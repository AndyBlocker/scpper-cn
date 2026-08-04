/**
 * 修订数倒退是页级身份/采集异常，不等于批级失败。
 *
 * ListPages 不返回 wikidotId，所以第一轮只能先隔离该页并下 meta 身份确认任务。
 * 整轮是否升级为 failed 沿用 R9 的覆盖率判据：未确认页占比使有效覆盖率跌破
 * 0.98 才视为系统性故障；零星页不杀死整轮。
 */

export const REVISION_REGRESSION_MIN_COVERAGE = 0.98;

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
