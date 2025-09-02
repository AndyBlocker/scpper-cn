import { PrismaClient } from '@prisma/client';

type CategoryKey = 'scp' | 'story' | 'goi' | 'translation' | 'wanderers' | 'art';

export type CategoryBenchmark = {
  category: CategoryKey;
  p05Rating: number;    // 该分类用户rating的5分位（仅count>0）
  p50Rating: number;    // 该分类用户rating的50分位（仅count>0）
  p90Rating: number;    // 该分类用户rating的90分位（仅count>0）
  p95Rating: number;    // 该分类用户rating的95分位（仅count>0）
  p99Rating: number;    // 该分类用户rating的99分位（仅count>0）
  avgRating: number;    // 平均rating
  tau: number;          // 稳健尺度（MAD 或其近似），用于 asinh 变换
  nAuthors: number;     // 参与计算的作者数（该分类作品数>0）
};

export type CategoryBenchmarksPayload = {
  asOf: string; // ISO 时间
  benchmarks: Record<CategoryKey, CategoryBenchmark>;
  method: 'asinh_piecewise_p50_p95_p99_v3' | 'asinh_p50_p95_v2' | 'legacy_linear_p50_p95';
  version: 3;
};

/**
 * 计算作者在各分类下的 rating 分布基准（P50 / P95 / 平均）并缓存在 LeaderboardCache。
 * - 基于 UserStats 的 per-user category rating 字段（仅对应 count>0 的用户纳入）。
 * - 结果写入 LeaderboardCache(key='category_benchmarks_author_rating', period='daily')。
 */
export async function computeUserCategoryBenchmarks(prisma: PrismaClient): Promise<CategoryBenchmarksPayload> {
  // 单次 SQL 计算所有分类的统计量
  const rows = await prisma.$queryRaw<Array<{
    category: string;
    p05_rating: number | null;
    p50_rating: number | null;
    p90_rating: number | null;
    p95_rating: number | null;
    p99_rating: number | null;
    avg_rating: number | null;
    n_authors: number | null;
    tau: number | null;
  }>>`
    WITH combined AS (
      SELECT 'scp'::text AS category, us."scpRating"::float AS rating
      FROM "UserStats" us WHERE us."scpPageCount" > 0
      UNION ALL
      SELECT 'story'::text AS category, us."storyRating"::float AS rating
      FROM "UserStats" us WHERE us."storyPageCount" > 0
      UNION ALL
      SELECT 'goi'::text AS category, us."goiRating"::float AS rating
      FROM "UserStats" us WHERE us."goiPageCount" > 0
      UNION ALL
      SELECT 'translation'::text AS category, us."translationRating"::float AS rating
      FROM "UserStats" us WHERE us."translationPageCount" > 0
      UNION ALL
      SELECT 'wanderers'::text AS category, us."wanderersRating"::float AS rating
      FROM "UserStats" us WHERE us."wanderersPageCount" > 0
      UNION ALL
      SELECT 'art'::text AS category, us."artRating"::float AS rating
      FROM "UserStats" us WHERE us."artPageCount" > 0
    ),
    stats AS (
      SELECT 
        c.category,
        PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY c.rating) AS p05_rating,
        PERCENTILE_CONT(0.25) WITHIN GROUP (ORDER BY c.rating) AS p25_rating,
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY c.rating) AS p50_rating,
        PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY c.rating) AS p75_rating,
        PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY c.rating) AS p90_rating,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY c.rating) AS p95_rating,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY c.rating) AS p99_rating,
        AVG(c.rating) AS avg_rating,
        COUNT(*) AS n_authors
      FROM combined c
      GROUP BY c.category
    )
    SELECT 
      s.category,
      s.p05_rating,
      s.p50_rating,
      s.p90_rating,
      s.p95_rating,
      s.p99_rating,
      s.avg_rating,
      s.n_authors,
      GREATEST(1e-6, NULLIF(s.p75_rating - s.p25_rating, 0) / 1.349) AS tau
    FROM stats s
  `;

  // 组装 payload
  const nowIso = new Date().toISOString();
  const normalize = (v: number | null | undefined): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

  const emptyBench: CategoryBenchmark = { category: 'scp', p05Rating: 0, p50Rating: 0, p90Rating: 0, p95Rating: 0, p99Rating: 0, avgRating: 0, tau: 1e-6, nAuthors: 0 };
  const byCat = new Map<CategoryKey, CategoryBenchmark>();

  (['scp','story','goi','translation','wanderers','art'] as CategoryKey[]).forEach((k) => {
    byCat.set(k, { ...emptyBench, category: k });
  });

  for (const r of rows) {
    const cat = (r.category || '') as CategoryKey;
    if (!byCat.has(cat)) continue;
    byCat.set(cat, {
      category: cat,
      p05Rating: normalize(r.p05_rating),
      p50Rating: normalize(r.p50_rating),
      p90Rating: normalize(r.p90_rating),
      p95Rating: normalize(r.p95_rating),
      p99Rating: normalize(r.p99_rating),
      avgRating: normalize(r.avg_rating),
      tau: Math.max(1e-6, normalize(r.tau)),
      nAuthors: Math.max(0, Number(r.n_authors || 0))
    });
  }

  const payload: CategoryBenchmarksPayload = {
    asOf: nowIso,
    benchmarks: Object.fromEntries(Array.from(byCat.entries())) as Record<CategoryKey, CategoryBenchmark>,
    method: 'asinh_piecewise_p50_p95_p99_v3',
    version: 3
  };

  // Upsert into LeaderboardCache
  const key = 'category_benchmarks_author_rating_v3';
  const period = 'daily';
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // +24h

  await prisma.leaderboardCache.upsert({
    where: { key_period: { key, period } },
    create: {
      key,
      period,
      payload: payload as unknown as object,
      expiresAt
    },
    update: {
      payload: payload as unknown as object,
      updatedAt: new Date(),
      expiresAt
    }
  });

  return payload;
}


