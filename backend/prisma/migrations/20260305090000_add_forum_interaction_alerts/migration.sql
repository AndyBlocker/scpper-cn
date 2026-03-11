DO $$ BEGIN
  CREATE TYPE "ForumInteractionAlertType" AS ENUM ('PAGE_REPLY', 'DIRECT_REPLY', 'MENTION');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "ForumInteractionAlert" (
  "id" SERIAL PRIMARY KEY,
  "recipientUserId" INT NOT NULL REFERENCES "User"("id") ON DELETE CASCADE,
  "actorUserId" INT NULL REFERENCES "User"("id") ON DELETE SET NULL,
  "actorWikidotId" INT NULL,
  "actorName" TEXT NULL,
  "type" "ForumInteractionAlertType" NOT NULL,
  "postId" INT NOT NULL REFERENCES "ForumPost"("id") ON DELETE CASCADE,
  "parentPostId" INT NULL REFERENCES "ForumPost"("id") ON DELETE SET NULL,
  "threadId" INT NOT NULL REFERENCES "ForumThread"("id") ON DELETE CASCADE,
  "pageId" INT NULL REFERENCES "Page"("id") ON DELETE SET NULL,
  "postTitle" TEXT NULL,
  "postExcerpt" TEXT NULL,
  "detectedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "acknowledgedAt" TIMESTAMPTZ NULL,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS "uniq_forum_interaction_alert_recipient_type_post"
  ON "ForumInteractionAlert" ("recipientUserId", "type", "postId");

CREATE INDEX IF NOT EXISTS "idx_forum_interaction_alert_recipient_ack_detected"
  ON "ForumInteractionAlert" ("recipientUserId", "acknowledgedAt", "detectedAt" DESC);

CREATE INDEX IF NOT EXISTS "idx_forum_interaction_alert_thread_detected"
  ON "ForumInteractionAlert" ("threadId", "detectedAt" DESC);

CREATE INDEX IF NOT EXISTS "idx_forum_interaction_alert_page_detected"
  ON "ForumInteractionAlert" ("pageId", "detectedAt" DESC);

CREATE INDEX IF NOT EXISTS "idx_forum_interaction_alert_post"
  ON "ForumInteractionAlert" ("postId");
