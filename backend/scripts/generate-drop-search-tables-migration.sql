-- Drop SearchIndex and UserSearchIndex tables
-- These tables are no longer needed as we're using PGroonga directly on PageVersion and User tables

-- Drop foreign key constraints first
ALTER TABLE "SearchIndex" DROP CONSTRAINT IF EXISTS "SearchIndex_pageId_fkey";
ALTER TABLE "UserSearchIndex" DROP CONSTRAINT IF EXISTS "UserSearchIndex_userId_fkey";

-- Drop the tables
DROP TABLE IF EXISTS "SearchIndex" CASCADE;
DROP TABLE IF EXISTS "UserSearchIndex" CASCADE;

-- Verify the tables are dropped
SELECT table_name 
FROM information_schema.tables 
WHERE table_schema = 'public' 
  AND table_name IN ('SearchIndex', 'UserSearchIndex');