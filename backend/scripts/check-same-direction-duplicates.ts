#!/usr/bin/env node
import { Prisma } from '@prisma/client';
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.ts';
import fs from 'fs';

interface DuplicateVoteDetail {
  voteId: number;
  timestamp: string;
  direction: number;
}

interface DuplicateRow {
  pageId: number;
  pageWikidotId: number | null;
  pageUrl: string | null;
  pageTitle: string | null;
  userId: number;
  userDisplayName: string | null;
  upCount: number;
  downCount: number;
  totalVotes: number;
  firstVoteAt: Date;
  lastVoteAt: Date;
  totalGroups: number;
  upVotes: unknown;
  downVotes: unknown;
}

interface ScriptOptions {
  limit: number | null;
  limitSpecified: boolean;
  includeHistorical: boolean;
  json: boolean;
  outputPath?: string;
}

function parseOptions(argv: string[]): ScriptOptions {
  let limit: number | null = null;
  let includeHistorical = false;
  let json = false;
  let outputPath: string | undefined;
  let limitSpecified = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--include-historical' || arg === '--all-versions') {
      includeHistorical = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--output' || arg === '-o') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        outputPath = next;
        i += 1;
      } else {
        console.warn('⚠️ --output 需要一个文件路径参数，已忽略该选项。');
      }
    } else if (arg.startsWith('--output=')) {
      const value = arg.split('=')[1];
      if (value) outputPath = value;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (arg === '--limit' || arg === '-l') {
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        limit = parseLimit(next, 20);
        limitSpecified = true;
        i += 1;
      }
    } else if (arg.startsWith('--limit=')) {
      const value = arg.split('=')[1];
      limit = parseLimit(value, 20);
      limitSpecified = true;
    }
  }

  return { limit, limitSpecified, includeHistorical, json, outputPath };
}

function parseLimit(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`⚠️ 无效的 limit 参数 "${value}"，使用默认值 ${fallback}`);
    return fallback;
  }
  return Math.min(parsed, 200);
}

function printUsage(): void {
  console.log(`用法: node --import tsx/esm backend/scripts/check-same-direction-duplicates.ts [选项]

选项:
  --limit <number>           输出的最大异常组合数量（默认 20，最大 200）
  --include-historical       包含历史 PageVersion（默认仅检查当前版本）
  --json                     使用 JSON 格式输出结果，便于后续处理
  --output <path>            将完整表格写入指定文件（CSV 或 JSON）
  --help                     显示本帮助信息
`);
}

function normalizeVoteList(raw: unknown): DuplicateVoteDetail[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const voteId = typeof (entry as any).voteId === 'number' ? (entry as any).voteId : null;
    const direction = typeof (entry as any).direction === 'number' ? (entry as any).direction : null;
    const timestamp = typeof (entry as any).timestamp === 'string' ? (entry as any).timestamp : null;
    if (voteId == null || direction == null || timestamp == null) return [];
    return [{ voteId, direction, timestamp }];
  });
}

