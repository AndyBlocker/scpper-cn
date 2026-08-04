import type { Pool } from 'pg';

import {
  advanceDriftObservation,
  applyL1DriftFloodGate,
  classifyL1ProjectionDrift,
  irreconcilableRemoteEvidenceChanged,
  type L1DriftFloodGate,
  type L1DriftTaskKind,
} from '../collect/l1Drift.js';
import type { L1ListPageRow } from '../collect/incrementalListPages.js';
import { chunk } from '../util/concurrency.js';
import { query, toPgTimestamptz } from './db.js';
import type { ScanTaskRow } from './meta.js';
import { toPgJson } from './pgText.js';

interface ProjectionRow {
  page_id: number;
  slug: string;
  rating: number;
  vote_count: number;
  revision_count: number;
  live_slug_count: string | number;
  live_page_ids: number[];
}

interface StoredDriftRow {
  page_id: number;
  kind: L1DriftTaskKind;
  consecutive_observations: number;
  last_observation_run_id: string | number;
  resolved_at: Date | string | null;
}

interface OpenIrreconcilableRow {
  page_id: number;
  kind: L1DriftTaskKind;
  remote_value: Record<string, unknown>;
}

export interface L1DriftObservationInput {
  row: L1ListPageRow;
  pageId: number;
  previousL1RunId: number | null;
}

export interface L1DriftIdentityConflict {
  slug: string;
  resolvedPageId: number;
  livePageIds: number[];
}

export interface L1DriftSummary {
  population: number;
  aligned: number;
  identityConflicts: number;
  discoveredPages: number;
  voteMismatches: number;
  revisionMismatches: number;
  persistentPages: number;
  terminalReopenedTasks: number;
  terminalSuppressedTasks: number;
  statesWritten: number;
  statesResolved: number;
  gate: Omit<L1DriftFloodGate<ScanTaskRow>, 'selected'>;
}

export interface L1DriftReconciliation {
  tasks: ScanTaskRow[];
  identityConflicts: L1DriftIdentityConflict[];
  summary: L1DriftSummary;
}

interface CurrentDrift {
  pageId: number;
  slug: string;
  kind: L1DriftTaskKind;
  reasons: string[];
  localValue: Record<string, number>;
  remoteValue: Record<string, number>;
  magnitude: number;
  previousL1RunId: number | null;
  consecutiveObservations: number;
  eligible: boolean;
}

interface ChangedTerminalDrift extends CurrentDrift {
  terminalRemoteValue: Record<string, unknown>;
}

/**
 * 完整 L1 已经支付了 145 个 ListPages 请求；本函数只读本地投影并写对账证据，
 * 不产生任何额外 wikidot 请求。
 */
