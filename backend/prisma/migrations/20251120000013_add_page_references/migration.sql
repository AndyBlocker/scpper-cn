CREATE TABLE "PageReference" (
  "id" SERIAL PRIMARY KEY,
  "pageVersionId" INTEGER NOT NULL,
  "linkType" TEXT NOT NULL,
  "targetPath" TEXT NOT NULL,
  "targetFragment" TEXT,
  "displayTexts" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "rawTarget" TEXT,
  "rawText" TEXT,
  "occurrence" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "PageReference"
  ADD CONSTRAINT "PageReference_pageVersionId_fkey"
  FOREIGN KEY ("pageVersionId")
  REFERENCES "PageVersion"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

CREATE INDEX "PageReference_pageVersionId_idx"
  ON "PageReference"("pageVersionId");

CREATE INDEX "PageReference_targetPath_idx"
  ON "PageReference"("targetPath");

CREATE UNIQUE INDEX "PageReference_unique_path"
  ON "PageReference"("pageVersionId", "linkType", "targetPath", "targetFragment");
