/**
 * L1 声明值与本地事实投影的对账判据。
 *
 * 这里刻意不使用 ±1 容差。Wikidot ListPages 与实时模块之间确有短暂的单票时差，
 * 但容差会把真正漏掉的一票永久藏起来；正确的消抖位置是“连续观测次数”。
 */

export type L1DriftTaskKind = 'votes_full' | 'revisions_full';

export interface LocalProjectionCounters {
  rating: number;
  voteCount: number;
  revisionCount: number;
}

export interface RemoteL1Counters {
  rating: number;
  voteCount: number;
  /** Wikidot %%revisions%% 的零基最大修订号。 */
  revisionClaim: number;
}

export interface ClassifiedL1Drift {
  kind: L1DriftTaskKind;
  reasons: string[];
  localValue: Record<string, number>;
  remoteValue: Record<string, number>;
  magnitude: number;
}

export const L1_DRIFT_MIN_CONSECUTIVE_OBSERVATIONS = 2;
export const L1_DRIFT_GATE_RATIO = 0.02;
export const L1_DRIFT_GATE_ABSOLUTE_LIMIT = 2_000;

export function classifyL1ProjectionDrift(
  local: LocalProjectionCounters,
  remote: RemoteL1Counters,
): ClassifiedL1Drift[] {
  const out: ClassifiedL1Drift[] = [];
  const voteReasons: string[] = [];
  if (local.rating !== remote.rating) {
    voteReasons.push('l1_projection_drift_rating');
  }
  if (local.voteCount !== remote.voteCount) {
    voteReasons.push('l1_projection_drift_vote_count');
  }
  if (voteReasons.length > 0) {
    out.push({
      kind: 'votes_full',
      reasons: ['l1_projection_drift_persistent', ...voteReasons],
      localValue: {
        rating: local.rating,
        vote_count: local.voteCount,
      },
      remoteValue: {
        rating: remote.rating,
        vote_count: remote.voteCount,
      },
      magnitude:
        Math.abs(local.rating - remote.rating) +
        Math.abs(local.voteCount - remote.voteCount),
    });
  }

  // page_current 是真实修订行数，包含 revision 0；L1 声明是零基最大修订号。
  const expectedRevisionCount = remote.revisionClaim + 1;
  if (local.revisionCount !== expectedRevisionCount) {
    out.push({
      kind: 'revisions_full',
      reasons: [
        'l1_projection_drift_persistent',
        'l1_projection_drift_revision_count',
      ],
      localValue: { revision_count: local.revisionCount },
      remoteValue: {
        revision_claim: remote.revisionClaim,
        expected_revision_count: expectedRevisionCount,
      },
      magnitude: Math.abs(local.revisionCount - expectedRevisionCount),
    });
  }
  return out;
}

export interface PreviousDriftObservation {
  consecutiveObservations: number;
  lastObservationRunId: number;
  resolved: boolean;
}

export interface AdvancedDriftObservation {
  consecutiveObservations: number;
  eligible: boolean;
}

/**
 * 只有紧邻的上一轮成功 L1 也记录了同类差额，streak 才递增。
 * 同一 run 的幂等重放不重复计数。
 */
export function advanceDriftObservation(
  previous: PreviousDriftObservation | null,
  currentRunId: number,
  expectedPreviousRunId: number | null,
): AdvancedDriftObservation {
  let consecutiveObservations = 1;
  if (previous !== null && previous.lastObservationRunId === currentRunId) {
    consecutiveObservations = previous.consecutiveObservations;
  } else if (
    previous !== null &&
    !previous.resolved &&
    expectedPreviousRunId !== null &&
    previous.lastObservationRunId === expectedPreviousRunId
  ) {
    consecutiveObservations = previous.consecutiveObservations + 1;
  }
  return {
    consecutiveObservations,
    eligible:
      consecutiveObservations >= L1_DRIFT_MIN_CONSECUTIVE_OBSERVATIONS,
  };
}

/**
 * irreconcilable 只终结“同一份远端声明下的稳定失败”。L1 声明本身变化后，
 * 旧终态证据已经过期，应允许重新进入常规队列；缺字段时保守地保持终态。
 */
export function irreconcilableRemoteEvidenceChanged(
  kind: L1DriftTaskKind,
  stored: Readonly<Record<string, unknown>>,
  current: Readonly<Record<string, number>>,
): boolean {
  if (kind === 'votes_full') {
    const storedRating = finiteNumber(stored['claimed_rating'] ?? stored['rating']);
    const storedVoteCount = finiteNumber(stored['claimed_total'] ?? stored['vote_count']);
    const currentRating = finiteNumber(current['rating']);
    const currentVoteCount = finiteNumber(current['vote_count']);
    if (
      storedRating === null ||
      storedVoteCount === null ||
      currentRating === null ||
      currentVoteCount === null
    ) {
      return false;
    }
    return storedRating !== currentRating || storedVoteCount !== currentVoteCount;
  }
  const storedRevision = finiteNumber(
    stored['claimed_total'] ?? stored['revision_claim'],
  );
  const currentRevision = finiteNumber(current['revision_claim']);
  return (
    storedRevision !== null &&
    currentRevision !== null &&
    storedRevision !== currentRevision
  );
}

export interface DriftGateCandidate {
  pageId: number;
}

export interface L1DriftFloodGate<T extends DriftGateCandidate> {
  triggered: boolean;
  limitPages: number;
  discoveredPages: number;
  eligiblePages: number;
  selectedPages: number;
  truncatedPages: number;
  selected: T[];
  message: string | null;
}

/**
 * “>2% 或 >2,000”取更先到达的那条边界。闸门按页面而不是任务计数：
 * 同一页同时需要 votes/revisions 时必须一起保留，不能制造半页修复。
 */
export function applyL1DriftFloodGate<T extends DriftGateCandidate>(
  candidates: readonly T[],
  population: number,
  discoveredPages: number,
): L1DriftFloodGate<T> {
  const ratioLimit = Math.max(1, Math.ceil(Math.max(0, population) * L1_DRIFT_GATE_RATIO));
  const limitPages = Math.min(L1_DRIFT_GATE_ABSOLUTE_LIMIT, ratioLimit);
  const triggered = discoveredPages > limitPages;
  const eligiblePageIds = [...new Set(candidates.map((candidate) => candidate.pageId))];
  const allowedPageIds = new Set(
    triggered ? eligiblePageIds.slice(0, limitPages) : eligiblePageIds,
  );
  const selected = candidates.filter((candidate) => allowedPageIds.has(candidate.pageId));
  const selectedPages = allowedPageIds.size;
  const truncatedPages = eligiblePageIds.length - selectedPages;
  const message = triggered
    ? `L1 对账总量闸门触发：发现 ${discoveredPages}/${population} 页不一致，` +
      `上限 ${limitPages} 页；本轮符合滞回 ${eligiblePageIds.length} 页，` +
      `入队 ${selectedPages} 页，明确截断 ${truncatedPages} 页`
    : null;
  return {
    triggered,
    limitPages,
    discoveredPages,
    eligiblePages: eligiblePageIds.length,
    selectedPages,
    truncatedPages,
    selected,
    message,
  };
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
