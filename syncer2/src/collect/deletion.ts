/**
 * M7 删除推断协议。
 *
 * 删除不是“本轮没看到”就成立，而是：
 *   1. sitemap full 与 ListPages 两个独立枚举源都完整（status=ok、coverage>=0.98）；
 *   2. 同页连续两组完整双源轮次都未见，且两个 sitemap full 间隔至少跨过一个 TTL；
 *   3. 只入 confirm_deleted 队列；
 *   4. 消费者再做一次整页 GET，只有单点 HTTP 404 才调用 apply_page_life(deleted)。
 *
 * 任一轮 absence >500 或 >1.5% 都整轮熔断，不下任何确认任务。
 */

import type { Pool } from 'pg';

import type { HttpClient } from '../http/client.js';
import { fetchPageIdentity } from '../page/identity.js';
import { query, toPgTimestamptz } from '../store/db.js';
import {
  enqueueScanTasks,
  finishIngestRun,
  recordPageScan,
  startIngestRun,
} from '../store/meta.js';
import { toPgJson } from '../store/pgText.js';
import { backoffFrom } from '../store/queues.js';
import { mapWithConcurrency } from '../util/concurrency.js';

export const DELETION_MIN_COVERAGE = 0.98;
export const DELETION_MIN_CONSECUTIVE_RUNS = 2;
export const DELETION_ABSENCE_MAX_PAGES = 500;
export const DELETION_ABSENCE_MAX_RATIO = 0.015;
/** README 要求轮间隔跨过 sitemap 约 60 分钟 TTL，调度建议为 ≥2h。 */
export const DELETION_MIN_RUN_SEPARATION_MS = 2 * 60 * 60_000;
/** 每组 sitemap 枚举采用其之前最近的 ListPages 完整轮，最多容忍 6h 陈旧。 */
export const DELETION_LISTPAGES_MAX_AGE_MS = 6 * 60 * 60_000;

export interface DeletionEnumerationRun {
  id: number;
  source: string;
  mode: string | null;
  pageScanPolicy: string | null;
  usedFallback: boolean;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  pagesEnumerated: number | null;
  remoteTotal: number | null;
  remoteTotalSource: string | null;
  coverageRatio: number | null;
  batchesFailed: number | null;
}

export interface DeletionRunPair {
  sitemap: DeletionEnumerationRun;
  listpages: DeletionEnumerationRun;
}

export interface DeletionEvidence {
  current: DeletionRunPair;
  previous: DeletionRunPair;
}

export interface DeletionCandidate {
  pageId: number;
  wikidotId: number;
  slug: string;
}

export interface DeletionInferenceReport {
  eligible: boolean;
  reason: string;
  currentSitemapRunId: number;
  currentListPagesRunId: number | null;
  previousSitemapRunId: number | null;
  previousListPagesRunId: number | null;
  eligibleLivePages: number;
  currentAbsent: number;
  currentAbsentRatio: number;
  consecutiveAbsent: number;
  circuitTripped: boolean;
  tasksEnqueued: number;
  sampleAbsent: DeletionCandidate[];
}

export type DeletionConfirmation =
  | {
      status: 'ok';
      data: {
        deleted: boolean;
        httpStatus: number;
        evidence: 'http_404' | 'page_exists' | 'identity_mismatch';
      };
    }
  | { status: 'failed'; error: string; httpStatus: number | null };

export interface DeletionTarget {
  pageId: number;
  wikidotId: number;
  slug: string;
}

export interface ClaimedDeletionTask extends DeletionTarget {
  taskId: number;
  attempts: number;
  reasons: string[];
}

export interface ProcessDeletionResult {
  status: 'deleted' | 'exists' | 'failed';
  confirmation: DeletionConfirmation;
  evidence: DeletionEvidence | null;
  eventSeq: number | null;
  error?: string;
}

/** 双源 run 的纯门控，供数据库路径和离线负向测试共用。 */
export function validateDeletionRunPair(pair: DeletionRunPair): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  validateRun(pair.sitemap, 'sitemap', reasons);
  validateRun(pair.listpages, 'listpages', reasons);
  if (pair.sitemap.source !== 'wikidot_sitemap') {
    reasons.push(`sitemap source=${pair.sitemap.source}≠wikidot_sitemap`);
  }
  if (!isListPagesEnumerationRun(pair.listpages)) {
    reasons.push(`ListPages source=${pair.listpages.source} 不是独立枚举源`);
  }
  if (pair.sitemap.remoteTotalSource !== 'sitemap') {
    reasons.push(`sitemap remote_total_source=${pair.sitemap.remoteTotalSource ?? 'null'}`);
  }
  if (!['listpages_total', 'both'].includes(pair.listpages.remoteTotalSource ?? '')) {
    reasons.push(`ListPages remote_total_source=${pair.listpages.remoteTotalSource ?? 'null'}`);
  }
  if (pair.sitemap.mode !== 'full') reasons.push(`sitemap mode=${pair.sitemap.mode ?? 'null'}≠full`);
  if (pair.sitemap.pageScanPolicy !== 'all') {
    reasons.push(
      `sitemap page_scan=${pair.sitemap.pageScanPolicy ?? 'null'}≠all，逐页正证据不完整`,
    );
  }
  if (pair.sitemap.usedFallback) reasons.push('sitemap 使用命名 fallback，分片完整性不可证明');
  if (!['tier1', 'l1_votes'].includes(pair.listpages.mode ?? '')) {
    reasons.push(`ListPages mode=${pair.listpages.mode ?? 'null'} 不是完整枚举`);
  }
  const sitemapAt = Date.parse(pair.sitemap.startedAt);
  const listpagesAt = Date.parse(pair.listpages.startedAt);
  if (
    !Number.isFinite(sitemapAt) ||
    !Number.isFinite(listpagesAt) ||
    listpagesAt > sitemapAt ||
    sitemapAt - listpagesAt > DELETION_LISTPAGES_MAX_AGE_MS
  ) {
    reasons.push('ListPages 不是 sitemap 前 6h 内最近的独立完整枚举');
  }
  return { ok: reasons.length === 0, reasons };
}

