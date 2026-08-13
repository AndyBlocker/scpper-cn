import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

import { query, toPgTimestamptz, withTransaction } from './db.js';
import { recordPageScan } from './meta.js';
import {
  sanitizePgText,
  textWasSanitized,
  toPgJson,
  type PgTextSanitization,
} from './pgText.js';

export const REVISION_SOURCE_VERSION = 'page-source-v1';
export const REVISION_SOURCE_DOMAIN = 'revision_source_full';
export const REVISION_SOURCE_POPULATION = 'revision_source_full';
export const REVISION_SOURCE_MODE = 'revision_source_backfill';
export const REVISION_SOURCE_PAGE_SCAN_KIND = 'revision_source';

export const REVISION_SOURCE_SCHEDULE_INTERVAL_MS = 30 * 60_000;
export const REVISION_SOURCE_ZERO_OUTPUT_ALERT_ROUNDS = 3;

export interface RevisionSourceRealtimeContentionDecision {
  action: 'execute';
  active: string[];
  coordination: 'background_token_bucket';
}

/**
 * 实时链路繁忙只作为观测，不再成为整轮退出条件。revision-source 已被 0062 固定映射到
 * background 令牌桶（800/h、容量 400），其 300 条/半小时需求在独立配额内；再叠一层
 * “看见 L1 就退出”只会把定时器相位变成永久阻塞。
 */
export function decideRevisionSourceRealtimeContention(
  active: readonly string[],
): RevisionSourceRealtimeContentionDecision {
  return {
    action: 'execute',
    active: [...active],
    coordination: 'background_token_bucket',
  };
}

export interface RevisionSourceOutputHealth {
  selected: number;
  stored: number;
  blobsInserted: number;
  consecutiveZeroOutputRuns: number;
  alertAfterRuns: number;
  alert: boolean;
}

/** 连续“确实认领过任务但 stored=0”的轮次才累计；空队列/主动 skip 不伪造无产出。 */
export function evaluateRevisionSourceOutputHealth(
  current: { selected: number; stored: number; blobsInserted: number },
  previousStoredNewestFirst: readonly number[],
  alertAfterRuns = REVISION_SOURCE_ZERO_OUTPUT_ALERT_ROUNDS,
): RevisionSourceOutputHealth {
  for (const [name, value] of Object.entries(current)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new RangeError(`revision source output ${name} 必须是非负整数，收到 ${value}`);
    }
  }
  if (!Number.isSafeInteger(alertAfterRuns) || alertAfterRuns < 1) {
    throw new RangeError(`alertAfterRuns 必须是正整数，收到 ${alertAfterRuns}`);
  }
  if (current.selected === 0 || current.stored > 0) {
    return {
      ...current,
      consecutiveZeroOutputRuns: 0,
      alertAfterRuns,
      alert: false,
    };
  }
  let consecutiveZeroOutputRuns = 1;
  for (const stored of previousStoredNewestFirst) {
    if (!Number.isSafeInteger(stored) || stored < 0) {
      throw new RangeError(`previous stored 必须是非负整数，收到 ${stored}`);
    }
    if (stored > 0) break;
    consecutiveZeroOutputRuns++;
  }
  return {
    ...current,
    consecutiveZeroOutputRuns,
    alertAfterRuns,
    alert: consecutiveZeroOutputRuns >= alertAfterRuns,
  };
}

export async function loadRevisionSourceOutputHealth(
  pool: Pool,
  current: { selected: number; stored: number; blobsInserted: number },
  alertAfterRuns = REVISION_SOURCE_ZERO_OUTPUT_ALERT_ROUNDS,
): Promise<RevisionSourceOutputHealth> {
  const previous = await query<{ stored: string | number }>(
    pool,
    'revision_source:previous_output_health',
    `SELECT (stats->>'stored')::bigint AS stored
       FROM meta.ingest_run
      WHERE source = 'wikidot_tier2'
        AND stats->>'mode' = $1
        AND status <> 'running'
        AND stats->>'selected' ~ '^[0-9]+$'
        AND (stats->>'selected')::bigint > 0
        AND stats->>'stored' ~ '^[0-9]+$'
      ORDER BY id DESC
      LIMIT $2`,
    [REVISION_SOURCE_MODE, Math.max(0, alertAfterRuns - 1)],
  );
  return evaluateRevisionSourceOutputHealth(
    current,
    previous.rows.map((row) => Number(row.stored)),
    alertAfterRuns,
  );
}

