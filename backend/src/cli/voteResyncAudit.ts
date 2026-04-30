import { PrismaClient } from '@prisma/client';
import { GraphQLClient } from '../core/client/GraphQLClient.js';
import { disconnectPrisma, getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';
import { Progress } from '../utils/Progress.js';

/**
 * vote-resync-audit
 *
 * 一次性 CLI，用于把本地 Vote 表与 CROM 真实分数对账并回填。
 * 所有中间数据落在独立 schema `vote_resync_audit`：
 *   - tmp_audit_summary: 偏差页清单与对账状态
 *   - tmp_vote:          CROM 拉到的全部 vote 边（用 user_wikidot_id 而非 userId）
 *   - tmp_user:          collect 期间见到的 user 占位（wikidotId + displayName）
 *
 * 重要约束（避免污染主库 / 破坏隔离）：
 *   - collect 阶段不读 public."User"、不写 public 任何表；只往 vote_resync_audit
 *     schema 写 tmp_audit_summary / tmp_vote / tmp_user。
 *   - 绝不写 'wd:<wikidotId>' 形式的 anonKey（避免与未来 PhaseB/C 同步出的真实
 *     userId 行重复计票）。tmp_vote.anonKey 在 collect 中永远为 NULL。
 *   - 占位 displayName 用 `wd:${wikidotId}` 形式（与 VoteRevisionStore /
 *     AttributionService 已有约定保持一致；AttributionService 会识别 `wd:` 前缀
 *     避免占位覆盖真名）。
 *   - 只有 Step 6 (--apply) 才动 public，并在单事务内：
 *       1) tmp_user → public."User" placeholder upsert (DO NOTHING 不覆盖真名)
 *       2) tmp_vote (user_wikidot_id IS NOT NULL) JOIN public."User" → "Vote".userId
 *       3) tmp_vote (user_wikidot_id IS NULL AND anonKey IS NOT NULL) → "Vote".anonKey
 *          [防御路径：当前 CROM schema 不会出现这种边，期望 0 行]
 *
 * 子命令：
 *   --setup     建 schema + tmp 表
 *   --collect   写偏差页清单 + 拉 CROM fuzzyVoteRecords 全量分页
 *   --report    聚合每页 expected_rating / expected_count + 输出 markdown
 *   --apply     把 tmp_vote 写回主库（事务内）
 *   --cleanup   DROP SCHEMA vote_resync_audit CASCADE
 *
 * 默认顺序：setup → collect → report；apply / cleanup 必须显式调用。
 */

export type VoteResyncAuditOptions = {
  setup?: boolean;
  collect?: boolean;
  report?: boolean;
  apply?: boolean;
  cleanup?: boolean;
  fetchConcurrency?: number;
  schema?: string;
};

const DEFAULT_SCHEMA = 'vote_resync_audit';
const FUZZY_PAGE_SIZE = 100;
const DEFAULT_FETCH_CONCURRENCY = 3;
const TMP_VOTE_INSERT_CHUNK = 200;
const TMP_USER_INSERT_CHUNK = 200;

const FUZZY_VOTE_QUERY = `
  query FuzzyVoteAudit($url: URL!, $first: Int, $after: ID) {
    wikidotPage(url: $url) {
      url
      rating
      voteCount
      fuzzyVoteRecords(first: $first, after: $after) {
        edges {
          node {
            userWikidotId
            direction
            timestamp
            user {
              ... on WikidotUser {
                wikidotId
                displayName
              }
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
`;

type CromVoteNode = {
  // CROM serializes wikidotId as string in JSON; coerce to int before SQL bind
  userWikidotId: string | number | null;
  direction: number;
  timestamp: string;
  user: { wikidotId?: string | number | null; displayName?: string | null } | null;
};

type CromFuzzyResponse = {
  wikidotPage: {
    url: string;
    rating: number;
    voteCount: number;
    fuzzyVoteRecords: {
      edges: Array<{ node: CromVoteNode }>;
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
    };
  } | null;
};

type SummaryRow = {
  wikidotId: number;
  pageVersionId: number;
  url: string | null;
  paRating: number | null;
  paCount: number | null;
};

type CollectStats = {
  totalPages: number;
  collected: number;
  failed: number;
  totalEdges: number;
  totalNullUserWikidotId: number;
};

type FetchOutcome = {
  rating: number;
  voteCount: number;
  edgesInserted: number;
  nullUserWikidotId: number;
};

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
    throw new Error(`invalid identifier: ${name}`);
  }
  return `"${name}"`;
}

async function ensureSchemaAndTables(prisma: PrismaClient, schema: string): Promise<void> {
  const qs = quoteIdent(schema);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS ${qs}`);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ${qs}.tmp_audit_summary (
      "wikidotId"     int        PRIMARY KEY,
      "pageVersionId" int        NOT NULL,
      url             text,
      pa_rating       int,
      pa_count        int,
      cr_rating       int,
      cr_count        int,
      expected_rating int,
      expected_count  int,
      status          text       NOT NULL DEFAULT 'pending',
      error           text,
      fetched_at      timestamptz
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ${qs}.tmp_vote (
      edge_seq        bigserial      PRIMARY KEY,
      "pageVersionId" int            NOT NULL,
      user_wikidot_id int,
      "anonKey"       text,
      direction       int            NOT NULL,
      timestamp       timestamp(3)   NOT NULL,
      fetched_at      timestamptz    NOT NULL DEFAULT now()
    )
  `);
  // 兜底已存在的旧 audit schema：把 timestamp 列对齐到 timestamp(3)（与 "Vote".timestamp 一致）。
  await prisma.$executeRawUnsafe(
    `ALTER TABLE ${qs}.tmp_vote ALTER COLUMN timestamp TYPE timestamp(3)`
  );

  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS tmp_vote_pv_uwid_ts
      ON ${qs}.tmp_vote ("pageVersionId", user_wikidot_id, timestamp)
  `);
  await prisma.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS tmp_vote_pv_anon_ts
      ON ${qs}.tmp_vote ("pageVersionId", "anonKey", timestamp)
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS ${qs}.tmp_user (
      "wikidotId"   int  PRIMARY KEY,
      "displayName" text NOT NULL,
      source        text NOT NULL DEFAULT 'collect'
    )
  `);
}

