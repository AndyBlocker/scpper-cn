-- Add cover image offset columns for collection hero positioning
ALTER TABLE "UserCollection"
  ADD COLUMN IF NOT EXISTS "coverImageOffsetX" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "coverImageOffsetY" DOUBLE PRECISION NOT NULL DEFAULT 0;