/**
 * 1-based FIFO 位置在“每轮硬保证的最少执行机会”下的保守调度界。
 * 生产配置的 300 是上限，不是 200 秒预算内的最低吞吐；硬界因此使用 1。
 * 失败或预算中断会把 not_before 推到当时/未来，不会让同一队头原地自旋。
 * 此界不声称覆盖 Wikidot/网络持续不可用、写入冻结或 timer 被停用；
 * 调用方还必须保持任务 due/live。
 */
export function revisionSourceDispatchUpperBoundMs(
  waitingPosition: number,
  guaranteedDispatchesPerRound: number,
  scheduleIntervalMs = REVISION_SOURCE_SCHEDULE_INTERVAL_MS,
): number {
  if (!Number.isSafeInteger(waitingPosition) || waitingPosition < 1) {
    throw new RangeError(`waitingPosition 必须是正整数，收到 ${waitingPosition}`);
  }
  if (
    !Number.isSafeInteger(guaranteedDispatchesPerRound)
    || guaranteedDispatchesPerRound < 1
  ) {
    throw new RangeError(
      `guaranteedDispatchesPerRound 必须是正整数，收到 ${guaranteedDispatchesPerRound}`,
    );
  }
  if (!Number.isSafeInteger(scheduleIntervalMs) || scheduleIntervalMs < 1) {
    throw new RangeError(`scheduleIntervalMs 必须是正整数，收到 ${scheduleIntervalMs}`);
  }
  return Math.ceil(waitingPosition / guaranteedDispatchesPerRound) * scheduleIntervalMs;
}

export type RevisionSourceFailureDisposition = 'deterministic' | 'transient';

/**
 * 登录账号复核后的 no_permission 已在上游直接进入 unavailable；这里只处理其余失败。
 * revision_error / 解析契约错误等稳定目标拒绝在三次后进入 irreconcilable。5xx、传输重置
 * 与全局断路器是链路状态，把它们终结为“不可调和”会把出口故障伪装成 100% 完成。
 */
export function classifyRevisionSourceFailure(error: string): RevisionSourceFailureDisposition {
  return /(TransportError|CircuitOpenError)/i.test(error)
    || /(?:HTTP|status)[^0-9]*5[0-9]{2}/i.test(error)
    ? 'transient'
    : 'deterministic';
}

/**
 * 目标口径与已确认的 347,686 基线一致：存活页中会改变/创建源码的修订。
 * TAGS_CHANGED 等非源码修订不重复抓同一全文；其独立标签变更史留待后续 PageDiff 任务。
 */
const SOURCE_TYPE_SQL = `(
  r.type IS NULL
  OR r.type && ARRAY['SOURCE_CHANGED','PAGE_CREATED']::text[]
  OR EXISTS (
    SELECT 1 FROM unnest(r.type) AS revision_type(value)
     WHERE starts_with(revision_type.value, 'UNKNOWN:')
  )
)`;

export interface RevisionSourceCandidate {
  revisionSeq: number;
  pageId: number;
  wikidotId: number;
  wikidotRevisionId: number;
  fromRevisionSeq: number | null;
  fromWikidotRevisionId: number | null;
  ordinal: number;
  revisionTotal: number;
  isAnchor: boolean;
  isLatest: boolean;
  occurredAt: string;
  type: string[] | null;
}

interface CandidateRow {
  revision_seq: string | number;
  page_id: number;
  wikidot_id: number;
  wikidot_revision_id: string | number;
  from_revision_seq: string | number | null;
  from_wikidot_revision_id: string | number | null;
  ordinal: string | number;
  revision_total: string | number;
  is_anchor: boolean;
  is_latest?: boolean;
  occurred_at: Date | string;
  type: string[] | null;
}

function candidate(row: CandidateRow): RevisionSourceCandidate {
  return {
    revisionSeq: Number(row.revision_seq),
    pageId: Number(row.page_id),
    wikidotId: Number(row.wikidot_id),
    wikidotRevisionId: Number(row.wikidot_revision_id),
    fromRevisionSeq:
      row.from_revision_seq === null ? null : Number(row.from_revision_seq),
    fromWikidotRevisionId:
      row.from_wikidot_revision_id === null
        ? null
        : Number(row.from_wikidot_revision_id),
    ordinal: Number(row.ordinal),
    revisionTotal: Number(row.revision_total),
    isAnchor: row.is_anchor,
    isLatest: row.is_latest ?? false,
    occurredAt:
      row.occurred_at instanceof Date
        ? row.occurred_at.toISOString()
        : new Date(row.occurred_at).toISOString(),
    type: row.type,
  };
}

