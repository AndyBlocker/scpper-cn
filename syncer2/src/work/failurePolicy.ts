import { createHash } from 'node:crypto';

import type { ScanTaskKind } from '../store/meta.js';
import type { ClaimedWorkTask } from '../store/workQueue.js';

export type WorkFailureFamily =
  | 'identity_absent'
  | 'transient'
  | 'structural'
  | 'prerequisite';

export type WorkFailureAction = 'review_identity' | 'retry' | 'irreconcilable';

export interface WorkFailurePolicy {
  family: WorkFailureFamily;
  signature: string;
  action: WorkFailureAction;
  /** null 表示该签名永不触发身份复核。 */
  identityReviewThreshold: number | null;
  rationale: string;
}

const PAGE_BOUND_KINDS = new Set<ScanTaskKind>([
  'votes_full',
  'new_page_highfreq',
  'content',
  'revisions_full',
  'files',
]);

/**
 * 失败签名是调度决策，不是错误文案的同义词。
 *
 * 只有 page-bound AMC 的“无页面实体”形状（null/空 body、空体 HTTP 500、明确 no_page）
 * 才把阈值设为 1。503、超时、reset、带正文 5xx 都可能自行恢复，永不为它们额外请求
 * slug。结构性拒绝靠重试不会变好，直接进 irreconcilable，等待代码/契约修复后的周复查。
 */
export function classifyWorkFailure(kind: ScanTaskKind, error: string): WorkFailurePolicy {
  const normalized = error.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();

  if (isTransientFailure(lower)) {
    return {
      family: 'transient',
      signature: transientSignature(lower),
      action: 'retry',
      identityReviewThreshold: null,
      rationale: '传输、限流或有正文的服务端故障可能自行恢复；保留指数退避且不付身份解析成本',
    };
  }

  if (
    (isPageIdentityBoundFailure(kind, lower) || /pageid 身份不一致/.test(lower)) &&
    isDirectMissingIdentity(lower)
  ) {
    return {
      family: 'identity_absent',
      signature: directIdentitySignature(lower),
      action: 'review_identity',
      identityReviewThreshold: 1,
      rationale: 'page-bound AMC 对旧 pageId 的空实体是身份不存在的直接证据；首次即按 slug 复核',
    };
  }

  if (isPrerequisiteFailure(lower)) {
    return {
      family: 'prerequisite',
      signature: prerequisiteSignature(lower),
      action: 'retry',
      identityReviewThreshold: null,
      rationale: '前置 L1/本地证据可由后续完整轮补齐，不是页面身份结论',
    };
  }

  return {
    family: 'structural',
    signature: structuralSignature(kind, lower),
    action: 'irreconcilable',
    identityReviewThreshold: null,
    rationale: '解析结构、权限或本地不变量在相同代码下重试不会改变；直接隔离等待修复',
  };
}

function isPageIdentityBoundFailure(kind: ScanTaskKind, error: string): boolean {
  if (PAGE_BOUND_KINDS.has(kind)) return true;
  if (kind !== 'forum' && kind !== 'discussion') return false;
  // discussion 的第一跳 CommentsList 带 pageId；其共享 ForumStart 前置和后续 thread/post
  // 模块不带 pageId，不能拿那些模块的失败去复核页面身份。
  return !/forumstartmodule|forumviewcategorymodule|forumviewthreadmodule|forumpostsmodule/.test(error);
}

export function workFailureHash(policy: WorkFailurePolicy): Buffer {
  return createHash('sha256')
    .update(`work_failure:v1\n${policy.family}\n${policy.signature}`, 'utf8')
    .digest();
}

/** 按“同一签名”计连续次数；换签名必须从 1 重新算，不能复用统一 attempts。 */
export function failureSignatureCount(
  task: Pick<ClaimedWorkTask, 'stableCount' | 'lastResultHash'>,
  policy: WorkFailurePolicy,
): number {
  const hash = workFailureHash(policy);
  return task.lastResultHash !== null && task.lastResultHash.equals(hash)
    ? task.stableCount + 1
    : 1;
}

