-- 追踪监控增强：身份信号列 + 小号检测表（2026-06-10）
--
-- 全部 additive：新增可空列 / 新建表 / 新建索引。不 UPDATE 既有列、不 DROP、不破坏历史。
-- 配套：bff/src/web/routes/tracking.ts 写侧采集；backend tracking-backfill-signals 回填；
--       backend analyze-alt-accounts 检测 Job。
--
-- 应用（生产，手动；含 CONCURRENTLY 索引须逐条在事务外跑，勿走 prisma migrate deploy）：
--   psql "$DATABASE_URL" -f backend/sql/20260610_tracking_identity_signals.sql
-- 回滚：DROP 新列/新表/新索引即可（历史事件行不受影响）。
--
-- Prisma drift：本批列/表在迁移体系外，schema.prisma 已同步声明；做 db pull/对账时勿误删。

-- ── 事件表新增身份信号列（image-only 可被动获取） ──
ALTER TABLE "PageViewEvent"
  ADD COLUMN IF NOT EXISTS "acceptLanguage" text,
  ADD COLUMN IF NOT EXISTS "uaPlatform"     text,
  ADD COLUMN IF NOT EXISTS "uaBrandMajor"   text,
  ADD COLUMN IF NOT EXISTS "uaFamily"       text,
  ADD COLUMN IF NOT EXISTS "softprint"      text,
  ADD COLUMN IF NOT EXISTS "visitorToken"   text,
  ADD COLUMN IF NOT EXISTS "tlsFingerprint" text;

ALTER TABLE "UserPixelEvent"
  ADD COLUMN IF NOT EXISTS "acceptLanguage" text,
  ADD COLUMN IF NOT EXISTS "uaPlatform"     text,
  ADD COLUMN IF NOT EXISTS "uaBrandMajor"   text,
  ADD COLUMN IF NOT EXISTS "uaFamily"       text,
  ADD COLUMN IF NOT EXISTS "softprint"      text,
  ADD COLUMN IF NOT EXISTS "visitorToken"   text,
  ADD COLUMN IF NOT EXISTS "tlsFingerprint" text;

-- 检测用索引（部分索引，仅非空行；CONCURRENTLY 避免锁表）
CREATE INDEX CONCURRENTLY IF NOT EXISTS "PageViewEvent_softprint_idx"
  ON "PageViewEvent" ("softprint", "createdAt") WHERE "softprint" IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "UserPixelEvent_softprint_idx"
  ON "UserPixelEvent" ("softprint", "createdAt") WHERE "softprint" IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "UserPixelEvent_visitorToken_idx"
  ON "UserPixelEvent" ("visitorToken") WHERE "visitorToken" IS NOT NULL;
CREATE INDEX CONCURRENTLY IF NOT EXISTS "PageViewEvent_visitorToken_idx"
  ON "PageViewEvent" ("visitorToken") WHERE "visitorToken" IS NOT NULL;

-- ── 小号嫌疑对（检测 Job 的输出，供站务复核） ──
CREATE TABLE IF NOT EXISTS "SuspectedAltPair" (
  id                serial PRIMARY KEY,
  "userIdA"         integer NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "userIdB"         integer NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "usernameA"       text NOT NULL,
  "usernameB"       text NOT NULL,
  "sharedHashes"    integer NOT NULL DEFAULT 0,   -- 共享的独立 clientHash 数
  "sharedSubnets"   integer NOT NULL DEFAULT 0,   -- 共享的独立 /24 子网数（最强网络信号）
  "sharedSoftprints" integer NOT NULL DEFAULT 0,
  "sharedTokens"    integer NOT NULL DEFAULT 0,   -- 共享的 ETag visitorToken 数
  "coVotes"         integer NOT NULL DEFAULT 0,   -- 共投页数
  "sameDir"         integer NOT NULL DEFAULT 0,
  "oppDir"          integer NOT NULL DEFAULT 0,
  "sameHour"        integer NOT NULL DEFAULT 0,   -- 同向且 1 小时内
  "agreePct"        integer,                      -- 同向占比 0-100
  "shadowPct"       integer,                      -- 共投/小号总票数 0-100
  "selfPromoAtoB"   integer NOT NULL DEFAULT 0,   -- A 给 B 原创页点赞数
  "selfPromoBtoA"   integer NOT NULL DEFAULT 0,
  score             numeric NOT NULL DEFAULT 0,   -- 综合可疑度
  status            text NOT NULL DEFAULT 'candidate', -- candidate | confirmed | cleared
  evidence          jsonb,
  "firstDetectedAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt"       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "SuspectedAltPair_pair_uniq" UNIQUE ("userIdA", "userIdB")
);

CREATE INDEX IF NOT EXISTS "SuspectedAltPair_score_idx"
  ON "SuspectedAltPair" (score DESC);
CREATE INDEX IF NOT EXISTS "SuspectedAltPair_status_idx"
  ON "SuspectedAltPair" (status);
