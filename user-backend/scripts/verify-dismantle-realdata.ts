/**
 * 只读真实数据校验（#96）：对若干真实用户，用【新端点的批量查询】构造快照，跑 planner，
 * 并用【逐字复刻旧端点的逐 item 只读查询(count + findFree，把"已删"在内存里排除后续查询)】
 * 独立选择，断言两者选中的实例完全一致。纯读，不写库。
 *
 * 运行：cd user-backend && npx tsx scripts/verify-dismantle-realdata.ts
 */
import { prisma } from '../src/db.js';
import { planBatchSelectiveDismantle, type DismantlePlanItem } from '../src/routes/gacha/_dismantlePlanner.js';

let seed = 0xC0FFEE;
function rnd() { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) % 1_000_000) / 1_000_000; }
function randint(lo: number, hi: number) { return lo + Math.floor(rnd() * (hi - lo + 1)); }

async function buildSnapshotQueries(userId: string, cardIds: string[]) {
  const [cardDefs, totalGroups, lockedGroups, freeInstances] = await Promise.all([
    prisma.gachaCardDefinition.findMany({ where: { id: { in: cardIds } } }),
    prisma.gachaCardInstance.groupBy({ by: ['cardId', 'affixSignature'], where: { userId, cardId: { in: cardIds }, tradeListingId: null, buyRequestId: null }, _count: { _all: true } }),
    prisma.gachaCardInstance.groupBy({ by: ['cardId', 'affixSignature'], where: { userId, cardId: { in: cardIds }, tradeListingId: null, buyRequestId: null, isLocked: true }, _count: { _all: true } }),
    prisma.gachaCardInstance.findMany({ where: { userId, cardId: { in: cardIds }, tradeListingId: null, buyRequestId: null, placementSlot: { is: null }, showcaseSlot: { is: null }, isLocked: false }, select: { id: true, cardId: true, affixSignature: true }, orderBy: [{ obtainedAt: 'asc' }, { id: 'asc' }] })
  ]);
  const cardExists = new Set(cardDefs.map((c) => c.id));
  const totalByCard = new Map<string, number>(); const totalByCardSig = new Map<string, Map<string, number>>();
  const lockedByCard = new Map<string, number>(); const lockedByCardSig = new Map<string, Map<string, number>>();
  const acc = (flat: Map<string, number>, nest: Map<string, Map<string, number>>, gs: any[]) => {
    for (const g of gs) { const c = g._count._all; flat.set(g.cardId, (flat.get(g.cardId) ?? 0) + c); let inner = nest.get(g.cardId); if (!inner) { inner = new Map(); nest.set(g.cardId, inner); } inner.set(g.affixSignature, (inner.get(g.affixSignature) ?? 0) + c); }
  };
  acc(totalByCard, totalByCardSig, totalGroups); acc(lockedByCard, lockedByCardSig, lockedGroups);
  const freeByCard = new Map<string, Array<{ id: string; cardId: string; affixSignature: string }>>();
  let nullSig = 0;
  for (const inst of freeInstances) {
    if ((inst.affixSignature as any) == null) nullSig++;
    let list = freeByCard.get(inst.cardId); if (!list) { list = []; freeByCard.set(inst.cardId, list); } list.push(inst);
  }
  return { snapshot: { totalByCard, totalByCardSig, lockedByCard, lockedByCardSig, freeByCard, cardExists }, nullSig };
}