export function evaluateAbsenceCircuit(
  absent: number,
  eligibleLivePages: number,
  maxPages = DELETION_ABSENCE_MAX_PAGES,
  maxRatio = DELETION_ABSENCE_MAX_RATIO,
): { tripped: boolean; ratio: number; reasons: string[] } {
  if (absent < 0 || eligibleLivePages < 0 || absent > eligibleLivePages) {
    throw new RangeError(`absence 计数非法：absent=${absent}, eligible=${eligibleLivePages}`);
  }
  const ratio = eligibleLivePages === 0 ? 0 : absent / eligibleLivePages;
  const reasons: string[] = [];
  if (absent > maxPages) reasons.push(`absence ${absent} > ${maxPages}`);
  if (ratio > maxRatio) reasons.push(`absence ratio ${ratio} > ${maxRatio}`);
  return { tripped: reasons.length > 0, ratio, reasons };
}

/**
 * 只有在两组完整双源枚举中都缺席，页面才进入下一道“期间无正证据”检查。
 * 保持为纯函数，确保单轮 L1 漏页这一关键反例与生产交集算法完全一致。
 */
export function intersectConsecutiveAbsences(
  current: readonly DeletionCandidate[],
  previous: readonly DeletionCandidate[],
): DeletionCandidate[] {
  const previousAbsentIds = new Set(previous.map((page) => page.pageId));
  return current.filter((page) => previousAbsentIds.has(page.pageId));
}

/** sitemap 枚举域已知排除项。缺席这些 slug 永远不构成删除证据。 */
export function isDeletionScopeSlug(slug: string): boolean {
  const normalized = slug.trim().toLowerCase();
  if (
    normalized === '' ||
    /^(?:deleted|forum|adult|wanderers-adult|fragment|component|theme|system):/.test(normalized)
  ) {
    return false;
  }
  // `_foo` 与 `category:_foo` 都属于 sitemap 隐藏页。
  return !/(^|:)_/.test(normalized);
}

/**
 * 在一个已成功结束的 sitemap full run 后执行。
 * 首次缺席只留在 run/page_scan 证据链；连续第二组完整双源缺席才入确认队列。
 */
