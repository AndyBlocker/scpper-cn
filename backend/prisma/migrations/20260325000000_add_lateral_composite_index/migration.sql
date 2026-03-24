-- 优化 LATERAL 子查询性能：7 个路由文件中 38 处使用
-- WHERE pv."pageId" = X AND pv."isDeleted" = false ORDER BY pv."validTo" DESC NULLS LAST, pv.id DESC
-- 当前只有 pageId 单列索引，需要复合索引以避免 filter + sort 的额外开销

CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_pv_pageid_isdeleted_validto"
ON "PageVersion" ("pageId", "isDeleted", "validTo" DESC NULLS LAST, id DESC);