function eligibleCte(): string {
  return `
    WITH eligible_base AS (
      SELECT r.seq AS revision_seq,
             r.page_id,
             p.wikidot_id,
             r.wikidot_revision_id,
             r.occurred_at,
             r.type,
             row_number() OVER (
               PARTITION BY r.page_id
               ORDER BY r.occurred_at, r.wikidot_revision_id, r.seq
             )::int AS ordinal,
             row_number() OVER (
               PARTITION BY r.page_id
               ORDER BY r.occurred_at DESC, r.wikidot_revision_id DESC, r.seq DESC
             )::int AS reverse_ordinal,
             count(*) OVER (PARTITION BY r.page_id)::int AS revision_total,
             lag(r.seq) OVER (
               PARTITION BY r.page_id
               ORDER BY r.occurred_at, r.wikidot_revision_id, r.seq
             ) AS from_revision_seq,
             lag(r.wikidot_revision_id) OVER (
               PARTITION BY r.page_id
               ORDER BY r.occurred_at, r.wikidot_revision_id, r.seq
             ) AS from_wikidot_revision_id
        FROM ingest.revision r
        JOIN ingest.page p ON p.id = r.page_id
        JOIN serve.page_current pc
          ON pc.page_id = r.page_id AND pc.status = 'live'
       WHERE r.wikidot_revision_id IS NOT NULL
         AND ${SOURCE_TYPE_SQL}
    ), eligible AS (
      SELECT b.*, true AS is_anchor, b.reverse_ordinal = 1 AS is_latest
        FROM eligible_base b
    )`;
}

/**
 * 1,000 条全文试点：100 个当前源码版本 + 900 个历史版本，每页最多一条。
 * 当前版本额外调用 ViewSourceModule 交叉验证；历史版本覆盖 revision_id 路径。
 */
export async function loadPilotCandidates(
  pool: Pool,
  sampleCount: number,
  currentCrosscheckCount = 100,
): Promise<RevisionSourceCandidate[]> {
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) {
    throw new RangeError(`pilot sampleCount 必须是正整数，收到 ${sampleCount}`);
  }
  if (
    !Number.isSafeInteger(currentCrosscheckCount) ||
    currentCrosscheckCount < 1 ||
    currentCrosscheckCount >= sampleCount
  ) {
    throw new RangeError(
      `currentCrosscheckCount 必须是 1..${sampleCount - 1}，收到 ${currentCrosscheckCount}`,
    );
  }
  const samplingSeed = 2_718_281;
  const result = await query<CandidateRow>(
    pool,
    'revision_source:pilot_candidates',
    `${eligibleCte()},
     latest_candidates AS (
       SELECT *
         FROM eligible
        WHERE is_latest
          AND EXISTS (
            SELECT 1 FROM serve.page_current pc
             WHERE pc.page_id = eligible.page_id
               AND pc.status = 'live'
               AND pc.source_sha IS NOT NULL
               AND pc.slug NOT LIKE 'deleted:%'
          )
        ORDER BY hashtextextended(
                   page_id::text || ':' || wikidot_revision_id::text,
                   $3
                 ),
                 page_id
        LIMIT $2
     ),
     history_one_per_page AS (
       SELECT DISTINCT ON (e.page_id) e.*
         FROM eligible e
        WHERE NOT e.is_latest
          -- pilot 只从已有当前全文正面证据的公开页抽样；长跑仍会给其余 live 页建 job，
          -- no_permission/revision_error 走逐条退避和 irreconcilable，不被样本过滤吞掉。
          AND EXISTS (
            SELECT 1 FROM serve.page_current pc
             WHERE pc.page_id = e.page_id
               AND pc.status = 'live'
               AND pc.source_sha IS NOT NULL
               AND pc.slug NOT LIKE 'deleted:%'
          )
          AND NOT EXISTS (
            SELECT 1 FROM latest_candidates l WHERE l.page_id = e.page_id
          )
        ORDER BY e.page_id,
                 hashtextextended(
                   e.page_id::text || ':' || e.wikidot_revision_id::text,
                   $3
                 ),
                 e.wikidot_revision_id
     ),
     history_candidates AS (
       SELECT *
         FROM history_one_per_page
        ORDER BY hashtextextended(
                   page_id::text || ':' || wikidot_revision_id::text,
                   $3
                 ),
                 page_id
        LIMIT ($1 - $2)
     )
     SELECT revision_seq, page_id, wikidot_id, wikidot_revision_id,
            from_revision_seq, from_wikidot_revision_id, ordinal, revision_total,
            is_anchor, is_latest, occurred_at, type
       FROM (
         SELECT * FROM latest_candidates
         UNION ALL
         SELECT * FROM history_candidates
       ) picked
      ORDER BY is_latest DESC, page_id, ordinal`,
    [sampleCount, currentCrosscheckCount, samplingSeed],
  );
  if (result.rows.length !== sampleCount) {
    throw new Error(
      `pilot 分层候选不足 rows=${result.rows.length}/${sampleCount} ` +
        `current=${result.rows.filter((row) => row.is_latest).length}/${currentCrosscheckCount}`,
    );
  }
  return result.rows.map(candidate);
}

