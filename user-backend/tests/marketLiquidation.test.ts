import assert from 'node:assert/strict';
import test, { beforeEach, type TestContext } from 'node:test';
import type { Prisma } from '@prisma/client';
import { prisma } from '../src/db.js';
import {
  createEmptyOracleCategoryRecord,
  loadUsersWithDueMarketSettlement,
  MARKET_OPEN_REASON,
  MARKET_SETTLE_REASON,
  MARKET_SETTLE_SWEEP_USER_BATCH_SIZE,
  oracleTickCache,
  oracleTickInflight,
  runMarketSettleSweep,
  settleDueMarketPositions,
  type MarketOpenPosition,
  type MarketOracleContext,
  type OracleTick,
  type Tx
} from '../src/routes/gacha/_helpers.js';

const at = (hour: number) => new Date(Date.UTC(2026, 9, 1, hour));
const asOf = at(12);
type Wallet = Prisma.GachaWalletGetPayload<{}>;
type Entry = { userId: string; reason: string; createdAt: Date; metadata: Prisma.JsonObject };

function position(overrides: Partial<MarketOpenPosition> = {}): MarketOpenPosition {
  return {
    positionId: 'position-test', contractId: 'OVERALL', side: 'LONG', lockTier: 'T1',
    lots: 10, margin: 100, stake: 100, openFee: 2, leverage: 10,
    entryIndex: 100, entryPrice: 100, entryTickTs: at(0).toISOString(),
    openedAt: at(1).toISOString(), expireAt: at(25).toISOString(), ...overrides
  };
}

function tick(hour: number, price: number): OracleTick {
  return {
    category: 'OVERALL', asOfTs: at(hour), indexMark: price,
    watermarkTs: null, voteCutoffDate: '2026-10-01', voteRuleVersion: 'test'
  };
}

function context(ticks: OracleTick[], date = asOf): MarketOracleContext {
  return { asOfTs: date, byCategory: { ...createEmptyOracleCategoryRecord(), OVERALL: ticks } };
}

function store(positions: Array<{ userId: string; position: MarketOpenPosition }>) {
  const wallets = new Map<string, Wallet>();
  const entries: Entry[] = positions.map(item => ({
    userId: item.userId, reason: MARKET_OPEN_REASON,
    createdAt: new Date(item.position.openedAt), metadata: { ...item.position }
  }));
  const writes: Entry[] = [];
  for (const { userId } of positions) {
    wallets.set(userId, {
      id: `wallet-${userId}`, userId, balance: 500, totalEarned: 500, totalSpent: 102,
      purplePityCount: 0, goldPityCount: 0, lastDailyClaimAt: null,
      createdAt: at(0), updatedAt: at(0)
    });
  }
  const tx = {
    gachaLedgerEntry: {
      findMany: async ({ where }: { where: { userId: string } }) => entries.filter(e => e.userId === where.userId),
      create: async ({ data }: { data: Prisma.GachaLedgerEntryUncheckedCreateInput }) => {
        const entry = {
          userId: data.userId, reason: data.reason, createdAt: asOf,
          metadata: data.metadata as Prisma.JsonObject
        };
        entries.push(entry);
        writes.push(entry);
        return entry;
      }
    },
    gachaWallet: {
      findUnique: async ({ where }: { where: { userId: string } }) => wallets.get(where.userId),
      update: async ({ where, data }: {
        where: { id: string };
        data: { balance: { increment: number }; totalEarned?: { increment: number } };
      }) => {
        const wallet = Array.from(wallets.values()).find(w => w.id === where.id)!;
        wallet.balance += data.balance.increment;
        wallet.totalEarned += data.totalEarned?.increment ?? 0;
        return wallet;
      }
    }
  } as unknown as Tx;
  return { tx, entries, writes, wallets };
}

function single(p = position()) {
  const data = store([{ userId: 'user-test', position: p }]);
  return { ...data, settle: (oracle: MarketOracleContext, date = asOf) => (
    settleDueMarketPositions(data.tx, 'user-test', data.wallets.get('user-test')!, oracle, date)
  ) };
}

function mockTicks(t: Pick<TestContext, 'mock'>, ticks: OracleTick[]) {
  return t.mock.method(globalThis, 'fetch', async () => Response.json({
    ok: true,
    items: ticks.map(item => ({ ...item, asOfTs: item.asOfTs.toISOString() }))
  }));
}

beforeEach(t => {
  oracleTickCache.clear();
  oracleTickInflight.clear();
  mockTicks(t, []);
});

