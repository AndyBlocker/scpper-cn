/**
 * 通知数据保留策略。
 *
 * **默认只统计不删除**（dry-run）。真正执行需要显式加 --apply。
 * 理由不只是谨慎：这些表里是用户的通知历史，删错了没法恢复，而「表会变大」
 * 是个以月计的问题，多等一天确认口径的代价远小于误删。
 *
 * 现存量级（2026-07-28 实测生产库）：
 *   PageMetricAlert 34872、ForumInteractionAlert 28055、UserActivityAlert 4088，
 *   且**没有任何清理任务**，已读行只增不减。接上 QQ 推送后 NotificationDelivery
 *   还会按日增长。
 */

import { getPrismaClient } from '../utils/db-connection.js';

interface RetentionOptions {
  apply: boolean;
  deliveryDays: number;
  challengeDays: number;
  alertDays: number;
}

interface Bucket {
  label: string;
  count: number;
  /** 实际执行删除；dry-run 时不调用 */
  run: () => Promise<number>;
}

export async function runNotifyRetention(options: RetentionOptions): Promise<void> {
  const prisma = getPrismaClient();
  const now = Date.now();
  const deliveryCutoff = new Date(now - options.deliveryDays * 86400_000);
  const alertCutoff = new Date(now - options.alertDays * 86400_000);

  const buckets: Bucket[] = [];

  // ① 已终态的投递记录。dedupeKey 的去重窗口只有 24 小时回看，
  //    终态记录留 30 天足够排查，再久就只是占地方。
  const deliveryWhere = {
    state: { in: ['SENT', 'SUPPRESSED', 'CANCELLED'] as Array<'SENT' | 'SUPPRESSED' | 'CANCELLED'> },
    createdAt: { lt: deliveryCutoff }
  };
  buckets.push({
    label: `NotificationDelivery（终态且早于 ${options.deliveryDays} 天）`,
    count: await prisma.notificationDelivery.count({ where: deliveryWhere }),
    run: async () => (await prisma.notificationDelivery.deleteMany({ where: deliveryWhere })).count
  });

  // ② 已读的三张告警表。**只删已读**：未读的无论多老都保留，
  //    否则用户长期不上线回来会发现历史动态凭空消失。
  const ackWhere = { acknowledgedAt: { not: null, lt: alertCutoff } };
  buckets.push({
    label: `PageMetricAlert（已读且早于 ${options.alertDays} 天）`,
    count: await prisma.pageMetricAlert.count({ where: ackWhere }),
    run: async () => (await prisma.pageMetricAlert.deleteMany({ where: ackWhere })).count
  });
  buckets.push({
    label: `ForumInteractionAlert（已读且早于 ${options.alertDays} 天）`,
    count: await prisma.forumInteractionAlert.count({ where: ackWhere }),
    run: async () => (await prisma.forumInteractionAlert.deleteMany({ where: ackWhere })).count
  });
  buckets.push({
    label: `UserActivityAlert（已读且早于 ${options.alertDays} 天）`,
    count: await prisma.userActivityAlert.count({ where: ackWhere }),
    run: async () => (await prisma.userActivityAlert.deleteMany({ where: ackWhere })).count
  });

  const total = buckets.reduce((acc, b) => acc + b.count, 0);

  console.log(`[notify-retention] ${options.apply ? '执行模式' : 'DRY-RUN（不会删除任何数据）'}`);
  for (const b of buckets) {
    console.log(`  ${b.label}: ${b.count} 行`);
  }
  console.log(`  合计: ${total} 行`);

  if (!options.apply) {
    console.log('[notify-retention] 未加 --apply，本次不执行删除。');
    return;
  }

  if (total === 0) {
    console.log('[notify-retention] 无需清理。');
    return;
  }

  let deleted = 0;
  for (const b of buckets) {
    if (b.count === 0) continue;
    const n = await b.run();
    deleted += n;
    console.log(`  已删除 ${n} 行 — ${b.label}`);
  }
  console.log(`[notify-retention] 完成，共删除 ${deleted} 行。`);
}

export function parseRetentionOptions(raw: Record<string, unknown>): RetentionOptions {
  const num = (v: unknown, d: number) => {
    const n = Number.parseInt(String(v ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    apply: Boolean(raw.apply),
    deliveryDays: num(raw.deliveryDays, 30),
    challengeDays: num(raw.challengeDays, 90),
    alertDays: num(raw.alertDays, 180)
  };
}