export async function observeL1ProjectionDrift(
  pool: Pool,
  runId: number,
  observations: readonly L1DriftObservationInput[],
  observedAt: string,
): Promise<L1DriftReconciliation> {
  const projection = await loadLiveProjection(pool);
  const byPageId = new Map(projection.map((row) => [Number(row.page_id), row]));
  const identityConflicts: L1DriftIdentityConflict[] = [];
  const aligned: L1DriftObservationInput[] = [];
  const classified: Array<Omit<CurrentDrift, 'consecutiveObservations' | 'eligible'>> = [];

  for (const observation of observations) {
    const local = byPageId.get(observation.pageId);
    if (local === undefined || local.slug !== observation.row.fullname) continue;
    if (Number(local.live_slug_count) !== 1) {
      identityConflicts.push({
        slug: observation.row.fullname,
        resolvedPageId: observation.pageId,
        livePageIds: local.live_page_ids.map(Number),
      });
      continue;
    }
    aligned.push(observation);
    for (const drift of classifyL1ProjectionDrift(
      {
        rating: Number(local.rating),
        voteCount: Number(local.vote_count),
        revisionCount: Number(local.revision_count),
      },
      {
        rating: observation.row.rating,
        voteCount: observation.row.ratingVotes,
        revisionClaim: observation.row.revisions,
      },
    )) {
      classified.push({
        pageId: observation.pageId,
        slug: observation.row.fullname,
        ...drift,
        previousL1RunId: observation.previousL1RunId,
      });
    }
  }

  const previous = await loadStoredDrift(
    pool,
    [...new Set(classified.map((row) => row.pageId))],
  );
  const current: CurrentDrift[] = classified.map((drift) => {
    const key = driftKey(drift.pageId, drift.kind);
    const stored = previous.get(key);
    const advanced = advanceDriftObservation(
      stored === undefined
        ? null
        : {
            consecutiveObservations: Number(stored.consecutive_observations),
            lastObservationRunId: Number(stored.last_observation_run_id),
            resolved: stored.resolved_at !== null,
          },
      runId,
      drift.previousL1RunId,
    );
    return { ...drift, ...advanced };
  });

  const terminalBeforeReopen = await loadOpenIrreconcilable(
    pool,
    [...new Set(current.map((row) => row.pageId))],
  );
  const changedTerminal = current.flatMap((row): ChangedTerminalDrift[] => {
    const terminal = terminalBeforeReopen.get(driftKey(row.pageId, row.kind));
    return terminal !== undefined &&
      irreconcilableRemoteEvidenceChanged(
        row.kind,
        terminal.remote_value,
        row.remoteValue,
      )
      ? [{ ...row, terminalRemoteValue: terminal.remote_value }]
      : [];
  });
  const terminalReopenedTasks = await reopenChangedIrreconcilable(
    pool,
    changedTerminal,
    observedAt,
  );
  const openTerminal = await loadOpenIrreconcilable(
    pool,
    [...new Set(current.map((row) => row.pageId))],
  );
  const reopenedKeys = new Set(
    terminalReopenedTasks.map((row) => driftKey(row.pageId, row.kind)),
  );
  for (const row of current) {
    if (reopenedKeys.has(driftKey(row.pageId, row.kind))) {
      row.reasons.push('l1_projection_drift_terminal_evidence_changed');
    }
  }
  const candidates = current
    .filter((drift) => drift.eligible && !openTerminal.has(driftKey(drift.pageId, drift.kind)))
    .sort((a, b) => b.magnitude - a.magnitude || a.pageId - b.pageId || a.kind.localeCompare(b.kind))
    .map((drift): ScanTaskRow => ({
      pageId: drift.pageId,
      kind: drift.kind,
      reasons: drift.reasons,
      priority: Math.min(100, 70 + drift.magnitude),
      notBefore: observedAt,
    }));
  const discoveredPages = new Set(current.map((row) => row.pageId)).size;
  const gate = applyL1DriftFloodGate(candidates, projection.length, discoveredPages);
  const selectedKeys = new Set(
    gate.selected.map((task) => driftKey(task.pageId, task.kind as L1DriftTaskKind)),
  );

  const statesWritten = await upsertCurrentDriftStates(
    pool,
    runId,
    current,
    selectedKeys,
    observedAt,
  );
  const statesResolved = await resolveMissingDriftStates(
    pool,
    aligned.map((row) => row.pageId),
    current,
    observedAt,
  );
  const gateSummary: Omit<L1DriftFloodGate<ScanTaskRow>, 'selected'> = {
    triggered: gate.triggered,
    limitPages: gate.limitPages,
    discoveredPages: gate.discoveredPages,
    eligiblePages: gate.eligiblePages,
    selectedPages: gate.selectedPages,
    truncatedPages: gate.truncatedPages,
    message: gate.message,
  };
  return {
    tasks: gate.selected,
    identityConflicts,
    summary: {
      population: projection.length,
      aligned: aligned.length,
      identityConflicts: identityConflicts.length,
      discoveredPages,
      voteMismatches: current.filter((row) => row.kind === 'votes_full').length,
      revisionMismatches: current.filter((row) => row.kind === 'revisions_full').length,
      persistentPages: new Set(
        current.filter((row) => row.eligible).map((row) => row.pageId),
      ).size,
      terminalReopenedTasks: terminalReopenedTasks.length,
      terminalSuppressedTasks: current.filter(
        (row) => row.eligible && openTerminal.has(driftKey(row.pageId, row.kind)),
      ).length,
      statesWritten,
      statesResolved,
      gate: gateSummary,
    },
  };
}

