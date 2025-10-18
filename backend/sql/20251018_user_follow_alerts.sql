DO $$ BEGIN
  CREATE TYPE "UserActivityType" AS ENUM ('REVISION', 'ATTRIBUTION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "UserFollow" (
  id SERIAL PRIMARY KEY,
  "followerId" INT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "targetUserId" INT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_user_follow_pair"
  ON "UserFollow"("followerId", "targetUserId");

CREATE INDEX IF NOT EXISTS "idx_user_follow_target"
  ON "UserFollow"("targetUserId");

CREATE TABLE IF NOT EXISTS "UserActivityAlert" (
  id SERIAL PRIMARY KEY,
  "followId" INT NOT NULL REFERENCES "UserFollow"(id) ON DELETE CASCADE,
  "followerId" INT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "targetUserId" INT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "pageId" INT NOT NULL REFERENCES "Page"(id) ON DELETE CASCADE,
  type "UserActivityType" NOT NULL,
  "revisionId" INT NULL REFERENCES "Revision"(id) ON DELETE SET NULL,
  "attributionId" INT NULL REFERENCES "Attribution"(id) ON DELETE SET NULL,
  "detectedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "acknowledgedAt" TIMESTAMPTZ NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "idx_user_activity_follow_ack"
  ON "UserActivityAlert"("followId", "acknowledgedAt");

CREATE INDEX IF NOT EXISTS "idx_user_activity_follower_detected"
  ON "UserActivityAlert"("followerId", "detectedAt" DESC);

CREATE INDEX IF NOT EXISTS "idx_user_activity_page_type"
  ON "UserActivityAlert"("pageId", type);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_user_activity_follow_revision"
  ON "UserActivityAlert"("followId", "revisionId")
  WHERE "revisionId" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_user_activity_follow_attribution"
  ON "UserActivityAlert"("followId", "attributionId")
  WHERE "attributionId" IS NOT NULL;

