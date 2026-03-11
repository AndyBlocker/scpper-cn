-- Business rule CHECK constraints for gacha system data integrity.
-- These guard against application-level bugs causing invalid data states.
-- All constraints are safe for existing data (values already enforced by application logic).

-- Wallet balance must never go negative (tokens cannot be overdrawn).
ALTER TABLE "GachaWallet" ADD CONSTRAINT "GachaWallet_balance_nonneg" CHECK ("balance" >= 0);

-- Pity counters must be non-negative (reset to 0 on pity break).
ALTER TABLE "GachaWallet" ADD CONSTRAINT "GachaWallet_pity_nonneg"
  CHECK ("purplePityCount" >= 0 AND "goldPityCount" >= 0);

-- Trade listing prices must be positive.
ALTER TABLE "GachaTradeListing" ADD CONSTRAINT "GachaTradeListing_price_positive"
  CHECK ("unitPrice" > 0 AND "totalPrice" > 0);

-- Trade listing quantity and remaining must be non-negative.
ALTER TABLE "GachaTradeListing" ADD CONSTRAINT "GachaTradeListing_quantity_nonneg"
  CHECK ("quantity" >= 0 AND "remaining" >= 0);

-- Placement slot count must be within the valid range (5 default, 10 max).
ALTER TABLE "GachaPlacementState" ADD CONSTRAINT "GachaPlacementState_slots_range"
  CHECK ("unlockedSlotCount" >= 1 AND "unlockedSlotCount" <= 10);

-- Pending placement tokens must be non-negative.
ALTER TABLE "GachaPlacementState" ADD CONSTRAINT "GachaPlacementState_pending_nonneg"
  CHECK ("pendingToken" >= 0);
