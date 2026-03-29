-- CreateIndex (CONCURRENTLY to avoid locking production tables)
-- These indexes optimize the /users/by-wikidot-id route which queries
-- last/first activity across Vote, Revision, and ForumPost tables.

-- Vote: enable fast lookup by userId + timestamp for last/first vote
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_vote_user_ts"
  ON "Vote" ("userId", "timestamp");

-- Revision: enable fast lookup by userId + timestamp for last/first revision
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_revision_user_ts"
  ON "Revision" ("userId", "timestamp");

-- ForumPost: composite index matching the exact WHERE clause shape:
--   createdByWikidotId = ? AND createdByType = 'user' AND isDeleted = false
--   ORDER BY createdAt DESC/ASC
-- Equality columns first, sort column last.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_forum_post_user_type_deleted_created"
  ON "ForumPost" ("createdByWikidotId", "createdByType", "isDeleted", "createdAt");
