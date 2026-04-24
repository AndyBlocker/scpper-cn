-- Ensure pgvector extension is present. Creating it requires SUPERUSER;
-- if this migration fails here, a DB admin must run
--   CREATE EXTENSION IF NOT EXISTS vector;
-- once and re-deploy. Prisma's `postgresqlExtensions` preview feature will
-- keep the extension declared in schema.prisma, but cannot install it.
CREATE EXTENSION IF NOT EXISTS vector;

-- Main table: one row = one embedding of one PageVersion under one model.
-- `embedding` is halfvec(1024) (FP16) — BGE-M3 dim. Future models can add
-- rows alongside with a different `model` key without disturbing old data.
CREATE TABLE "PageEmbedding" (
  "id" SERIAL PRIMARY KEY,
  "pageVersionId" INTEGER NOT NULL REFERENCES "PageVersion"("id") ON DELETE CASCADE,
  "model" VARCHAR(64) NOT NULL,
  "dim" INTEGER NOT NULL,
  "embedding" halfvec(1024) NOT NULL,
  "sourceCharLen" INTEGER NOT NULL,
  "sourceTruncated" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "PageEmbedding_pageVersionId_model_key"
  ON "PageEmbedding" ("pageVersionId", "model");

CREATE INDEX "PageEmbedding_model_idx"
  ON "PageEmbedding" ("model");

-- HNSW index on the cosine distance for ANN search.
-- `m=16, ef_construction=64` are standard defaults; build time on ~34K vectors
-- is typically under a minute. Query-time `ef_search` can be tuned per-session
-- via `SET hnsw.ef_search = <n>;` (default 40).
CREATE INDEX "PageEmbedding_embedding_hnsw"
  ON "PageEmbedding"
  USING hnsw ("embedding" halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);
