-- Install the pg_trgm extension used by planned ForumPost / gacha card
-- similarity search features.
--
-- Idempotent: safe to run repeatedly.
--
-- Usage:
--   PGPASSWORD=... psql -h localhost -p 5434 -U user_dxzbdi -d scpper-cn \
--     -f scripts/ops/enable-pg-trgm.sql
--
-- ON_ERROR_STOP makes psql exit non-zero on the first SQL error (permission
-- denied, missing postgresql-contrib package, etc.). Without it psql returns
-- 0 even when CREATE EXTENSION fails, which silently leaves pg_trgm
-- uninstalled while downstream steps assume success.
\set ON_ERROR_STOP on

\echo 'Ensuring pg_trgm is installed on current database ...'
CREATE EXTENSION IF NOT EXISTS pg_trgm;
SELECT extname, extversion FROM pg_extension WHERE extname = 'pg_trgm';
