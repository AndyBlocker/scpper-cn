ALTER TABLE "UserCollection"
  ADD COLUMN IF NOT EXISTS "coverImageOffsetX" DOUBLE PRECISION NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "coverImageOffsetY" DOUBLE PRECISION NOT NULL DEFAULT 0;

UPDATE "UserCollection"
  SET
    "coverImageOffsetX" = COALESCE("coverImageOffsetX", 0),
    "coverImageOffsetY" = COALESCE("coverImageOffsetY", 0);
