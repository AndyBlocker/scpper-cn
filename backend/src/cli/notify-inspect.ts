/**
 * 通知投递的运维视图。
 *
 * 出问题时最先要回答的三个问题：投递器还活着吗、失败集中在什么原因、
 * 具体是哪些用户受影响。没有这个命令就只能翻 pm2 日志。
 */

import { getPrismaClient } from '../utils/db-connection.js';

function ago(d: Date | null): string {
  if (!d) return '从未';
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

export async function runNotifyInspect(options: { hours: number; failedOnly: boolean }): Promise<void> {
  const prisma = getPrismaClient();
  const since = new Date(Date.now() - options.hours * 3600_000);

  const state = await prisma.notificationDispatchState.findUnique({ where: { id: 1 } });
  console.log('=== 投递器状态 ===');
  console.log(`  上次运行: ${ago(state?.lastRunAt ?? null)}`);
  console.log(`  上次成功: ${ago(state?.lastSuccessAt ?? null)}`);
  if (state?.circuitTrippedAt) {
    console.log(`  ⚠ 全局熔断已跳闸于 ${state.circuitTrippedAt.toISOString()}`);
    console.log(`     原因: ${state.circuitReason ?? '未知'}`);
    console.log('     复位: node --import tsx/esm src/cli/index.ts notify-dispatch --once --reset-circuit');
  } else {
    console.log('  熔断: 正常');
  }

  const byState = await prisma.notificationDelivery.groupBy({
    by: ['state'],
    where: { createdAt: { gt: since } },
    _count: { _all: true }
  });
  console.log(`\n=== 最近 ${options.hours} 小时的投递 ===`);
  if (byState.length === 0) {
    console.log('  （无记录）');
  } else {
    for (const row of byState.sort((a, b) => b._count._all - a._count._all)) {
      console.log(`  ${String(row.state).padEnd(11)} ${row._count._all}`);
    }
  }

  const failures = await prisma.notificationDelivery.groupBy({
    by: ['lastError'],
    where: { createdAt: { gt: since }, state: 'FAILED' },
    _count: { _all: true }
  });
  if (failures.length > 0) {
    console.log('\n=== 失败原因分布 ===');
    for (const row of failures.sort((a, b) => b._count._all - a._count._all)) {
      console.log(`  ${String(row.lastError ?? 'unknown').padEnd(24)} ${row._count._all}`);
    }
  }

  if (options.failedOnly) {
    const rows = await prisma.notificationDelivery.findMany({
      where: { createdAt: { gt: since }, state: 'FAILED' },
      select: { id: true, userId: true, dedupeKey: true, lastError: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 50
    });
    console.log('\n=== 失败明细（最近 50 条）===');
    for (const r of rows) {
      console.log(`  #${r.id} user=${r.userId} ${r.lastError ?? ''} ${r.dedupeKey}`);
    }
  }
}
