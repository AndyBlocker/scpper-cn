/** M10 报告聚合、持久化与 qqbot 单行摘要。 */

import type { Pool } from 'pg';
import { query, toPgTimestamptz } from '../store/db.js';
import { toPgJson } from '../store/pgText.js';
import type { CromCanaryReport } from './crom.js';
import type { ParityReport } from './parity.js';
import type { ActiveTriangleReport, EnumerationTriangleReport } from './triangle.js';
import {
  isReconcileFailure,
  mergeStatus,
  sumCounts,
  type ReconcileCounts,
  type ReconcileSection,
  type ReconcileStatus,
} from './types.js';

export type ReconcileMode = 'all' | 'parity' | 'crom' | 'triangle';

export interface TriangleReport extends ReconcileSection {
  enumeration: EnumerationTriangleReport;
  active: ActiveTriangleReport;
  source: 'snapshots' | 'live_listpages_sample';
}

export interface FullReconcileReport {
  version: 1;
  mode: ReconcileMode;
  observedAt: string;
  finishedAt: string;
  lagWindowSeconds: number;
  status: ReconcileStatus;
  counts: ReconcileCounts;
  alerts: string[];
  parity?: ParityReport;
  crom?: CromCanaryReport;
  triangle?: TriangleReport;
  http: {
    wikidot?: Record<string, unknown>;
    crom?: Record<string, unknown>;
  };
}

export interface QqReconcileSummary {
  type: 'scpper-parity';
  version: 1;
  at: string;
  mode: ReconcileMode;
  ok: boolean;
  status: ReconcileStatus;
  compared: number;
  differences: number;
  unexplained: number;
  parity?: {
    stateDiffRate: number;
    unexplainedPages: number;
    streakDays: number;
    sevenDayGatePassed: boolean;
    whitelistGrowth: number;
    frozenChanged: boolean;
  };
  crom?: {
    full: boolean;
    cromPages: number;
    v2Pages: number;
    existenceDiffs: number | null;
    fieldDiffs: number | null;
  };
  triangle?: {
    enumUnexplained: number | null;
    votes: string;
    revisions: string;
  };
  alerts: string[];
}

export function assembleReport(args: {
  mode: ReconcileMode;
  observedAt: string;
  finishedAt: string;
  lagWindowSeconds: number;
  parity?: ParityReport;
  crom?: CromCanaryReport;
  triangle?: TriangleReport;
  http?: FullReconcileReport['http'];
}): FullReconcileReport {
  const sections: ReconcileSection[] = [];
  if (args.parity) sections.push(args.parity);
  if (args.crom) sections.push(args.crom);
  if (args.triangle) sections.push(args.triangle);
  const status = sections.length === 0 ? 'failed' : mergeStatus(sections.map((section) => section.status));
  const alerts =
    sections.length === 0
      ? ['没有执行任何对账子轨']
      : sections.flatMap((section) => section.alerts);
  return {
    version: 1,
    mode: args.mode,
    observedAt: args.observedAt,
    finishedAt: args.finishedAt,
    lagWindowSeconds: args.lagWindowSeconds,
    status,
    counts: sumCounts(sections),
    alerts,
    ...(args.parity ? { parity: args.parity } : {}),
    ...(args.crom ? { crom: args.crom } : {}),
    ...(args.triangle ? { triangle: args.triangle } : {}),
    http: args.http ?? {},
  };
}

export function assembleTriangleReport(
  enumeration: EnumerationTriangleReport,
  active: ActiveTriangleReport,
  source: TriangleReport['source'],
): TriangleReport {
  const status = mergeStatus([enumeration.status, active.status]);
  return {
    status: status === 'aborted' ? 'failed' : status,
    counts: sumCounts([enumeration, active]),
    alerts: [...enumeration.alerts, ...active.alerts],
    enumeration,
    active,
    source,
  };
}

export function buildQqSummary(report: FullReconcileReport): QqReconcileSummary {
  const qq: QqReconcileSummary = {
    type: 'scpper-parity',
    version: 1,
    at: report.finishedAt,
    mode: report.mode,
    ok: !isReconcileFailure(report.status),
    status: report.status,
    compared: report.counts.compared,
    differences: report.counts.differences,
    unexplained: report.counts.unexplained,
    alerts: report.alerts.slice(0, 6),
  };
  if (report.parity) {
    qq.parity = {
      stateDiffRate: report.parity.stateAlignment.diffRate,
      unexplainedPages: report.parity.stateAlignment.unexplainedPages,
      streakDays: report.parity.qualifiedDailyStreak,
      sevenDayGatePassed: report.parity.sevenDayGatePassed,
      whitelistGrowth: Object.keys(report.parity.whitelist.growth).length,
      frozenChanged: report.parity.freeze.changed,
    };
  }
  if (report.crom) {
    qq.crom = {
      full: report.crom.isFull,
      cromPages: report.crom.cromPages,
      v2Pages: report.crom.v2Pages,
      existenceDiffs: report.crom.differenceCountsAvailable
        ? (report.crom.cromOnly ?? 0) + (report.crom.v2Only ?? 0)
        : null,
      fieldDiffs: report.crom.differenceCountsAvailable
        ? Object.values(report.crom.fields).reduce(
            (sum, field) => sum + (field.actionableMismatches ?? 0),
            0,
          )
        : null,
    };
  }
  if (report.triangle) {
    qq.triangle = {
      enumUnexplained: report.triangle.enumeration.differenceCountsAvailable
        ? report.triangle.enumeration.counts.unexplained
        : null,
      votes: `${report.triangle.active.voteMatches}/${report.triangle.active.requestedPages}`,
      revisions: `${report.triangle.active.revisionMatches}/${report.triangle.active.requestedPages}`,
    };
  }
  return qq;
}

export async function persistReconcileReport(
  pool: Pool,
  runId: number | null,
  report: FullReconcileReport,
  qqSummary: QqReconcileSummary,
): Promise<number> {
  const res = await query<{ id: string }>(
    pool,
    'reconcile:report:insert',
    `INSERT INTO meta.reconcile_report
       (run_id, mode, status, observed_at, finished_at, lag_window_seconds,
        compared_count, difference_count, unexplained_count, report, qq_summary)
     VALUES
       ($1::bigint, $2::text, $3::text, $4::timestamptz, $5::timestamptz, $6::int,
        $7::int, $8::int, $9::int, $10::jsonb, $11::jsonb)
     RETURNING id`,
    [
      runId,
      report.mode,
      report.status,
      toPgTimestamptz(report.observedAt),
      toPgTimestamptz(report.finishedAt),
      report.lagWindowSeconds,
      report.counts.compared,
      report.counts.differences,
      report.counts.unexplained,
      toPgJson(report, 'reconcile.report'),
      toPgJson(qqSummary, 'reconcile.qq_summary'),
    ],
  );
  const id = res.rows[0]?.id;
  if (id === undefined) throw new Error('meta.reconcile_report INSERT 未返回 id');
  return Number(id);
}
