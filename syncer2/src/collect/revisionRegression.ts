/**
 * 修订数倒退是页级身份/采集异常，不等于批级失败。
 *
 * ListPages 不返回 wikidotId，所以第一轮只能先隔离该页并下 meta 身份确认任务。
 * 整轮是否升级为 failed 沿用 R9 的覆盖率判据：未确认页占比使有效覆盖率跌破
 * 0.98 才视为系统性故障；零星页不杀死整轮。
 */

export const REVISION_REGRESSION_MIN_COVERAGE = 0.98;
/** L1 每 5 分钟、work-queue 至少每小时有一次可推导机会；超过一小时必须离开 pending。 */
export const REVISION_REGRESSION_PENDING_TIMEOUT_MS = 60 * 60_000;

export type RevisionRegressionPendingDisposition =
  | 'pending'
  | 'slug_reused'
  | 'deleted'
  | 'manual_review';

export interface RevisionRegressionPendingEvidence {
  expectedWikidotId: number;
  currentPageStatus: 'live' | 'deleted' | null;
  liveSlugWikidotIds: readonly number[];
  observedRevision: number;
  firstSeenAt: string;
  now: string;
}

/**
 * 本地生命周期证据优先于时钟：同 slug 已有另一 live 身份就是复用；旧身份已删且无
 * 后继就是删除终态。revision=0 本身不等于删除，必须与生命周期证据合取。其余异常
 * 一小时仍无远端身份结论时显式升级，而不是继续 pending 自旋。
 */
export function classifyRevisionRegressionPending(
  evidence: RevisionRegressionPendingEvidence,
): RevisionRegressionPendingDisposition {
  if (!Number.isInteger(evidence.expectedWikidotId) || evidence.expectedWikidotId <= 0) {
    throw new RangeError(`expectedWikidotId 必须是正整数，收到 ${evidence.expectedWikidotId}`);
  }
  if (!Number.isInteger(evidence.observedRevision) || evidence.observedRevision < 0) {
    throw new RangeError(`observedRevision 必须是非负整数，收到 ${evidence.observedRevision}`);
  }
  if (evidence.liveSlugWikidotIds.some((id) => id !== evidence.expectedWikidotId)) {
    return 'slug_reused';
  }
  if (evidence.currentPageStatus === 'deleted') return 'deleted';
  const firstSeenMs = Date.parse(evidence.firstSeenAt);
  const nowMs = Date.parse(evidence.now);
  if (!Number.isFinite(firstSeenMs) || !Number.isFinite(nowMs)) {
    throw new TypeError(
      `非法 regression 时间 first=${evidence.firstSeenAt};now=${evidence.now}`,
    );
  }
  return nowMs - firstSeenMs >= REVISION_REGRESSION_PENDING_TIMEOUT_MS
    ? 'manual_review'
    : 'pending';
}

/** 页级隔离边界：只拿掉异常 slug，其它页继续推进全站水位与 drift streak。 */
export function excludeRevisionRegressionRows<T>(
  rows: readonly T[],
  regressionSlugs: ReadonlySet<string>,
  slugOf: (row: T) => string,
): T[] {
  return rows.filter((row) => !regressionSlugs.has(slugOf(row)));
}

export interface RevisionRegressionHealth {
  regressions: number;
  population: number;
  anomalyRatio: number;
  effectiveCoverage: number;
  minCoverage: number;
  systemic: boolean;
}

export type RevisionRegressionIdentityDecision =
  | 'same_identity_anomaly'
  | 'slug_reuse';

export function decideRevisionRegressionIdentity(
  expectedWikidotId: number,
  observedWikidotId: number,
): RevisionRegressionIdentityDecision {
  if (
    !Number.isInteger(expectedWikidotId) ||
    expectedWikidotId <= 0 ||
    !Number.isInteger(observedWikidotId) ||
    observedWikidotId <= 0
  ) {
    throw new RangeError(
      `wikidotId 必须是正整数，收到 expected=${expectedWikidotId}, observed=${observedWikidotId}`,
    );
  }
  return expectedWikidotId === observedWikidotId
    ? 'same_identity_anomaly'
    : 'slug_reuse';
}

export function evaluateRevisionRegressionHealth(args: {
  regressions: number;
  pagesEnumerated: number;
  knownPopulation?: number;
  minCoverage?: number;
}): RevisionRegressionHealth {
  const regressions = nonNegativeInteger(args.regressions, 'regressions');
  const pagesEnumerated = nonNegativeInteger(args.pagesEnumerated, 'pagesEnumerated');
  const knownPopulation = nonNegativeInteger(args.knownPopulation ?? 0, 'knownPopulation');
  const minCoverage = args.minCoverage ?? REVISION_REGRESSION_MIN_COVERAGE;
  if (!Number.isFinite(minCoverage) || minCoverage <= 0 || minCoverage > 1) {
    throw new RangeError(`minCoverage 必须在 (0,1]，收到 ${minCoverage}`);
  }

  // L0 只枚举 updated_at 窗口，不能用窗口内 1 页作全站异常率分母；
  // 已建立的 L1 全站基线才是它的已知人口。L1 自身枚举量通常更大，取 max 兼容冷启动。
  const population = Math.max(pagesEnumerated, knownPopulation, regressions);
  if (population === 0) {
    return {
      regressions: 0,
      population: 0,
      anomalyRatio: 0,
      effectiveCoverage: 1,
      minCoverage,
      systemic: false,
    };
  }

  const anomalyRatio = regressions / population;
  const effectiveCoverage = 1 - anomalyRatio;
  return {
    regressions,
    population,
    anomalyRatio,
    effectiveCoverage,
    minCoverage,
    // “超过阈值”才升级；恰好 2%（coverage=0.98）仍满足 R9。
    systemic: effectiveCoverage < minCoverage,
  };
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${label} 必须是非负整数，收到 ${value}`);
  }
  return value;
}
