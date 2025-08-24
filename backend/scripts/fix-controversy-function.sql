-- Fix f_controversy function to match the expected signature and implementation
-- The function should take up (upvotes) and down (downvotes) as parameters
-- and return a normalized controversy index between 0 and 1

DROP FUNCTION IF EXISTS public.f_controversy(integer, integer);

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

COMMENT ON FUNCTION public.f_controversy(integer, integer) IS 'Normalized controversy index in [0,1], peaks at balanced votes';