async function loadLiveProjection(pool: Pool): Promise<ProjectionRow[]> {
  const result = await query<ProjectionRow>(
    pool,
    'drift:load_live_projection',
    `SELECT pc.page_id, pc.slug, pc.rating,
            pc.vote_up + pc.vote_down AS vote_count,
            pc.revision_count,
            count(*) OVER (PARTITION BY pc.slug) AS live_slug_count,
            array_agg(pc.page_id) OVER (PARTITION BY pc.slug) AS live_page_ids
       FROM serve.page_current pc
      WHERE pc.status = 'live'`,
  );
  return result.rows;
}

async function loadStoredDrift(
  pool: Pool,
  pageIds: readonly number[],
): Promise<Map<string, StoredDriftRow>> {
  const out = new Map<string, StoredDriftRow>();
  for (const part of chunk([...new Set(pageIds)], 5_000)) {
    if (part.length === 0) continue;
    const result = await query<StoredDriftRow>(
      pool,
      'drift:load_state',
      `SELECT page_id, kind, consecutive_observations,
              last_observation_run_id, resolved_at
         FROM meta.incremental_drift_state
        WHERE page_id = ANY($1::int[])`,
      [part],
    );
    for (const row of result.rows) out.set(driftKey(Number(row.page_id), row.kind), row);
  }
  return out;
}

async function loadOpenIrreconcilable(
  pool: Pool,
  pageIds: readonly number[],
): Promise<Map<string, OpenIrreconcilableRow>> {
  const out = new Map<string, OpenIrreconcilableRow>();
  for (const part of chunk([...new Set(pageIds)], 5_000)) {
    if (part.length === 0) continue;
    const result = await query<OpenIrreconcilableRow>(
      pool,
      'drift:load_irreconcilable',
      `SELECT page_id, kind, remote_value
         FROM meta.irreconcilable
        WHERE page_id = ANY($1::int[])
          AND kind = ANY($2::text[])
          AND resolved_at IS NULL`,
      [part, ['votes_full', 'revisions_full']],
    );
    for (const row of result.rows) {
      out.set(driftKey(Number(row.page_id), row.kind), row);
    }
  }
  return out;
}

async function reopenChangedIrreconcilable(
  pool: Pool,
  rows: readonly ChangedTerminalDrift[],
  observedAt: string,
): Promise<Array<{ pageId: number; kind: L1DriftTaskKind }>> {
  const reopened: Array<{ pageId: number; kind: L1DriftTaskKind }> = [];
  for (const part of chunk(rows, 1_000)) {
    if (part.length === 0) continue;
    const result = await query<{ page_id: number; kind: L1DriftTaskKind }>(
      pool,
      'drift:reopen_changed_irreconcilable',
      `WITH input AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS x(
             page_id int, kind text, terminal_remote_value jsonb
           )
       )
       UPDATE meta.irreconcilable i
          SET resolved_at = $2::timestamptz,
              last_checked = $2::timestamptz,
              next_review_at = NULL
         FROM input
        WHERE i.page_id = input.page_id
          AND i.kind = input.kind
          AND i.resolved_at IS NULL
          AND i.locked_by IS NULL
          AND i.remote_value = input.terminal_remote_value
       RETURNING i.page_id, i.kind`,
      [
        toPgJson(
          part.map((row) => ({
            page_id: row.pageId,
            kind: row.kind,
            terminal_remote_value: row.terminalRemoteValue,
          })),
          'drift.reopen_irreconcilable',
        ),
        toPgTimestamptz(observedAt),
      ],
    );
    reopened.push(
      ...result.rows.map((row) => ({
        pageId: Number(row.page_id),
        kind: row.kind,
      })),
    );
  }
  return reopened;
}

