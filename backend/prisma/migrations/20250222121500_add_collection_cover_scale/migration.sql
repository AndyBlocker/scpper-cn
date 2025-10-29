-- Add cover image scale column for adjustable zoom
ALTER TABLE "UserCollection"
  ADD COLUMN IF NOT EXISTS "coverImageScale" DOUBLE PRECISION NOT NULL DEFAULT 1;
