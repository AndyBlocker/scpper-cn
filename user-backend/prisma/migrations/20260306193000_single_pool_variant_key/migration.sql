ALTER TABLE "GachaCardDefinition"
ADD COLUMN IF NOT EXISTS "variantKey" TEXT;

CREATE INDEX IF NOT EXISTS "GachaCardDefinition_poolId_pageId_variantKey_idx"
ON "GachaCardDefinition" ("poolId", "pageId", "variantKey");
