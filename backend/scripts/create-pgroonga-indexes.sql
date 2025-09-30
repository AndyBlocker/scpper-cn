-- 为 PageVersion 表创建 PGroonga 索引
-- 注意：tags 只创建普通索引用于过滤，不用于全文搜索

-- 1. 标题索引（主要搜索字段）
CREATE INDEX IF NOT EXISTS idx_pageversion_title_pgroonga 
ON "PageVersion" 
USING pgroonga (title);

-- 2. 内容索引（主要搜索字段）
CREATE INDEX IF NOT EXISTS idx_pageversion_content_pgroonga 
ON "PageVersion" 
USING pgroonga ("textContent");

-- 3. 组合全文索引（标题 + 内容）- 用于统一搜索
CREATE INDEX IF NOT EXISTS idx_pageversion_fulltext_pgroonga 
ON "PageVersion" 
USING pgroonga ((COALESCE(title, '') || ' ' || COALESCE("textContent", '')));

-- 4. 标签索引（用于过滤，不是全文搜索）
-- 使用 GIN 索引而不是 PGroonga，因为标签是数组类型
CREATE INDEX IF NOT EXISTS idx_pageversion_tags_gin 
ON "PageVersion" 
USING gin (tags);

-- 5. 为当前版本过滤创建索引
CREATE INDEX IF NOT EXISTS idx_pageversion_validto 
ON "PageVersion" ("validTo") 
WHERE "validTo" IS NULL;

-- 为 User 表创建 PGroonga 索引
CREATE INDEX IF NOT EXISTS idx_user_displayname_pgroonga 
ON "User" 
USING pgroonga ("displayName");

-- 为 Page 表 URL 创建 PGroonga 索引
CREATE INDEX IF NOT EXISTS idx_page_current_url_pgroonga 
ON "Page" 
USING pgroonga ("currentUrl");

-- 输出索引创建结果
SELECT 
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('PageVersion', 'User', 'Page')
  AND (
    indexname LIKE '%pgroonga%' 
    OR indexname LIKE '%tags%'
    OR indexname LIKE '%validto%'
  )
ORDER BY tablename, indexname;
