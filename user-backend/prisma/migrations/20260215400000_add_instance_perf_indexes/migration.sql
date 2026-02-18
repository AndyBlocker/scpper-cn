-- Performance indexes for GachaCardInstance queries
-- Covers the common "free instances for user" pattern:
--   WHERE userId = $1 AND tradeListingId IS NULL
-- Used by: /inventory, /album/summary, /progress

CREATE INDEX IF NOT EXISTS "GachaCardInstance_userId_tradeListingId_idx"
  ON "GachaCardInstance" ("userId", "tradeListingId");