export async function inferDeletionCandidates(
  pool: Pool,
  currentSitemapRunId: number,
): Promise<DeletionInferenceReport> {
  const empty = (
    reason: string,
    overrides: Partial<DeletionInferenceReport> = {},
  ): DeletionInferenceReport => ({
    eligible: false,
    reason,
    currentSitemapRunId,
    currentListPagesRunId: null,
    previousSitemapRunId: null,
    previousListPagesRunId: null,
    eligibleLivePages: 0,
    currentAbsent: 0,
    currentAbsentRatio: 0,
    consecutiveAbsent: 0,
    circuitTripped: false,
    tasksEnqueued: 0,
    sampleAbsent: [],
    ...overrides,
  });

  const currentSitemap = await loadRun(pool, currentSitemapRunId);
  if (!currentSitemap) return empty(`run ${currentSitemapRunId} 不存在`);
  const currentListpages = await findListPagesBefore(pool, currentSitemap.startedAt);
  if (!currentListpages) return empty('当前 sitemap 前 6h 内没有完整 ListPages 双源证据');
  const currentPair = { sitemap: currentSitemap, listpages: currentListpages };
  const currentGate = validateDeletionRunPair(currentPair);
  if (!currentGate.ok) {
    return empty(`当前双源门控失败：${currentGate.reasons.join('；')}`, {
      currentListPagesRunId: currentListpages.id,
    });
  }
  // 正证据不依赖上一轮，也不应因本轮稍后触发 absence 熔断而被搁置。
  await dismissRefutedTasks(pool, currentPair);

  // L2 每小时一轮，而安全 TTL 是 2h；取最近一个已经跨过 TTL 的完整 full。
  // 中间任意 L1/L2（含 partial）正观测仍会在下面逐页否决，不能靠跨轮选择跳过。
  const previousSitemap = await findPreviousSitemapRun(pool, currentSitemap);
  if (!previousSitemap) {
    return empty('还没有上一轮完整 sitemap full；本轮只建立首次 absence 证据', {
      currentListPagesRunId: currentListpages.id,
    });
  }
  const separation = Date.parse(currentSitemap.startedAt) - Date.parse(previousSitemap.startedAt);
  if (separation < DELETION_MIN_RUN_SEPARATION_MS) {
    return empty(
      `连续 full 间隔 ${Math.round(separation / 60_000)}min，未跨过 2h TTL 安全间隔`,
      {
        currentListPagesRunId: currentListpages.id,
        previousSitemapRunId: previousSitemap.id,
      },
    );
  }
  const previousListpages = await findListPagesBefore(pool, previousSitemap.startedAt);
  if (!previousListpages) {
    return empty('上一轮 sitemap 前 6h 内没有完整 ListPages 双源证据', {
      currentListPagesRunId: currentListpages.id,
      previousSitemapRunId: previousSitemap.id,
    });
  }
  const previousPair = { sitemap: previousSitemap, listpages: previousListpages };
  const previousGate = validateDeletionRunPair(previousPair);
  if (!previousGate.ok) {
    return empty(`上一组双源门控失败：${previousGate.reasons.join('；')}`, {
      currentListPagesRunId: currentListpages.id,
      previousSitemapRunId: previousSitemap.id,
      previousListPagesRunId: previousListpages.id,
    });
  }

  const eligible = await loadEligibleLivePages(pool);
  const currentAbsent = await filterAbsentFromPair(pool, eligible, currentPair);
  const circuit = evaluateAbsenceCircuit(currentAbsent.length, eligible.length);
  if (circuit.tripped) {
    const report = empty(`absence 熔断：${circuit.reasons.join('；')}`, {
      eligible: true,
      currentListPagesRunId: currentListpages.id,
      previousSitemapRunId: previousSitemap.id,
      previousListPagesRunId: previousListpages.id,
      eligibleLivePages: eligible.length,
      currentAbsent: currentAbsent.length,
      currentAbsentRatio: circuit.ratio,
      circuitTripped: true,
      sampleAbsent: currentAbsent.slice(0, 50),
    });
    await writeInferenceStats(pool, currentSitemapRunId, report);
    return report;
  }

  // 上一组也必须没有批量 absence。不能把一个曾经触发全站级异常的坏基线，
  // 与本轮少量 absence 取交集后伪装成“连续两轮可靠缺席”。
  const previousAbsent = await filterAbsentFromPair(pool, eligible, previousPair);
  const previousCircuit = evaluateAbsenceCircuit(previousAbsent.length, eligible.length);
  if (previousCircuit.tripped) {
    const report = empty(`上一组 absence 熔断：${previousCircuit.reasons.join('；')}`, {
      eligible: true,
      currentListPagesRunId: currentListpages.id,
      previousSitemapRunId: previousSitemap.id,
      previousListPagesRunId: previousListpages.id,
      eligibleLivePages: eligible.length,
      currentAbsent: currentAbsent.length,
      currentAbsentRatio: circuit.ratio,
      circuitTripped: true,
      sampleAbsent: previousAbsent.slice(0, 50),
    });
    await writeInferenceStats(pool, currentSitemapRunId, report);
    return report;
  }

  const priorAbsent = intersectConsecutiveAbsences(currentAbsent, previousAbsent);
  // 即使夹在两轮完整枚举之间的是一个失败/局部 run，其中的“看见了”仍是可靠正证据；
  // 不能跳过它拼出两次 absence。失败只不能提供负证据，不代表其正证据也作废。
  const consecutive = await filterWithoutPositiveObservationBetween(
    pool,
    priorAbsent,
    previousSitemap.startedAt,
    currentSitemap.startedAt,
  );
  const reasons = [
    'dual_source_absence',
    `sitemap_run:${currentSitemap.id}`,
    `listpages_run:${currentListpages.id}`,
    `previous_sitemap_run:${previousSitemap.id}`,
    `previous_listpages_run:${previousListpages.id}`,
  ];
  const tasksEnqueued = await enqueueScanTasks(
    pool,
    consecutive.map((page) => ({
      pageId: page.pageId,
      kind: 'confirm_deleted' as const,
      reasons,
      priority: 50,
    })),
  );

  const report: DeletionInferenceReport = {
    eligible: true,
    reason:
      consecutive.length === 0
        ? '双源完整；当前 absence 未连续满 2 轮，不下确认任务'
        : '双源完整且连续 2 轮 absence；仅下 confirm_deleted，尚未写 deleted 事实',
    currentSitemapRunId,
    currentListPagesRunId: currentListpages.id,
    previousSitemapRunId: previousSitemap.id,
    previousListPagesRunId: previousListpages.id,
    eligibleLivePages: eligible.length,
    currentAbsent: currentAbsent.length,
    currentAbsentRatio: circuit.ratio,
    consecutiveAbsent: consecutive.length,
    circuitTripped: false,
    tasksEnqueued,
    sampleAbsent: consecutive.slice(0, 50),
  };
  await writeInferenceStats(pool, currentSitemapRunId, report);
  return report;
}

