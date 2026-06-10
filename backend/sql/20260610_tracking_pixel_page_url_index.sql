-- 追踪像素 by-url 页面查找索引(2026-06-10 审计 P0-5)
--
-- 背景: /api/tracking/pixel/by-url 按 lower("currentUrl") 精确匹配查页,此前无函数索引,
-- 每次像素请求对 Page(~4.75 万行)整表过滤,p50 189ms,占像素端点延迟 97%。
-- 配套代码改动: bff/src/web/routes/tracking.ts 已把 OR+EXISTS(unnest) 单查询拆成
-- 两段短路(先 currentUrl 精确命中走本索引,miss 再退 urlHistory 慢路径)。
--
-- 应用方式(生产,手动): CONCURRENTLY 不能在事务内,勿走 prisma migrate deploy。
--   psql "$DATABASE_URL" -f backend/sql/20260610_tracking_pixel_page_url_index.sql
-- 回滚: DROP INDEX CONCURRENTLY IF EXISTS idx_page_lower_currenturl;
--
-- 注意(Prisma drift): 该索引在迁移体系之外,schema.prisma 不声明函数索引;
-- 做 schema 对账/drift 修复时不要删除它(参见 db pull 后人工核对清单)。

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_page_lower_currenturl
  ON "Page" (lower("currentUrl"));