/** 每轮只补一小段 job 元数据；已存在 source_sha 的修订直接登记为 done。 */
export async function seedRevisionSourceJobs(
  pool: Pool,
  seedLimit: number,
): Promise<{ inserted: number; eligible: number }> {
  return withTransaction(pool, 'revision_source:seed_jobs', async (db) => {
    const inserted = await query(
      db,
      'revision_source:seed_jobs_insert',
      `${eligibleCte()}
       INSERT INTO meta.revision_source_backfill_job(
         revision_seq, page_id, wikidot_id, wikidot_revision_id,
         from_revision_seq, from_wikidot_revision_id, ordinal, revision_total,
         is_anchor, strategy, status, source_sha, source_bytes, blob_inserted, completed_at
       )
       SELECT e.revision_seq, e.page_id, e.wikidot_id, e.wikidot_revision_id,
              e.from_revision_seq, e.from_wikidot_revision_id,
              e.ordinal, e.revision_total, true, $2,
              CASE WHEN r.source_sha IS NULL THEN 'pending' ELSE 'done' END,
              r.source_sha, cb.byte_len,
              CASE WHEN r.source_sha IS NULL THEN NULL ELSE false END,
              CASE WHEN r.source_sha IS NULL THEN NULL ELSE now() END
         FROM eligible e
         JOIN ingest.revision r ON r.seq = e.revision_seq
         LEFT JOIN ingest.content_blob cb ON cb.sha256 = r.source_sha
        WHERE NOT EXISTS (
                SELECT 1 FROM meta.revision_source_backfill_job j
                 WHERE j.revision_seq = e.revision_seq
              )
        ORDER BY e.page_id, e.ordinal
        LIMIT $1
       ON CONFLICT (revision_seq) DO NOTHING`,
      [seedLimit, REVISION_SOURCE_VERSION],
    );
    const total = await query<{ n: string | number }>(
      db,
      'revision_source:eligible_count',
      `${eligibleCte()}
       SELECT count(*) AS n FROM eligible`,
    );
    return {
      inserted: inserted.rowCount ?? 0,
      eligible: Number(total.rows[0]?.n ?? 0),
    };
  });
}

export async function skipDeletedRevisionSourceJobs(pool: Pool): Promise<number> {
  const result = await query(
    pool,
    'revision_source:skip_deleted',
    `UPDATE meta.revision_source_backfill_job j
        SET status = 'skipped_deleted',
            locked_by = NULL,
            locked_at = NULL,
            last_error = 'page no longer live; deleted-page revisions are out of scope',
            updated_at = now()
      WHERE j.status IN ('pending','retry','processing')
        AND NOT EXISTS (
          SELECT 1 FROM serve.page_current pc
           WHERE pc.page_id = j.page_id AND pc.status = 'live'
        )`,
  );
  return result.rowCount ?? 0;
}

export async function recoverStaleRevisionSourceJobs(
  pool: Pool,
  staleMinutes = 15,
): Promise<number> {
  const result = await query(
    pool,
    'revision_source:recover_stale',
    `UPDATE meta.revision_source_backfill_job
        SET status = 'retry',
            locked_by = NULL,
            locked_at = NULL,
            not_before = now(),
            last_error = concat_ws('; ', last_error, 'recovered stale processing claim'),
            updated_at = now()
      WHERE status = 'processing'
        AND locked_at < now() - make_interval(mins => $1)`,
    [staleMinutes],
  );
  return result.rowCount ?? 0;
}

