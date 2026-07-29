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
