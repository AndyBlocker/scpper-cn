-- Non-destructive migration: create SiteOverviewDaily table
CREATE TABLE IF NOT EXISTS "SiteOverviewDaily" (
  id SERIAL PRIMARY KEY,
  date DATE UNIQUE NOT NULL,
  "usersTotal" INTEGER NOT NULL DEFAULT 0,
  "usersActive" INTEGER NOT NULL DEFAULT 0,
  "usersContributors" INTEGER NOT NULL DEFAULT 0,
  "usersAuthors" INTEGER NOT NULL DEFAULT 0,
  "pagesTotal" INTEGER NOT NULL DEFAULT 0,
  "pagesOriginals" INTEGER NOT NULL DEFAULT 0,
  "pagesTranslations" INTEGER NOT NULL DEFAULT 0,
  "votesUp" INTEGER NOT NULL DEFAULT 0,
  "votesDown" INTEGER NOT NULL DEFAULT 0,
  "revisionsTotal" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_siteoverviewdaily_date" ON "SiteOverviewDaily"(date);

-- Trigger to maintain updatedAt
CREATE OR REPLACE FUNCTION set_updated_at_siteoverviewdaily()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_siteoverviewdaily_set_updated_at'
  ) THEN
    CREATE TRIGGER trg_siteoverviewdaily_set_updated_at
    BEFORE UPDATE ON "SiteOverviewDaily"
    FOR EACH ROW EXECUTE FUNCTION set_updated_at_siteoverviewdaily();
  END IF;
END $$;



