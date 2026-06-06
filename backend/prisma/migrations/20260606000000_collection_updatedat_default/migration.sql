-- 恢复 UserCollection / UserCollectionItem 的 updatedAt 数据库级默认值，修复收藏报错：
--   创建收藏夹（POST /collections）与添加条目（POST /collections/:id/items）的裸 SQL INSERT
--   未提供 updatedAt，依赖建表时的 DEFAULT now()。该默认值不在 Prisma schema 中
--   （@updatedAt 不生成 DB 默认），在 2026-06-01 前后的 schema drift 对齐中被移除，
--   导致 INSERT 违反 NOT NULL 约束（线上 6/1 起累计 71 次报错）。
--
-- 配套修复：
--   1. bff/src/web/routes/collections.ts 两处 INSERT 已显式补充 "updatedAt" = NOW()
--   2. schema.prisma 两表 updatedAt 改为 @default(now()) @updatedAt，使 DB 默认值
--      成为 schema 的一部分，未来 drift 对齐不会再次移除
--
-- 本迁移为纯加固（非破坏性、可重复执行），SET DEFAULT 只影响后续 INSERT，不回填存量数据。
ALTER TABLE "UserCollection" ALTER COLUMN "updatedAt" SET DEFAULT now();
ALTER TABLE "UserCollectionItem" ALTER COLUMN "updatedAt" SET DEFAULT now();
