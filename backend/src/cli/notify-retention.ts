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

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { getPrismaClient } from '../utils/db-connection.js';

const USER_BACKEND_CLIENT_PATH = '../../../user-backend/node_modules/@prisma/client/index.js';
const __dirname_ = path.dirname(fileURLToPath(import.meta.url));

/**
 * 加载 user-backend 的 Prisma client 以清理绑定挑战。
 * 与 services/userDirectory.ts 同一手法（cli/alerts.ts 早有先例）；
 * 连不上就返回 null，跳过这一桶而不是让整个命令失败。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadUserBackendClient(): Promise<any | null> {
  const candidate = path.resolve(__dirname_, '../../../user-backend/.env');
  if (fs.existsSync(candidate)) dotenv.config({ path: candidate, override: false });
  const url = process.env.USER_DATABASE_URL || process.env.USER_BACKEND_DATABASE_URL;
  if (!url) return null;
  try {
    const localRequire = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = localRequire(USER_BACKEND_CLIENT_PATH);
    if (typeof mod?.PrismaClient !== 'function') return null;
    return new mod.PrismaClient({ datasources: { db: { url } } });
  } catch {
    return null;
  }
}

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
    // FAILED 也是终态（not_friend 这类永久失败不会重试），漏掉它会让这些行无限增长
    state: { in: ['SENT', 'SUPPRESSED', 'CANCELLED', 'FAILED'] as Array<'SENT' | 'SUPPRESSED' | 'CANCELLED' | 'FAILED'> },
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

  // 绑定挑战：每次「发起绑定」都会新建一行，终态行不清理就会无限增长
  // （migration 里那个 (status, expiresAt) 索引本来就是为清理留的）。
  const challengeCutoff = new Date(now - options.challengeDays * 86400_000);
  // 除了终态，还要收掉「PENDING 但早已过 expiresAt」的：
  // 没有任何任务把它们转成 EXPIRED（status 读取只是过滤掉而已），
  // 于是每个生成了验证码却没回来的用户都会留下一行永远删不掉。
  const challengeWhere = {
    createdAt: { lt: challengeCutoff },
    OR: [
      { status: { in: ['VERIFIED', 'EXPIRED', 'CANCELLED', 'FAILED'] as Array<'VERIFIED' | 'EXPIRED' | 'CANCELLED' | 'FAILED'> } },
      { status: 'PENDING' as const, expiresAt: { lt: challengeCutoff } }
    ]
  };
  const userDb = await loadUserBackendClient();
  if (userDb) {
    buckets.push({
      label: `ChannelBindingChallenge（终态且早于 ${options.challengeDays} 天）`,
      count: await userDb.channelBindingChallenge.count({ where: challengeWhere }),
      run: async () => (await userDb.channelBindingChallenge.deleteMany({ where: challengeWhere })).count
    });
  } else {
    console.warn('[notify-retention] 无法连接用户库，跳过 ChannelBindingChallenge 清理');
  }

  const total = buckets.reduce((acc, b) => acc + b.count, 0);

  console.log(`[notify-retention] ${options.apply ? '执行模式' : 'DRY-RUN（不会删除任何数据）'}`);
  for (const b of buckets) {
    console.log(`  ${b.label}: ${b.count} 行`);
  }
  console.log(`  合计: ${total} 行`);

  if (!options.apply) {
    console.log('[notify-retention] 未加 --apply，本次不执行删除。');
    await userDb?.$disconnect?.();
    return;
  }

  if (total === 0) {
    console.log('[notify-retention] 无需清理。');
    await userDb?.$disconnect?.();
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
  await userDb?.$disconnect?.();
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
