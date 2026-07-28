-- 通知渠道绑定：QQ 绑定闭环所需的两张表与三个枚举。
--
-- 【为什么是「渠道绑定」而不是 UserAccount 上加一列】
-- 现有的 linkedWikidotId 是「一个外部身份一列」的做法。再按这个路子加 linkedQqNumber，
-- 将来接入第三个渠道就要再改一次 UserAccount 表结构、再改一次 /auth/me 的返回形状。
-- 抽成 (userId, channel, address) 后，加渠道只需往 NotificationChannel 枚举里加值。
--
-- 【为什么验证码只存哈希】
-- user-backend/src/services/AGENTS.md 明令「验证码以明文落库或日志输出」是反模式。
-- 既有的 WikidotBindingTask.verificationCode 存明文有其特殊性 —— 那个码本来就要被用户
-- 公开写进 wikidot 的修订注释里。QQ 的码是私聊/好友验证消息传递的准秘密，没有存明文的理由。
-- codeHash 上的唯一索引让机器人回调时可以按哈希 O(1) 反查，不必遍历。
--
-- 【本迁移刻意只含新增对象】
-- `prisma migrate diff` 对本库还会生成一批与本次无关的既有漂移修正
-- （gacha 系列表的 DROP DEFAULT / RenameIndex、DROP TABLE gacha_orphan_slot_cleanup_log、
--  DROP INDEX idx_gacha_card_title_trgm 等）。那些是独立问题，不应搭本次功能的车上线，
--  故本文件为手写，只包含 QQ 绑定真正需要的对象。

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('QQ');

-- CreateEnum
CREATE TYPE "ChannelBindingStatus" AS ENUM ('ACTIVE', 'PAUSED', 'REVOKED');

-- CreateEnum
CREATE TYPE "ChannelChallengeStatus" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED', 'CANCELLED', 'FAILED');

-- CreateTable
CREATE TABLE "NotificationChannelBinding" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "address" TEXT NOT NULL,
    "displayName" TEXT,
    "status" "ChannelBindingStatus" NOT NULL DEFAULT 'ACTIVE',
    "verifiedAt" TIMESTAMP(3) NOT NULL,
    "lastSentAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailureCode" TEXT,
    "suspendedUntil" TIMESTAMP(3),
    "resolvedMatrix" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationChannelBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelBindingChallenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeHint" TEXT NOT NULL,
    "status" "ChannelChallengeStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "boundAddress" TEXT,
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelBindingChallenge_pkey" PRIMARY KEY ("id")
);

-- 一个账号在一个渠道上只能有一条绑定
CREATE UNIQUE INDEX "NotificationChannelBinding_userId_channel_key"
  ON "NotificationChannelBinding"("userId", "channel");

-- 一个 QQ 号只能绑一个账号 —— 与 UserAccount.linkedWikidotId 的唯一性语义对称。
-- 这条约束是防「一个 QQ 被绑到多个站点账号、进而收到别人通知」的最后一道闸，
-- 应用层的检查只是为了给出友好提示，真正兜底的是它。
CREATE UNIQUE INDEX "NotificationChannelBinding_channel_address_key"
  ON "NotificationChannelBinding"("channel", "address");

-- 投递侧按 (channel, status) 捞活跃绑定
CREATE INDEX "NotificationChannelBinding_channel_status_idx"
  ON "NotificationChannelBinding"("channel", "status");

-- 机器人回调时按码的哈希直接定位挑战
CREATE UNIQUE INDEX "ChannelBindingChallenge_codeHash_key"
  ON "ChannelBindingChallenge"("codeHash");

CREATE INDEX "ChannelBindingChallenge_userId_channel_status_idx"
  ON "ChannelBindingChallenge"("userId", "channel", "status");

-- 过期清理任务按 (status, expiresAt) 扫描
CREATE INDEX "ChannelBindingChallenge_status_expiresAt_idx"
  ON "ChannelBindingChallenge"("status", "expiresAt");

-- AddForeignKey
ALTER TABLE "NotificationChannelBinding" ADD CONSTRAINT "NotificationChannelBinding_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ChannelBindingChallenge" ADD CONSTRAINT "ChannelBindingChallenge_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "UserAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