export async function claimRevisionSourceJobs(
  pool: Pool,
  limit: number,
  workerId: string,
): Promise<RevisionSourceCandidate[]> {
  return withTransaction(pool, 'revision_source:claim', async (db) => {
    const result = await query<CandidateRow>(
      db,
      'revision_source:claim_update',
      `WITH picked AS (
         SELECT j.revision_seq
           FROM meta.revision_source_backfill_job j
          WHERE j.status IN ('pending','retry')
            AND j.strategy = $3
            AND j.not_before <= now()
            AND EXISTS (
              SELECT 1 FROM serve.page_current pc
               WHERE pc.page_id = j.page_id AND pc.status = 'live'
            )
          ORDER BY j.not_before, j.page_id, j.ordinal
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       ), updated AS (
         UPDATE meta.revision_source_backfill_job j
            SET status = 'processing',
                locked_by = $2,
                locked_at = now(),
                attempts = j.attempts + 1,
                updated_at = now()
           FROM picked
          WHERE j.revision_seq = picked.revision_seq
         RETURNING j.*
       )
       SELECT u.revision_seq, u.page_id, u.wikidot_id, u.wikidot_revision_id,
              u.from_revision_seq, u.from_wikidot_revision_id, u.ordinal,
              u.revision_total, u.is_anchor, false AS is_latest,
              r.occurred_at, r.type
         FROM updated u
         JOIN ingest.revision r ON r.seq = u.revision_seq
        ORDER BY u.page_id, u.ordinal`,
      [limit, workerId, REVISION_SOURCE_VERSION],
    );
    return result.rows.map(candidate);
  });
}

export interface StoredRevisionSource {
  candidate: RevisionSourceCandidate;
  source: string;
  sourceSha256Hex: string;
  responseSha256Hex: string | null;
  responseBytes: number | null;
  observedAt: string;
  textSanitization?: PgTextSanitization;
}

export interface ApplyRevisionSourceResult {
  revisionSeq: number;
  sourceShaHex: string;
  sourceBytes: number;
  responseBytes: number | null;
  blobInserted: boolean;
  textSanitized: boolean;
  nulCodeUnits: number;
  loneSurrogates: number;
}

export function prepareRevisionSourceText(
  source: string,
  context = 'revision_source.source',
): { source: string; sourceSha256Hex: string; sanitation: PgTextSanitization } {
  const stored = sanitizePgText(source, { context });
  return {
    source: stored.value,
    sourceSha256Hex: createHash('sha256').update(stored.value, 'utf8').digest('hex'),
    sanitation: stored.sanitation,
  };
}

export async function applyStoredRevisionSource(
  pool: Pool,
  value: StoredRevisionSource,
): Promise<ApplyRevisionSourceResult> {
  const c = value.candidate;
  const prepared = prepareRevisionSourceText(
    value.source,
    `revision_source.source:${c.pageId}:${c.wikidotRevisionId}`,
  );
  const sanitation = value.textSanitization ?? prepared.sanitation;
  const result = await query<{ result: Record<string, unknown> }>(
    pool,
    'revision_source:apply_full',
    `SELECT ingest.apply_revision_source_full(
       $1::bigint, $2::int, $3::bigint, $4::text,
       $5::bytea, $6::bytea, $7::int, $8::timestamptz
     ) AS result`,
    [
      c.revisionSeq,
      c.pageId,
      c.wikidotRevisionId,
      prepared.source,
      Buffer.from(prepared.sourceSha256Hex, 'hex'),
      value.responseSha256Hex === null
        ? null
        : Buffer.from(value.responseSha256Hex, 'hex'),
      value.responseBytes,
      toPgTimestamptz(value.observedAt),
    ],
  );
  const applied = result.rows[0]?.result;
  if (applied === undefined) throw new Error('apply_revision_source_full 未返回结果');
  return {
    revisionSeq: Number(applied['revision_seq']),
    sourceShaHex: String(applied['source_sha']),
    sourceBytes: Number(applied['source_bytes']),
    responseBytes:
      applied['response_bytes'] === null || applied['response_bytes'] === undefined
        ? null
        : Number(applied['response_bytes']),
    blobInserted: applied['blob_inserted'] === true,
    textSanitized: textWasSanitized(sanitation),
    nulCodeUnits: sanitation.nulCodeUnits,
    loneSurrogates: sanitation.loneSurrogates,
  };
}

export async function loadStoredRevisionSource(
  pool: Pool,
  revisionSeq: number,
): Promise<{ sourceShaHex: string; source: string; sourceBytes: number } | null> {
  const result = await query<{
    source_sha_hex: string;
    source: string;
    source_bytes: number;
  }>(
    pool,
    'revision_source:readback',
    `SELECT encode(r.source_sha, 'hex') AS source_sha_hex,
            cb.source,
            cb.byte_len AS source_bytes
       FROM ingest.revision r
       JOIN ingest.content_blob cb ON cb.sha256 = r.source_sha
      WHERE r.seq = $1`,
    [revisionSeq],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        sourceShaHex: row.source_sha_hex,
        source: row.source,
        sourceBytes: Number(row.source_bytes),
      };
}

