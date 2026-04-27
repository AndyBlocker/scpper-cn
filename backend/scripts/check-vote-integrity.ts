#!/usr/bin/env node
import { disconnectPrisma, getPrismaClient } from '../src/utils/db-connection.ts';

/**
 * check-vote-integrity
 *
 * 常态化对账脚本：比对 LatestVote 重算的 (rating, voteCount) 与 PageVersion 上的
 * pa_rating / pa_count，输出 7 个 bucket 的统计 + top 20 偏差页详情。
 *
 * CLI 选项：
 *   --threshold N     any_mismatch > N 时 exit 1（默认 100）
 *   --json            以 JSON 输出
 */

type SummaryRow = {
  total_pages: bigint | number | null;
  no_votes_synced: bigint | number | null;
  perfect_match: bigint | number | null;
  rating_mismatch: bigint | number | null;
  count_mismatch: bigint | number | null;
  direction_out_of_range: bigint | number | null;
  any_mismatch: bigint | number | null;
};

type AnomalyRow = {
  wikidotId: number | null;
  pageVersionId: number;
  url: string | null;
  pa_rating: number | null;
  pa_count: number | null;
  lv_total: number | string | null;
  lv_net: number | string | null;
  lv_zero: number | string | null;
};

function toNumber(value: bigint | number | string | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseArgs(argv: string[]): { threshold: number; json: boolean } {
  let threshold = 100;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      json = true;
    } else if (arg === '--threshold') {
      const next = argv[i + 1];
      if (next !== undefined) {
        const parsed = Number.parseInt(next, 10);
        if (Number.isFinite(parsed) && parsed >= 0) threshold = parsed;
        i += 1;
      }
    } else if (arg.startsWith('--threshold=')) {
      const parsed = Number.parseInt(arg.slice('--threshold='.length), 10);
      if (Number.isFinite(parsed) && parsed >= 0) threshold = parsed;
    }
  }
  return { threshold, json };
}