/** 重新验证某个页确有连续两组双源 absence，供 404 应用前做最后一道 TOCTOU 防线。 */
export async function verifyDeletionEvidence(
  pool: Pool,
  pageId: number,
): Promise<DeletionEvidence | null> {
  const currentSitemap = await findLatestSitemapRun(pool);
  if (!currentSitemap) return null;
  const currentListpages = await findListPagesBefore(pool, currentSitemap.startedAt);
  const previousSitemap = await findPreviousSitemapRun(pool, currentSitemap);
  if (!currentListpages || !previousSitemap) return null;
  const separation = Date.parse(currentSitemap.startedAt) - Date.parse(previousSitemap.startedAt);
  if (separation < DELETION_MIN_RUN_SEPARATION_MS) return null;
  const previousListpages = await findListPagesBefore(pool, previousSitemap.startedAt);
  if (!previousListpages) return null;
  const evidence = {
    current: { sitemap: currentSitemap, listpages: currentListpages },
    previous: { sitemap: previousSitemap, listpages: previousListpages },
  };
  if (
    !validateDeletionRunPair(evidence.current).ok ||
    !validateDeletionRunPair(evidence.previous).ok
  ) {
    return null;
  }
  // 404 前不能只验证单页；两组任一发生全站级 absence 都必须让所有旧任务失效。
  const eligible = await loadEligibleLivePages(pool);
  const currentAbsent = await filterAbsentFromPair(pool, eligible, evidence.current);
  if (evaluateAbsenceCircuit(currentAbsent.length, eligible.length).tripped) return null;
  const previousAbsent = await filterAbsentFromPair(pool, eligible, evidence.previous);
  if (evaluateAbsenceCircuit(previousAbsent.length, eligible.length).tripped) return null;
  const candidate = intersectConsecutiveAbsences(currentAbsent, previousAbsent).find(
    (page) => page.pageId === pageId,
  );
  if (!candidate) return null;
  const uninterrupted = await filterWithoutPositiveObservationBetween(
    pool,
    [candidate],
    previousSitemap.startedAt,
    currentSitemap.startedAt,
  );
  return uninterrupted.length === 1 ? evidence : null;
}

/**
 * 完整现代 L1 只持久化缺席的小集合。observedSlugs 也作为正证据输入：即使某个
 * slug 因身份冲突暂时不能映射 page_id，也绝不能把它反推成 absence。
 */
export async function recordL1AbsenceObservations(
  pool: Pool,
  runId: number,
  observedAt: string,
  presentPageIds: readonly number[],
  observedSlugs: readonly string[],
): Promise<number> {
  const result = await query(
    pool,
    'deletion:record_l1_absence',
    `INSERT INTO meta.l1_absence_observation(run_id, page_id, slug, observed_at)
     SELECT $1::bigint, pc.page_id, pc.slug, $2::timestamptz
       FROM serve.page_current pc
       JOIN ingest.page p ON p.id = pc.page_id
      WHERE pc.status = 'live'
        AND pc.enumeration_scope = 'standard'
        AND p.created_at <= $2::timestamptz
        AND NOT (pc.page_id = ANY($3::int[]))
        AND NOT (pc.slug = ANY($4::text[]))
     ON CONFLICT (run_id, page_id) DO UPDATE
       SET slug = EXCLUDED.slug,
           observed_at = EXCLUDED.observed_at`,
    [runId, toPgTimestamptz(observedAt), presentPageIds, observedSlugs],
  );
  return result.rowCount ?? 0;
}

/** 整页 GET 的显式结果：合法存在、404 删除、解析/传输失败三者绝不混淆。 */
export async function confirmDeletedPage(
  http: HttpClient,
  baseUrl: string,
  target: DeletionTarget,
): Promise<DeletionConfirmation> {
  const outcome = await fetchPageIdentity(http, baseUrl, target.slug);
  if (outcome.kind === 'gone') {
    return { status: 'ok', data: { deleted: true, httpStatus: 404, evidence: 'http_404' } };
  }
  if (outcome.kind === 'ok') {
    if (outcome.identity.wikidotId !== target.wikidotId) {
      return {
        status: 'failed',
        httpStatus: outcome.httpStatus,
        error:
          `整页身份回显不一致：任务 wikidotId=${target.wikidotId}，` +
          `响应=${outcome.identity.wikidotId}；拒绝据此确认删除`,
      };
    }
    return {
      status: 'ok',
      data: { deleted: false, httpStatus: outcome.httpStatus, evidence: 'page_exists' },
    };
  }
  if (outcome.kind === 'mismatch') {
    return {
      status: 'ok',
      data: {
        deleted: false,
        httpStatus: outcome.httpStatus,
        evidence: 'identity_mismatch',
      },
    };
  }
  return { status: 'failed', httpStatus: outcome.httpStatus, error: outcome.error };
}

export async function confirmDeletedPages(
  http: HttpClient,
  baseUrl: string,
  targets: readonly DeletionTarget[],
  concurrency = 4,
): Promise<Map<number, DeletionConfirmation>> {
  assertUniquePageIds(targets);
  const pairs = await mapWithConcurrency(targets, concurrency, async (target) => [
    target.pageId,
    await confirmDeletedPage(http, baseUrl, target),
  ] as const);
  return new Map(pairs);
}