export function identityReviewDue(
  task: Pick<ClaimedWorkTask, 'stableCount' | 'lastResultHash'>,
  policy: WorkFailurePolicy,
): boolean {
  return policy.action === 'review_identity' &&
    policy.identityReviewThreshold !== null &&
    failureSignatureCount(task, policy) >= policy.identityReviewThreshold;
}

/** 把“是否值得多打一条 slug GET”的边界集中在这里，便于断言瞬时故障零额外请求。 */
export async function reviewIdentityIfDue<T>(
  task: Pick<ClaimedWorkTask, 'stableCount' | 'lastResultHash'>,
  policy: WorkFailurePolicy,
  review: () => Promise<T>,
): Promise<T | null> {
  return identityReviewDue(task, policy) ? review() : null;
}

function isTransientFailure(error: string): boolean {
  if (/\bhttp (?:429|502|503|504)\b/.test(error)) return true;
  if (/\bstatus=(?:try_again|retry|temporarily_unavailable)\b/.test(error)) return true;
  if (/transport (?:timeout|reset|other)|circuit open|econnreset|etimedout|socket hang up/.test(error)) {
    return true;
  }
  // pageId 缺失的实测 500 是空响应；有 `::` 错误正文的 500 仍按瞬时服务端故障处理。
  if (/\bhttp 500 for \S+\s+::\s*\S/.test(error)) return true;
  if (/\bhttp 5\d\d\b/.test(error) && !/\bhttp 500 for \S+(?:$|[；，。])/.test(error)) {
    return true;
  }
  return false;
}

function isDirectMissingIdentity(error: string): boolean {
  return /(?:status=ok|status ok).*body(?:=null| null| 缺失| 为空)/.test(error) ||
    /\bbody(?:=null| null| 缺失| 为空).*不是合法/.test(error) ||
    /\bhttp 500 for \S+(?:$|[；，。])/.test(error) ||
    /\bstatus=(?:no_page|not_found)\b/.test(error) ||
    /who(?:rated)? body 为空/.test(error) ||
    /pageid 身份不一致/.test(error);
}

function isPrerequisiteFailure(error: string): boolean {
  return /缺少成功 l1|claimed_total 非法|claimed_rating|tier1.*证据/.test(error)
    || /restrictedsessionunavailable|受限源码.*emptyresult=false|登录 session 不可用/.test(error);
}

function transientSignature(error: string): string {
  if (/\bhttp 429\b/.test(error)) return 'http_429';
  if (/\bhttp 503\b/.test(error)) return 'http_503';
  if (/\bhttp 5\d\d\b/.test(error)) return `http_${/\bhttp (5\d\d)\b/.exec(error)?.[1] ?? '5xx'}`;
  if (/timeout|etimedout/.test(error)) return 'transport_timeout';
  if (/reset|econnreset|socket hang up/.test(error)) return 'transport_reset';
  if (/circuit open/.test(error)) return 'circuit_open';
  return 'transport_or_remote_retryable';
}

function directIdentitySignature(error: string): string {
  if (/pageid 身份不一致/.test(error)) return 'slug_identity_mismatch';
  if (/\bhttp 500\b/.test(error)) return 'page_bound_amc_http_500_empty';
  if (/\bstatus=(?:no_page|not_found)\b/.test(error)) return 'page_bound_amc_no_page';
  return 'page_bound_amc_empty_entity';
}

function prerequisiteSignature(error: string): string {
  if (/缺少成功 l1|tier1.*证据/.test(error)) return 'missing_l1_claim';
  if (/restrictedsessionunavailable|受限源码.*emptyresult=false|登录 session 不可用/.test(error)) {
    return 'restricted_session_unavailable';
  }
  return 'invalid_remote_claim';
}

function structuralSignature(kind: ScanTaskKind, error: string): string {
  const marker = [
    '解析不出',
    '结构锚点',
    '缺少',
    '没有',
    '重复',
    '错位',
    '非法',
    'no_permission',
    'not_ok',
  ].find((value) => error.includes(value)) ?? 'unclassified_deterministic';
  return `${kind}:${marker}`;
}
