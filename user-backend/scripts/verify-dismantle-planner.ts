/**
 * Golden 对比验证（#96）：证明 planBatchSelectiveDismantle（基于快照的纯规划器）与
 * "直接在原始实例列表上逐字跑旧 /dismantle/batch-selective 循环语义"的参考实现，在大量
 * 随机输入下【选中的实例完全一致】。选择一致 ⇒ 奖励/日志/汇总一致（均为选择的确定性函数）。
 *
 * 运行：cd user-backend && npx tsx scripts/verify-dismantle-planner.ts
 * 退出码 0 = 全部通过；非 0 = 发现分歧（打印首个反例）。
 */
import {
  planBatchSelectiveDismantle,
  type DismantleSnapshot,
  type DismantleSnapshotInstance,
  type DismantlePlanItem
} from '../src/routes/gacha/_dismantlePlanner.js';

// ─── 确定性伪随机（可复现反例）────────────────────────────────
let seed = 0x1234abcd;
function rnd(): number {
  // xorshift32
  seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
  return ((seed >>> 0) % 1_000_000) / 1_000_000;
}
function randint(lo: number, hi: number): number { return lo + Math.floor(rnd() * (hi - lo + 1)); }
function pick<T>(arr: T[]): T { return arr[randint(0, arr.length - 1)]; }

// ─── 原始实例模型（含全部影响"自由/留存"判定的字段）──────────────
interface RawInstance {
  id: string;
  cardId: string;
  affixSignature: string;
  obtainedAt: number;       // 唯一，避免并列排序歧义
  isLocked: boolean;
  placed: boolean;          // placementSlot 是否存在
  showcased: boolean;       // showcaseSlot 是否存在
  traded: boolean;          // tradeListingId 非空
  buyReq: boolean;          // buyRequestId 非空
}

const SIGS = ['NONE', 'PRISM', 'COLORLESS', 'FOIL'];
const CARDS = ['c1', 'c2', 'c3', 'c4'];

function genInstances(obtainedSeq: { v: number }): RawInstance[] {
  const n = randint(0, 40);
  const out: RawInstance[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      id: `i${out.length}_${randint(0, 99999)}`,
      cardId: pick(CARDS),
      affixSignature: pick(SIGS),
      obtainedAt: obtainedSeq.v++,
      isLocked: rnd() < 0.2,
      placed: rnd() < 0.15,
      showcased: rnd() < 0.1,
      traded: rnd() < 0.1,
      buyReq: rnd() < 0.1
    });
  }
  // 打乱 id 唯一性
  return out;
}

function genItems(): DismantlePlanItem[] {
  const n = randint(1, 8);
  const out: DismantlePlanItem[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      cardId: pick(CARDS),
      affixSignature: rnd() < 0.5 ? pick(SIGS) : undefined,
      count: randint(1, 6)
    });
  }
  return out;
}

// ─── 参考实现：逐字复刻旧端点循环（直接在 live 列表上 count/findFree/delete）──────
function referenceSelect(
  instances: RawInstance[],
  items: DismantlePlanItem[],
  keepAtLeast: number,
  cardExists: Set<string>
): Array<{ cardId: string; selectedIds: string[] }> {
  const live = new Set(instances.map((x) => x.id));
  const byId = new Map(instances.map((x) => [x.id, x]));
  const result: Array<{ cardId: string; selectedIds: string[] }> = [];

  const matchInstanceWhere = (x: RawInstance, cardId: string, sig?: string) =>
    live.has(x.id) && x.cardId === cardId && !x.traded && !x.buyReq &&
    (sig == null || x.affixSignature === sig);

  for (const item of items) {
    const sig = item.affixSignature;
    const owned = instances.filter((x) => matchInstanceWhere(x, item.cardId, sig));
    const totalOwned = owned.length;
    const lockedOwned = owned.filter((x) => x.isLocked).length;
    const minKeep = Math.max(lockedOwned, keepAtLeast);
    const maxDeletable = Math.max(0, totalOwned - minKeep);
    const targetDelete = Math.min(item.count, maxDeletable);
    if (targetDelete <= 0) continue;

    // findFreeInstances: 自由白名单 + orderBy obtainedAt asc + take targetDelete
    const free = instances
      .filter((x) => matchInstanceWhere(x, item.cardId, sig) && !x.isLocked && !x.placed && !x.showcased)
      .sort((a, b) => a.obtainedAt - b.obtainedAt)
      .slice(0, targetDelete);
    const dismantleCount = Math.min(free.length, targetDelete);
    if (dismantleCount <= 0) continue;
    const toDelete = free.slice(0, dismantleCount);

    if (!cardExists.has(item.cardId)) continue; // 缺定义：不删、不记录

    for (const x of toDelete) live.delete(x.id);
    result.push({ cardId: item.cardId, selectedIds: toDelete.map((x) => x.id) });
  }
  // 防御：byId 仅为对称占位，避免未用告警
  void byId;
  return result;
}

