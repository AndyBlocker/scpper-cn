DO $$
BEGIN
  CREATE TYPE "GachaAffixVisualStyle" AS ENUM ('NONE', 'MONO', 'SILVER', 'GOLD', 'CYAN', 'PRISM', 'COLORLESS');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "GachaInventory"
  ADD COLUMN IF NOT EXISTS "affixStacks" JSONB;

ALTER TABLE "GachaPlacementSlot"
  ADD COLUMN IF NOT EXISTS "inventoryId" TEXT,
  ADD COLUMN IF NOT EXISTS "affixVisualStyle" "GachaAffixVisualStyle",
  ADD COLUMN IF NOT EXISTS "affixLabel" TEXT;

ALTER TABLE "GachaTradeListing"
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;

CREATE INDEX IF NOT EXISTS "idx_gacha_placement_slot_inventory_id"
  ON "GachaPlacementSlot" ("inventoryId");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'fk_gacha_placement_slot_inventory_id'
  ) THEN
    ALTER TABLE "GachaPlacementSlot"
      ADD CONSTRAINT "fk_gacha_placement_slot_inventory_id"
      FOREIGN KEY ("inventoryId")
      REFERENCES "GachaInventory"("id")
      ON DELETE SET NULL
      ON UPDATE CASCADE;
  END IF;
END $$;