export async function claimDeletionTasks(
  pool: Pool,
  requestedLimit: number,
  workerId: string,
): Promise<ClaimedDeletionTask[]> {
  const limit = Math.min(50, Math.max(0, Math.floor(requestedLimit)));
  if (limit === 0) return [];
  const result = await query<{
    id: string;
    page_id: number;
    wikidot_id: number;
    slug: string;
    attempts: number;
    reasons: string[];
  }>(
    pool,
    'deletion:claim_tasks',
    `WITH picked AS (
       SELECT st.id
         FROM meta.scan_task st
         JOIN serve.page_current pc ON pc.page_id = st.page_id
        WHERE st.kind = 'confirm_deleted'
          AND pc.status = 'live'
          AND (st.not_before IS NULL OR st.not_before <= now())
          AND (st.locked_by IS NULL OR st.locked_at < now() - interval '30 minutes')
        ORDER BY st.priority DESC, st.id
        LIMIT $2
        FOR UPDATE OF st SKIP LOCKED
     ),
     claimed AS (
       UPDATE meta.scan_task st
          SET locked_by = $1, locked_at = now(), attempts = attempts + 1
         FROM picked
        WHERE st.id = picked.id
        RETURNING st.*
     )
     SELECT st.id::text, st.page_id, pc.wikidot_id, pc.slug, st.attempts, st.reasons
       FROM claimed st
       JOIN serve.page_current pc ON pc.page_id = st.page_id
      ORDER BY st.priority DESC, st.id`,
    [workerId, limit],
  );
  return result.rows.map((row) => ({
    taskId: Number(row.id),
    pageId: Number(row.page_id),
    wikidotId: Number(row.wikidot_id),
    slug: row.slug,
    attempts: Number(row.attempts),
    reasons: row.reasons ?? [],
  }));
}

/**
 * 处理一条确认任务。HTTP 200/身份重定向是“仍存在”的正证据，成功删除任务；
 * 只有 404 + 再验证连续双源 evidence 才调用 apply_page_life。
 */
export async function processDeletionTask(
  pool: Pool,
  http: HttpClient,
  baseUrl: string,
  task: ClaimedDeletionTask,
  confirmationRunId: number | null,
  workerId: string,
  observedAt: string,
): Promise<ProcessDeletionResult> {
  const confirmation = await confirmDeletedPage(http, baseUrl, task);
  if (confirmation.status === 'failed') {
    await retainDeletionTask(pool, task, workerId, observedAt);
    return {
      status: 'failed',
      confirmation,
      evidence: null,
      eventSeq: null,
      error: confirmation.error,
    };
  }

  await recordConfirmationScan(
    pool,
    confirmationRunId,
    task.pageId,
    confirmation.data.deleted ? 'confirmed_http_404' : confirmation.data.evidence,
  );
  if (!confirmation.data.deleted) {
    await deleteDeletionTask(pool, task.taskId, workerId);
    return { status: 'exists', confirmation, evidence: null, eventSeq: null };
  }

  const evidence = await verifyDeletionEvidence(pool, task.pageId);
  if (!evidence) {
    const error = 'HTTP 404，但连续两轮双源完整 absence 证据已失效；拒绝 apply_page_life';
    await retainDeletionTask(pool, task, workerId, observedAt);
    return { status: 'failed', confirmation, evidence: null, eventSeq: null, error };
  }
  if (confirmationRunId === null) {
    const error = 'HTTP 404 且 absence 证据有效，但确认 run_id 缺失；拒绝写 deleted 事实';
    await retainDeletionTask(pool, task, workerId, observedAt);
    return { status: 'failed', confirmation, evidence, eventSeq: null, error };
  }

  try {
    // 通用 work-queue run 在整批结束前必然仍是 running；apply_page_life 的数据库红线
    // 正确要求删除所引用的 run 已经 status=ok。为本页 404 签发一个独立、已结束的
    // 身份确认 run，不能靠放宽生命周期函数去接受“未来也许失败”的父 run。
    const certificateRunId = await createDeletionConfirmationCertificate(
      pool,
      task.pageId,
      confirmationRunId,
      observedAt,
    );
    const applied = await query<{ seq: string | number | null }>(
      pool,
      'deletion:apply_page_life',
      `SELECT ingest.apply_page_life(
         $1, 'deleted', $2::timestamptz, 'inferred',
         $2::timestamptz, 'wikidot', $3, $4, $5::real
       ) AS seq`,
      [
        task.pageId,
        toPgTimestamptz(observedAt),
        certificateRunId,
        task.wikidotId,
        DELETION_MIN_COVERAGE,
      ],
    );
    await deleteDeletionTask(pool, task.taskId, workerId);
    const seq = applied.rows[0]?.seq;
    return {
      status: 'deleted',
      confirmation,
      evidence,
      eventSeq: seq === null || seq === undefined ? null : Number(seq),
    };
  } catch (err) {
    if (pgCode(err) === 'PGF01' && confirmationRunId !== null) {
      await query(
        pool,
        'deletion:note_freeze_skip',
        `SELECT meta.note_freeze_skip($1, $2, 'meta', 'page', $3)`,
        [confirmationRunId, task.pageId, String(err)],
      ).catch(() => undefined);
    }
    await retainDeletionTask(pool, task, workerId, observedAt);
    return {
      status: 'failed',
      confirmation,
      evidence,
      eventSeq: null,
      error: String(err),
    };
  }
}

