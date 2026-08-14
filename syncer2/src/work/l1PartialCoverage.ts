import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

import type { L1ListPageRow } from '../collect/incrementalListPages.js';
import {
  insertIncrementalSignals,
  loadIncrementalPageStates,
  type IncrementalPageState,
} from '../store/incremental.js';
import {
  loadL1VoteObservationStates,
  upsertL1VoteObservationStates,
  type L1VoteObservationState,
} from '../store/l1PartialVotes.js';
import {
  enqueueScanTasks,
  insertPageScans,
  resolveSlugs,
  type ScanTaskRow,
} from '../store/meta.js';
import { upsertPendingPages } from '../store/queues.js';

export const L1_PARTIAL_VOTE_CHANGE_PRIORITY = 200;

export interface L1PartialVoteChange {
  current: L1ListPageRow;
  previous: L1VoteObservationState | null;
}

export interface L1PartialCoverageSelection {
  changes: L1PartialVoteChange[];
  unchanged: number;
  revisionRegressionsSkipped: string[];
  safeRows: L1ListPageRow[];
}

export interface L1PartialCoveragePersistResult {
  resolved: number;
  unresolved: number;
  pendingEnqueued: number;
  tasksEnqueued: number;
  pageScansWritten: number;
  signalsWritten: number;
  voteStatesAdvanced: number;
  voteChanges: number;
  unchanged: number;
  revisionRegressionsSkipped: number;
  absenceInference: 'forbidden_partial_positive_only';
  fullCoverageStateAdvanced: false;
  revisionCoverageRecorded: false;
  driftReconciliationPerformed: false;
}

/**
 * 部分轮只比较投票聚合值。修订倒退意味着 slug 身份可能复用，整页跳过；其它行即使来自
 * 非连续批次，也都是 Wikidot 明确返回的正向观测，可以安全入队，不能反推任何缺席页。
 */
export function selectL1PartialVoteChanges(
  rows: readonly L1ListPageRow[],
  voteStates: ReadonlyMap<string, L1VoteObservationState>,
  fullStates: ReadonlyMap<string, IncrementalPageState>,
): L1PartialCoverageSelection {
  const changes: L1PartialVoteChange[] = [];
  const safeRows: L1ListPageRow[] = [];
  const revisionRegressionsSkipped: string[] = [];
  let unchanged = 0;
  for (const current of rows) {
    const full = fullStates.get(current.fullname);
    if (full?.lastL1Revision !== null && full?.lastL1Revision !== undefined
        && current.revisions < full.lastL1Revision) {
      revisionRegressionsSkipped.push(current.fullname);
      continue;
    }
    safeRows.push(current);
    const previous = voteStates.get(current.fullname) ?? null;
    if (
      previous === null
      || current.rating !== previous.rating
      || current.ratingVotes !== previous.ratingVotes
    ) {
      changes.push({ current, previous });
    } else {
      unchanged++;
    }
  }
  return { changes, unchanged, revisionRegressionsSkipped, safeRows };
}

export async function persistL1PartialCoverage(
  pool: Pool,
  runId: number,
  rows: readonly L1ListPageRow[],
  observedAt: string,
): Promise<L1PartialCoveragePersistResult> {
  const slugs = rows.map((row) => row.fullname);
  const [voteStates, fullStates, resolution] = await Promise.all([
    loadL1VoteObservationStates(pool, slugs),
    loadIncrementalPageStates(pool, slugs),
    resolveSlugs(pool, slugs),
  ]);
  const selected = selectL1PartialVoteChanges(rows, voteStates, fullStates);
  const resolvedRows = selected.safeRows
    .filter((row) => resolution.map.has(row.fullname))
    .map((row) => ({ row, pageId: resolution.map.get(row.fullname)! }));
  const unresolvedRows = selected.safeRows.filter((row) => !resolution.map.has(row.fullname));
  const changedSlugs = new Set(selected.changes.map(({ current }) => current.fullname));
  const changedResolved = resolvedRows.filter(({ row }) => changedSlugs.has(row.fullname));

  const tasks: ScanTaskRow[] = changedResolved.map(({ pageId }) => ({
    pageId,
    kind: 'votes_full',
    reasons: ['l1_partial_rating_or_rating_votes_changed'],
    priority: L1_PARTIAL_VOTE_CHANGE_PRIORITY,
  }));
  const pending = await upsertPendingPages(
    pool,
    unresolvedRows.map((row) => ({
      slug: row.fullname,
      reasons: ['l1_partial_positive_unresolved'],
      priority: 30,
      discoveredBy: 'wikidot_listpages',
    })),
    observedAt,
  );
  const tasksEnqueued = await enqueueScanTasks(pool, tasks);
  const pageScansWritten = await insertPageScans(
    pool,
    runId,
    changedResolved.map(({ row, pageId }) => ({
      pageId,
      kind: 'meta' as const,
      status: 'partial' as const,
      claimedTotal: row.ratingVotes,
      checksumExpected: row.rating,
      resultHash: observationHash(row),
      error: 'l1_partial_positive_observation:absence_forbidden',
    })),
    observedAt,
  );
  const changeBySlug = new Map(selected.changes.map((change) => [change.current.fullname, change]));
  const signalsWritten = await insertIncrementalSignals(
    pool,
    runId,
    selected.changes.map(({ current, previous }) => ({
      layer: 'L1' as const,
      slug: current.fullname,
      pageId: resolution.map.get(current.fullname) ?? null,
      signal: 'vote_changed',
      detectedAt: observedAt,
      details: {
        previous_rating: previous?.rating ?? null,
        current_rating: current.rating,
        previous_rating_votes: previous?.ratingVotes ?? null,
        current_rating_votes: current.ratingVotes,
        coverage_scope: 'partial_positive_only',
        absence_inference: 'forbidden',
      },
    })),
  );

  // 所有派生产物成功后才推进独立投票水位；失败时下一轮会重报，而不是静默丢信号。
  const voteStatesAdvanced = await upsertL1VoteObservationStates(
    pool,
    runId,
    selected.safeRows.map((row) => ({
      row,
      pageId: resolution.map.get(row.fullname) ?? null,
    })),
    observedAt,
    'partial',
  );

  return {
    resolved: resolvedRows.length,
    unresolved: unresolvedRows.length,
    pendingEnqueued: pending.affected,
    tasksEnqueued,
    pageScansWritten,
    signalsWritten,
    voteStatesAdvanced,
    voteChanges: changeBySlug.size,
    unchanged: selected.unchanged,
    revisionRegressionsSkipped: selected.revisionRegressionsSkipped.length,
    absenceInference: 'forbidden_partial_positive_only',
    fullCoverageStateAdvanced: false,
    revisionCoverageRecorded: false,
    driftReconciliationPerformed: false,
  };
}

function observationHash(row: L1ListPageRow): Buffer {
  return createHash('sha256').update(JSON.stringify(row), 'utf8').digest();
}
