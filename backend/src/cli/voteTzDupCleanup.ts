import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { disconnectPrisma, getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';

/**
 * vote-tz-dup-cleanup
 *
 * 清理 voteResyncAudit 在修复前因 TZ 写入口径不一致引入的重复 Vote 行。
 *
 * 根因：voteResyncAudit 早期版本通过 `$executeRawUnsafe` 把 JS Date 作为参数
 * 写入 `tmp_vote.timestamp` (`timestamp without time zone`)。pg-node 协议序列化
 * Date 为带时区 ISO 字符串，PostgreSQL 按 session TimeZone=Asia/Shanghai 把它去
 * 时区化为本地时间 → 与 Prisma ORM 的 UTC 写入相比偏移 8h，绕过 Vote 表唯一约束
 * `(pageVersionId, userId, timestamp)`，造成同一票多记 1 行。
 *
 * 识别口径（精确）：
 *   - 把 (pageVersionId, direction, actor_key) 作为 actor 维度，
 *     actor_key = COALESCE('u:'||userId, 'a:'||anonKey)
 *   - actor group 内严格 2 条、且 timestamp 差恰好 8h（容差 ±--pair-window-sec，
 *     默认 1 秒）的认定为 cleanup pair
 *   - 保留 timestamp 较小的（UTC 真值），删除较大的（+8h 错误副本）
 *
 * 不动的（保守，避免误伤合法行为）：
 *   - actor group >= 3 条（哪怕含 8h pair）— 列入 review，等第二阶段
 *   - 单条孤儿（无 counterpart 的 +8h 票，可能是漏抓被填补）— 列入 review
 *
 * 子命令：
 *   默认 dry-run：只统计 + 抽样，不写库
 *   --apply：单事务内备份 + DELETE（自动加 SET LOCAL TIME ZONE 'UTC' 防御）
 *
 * 备份：被删行写入 public.vote_tz_dup_cleanup_log，带 run_id 便于回滚。
 */

export type VoteTzDupCleanupOptions = {
  apply?: boolean;
  pairWindowSec?: number;
  sampleSize?: number;
  json?: boolean;
};

type Counts = {
  total_vote_rows: number;
  pair_8h_pairs: number;
  multi_groups: number;
  multi_extra_rows: number;
  affected_pages: number;
};

type SamplePageRow = {
  page_version_id: number;
  wikidot_id: number | null;
  current_url: string | null;
  pair_count: number;
};

const DEFAULT_PAIR_WINDOW_SEC = 1;
const DEFAULT_SAMPLE_SIZE = 20;

async function ensureLogTable(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS public.vote_tz_dup_cleanup_log (
      id              bigserial    PRIMARY KEY,
      run_id          uuid         NOT NULL,
      vote_id         int          NOT NULL,
      "pageVersionId" int          NOT NULL,
      "userId"        int,
      "anonKey"       text,
      direction       int          NOT NULL,
      ts_deleted      timestamp(3) NOT NULL,
      paired_vote_id  int          NOT NULL,
      ts_kept         timestamp(3) NOT NULL,
      reason          text         NOT NULL,
      cleaned_at      timestamptz  NOT NULL DEFAULT now()
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_vote_tz_dup_cleanup_log_run_id
       ON public.vote_tz_dup_cleanup_log (run_id)`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS idx_vote_tz_dup_cleanup_log_vote_id
       ON public.vote_tz_dup_cleanup_log (vote_id)`
  );
}

async function getCounts(prisma: PrismaClient, pairWindowSec: number): Promise<Counts> {
  const rows = await prisma.$queryRawUnsafe<Array<{
    total_vote_rows: bigint;
    pair_8h_pairs: bigint;
    multi_groups: bigint;
    multi_extra_rows: bigint;
    affected_pages: bigint;
  }>>(
    `
    WITH actor_groups AS (
      SELECT
        v."pageVersionId" AS page_version_id,
        v.direction,
        COALESCE('u:' || v."userId"::text, 'a:' || v."anonKey") AS actor_key,
        array_agg(v.timestamp ORDER BY v.timestamp, v.id) AS tses,
        COUNT(*)::int AS n
      FROM "Vote" v
      WHERE v.direction <> 0
        AND (v."userId" IS NOT NULL OR v."anonKey" IS NOT NULL)
      GROUP BY 1, 2, 3
      HAVING COUNT(*) >= 2
    ),
    pair_8h AS (
      SELECT page_version_id, actor_key, direction
        FROM actor_groups
       WHERE n = 2
         AND ABS(EXTRACT(EPOCH FROM (tses[2] - tses[1])) - 28800) <= $1
    ),
    multi AS (
      SELECT page_version_id, actor_key, direction, n
        FROM actor_groups
       WHERE n >= 3
         AND EXISTS (
           SELECT 1 FROM generate_subscripts(tses, 1) i
           WHERE i < array_length(tses, 1)
             AND ABS(EXTRACT(EPOCH FROM (tses[i + 1] - tses[i])) - 28800) <= $1
         )
    )
    SELECT
      (SELECT COUNT(*) FROM "Vote")::bigint                   AS total_vote_rows,
      (SELECT COUNT(*) FROM pair_8h)::bigint                  AS pair_8h_pairs,
      (SELECT COUNT(*) FROM multi)::bigint                    AS multi_groups,
      (SELECT COALESCE(SUM(n - 1), 0) FROM multi)::bigint     AS multi_extra_rows,
      (SELECT COUNT(DISTINCT page_version_id) FROM pair_8h)::bigint AS affected_pages
    `,
    pairWindowSec
  );
  const row = rows[0];
  return {
    total_vote_rows: Number(row?.total_vote_rows ?? 0),
    pair_8h_pairs: Number(row?.pair_8h_pairs ?? 0),
    multi_groups: Number(row?.multi_groups ?? 0),
    multi_extra_rows: Number(row?.multi_extra_rows ?? 0),
    affected_pages: Number(row?.affected_pages ?? 0)
  };
}

async function getSamplePages(
  prisma: PrismaClient,
  pairWindowSec: number,
  sampleSize: number
): Promise<SamplePageRow[]> {
  return prisma.$queryRawUnsafe<SamplePageRow[]>(
    `
    WITH actor_groups AS (
      SELECT
        v."pageVersionId" AS page_version_id,
        v.direction,
        COALESCE('u:' || v."userId"::text, 'a:' || v."anonKey") AS actor_key,
        array_agg(v.timestamp ORDER BY v.timestamp, v.id) AS tses,
        COUNT(*)::int AS n
      FROM "Vote" v
      WHERE v.direction <> 0
        AND (v."userId" IS NOT NULL OR v."anonKey" IS NOT NULL)
      GROUP BY 1, 2, 3
      HAVING COUNT(*) = 2
    ),
    pair_8h AS (
      SELECT page_version_id
        FROM actor_groups
       WHERE ABS(EXTRACT(EPOCH FROM (tses[2] - tses[1])) - 28800) <= $1
    ),
    by_page AS (
      SELECT page_version_id, COUNT(*)::int AS pair_count
        FROM pair_8h
       GROUP BY page_version_id
       ORDER BY pair_count DESC, page_version_id
       LIMIT $2
    )
    SELECT b.page_version_id,
           pg."wikidotId"   AS wikidot_id,
           pg."currentUrl"  AS current_url,
           b.pair_count
      FROM by_page b
      JOIN "PageVersion" pv ON pv.id = b.page_version_id
      JOIN "Page" pg        ON pg.id = pv."pageId"
     ORDER BY b.pair_count DESC, b.page_version_id
    `,
    pairWindowSec,
    sampleSize
  );
}

export async function runVoteTzDupCleanup(options: VoteTzDupCleanupOptions): Promise<void> {
  const prisma = getPrismaClient();
  const apply = Boolean(options.apply);
  const pairWindowSec = options.pairWindowSec ?? DEFAULT_PAIR_WINDOW_SEC;
  const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  const json = Boolean(options.json);
  const runId = randomUUID();

  // 多行报告：直接 console.log 避免 Logger.info 的 500ms 节流丢行。
  // JSON 模式下 header 走 stderr，让 stdout 保持纯 JSON，方便上游脚本解析。
  const header =
    `🛠 vote-tz-dup-cleanup ${apply ? '(APPLY)' : '(dry-run)'} ` +
    `pairWindowSec=${pairWindowSec} runId=${runId}`;
  if (json) {
    console.error(header);
  } else {
    console.log(header);
  }

  const counts = await getCounts(prisma, pairWindowSec);
  const samples = await getSamplePages(prisma, pairWindowSec, sampleSize);

  if (json) {
    console.log(
      JSON.stringify(
        {
          mode: apply ? 'apply' : 'dry-run',
          pairWindowSec,
          runId,
          counts,
          samples
        },
        null,
        2
      )
    );
  } else {
    console.log('## counts');
    console.log(`  total_vote_rows  = ${counts.total_vote_rows}`);
    console.log(`  pair_8h_pairs    = ${counts.pair_8h_pairs}     (cleanup target)`);
    console.log(`  affected_pages   = ${counts.affected_pages}`);
    console.log(`  multi_groups     = ${counts.multi_groups}      (review only, not touched)`);
    console.log(`  multi_extra_rows = ${counts.multi_extra_rows}  (potential extra rows in multi)`);
    console.log('');
    console.log(`## top ${samples.length} affected pages`);
    for (const s of samples) {
      console.log(
        `  pv=${s.page_version_id} wikidotId=${s.wikidot_id ?? '(null)'} ` +
        `pair_count=${s.pair_count} url=${s.current_url ?? '(unknown)'}`
      );
    }
  }

  if (!apply) {
    console.log('');
    console.log('🧪 dry-run only. re-run with --apply to perform the cleanup.');
    return;
  }

  if (counts.pair_8h_pairs === 0) {
    console.log('✅ no suspect pairs to clean up.');
    return;
  }

  await ensureLogTable(prisma);

  console.log(`🚀 entering single transaction (pair select + backup + DELETE all in tx) runId=${runId}`);

  const result = await prisma.$transaction(
    async (tx) => {
      // 防御：保证事务内 timestamp 比较口径与 Vote 表写入一致（UTC）。
      await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);

      // 1) 在事务内重选 suspect pair 并直接备份到 cleanup_log，避免 tx 外/内 pair 集合 drift。
      //    timestamp 全程 server-side，不出库；run_id 是本次唯一 provenance。
      const backupInserted = await tx.$executeRawUnsafe(
        `WITH actor_groups AS (
           SELECT
             array_agg(v.id        ORDER BY v.timestamp, v.id) AS ids,
             array_agg(v.timestamp ORDER BY v.timestamp, v.id) AS tses
           FROM "Vote" v
           WHERE v.direction <> 0
             AND (v."userId" IS NOT NULL OR v."anonKey" IS NOT NULL)
           GROUP BY v."pageVersionId", v.direction,
                    COALESCE('u:' || v."userId"::text, 'a:' || v."anonKey")
           HAVING COUNT(*) = 2
         ),
         pairs AS (
           SELECT ids[1] AS keep_id, ids[2] AS delete_id
             FROM actor_groups
            WHERE ABS(EXTRACT(EPOCH FROM (tses[2] - tses[1])) - 28800) <= $2
         )
         INSERT INTO public.vote_tz_dup_cleanup_log
           (run_id, vote_id, "pageVersionId", "userId", "anonKey", direction,
            ts_deleted, paired_vote_id, ts_kept, reason)
         SELECT $1::uuid,
                v.id, v."pageVersionId", v."userId", v."anonKey", v.direction,
                v.timestamp, k.id, k.timestamp, 'tz_dup_pair_8h'
           FROM pairs p
           JOIN "Vote" v ON v.id = p.delete_id
           JOIN "Vote" k ON k.id = p.keep_id`,
        runId,
        pairWindowSec
      );
      const backupCount = Number(backupInserted ?? 0);
      console.log(`📝 backup rows inserted into vote_tz_dup_cleanup_log: ${backupCount}`);

      // 2) DELETE 直接驱动自 log（同 run_id），保证 DELETE 严格是 backup 的子集 — 一一对应。
      const deleted = await tx.$executeRawUnsafe(
        `DELETE FROM "Vote" v
           USING public.vote_tz_dup_cleanup_log l
          WHERE l.run_id = $1::uuid
            AND v.id     = l.vote_id`,
        runId
      );
      const deletedCount = Number(deleted ?? 0);
      console.log(`🗑  deleted Vote rows: ${deletedCount}`);

      if (deletedCount !== backupCount) {
        throw new Error(
          `backup/delete mismatch: backup=${backupCount}, deleted=${deletedCount}; rolling back`
        );
      }

      // 3) 残留断言：仅在 cleanup_log 涉及的 actor 子集上重新分组，确认这些 actor 不再有 8h pair。
      //    比全表 GROUP 便宜得多，且语义上覆盖了所有"被本次 cleanup 触及"的 actor。
      const residualRows = await tx.$queryRawUnsafe<Array<{ residual: bigint }>>(
        `WITH affected AS (
           SELECT DISTINCT "pageVersionId", "userId", "anonKey", direction
             FROM public.vote_tz_dup_cleanup_log
            WHERE run_id = $1::uuid
         ),
         residual_groups AS (
           SELECT array_agg(v.timestamp ORDER BY v.timestamp, v.id) AS tses
             FROM "Vote" v
             JOIN affected a
               ON a."pageVersionId" = v."pageVersionId"
              AND a.direction       = v.direction
              AND ((a."userId"  IS NOT NULL AND v."userId"  = a."userId")
                OR (a."anonKey" IS NOT NULL AND v."anonKey" = a."anonKey"))
            WHERE v.direction <> 0
            GROUP BY v."pageVersionId", v.direction,
                     COALESCE('u:' || v."userId"::text, 'a:' || v."anonKey")
           HAVING COUNT(*) = 2
         )
         SELECT COUNT(*)::bigint AS residual
           FROM residual_groups
          WHERE ABS(EXTRACT(EPOCH FROM (tses[2] - tses[1])) - 28800) <= $2`,
        runId,
        pairWindowSec
      );
      const residual = Number(residualRows[0]?.residual ?? 0);
      if (residual !== 0) {
        throw new Error(
          `post-cleanup residual suspect pairs on affected actors = ${residual} (expected 0); rolling back`
        );
      }
      console.log(`✅ residual pair_8h_pairs on affected actors = 0 (post-cleanup assertion passed)`);

      return { backupCount, deletedCount, residual };
    },
    { timeout: 10 * 60 * 1000, maxWait: 60 * 1000 }
  );

  console.log(
    `🎉 cleanup complete. runId=${runId} backup=${result.backupCount} deleted=${result.deletedCount}`
  );
  console.log(
    `   rollback: re-INSERT rows from public.vote_tz_dup_cleanup_log WHERE run_id = '${runId}'`
  );
}

if (process.argv[1] && process.argv[1].endsWith('voteTzDupCleanup.js')) {
  const argv = process.argv.slice(2);
  const opts: VoteTzDupCleanupOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--apply') opts.apply = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--pair-window-sec' && argv[i + 1] !== undefined) {
      const v = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(v) && v >= 0) opts.pairWindowSec = v;
      i += 1;
    } else if (a === '--sample-size' && argv[i + 1] !== undefined) {
      const v = Number.parseInt(argv[i + 1], 10);
      if (Number.isFinite(v) && v >= 0) opts.sampleSize = v;
      i += 1;
    }
  }

  runVoteTzDupCleanup(opts)
    .then(async () => {
      await disconnectPrisma();
      process.exit(0);
    })
    .catch(async (err) => {
      Logger.error('vote-tz-dup-cleanup failed', err instanceof Error ? err : new Error(String(err)));
      try {
        await disconnectPrisma();
      } catch {
        // ignore
      }
      process.exit(1);
    });
}
