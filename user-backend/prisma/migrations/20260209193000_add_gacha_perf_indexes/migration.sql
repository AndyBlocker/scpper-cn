CREATE INDEX IF NOT EXISTS "idx_gacha_ledger_user_reason_created_at"
  ON "GachaLedgerEntry" ("userId", "reason", "createdAt");

CREATE INDEX IF NOT EXISTS "idx_gacha_ledger_reason_created_at"
  ON "GachaLedgerEntry" ("reason", "createdAt");

CREATE INDEX IF NOT EXISTS "idx_gacha_trade_status_expires_at"
  ON "GachaTradeListing" ("status", "expiresAt");