for (const side of ['LONG', 'SHORT'] as const) {
  test(`${side}: a historical breach liquidates even after price recovers`, async () => {
    const data = single(position({ side }));
    const breach = side === 'LONG' ? 89 : 111;
    const result = await data.settle(context([tick(0, 100), tick(2, breach), tick(3, breach), tick(12, 100)]));
    assert.equal(result.settlements.length, 1);
    assert.equal(result.settlements[0]?.status, 'LIQUIDATED');
    assert.equal(result.settlements[0]?.liquidatedAt, at(2).toISOString());
    assert.equal(result.settlements[0]?.payout, 0);
    assert.equal(result.settlements[0]?.settleIndex, breach);
    assert.equal(result.state.active.length, 0);
    assert.equal(result.wallet.balance, 500);
    assert.equal(data.writes[0]?.metadata.settleTickTs, at(2).toISOString());
    assert.equal(data.writes[0]?.metadata.pnl, -102);
  });
}

test('a breach before expiry takes precedence over a recovered expiry price', async () => {
  const data = single(position({ expireAt: at(8).toISOString() }));
  const result = await data.settle(context([tick(0, 100), tick(2, 89), tick(8, 105), tick(12, 110)]));
  assert.equal(result.settlements[0]?.status, 'LIQUIDATED');
  assert.equal(result.settlements[0]?.liquidatedAt, at(2).toISOString());
  assert.equal(result.settlements[0]?.payout, 0);
});

test('ticks before openedAt do not liquidate a newly opened position', async () => {
  const data = single(position({ entryTickTs: at(0).toISOString() }));
  const result = await data.settle(context([tick(-2, 80), tick(0, 100), tick(2, 101), tick(12, 100)]));
  assert.equal(result.settlements.length, 0);
  assert.equal(result.state.active.length, 1);
  assert.equal(data.writes.length, 0);
});

test('ticks after expiry cannot liquidate a position; payout uses the expiry tick', async () => {
  const data = single(position({ expireAt: at(8).toISOString() }));
  const result = await data.settle(context([tick(0, 100), tick(8, 105), tick(9, 80), tick(12, 70)]));
  assert.equal(result.settlements[0]?.status, 'SETTLED');
  assert.equal(result.settlements[0]?.settleIndex, 105);
  assert.equal(result.settlements[0]?.payout, 146);
  assert.equal(result.wallet.balance, 646);
  assert.equal(result.settlements[0]?.liquidatedAt, null);
});

test('a tick exactly at expiry can trigger liquidation', async () => {
  const data = single(position({ expireAt: at(8).toISOString() }));
  const result = await data.settle(context([tick(0, 100), tick(8, 90), tick(12, 100)]));
  assert.equal(result.settlements[0]?.status, 'LIQUIDATED');
  assert.equal(result.settlements[0]?.liquidatedAt, at(8).toISOString());
});

test('future ticks do not liquidate a position at an earlier asOf', async () => {
  const data = single();
  const result = await data.settle(context([tick(0, 100), tick(12, 100), tick(13, 80)]));
  assert.equal(result.settlements.length, 0);
  assert.equal(result.state.active.length, 1);
});

test('equity exactly zero liquidates without fees or wallet credit', async () => {
  const data = single();
  const result = await data.settle(context([tick(0, 100), tick(2, 90), tick(12, 101)]));
  assert.equal(result.settlements[0]?.status, 'LIQUIDATED');
  assert.equal(result.settlements[0]?.settleFee, 0);
  assert.equal(result.settlements[0]?.payout, 0);
  assert.equal(data.writes.length, 1);
  assert.equal(data.writes[0]?.reason, MARKET_SETTLE_REASON);
});

test('missing oracle data keeps both open and expired positions pending', async () => {
  for (const expireAt of [at(25), at(8)]) {
    const data = single(position({ expireAt: expireAt.toISOString() }));
    const result = await data.settle(context([]));
    assert.equal(result.settlements.length, 0);
    assert.equal(result.state.active.length, 1);
    assert.equal(data.writes.length, 0);
  }
});

test('expired positions fetch their historical window when recent ticks no longer cover expiry', async t => {
  const historical = [tick(0, 100), tick(2, 89), tick(8, 105)];
  const fetch = mockTicks(t, historical);
  const date = at(24 * 60);
  const data = single(position({ expireAt: at(8).toISOString() }));
  const result = await data.settle(context([tick(24 * 50, 100), tick(24 * 60, 100)], date), date);
  assert.equal(result.settlements[0]?.status, 'LIQUIDATED');
  assert.equal(result.settlements[0]?.liquidatedAt, at(2).toISOString());
  assert.ok(fetch.mock.calls.length > 0);
  const url = new URL(String(fetch.mock.calls[0]?.arguments[0]));
  assert.equal(url.searchParams.get('asOfTs'), at(8).toISOString());
  assert.equal(url.searchParams.get('category'), 'OVERALL');
});