export async function finishRevisionSourceJob(
  pool: Pool,
  candidateRow: RevisionSourceCandidate,
  workerId: string,
  outcome:
    | {
        status: 'done';
        sourceShaHex: string;
        sourceBytes: number;
        responseBytes: number | null;
        blobInserted: boolean;
      }
    | {
        status: 'failed';
        error: string;
        disposition?: RevisionSourceFailureDisposition;
        resultHashHex?: string;
      }
    | {
        status: 'unavailable';
        error: string;
      },
): Promise<'done' | 'retry' | 'irreconcilable' | 'unavailable'> {
  return withTransaction(pool, `revision_source:finish:${candidateRow.revisionSeq}`, async (db) => {
    if (outcome.status === 'done') {
      const done = await query(
        db,
        'revision_source:job_done',
        `UPDATE meta.revision_source_backfill_job
            SET status = 'done', consecutive_failures = 0, not_before = now(),
                locked_by = NULL, locked_at = NULL, last_error = NULL,
                source_sha = $3::bytea, source_bytes = $4, response_bytes = $5,
                blob_inserted = $6, completed_at = now(), updated_at = now()
          WHERE revision_seq = $1 AND status = 'processing' AND locked_by = $2`,
        [
          candidateRow.revisionSeq,
          workerId,
          Buffer.from(outcome.sourceShaHex, 'hex'),
          outcome.sourceBytes,
          outcome.responseBytes,
          outcome.blobInserted,
        ],
      );
      if ((done.rowCount ?? 0) !== 1) throw new Error('job done 丢失锁所有权');
      return 'done';
    }

    if (outcome.status === 'unavailable') {
      const unavailable = await query(
        db,
        'revision_source:job_unavailable',
        `UPDATE meta.revision_source_backfill_job
            SET status = 'unavailable', consecutive_failures = 0, not_before = now(),
                locked_by = NULL, locked_at = NULL, last_error = left($3, 4000),
                completed_at = now(), updated_at = now()
          WHERE revision_seq = $1 AND status = 'processing' AND locked_by = $2`,
        [candidateRow.revisionSeq, workerId, outcome.error],
      );
      if ((unavailable.rowCount ?? 0) !== 1) {
        throw new Error('job unavailable 丢失锁所有权');
      }
      await query(
        db,
        'revision_source:resolve_old_irreconcilable',
        `UPDATE meta.irreconcilable
            SET resolved_at = now(), last_checked = now(), next_review_at = NULL,
                locked_by = NULL, locked_at = NULL
          WHERE kind = 'revision_source' AND instance_id = $1 AND resolved_at IS NULL`,
        [candidateRow.revisionSeq],
      );
      return 'unavailable';
    }

    const disposition = outcome.disposition ?? classifyRevisionSourceFailure(outcome.error);
    const failed = await query<{ consecutive_failures: number; status: string }>(
      db,
      'revision_source:job_failed',
      `UPDATE meta.revision_source_backfill_job
          SET consecutive_failures = CASE WHEN $4::boolean THEN 0
                                          ELSE consecutive_failures + 1 END,
              status = CASE
                         WHEN $4::boolean THEN 'retry'
                         WHEN consecutive_failures + 1 >= 3 THEN 'irreconcilable'
                         ELSE 'retry'
                       END,
              not_before = now() + make_interval(
                mins => LEAST(1440, 5 * (1 << LEAST(8, consecutive_failures)))
              ),
              locked_by = NULL, locked_at = NULL,
              last_error = left($3, 4000), updated_at = now()
        WHERE revision_seq = $1 AND status = 'processing' AND locked_by = $2
        RETURNING consecutive_failures, status`,
      [candidateRow.revisionSeq, workerId, outcome.error, disposition === 'transient'],
    );
    const count = failed.rows[0]?.consecutive_failures;
    if (count === undefined) throw new Error('job failed 丢失锁所有权');
    if (failed.rows[0]?.status === 'retry') return 'retry';

    await query(
      db,
      'revision_source:irreconcilable',
      `INSERT INTO meta.irreconcilable(
         page_id, kind, instance_id, local_value, remote_value, result_hash,
         first_seen, last_checked, checks, next_review_at
       )
       VALUES (
         $1, 'revision_source', $2,
         jsonb_build_object('revision_seq',$3::bigint),
         jsonb_build_object('error',$4::text,'wikidot_revision_id',$5::bigint),
         $6::bytea, now(), now(), 3, now() + interval '7 days'
       )
       ON CONFLICT (page_id, kind, instance_id) DO UPDATE
         SET remote_value = EXCLUDED.remote_value,
             result_hash = EXCLUDED.result_hash,
             last_checked = now(),
             checks = meta.irreconcilable.checks + 1,
             next_review_at = now() + interval '7 days',
             resolved_at = NULL`,
      [
        candidateRow.pageId,
        candidateRow.revisionSeq,
        candidateRow.revisionSeq,
        outcome.error,
        candidateRow.wikidotRevisionId,
        outcome.resultHashHex ? Buffer.from(outcome.resultHashHex, 'hex') : null,
      ],
    );
    return 'irreconcilable';
  });
}

