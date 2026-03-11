-- GachaInventory.count must never go negative.
-- This constraint guards against race conditions in trade/dismantle logic.
ALTER TABLE "GachaInventory" ADD CONSTRAINT "GachaInventory_count_nonneg" CHECK ("count" >= 0);
