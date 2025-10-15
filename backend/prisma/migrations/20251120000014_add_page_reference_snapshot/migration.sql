CREATE TABLE "PageReferenceGraphSnapshot" (
  "id" SERIAL PRIMARY KEY,
  "label" TEXT NOT NULL UNIQUE,
  "description" TEXT,
  "generatedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stats" JSONB NOT NULL
);