/**
 * 用对账 SQL 找出所有 perfect_match=false 的偏差页，
 * 写入 tmp_audit_summary（status='pending'，已存在的 wikidotId 不覆盖）。
 */
async function seedSummary(prisma: PrismaClient, schema: string): Promise<number> {
  const qs = quoteIdent(schema);
  const inserted = await prisma.$executeRawUnsafe(`
    INSERT INTO ${qs}.tmp_audit_summary
      ("wikidotId", "pageVersionId", url, pa_rating, pa_count, status)
    WITH lv_agg AS (
      SELECT lv."pageVersionId" AS pvid,
             COUNT(*)::int                              AS lv_total,
             COALESCE(SUM(lv.direction)::int, 0)        AS lv_net,
             COUNT(*) FILTER (WHERE lv.direction = 0)::int AS lv_zero
        FROM "LatestVote" lv
       GROUP BY lv."pageVersionId"
    )
    SELECT pg."wikidotId",
           pv.id,
           pg."currentUrl",
           pv.rating,
           pv."voteCount",
           'pending'
      FROM "PageVersion" pv
      JOIN "Page" pg ON pg.id = pv."pageId"
      LEFT JOIN lv_agg ON lv_agg.pvid = pv.id
     WHERE pv."validTo" IS NULL
       AND pv."isDeleted" = false
       AND pv."voteCount" IS NOT NULL
       AND pg."wikidotId" IS NOT NULL
       AND pg."currentUrl" IS NOT NULL
       AND (
         (COALESCE(lv_agg.lv_total, 0) = 0 AND pv."voteCount" > 0)
         OR (lv_agg.lv_total > 0 AND lv_agg.lv_net <> pv.rating)
         OR (lv_agg.lv_total > 0 AND (lv_agg.lv_total - lv_agg.lv_zero) <> pv."voteCount")
       )
    ON CONFLICT ("wikidotId") DO NOTHING
  `);
  return Number(inserted ?? 0);
}

async function loadPendingPages(prisma: PrismaClient, schema: string): Promise<SummaryRow[]> {
  const qs = quoteIdent(schema);
  const rows = await prisma.$queryRawUnsafe<Array<{
    wikidotId: number;
    pageVersionId: number;
    url: string | null;
    pa_rating: number | null;
    pa_count: number | null;
  }>>(`
    SELECT "wikidotId",
           "pageVersionId",
           url,
           pa_rating,
           pa_count
      FROM ${qs}.tmp_audit_summary
     WHERE status IN ('pending', 'error')
     ORDER BY "wikidotId"
  `);
  return rows.map(r => ({
    wikidotId: Number(r.wikidotId),
    pageVersionId: Number(r.pageVersionId),
    url: r.url,
    paRating: r.pa_rating === null ? null : Number(r.pa_rating),
    paCount: r.pa_count === null ? null : Number(r.pa_count)
  }));
}

/**
 * 拉一页全部 fuzzyVoteRecords，仅向 tmp 表写入：
 *   - tmp_vote: 每条 edge 一行，user_wikidot_id 为 CROM 返回的 userWikidotId
 *   - tmp_user: 每个见到的 wikidotId 一行（ON CONFLICT DO NOTHING 去重）
 * 重跑前先 DELETE 该 pageVersionId 的旧边，避免半截数据残留。
 * 不会查询或写入 public schema 任何表。
 */