// 逐字复刻旧端点：逐 item count + findFree，把已"删"的 id 在内存里排除后续查询。
async function referenceSelectRealData(userId: string, items: DismantlePlanItem[], keepAtLeast: number) {
  const deleted = new Set<string>();
  const result: Array<{ cardId: string; selectedIds: string[] }> = [];
  for (const item of items) {
    const sig = item.affixSignature;
    const baseWhere: any = { userId, cardId: item.cardId, tradeListingId: null, buyRequestId: null, id: { notIn: [...deleted] } };
    if (sig != null) baseWhere.affixSignature = sig;
    const [totalOwned, lockedOwned] = await Promise.all([
      prisma.gachaCardInstance.count({ where: baseWhere }),
      prisma.gachaCardInstance.count({ where: { ...baseWhere, isLocked: true } })
    ]);
    const minKeep = Math.max(lockedOwned, keepAtLeast);
    const targetDelete = Math.min(item.count, Math.max(0, totalOwned - minKeep));
    if (targetDelete <= 0) continue;
    const free = await prisma.gachaCardInstance.findMany({
      where: { ...baseWhere, placementSlot: { is: null }, showcaseSlot: { is: null }, isLocked: false },
      orderBy: [{ obtainedAt: 'asc' }, { id: 'asc' }], take: targetDelete, select: { id: true }
    });
    if (free.length <= 0) continue;
    const card = await prisma.gachaCardDefinition.findUnique({ where: { id: item.cardId } });
    if (!card) continue;
    free.forEach((f) => deleted.add(f.id));
    result.push({ cardId: item.cardId, selectedIds: free.map((f) => f.id) });
  }
  return result;
}

async function main() {
  // 取库存最多的若干用户
  const heavy = await prisma.gachaInventory.groupBy({ by: ['userId'], where: { count: { gt: 0 } }, _count: { _all: true }, orderBy: { _count: { userId: 'desc' } }, take: 8 });
  let totalCases = 0; let mismatches = 0; let nullSigTotal = 0;
  for (const u of heavy) {
    const userId = u.userId;
    const inv = await prisma.gachaInventory.findMany({ where: { userId, count: { gt: 0 } }, select: { cardId: true }, take: 1000 });
    if (inv.length === 0) continue;
    // 采样该用户实际存在的 affixSignature，用于覆盖"指定 sig"过滤路径。
    const sigGroups = await prisma.gachaCardInstance.groupBy({ by: ['affixSignature'], where: { userId }, _count: { _all: true } });
    const realSigs = sigGroups.map((g) => g.affixSignature).filter((s): s is string => s != null).slice(0, 20);
    // 跑 12 个随机 items 批次
    for (let t = 0; t < 12; t++) {
      const k = randint(1, Math.min(40, inv.length));
      const items: DismantlePlanItem[] = [];
      for (let j = 0; j < k; j++) {
        const card = inv[randint(0, inv.length - 1)].cardId;
        // 40% 概率指定一个真实存在的 sig（可能与该卡不匹配→选 0，亦是有效的过滤路径测试）。
        const sig = (realSigs.length > 0 && rnd() < 0.4) ? realSigs[randint(0, realSigs.length - 1)] : undefined;
        items.push({ cardId: card, affixSignature: sig, count: randint(1, 5) });
      }
      const keepAtLeast = randint(0, 3);
      const cardIds = [...new Set(items.map((i) => i.cardId))];
      const { snapshot, nullSig } = await buildSnapshotQueries(userId, cardIds);
      nullSigTotal += nullSig;
      const plan = planBatchSelectiveDismantle(items, keepAtLeast, snapshot);
      const ref = await referenceSelectRealData(userId, items, keepAtLeast);
      totalCases++;
      let bad = false;
      if (plan.perItem.length !== ref.length) bad = true;
      if (!bad) for (let i = 0; i < ref.length; i++) {
        if (ref[i].cardId !== plan.perItem[i].cardId) { bad = true; break; }
        const sa = [...ref[i].selectedIds].sort().join(','); const sb = [...plan.perItem[i].selectedIds].sort().join(',');
        if (sa !== sb) { bad = true; break; }
      }
      if (bad) {
        mismatches++;
        if (mismatches <= 2) {
          console.error(`❌ mismatch user=${userId} keepAtLeast=${keepAtLeast}`);
          console.error('items=', JSON.stringify(items));
          console.error('ref=', JSON.stringify(ref.map((r) => ({ c: r.cardId, n: r.selectedIds.length }))));
          console.error('plan=', JSON.stringify(plan.perItem.map((p) => ({ c: p.cardId, n: p.selectedIds.length }))));
        }
      }
    }
  }
  console.log(`用户数=${heavy.length} 用例=${totalCases} 分歧=${mismatches} 自由实例 affixSignature 为 null 的行数=${nullSigTotal}`);
  await prisma.$disconnect();
  process.exit(mismatches === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
