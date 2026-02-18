/**
 * 午夜阶梯跳变 - 触发重新结算
 *
 * 在删除异常 settle 条目后，调用此脚本为受影响用户重新触发仓位结算。
 * 恢复的仓位已过期（expireAt 在过去），系统会自动用修正后的 tick 重新计算。
 *
 * Usage:
 *   cd user-backend
 *   node --import tsx/esm src/cli/fixMidnightJumpResettle.ts
 */
import { prisma } from '../db.js';
import {
  loadOracleContext,
  runSerializableTransaction,
  ensureWallet,
  settleDueMarketPositions,
  ORACLE_TICK_LIMIT_POSITION
} from '../routes/gacha/runtime.js';

// Users affected by the anomalous tick (from the reopen inspect)
const AFFECTED_USER_IDS = [
  'cmgefehmh0003epu3atyfn35z',
  'cmlbjzmwo088s12roki9bk5ce',
  'cmgeu6lk5000gtxj99y1wh07r',
  'cmkcetkj81mycixz5xub5hvbv',
  'cmlhwtli50ac3qqa3xdo2panx'
];

async function main() {
  const asOf = new Date();
  console.log(`=== Triggering re-settlement at ${asOf.toISOString()} ===`);

  // Load oracle context (fetches ticks from BFF)
  console.log('  Loading oracle context...');
  const oracleContext = await loadOracleContext(asOf, ORACLE_TICK_LIMIT_POSITION);

  // Check oracle has ticks
  for (const [category, ticks] of Object.entries(oracleContext.byCategory)) {
    console.log(`  Oracle: ${category} has ${(ticks as any[]).length} ticks`);
  }

  for (const userId of AFFECTED_USER_IDS) {
    console.log(`\n  Processing user ${userId}...`);
    try {
      const result = await runSerializableTransaction(async (tx: any) => {
        const wallet = await ensureWallet(tx, userId);
        console.log(`    Wallet balance before: ${wallet.balance}`);
        const settled = await settleDueMarketPositions(tx, userId, wallet, oracleContext, asOf);
        return {
          walletAfter: settled.wallet.balance,
          settlements: settled.settlements,
          activeCount: settled.state.active.length
        };
      });

      console.log(`    Wallet balance after: ${result.walletAfter}`);
      console.log(`    Settlements: ${result.settlements.length}`);
      console.log(`    Remaining active: ${result.activeCount}`);
      for (const s of result.settlements) {
        console.log(`      ${s.contractId} ${s.side} ${s.leverage}x: status=${s.status}, payout=${s.payout}, pnl=${s.pnl}, settleIndex=${s.settleIndex}`);
      }
    } catch (err: any) {
      console.error(`    Error: ${err.message}`);
    }
  }

  console.log('\n=== Re-settlement complete ===');
  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
