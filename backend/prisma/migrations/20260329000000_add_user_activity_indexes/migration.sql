-- MANUAL MIGRATION: This file uses CREATE INDEX CONCURRENTLY which cannot
-- run inside a transaction. Do NOT run via `prisma migrate deploy`.
--
-- Deployment steps:
--   1. psql $DATABASE_URL < this_file.sql
--   2. npx prisma migrate resolve --applied 20260329000000_add_user_activity_indexes
--
-- If a previous CONCURRENTLY attempt failed, PostgreSQL may leave an INVALID
-- index behind. The DROP statements below clean those up before recreating.

-- Vote: enable fast lookup by userId + timestamp for last/first vote
DROP INDEX CONCURRENTLY IF EXISTS "idx_vote_user_ts";
CREATE INDEX CONCURRENTLY "idx_vote_user_ts"
  ON "Vote" ("userId", "timestamp");

-- Revision: enable fast lookup by userId + timestamp for last/first revision
DROP INDEX CONCURRENTLY IF EXISTS "idx_revision_user_ts";
CREATE INDEX CONCURRENTLY "idx_revision_user_ts"
  ON "Revision" ("userId", "timestamp");

-- ForumPost: composite index matching the exact WHERE clause shape:
--   createdByWikidotId = ? AND createdByType = 'user' AND isDeleted = false
--   ORDER BY createdAt DESC/ASC
-- Equality columns first, sort column last.
DROP INDEX CONCURRENTLY IF EXISTS "idx_forum_post_user_type_deleted_created";
CREATE INDEX CONCURRENTLY "idx_forum_post_user_type_deleted_created"
  ON "ForumPost" ("createdByWikidotId", "createdByType", "isDeleted", "createdAt");