export async function releaseDeletionTaskLocks(
  pool: Pool,
  taskIds: readonly number[],
  workerId: string,
): Promise<number> {
  if (taskIds.length === 0) return 0;
  const result = await query(
    pool,
    'deletion:release_locks',
    `UPDATE meta.scan_task
        SET locked_by = NULL,
            locked_at = NULL,
            not_before = COALESCE(not_before, now() + interval '1 hour')
      WHERE id = ANY($1::bigint[]) AND locked_by = $2`,
    [taskIds, workerId],
  );
  return result.rowCount ?? 0;
}

function validateRun(
  run: DeletionEnumerationRun,
  label: string,
  reasons: string[],
): void {
  if (run.status !== 'ok') reasons.push(`${label} status=${run.status}≠ok`);
  if (run.coverageRatio === null || run.coverageRatio < DELETION_MIN_COVERAGE) {
    reasons.push(`${label} coverage=${run.coverageRatio ?? 'null'}<${DELETION_MIN_COVERAGE}`);
  }
  if (run.batchesFailed !== 0) reasons.push(`${label} batches_failed=${run.batchesFailed ?? 'null'}≠0`);
  if ((run.remoteTotal ?? 0) <= 0) reasons.push(`${label} remote_total 缺失`);
}

async function loadRun(pool: Pool, id: number): Promise<DeletionEnumerationRun | null> {
  const result = await query<RunRow>(
    pool,
    'deletion:load_run',
    `${RUN_SELECT} WHERE ir.id = $1`,
    [id],
  );
  return result.rows[0] ? mapRun(result.rows[0]) : null;
}

async function findLatestSitemapRun(pool: Pool): Promise<DeletionEnumerationRun | null> {
  const result = await query<RunRow>(
    pool,
    'deletion:latest_sitemap',
    `${RUN_SELECT}
      WHERE ir.source = 'wikidot_sitemap'
        AND ir.stats ->> 'mode' = 'full'
        AND ir.status = 'ok'
        AND ir.coverage_ratio >= $1
        AND ir.batches_failed = 0
      ORDER BY ir.started_at DESC, ir.id DESC
      LIMIT 1`,
    [DELETION_MIN_COVERAGE],
  );
  return result.rows[0] ? mapRun(result.rows[0]) : null;
}

async function findPreviousSitemapRun(
  pool: Pool,
  current: DeletionEnumerationRun,
): Promise<DeletionEnumerationRun | null> {
  const result = await query<RunRow>(
    pool,
    'deletion:previous_sitemap',
    `${RUN_SELECT}
      WHERE ir.source = 'wikidot_sitemap'
        AND ir.stats ->> 'mode' = 'full'
        AND ir.status = 'ok'
        AND ir.coverage_ratio >= $1
        AND ir.batches_failed = 0
        AND (ir.started_at, ir.id) < ($2::timestamptz, $3::bigint)
        AND ir.started_at <= $2::timestamptz - interval '2 hours'
      ORDER BY ir.started_at DESC, ir.id DESC
      LIMIT 1`,
    [DELETION_MIN_COVERAGE, current.startedAt, current.id],
  );
  return result.rows[0] ? mapRun(result.rows[0]) : null;
}

async function findListPagesBefore(
  pool: Pool,
  before: string,
): Promise<DeletionEnumerationRun | null> {
  const result = await query<RunRow>(
    pool,
    'deletion:listpages_pair',
    `${RUN_SELECT}
      WHERE (
          (ir.source = 'wikidot_listpages'
           AND ir.stats ->> 'mode' = 'l1_votes'
           AND ir.stats ->> 'layer' = 'L1'
           AND ir.stats #>> '{coverage,scope}' = 'full'
           AND ir.stats #>> '{validation,complete}' = 'true')
          OR (ir.source = 'wikidot' AND ir.stats ->> 'mode' = 'tier1')
        )
        AND ir.status = 'ok'
        AND ir.coverage_ratio >= $1
        AND ir.batches_failed = 0
        AND ir.finished_at <= $2::timestamptz
        AND ir.started_at >= $2::timestamptz - interval '6 hours'
      ORDER BY ir.started_at DESC, ir.id DESC
      LIMIT 1`,
    [DELETION_MIN_COVERAGE, before],
  );
  return result.rows[0] ? mapRun(result.rows[0]) : null;
}

