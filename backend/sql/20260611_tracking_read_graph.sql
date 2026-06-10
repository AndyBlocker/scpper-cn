-- 追踪读取图谱 + 反作弊检查支撑（2026-06-11）
--
-- 全部 additive：新建表 + 新建索引。不改既有列、不 DROP、不破坏历史。
-- 背景：UserPixelEvent = "登录浏览者 X(wikidotId) 用 clientHash=H 浏览了带组件的页面"，
--   PageViewEvent = "clientHash=H 浏览了页面 Y"(匿名/登录通吃)。两者皆带 clientHash+时间，
--   按 (clientHash, ±窗口) join 即可重建"用户 X 读了页面 Y"的读取图谱(零改组件)。
--
-- 应用(生产,手动；CONCURRENTLY 不能在事务内,勿走 prisma migrate deploy)：
--   psql "$DATABASE_URL" -f backend/sql/20260611_tracking_read_graph.sql
-- 回滚：DROP TABLE "UserPageView"; DROP INDEX CONCURRENTLY 各新索引。

-- 支撑读取图谱 join 的 clientHash 时间索引(现有索引均 pageId/wikidotId 前导,无 clientHash 前导)
CREATE INDEX CONCURRENTLY IF NOT EXISTS "PageViewEvent_clientHash_createdAt_idx"
  ON "PageViewEvent" ("clientHash", "createdAt");

-- 读取图谱：每个(注册用户, 页面)的浏览聚合(去重到对,带首末次与次数)
CREATE TABLE IF NOT EXISTS "UserPageView" (
  id             bigserial PRIMARY KEY,
  "userId"       integer NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "wikidotId"    integer,
  "pageId"       integer NOT NULL REFERENCES "Page"(id) ON DELETE CASCADE,
  "firstViewedAt" timestamptz NOT NULL,
  "lastViewedAt"  timestamptz NOT NULL,
  "viewCount"    integer NOT NULL DEFAULT 1,
  "updatedAt"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "UserPageView_user_page_uniq" UNIQUE ("userId", "pageId")
);
CREATE INDEX IF NOT EXISTS "UserPageView_pageId_idx" ON "UserPageView" ("pageId");
CREATE INDEX IF NOT EXISTS "UserPageView_lastViewedAt_idx" ON "UserPageView" ("lastViewedAt");
