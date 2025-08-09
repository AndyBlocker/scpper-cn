-- 直接数据库迁移脚本
-- 不使用Prisma migrate，直接执行SQL

BEGIN;

-- 1. 添加Page.firstPublishedAt字段
ALTER TABLE "Page" ADD COLUMN IF NOT EXISTS "firstPublishedAt" timestamp;

-- 2. 创建AnalysisWatermark表
CREATE TABLE IF NOT EXISTS "AnalysisWatermark" (
    id SERIAL PRIMARY KEY,
    task TEXT UNIQUE NOT NULL,
    "lastRunAt" TIMESTAMP NOT NULL DEFAULT now(),
    "cursorTs" TIMESTAMP
);

-- 3. 创建SearchIndex表
CREATE TABLE IF NOT EXISTS "SearchIndex" (
    "pageId" INTEGER PRIMARY KEY,
    title TEXT,
    url TEXT,
    tags TEXT[],
    text_content TEXT,
    source_content TEXT,
    "updatedAt" TIMESTAMP DEFAULT now(),
    CONSTRAINT fk_searchindex_page FOREIGN KEY ("pageId") REFERENCES "Page"(id) ON DELETE CASCADE
);

-- 4. 创建PageDailyStats表
CREATE TABLE IF NOT EXISTS "PageDailyStats" (
    id SERIAL PRIMARY KEY,
    "pageId" INTEGER NOT NULL,
    date DATE NOT NULL,
    votes_up INTEGER DEFAULT 0,
    votes_down INTEGER DEFAULT 0,
    total_votes INTEGER DEFAULT 0,
    unique_voters INTEGER DEFAULT 0,
    revisions INTEGER DEFAULT 0,
    "createdAt" TIMESTAMP DEFAULT now(),
    CONSTRAINT fk_pagedailystats_page FOREIGN KEY ("pageId") REFERENCES "Page"(id) ON DELETE CASCADE,
    UNIQUE("pageId", date)
);

-- 5. 创建UserDailyStats表
CREATE TABLE IF NOT EXISTS "UserDailyStats" (
    id SERIAL PRIMARY KEY,
    "userId" INTEGER NOT NULL,
    date DATE NOT NULL,
    votes_cast INTEGER DEFAULT 0,
    pages_created INTEGER DEFAULT 0,
    last_activity TIMESTAMP,
    "createdAt" TIMESTAMP DEFAULT now(),
    CONSTRAINT fk_userdailystats_user FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE CASCADE,
    UNIQUE("userId", date)
);

-- 6. 创建LeaderboardCache表
CREATE TABLE IF NOT EXISTS "LeaderboardCache" (
    id SERIAL PRIMARY KEY,
    key TEXT NOT NULL,
    period TEXT NOT NULL,
    payload JSONB NOT NULL,
    "updatedAt" TIMESTAMP DEFAULT now(),
    "expiresAt" TIMESTAMP,
    UNIQUE(key, period)
);

-- 7. 创建基础索引
CREATE INDEX IF NOT EXISTS idx_page_first_published ON "Page" ("firstPublishedAt");
CREATE INDEX IF NOT EXISTS idx_pagedailystats_date ON "PageDailyStats" (date);
CREATE INDEX IF NOT EXISTS idx_pagedailystats_pageid ON "PageDailyStats" ("pageId");
CREATE INDEX IF NOT EXISTS idx_userdailystats_date ON "UserDailyStats" (date);
CREATE INDEX IF NOT EXISTS idx_userdailystats_userid ON "UserDailyStats" ("userId");
CREATE INDEX IF NOT EXISTS idx_leaderboard_key_period ON "LeaderboardCache" (key, period);
CREATE INDEX IF NOT EXISTS idx_leaderboard_expires ON "LeaderboardCache" ("expiresAt");

