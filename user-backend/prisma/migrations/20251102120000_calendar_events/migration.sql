-- Create CalendarEvent table and related objects (idempotent)
CREATE TABLE IF NOT EXISTS "CalendarEvent" (
  id           TEXT        PRIMARY KEY,
  title        TEXT        NOT NULL,
  summary      TEXT,
  color        TEXT,
  "startsAt"   TIMESTAMPTZ NOT NULL,
  "endsAt"     TIMESTAMPTZ NOT NULL,
  "detailsMd"  TEXT,
  "isPublished" BOOLEAN    NOT NULL DEFAULT TRUE,
  "createdById" TEXT REFERENCES "UserAccount"(id) ON UPDATE CASCADE ON DELETE SET NULL,
  "createdAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updatedAt"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "CalendarEvent_pub_time_idx" ON "CalendarEvent" ("isPublished", "startsAt", "endsAt");
CREATE INDEX IF NOT EXISTS "CalendarEvent_time_idx" ON "CalendarEvent" ("startsAt", "endsAt");

-- Recreate trigger function and trigger idempotently
DROP TRIGGER IF EXISTS calendar_event_set_updated_at ON "CalendarEvent";
DROP FUNCTION IF EXISTS calendar_event_set_updated_at();

CREATE OR REPLACE FUNCTION calendar_event_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW."updatedAt" = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER calendar_event_set_updated_at
BEFORE UPDATE ON "CalendarEvent"
FOR EACH ROW EXECUTE FUNCTION calendar_event_set_updated_at();