async function fetchAndStorePageVotes(
  prisma: PrismaClient,
  schema: string,
  client: GraphQLClient,
  page: SummaryRow
): Promise<FetchOutcome> {
  if (!page.url) throw new Error('missing page url');
  const qs = quoteIdent(schema);

  await prisma.$executeRawUnsafe(
    `DELETE FROM ${qs}.tmp_vote WHERE "pageVersionId" = $1`,
    page.pageVersionId
  );

  let cursor: string | null = null;
  let edgesInserted = 0;
  let nullUserWikidotId = 0;
  let pageRating = 0;
  let pageVoteCount = 0;

  // 防 cursor 死循环
  const MAX_PAGES = 1000;
  let pageIter = 0;

  while (true) {
    pageIter += 1;
    if (pageIter > MAX_PAGES) {
      throw new Error(`pagination did not terminate after ${MAX_PAGES} iterations`);
    }
    const resp = (await client.request(FUZZY_VOTE_QUERY, {
      url: page.url,
      first: FUZZY_PAGE_SIZE,
      after: cursor
    })) as CromFuzzyResponse | null;
    const wp: CromFuzzyResponse['wikidotPage'] = resp?.wikidotPage ?? null;
    if (!wp) {
      throw new Error(`wikidotPage returned null for url=${page.url}`);
    }
    pageRating = wp.rating;
    pageVoteCount = wp.voteCount;
    const edges = wp.fuzzyVoteRecords?.edges ?? [];

    if (edges.length > 0) {
      type VoteRow = {
        pvid: number;
        userWikidotId: number;
        direction: number;
        timestamp: Date;
      };
      type UserRow = { wikidotId: number; displayName: string };

      const voteRows: VoteRow[] = [];
      const userBatch: UserRow[] = [];
      const userBatchSeen = new Set<number>();

      for (const e of edges) {
        const node = e.node;
        // CROM 把 wikidotId 序列化为 string；强制 parseInt，否则 PG 会因
        // "user_wikidot_id integer ← text" 类型失配整页失败
        const widRaw = node.user?.wikidotId ?? node.userWikidotId ?? null;
        const wid = widRaw == null ? null : Number.parseInt(String(widRaw), 10);
        if (wid == null || !Number.isFinite(wid)) {
          // 应当极少（按 schema 1682 always present），但守住兜底
          nullUserWikidotId += 1;
          continue;
        }
        const ts = new Date(node.timestamp);
        if (Number.isNaN(ts.getTime())) {
          nullUserWikidotId += 1;
          continue;
        }
        const rawDn = typeof node.user?.displayName === 'string' ? node.user.displayName.trim() : '';
        const displayName = rawDn.length > 0 ? rawDn : `wd:${wid}`;

        voteRows.push({
          pvid: page.pageVersionId,
          userWikidotId: wid,
          direction: node.direction,
          timestamp: ts
        });
        if (!userBatchSeen.has(wid)) {
          userBatchSeen.add(wid);
          userBatch.push({ wikidotId: wid, displayName });
        }
      }

      // tmp_vote bulk insert (anonKey 永远 NULL)
      // timestamp 走显式 ISO 字符串 + (::timestamptz AT TIME ZONE 'UTC')::timestamp，
      // 防止 pg-node 把 JS Date 按 session TimeZone(Asia/Shanghai) 落库，
      // 与 Prisma ORM 的 UTC 写入口径偏离 8h，制造 (pageVersionId, userId, timestamp+8h) 重复行。
      for (const chunk of chunkArray(voteRows, TMP_VOTE_INSERT_CHUNK)) {
        const params: unknown[] = [];
        const valueClauses: string[] = [];
        chunk.forEach((row, idx) => {
          const base = idx * 4;
          valueClauses.push(
            `($${base + 1}, $${base + 2}, $${base + 3}, ($${base + 4}::timestamptz AT TIME ZONE 'UTC')::timestamp)`
          );
          params.push(
            row.pvid,
            row.userWikidotId,
            row.direction,
            row.timestamp.toISOString()
          );
        });
        await prisma.$executeRawUnsafe(
          `INSERT INTO ${qs}.tmp_vote ("pageVersionId", user_wikidot_id, direction, timestamp)
           VALUES ${valueClauses.join(',')}`,
          ...params
        );
      }

      // tmp_user bulk insert (ON CONFLICT DO NOTHING)
      for (const chunk of chunkArray(userBatch, TMP_USER_INSERT_CHUNK)) {
        const params: unknown[] = [];
        const valueClauses: string[] = [];
        chunk.forEach((row, idx) => {
          const base = idx * 2;
          valueClauses.push(`($${base + 1}, $${base + 2})`);
          params.push(row.wikidotId, row.displayName);
        });
        await prisma.$executeRawUnsafe(
          `INSERT INTO ${qs}.tmp_user ("wikidotId", "displayName")
           VALUES ${valueClauses.join(',')}
           ON CONFLICT ("wikidotId") DO NOTHING`,
          ...params
        );
      }

      edgesInserted += voteRows.length;
    }

    if (!wp.fuzzyVoteRecords?.pageInfo?.hasNextPage) break;
    const nextCursor: string | null = wp.fuzzyVoteRecords?.pageInfo?.endCursor ?? null;
    if (!nextCursor || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return {
    rating: pageRating,
    voteCount: pageVoteCount,
    edgesInserted,
    nullUserWikidotId
  };
}

async function doCollect(
  prisma: PrismaClient,
  schema: string,
  fetchConcurrency: number
): Promise<CollectStats> {
  const seeded = await seedSummary(prisma, schema);
  Logger.info(`📋 seed: inserted ${seeded} new mismatched pages into tmp_audit_summary`);

  const pages = await loadPendingPages(prisma, schema);
  const stats: CollectStats = {
    totalPages: pages.length,
    collected: 0,
    failed: 0,
    totalEdges: 0,
    totalNullUserWikidotId: 0
  };
  if (pages.length === 0) {
    Logger.info('✅ nothing left to collect (no pending/error rows)');
    return stats;
  }
  Logger.info(`🚚 collect: pulling fuzzyVoteRecords for ${pages.length} pages, concurrency=${fetchConcurrency}`);

  const client = new GraphQLClient();
  const bar = Progress.createBar({ title: 'collect', total: pages.length });
  const queue = pages.slice();
  const qs = quoteIdent(schema);

  const worker = async () => {
    while (true) {
      const page = queue.shift();
      if (!page) break;
      try {
        const outcome = await fetchAndStorePageVotes(prisma, schema, client, page);
        const errStr =
          outcome.nullUserWikidotId > 0 ? `null_userWikidotId=${outcome.nullUserWikidotId}` : null;
        await prisma.$executeRawUnsafe(
          `UPDATE ${qs}.tmp_audit_summary
              SET cr_rating  = $2,
                  cr_count   = $3,
                  status     = 'collected',
                  error      = $4,
                  fetched_at = now()
            WHERE "wikidotId" = $1`,
          page.wikidotId,
          outcome.rating,
          outcome.voteCount,
          errStr
        );
        stats.collected += 1;
        stats.totalEdges += outcome.edgesInserted;
        stats.totalNullUserWikidotId += outcome.nullUserWikidotId;
      } catch (err) {
        stats.failed += 1;
        const msg = err instanceof Error ? err.message : String(err);
        Logger.warn(`⚠️ collect failed wikidotId=${page.wikidotId} url=${page.url ?? '(null)'}: ${msg}`);
        // 关键：分页中途失败时 fetchAndStorePageVotes 已经向 tmp_vote 插过若干 partial 行。
        // 如果不清理，--report 会基于 partial 数据算 expected_*，apply 也可能把残留写回主库。
        try {
          await prisma.$executeRawUnsafe(
            `DELETE FROM ${qs}.tmp_vote WHERE "pageVersionId" = $1`,
            page.pageVersionId
          );
        } catch (cleanupErr) {
          Logger.error(
            `❌ failed to clean partial tmp_vote rows for wikidotId=${page.wikidotId}`,
            cleanupErr instanceof Error ? cleanupErr : new Error(String(cleanupErr))
          );
        }
        try {
          await prisma.$executeRawUnsafe(
            `UPDATE ${qs}.tmp_audit_summary
                SET status     = 'error',
                    error      = $2,
                    cr_rating  = NULL,
                    cr_count   = NULL,
                    fetched_at = now()
              WHERE "wikidotId" = $1`,
            page.wikidotId,
            msg.slice(0, 1000)
          );
        } catch (innerErr) {
          Logger.error(
            `❌ failed to record error status for wikidotId=${page.wikidotId}`,
            innerErr instanceof Error ? innerErr : new Error(String(innerErr))
          );
        }
      } finally {
        bar.increment();
      }
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.max(1, fetchConcurrency) }, () => worker())
    );
  } finally {
    bar.stop();
    try { (client as unknown as { destroy?: () => void }).destroy?.(); } catch {}
  }

  Logger.info(
    `✅ collect done: collected=${stats.collected} failed=${stats.failed} edges=${stats.totalEdges} nullUserWikidotId=${stats.totalNullUserWikidotId}`
  );
  return stats;
}

