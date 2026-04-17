-- Missing partial / composite indexes for the backend (syncer / analyzer)
-- database. Target cluster: 17/main port 5434, database scpper-cn.
-- (Note: both services point at the same database; the split is logical.)
--
-- Each CREATE INDEX uses CONCURRENTLY. Invoke this file with:
--
--   PGPASSWORD=... psql -h 127.0.0.1 -p 5434 -U user_dxzbdi -d scpper-cn \
--     -v ON_ERROR_STOP=0 -f scripts/ops/indexes-2026-04-17-backend.sql
--
-- If any statement aborts, clean up with:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
--   DROP INDEX CONCURRENTLY <name>;

\echo '=== Page: active (non-deleted) pages by publish date ==='
-- Partial index shrinks the B-tree dramatically because deleted pages are a
-- meaningful fraction of the table. Query: public page lists filter out
-- deleted pages in virtually every request.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_page_active
  ON "Page" ("firstPublishedAt" DESC)
  WHERE "isDeleted" = false;

\echo '=== Vote: direction over time (global trends, upvote vs downvote) ==='
-- Query: site-wide vote velocity / heat metrics -> GROUP BY direction ORDER BY ts
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_vote_direction_timestamp
  ON "Vote" (direction, timestamp DESC);

\echo '=== RatingRecords: leaderboard top-N by record type ==='
-- Query: SELECT ... WHERE recordType = 'WEEKLY_TOP' ORDER BY rating DESC LIMIT N
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rating_record_type_rating
  ON "RatingRecords" ("recordType", rating DESC NULLS LAST);

\echo '=== PageMetricAlert: unread / open alerts by detection time ==='
-- Query: dashboard -> WHERE acknowledgedAt IS NULL ORDER BY detectedAt DESC
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_metric_alert_unread
  ON "PageMetricAlert" ("detectedAt" DESC)
  WHERE "acknowledgedAt" IS NULL;

\echo 'Validation:'
SELECT
  c.relname AS index_name,
  t.relname AS table_name,
  i.indisvalid AS is_valid
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
WHERE c.relname IN (
  'idx_page_active',
  'idx_vote_direction_timestamp',
  'idx_rating_record_type_rating',
  'idx_metric_alert_unread'
)
ORDER BY c.relname;
