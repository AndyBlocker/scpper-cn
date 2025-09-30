-- Add alternateTitle column to PageVersion for storing remote alternate titles
ALTER TABLE "PageVersion"
ADD COLUMN IF NOT EXISTS "alternateTitle" TEXT;

-- Index alternate titles for PGroonga search
CREATE INDEX IF NOT EXISTS idx_pv_alternate_title_pgroonga
ON "PageVersion" USING pgroonga ("alternateTitle");