function fmt(v: number | null | undefined): string {
  if (v == null) return '∅';
  return String(v);
}

async function doReport(prisma: PrismaClient, schema: string): Promise<void> {
  const qs = quoteIdent(schema);

  // 计算 expected_rating / expected_count：每个 (pageVersionId, actor_key) 取最新边
  // actor_key 用 wikidotId 而非 lookup 后的 userId，因为 collect 阶段不查 public.User
  await prisma.$executeRawUnsafe(`
    WITH ranked AS (
      SELECT "pageVersionId", direction,
             ROW_NUMBER() OVER (
               PARTITION BY "pageVersionId",
                            COALESCE('u:' || user_wikidot_id::text, 'a:' || "anonKey")
               ORDER BY timestamp DESC, edge_seq DESC
             ) AS rn
        FROM ${qs}.tmp_vote
    )
    UPDATE ${qs}.tmp_audit_summary s
       SET expected_rating = a.expected_rating,
           expected_count  = a.expected_count
      FROM (
        SELECT "pageVersionId",
               SUM(direction)::int AS expected_rating,
               COUNT(*) FILTER (WHERE direction <> 0)::int AS expected_count
          FROM ranked
         WHERE rn = 1
         GROUP BY "pageVersionId"
      ) a
     WHERE s."pageVersionId" = a."pageVersionId"
  `);

  type OverviewRow = {
    total: bigint | number;
    collected: bigint | number;
    pending: bigint | number;
    error: bigint | number;
    matches_cr: bigint | number;
    mismatches_cr: bigint | number;
  };

  const overviewRows = await prisma.$queryRawUnsafe<OverviewRow[]>(`
    SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE status = 'collected')::bigint AS collected,
      COUNT(*) FILTER (WHERE status = 'pending')::bigint AS pending,
      COUNT(*) FILTER (WHERE status = 'error')::bigint AS error,
      COUNT(*) FILTER (
        WHERE status = 'collected'
          AND expected_rating IS NOT NULL
          AND expected_rating = cr_rating
      )::bigint AS matches_cr,
      COUNT(*) FILTER (
        WHERE status = 'collected'
          AND expected_rating IS NOT NULL
          AND expected_rating <> cr_rating
      )::bigint AS mismatches_cr
    FROM ${qs}.tmp_audit_summary
  `);

  const tmpVoteCountRows = await prisma.$queryRawUnsafe<Array<{ count: bigint | number }>>(
    `SELECT COUNT(*)::bigint AS count FROM ${qs}.tmp_vote`
  );

  type ApplyEstRow = { user_rows: bigint | number; anon_rows: bigint | number };
  const applyEstRows = await prisma.$queryRawUnsafe<ApplyEstRow[]>(`
    SELECT
      COUNT(*) FILTER (WHERE user_wikidot_id IS NOT NULL)::bigint AS user_rows,
      COUNT(*) FILTER (WHERE user_wikidot_id IS NULL AND "anonKey" IS NOT NULL)::bigint AS anon_rows
    FROM ${qs}.tmp_vote
  `);

  type TmpUserStatsRow = {
    total: bigint | number;
    placeholder_dn: bigint | number;
    real_dn: bigint | number;
    new_to_public: bigint | number;
  };
  const tmpUserStatsRows = await prisma.$queryRawUnsafe<TmpUserStatsRow[]>(`
    SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE "displayName" LIKE 'wd:%')::bigint AS placeholder_dn,
      COUNT(*) FILTER (WHERE "displayName" NOT LIKE 'wd:%')::bigint AS real_dn,
      COUNT(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM "User" u WHERE u."wikidotId" = ${qs}.tmp_user."wikidotId"
        )
      )::bigint AS new_to_public
    FROM ${qs}.tmp_user
  `);

  type AnomalyRow = {
    wikidotId: number;
    url: string | null;
    expected_rating: number | null;
    cr_rating: number | null;
    expected_count: number | null;
    cr_count: number | null;
    pa_rating: number | null;
    pa_count: number | null;
  };
  const anomalies = await prisma.$queryRawUnsafe<AnomalyRow[]>(`
    SELECT "wikidotId",
           url,
           expected_rating,
           cr_rating,
           expected_count,
           cr_count,
           pa_rating,
           pa_count
      FROM ${qs}.tmp_audit_summary
     WHERE status = 'collected'
       AND expected_rating IS NOT NULL
       AND expected_rating <> cr_rating
     ORDER BY ABS(COALESCE(expected_rating, 0) - COALESCE(cr_rating, 0)) DESC,
              "wikidotId"
     LIMIT 30
  `);

  const o = overviewRows[0];
  const total = Number(o?.total ?? 0);
  const collected = Number(o?.collected ?? 0);
  const pending = Number(o?.pending ?? 0);
  const errored = Number(o?.error ?? 0);
  const matchesCr = Number(o?.matches_cr ?? 0);
  const mismatchesCr = Number(o?.mismatches_cr ?? 0);
  const totalEdges = Number(tmpVoteCountRows[0]?.count ?? 0);
  const userRows = Number(applyEstRows[0]?.user_rows ?? 0);
  const anonRows = Number(applyEstRows[0]?.anon_rows ?? 0);

  const u = tmpUserStatsRows[0];
  const tmpUserTotal = Number(u?.total ?? 0);
  const tmpUserPlaceholder = Number(u?.placeholder_dn ?? 0);
  const tmpUserRealName = Number(u?.real_dn ?? 0);
  const tmpUserNewToPublic = Number(u?.new_to_public ?? 0);

  const lines: string[] = [];
  lines.push('# vote-resync-audit report');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`- 偏差页总数 (tmp_audit_summary): **${total}**`);
  lines.push(`- 已 collected: **${collected}**`);
  lines.push(`- 待 collect (pending): **${pending}**`);
  lines.push(`- 失败 (error): **${errored}**`);
  lines.push(`- expected_rating == cr_rating（重算与 CROM 一致）: **${matchesCr}**`);
  lines.push(`- expected_rating != cr_rating（重算与 CROM 不一致）: **${mismatchesCr}**`);
  lines.push(`- tmp_vote 总边数: **${totalEdges}**`);
  lines.push('');
  lines.push('## tmp_user (collect 占位用户表)');
  lines.push('');
  lines.push(`- tmp_user 总行数: **${tmpUserTotal}**`);
  lines.push(`-   有真名 displayName: **${tmpUserRealName}**`);
  lines.push(`-   占位 \`wd:${'<wikidotId>'}\` displayName: **${tmpUserPlaceholder}**`);
  lines.push(`- apply 预计触动 public."User"（NOT EXISTS in public.User）: **${tmpUserNewToPublic}**`);
  lines.push('');
  lines.push('## apply 预估行数');
  lines.push('');
  lines.push(`- user 路径: tmp_vote rows with user_wikidot_id NOT NULL = **${userRows}**`);
  lines.push(`- anon 路径（防御，期望 0）: tmp_vote rows with anonKey NOT NULL = **${anonRows}**`);
  lines.push('');

  if (anomalies.length === 0) {
    lines.push('## Anomalies');
    lines.push('');
    lines.push('🎉 expected_rating 与 cr_rating 全部一致。');
  } else {
    lines.push(`## Anomalies (top ${anomalies.length})`);
    lines.push('');
    lines.push('| wikidotId | url | expected_rating | cr_rating | expected_count | cr_count | pa_rating | pa_count |');
    lines.push('|---|---|---:|---:|---:|---:|---:|---:|');
    for (const a of anomalies) {
      lines.push(
        `| ${a.wikidotId} | ${a.url ?? '(unknown)'} | ${fmt(a.expected_rating)} | ${fmt(a.cr_rating)} | ${fmt(a.expected_count)} | ${fmt(a.cr_count)} | ${fmt(a.pa_rating)} | ${fmt(a.pa_count)} |`
      );
    }
  }

  console.log(lines.join('\n'));
}

