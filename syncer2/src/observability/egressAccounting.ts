import type { PoolClient, QueryResultRow } from 'pg';

import { query, toPgTimestamptz } from '../store/db.js';
import { toPgJson } from '../store/pgText.js';

export const EGRESS_ACCOUNTING_WINDOW_MINUTES = 60;
export const EGRESS_ACCOUNTING_MINIMUM_SAMPLES = 100;
export const EGRESS_ACCOUNTING_MINIMUM_ABSOLUTE_GAP = 0.05;
export const EGRESS_ACCOUNTING_MINIMUM_RATE_RATIO = 3;
export const EGRESS_ACCOUNTING_WARN_AFTER_MS = 15 * 60_000;
export const EGRESS_ACCOUNTING_CRITICAL_AFTER_MS = 60 * 60_000;

export interface EgressAccountingCounts {
  ingestFailures: number;
  ingestTotal: number;
  egressFailures: number;
  egressTotal: number;
}

export interface EgressAccountingPreviousState {
  status: 'insufficient' | 'aligned' | 'divergent';
  divergentSinceMs: number | null;
}

export interface EgressAccountingDecision extends EgressAccountingCounts {
  status: EgressAccountingPreviousState['status'];
  severity: 'ok' | 'warn' | 'critical';
  ingestFailureRate: number | null;
  egressFailureRate: number | null;
  absoluteRateGap: number | null;
  /** null 且 gap>0 表示较低一侧为 0，倍数无上界。 */
  rateRatio: number | null;
  divergentSinceMs: number | null;
  divergenceDurationMs: number;
}

export function evaluateEgressAccountingReconciliation(
  counts: EgressAccountingCounts,
  observedAtMs: number,
  previous: EgressAccountingPreviousState | null = null,
): EgressAccountingDecision {
  if (!Number.isFinite(observedAtMs)) throw new RangeError(`非法 accounting observedAt=${observedAtMs}`);
  for (const [name, value] of Object.entries(counts)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`egress accounting ${name} 必须是非负安全整数，收到 ${value}`);
    }
  }
  if (counts.ingestFailures > counts.ingestTotal) {
    throw new RangeError('ingestFailures 不能超过 ingestTotal');
  }
  if (counts.egressFailures > counts.egressTotal) {
    throw new RangeError('egressFailures 不能超过 egressTotal');
  }

  const ingestFailureRate = counts.ingestTotal === 0
    ? null
    : counts.ingestFailures / counts.ingestTotal;
  const egressFailureRate = counts.egressTotal === 0
    ? null
    : counts.egressFailures / counts.egressTotal;
  const enoughSamples = counts.ingestTotal >= EGRESS_ACCOUNTING_MINIMUM_SAMPLES
    && counts.egressTotal >= EGRESS_ACCOUNTING_MINIMUM_SAMPLES;
  if (!enoughSamples || ingestFailureRate === null || egressFailureRate === null) {
    return {
      ...counts,
      status: 'insufficient',
      severity: 'ok',
      ingestFailureRate,
      egressFailureRate,
      absoluteRateGap: null,
      rateRatio: null,
      divergentSinceMs: null,
      divergenceDurationMs: 0,
    };
  }

  const high = Math.max(ingestFailureRate, egressFailureRate);
  const low = Math.min(ingestFailureRate, egressFailureRate);
  const absoluteRateGap = high - low;
  const rateRatio = low === 0 ? (high === 0 ? 1 : null) : high / low;
  const divergent = absoluteRateGap >= EGRESS_ACCOUNTING_MINIMUM_ABSOLUTE_GAP
    && (rateRatio === null || rateRatio >= EGRESS_ACCOUNTING_MINIMUM_RATE_RATIO);
  if (!divergent) {
    return {
      ...counts,
      status: 'aligned',
      severity: 'ok',
      ingestFailureRate,
      egressFailureRate,
      absoluteRateGap,
      rateRatio,
      divergentSinceMs: null,
      divergenceDurationMs: 0,
    };
  }

  const divergentSinceMs = previous?.status === 'divergent'
    && previous.divergentSinceMs !== null
    && previous.divergentSinceMs <= observedAtMs
    ? previous.divergentSinceMs
    : observedAtMs;
  const divergenceDurationMs = observedAtMs - divergentSinceMs;
  const severity = divergenceDurationMs >= EGRESS_ACCOUNTING_CRITICAL_AFTER_MS
    ? 'critical'
    : divergenceDurationMs >= EGRESS_ACCOUNTING_WARN_AFTER_MS
      ? 'warn'
      : 'ok';
  return {
    ...counts,
    status: 'divergent',
    severity,
    ingestFailureRate,
    egressFailureRate,
    absoluteRateGap,
    rateRatio,
    divergentSinceMs,
    divergenceDurationMs,
  };
}

interface CountRow extends QueryResultRow {
  failures: string;
  total: string;
}

interface PreviousRow extends QueryResultRow {
  status: EgressAccountingPreviousState['status'];
  divergent_since: string | null;
}