// ─── 由原始列表构造 planner 快照（镜像端点的 groupBy/findMany 查询语义）────────
function buildSnapshot(instances: RawInstance[], cardExists: Set<string>): DismantleSnapshot {
  const totalByCard = new Map<string, number>();
  const totalByCardSig = new Map<string, Map<string, number>>();
  const lockedByCard = new Map<string, number>();
  const lockedByCardSig = new Map<string, Map<string, number>>();
  const freeByCard = new Map<string, DismantleSnapshotInstance[]>();

  const bump = (m: Map<string, number>, k: string, d = 1) => m.set(k, (m.get(k) ?? 0) + d);
  const bump2 = (m: Map<string, Map<string, number>>, c: string, s: string, d = 1) => {
    let inner = m.get(c); if (!inner) { inner = new Map(); m.set(c, inner); }
    inner.set(s, (inner.get(s) ?? 0) + d);
  };

  for (const x of instances) {
    // 留存口径：排除交易/求购，包含锁定/放置/展示
    if (x.traded || x.buyReq) continue;
    bump(totalByCard, x.cardId);
    bump2(totalByCardSig, x.cardId, x.affixSignature);
    if (x.isLocked) { bump(lockedByCard, x.cardId); bump2(lockedByCardSig, x.cardId, x.affixSignature); }
  }
  // 自由池：完整白名单 + obtainedAt 升序
  const freeSorted = instances
    .filter((x) => !x.traded && !x.buyReq && !x.isLocked && !x.placed && !x.showcased)
    .sort((a, b) => a.obtainedAt - b.obtainedAt);
  for (const x of freeSorted) {
    let list = freeByCard.get(x.cardId); if (!list) { list = []; freeByCard.set(x.cardId, list); }
    list.push({ id: x.id, cardId: x.cardId, affixSignature: x.affixSignature, obtainedAt: x.obtainedAt });
  }

  return { totalByCard, totalByCardSig, lockedByCard, lockedByCardSig, freeByCard, cardExists };
}

// ─── 主循环 ────────────────────────────────────────────────
const ITERATIONS = 20000;
let failures = 0;
const obtainedSeq = { v: 1 };

for (let iter = 0; iter < ITERATIONS; iter++) {
  const instances = genInstances(obtainedSeq);
  const items = genItems();
  const keepAtLeast = randint(0, 4);
  // 随机让某些 card 缺定义（测试 skip 路径）
  const cardExists = new Set(CARDS.filter(() => rnd() < 0.85));

  const ref = referenceSelect(instances, items, keepAtLeast, cardExists);
  const plan = planBatchSelectiveDismantle(items, keepAtLeast, buildSnapshot(instances, cardExists));

  // 对齐比较：planner.perItem（仅 dismantleCount>0）应与 ref 的 (cardId, selectedIds) 序列逐项一致
  let mismatch = false;
  if (plan.perItem.length !== ref.length) mismatch = true;
  if (!mismatch) {
    for (let k = 0; k < ref.length; k++) {
      const a = ref[k];
      const b = plan.perItem[k];
      if (a.cardId !== b.cardId) { mismatch = true; break; }
      // 选中 id 集合必须完全一致（顺序无关，因均来自同一最早集合）
      const sa = [...a.selectedIds].sort().join(',');
      const sb = [...b.selectedIds].sort().join(',');
      if (sa !== sb) { mismatch = true; break; }
    }
  }

  if (mismatch) {
    failures++;
    if (failures === 1) {
      console.error('❌ 发现首个反例:');
      console.error('keepAtLeast=', keepAtLeast, ' cardExists=', [...cardExists]);
      console.error('items=', JSON.stringify(items));
      console.error('instances=', JSON.stringify(instances));
      console.error('reference=', JSON.stringify(ref));
      console.error('planner.perItem=', JSON.stringify(plan.perItem.map((p) => ({ cardId: p.cardId, selectedIds: p.selectedIds }))));
    }
  }
}

if (failures === 0) {
  console.log(`✓ planner 与参考实现在 ${ITERATIONS} 个随机用例下完全一致（选中实例逐项相同）。`);
  process.exit(0);
} else {
  console.error(`✗ ${failures}/${ITERATIONS} 个用例分歧。`);
  process.exit(1);
}
