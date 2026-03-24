-- cleanup_schema: remove redundant indexes, drop DirtyPageBackup, add missing foreign keys

-- 1. Remove redundant indexes (unique constraints already create indexes)
DROP INDEX IF EXISTS "SiteStats_date_idx";
DROP INDEX IF EXISTS "idx_siteoverviewdaily_date";
DROP INDEX IF EXISTS "idx_category_index_tick_category_as_of_ts";
DROP INDEX IF EXISTS "LeaderboardCache_key_period_idx";
DROP INDEX IF EXISTS "SeriesStats_seriesNumber_idx";

-- 2. Drop deprecated DirtyPageBackup table
DROP TABLE IF EXISTS "DirtyPageBackup";

-- 3. Add foreign keys for UserTagPreference and UserVoteInteraction
-- Clean up orphan records first (userId not in User table)
DELETE FROM "UserTagPreference"
WHERE "userId" NOT IN (SELECT id FROM "User");

DELETE FROM "UserVoteInteraction"
WHERE "fromUserId" NOT IN (SELECT id FROM "User")
   OR "toUserId" NOT IN (SELECT id FROM "User");

-- Add foreign key: UserTagPreference.userId -> User.id
ALTER TABLE "UserTagPreference"
  ADD CONSTRAINT "UserTagPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Add foreign key: UserVoteInteraction.fromUserId -> User.id
ALTER TABLE "UserVoteInteraction"
  ADD CONSTRAINT "UserVoteInteraction_fromUserId_fkey"
  FOREIGN KEY ("fromUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Add foreign key: UserVoteInteraction.toUserId -> User.id
ALTER TABLE "UserVoteInteraction"
  ADD CONSTRAINT "UserVoteInteraction_toUserId_fkey"
  FOREIGN KEY ("toUserId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
