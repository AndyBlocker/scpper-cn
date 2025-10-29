ALTER TABLE "UserCollection"
  ADD COLUMN IF NOT EXISTS "coverImageScale" DOUBLE PRECISION NOT NULL DEFAULT 1;

UPDATE "UserCollection"
  SET "coverImageScale" = COALESCE("coverImageScale", 1);
