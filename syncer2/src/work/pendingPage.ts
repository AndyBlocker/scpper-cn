import type { Pool, PoolClient } from 'pg';

import type { ClaimedPending, PendingResolution } from '../store/queues.js';
import {
  finishPendingPage,
  lookupIdentityByWikidotId,
  registerPage,
} from '../store/queues.js';

type PgExecutor = Pool | PoolClient;

const RESTRICTED_REVIEW_MS = 4 * 60 * 60_000;
const TERMINAL_REVIEW_MS = 7 * 24 * 60 * 60_000;
const TRANSIENT_ATTEMPTS = 4;

export interface RestrictedV1Identity {
  v1PageId: number;
  wikidotId: number;
  /** v1 的历史 URL 口径；adult: 前缀在 v1 被剥掉。 */
  legacySlug: string;
  sourceUrl: string;
}

export interface RestrictedResolution {
  pageId: number;
  newlyRegistered: boolean;
  source: 'restricted_listpages_v1_reuse';
}

/**
 * v1 对受限分类沿用了历史 URL 口径：adult:foo → foo，
 * wanderers-adult:foo → wanderers:foo。这个映射只用于只读身份交叉验证，
 * 新铸的 v2 slug 仍保留 ListPages 给出的完整 fullname。
 */
export function restrictedLegacySlug(slug: string): string | null {
  const lower = slug.toLowerCase();
  if (lower.startsWith('adult:') && lower.length > 'adult:'.length) {
    return lower.slice('adult:'.length);
  }
  if (lower.startsWith('wanderers-adult:') && lower.length > 'wanderers-adult:'.length) {
    return `wanderers:${lower.slice('wanderers-adult:'.length)}`;
  }
  return null;
}

export function isRestrictedListPagesPending(row: Pick<ClaimedPending, 'slug' | 'reasons'>): boolean {
  return restrictedLegacySlug(row.slug) !== null && row.reasons.some((reason) =>
    reason === 'listpages_fullname_without_identity'
    || reason === 'listpages_new_fullname'
    || reason === 'l1_full_site_unresolved'
  );
}

/**
 * 匿名整页 GET 对受限分类只会回显 category:_public，不能复核目标身份。
 * ListPages fullname + v1 强制只读的唯一 live URL/wikidotId 是这类页面的合法证据链。
 */
export async function resolveRestrictedPendingPage(
  db: PgExecutor,
  row: ClaimedPending,
  candidate: RestrictedV1Identity,
  observedAt: string,
  runId: number | null,
): Promise<RestrictedResolution> {
  const expectedLegacy = restrictedLegacySlug(row.slug);
  if (expectedLegacy === null || !isRestrictedListPagesPending(row)) {
    throw new Error(`restricted fallback 拒绝非受限/ListPages 项：${row.slug}`);
  }
  if (candidate.legacySlug !== expectedLegacy) {
    throw new Error(
      `restricted fallback v1 URL 不匹配：pending=${row.slug}, `
      + `expected=${expectedLegacy}, actual=${candidate.legacySlug}`,
    );
  }
  if (row.wikidotId !== null && row.wikidotId !== candidate.wikidotId) {
    throw new Error(
      `restricted fallback wikidot_id 冲突：pending=${row.wikidotId}, v1=${candidate.wikidotId}`,
    );
  }

  const existing = await lookupIdentityByWikidotId(db, candidate.wikidotId);
  let pageId: number;
  let newlyRegistered = false;
  if (existing === null) {
    pageId = await registerPage(db, {
      wikidotId: candidate.wikidotId,
      slug: row.slug,
      observedAt,
      source: 'restricted_listpages_v1_reuse',
      runId,
    });
    newlyRegistered = true;
  } else {
    pageId = existing.pageId;
    // 冷启动保留 v1 page.id；未来 v2 自铸身份则只要求 wikidotId 唯一映射，
    // 不强迫两个库的内部 surrogate id 永远相同。
    if (existing.currentSlug !== row.slug && existing.currentSlug !== expectedLegacy) {
      throw new Error(
        `restricted fallback v2 当前 slug 冲突：pending=${row.slug}, current=${existing.currentSlug}`,
      );
    }
  }

  await finishPendingPage(db, {
    slug: row.slug,
    status: 'resolved',
    wikidotId: candidate.wikidotId,
    pageId,
    observedSlug: row.slug,
    error: null,
    resolutionSource: 'restricted_listpages_v1_reuse',
    resolutionEvidence: {
      listpagesFullname: row.slug,
      legacySlug: candidate.legacySlug,
      v1PageId: candidate.v1PageId,
      v1WikidotId: candidate.wikidotId,
      v1ReadOnly: true,
      sourceUrl: candidate.sourceUrl,
      v2IdentityReused: !newlyRegistered,
    },
  });
  return { pageId, newlyRegistered, source: 'restricted_listpages_v1_reuse' };
}

export function waitingForRestrictedEvidence(
  slug: string,
  now = Date.now(),
  error = '受限分类等待 ListPages + v1 只读身份交叉证据',
): PendingResolution {
  return {
    slug,
    status: 'waiting_evidence',
    error,
    notBefore: new Date(now + RESTRICTED_REVIEW_MS).toISOString(),
    resolutionSource: 'restricted_listpages_v1_wait',
    resolutionEvidence: { reviewIntervalHours: RESTRICTED_REVIEW_MS / 3_600_000 },
  };
}

/** 短退避失败四次后转为低频复查；两种状态都仍有明确的下次调度。 */
export function pendingFailureResolution(
  slug: string,
  attempts: number,
  error: string,
  httpStatus: number | null = null,
  now = Date.now(),
): PendingResolution {
  if (attempts < TRANSIENT_ATTEMPTS) {
    const ladder = [60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000];
    const delay = ladder[Math.max(0, attempts - 1)] ?? ladder.at(-1)!;
    return {
      slug,
      status: 'retry',
      httpStatus,
      error,
      notBefore: new Date(now + delay).toISOString(),
      resolutionSource: 'transient_retry',
      resolutionEvidence: { attempts, maxTransientAttempts: TRANSIENT_ATTEMPTS },
    };
  }
  return {
    slug,
    status: 'irreconcilable',
    httpStatus,
    error,
    notBefore: new Date(now + TERMINAL_REVIEW_MS).toISOString(),
    resolutionSource: 'retry_exhausted_weekly_review',
    resolutionEvidence: { attempts, reviewIntervalDays: TERMINAL_REVIEW_MS / 86_400_000 },
  };
}

export function identityConflictResolution(
  row: Pick<ClaimedPending, 'slug' | 'attempts'>,
  observedSlug: string,
  wikidotId: number,
  httpStatus: number,
  now = Date.now(),
): PendingResolution {
  return {
    slug: row.slug,
    status: 'conflict',
    wikidotId,
    observedSlug,
    httpStatus,
    error: `pageUnixName=${observedSlug} ≠ 请求 slug=${row.slug}，身份冲突，拒绝注册`,
    notBefore: new Date(now + TERMINAL_REVIEW_MS).toISOString(),
    resolutionSource: 'wikidot_identity_conflict',
    resolutionEvidence: {
      requestedSlug: row.slug,
      observedSlug,
      wikidotId,
      attempts: row.attempts,
      reviewIntervalDays: TERMINAL_REVIEW_MS / 86_400_000,
    },
  };
}
