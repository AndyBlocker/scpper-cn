-- Missing partial / composite indexes for the user-backend database.
-- Target cluster: 17/main port 5434, database scpper-cn
--
-- Each CREATE INDEX uses CONCURRENTLY so production writes are not blocked.
-- CONCURRENTLY cannot run inside a transaction, so invoke this file with:
--
--   PGPASSWORD=... psql -h 127.0.0.1 -p 5434 -U user_dxzbdi -d scpper-cn \
--     -v ON_ERROR_STOP=0 -f scripts/ops/indexes-2026-04-17-user-backend.sql
--
-- If an index creation aborts, it leaves an INVALID index. Detect with:
--   SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
-- Then DROP INDEX CONCURRENTLY <name>; and re-run the matching statement.

\echo '=== GachaTradeListing: only index live open-for-sale listings ==='
-- Query: market browse -> WHERE status='OPEN' AND (expiresAt IS NULL OR expiresAt > NOW()).
-- The actual read path (trade.routes.ts /trade/listings) only constrains
-- `status='OPEN'`; there is NO `remaining > 0` predicate, and no CHECK
-- constraint that lets the planner infer `status='OPEN' => remaining > 0`.
-- A partial index whose predicate is strictly tighter than the query would
-- never be chosen. Index only on `status='OPEN'` and let the row-level
-- `remaining` / `expiresAt` filters apply on the small result set.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gacha_trade_open_live
  ON "GachaTradeListing" ("createdAt" DESC, "cardId")
  WHERE status = 'OPEN';

\echo '=== GachaBuyRequest: only index live requests ==='
-- Query: buy-request board -> WHERE status='OPEN' ORDER BY createdAt DESC
-- Note: cannot include expiresAt > NOW() because NOW() is not IMMUTABLE;
-- the query filter on expiresAt is applied after the index scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gacha_buyreq_open_live
  ON "GachaBuyRequest" ("createdAt" DESC, "targetCardId")
  WHERE status = 'OPEN';

\echo '=== GachaCardInstance: tradeable (unlocked) instances per user ==='
-- Query: "free instances" listing -> WHERE userId=X AND isLocked=false
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gacha_card_instance_unlocked
  ON "GachaCardInstance" ("userId", "cardId")
  WHERE "isLocked" = false;

\echo '=== GachaInventory: active positive-count rows ==='
-- Query: inventory panel -> WHERE userId=X AND count>0 ORDER BY count DESC
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gacha_inventory_active
  ON "GachaInventory" ("userId", count DESC)
  WHERE count > 0;

\echo '=== GachaDraw: per-pool history for a user ==='
-- Query: draw history scoped to a pool -> ORDER BY createdAt DESC
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_gacha_draw_user_pool_created
  ON "GachaDraw" ("userId", "poolId", "createdAt" DESC);

\echo 'Validation (rerun if any index shows indisvalid = false):'
SELECT
  c.relname AS index_name,
  t.relname AS table_name,
  i.indisvalid AS is_valid
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_class t ON t.oid = i.indrelid
WHERE c.relname LIKE 'idx_gacha_%'
ORDER BY c.relname;
