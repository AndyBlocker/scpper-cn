DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'GachaAffixVisualStyle'
      AND e.enumlabel = 'WILDCARD'
  ) THEN
    ALTER TYPE "GachaAffixVisualStyle" ADD VALUE 'WILDCARD';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'GachaAffixVisualStyle'
      AND e.enumlabel = 'SPECTRUM'
  ) THEN
    ALTER TYPE "GachaAffixVisualStyle" ADD VALUE 'SPECTRUM';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'GachaAffixVisualStyle'
      AND e.enumlabel = 'MIRROR'
  ) THEN
    ALTER TYPE "GachaAffixVisualStyle" ADD VALUE 'MIRROR';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'GachaAffixVisualStyle'
      AND e.enumlabel = 'ORBIT'
  ) THEN
    ALTER TYPE "GachaAffixVisualStyle" ADD VALUE 'ORBIT';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'GachaAffixVisualStyle'
      AND e.enumlabel = 'ECHO'
  ) THEN
    ALTER TYPE "GachaAffixVisualStyle" ADD VALUE 'ECHO';
  END IF;
END $$;

ALTER TABLE "GachaPlacementState"
  ADD COLUMN IF NOT EXISTS "unlockedSlotCount" INTEGER NOT NULL DEFAULT 5;

ALTER TABLE "GachaPlacementSlot"
  ADD COLUMN IF NOT EXISTS "affixSignature" TEXT;

CREATE INDEX IF NOT EXISTS "idx_gacha_placement_slot_user_affix_signature"
  ON "GachaPlacementSlot" ("userId", "affixSignature");
