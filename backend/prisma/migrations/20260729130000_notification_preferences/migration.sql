-- 通知偏好：类型 × 渠道矩阵，以及渠道级设置。
--
-- 手写而非 `prisma migrate diff` 生成：本库存在历史漂移（若干表长期只在
-- 手工 SQL 脚本里、未进 schema.prisma），diff 会把那些差异一并打包进来，
-- 甚至生成 DROP TABLE。这一点在 #176 里已经实际验证过。

CREATE TYPE "NotificationTypeKey" AS ENUM (
  'PAGE_COMMENT', 'PAGE_VOTE', 'PAGE_REVISION', 'FOLLOW_ACTIVITY', 'FORUM_INTERACTION'
);

CREATE TYPE "QqDeliveryMode" AS ENUM ('REALTIME', 'DAILY_DIGEST');

CREATE TABLE "UserNotificationPreference" (
  "id"          SERIAL PRIMARY KEY,
  "userId"      INTEGER NOT NULL,
  "type"        "NotificationTypeKey" NOT NULL,
  "siteEnabled" BOOLEAN NOT NULL DEFAULT true,
  "qqEnabled"   BOOLEAN NOT NULL DEFAULT true,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);

-- 一个用户在一个类型上只有一行
CREATE UNIQUE INDEX "uniq_user_notification_preference"
  ON "UserNotificationPreference"("userId", "type");
CREATE INDEX "UserNotificationPreference_userId_idx"
  ON "UserNotificationPreference"("userId");

ALTER TABLE "UserNotificationPreference"
  ADD CONSTRAINT "UserNotificationPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "UserNotificationChannelSetting" (
  "userId"       INTEGER PRIMARY KEY,
  -- 默认 20 而非全局上限 40：默认值应当保守，用户要更多可以自己调
  "qqDailyLimit" INTEGER NOT NULL DEFAULT 20,
  "qqMode"       "QqDeliveryMode" NOT NULL DEFAULT 'REALTIME',
  -- 0–23，按 UTC+8 解释
  "qqDigestHour" INTEGER NOT NULL DEFAULT 21,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL
);

-- 取值范围在数据库层兜底：应用层校验漏了也不会写进非法值，
-- 而 qqDigestHour 越界会让「定时推送」永远不触发 —— 静默失效最难查。
ALTER TABLE "UserNotificationChannelSetting"
  ADD CONSTRAINT "chk_qq_digest_hour" CHECK ("qqDigestHour" BETWEEN 0 AND 23),
  ADD CONSTRAINT "chk_qq_daily_limit" CHECK ("qqDailyLimit" BETWEEN 1 AND 200);

ALTER TABLE "UserNotificationChannelSetting"
  ADD CONSTRAINT "UserNotificationChannelSetting_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── 回填既有的静音意图 ──────────────────────────────────────────────
--
-- 旧机制：UserMetricPreference.config->>'muted' 为 true 时，
-- PageMetricMonitorJob 会给对应的 watch 打上 mutedAt，进而**不产生告警**。
-- 新机制下告警一律产生（站内与 QQ 各自独立地决定要不要展示/推送），
-- 若不回填，这些用户静音过的类型会突然重新出现在提醒流里 ——
-- 他们没做任何操作，界面却变了，这是最容易招致投诉的一类回归。
--
-- 静音在旧语义下等于「完全不想收到」，因此两个渠道都置 false。
INSERT INTO "UserNotificationPreference" ("userId", "type", "siteEnabled", "qqEnabled", "updatedAt")
SELECT
  ump."userId",
  (CASE ump."metric"
     WHEN 'COMMENT_COUNT'  THEN 'PAGE_COMMENT'
     WHEN 'VOTE_COUNT'     THEN 'PAGE_VOTE'
     WHEN 'REVISION_COUNT' THEN 'PAGE_REVISION'
   END)::"NotificationTypeKey",
  false,
  false,
  now()
FROM "UserMetricPreference" ump
WHERE (ump.config->>'muted') IN ('true', 'True', 'TRUE')
  AND ump."metric" IN ('COMMENT_COUNT', 'VOTE_COUNT', 'REVISION_COUNT')
ON CONFLICT ("userId", "type") DO NOTHING;

-- 汇总周期状态。显式记录「上一次汇总的截止线」，
-- 而不是从投递记录反推 —— 反推在跨午夜宕机、中途切换模式时必然出错。
ALTER TABLE "UserNotificationChannelSetting"
  ADD COLUMN "lastDigestCutoffAt" TIMESTAMP(3);

-- ── 「每个自然日一封汇总」的占位表 ────────────────────────────
-- 主键 (userId, cutoffDay) 就是名额本身：ON CONFLICT DO NOTHING 让
-- 「查槽位 → 占槽位」变成一次原子操作，重叠的两轮里只有一方能插入成功。
--
-- 单位是**周期边界所属的那一天**，不是消息发出去的那一天：
--  · 跨午夜的补发属于前一天的周期，不占新一天的名额（否则用户被相位锁死在午夜）
--  · 同一天内把时点从 10:00 改到 21:00，两个边界同属一天，只能发一封
CREATE TABLE "DigestSlotClaim" (
    "userId"    INTEGER NOT NULL,
    "cutoffDay" DATE NOT NULL,
    "cutoffAt"  TIMESTAMP(3) NOT NULL,
    -- 占位者是哪一封。重发时用它区分「这个槽位是不是我自己的」
    "digestKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DigestSlotClaim_pkey" PRIMARY KEY ("userId", "cutoffDay")
);
CREATE INDEX "DigestSlotClaim_createdAt_idx" ON "DigestSlotClaim"("createdAt");
ALTER TABLE "DigestSlotClaim" ADD CONSTRAINT "DigestSlotClaim_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