async function upsertCurrentDriftStates(
  pool: Pool,
  runId: number,
  rows: readonly CurrentDrift[],
  selectedKeys: ReadonlySet<string>,
  observedAt: string,
): Promise<number> {
  let written = 0;
  for (const part of chunk(rows, 1_000)) {
    if (part.length === 0) continue;
    const payload = part.map((row) => ({
      page_id: row.pageId,
      slug: row.slug,
      kind: row.kind,
      consecutive_observations: row.consecutiveObservations,
      local_value: row.localValue,
      remote_value: row.remoteValue,
      enqueued: selectedKeys.has(driftKey(row.pageId, row.kind)),
    }));
    const result = await query(
      pool,
      'drift:upsert_state',
      `WITH input AS (
         SELECT *
           FROM jsonb_to_recordset($1::jsonb) AS x(
             page_id int, slug text, kind text, consecutive_observations int,
             local_value jsonb, remote_value jsonb, enqueued boolean
           )
       )
       INSERT INTO meta.incremental_drift_state AS ds
         (page_id, kind, slug, first_detected_at, last_detected_at,
          last_observation_run_id, consecutive_observations,
          local_value, remote_value, last_enqueued_at, resolved_at)
       SELECT page_id, kind, slug, $2::timestamptz, $2::timestamptz,
              $3::bigint, consecutive_observations,
              local_value, remote_value,
              CASE WHEN enqueued THEN $2::timestamptz ELSE NULL END,
              NULL
         FROM input
       ON CONFLICT (page_id, kind) DO UPDATE
         SET slug = EXCLUDED.slug,
             first_detected_at = CASE
               WHEN ds.resolved_at IS NULL THEN ds.first_detected_at
               ELSE EXCLUDED.first_detected_at
             END,
             last_detected_at = EXCLUDED.last_detected_at,
             last_observation_run_id = EXCLUDED.last_observation_run_id,
             consecutive_observations = EXCLUDED.consecutive_observations,
             local_value = EXCLUDED.local_value,
             remote_value = EXCLUDED.remote_value,
             last_enqueued_at = CASE
               WHEN EXCLUDED.last_enqueued_at IS NOT NULL THEN EXCLUDED.last_enqueued_at
               WHEN ds.resolved_at IS NOT NULL THEN NULL
               ELSE ds.last_enqueued_at
             END,
             resolved_at = NULL`,
      [
        toPgJson(payload, 'drift.state'),
        toPgTimestamptz(observedAt),
        runId,
      ],
    );
    written += result.rowCount ?? 0;
  }
  return written;
}

async function resolveMissingDriftStates(
  pool: Pool,
  alignedPageIds: readonly number[],
  current: readonly CurrentDrift[],
  observedAt: string,
): Promise<number> {
  let resolved = 0;
  const byKind = new Map<L1DriftTaskKind, number[]>([
    ['votes_full', []],
    ['revisions_full', []],
  ]);
  for (const row of current) byKind.get(row.kind)!.push(row.pageId);
  for (const pagePart of chunk([...new Set(alignedPageIds)], 5_000)) {
    if (pagePart.length === 0) continue;
    for (const kind of ['votes_full', 'revisions_full'] as const) {
      const currentForPart = new Set(byKind.get(kind));
      const mismatched = pagePart.filter((pageId) => currentForPart.has(pageId));
      const result = await query(
        pool,
        'drift:resolve_state',
        `UPDATE meta.incremental_drift_state
            SET consecutive_observations = 0,
                resolved_at = $3::timestamptz
          WHERE page_id = ANY($1::int[])
            AND kind = $2
            AND NOT (page_id = ANY($4::int[]))
            AND resolved_at IS NULL`,
        [pagePart, kind, toPgTimestamptz(observedAt), mismatched],
      );
      resolved += result.rowCount ?? 0;
    }
  }
  return resolved;
}

function driftKey(pageId: number, kind: L1DriftTaskKind): string {
  return `${pageId}:${kind}`;
}
