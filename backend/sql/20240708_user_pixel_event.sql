-- Tracks pixel hits that include authenticated usernames for correlation with page URL events.
CREATE TABLE IF NOT EXISTS "UserPixelEvent" (
  id serial PRIMARY KEY,
  "userId" integer NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "wikidotId" integer,
  username text NOT NULL,
  "clientHash" text NOT NULL,
  "clientIp" text,
  "userAgent" text,
  "component" text,
  "source" text,
  "refererHost" text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "UserPixelEvent_userId_createdAt_idx"
  ON "UserPixelEvent" ("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "UserPixelEvent_user_client_hash_idx"
  ON "UserPixelEvent" ("userId", "clientHash", "createdAt");

CREATE INDEX IF NOT EXISTS "UserPixelEvent_user_client_ip_idx"
  ON "UserPixelEvent" ("userId", "clientIp", "userAgent", "createdAt");