/**
 * apply：在单事务内执行 5 步，任何一步失败整体回滚：
 *
 *   Step 0: 重新计算 expected_rating / expected_count（防 report 跑后又新 collect 几页带来的 stale）
 *   Step 1: 5-bucket dry-count + cr_mismatch / stale top-10 预览（warn 不 abort）
 *   Step 2: tmp_user → public."User"（只插被 eligible 页引用且尚未存在于 public.User 的占位）
 *   Step 3: tmp_vote (user_wikidot_id) JOIN public.User → "Vote"（user 路径）
 *   Step 4: tmp_vote (anonKey)         → "Vote"（anon 防御路径；当前 CROM schema 期望 0 行）
 *
 * 安全过滤（每条 INSERT 都强制）：
 *   AND s.status = 'collected'
 *   AND s.expected_rating IS NOT NULL
 *   AND s.expected_rating = s.cr_rating
 *   AND pv."validTo" IS NULL AND pv."isDeleted" = false
 *   AND pv.rating       IS NOT DISTINCT FROM s.pa_rating   -- freshness guard
 *   AND pv."voteCount"  IS NOT DISTINCT FROM s.pa_count    -- freshness guard
 *
 * 这能：(a) 拦掉 status!='collected' 的 partial 行；(b) 拦掉 expected_rating!=cr_rating
 * 的异常页（rating 是用户最关心的页面分数，必须严格对齐 wikidot）；(c) 拦掉 collect 之后
 * 被 PhaseA 增量同步覆盖了 pa_* 的 stale 页。
 *
 * 注：故意不强制 expected_count == cr_count。CROM voteCount 字段包含 direction=0
 * (cancelled vote) 用户，而我们 expected_count = COUNT(direction <> 0) 过滤了 cancelled。
 * 这是有意的口径选择——本地 LatestVote 聚合在语义上更准确。
 */