test('missing historical data never uses a post-expiry tick as a settlement price', async () => {
  const date = at(24 * 60);
  const data = single(position({ expireAt: at(8).toISOString() }));
  const result = await data.settle(context([tick(24 * 50, 80), tick(24 * 60, 80)], date), date);
  assert.equal(result.settlements.length, 0);
  assert.equal(result.state.active.length, 1);
  assert.equal(data.writes.length, 0);
});

test('repeated settlement reads the ledger and does not duplicate liquidation', async () => {
  const data = single();
  const oracle = context([tick(0, 100), tick(2, 89), tick(12, 100)]);
  assert.equal((await data.settle(oracle)).settlements.length, 1);
  const second = await data.settle(oracle);
  assert.equal(second.settlements.length, 0);
  assert.equal(second.state.history.length, 1);
  assert.equal(data.writes.length, 1);
});

test('background candidate query includes unexpired positions and preserves cursor pagination', async () => {
  let query: Prisma.Sql | undefined;
  const tx = {
    $queryRaw: async (sql: Prisma.Sql) => {
      query = sql;
      return [{ userId: 'offline-user' }];
    }
  } as unknown as Tx;
  assert.deepEqual(await loadUsersWithDueMarketSettlement(tx, asOf, 2, 'previous-user'), [{ userId: 'offline-user' }]);
  assert.ok(query);
  assert.doesNotMatch(query.sql, /opens\."expireAt"\s*<=/);
  assert.match(query.sql, /settles\."positionId" IS NULL/);
  assert.ok(query.values.includes('previous-user'));
  assert.ok(query.values.includes(2));
});

function mockSweep(t: TestContext, data: ReturnType<typeof store>, users: string[]) {
  t.mock.method(prisma, '$queryRaw', (async (sql: Prisma.Sql) => {
    const cursorIndex = sql.values.findIndex(v => typeof v === 'string' && users.includes(v));
    const after = cursorIndex >= 0 ? String(sql.values[cursorIndex]) : '';
    return users.filter(id => id > after).slice(0, MARKET_SETTLE_SWEEP_USER_BATCH_SIZE).map(userId => ({ userId }));
  }) as typeof prisma.$queryRaw);
  const transaction = t.mock.method(prisma, '$transaction', (async (task: (tx: Tx) => Promise<unknown>, options: { isolationLevel?: string }) => {
    assert.equal(options.isolationLevel, 'Serializable');
    return task(data.tx);
  }) as typeof prisma.$transaction);
  return transaction;
}

test('background sweep liquidates an offline user before expiry without any API request', async t => {
  const data = store([{ userId: 'offline-user', position: position() }]);
  mockTicks(t, [tick(0, 100), tick(2, 89), tick(12, 100)]);
  const transaction = mockSweep(t, data, ['offline-user']);
  assert.equal(await runMarketSettleSweep(asOf), 1);
  assert.equal(transaction.mock.calls.length, 1);
  assert.equal(data.writes[0]?.userId, 'offline-user');
  assert.equal(data.writes[0]?.metadata.status, 'LIQUIDATED');
  assert.equal(data.writes[0]?.metadata.liquidatedAt, at(2).toISOString());
});

test('background sweep continues after one user fails and reaches subsequent batches', async t => {
  const users = Array.from({ length: MARKET_SETTLE_SWEEP_USER_BATCH_SIZE + 1 }, (_, i) => `user-${String(i).padStart(3, '0')}`);
  const data = store(users.map(userId => ({ userId, position: position({ positionId: `position-${userId}` }) })));
  mockTicks(t, [tick(0, 100), tick(2, 89), tick(12, 100)]);
  mockSweep(t, data, users);
  const walletDelegate = data.tx.gachaWallet as unknown as {
    findUnique: (args: { where: { userId: string } }) => Promise<Wallet | undefined>;
  };
  const original = walletDelegate.findUnique;
  t.mock.method(walletDelegate, 'findUnique', async (args: { where: { userId: string } }) => {
    if (args.where.userId === users[0]) throw new Error('simulated wallet failure');
    return original(args);
  });
  const warnings = t.mock.method(console, 'warn', () => {});
  assert.equal(await runMarketSettleSweep(asOf), users.length - 1);
  assert.equal(data.writes.length, users.length - 1);
  assert.equal(data.writes.at(-1)?.userId, users.at(-1));
  assert.ok(warnings.mock.calls.length > 0);
});
