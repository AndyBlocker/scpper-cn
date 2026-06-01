/**
 * 批量分解（/dismantle/batch-selective）的纯选择规划器（#96）。
 *
 * 背景：原实现把 ≤500 个 item 的选择/删除全塞进一个 Serializable 长事务，每个 item 串行
 * 发起 ~8-9 次 DB 往返（2×count + findFreeInstances + findUnique + deleteCardInstances +
 * create log），共约 4000 次串行往返、持锁数十秒，高并发下串行化冲突重试风暴。
 *
 * 修复（方案 D，单原子事务）：把"选哪些实例、删多少、各自属哪个 affix 组"的决策抽成这个
 * 【纯函数】，在内存里【逐字复刻】原 for 循环的顺序语义（含重复 item、同 card 同 affix、
 * 混合"指定/不指定 affix"、obtainedAt 先后、按已删后的状态续算），然后由调用方一次性
 * deleteMany / createMany / count 同步 / 钱包结算。奖励仍由现有 computeDismantleRewardByAffix
 * 计算，故只要"选择"与旧逻辑一致，奖励/日志/汇总即逐字一致。
 *
 * 正确性由 scripts/verify-dismantle-planner.ts 的 golden 对比保证（随机快照下 planner 输出
 * 与"直接在原始实例列表上跑旧循环语义"的参考实现完全一致）。
 */

/** 自由实例快照行（已通过自由白名单：未交易/未求购/未锁/未放置/未展示）。 */
export interface DismantleSnapshotInstance {
  id: string;
  cardId: string;
  affixSignature: string;
  /** 仅用于稳定排序的占位；快照里 freeByCard 数组本身已按 obtainedAt 升序。 */
  obtainedAt?: number;
}

/** 单个待分解 item（affixSignature 必须已规范化，或为 undefined 表示整卡不限 affix）。 */
export interface DismantlePlanItem {
  cardId: string;
  affixSignature?: string;
  count: number;
}

export interface DismantleSnapshot {
  /** 留存护栏分母：排除交易/求购，但【包含】锁定/放置/展示的实例计数。cardId -> sig -> count。 */
  totalByCardSig: Map<string, Map<string, number>>;
  /** 同上按整卡聚合。cardId -> count。 */
  totalByCard: Map<string, number>;
  /** 同 totalBy* 口径再加 isLocked=true。 */
  lockedByCardSig: Map<string, Map<string, number>>;
  lockedByCard: Map<string, number>;
  /** 自由实例池，按 cardId 分组，每组已按 obtainedAt 升序（与 findFreeInstances 一致）。 */
  freeByCard: Map<string, DismantleSnapshotInstance[]>;
  /** 存在卡牌定义的 cardId 集合（缺定义的 item 跳过，且不消耗自由池——与原逻辑一致）。 */
  cardExists: Set<string>;
}

export interface DismantlePlanItemResult {
  cardId: string;
  dismantleCount: number;
  selectedIds: string[];
  /** sig -> 该 sig 被选中的数量，用于构造 computeDismantleRewardByAffix 的 consumed。 */
  consumeGroups: Map<string, number>;
}

export interface DismantlePlan {
  /** 仅含真正产生删除（dismantleCount>0）的 item，顺序与输入一致。 */
  perItem: DismantlePlanItemResult[];
  /** 所有被选中的实例 id（去重前的全集；各 item 互不重叠，因消耗即移除）。 */
  selectedIds: string[];
  /** cardId -> 本次删除总数，用于库存 count 同步。 */
  deletedCountByCard: Map<string, number>;
}

function cloneSigMap(src: Map<string, Map<string, number>>): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>();
  for (const [card, inner] of src) out.set(card, new Map(inner));
  return out;
}

/**
 * 纯选择规划：在内存里复刻原 for 循环（每 item 用"删除后的当前状态"重新评估留存护栏与自由池）。
 * 不做任何 IO，不改入参快照（内部克隆可变部分）。
 */
export function planBatchSelectiveDismantle(
  items: DismantlePlanItem[],
  keepAtLeast: number,
  snapshot: DismantleSnapshot
): DismantlePlan {
  // 克隆需要随删除递减的可变状态；lockedBy* 不变（锁定实例永不删除）。
  const totalByCard = new Map(snapshot.totalByCard);
  const totalByCardSig = cloneSigMap(snapshot.totalByCardSig);
  const freeByCard = new Map<string, DismantleSnapshotInstance[]>();
  for (const [card, list] of snapshot.freeByCard) freeByCard.set(card, list.slice());

  const perItem: DismantlePlanItemResult[] = [];
  const selectedIds: string[] = [];
  const deletedCountByCard = new Map<string, number>();

  for (const item of items) {
    const sig = item.affixSignature; // 已规范化或 undefined
    // 卡牌定义缺失：原逻辑 continue 且不调用 deleteCardInstances，故不消耗自由池。
    if (!snapshot.cardExists.has(item.cardId)) continue;

    const totalOwned = sig != null
      ? (totalByCardSig.get(item.cardId)?.get(sig) ?? 0)
      : (totalByCard.get(item.cardId) ?? 0);
    const lockedOwned = sig != null
      ? (snapshot.lockedByCardSig.get(item.cardId)?.get(sig) ?? 0)
      : (snapshot.lockedByCard.get(item.cardId) ?? 0);
    const minKeep = Math.max(lockedOwned, keepAtLeast);
    const maxDeletable = Math.max(0, totalOwned - minKeep);
    const targetDelete = Math.min(item.count, maxDeletable);
    if (targetDelete <= 0) continue;

    const pool = freeByCard.get(item.cardId);
    if (!pool || pool.length === 0) continue;

    // 池已按 obtainedAt 升序；指定 sig 时只取该 sig，否则跨 sig 取最早的；消耗即从池中移除，
    // 使后续 item 看到删除后的池（复刻原逐 item 重新 findFreeInstances 的行为）。
    const selected: DismantleSnapshotInstance[] = [];
    for (let i = 0; i < pool.length && selected.length < targetDelete; ) {
      const inst = pool[i];
      if (sig == null || inst.affixSignature === sig) {
        selected.push(inst);
        pool.splice(i, 1);
      } else {
        i++;
      }
    }
    const dismantleCount = selected.length;
    if (dismantleCount <= 0) continue;

    const consumeGroups = new Map<string, number>();
    for (const inst of selected) {
      consumeGroups.set(inst.affixSignature, (consumeGroups.get(inst.affixSignature) ?? 0) + 1);
    }

    // 递减留存分母：整卡 -dismantleCount；按实际消耗的 sig 分别递减 sig 维度。
    totalByCard.set(item.cardId, (totalByCard.get(item.cardId) ?? 0) - dismantleCount);
    const sigMap = totalByCardSig.get(item.cardId);
    if (sigMap) {
      for (const [s, c] of consumeGroups) sigMap.set(s, (sigMap.get(s) ?? 0) - c);
    }

    for (const inst of selected) selectedIds.push(inst.id);
    deletedCountByCard.set(item.cardId, (deletedCountByCard.get(item.cardId) ?? 0) + dismantleCount);
    perItem.push({ cardId: item.cardId, dismantleCount, selectedIds: selected.map((s) => s.id), consumeGroups });
  }

  return { perItem, selectedIds, deletedCountByCard };
}