async function doApply(prisma: PrismaClient, schema: string): Promise<void> {
  const qs = quoteIdent(schema);

  type SkipBucketRow = {
    pending: bigint | number;
    error: bigint | number;
    no_report: bigint | number;
    cr_mismatch: bigint | number;
    stale: bigint | number;
    apply_eligible: bigint | number;
  };
  type CrPreviewRow = {
    wikidotId: number;
    url: string | null;
    expected_rating: number | null;
    cr_rating: number | null;
    expected_count: number | null;
    cr_count: number | null;
  };
  type StalePreviewRow = {
    wikidotId: number;
    url: string | null;
    pa_rating: number | null;
    pa_count: number | null;
    pv_rating: number | null;
    pv_count: number | null;
    valid_to: Date | null;
    is_deleted: boolean | null;
  };

  // INSERT 180k+ 行 + 多步 SQL 的事务可能跑数十秒到几分钟；Prisma 默认 5s timeout 不够
  const result = await prisma.$transaction(async (tx) => {
    // 防御：保证事务内任何 raw timestamp 转换都按 UTC，与 Prisma ORM 写入口径一致。
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE 'UTC'`);

    // Step 0: 事务内重跑 expected_*，避免 report 跑过后又有新 collect 行带来的 stale
    const expectedRecomputed = await tx.$executeRawUnsafe(`
      WITH ranked AS (
        SELECT "pageVersionId", direction,
               ROW_NUMBER() OVER (
                 PARTITION BY "pageVersionId",
                              COALESCE('u:' || user_wikidot_id::text, 'a:' || "anonKey")
                 ORDER BY timestamp DESC, edge_seq DESC
               ) AS rn
          FROM ${qs}.tmp_vote
      )
      UPDATE ${qs}.tmp_audit_summary s
         SET expected_rating = a.expected_rating,
             expected_count  = a.expected_count
        FROM (
          SELECT "pageVersionId",
                 SUM(direction)::int AS expected_rating,
                 COUNT(*) FILTER (WHERE direction <> 0)::int AS expected_count
            FROM ranked
           WHERE rn = 1
           GROUP BY "pageVersionId"
        ) a
       WHERE s."pageVersionId" = a."pageVersionId"
    `);

    // Step 1: 5-bucket dry-count + apply_eligible
    const skipRows = await tx.$queryRawUnsafe<SkipBucketRow[]>(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::bigint AS pending,
        COUNT(*) FILTER (WHERE status = 'error')::bigint   AS error,
        COUNT(*) FILTER (
          WHERE status = 'collected'
            AND (expected_rating IS NULL OR expected_count IS NULL)
        )::bigint AS no_report,
        COUNT(*) FILTER (
          WHERE status = 'collected'
            AND expected_rating IS NOT NULL
            AND expected_count  IS NOT NULL
            AND expected_rating <> cr_rating
        )::bigint AS cr_mismatch,
        COUNT(*) FILTER (
          WHERE status = 'collected'
            AND expected_rating IS NOT NULL
            AND expected_count  IS NOT NULL
            AND expected_rating = cr_rating            AND NOT EXISTS (
              SELECT 1 FROM "PageVersion" pv
               WHERE pv.id = "pageVersionId"
                 AND pv."validTo" IS NULL
                 AND pv."isDeleted" = false
                 AND pv.rating       IS NOT DISTINCT FROM pa_rating
                 AND pv."voteCount"  IS NOT DISTINCT FROM pa_count
            )
        )::bigint AS stale,
        COUNT(*) FILTER (
          WHERE status = 'collected'
            AND expected_rating IS NOT NULL
            AND expected_count  IS NOT NULL
            AND expected_rating = cr_rating            AND EXISTS (
              SELECT 1 FROM "PageVersion" pv
               WHERE pv.id = "pageVersionId"
                 AND pv."validTo" IS NULL
                 AND pv."isDeleted" = false
                 AND pv.rating       IS NOT DISTINCT FROM pa_rating
                 AND pv."voteCount"  IS NOT DISTINCT FROM pa_count
            )
        )::bigint AS apply_eligible
      FROM ${qs}.tmp_audit_summary
    `);
    const sb = skipRows[0];
    const skipPending = Number(sb?.pending ?? 0);
    const skipError = Number(sb?.error ?? 0);
    const skipNoReport = Number(sb?.no_report ?? 0);
    const skipCrMismatch = Number(sb?.cr_mismatch ?? 0);
    const skipStale = Number(sb?.stale ?? 0);
    const eligible = Number(sb?.apply_eligible ?? 0);
    const totalSkipped = skipPending + skipError + skipNoReport + skipCrMismatch + skipStale;

    Logger.info(
      `🔎 apply pre-flight: eligible=${eligible}, skipped total=${totalSkipped} ` +
      `(pending=${skipPending}, error=${skipError}, no_report=${skipNoReport}, ` +
      `cr_mismatch=${skipCrMismatch}, stale=${skipStale}); ` +
      `expected_recomputed_rows=${Number(expectedRecomputed ?? 0)}`
    );

    if (skipCrMismatch > 0) {
      const crPreview = await tx.$queryRawUnsafe<CrPreviewRow[]>(`
        SELECT "wikidotId", url, expected_rating, cr_rating, expected_count, cr_count
          FROM ${qs}.tmp_audit_summary
         WHERE status = 'collected'
           AND expected_rating IS NOT NULL
           AND expected_count  IS NOT NULL
           AND (expected_rating <> cr_rating OR expected_count <> cr_count)
         ORDER BY ABS(COALESCE(expected_rating, 0) - COALESCE(cr_rating, 0)) DESC, "wikidotId"
         LIMIT 10
      `);
      Logger.warn(`⚠️ cr_mismatch preview (top ${crPreview.length}):`);
      for (const p of crPreview) {
        Logger.warn(
          `   wikidotId=${p.wikidotId} expected=${p.expected_rating}/${p.expected_count} ` +
          `cr=${p.cr_rating}/${p.cr_count} url=${p.url ?? '(unknown)'}`
        );
      }
    }

    if (skipStale > 0) {
      const stalePreview = await tx.$queryRawUnsafe<StalePreviewRow[]>(`
        SELECT s."wikidotId",
               s.url,
               s.pa_rating,
               s.pa_count,
               pv.rating       AS pv_rating,
               pv."voteCount"  AS pv_count,
               pv."validTo"    AS valid_to,
               pv."isDeleted"  AS is_deleted
          FROM ${qs}.tmp_audit_summary s
          LEFT JOIN "PageVersion" pv ON pv.id = s."pageVersionId"
         WHERE s.status = 'collected'
           AND s.expected_rating IS NOT NULL
           AND s.expected_count  IS NOT NULL
           AND s.expected_rating = s.cr_rating           AND NOT (
             pv."validTo" IS NULL
             AND pv."isDeleted" = false
             AND pv.rating       IS NOT DISTINCT FROM s.pa_rating
             AND pv."voteCount"  IS NOT DISTINCT FROM s.pa_count
           )
         ORDER BY s."wikidotId"
         LIMIT 10
      `);
      Logger.warn(
        `⚠️ stale preview (top ${stalePreview.length}): PageVersion changed since collect; re-collect needed`
      );
      for (const p of stalePreview) {
        Logger.warn(
          `   wikidotId=${p.wikidotId} pa=${p.pa_rating}/${p.pa_count} ` +
          `pv=${p.pv_rating}/${p.pv_count} validTo=${p.valid_to ? p.valid_to.toISOString() : 'NULL'} ` +
          `isDeleted=${p.is_deleted} url=${p.url ?? '(unknown)'}`
        );
      }
    }

    if (totalSkipped > 0) {
      Logger.warn(
        `⚠️ apply will SKIP ${totalSkipped} pages (see breakdown above). ` +
        `Re-run --collect for failed/stale pages or --report for no_report rows. ` +
        `cr_mismatch pages 需要人工 review 后再决定是否 apply。`
      );
    }

    // Step 2: tmp_user → public."User"，只插被 eligible 页引用的 user 占位
    const userPlaceholderInserted = await tx.$executeRawUnsafe(`
      INSERT INTO "User" ("wikidotId", "displayName")
      SELECT DISTINCT u_tmp."wikidotId", u_tmp."displayName"
        FROM ${qs}.tmp_user u_tmp
       WHERE EXISTS (
         SELECT 1
           FROM ${qs}.tmp_vote tv
           JOIN ${qs}.tmp_audit_summary s ON s."pageVersionId" = tv."pageVersionId"
           JOIN "PageVersion" pv          ON pv.id             = s."pageVersionId"
          WHERE tv.user_wikidot_id = u_tmp."wikidotId"
            AND s.status = 'collected'
            AND s.expected_rating IS NOT NULL
            AND s.expected_count  IS NOT NULL
            AND s.expected_rating = s.cr_rating            AND pv."validTo" IS NULL
            AND pv."isDeleted" = false
            AND pv.rating       IS NOT DISTINCT FROM s.pa_rating
            AND pv."voteCount"  IS NOT DISTINCT FROM s.pa_count
       )
      ON CONFLICT ("wikidotId") DO NOTHING
    `);

    // Step 3: user-vote 路径（含 freshness guard）
    const userVoteTouched = await tx.$executeRawUnsafe(`
      INSERT INTO "Vote" ("pageVersionId", "userId", "timestamp", direction)
      SELECT DISTINCT ON (tv."pageVersionId", u.id, tv."timestamp")
             tv."pageVersionId", u.id, tv."timestamp", tv.direction
        FROM ${qs}.tmp_vote tv
        JOIN ${qs}.tmp_audit_summary s ON s."pageVersionId" = tv."pageVersionId"
        JOIN "PageVersion" pv          ON pv.id             = s."pageVersionId"
        JOIN "User" u                  ON u."wikidotId"     = tv.user_wikidot_id
       WHERE tv.user_wikidot_id IS NOT NULL
         AND s.status = 'collected'
         AND s.expected_rating IS NOT NULL
         AND s.expected_count  IS NOT NULL
         AND s.expected_rating = s.cr_rating         AND pv."validTo" IS NULL
         AND pv."isDeleted" = false
         AND pv.rating       IS NOT DISTINCT FROM s.pa_rating
         AND pv."voteCount"  IS NOT DISTINCT FROM s.pa_count
       ORDER BY tv."pageVersionId", u.id, tv."timestamp", tv.edge_seq DESC
      ON CONFLICT ("pageVersionId", "userId", "timestamp")
      DO UPDATE SET direction = EXCLUDED.direction
    `);

    // Step 4: anon 防御路径（含 freshness guard；当前期望 0 行）
    const anonVoteTouched = await tx.$executeRawUnsafe(`
      INSERT INTO "Vote" ("pageVersionId", "anonKey", "timestamp", direction)
      SELECT DISTINCT ON (tv."pageVersionId", tv."anonKey", tv."timestamp")
             tv."pageVersionId", tv."anonKey", tv."timestamp", tv.direction
        FROM ${qs}.tmp_vote tv
        JOIN ${qs}.tmp_audit_summary s ON s."pageVersionId" = tv."pageVersionId"
        JOIN "PageVersion" pv          ON pv.id             = s."pageVersionId"
       WHERE tv.user_wikidot_id IS NULL
         AND tv."anonKey" IS NOT NULL
         AND s.status = 'collected'
         AND s.expected_rating IS NOT NULL
         AND s.expected_count  IS NOT NULL
         AND s.expected_rating = s.cr_rating         AND pv."validTo" IS NULL
         AND pv."isDeleted" = false
         AND pv.rating       IS NOT DISTINCT FROM s.pa_rating
         AND pv."voteCount"  IS NOT DISTINCT FROM s.pa_count
       ORDER BY tv."pageVersionId", tv."anonKey", tv."timestamp", tv.edge_seq DESC
      ON CONFLICT ("pageVersionId", "anonKey", "timestamp")
      DO UPDATE SET direction = EXCLUDED.direction
    `);

    return {
      expectedRecomputed: Number(expectedRecomputed ?? 0),
      eligible,
      skipPending,
      skipError,
      skipNoReport,
      skipCrMismatch,
      skipStale,
      totalSkipped,
      userPlaceholderInserted: Number(userPlaceholderInserted ?? 0),
      userVoteTouched: Number(userVoteTouched ?? 0),
      anonVoteTouched: Number(anonVoteTouched ?? 0)
    };
  }, {
    // INSERT 180k+ 行 + 多 SQL 步骤可能跑几分钟，Prisma 默认 5s 不够
    timeout: 600_000,    // 10 min
    maxWait: 30_000      // 30 s 等连接
  });

  Logger.info(
    `✅ apply complete: public.User new=${result.userPlaceholderInserted}, ` +
    `user-vote rows touched=${result.userVoteTouched}, anon-vote rows touched=${result.anonVoteTouched} ` +
    `(rows include INSERT + ON CONFLICT DO UPDATE; eligible=${result.eligible}, skipped=${result.totalSkipped}, stale=${result.skipStale}; expected_recomputed=${result.expectedRecomputed})`
  );
  if (result.skipStale > 0) {
    Logger.warn(
      `⚠️ apply skipped ${result.skipStale} stale pages (PageVersion changed since collect; re-collect needed)`
    );
  }
}