async function detect(options: ScriptOptions): Promise<void> {
  const prisma = getPrismaClient();
  const DEFAULT_DISPLAY_LIMIT = 20;
  const { limit, limitSpecified, includeHistorical, json, outputPath } = options;
  const queryLimit = limitSpecified ? limit : (outputPath ? null : DEFAULT_DISPLAY_LIMIT);
  const displayLimit = limitSpecified && limit != null ? limit : DEFAULT_DISPLAY_LIMIT;
  const limitClause = queryLimit != null ? Prisma.sql`LIMIT ${queryLimit}` : Prisma.sql``;

  // NOTE: 本脚本只检测 ±1 方向的同向重复投票（数据完整性检查）；±2 不在此分析范围内，
  // 因此 SQL 内仍使用 `direction IN (-1, 1)` 与 `direction = 1`/`direction = -1`，与全站
  // upvote/downvote 计数口径（`direction > 0`/`direction < 0`）有意区分，请勿改动。
  const rows = await prisma.$queryRaw<DuplicateRow[]>(Prisma.sql`
    WITH filtered_votes AS (
      SELECT
        v.id,
        pv."pageId",
        pv."wikidotId",
        p."currentUrl",
        COALESCE(pv.title, p."currentUrl") AS page_title,
        v."userId",
        COALESCE(u."displayName", u."username", 'user#' || u.id::text) AS user_label,
        v.direction,
        v."timestamp"
      FROM "Vote" v
      JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
      JOIN "Page" p ON p.id = pv."pageId"
      JOIN "User" u ON u.id = v."userId"
      WHERE v."userId" IS NOT NULL
        AND v.direction IN (-1, 1)
        AND pv."isDeleted" = false
        AND (${includeHistorical} OR pv."validTo" IS NULL)
    ),
    grouped AS (
      SELECT
        fv."pageId",
        fv."wikidotId",
        fv."currentUrl",
        fv.page_title,
        fv."userId",
        fv.user_label,
        SUM(CASE WHEN fv.direction = 1 THEN 1 ELSE 0 END)::int AS up_count,
        SUM(CASE WHEN fv.direction = -1 THEN 1 ELSE 0 END)::int AS down_count,
        COUNT(*)::int AS total_votes,
        MIN(fv."timestamp") AS first_vote_at,
        MAX(fv."timestamp") AS last_vote_at
      FROM filtered_votes fv
      GROUP BY fv."pageId", fv."wikidotId", fv."currentUrl", fv.page_title, fv."userId", fv.user_label
      HAVING SUM(CASE WHEN fv.direction = 1 THEN 1 ELSE 0 END) > 1
         OR SUM(CASE WHEN fv.direction = -1 THEN 1 ELSE 0 END) > 1
    )
    SELECT
      g."pageId"::int AS "pageId",
      g."wikidotId"::int AS "pageWikidotId",
      g."currentUrl" AS "pageUrl",
      g.page_title AS "pageTitle",
      g."userId"::int AS "userId",
      g.user_label AS "userDisplayName",
      g.up_count AS "upCount",
      g.down_count AS "downCount",
      g.total_votes AS "totalVotes",
      g.first_vote_at AS "firstVoteAt",
      g.last_vote_at AS "lastVoteAt",
      COUNT(*) OVER ()::int AS "totalGroups",
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'voteId', fv.id,
            'direction', fv.direction,
            'timestamp', fv."timestamp"
          )
          ORDER BY fv."timestamp", fv.id
        )
        FROM filtered_votes fv
        WHERE fv."pageId" = g."pageId"
          AND fv."userId" = g."userId"
          AND fv.direction = 1
      ) AS "upVotes",
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'voteId', fv.id,
            'direction', fv.direction,
            'timestamp', fv."timestamp"
          )
          ORDER BY fv."timestamp", fv.id
        )
        FROM filtered_votes fv
        WHERE fv."pageId" = g."pageId"
          AND fv."userId" = g."userId"
          AND fv.direction = -1
      ) AS "downVotes"
    FROM grouped g
    ORDER BY GREATEST(g.up_count, g.down_count) DESC, g.total_votes DESC, g.last_vote_at DESC
    ${limitClause}
  `);

  const totalGroups = rows[0]?.totalGroups ?? 0;

  if (json) {
    const payload = {
      includeHistorical,
      limit,
      totalGroups,
      results: rows.map((row) => ({
        pageId: row.pageId,
        pageWikidotId: row.pageWikidotId,
        pageUrl: row.pageUrl,
        pageTitle: row.pageTitle,
        userId: row.userId,
        userDisplayName: row.userDisplayName,
        upCount: row.upCount,
        downCount: row.downCount,
        totalVotes: row.totalVotes,
        firstVoteAt: row.firstVoteAt?.toISOString() ?? null,
        lastVoteAt: row.lastVoteAt?.toISOString() ?? null,
        upVotes: normalizeVoteList(row.upVotes),
        downVotes: normalizeVoteList(row.downVotes)
      }))
    };
    const serialized = JSON.stringify(payload, null, 2);
    if (outputPath) {
      fs.writeFileSync(outputPath, serialized, 'utf8');
      console.log(`📄 JSON 结果已写入 ${outputPath}`);
    } else {
      console.log(serialized);
    }
    return;
  }

  if (totalGroups === 0) {
    console.log('✅ 未发现同一用户对同一页面的同向重复评分。');
    if (outputPath) {
      fs.writeFileSync(outputPath, 'user,title,url,upDuplicates,downDuplicates,totalVotes,first,last\n', 'utf8');
      console.log(`📄 已写入空结果表头到 ${outputPath}`);
    }
    return;
  }

  const summary = rows.map((row) => ({
    user: row.userDisplayName ?? `user#${row.userId}`,
    title: row.pageTitle ?? '(无标题)',
    url: row.pageUrl ?? '',
    upDuplicates: row.upCount,
    downDuplicates: row.downCount,
    totalVotes: row.totalVotes,
    first: row.firstVoteAt?.toISOString() ?? '',
    last: row.lastVoteAt?.toISOString() ?? ''
  }));
  const displayedSummary = displayLimit > 0 ? summary.slice(0, displayLimit) : summary;
  console.log(`⚠️ 检测到 ${totalGroups} 个疑似同向重复评分组合（显示前 ${displayedSummary.length} 条）。`);
  console.table(displayedSummary);
  if (summary.length > displayedSummary.length) {
    const note = outputPath
      ? `（已截取前 ${displayedSummary.length} 条，其余结果已写入 ${outputPath}）`
      : `（仅显示前 ${displayedSummary.length} 条，使用 --limit 可调整）`;
    console.log(note);
  }

  if (outputPath) {
    const header = ['user', 'title', 'url', 'upDuplicates', 'downDuplicates', 'totalVotes', 'first', 'last'];
    const lines: string[] = [header.join(',')];
    const escapeCsv = (value: string | number): string => {
      const str = String(value ?? '');
      if (str.includes('"') || str.includes(',') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };
    for (const row of summary) {
      lines.push([
        escapeCsv(row.user),
        escapeCsv(row.title),
        escapeCsv(row.url),
        escapeCsv(row.upDuplicates),
        escapeCsv(row.downDuplicates),
        escapeCsv(row.totalVotes),
        escapeCsv(row.first),
        escapeCsv(row.last)
      ].join(','));
    }
    fs.writeFileSync(outputPath, `${lines.join('\n')}\n`, 'utf8');
    console.log(`📄 汇总表格已写入 ${outputPath}`);
  }

  rows.forEach((row) => {
    const upDetails = normalizeVoteList(row.upVotes);
    const downDetails = normalizeVoteList(row.downVotes);
    const pageLabel = row.pageTitle ? `${row.pageTitle} (${row.pageUrl ?? `id:${row.pageId}`})` : (row.pageUrl ?? `pageId:${row.pageId}`);
    const userLabel = row.userDisplayName ?? `user#${row.userId}`;
    console.log(`\n页面 ${pageLabel} / 用户 ${userLabel} (id=${row.userId})`);
    console.log(`  上票记录数: ${row.upCount}，下票记录数: ${row.downCount}，总票数: ${row.totalVotes}`);
    console.log(`  首次异常时间: ${row.firstVoteAt?.toISOString() ?? '未知'}, 最近异常时间: ${row.lastVoteAt?.toISOString() ?? '未知'}`);
    if (row.upCount > 1 && upDetails.length > 0) {
      console.log('  重复上票详情:');
      upDetails.forEach((vote) => {
        console.log(`    • voteId=${vote.voteId}, ts=${vote.timestamp}`);
      });
    }
    if (row.downCount > 1 && downDetails.length > 0) {
      console.log('  重复下票详情:');
      downDetails.forEach((vote) => {
        console.log(`    • voteId=${vote.voteId}, ts=${vote.timestamp}`);
      });
    }
  });
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  try {
    await detect(options);
  } finally {
    await disconnectPrisma();
  }
}

main().catch((error) => {
  console.error('❌ 检测过程中出现错误:', error);
  process.exitCode = 1;
});
