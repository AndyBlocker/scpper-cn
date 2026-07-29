-- 冷启动水位线持久化。
--
-- 原实现：NOTIFY_DISPATCH_START_AT 未配置时取「进程启动时刻」作为闸门。
-- 这挡住了首次上线群发历史告警，但带来另一个问题 —— 闸门随每次重启前移，
-- 投递器停机（部署、崩溃、熔断复位）期间产生的告警会落到窗口之外，
-- 既不会被重试也不会留下 NotificationDelivery 记录，等于静默丢失。
--
-- 改为：首轮把闸门值落库，之后一律以库里的为准。
ALTER TABLE "NotificationDispatchState" ADD COLUMN IF NOT EXISTS "cutoffAt" TIMESTAMP(3);