async function loadEligibleLivePages(pool: Pool): Promise<DeletionCandidate[]> {
  const result = await query<{ page_id: number; wikidot_id: number; slug: string }>(
    pool,
    'deletion:eligible_live',
    `SELECT page_id, wikidot_id, slug
       FROM serve.page_current
      WHERE status = 'live'
        AND enumeration_scope = 'standard'
      ORDER BY page_id`,
  );
  return result.rows
    .map((row) => ({
      pageId: Number(row.page_id),
      wikidotId: Number(row.wikidot_id),
      slug: row.slug,
    }))
    .filter((row) => isDeletionScopeSlug(row.slug));
}

async function filterAbsentFromPair(
  pool: Pool,
  pages: readonly DeletionCandidate[],
  pair: DeletionRunPair,
): Promise<DeletionCandidate[]> {
  if (pages.length === 0) return [];
  const ids = pages.map((page) => page.pageId);
  if (isModernL1Run(pair.listpages)) {
    const absent = await query<{ page_id: number }>(
      pool,
      'deletion:pair_absent_modern_l1',
      `SELECT a.page_id
         FROM meta.l1_absence_observation a
        WHERE a.run_id = $1
          AND a.page_id = ANY($2::int[])
          AND NOT EXISTS (
            SELECT 1
              FROM meta.page_scan ps
             WHERE ps.run_id = $3
               AND ps.page_id = a.page_id
               AND ps.kind = 'meta'
               AND ps.status = 'ok'
          )`,
      [pair.listpages.id, ids, pair.sitemap.id],
    );
    const absentIds = new Set(absent.rows.map((row) => Number(row.page_id)));
    return pages.filter((page) => absentIds.has(page.pageId));
  }
  const seen = await query<{ page_id: number }>(
    pool,
    'deletion:pair_seen_legacy_l1',
    `SELECT DISTINCT page_id
       FROM meta.page_scan
      WHERE run_id IN ($1, $2)
        AND kind = 'meta'
        AND status = 'ok'
        AND page_id = ANY($3::int[])`,
    [pair.sitemap.id, pair.listpages.id, ids],
  );
  const present = new Set(seen.rows.map((row) => Number(row.page_id)));
  return pages.filter((page) => !present.has(page.pageId));
}

async function filterWithoutPositiveObservationBetween(
  pool: Pool,
  pages: readonly DeletionCandidate[],
  after: string,
  before: string,
): Promise<DeletionCandidate[]> {
  if (pages.length === 0) return [];
  const seen = await query<{ page_id: number }>(
    pool,
    'deletion:intervening_positive',
    `SELECT DISTINCT positive.page_id
       FROM (
         SELECT ps.page_id, ir.started_at AS observed_at
           FROM meta.page_scan ps
           JOIN meta.ingest_run ir ON ir.id = ps.run_id
          WHERE ps.kind = 'meta' AND ps.status = 'ok'
         UNION ALL
         SELECT ips.page_id, ips.last_l1_seen_at
           FROM meta.incremental_page_state ips
          WHERE ips.page_id IS NOT NULL AND ips.last_l1_seen_at IS NOT NULL
         UNION ALL
         SELECT pvs.page_id, pvs.observed_at
           FROM meta.l1_partial_vote_state pvs
          WHERE pvs.page_id IS NOT NULL
       ) positive
      WHERE positive.page_id = ANY($1::int[])
        AND positive.observed_at > $2::timestamptz
        AND positive.observed_at < $3::timestamptz`,
    [pages.map((page) => page.pageId), after, before],
  );
  const positive = new Set(seen.rows.map((row) => Number(row.page_id)));
  return pages.filter((page) => !positive.has(page.pageId));
}

async function dismissRefutedTasks(pool: Pool, pair: DeletionRunPair): Promise<void> {
  if (isModernL1Run(pair.listpages)) {
    await query(
      pool,
      'deletion:dismiss_refuted_modern_l1',
      `DELETE FROM meta.scan_task st
        WHERE st.kind = 'confirm_deleted'
          AND st.locked_by IS NULL
          AND (
            EXISTS (
              SELECT 1 FROM meta.page_scan ps
               WHERE ps.page_id = st.page_id
                 AND ps.run_id = $1
                 AND ps.kind = 'meta'
                 AND ps.status = 'ok'
            )
            OR NOT EXISTS (
              SELECT 1 FROM meta.l1_absence_observation a
               WHERE a.page_id = st.page_id AND a.run_id = $2
            )
          )`,
      [pair.sitemap.id, pair.listpages.id],
    );
    return;
  }
  await query(
    pool,
    'deletion:dismiss_refuted',
    `DELETE FROM meta.scan_task st
      USING meta.page_scan ps
      WHERE st.kind = 'confirm_deleted'
        AND ps.page_id = st.page_id
        AND ps.run_id IN ($1, $2)
        AND ps.kind = 'meta'
        AND ps.status = 'ok'
        AND st.locked_by IS NULL`,
    [pair.sitemap.id, pair.listpages.id],
  );
}

async function writeInferenceStats(
  pool: Pool,
  runId: number,
  report: DeletionInferenceReport,
): Promise<void> {
  await query(
    pool,
    'deletion:write_stats',
    `UPDATE meta.ingest_run
        SET stats = jsonb_set(stats, '{deletionInference}', $2::jsonb, true)
      WHERE id = $1`,
    [runId, toPgJson(report, 'deletion.inference_stats')],
  );
}