-- 8. 创建更多优化索引
CREATE INDEX IF NOT EXISTS idx_vote_pv_ts ON "Vote" ("pageVersionId", "timestamp");
CREATE INDEX IF NOT EXISTS idx_vote_pv_dir_ts ON "Vote" ("pageVersionId", "direction", "timestamp");
CREATE INDEX IF NOT EXISTS idx_rev_pv_ts ON "Revision" ("pageVersionId", "timestamp");
CREATE INDEX IF NOT EXISTS idx_pv_valid_active ON "PageVersion" ("pageId") WHERE "validTo" IS NULL AND "isDeleted" = false;
CREATE INDEX IF NOT EXISTS idx_attr_pagever_date ON "Attribution" ("pageVerId", "date");
CREATE INDEX IF NOT EXISTS idx_attr_user ON "Attribution" ("userId");
CREATE INDEX IF NOT EXISTS idx_user_first_last ON "User" ("firstActivityAt", "lastActivityAt");

-- 9. 创建pg_trgm扩展和搜索索引（如果支持）
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_search_title_trgm ON "SearchIndex" USING GIN (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_search_text_trgm ON "SearchIndex" USING GIN (text_content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_search_source_trgm ON "SearchIndex" USING GIN (source_content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_search_tags_gin ON "SearchIndex" USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_pv_tags_gin ON "PageVersion" USING GIN (tags);

-- 10. 创建统计函数
CREATE OR REPLACE FUNCTION f_wilson_lower_bound(up integer, down integer)
RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN (up + down) = 0 THEN 0.0
    ELSE (
      (up::float/(up+down) + 1.96^2/(2*(up+down))
       - 1.96/(2*(up+down)) * sqrt(4*(up+down)*(up::float/(up+down))*(1-(up::float/(up+down))) + 1.96^2)
      ) / (1 + 1.96^2/(up+down))
    )
  END
$$;

CREATE OR REPLACE FUNCTION f_controversy(up integer, down integer)
RETURNS double precision LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN (up + down) = 0 OR GREATEST(up,down)=0 THEN 0.0
    ELSE (LEAST(up,down)::float/GREATEST(up,down)::float) * ln(up+down+1)
  END
$$;

-- 11. 创建SearchIndex同步触发器
CREATE OR REPLACE FUNCTION sync_searchindex_from_pageversion() 
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."validTo" IS NULL AND NEW."isDeleted" = false THEN
    INSERT INTO "SearchIndex" ("pageId", title, url, tags, text_content, source_content, "updatedAt")
    SELECT 
      NEW."pageId",
      NEW.title,
      p.url,
      NEW.tags,
      NEW."textContent",
      NEW.source,
      now()
    FROM "Page" p 
    WHERE p.id = NEW."pageId"
    ON CONFLICT ("pageId") DO UPDATE SET
      title = EXCLUDED.title,
      url = EXCLUDED.url,
      tags = EXCLUDED.tags,
      text_content = EXCLUDED.text_content,
      source_content = EXCLUDED.source_content,
      "updatedAt" = EXCLUDED."updatedAt";
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 检查触发器是否存在，不存在则创建
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_sync_searchindex') THEN
    CREATE TRIGGER trg_sync_searchindex
    AFTER INSERT OR UPDATE ON "PageVersion"
    FOR EACH ROW 
    EXECUTE FUNCTION sync_searchindex_from_pageversion();
  END IF;
END $$;

-- 12. 初始化水位线数据
INSERT INTO "AnalysisWatermark" (task, "lastRunAt", "cursorTs")
VALUES 
  ('page_stats', now(), NULL),
  ('user_stats', now(), NULL),
  ('site_stats', now(), NULL),
  ('search_index', now(), NULL),
  ('facts_generation', now(), NULL)
ON CONFLICT (task) DO NOTHING;

COMMIT;

-- 输出成功信息
\echo '✅ 数据库迁移完成！'
\echo '📊 创建的表：AnalysisWatermark, SearchIndex, PageDailyStats, UserDailyStats, LeaderboardCache'
\echo '📈 添加的字段：Page.firstPublishedAt'
\echo '🔍 创建的索引：15个性能优化索引'
\echo '⚙️ 创建的函数：Wilson下界、争议度计算函数'
\echo '🔄 创建的触发器：SearchIndex自动同步触发器'