export async function releaseRevisionSourceClaims(
  pool: Pool,
  revisionSeqs: readonly number[],
  workerId: string,
): Promise<number> {
  if (revisionSeqs.length === 0) return 0;
  const result = await query(
    pool,
    'revision_source:release_claims',
    `UPDATE meta.revision_source_backfill_job
        SET status = 'retry', locked_by = NULL, locked_at = NULL,
            not_before = now(),
            -- 未形成上游结果（进程停止/我方写冻结）不能白烧 attempt。
            attempts = GREATEST(0, attempts - 1),
            updated_at = now()
      WHERE revision_seq = ANY($1::bigint[])
        AND status = 'processing' AND locked_by = $2`,
    [revisionSeqs, workerId],
  );
  return result.rowCount ?? 0;
}

/** 在抓取前读取 effective 写闸，避免明知写不进去仍消耗网络与队列 attempt。 */
export async function activeRevisionSourceWriteFreezes(
  pool: Pool,
): Promise<string[]> {
  const result = await query<{ domain: string }>(
    pool,
    'revision_source:write_freeze_preflight',
    `SELECT domain
       FROM meta.write_freeze_status()
      WHERE domain = ANY($1::text[]) AND effective
      ORDER BY domain`,
    [['revision', 'content']],
  );
  return result.rows.map((row) => row.domain);
}

/** PGF01 已回滚事实事务；在新事务补一条不带分母的冻结跳过证据。 */
export async function noteRevisionSourceFreezeSkip(
  pool: Pool,
  runId: number | null,
  candidateRow: RevisionSourceCandidate,
  error: string,
): Promise<void> {
  await query(
    pool,
    'revision_source:note_freeze_skip',
    `SELECT meta.note_freeze_skip(
       $1::bigint, $2::int, 'revision_source', 'revision', $3::text
     )`,
    [runId, candidateRow.pageId, error],
  );
}

export async function recordRevisionSourcePageScan(
  pool: Pool,
  args: {
    runId: number | null;
    pageId: number;
    claimed: number;
    fetched: number;
    errors: string[];
    resultHashes: string[];
  },
): Promise<void> {
  const status =
    args.errors.length === 0 ? 'ok' : args.fetched === 0 ? 'failed' : 'partial';
  const resultHash =
    args.resultHashes.length === 0
      ? null
      : createHash('sha256')
          .update([...args.resultHashes].sort().join('\n'), 'utf8')
          .digest();
  await recordPageScan(
    pool,
    {
      runId: args.runId,
      pageId: args.pageId,
      kind: 'revision_source',
      status,
      claimedTotal: args.claimed,
      fetchedTotal: args.fetched,
      resultHash,
      error: args.errors.length === 0 ? null : args.errors.slice(0, 10).join('；'),
    },
  );
}

export async function writePilotGate(
  pool: Pool,
  args: {
    runId: number | null;
    sampleCount: number;
    exactMatches: number;
    failedCount: number;
    passed: boolean;
    detail: Record<string, unknown>;
  },
): Promise<void> {
  await query(
    pool,
    'revision_source:pilot_gate',
    `INSERT INTO meta.revision_source_pilot(
       parser_version, run_id, sample_count, exact_matches, failed_count,
       passed, anchor_interval, detail, checked_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,1,$7::jsonb,now())
     ON CONFLICT (parser_version) DO UPDATE
       SET run_id = EXCLUDED.run_id,
           sample_count = EXCLUDED.sample_count,
           exact_matches = EXCLUDED.exact_matches,
           failed_count = EXCLUDED.failed_count,
           passed = EXCLUDED.passed,
           anchor_interval = 1,
           detail = EXCLUDED.detail,
           checked_at = now()`,
    [
      REVISION_SOURCE_VERSION,
      args.runId,
      args.sampleCount,
      args.exactMatches,
      args.failedCount,
      args.passed,
      toPgJson(args.detail, 'revision_source.pilot_gate'),
    ],
  );
}

