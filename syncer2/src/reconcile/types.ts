/** M10 各子轨共用的最小结果形状。 */

/**
 * `inconclusive` 表示输入覆盖不完整，因而本轮没有形成可判定的对账结果。
 * 它与 `failed`（已完成测量且发现不合格）严格分离；`partial` 只保留给基线暖机、
 * 七日门和调用方明确要求的小样本等“结果有效但尚不能放行”的场景。
 */
export type ReconcileStatus = 'ok' | 'partial' | 'inconclusive' | 'failed' | 'aborted';

export interface ReconcileCounts {
  compared: number;
  differences: number;
  unexplained: number;
}

export interface ReconcileSection {
  status: Exclude<ReconcileStatus, 'aborted'>;
  counts: ReconcileCounts;
  alerts: string[];
}

/** 报告里的逐项差异只保存有界样本；全量由 counts 表达。 */
export const MAX_REPORT_SAMPLES = 100;

export function mergeStatus(statuses: readonly ReconcileStatus[]): ReconcileStatus {
  if (statuses.includes('aborted')) return 'aborted';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('inconclusive')) return 'inconclusive';
  if (statuses.includes('partial')) return 'partial';
  return 'ok';
}

/** 只有“测到了且不合格”或主动中止才是进程失败。 */
export function isReconcileFailure(status: ReconcileStatus): boolean {
  return status === 'failed' || status === 'aborted';
}

/**
 * 对账「自身是否故障」——决定退出码，与「是否发现分歧」区分开。
 *
 * `failed` 表示某一轨发现未解释分歧超阈，那是**对账的产出**而非对账坏了：
 * v1→v2 迁移期本就长期存在待归因差异，若让它常驻非零退出，
 * reconcile 单元会永远红着，告警随即失去指示作用（今天已经有几例同型教训）。
 * 工具级故障走 `aborted` 与调用方的 catch，两者仍然非零退出。
 *
 * 分歧本身不靠退出码通知，而是靠报表 + 「未解释占比相对上一轮显著恶化」的回归判据；
 * 后者才是真正的新消息。
 */
export function isReconcileToolFailure(status: ReconcileStatus): boolean {
  return status === 'aborted';
}

/**
 * 未解释占比是否相对基线显著恶化。
 *
 * 用占比而非绝对条数：对账覆盖面在各轮之间会变（195,489 → 376,082），
 * 绝对数增长可能只是比对得更多，据此告警属于拿不同口径相比。
 */
export function unexplainedRatioRegressed(
  current: ReconcileCounts,
  baseline: { compared: number; unexplained: number } | null,
  tolerancePoints: number,
): boolean {
  if (baseline === null) return false;
  if (current.compared <= 0 || baseline.compared <= 0) return false;
  if (!Number.isFinite(tolerancePoints) || tolerancePoints < 0) {
    throw new RangeError(`未解释占比容差必须为非负数，收到 ${String(tolerancePoints)}`);
  }
  const now = current.unexplained / current.compared;
  const before = baseline.unexplained / baseline.compared;
  return now - before > tolerancePoints;
}

function emptyCounts(): ReconcileCounts {
  return { compared: 0, differences: 0, unexplained: 0 };
}

export function sumCounts(sections: readonly ReconcileSection[]): ReconcileCounts {
  return sections.reduce(
    (sum, section) => ({
      compared: sum.compared + section.counts.compared,
      differences: sum.differences + section.counts.differences,
      unexplained: sum.unexplained + section.counts.unexplained,
    }),
    emptyCounts(),
  );
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