async function doCleanup(prisma: PrismaClient, schema: string): Promise<void> {
  const qs = quoteIdent(schema);
  await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS ${qs} CASCADE`);
  Logger.info(`🧹 schema ${schema} dropped`);
}

export async function runVoteResyncAudit(opts: VoteResyncAuditOptions): Promise<void> {
  const schema = opts.schema && opts.schema.trim() ? opts.schema.trim() : DEFAULT_SCHEMA;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) {
    throw new Error(`invalid schema name: ${schema}`);
  }

  // 默认顺序：setup → collect → report；显式传任何 flag 时只跑被指定的步骤。
  const explicitlyChosen =
    Boolean(opts.setup) ||
    Boolean(opts.collect) ||
    Boolean(opts.report) ||
    Boolean(opts.apply) ||
    Boolean(opts.cleanup);

  const runSetup = explicitlyChosen ? Boolean(opts.setup) : true;
  const runCollect = explicitlyChosen ? Boolean(opts.collect) : true;
  const runReport = explicitlyChosen ? Boolean(opts.report) : true;
  const runApply = Boolean(opts.apply);
  const runCleanup = Boolean(opts.cleanup);

  const fetchConcurrency = Math.max(
    1,
    Number.isFinite(opts.fetchConcurrency) && (opts.fetchConcurrency ?? 0) > 0
      ? Number(opts.fetchConcurrency)
      : DEFAULT_FETCH_CONCURRENCY
  );

  const prisma = getPrismaClient();
  try {
    if (runSetup) {
      Logger.info(`🛠️  setup: ensuring schema ${schema} and tmp tables`);
      await ensureSchemaAndTables(prisma, schema);
    }
    if (runCollect) {
      Logger.info('📥 collect: seed tmp_audit_summary and pull CROM fuzzyVoteRecords (no public reads)');
      await doCollect(prisma, schema, fetchConcurrency);
    }
    if (runReport) {
      Logger.info('📊 report: compute expected_rating/expected_count and render markdown');
      await doReport(prisma, schema);
    }
    if (runApply) {
      Logger.info('🚀 apply: writing tmp_user → public.User and tmp_vote → "Vote" (transactional)');
      await doApply(prisma, schema);
    }
    if (runCleanup) {
      Logger.info(`🧹 cleanup: dropping schema ${schema}`);
      await doCleanup(prisma, schema);
    }
  } finally {
    await disconnectPrisma();
  }
}