export async function assertPilotPassed(pool: Pool): Promise<void> {
  const result = await query<{
    passed: boolean;
    sample_count: number;
    exact_matches: number;
    failed_count: number;
  }>(
    pool,
    'revision_source:pilot_check',
    `SELECT passed, sample_count, exact_matches, failed_count
       FROM meta.revision_source_pilot
      WHERE parser_version = $1
        AND anchor_interval = 1`,
    [REVISION_SOURCE_VERSION],
  );
  const row = result.rows[0];
  if (
    !row?.passed ||
    Number(row.sample_count) < 1_000 ||
    Number(row.exact_matches) < 1_000 ||
    Number(row.failed_count) !== 0
  ) {
    throw new Error(
      `长跑门禁未通过：version=${REVISION_SOURCE_VERSION}，` +
        '需要先完成 1000/1000 全文抓取、落库与逐字节回读 pilot',
    );
  }
}

export async function realtimeCollectionActive(pool: Pool): Promise<string[]> {
  const result = await query<{ mode: string }>(
    pool,
    'revision_source:realtime_active',
    `SELECT DISTINCT COALESCE(stats->>'mode','unknown') AS mode
       FROM meta.ingest_run
      WHERE status = 'running'
        AND started_at > now() - interval '2 hours'
        AND source = 'wikidot_listpages'`,
  );
  return result.rows.map((row) => row.mode);
}

export async function refreshRevisionSourceProgress(
  pool: Pool,
  totalCount: number,
  shard = REVISION_SOURCE_VERSION,
): Promise<void> {
  await query(
    pool,
    'revision_source:progress',
    `INSERT INTO meta.backfill_progress(
       domain, shard, last_page_id, done_count, total_count, updated_at
     )
     SELECT $1, $2,
            COALESCE(max(page_id) FILTER (WHERE status = 'done'), 0),
            count(*) FILTER (WHERE status = 'done'),
            $3::bigint,
            now()
       FROM meta.revision_source_backfill_job
     ON CONFLICT (domain, shard) DO UPDATE
       SET last_page_id = EXCLUDED.last_page_id,
           done_count = EXCLUDED.done_count,
           total_count = EXCLUDED.total_count,
           updated_at = now()`,
    [REVISION_SOURCE_DOMAIN, shard, totalCount],
  );
}

export interface RevisionSourceStorageStats {
  databaseBytes: number;
  contentBlobRelationBytes: number;
  queued: number;
  done: number;
  retry: number;
  irreconcilable: number;
  skippedDeleted: number;
  unavailable: number;
  uniqueSourceShas: number;
  sourceBytes: number;
  responseBytes: number;
  blobsInserted: number;
}

export async function loadRevisionSourceStorageStats(
  pool: Pool,
): Promise<RevisionSourceStorageStats> {
  const result = await query<Record<string, string | number>>(
    pool,
    'revision_source:storage_stats',
    `SELECT pg_database_size(current_database()) AS database_bytes,
            pg_total_relation_size('ingest.content_blob') AS content_blob_relation_bytes,
            count(*) AS queued,
            count(*) FILTER (WHERE status = 'done') AS done,
            count(*) FILTER (WHERE status = 'retry') AS retry,
            count(*) FILTER (WHERE status = 'irreconcilable') AS irreconcilable,
            count(*) FILTER (WHERE status = 'skipped_deleted') AS skipped_deleted,
            count(*) FILTER (WHERE status = 'unavailable') AS unavailable,
            count(DISTINCT source_sha) FILTER (WHERE status = 'done') AS unique_source_shas,
            COALESCE(sum(source_bytes) FILTER (WHERE status = 'done'), 0) AS source_bytes,
            COALESCE(sum(response_bytes) FILTER (WHERE status = 'done'), 0) AS response_bytes,
            count(*) FILTER (WHERE status = 'done' AND blob_inserted) AS blobs_inserted
       FROM meta.revision_source_backfill_job`,
  );
  const row = result.rows[0] ?? {};
  return {
    databaseBytes: Number(row['database_bytes'] ?? 0),
    contentBlobRelationBytes: Number(row['content_blob_relation_bytes'] ?? 0),
    queued: Number(row['queued'] ?? 0),
    done: Number(row['done'] ?? 0),
    retry: Number(row['retry'] ?? 0),
    irreconcilable: Number(row['irreconcilable'] ?? 0),
    skippedDeleted: Number(row['skipped_deleted'] ?? 0),
    unavailable: Number(row['unavailable'] ?? 0),
    uniqueSourceShas: Number(row['unique_source_shas'] ?? 0),
    sourceBytes: Number(row['source_bytes'] ?? 0),
    responseBytes: Number(row['response_bytes'] ?? 0),
    blobsInserted: Number(row['blobs_inserted'] ?? 0),
  };
}
