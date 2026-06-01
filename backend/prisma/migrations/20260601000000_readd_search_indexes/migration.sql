-- 重建被后续迁移删除的搜索索引，修复全表扫描导致的搜索慢：
--   #103 PageVersion.title / alternateTitle 的 &@~ 无列级 pgroonga 索引 → 全表扫约 5 万当前版本
--   #104 User 搜索三路（displayName / username / 下划线拆词）无 pgroonga 索引 → 全表扫约 3.7 万用户
--   #105 ForumPost / ForumThread 的 ILIKE '%kw%' 无 trgm 索引 → 全表扫约 53 万帖（稀有词/计数约 1.7s）
--
-- 全部使用 CREATE INDEX CONCURRENTLY（沿用 20250827000006 / 20251125000016 已上线的非事务迁移模式），
-- 可重复执行（IF NOT EXISTS）。部分索引谓词均与对应查询的 WHERE 条件匹配，确保规划器可命中。
-- 失败恢复：若 CONCURRENTLY 中断留下 invalid index，先 DROP INDEX CONCURRENTLY <name> 再重跑。
--
-- 命名说明：User 显示名索引改用 *_registered_pgroonga 新名，避免与历史迁移 20250827000006 中
-- 已创建过的同名全量索引 idx_user_displayname_pgroonga 在全量重放环境下被 IF NOT EXISTS 静默跳过。

-- #103 页面标题 / 副标题（当前有效版本的部分索引，匹配 search.ts title_hits/alternate_hits 的 validTo IS NULL 过滤）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pv_title_current_pgroonga
ON "PageVersion" USING pgroonga (title)
WHERE "validTo" IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_pv_alttitle_current_pgroonga
ON "PageVersion" USING pgroonga ("alternateTitle")
WHERE "validTo" IS NULL AND "alternateTitle" IS NOT NULL;

-- #104 用户搜索三路（部分索引限注册用户，匹配 /search/users 与 /search/all 的 wikidotId IS NOT NULL 过滤）
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_displayname_registered_pgroonga
ON "User" USING pgroonga ("displayName")
WHERE "wikidotId" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_username_registered_pgroonga
ON "User" USING pgroonga (username)
WHERE "wikidotId" IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_user_username_spaced_registered_pgroonga
ON "User" USING pgroonga (replace(username, '_', ' '))
WHERE "wikidotId" IS NOT NULL;

-- #105 论坛搜索止血：trgm GIN 支撑现有 ILIKE '%kw%'（覆盖 textHtml / post.title / thread.title 三个 OR 分支）。
-- 部分索引限 isDeleted = false，匹配 /forums 与 /search/forums 的 p.isDeleted=false AND t.isDeleted=false 过滤。
-- 注：textHtml 含 HTML 标签，索引偏肥且有标签噪声；这是不改代码的止血，纯文本正解留待 search_text 列方案。
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_forumpost_texthtml_live_trgm
ON "ForumPost" USING gin ("textHtml" gin_trgm_ops)
WHERE "isDeleted" = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_forumpost_title_live_trgm
ON "ForumPost" USING gin (title gin_trgm_ops)
WHERE "isDeleted" = false;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_forumthread_title_live_trgm
ON "ForumThread" USING gin (title gin_trgm_ops)
WHERE "isDeleted" = false;
