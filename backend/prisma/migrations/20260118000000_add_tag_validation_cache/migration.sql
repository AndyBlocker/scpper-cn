-- CreateTable (already exists in production, this migration is recorded for schema consistency)
CREATE TABLE IF NOT EXISTS "TagValidationCache" (
    "id" SERIAL NOT NULL,
    "tag" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "samplePages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "validationType" TEXT NOT NULL DEFAULT 'invalid',
    "computedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "latestPageDate" TIMESTAMPTZ,

    CONSTRAINT "TagValidationCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TagValidationCache_tag_validationType_key" ON "TagValidationCache"("tag", "validationType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_tag_validation_type" ON "TagValidationCache"("validationType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_tag_validation_computed" ON "TagValidationCache"("computedAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "idx_tag_validation_latest" ON "TagValidationCache"("latestPageDate" DESC NULLS LAST);
