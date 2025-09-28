-- Wilson lower bound (95% CI) and controversy functions
-- These functions are used by IncrementalAnalyze to compute PageStats

-- Wilson score lower bound at 95% confidence
CREATE OR REPLACE FUNCTION public.f_wilson_lower_bound(up integer, down integer)
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

-- Normalized controversy index in [0,1], peaks at balanced votes
CREATE OR REPLACE FUNCTION public.f_controversy(up integer, down integer)
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