async function recordConfirmationScan(
  pool: Pool,
  runId: number | null,
  pageId: number,
  note: string,
): Promise<void> {
  await recordPageScan(
    pool,
    {
      runId,
      pageId,
      kind: 'meta',
      status: 'ok',
      error: note,
    },
  );
}

async function createDeletionConfirmationCertificate(
  pool: Pool,
  pageId: number,
  parentRunId: number,
  observedAt: string,
): Promise<number> {
  const runId = await startIngestRun(pool, 'wikidot_page_identity', observedAt);
  if (runId === null) {
    throw new Error('无法创建 confirm_deleted 身份确认 run');
  }
  try {
    await recordConfirmationScan(pool, runId, pageId, 'confirmed_http_404');
    await finishIngestRun(pool, runId, {
      status: 'ok',
      finishedAt: new Date().toISOString(),
      pagesEnumerated: 1,
      remoteTotal: 1,
      remoteTotalSource: 'unknown',
      batchesTotal: 1,
      batchesFailed: 0,
      populationType: 'targeted_page_identity',
      stats: {
        mode: 'confirm_deleted',
        parentRunId,
        evidence: 'confirmed_http_404',
      },
    });
    return runId;
  } catch (err) {
    await finishIngestRun(pool, runId, {
      status: 'failed',
      finishedAt: new Date().toISOString(),
      pagesEnumerated: 0,
      remoteTotal: 1,
      remoteTotalSource: 'unknown',
      batchesTotal: 1,
      batchesFailed: 1,
      populationType: 'targeted_page_identity',
      stats: {
        mode: 'confirm_deleted',
        parentRunId,
        certificateError: String(err),
      },
    }).catch(() => undefined);
    throw err;
  }
}

async function deleteDeletionTask(pool: Pool, taskId: number, workerId: string): Promise<void> {
  await query(
    pool,
    'deletion:finish_success',
    `DELETE FROM meta.scan_task WHERE id = $1 AND locked_by = $2`,
    [taskId, workerId],
  );
}

async function retainDeletionTask(
  pool: Pool,
  task: ClaimedDeletionTask,
  workerId: string,
  now: string,
): Promise<void> {
  const next = backoffFrom(task.attempts, Date.parse(toPgTimestamptz(now)));
  await query(
    pool,
    'deletion:finish_retry',
    `UPDATE meta.scan_task
        SET not_before = $3::timestamptz,
            locked_by = NULL,
            locked_at = NULL
      WHERE id = $1 AND locked_by = $2`,
    [task.taskId, workerId, next],
  );
}

interface RunRow {
  id: string;
  source: string;
  mode: string | null;
  page_scan_policy: string | null;
  used_fallback: boolean | string | null;
  status: string;
  started_at: Date | string;
  finished_at: Date | string | null;
  pages_enumerated: number | null;
  remote_total: number | null;
  remote_total_source: string | null;
  coverage_ratio: number | null;
  batches_failed: number | null;
}

const RUN_SELECT = `
  SELECT ir.id::text, ir.source, ir.stats ->> 'mode' AS mode,
         ir.stats ->> 'pageScanPolicy' AS page_scan_policy,
         COALESCE((ir.stats ->> 'usedFallback')::boolean, false) AS used_fallback,
         ir.status,
         ir.started_at, ir.finished_at, ir.pages_enumerated, ir.remote_total,
         ir.remote_total_source, ir.coverage_ratio, ir.batches_failed
    FROM meta.ingest_run ir`;

function mapRun(row: RunRow): DeletionEnumerationRun {
  return {
    id: Number(row.id),
    source: row.source,
    mode: row.mode,
    pageScanPolicy: row.page_scan_policy,
    usedFallback: row.used_fallback === true || row.used_fallback === 'true',
    status: row.status,
    startedAt: iso(row.started_at),
    finishedAt: row.finished_at === null ? null : iso(row.finished_at),
    pagesEnumerated: row.pages_enumerated === null ? null : Number(row.pages_enumerated),
    remoteTotal: row.remote_total === null ? null : Number(row.remote_total),
    remoteTotalSource: row.remote_total_source,
    coverageRatio: row.coverage_ratio === null ? null : Number(row.coverage_ratio),
    batchesFailed: row.batches_failed === null ? null : Number(row.batches_failed),
  };
}

function isModernL1Run(run: DeletionEnumerationRun): boolean {
  return run.source === 'wikidot_listpages' && run.mode === 'l1_votes';
}

function isListPagesEnumerationRun(run: DeletionEnumerationRun): boolean {
  return isModernL1Run(run) || (run.source === 'wikidot' && run.mode === 'tier1');
}

function assertUniquePageIds(targets: readonly DeletionTarget[]): void {
  const ids = new Set<number>();
  for (const target of targets) {
    if (ids.has(target.pageId)) throw new Error(`删除确认目标 pageId 重复：${target.pageId}`);
    ids.add(target.pageId);
  }
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function pgCode(err: unknown): string | null {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
    ? String((err as { code: string }).code)
    : null;
}
