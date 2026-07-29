-- 站外通知投递账本（QQ 推送 MVP）。
--
-- 【为什么是旁路扫描而不是在告警产生时写 outbox】
-- 三个告警 Job（PageMetricMonitorJob / UserFollowActivityJob / ForumInteractionAlertJob）
-- 跑在 scpper-sync 的关键路径上，有全局租约锁与 15 分钟无进展看门狗，且与「未读折叠」
-- 这个非平凡去重语义纠缠。改它们的插入语句风险远大于收益。
-- 本表由独立进程（pm2: scpper-notify）按 24 小时回看窗口 + dedupeKey 反连接来发现
-- 「还没推过的告警」，producer 一行不改；出问题停掉那个 app 即可完全回滚。
--
-- 【id 用 BIGINT】
-- 同一天（2026-07-28）刚因 UserTagPreference 的 int4 序列耗尽导致 sync 每轮失败。
-- 本表是纯追加、且未来很可能引入 ON CONFLICT（每次冲突也会消耗序列值），
-- 没有理由再赌 21 亿够用。
--
-- 【dedupeKey 为什么带内容签名】
-- PageMetricAlert 是**就地合并**的：同一 watch 的最早未读行会被反复 UPDATE
-- （newValue/detectedAt 变化，行 id 不变）。只按行 id 去重会漏掉后续增量，
-- 只要行变过就推又会重复轰炸。键里带 newValue 让「票数从 20 涨到 41」能推、
-- 「同一个 41 被重复扫到」不推。

-- CreateEnum
CREATE TYPE "NotificationDeliveryChannel" AS ENUM ('QQ', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationDeliveryState" AS ENUM (
  'PENDING', 'SCHEDULED', 'SENDING', 'SENT', 'FAILED', 'SUPPRESSED', 'CANCELLED'
);

-- CreateTable
CREATE TABLE "NotificationDelivery" (
    "id" BIGSERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "channel" "NotificationDeliveryChannel" NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "state" "NotificationDeliveryState" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDispatchState" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "lastRunAt" TIMESTAMP(3),
    "lastSuccessAt" TIMESTAMP(3),
    "circuitTrippedAt" TIMESTAMP(3),
    "circuitReason" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationDispatchState_pkey" PRIMARY KEY ("id")
);

-- 幂等的核心：同一个 (来源, 主键, 内容签名) 只会产生一条投递
CREATE UNIQUE INDEX "NotificationDelivery_dedupeKey_key" ON "NotificationDelivery"("dedupeKey");

-- 按用户查最近投递（日限额判定、运维排查）
CREATE INDEX "NotificationDelivery_userId_createdAt_idx" ON "NotificationDelivery"("userId", "createdAt");

-- 捞待投递/待重试
CREATE INDEX "NotificationDelivery_state_scheduledAt_idx" ON "NotificationDelivery"("state", "scheduledAt");

-- retention 任务按时间清理
CREATE INDEX "NotificationDelivery_createdAt_idx" ON "NotificationDelivery"("createdAt");

-- AddForeignKey
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 单行状态表：插入初始行，让 dispatcher 不必处理「表为空」的分支
INSERT INTO "NotificationDispatchState" ("id", "updatedAt")
VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
