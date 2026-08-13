/** forum-consume 的跨队列公平波次与可审计等待上界。 */

export const FORUM_CONSUME_WAVE_PER_CLASS = 2;
export const FORUM_CONSUME_MAX_IN_FLIGHT = FORUM_CONSUME_WAVE_PER_CLASS * 2;

/** systemd: OnUnitInactiveSec=1min + AccuracySec=10s。 */
export const FORUM_CONSUME_TIMER_GAP_SEC = 70;

export interface ForumConsumeWaveQuotas {
  discussion: number;
  forum: number;
}

/** 标准轮必须容得下两类各两个首波名额；定向修复与 probe 不受此约束。 */
export function assertForumConsumeFairLimit(
  limit: number,
  targeted: boolean,
  probeOnly: boolean,
): void {
  if (!targeted && !probeOnly && limit < FORUM_CONSUME_MAX_IN_FLIGHT) {
    throw new RangeError(
      `--limit=${limit} 小于公平首波 ${FORUM_CONSUME_MAX_IN_FLIGHT}；`
      + '标准轮无法保证 discussion/forum 各两个名额',
    );
  }
}

/**
 * 标准轮每波同时给 discussion 与 forum 至多两个名额。
 * 只剩一个总名额时把它给 discussion；生产 --limit=50，因此正常会以 2+2 波次
 * 收敛，最后一波恰好 1+1。
 */
export function forumConsumeWaveQuotas(
  remaining: number,
  available: { discussion: boolean; forum: boolean } = {
    discussion: true,
    forum: true,
  },
): ForumConsumeWaveQuotas {
  const bounded = Math.max(0, Math.floor(remaining));
  if (bounded === 0 || (!available.discussion && !available.forum)) {
    return { discussion: 0, forum: 0 };
  }
  if (!available.discussion) {
    return { discussion: 0, forum: Math.min(FORUM_CONSUME_MAX_IN_FLIGHT, bounded) };
  }
  if (!available.forum) {
    return { discussion: Math.min(FORUM_CONSUME_MAX_IN_FLIGHT, bounded), forum: 0 };
  }
  if (bounded === 1) return { discussion: 1, forum: 0 };
  const each = Math.min(FORUM_CONSUME_WAVE_PER_CLASS, Math.floor(bounded / 2));
  return { discussion: each, forum: each };
}

/**
 * 同时启动一波两类任务，并分别保留已完成结果。
 * 一侧命中 RuntimeBudget 后，Promise.allSettled 仍会保住另一侧已经完成的结果，
 * 不再因为固定串行顺序把尾部整类任务原样释放。
 */
export async function runForumFairWave<D, F, DR, FR>(
  discussions: readonly D[],
  forums: readonly F[],
  runDiscussion: (task: D) => Promise<DR>,
  runForum: (task: F) => Promise<FR>,
): Promise<{
  discussion: PromiseSettledResult<DR>[];
  forum: PromiseSettledResult<FR>[];
}> {
  // 两组 Promise 都先构造再 await，避免任一类在另一类启动前独占墙钟预算。
  const discussionPromises = discussions.map((task) =>
    Promise.resolve().then(() => runDiscussion(task))
  );
  const forumPromises = forums.map((task) => Promise.resolve().then(() => runForum(task)));
  const [discussion, forum] = await Promise.all([
    Promise.allSettled(discussionPromises),
    Promise.allSettled(forumPromises),
  ]);
  return { discussion, forum };
}

/**
 * 从某任务前方同类 eligible 数量推导认领等待上界。
 *
 * discussion 每轮首波至少 2 个；forum 的 catchup/steady 各至少 1 个（认领 SQL
 * 对 lane 保留名额）。每轮最长 maxRuntimeSec，结束后 timer 最多再等 70 秒。
 * 该上界描述“获得执行尝试”的等待；远端永久失败仍由既有终态/退避语义处理。
 */
export function forumConsumeWaitUpperBoundMs(
  eligibleAhead: number,
  taskClass: 'discussion_lane' | 'forum_lane',
  maxRuntimeSec: number,
): number {
  if (!Number.isSafeInteger(eligibleAhead) || eligibleAhead < 0) {
    throw new RangeError(`同类队前任务数必须是非负安全整数，收到 ${String(eligibleAhead)}`);
  }
  if (!Number.isSafeInteger(maxRuntimeSec) || maxRuntimeSec < 1) {
    throw new RangeError(`单轮预算必须是正安全整数秒，收到 ${String(maxRuntimeSec)}`);
  }
  const ahead = eligibleAhead;
  // 两张队列表内都可能同时存在 catchup/steady；认领 SQL对每个 lane 首波保底1个。
  const guaranteedPerRound = 1;
  const rounds = Math.ceil((ahead + 1) / guaranteedPerRound);
  return rounds * (maxRuntimeSec + FORUM_CONSUME_TIMER_GAP_SEC) * 1_000;
}
