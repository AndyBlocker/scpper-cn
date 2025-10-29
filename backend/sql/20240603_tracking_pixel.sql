-- Adds page view tracking support without data loss.
ALTER TABLE "PageDailyStats"
  ADD COLUMN IF NOT EXISTS "views" integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "PageViewEvent" (
  id serial PRIMARY KEY,
  "pageId" integer NOT NULL REFERENCES "Page"(id) ON DELETE CASCADE,
  "wikidotId" integer NOT NULL,
  "clientHash" text NOT NULL,
  "clientIp" text,
  "userAgent" text,
  "component" text,
  "source" text,
  "refererHost" text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE "PageViewEvent"
  ADD COLUMN IF NOT EXISTS "clientIp" text,
  ADD COLUMN IF NOT EXISTS "userAgent" text,
  ADD COLUMN IF NOT EXISTS "clientHash" text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS "PageViewEvent_pageId_createdAt_idx"
  ON "PageViewEvent" ("pageId", "createdAt");

CREATE INDEX IF NOT EXISTS "PageViewEvent_page_client_hash_idx"
  ON "PageViewEvent" ("pageId", "clientHash", "createdAt");

CREATE INDEX IF NOT EXISTS "PageViewEvent_page_client_ip_idx"
  ON "PageViewEvent" ("pageId", "clientIp", "userAgent", "createdAt");

CREATE INDEX IF NOT EXISTS "PageViewEvent_wikidotId_createdAt_idx"
  ON "PageViewEvent" ("wikidotId", "createdAt");
