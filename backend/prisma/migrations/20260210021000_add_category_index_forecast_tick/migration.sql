CREATE TABLE IF NOT EXISTS "CategoryIndexForecastTick" (
  "id" SERIAL PRIMARY KEY,
  "category" TEXT NOT NULL,
  "as_of_ts" TIMESTAMP(3) NOT NULL,
  "settle_day" DATE NOT NULL,
  "hour_offset" INTEGER NOT NULL,
  "forecast_score" DECIMAL(20, 8) NOT NULL,
  "forecast_index" DECIMAL(20, 8) NOT NULL,
  "day_close_score" DECIMAL(20, 8) NOT NULL,
  "day_close_index" DECIMAL(20, 8) NOT NULL,
  "prev_day_close_index" DECIMAL(20, 8) NOT NULL,
  "is_stale" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_category_index_fcst_category_as_of_ts"
  ON "CategoryIndexForecastTick" ("category", "as_of_ts");

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_category_index_fcst_day_hour"
  ON "CategoryIndexForecastTick" ("category", "settle_day", "hour_offset");

CREATE INDEX IF NOT EXISTS "idx_category_index_fcst_category_settle_day"
  ON "CategoryIndexForecastTick" ("category", "settle_day");
