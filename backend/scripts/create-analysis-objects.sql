-- Create overloaded analysis functions and materialized views required by IncrementalAnalyzeJob
-- Safe to run multiple times

-- Wilson lower bound (bigint overload)
DROP FUNCTION IF EXISTS public.f_wilson_lower_bound(bigint, bigint);
CREATE OR REPLACE FUNCTION public.f_wilson_lower_bound(up bigint, down bigint)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $$
SELECT CASE
  WHEN (COALESCE(up,0) + COALESCE(down,0)) = 0 THEN 0::float8
  ELSE (
    (
      up::float8 / (up + down)
    ) + (1.96^2) / (2 * (up + down))
    - 1.96 * sqrt(
        (
          (up::float8 / (up + down)) * (1 - (up::float8 / (up + down)))
          + (1.96^2) / (4 * (up + down) * (up + down))
        ) / (up + down)
      )
  ) / (1 + (1.96^2) / (up + down))
END;
$$;

-- Controversy index (bigint overload)
DROP FUNCTION IF EXISTS public.f_controversy(bigint, bigint);
CREATE OR REPLACE FUNCTION public.f_controversy(up bigint, down bigint)
RETURNS double precision
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $$
SELECT CASE
  WHEN (COALESCE(up,0) + COALESCE(down,0)) = 0 THEN 0::float8
  ELSE (4.0 * up::float8 * down::float8) / (((up + down)::float8) * ((up + down)::float8))
END;
$$;

-- Materialized view for top pages over last 30 days by Wilson gain or score
-- Minimal but consistent definition; requires unique index for CONCURRENT refresh
CREATE MATERIALIZED VIEW IF NOT EXISTS public.mv_top_pages_30d AS
WITH votes_30d AS (
  SELECT pv."pageId",
         COUNT(*) FILTER (WHERE v.direction = 1) AS uv,
         COUNT(*) FILTER (WHERE v.direction = -1) AS dv
  FROM "Vote" v
  JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
  WHERE v."timestamp" >= NOW() - INTERVAL '30 days'
    AND pv."validTo" IS NULL
  GROUP BY pv."pageId"
)
SELECT p.id AS "pageId",
       MAX(pv.title) AS title,
       COALESCE(v.uv,0) AS uv,
       COALESCE(v.dv,0) AS dv,
       f_wilson_lower_bound(COALESCE(v.uv,0), COALESCE(v.dv,0)) AS wilson95
FROM "Page" p
LEFT JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
LEFT JOIN votes_30d v ON v."pageId" = p.id
GROUP BY p.id;

-- Unique index required by REFRESH MATERIALIZED VIEW CONCURRENTLY
CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_top_pages_30d_pageId ON public.mv_top_pages_30d ("pageId");


