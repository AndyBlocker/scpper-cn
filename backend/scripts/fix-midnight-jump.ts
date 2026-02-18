/**
 * 午夜阶梯跳变修复脚本 (backend 数据库)
 *
 * Step 2: 查看并删除异常 tick
 */
import { getPrismaClient } from '../src/utils/db-connection.js';

const ANOMALOUS_TS = new Date('2026-02-14T16:00:00Z'); // Feb 15 00:00 UTC+8

async function main() {
  const prisma = getPrismaClient();
  const action = process.argv[2] || 'inspect';

  try {
    if (action === 'inspect') {
      await inspect(prisma);
    } else if (action === 'delete-ticks') {
      await deleteTicks(prisma);
    } else {
      console.log('Usage: tsx scripts/fix-midnight-jump.ts [inspect|delete-ticks]');
    }
  } finally {
    await prisma.$disconnect();
  }
}

async function inspect(prisma: any) {
  // 1. Show anomalous tick vs previous
  console.log('=== Tick Comparison ===');
  const prev = await prisma.categoryIndexTick.findMany({
    where: { asOfTs: new Date('2026-02-14T15:00:00Z') },
    orderBy: { category: 'asc' }
  });
  const curr = await prisma.categoryIndexTick.findMany({
    where: { asOfTs: ANOMALOUS_TS },
    orderBy: { category: 'asc' }
  });
  for (const p of prev) {
    const c = curr.find((t: any) => t.category === p.category);
    const delta = c ? Number(c.indexMark) - Number(p.indexMark) : NaN;
    console.log(`  ${p.category}: ${Number(p.indexMark).toFixed(2)} → ${c ? Number(c.indexMark).toFixed(2) : '?'} (${delta >= 0 ? '+' : ''}${delta.toFixed(2)})`);
  }

  // 2. Count ticks to delete
  const tickCount = await prisma.categoryIndexTick.count({
    where: { asOfTs: { gte: ANOMALOUS_TS } }
  });
  let forecastCount = 0;
  try {
    const forecastRows = await prisma.$queryRaw<Array<{count: bigint}>>`
      SELECT count(*) FROM "CategoryIndexForecastTick" WHERE as_of_ts >= ${ANOMALOUS_TS}
    `;
    forecastCount = Number(forecastRows[0]?.count ?? 0);
  } catch {
    console.log('  (CategoryIndexForecastTick table does not exist, skipping)');
  }
  console.log(`\n=== Data to Delete ===`);
  console.log(`  CategoryIndexTick >= ${ANOMALOUS_TS.toISOString()}: ${tickCount} rows`);
  console.log(`  CategoryIndexForecastTick >= ${ANOMALOUS_TS.toISOString()}: ${forecastCount} rows`);
}

async function deleteTicks(prisma: any) {
  console.log('=== Deleting Anomalous Ticks ===');

  // Delete the anomalous tick and all subsequent ones (they'll be regenerated)
  const deletedTicks = await prisma.categoryIndexTick.deleteMany({
    where: { asOfTs: { gte: ANOMALOUS_TS } }
  });
  console.log(`  Deleted ${deletedTicks.count} CategoryIndexTick rows (>= ${ANOMALOUS_TS.toISOString()})`);

  try {
    const deletedForecastRows = await prisma.$queryRaw<Array<{count: bigint}>>`
      WITH deleted AS (
        DELETE FROM "CategoryIndexForecastTick" WHERE as_of_ts >= ${ANOMALOUS_TS} RETURNING 1
      ) SELECT count(*) FROM deleted
    `;
    const deletedForecastCount = Number(deletedForecastRows[0]?.count ?? 0);
    console.log(`  Deleted ${deletedForecastCount} CategoryIndexForecastTick rows (>= ${ANOMALOUS_TS.toISOString()})`);
  } catch {
    console.log('  (CategoryIndexForecastTick table does not exist, skipping)');
  }

  console.log('Done. Run analyze to regenerate ticks with corrected algorithm.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
