DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_enum e ON t.oid = e.enumtypid
    WHERE t.typname = 'PageMetricType' AND e.enumlabel = 'VOTE_COUNT'
  ) THEN
    ALTER TYPE "PageMetricType" ADD VALUE 'VOTE_COUNT';
  END IF;
END $$;

ALTER TABLE "PageMetricWatch"
  ADD COLUMN IF NOT EXISTS "config" JSONB;

CREATE TABLE IF NOT EXISTS "UserMetricPreference" (
  "id" SERIAL PRIMARY KEY,
  "userId" INTEGER NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "metric" "PageMetricType" NOT NULL,
  "config" JSONB,
  "createdAt" TIMESTAMP DEFAULT NOW() NOT NULL,
  "updatedAt" TIMESTAMP DEFAULT NOW() NOT NULL,
  CONSTRAINT "uniq_user_metric_preference" UNIQUE ("userId", "metric")
);

CREATE OR REPLACE FUNCTION update_user_metric_pref_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_metric_pref_set_updated_at ON "UserMetricPreference";
CREATE TRIGGER user_metric_pref_set_updated_at
BEFORE UPDATE ON "UserMetricPreference"
FOR EACH ROW EXECUTE FUNCTION update_user_metric_pref_updated_at();
