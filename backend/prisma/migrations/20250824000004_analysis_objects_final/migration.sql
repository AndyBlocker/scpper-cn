-- Finalize analysis objects: bigint function overloads and materialized view

-- Ensure functions (bigint) exist
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

-- Create materialized view if missing using DO/EXECUTE with single quotes
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_matviews WHERE schemaname = 'public' AND matviewname = 'mv_top_pages_30d'
  ) THEN
    EXECUTE 'CREATE MATERIALIZED VIEW public.mv_top_pages_30d AS
      WITH votes_30d AS (
        SELECT pv."pageId",
               COUNT(*) FILTER (WHERE v.direction = 1) AS uv,
               COUNT(*) FILTER (WHERE v.direction = -1) AS dv
        FROM "Vote" v
        JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
        WHERE v."timestamp" >= NOW() - INTERVAL ''30 days''
          AND pv."validTo" IS NULL
        GROUP BY pv."pageId"
      )
      SELECT p.id AS "pageId",
             MAX(pv.title) AS title,
             COALESCE(MAX(v.uv),0) AS uv,
             COALESCE(MAX(v.dv),0) AS dv,
             f_wilson_lower_bound(COALESCE(MAX(v.uv),0), COALESCE(MAX(v.dv),0)) AS wilson95
      FROM "Page" p
      LEFT JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
      LEFT JOIN votes_30d v ON v."pageId" = p.id
      GROUP BY p.id';
    EXECUTE 'CREATE UNIQUE INDEX idx_mv_top_pages_30d_pageId ON public.mv_top_pages_30d ("pageId")';
  END IF;
END $$;