async function main(): Promise<number> {
  const { threshold, json } = parseArgs(process.argv.slice(2));
  const prisma = getPrismaClient();

  const summaryRows = await prisma.$queryRawUnsafe<SummaryRow[]>(`
    WITH lv_agg AS (
      SELECT lv."pageVersionId" AS pvid,
             COUNT(*)::int                              AS lv_total,
             COALESCE(SUM(lv.direction)::int, 0)        AS lv_net,
             COUNT(*) FILTER (WHERE lv.direction = 0)::int AS lv_zero,
             BOOL_OR(lv.direction NOT IN (-1,0,1))      AS has_oor
        FROM "LatestVote" lv
       GROUP BY lv."pageVersionId"
    )
    SELECT
      COUNT(*)::bigint AS total_pages,
      COUNT(*) FILTER (
        WHERE COALESCE(lv_total, 0) = 0 AND pv."voteCount" > 0
      )::bigint AS no_votes_synced,
      COUNT(*) FILTER (
        WHERE lv_total > 0
          AND lv_net = pv.rating
          AND (lv_total - lv_zero) = pv."voteCount"
      )::bigint AS perfect_match,
      COUNT(*) FILTER (
        WHERE lv_total > 0 AND (lv_net <> pv.rating)
      )::bigint AS rating_mismatch,
      COUNT(*) FILTER (
        WHERE lv_total > 0 AND (lv_total - lv_zero) <> pv."voteCount"
      )::bigint AS count_mismatch,
      COUNT(*) FILTER (WHERE has_oor)::bigint AS direction_out_of_range,
      COUNT(*) FILTER (
        WHERE lv_total > 0
          AND (lv_net <> pv.rating
            OR (lv_total - lv_zero) <> pv."voteCount")
      )::bigint AS any_mismatch
    FROM "PageVersion" pv
    LEFT JOIN lv_agg lv ON lv.pvid = pv.id
    WHERE pv."validTo" IS NULL
      AND pv."isDeleted" = false
      AND pv."voteCount" IS NOT NULL
  `);

  const anomalies = await prisma.$queryRawUnsafe<AnomalyRow[]>(`
    WITH lv_agg AS (
      SELECT lv."pageVersionId" AS pvid,
             COUNT(*)::int                              AS lv_total,
             COALESCE(SUM(lv.direction)::int, 0)        AS lv_net,
             COUNT(*) FILTER (WHERE lv.direction = 0)::int AS lv_zero
        FROM "LatestVote" lv
       GROUP BY lv."pageVersionId"
    )
    SELECT pg."wikidotId"   AS "wikidotId",
           pv.id            AS "pageVersionId",
           pg."currentUrl"  AS url,
           pv.rating        AS pa_rating,
           pv."voteCount"   AS pa_count,
           COALESCE(lv.lv_total, 0) AS lv_total,
           COALESCE(lv.lv_net,   0) AS lv_net,
           COALESCE(lv.lv_zero,  0) AS lv_zero
      FROM "PageVersion" pv
      JOIN "Page" pg ON pg.id = pv."pageId"
      LEFT JOIN lv_agg lv ON lv.pvid = pv.id
     WHERE pv."validTo" IS NULL
       AND pv."isDeleted" = false
       AND pv."voteCount" IS NOT NULL
       AND (
         (COALESCE(lv.lv_total, 0) = 0 AND pv."voteCount" > 0)
         OR (lv.lv_total > 0 AND lv.lv_net <> pv.rating)
         OR (lv.lv_total > 0 AND (lv.lv_total - lv.lv_zero) <> pv."voteCount")
       )
     ORDER BY ABS(COALESCE(lv.lv_net, 0) - pv.rating) DESC,
              ABS(COALESCE(lv.lv_total - lv.lv_zero, 0) - pv."voteCount") DESC,
              pg."wikidotId"
     LIMIT 20
  `);

  const summary = {
    totalPages: toNumber(summaryRows[0]?.total_pages),
    noVotesSynced: toNumber(summaryRows[0]?.no_votes_synced),
    perfectMatch: toNumber(summaryRows[0]?.perfect_match),
    ratingMismatch: toNumber(summaryRows[0]?.rating_mismatch),
    countMismatch: toNumber(summaryRows[0]?.count_mismatch),
    directionOutOfRange: toNumber(summaryRows[0]?.direction_out_of_range),
    anyMismatch: toNumber(summaryRows[0]?.any_mismatch)
  };

  const anomaliesDisplay = anomalies.map((a) => {
    const lvTotal = toNumber(a.lv_total);
    const lvZero = toNumber(a.lv_zero);
    const lvNet = toNumber(a.lv_net);
    const paRating = toNumber(a.pa_rating);
    const paCount = toNumber(a.pa_count);
    const lvCount = lvTotal - lvZero;
    return {
      wikidotId: a.wikidotId,
      pageVersionId: a.pageVersionId,
      url: a.url,
      paRating,
      paCount,
      lvNet,
      lvCount,
      diffRating: paRating - lvNet,
      diffCount: paCount - lvCount
    };
  });

  const exceeded = summary.anyMismatch > threshold;

  if (json) {
    console.log(
      JSON.stringify(
        {
          summary,
          threshold,
          exceeded,
          anomalies: anomaliesDisplay
        },
        null,
        2
      )
    );
  } else {
    console.log('# vote-integrity report');
    console.log('');
    console.log('## Bucket counts');
    console.table(summary);
    console.log('');
    console.log(`Threshold = ${threshold} on any_mismatch (current = ${summary.anyMismatch})`);
    console.log(exceeded ? '⚠️  exceeded threshold — exit 1' : '✅ within threshold');
    if (anomaliesDisplay.length > 0) {
      console.log('');
      console.log('## Top 20 偏差页 (按 |paRating - lvNet| desc)');
      console.table(anomaliesDisplay);
    } else {
      console.log('');
      console.log('🎉 No mismatches detected.');
    }
  }

  return exceeded ? 1 : 0;
}

main()
  .then(async (code) => {
    try {
      await disconnectPrisma();
    } catch {
      // ignore
    }
    process.exit(code);
  })
  .catch(async (err) => {
    console.error(err);
    try {
      await disconnectPrisma();
    } catch {
      // ignore
    }
    process.exit(2);
  });
