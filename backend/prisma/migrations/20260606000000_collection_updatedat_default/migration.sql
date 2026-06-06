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
--
-- 注意：UserCollection / UserCollectionItem 的建表 SQL 位于 backend/sql/20251212_user_collections.sql
-- （迁移目录之外），prisma migrate deploy 不会执行它。为兼容空库重放（CI / 新环境 / shadow
-- database，否则 migrate dev 无法创建新迁移），用 to_regclass 守卫表存在性；混合大小写表名
-- 必须带双引号传入 to_regclass。
DO $$
BEGIN
  IF to_regclass('public."UserCollection"') IS NOT NULL THEN
    ALTER TABLE "UserCollection" ALTER COLUMN "updatedAt" SET DEFAULT NOW();
  END IF;
  IF to_regclass('public."UserCollectionItem"') IS NOT NULL THEN
    ALTER TABLE "UserCollectionItem" ALTER COLUMN "updatedAt" SET DEFAULT NOW();
  END IF;
END $$;

-- SiteOverviewDaily 同款预防性加固（Codex review 发现）：其建表迁移 20250825000005 手工带
-- DEFAULT now() 且线上健在，但 schema 此前是裸 @updatedAt，与迁移历史矛盾，存在被未来
-- drift 对齐删除的同等风险。schema 已同步改为 @default(now()) @updatedAt，此处重申默认值（幂等）。
ALTER TABLE "SiteOverviewDaily" ALTER COLUMN "updatedAt" SET DEFAULT NOW();
