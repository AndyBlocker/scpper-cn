// scripts/check-ranking-totals.ts
// 检查综合排名（overallRank）对应的“总分显示”是否异常：
//  - 对照 UserStats.totalRating（总分，排名依据） 与 UserStats.overallRating（当前作为均值存放）
//  - 复算前 N 名用户的总分（基于 Attribution × 当前有效 PageVersion）核对是否一致

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

type Row = {
  id: number;
  wikidotId: number | null;
  displayName: string | null;
  rank: number | null;
  total: number; // UserStats.totalRating (int)
  pages: number; // UserStats.pageCount
  mean: number; // UserStats.overallRating (float, 当前用于存放“过滤口径均值”)
  computed_total: number | null; // 复算的总分（float）
  computed_pages: number | null; // 复算的作品数
};

function toInt(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.trunc(v) : 0;
}

async function main() {
  const prisma = new PrismaClient();
  const limit = Number.parseInt(process.env.CHECK_RANK_LIMIT || '50', 10) || 50;

  console.log(`🔎 检查前 ${limit} 名综合排名用户的“总分/均值/复算”情况...`);

  const rows = await prisma.$queryRaw<Row[]>`
    WITH top AS (
      SELECT us."userId"
      FROM "UserStats" us
      WHERE us."overallRank" IS NOT NULL
      ORDER BY us."overallRank" ASC
      LIMIT ${limit}
    ),
    roles AS (
      -- 用户-页面（去重到 pageId）
      SELECT DISTINCT a."userId", pv."pageId"
      FROM "Attribution" a
      JOIN "PageVersion" pv ON pv.id = a."pageVerId"
      JOIN top t ON t."userId" = a."userId"
      WHERE pv."validTo" IS NULL
        AND pv."isDeleted" = false
    ),
    cur AS (
      -- 当前有效且未删除、有评分的版本
      SELECT pv."pageId", pv.rating
      FROM "PageVersion" pv
      WHERE pv."validTo" IS NULL
        AND pv."isDeleted" = false
        AND pv.rating IS NOT NULL
    ),
    agg AS (
      SELECT r."userId",
             SUM(c.rating)::float AS computed_total,
             COUNT(*)::int AS computed_pages
      FROM roles r
      JOIN cur c ON c."pageId" = r."pageId"
      GROUP BY r."userId"
    )
    SELECT u.id,
           u."wikidotId",
           u."displayName",
           us."overallRank" AS rank,
           us."totalRating"  AS total,
           us."pageCount"    AS pages,
           COALESCE(us."overallRating", 0)::float AS mean,
           COALESCE(agg.computed_total, 0)::float   AS computed_total,
           COALESCE(agg.computed_pages, 0)::int     AS computed_pages
    FROM "User" u
    JOIN "UserStats" us ON us."userId" = u.id
    LEFT JOIN agg ON agg."userId" = us."userId"
    WHERE us."userId" IN (SELECT "userId" FROM top)
    ORDER BY us."overallRank" ASC;
  `;

  if (!rows.length) {
    console.log('ℹ️ 未查询到任何排名数据。');
    await prisma.$disconnect();
    return;
  }

  const report = rows.map((r) => {
    const total = toInt(r.total);
    const comp = Math.round(Number(r.computed_total || 0));
    const meanFromTotal = r.pages > 0 ? total / r.pages : 0;
    const meanStored = Number(r.mean || 0);
    const listRatingDelta = Math.abs(meanStored - total);
    const totalDelta = Math.abs(comp - total);
    const flags: string[] = [];

    // 如果“榜单显示值（BFF 当前使用 overallRating）”与总分相差较大，则标注
    if (total > 0 && listRatingDelta / Math.max(1, total) > 0.1) {
      flags.push('LIST_SHOWS_MEAN_NOT_TOTAL');
    }
    // 如果复算与库存总分不一致，标注（允许 ±1 的离散化误差）
    if (totalDelta > 1) {
      flags.push('TOTAL_MISMATCH_AGAINST_RECOMPUTE');
    }

    return {
      rank: r.rank ?? '-'.toString(),
      userId: r.id,
      wikidotId: r.wikidotId ?? '-',
      name: r.displayName ?? '-',
      total,
      total_recompute: comp,
      pages: r.pages,
      mean_stored: Number(meanStored.toFixed(2)),
      mean_from_total: Number(meanFromTotal.toFixed(2)),
      flags: flags.join('|') || ''
    };
  });

  console.table(report, [
    'rank', 'wikidotId', 'name', 'total', 'total_recompute', 'pages',
    'mean_stored', 'mean_from_total', 'flags'
  ]);

  const suspicious = report.filter(r => r.flags.includes('LIST_SHOWS_MEAN_NOT_TOTAL'));
  console.log(`\n❗ 检测到 ${suspicious.length} 条“榜单显示均值而非总分”的可疑记录（前 ${limit} 名）`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('检查失败：', err);
  process.exitCode = 1;
});

