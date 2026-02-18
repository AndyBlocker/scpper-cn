import { prisma } from '../db.js';

async function main() {
  // Search by displayName
  let user = await prisma.userAccount.findFirst({
    where: { displayName: { contains: 'Kirito', mode: 'insensitive' } },
    include: { gachaWallet: true, wikidotBindingTasks: true }
  });

  // Fallback: search by wikidot binding task (new schema)
  if (!user) {
    const binding = await prisma.wikidotBindingTask.findFirst({
      where: {
        status: 'VERIFIED',
        wikidotUsername: { contains: 'Kirito', mode: 'insensitive' }
      },
      orderBy: { verifiedAt: 'desc' },
      include: { user: { include: { gachaWallet: true } } }
    });
    const fallbackBinding = binding ?? await prisma.wikidotBindingTask.findFirst({
      where: { wikidotUsername: { contains: 'Kirito', mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' },
      include: { user: { include: { gachaWallet: true } } }
    });
    if (fallbackBinding) {
      console.log('Found via wikidot binding task:', fallbackBinding.wikidotUsername);
      user = fallbackBinding.user as any;
    }
  }

  if (!user) {
    // Last resort: search by email
    user = await prisma.userAccount.findFirst({
      where: { email: { contains: 'kirito', mode: 'insensitive' } },
      include: { gachaWallet: true, wikidotBindingTasks: true }
    });
  }

  if (!user) {
    console.log('User "Kirito_Blade" not found');
    await prisma.$disconnect();
    return;
  }

  console.log('=== User Info ===');
  console.log('  id:', user.id);
  console.log('  displayName:', user.displayName);
  console.log('  email:', user.email);
  console.log('  linkedWikidotId:', user.linkedWikidotId);

  const wallet = (user as any).gachaWallet;
  console.log('  wallet balance:', wallet?.balance ?? 'N/A');

  // Check ledger entries for market activity
  const marketEntries = await prisma.gachaLedgerEntry.findMany({
    where: {
      userId: user.id,
      reason: { in: ['MARKET_POSITION_OPEN', 'MARKET_POSITION_OPEN_SPEND', 'MARKET_POSITION_SETTLE'] }
    },
    orderBy: { createdAt: 'asc' }
  });

  console.log('\n=== Market Ledger Entries ===');
  console.log('  Total:', marketEntries.length);

  // Build position state
  const opens = new Map<string, any>();
  const settles = new Map<string, any>();

  for (const entry of marketEntries) {
    const meta = entry.metadata as Record<string, any> | null;
    const posId = meta?.positionId;
    if (!posId) continue;

    if (entry.reason === 'MARKET_POSITION_OPEN') {
      opens.set(posId, { entry, meta });
    }
    if (entry.reason === 'MARKET_POSITION_SETTLE') {
      settles.set(posId, { entry, meta });
    }
  }

  console.log('\n=== Position Summary ===');
  for (const [posId, open] of opens) {
    const settle = settles.get(posId);
    const m = open.meta;
    const status = settle ? (settle.meta.status || 'SETTLED') : 'ACTIVE';
    console.log(`  ${posId}: ${m.contractId} ${m.side} ${m.leverage}x, margin=${m.margin}`);
    console.log(`    entryIndex=${m.entryIndex}, openedAt=${open.entry.createdAt.toISOString()}`);
    if (settle) {
      const sm = settle.meta;
      console.log(`    status=${status}, settleIndex=${sm.settleIndex}, payout=${sm.payout}, pnl=${sm.pnl}`);
      console.log(`    settleTickTs=${sm.settleTickTs}, settledAt=${sm.settledAt}`);
    } else {
      console.log(`    status=ACTIVE (not yet settled)`);
    }
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