/** 在 oldest-pending 的同一巡检事务内刷新一次；不发送任何外部消息。 */
export async function observeEgressAccounting(
  db: PoolClient,
  observedAt: string,
): Promise<EgressAccountingDecision> {
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(observedAtMs)) throw new RangeError(`非法 observedAt ${observedAt}`);

  // 同一 PoolClient 正在 oldest-pending 事务中；pg 不允许在一个 client 上并发 query。
  const ingest = await query<CountRow>(
    db,
    'egress-accounting:ingest-run',
    `WITH eligible AS (
         SELECT batches_total::bigint AS total,
                batches_failed::bigint AS failed,
                LEAST(
                  batches_failed::bigint,
                  CASE
                    WHEN coalesce(
                      stats #>> '{health,deterministicFailures}',
                      stats #>> '{health,deterministic_failures}',
                      stats #>> '{healthExclusions,deterministic_failures}',
                      stats #>> '{health_exclusions,deterministic_failures}'
                    ) ~ '^[0-9]+$'
                    THEN coalesce(
                      stats #>> '{health,deterministicFailures}',
                      stats #>> '{health,deterministic_failures}',
                      stats #>> '{healthExclusions,deterministic_failures}',
                      stats #>> '{health_exclusions,deterministic_failures}'
                    )::bigint
                    ELSE 0
                  END
                ) AS deterministic
           FROM meta.ingest_run
          WHERE finished_at >= $1::timestamptz - interval '60 minutes'
            AND finished_at <= $1::timestamptz
            AND batches_total > 0
            AND batches_failed IS NOT NULL
            AND stats #> '{http,adaptiveEgress}' IS NOT NULL
            AND stats #> '{http,adaptiveEgress}' <> 'null'::jsonb
       )
       SELECT coalesce(sum(GREATEST(failed - deterministic, 0)), 0)::text AS failures,
              coalesce(sum(total), 0)::text AS total
         FROM eligible`,
    [observedAt],
  );
  const egress = await query<CountRow>(
    db,
    'egress-accounting:request-bucket',
    `SELECT coalesce(sum(failures), 0)::text AS failures,
              coalesce(sum(requests), 0)::text AS total
         FROM meta.egress_request_bucket
        WHERE site_key = 'wikidot'
          AND bucket_start >= date_trunc('minute', $1::timestamptz) - interval '59 minutes'
          AND bucket_start <= date_trunc('minute', $1::timestamptz)`,
    [observedAt],
  );
  const prior = await query<PreviousRow>(
    db,
    'egress-accounting:previous',
    `SELECT status, divergent_since::text
         FROM meta.egress_accounting_check
        WHERE site_key = 'wikidot'
        FOR UPDATE`,
  );

  const counts = {
    ingestFailures: Number(ingest.rows[0]?.failures ?? 0),
    ingestTotal: Number(ingest.rows[0]?.total ?? 0),
    egressFailures: Number(egress.rows[0]?.failures ?? 0),
    egressTotal: Number(egress.rows[0]?.total ?? 0),
  };
  const previousRow = prior.rows[0];
  const decision = evaluateEgressAccountingReconciliation(
    counts,
    observedAtMs,
    previousRow === undefined
      ? null
      : {
          status: previousRow.status,
          divergentSinceMs: previousRow.divergent_since === null
            ? null
            : Date.parse(previousRow.divergent_since),
        },
  );
  await query(
    db,
    'egress-accounting:upsert',
    `INSERT INTO meta.egress_accounting_check(
       site_key, status, observed_at, window_started_at,
       ingest_failures, ingest_total, ingest_failure_rate,
       egress_failures, egress_total, egress_failure_rate,
       absolute_rate_gap, rate_ratio, divergent_since, details, updated_at
     ) VALUES (
       'wikidot', $1, $2::timestamptz, $2::timestamptz - interval '60 minutes',
       $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, $12::jsonb, clock_timestamp()
     )
     ON CONFLICT (site_key) DO UPDATE SET
       status = EXCLUDED.status,
       observed_at = EXCLUDED.observed_at,
       window_started_at = EXCLUDED.window_started_at,
       ingest_failures = EXCLUDED.ingest_failures,
       ingest_total = EXCLUDED.ingest_total,
       ingest_failure_rate = EXCLUDED.ingest_failure_rate,
       egress_failures = EXCLUDED.egress_failures,
       egress_total = EXCLUDED.egress_total,
       egress_failure_rate = EXCLUDED.egress_failure_rate,
       absolute_rate_gap = EXCLUDED.absolute_rate_gap,
       rate_ratio = EXCLUDED.rate_ratio,
       divergent_since = EXCLUDED.divergent_since,
       details = EXCLUDED.details,
       updated_at = clock_timestamp()`,
    [
      decision.status,
      toPgTimestamptz(observedAtMs),
      decision.ingestFailures,
      decision.ingestTotal,
      decision.ingestFailureRate,
      decision.egressFailures,
      decision.egressTotal,
      decision.egressFailureRate,
      decision.absoluteRateGap,
      decision.rateRatio,
      decision.divergentSinceMs === null
        ? null
        : toPgTimestamptz(decision.divergentSinceMs),
      toPgJson(
        {
          severity: decision.severity,
          divergence_duration_seconds: Math.round(decision.divergenceDurationMs / 1_000),
          minimum_samples_each: EGRESS_ACCOUNTING_MINIMUM_SAMPLES,
          minimum_absolute_gap: EGRESS_ACCOUNTING_MINIMUM_ABSOLUTE_GAP,
          minimum_rate_ratio: EGRESS_ACCOUNTING_MINIMUM_RATE_RATIO,
          deterministic_failures_excluded: true,
          no_qq_delivery: true,
        },
        'egress_accounting_check.details',
      ),
    ],
  );
  return decision;
}
