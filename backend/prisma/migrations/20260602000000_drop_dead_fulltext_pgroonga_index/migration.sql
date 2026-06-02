-- #108：删除无人查询的"死"全表 pgroonga 全文索引。
-- idx_pageversion_fulltext_pgroonga 索引 (title || ' ' || textContent) 覆盖【全部】PageVersion
-- 版本(非仅当前版本),每次写入都维护,体量巨大。唯一消费者是已删除的死代码 PGroongaSearchService;
-- 活跃搜索改用 #130 的当前版本分区索引(idx_pv_*_current_pgroonga),无任何查询命中该拼接表达式。
-- 用 CONCURRENTLY 避免长锁(故本迁移需手动 psql 应用 + prisma migrate resolve --applied)。
DROP INDEX CONCURRENTLY IF EXISTS idx_pageversion_fulltext_pgroonga;
