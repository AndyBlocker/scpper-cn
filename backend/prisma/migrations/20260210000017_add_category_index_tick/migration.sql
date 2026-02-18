CREATE TABLE IF NOT EXISTS "CategoryIndexTick" (
  "id" SERIAL PRIMARY KEY,
  "category" TEXT NOT NULL,
  "as_of_ts" TIMESTAMP(3) NOT NULL,
  "watermark_ts" TIMESTAMP(3),
  "vote_cutoff_date" DATE NOT NULL,
  "vote_rule_version" TEXT NOT NULL DEFAULT 'utc8-t+1-v1',
  "score_signal_raw" DECIMAL(20, 8) NOT NULL DEFAULT 0,
  "score_ref" DECIMAL(20, 8) NOT NULL DEFAULT 0,
  "score_provisional" DECIMAL(20, 8) NOT NULL DEFAULT 0,
  "index_mark" DECIMAL(20, 8) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_category_index_tick_category_as_of_ts"
  ON "CategoryIndexTick" ("category", "as_of_ts");

CREATE INDEX IF NOT EXISTS "idx_category_index_tick_category_as_of_ts"
  ON "CategoryIndexTick" ("category", "as_of_ts");

CREATE INDEX IF NOT EXISTS "idx_category_index_tick_watermark_ts"
  ON "CategoryIndexTick" ("watermark_ts");
