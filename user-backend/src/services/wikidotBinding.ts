import crypto from 'crypto';
import { prisma } from '../db.js';
import { Prisma, WikidotBindingStatus } from '@prisma/client';
import { invalidateAuthCache } from '../middleware/requireAuth.js';
import {
  isActionableBindingTaskStatus,
  isCompletableLatestBindingTask,
  validateBindingCompletionProof,
  type BindingCompletionProof
} from './wikidotBindingProof.js';

const VERIFICATION_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // Excluding 0/O, 1/I/L
const VERIFICATION_CODE_LENGTH = 6;
const TASK_TTL_HOURS = 48;
const SERIALIZABLE_RETRY_ATTEMPTS = 3;

// BFF base URL for resolving Wikidot users
const BFF_BASE_URL = process.env.BFF_BASE_URL || 'http://127.0.0.1:4396';
const BFF_INTERNAL_KEY = (process.env.BFF_INTERNAL_API_KEY || '').trim();
const BFF_INTERNAL_FETCH_TIMEOUT_MS = Math.max(1000, Math.floor(Number(process.env.BFF_INTERNAL_FETCH_TIMEOUT_MS ?? '4500') || 4500));

type BindingTransaction = Prisma.TransactionClient;

function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') {
    return true;
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('could not serialize access')
    || message.includes('serialization failure')
    || message.includes('deadlock detected')
    || message.includes('40001')
    || message.includes('40p01');
}

async function runBindingTransaction<T>(operation: (tx: BindingTransaction) => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 5000,
        timeout: 10_000
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === SERIALIZABLE_RETRY_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 25 * attempt)));
    }
  }
  throw lastError ?? new Error('绑定事务执行失败');
}

interface LockedAccountRow {
  id: string;
  linkedWikidotId: number | null;
}

interface LockedTaskRow {
  id: string;
  userId: string;
  wikidotUserId: number;
  verificationCode: string;
  status: WikidotBindingStatus;
  createdAt: Date;
  expiresAt: Date;
}

async function lockAccount(tx: BindingTransaction, userId: string): Promise<LockedAccountRow | null> {
  const rows = await tx.$queryRaw<LockedAccountRow[]>`
    SELECT id, "linkedWikidotId"
    FROM "UserAccount"
    WHERE id = ${userId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function lockTask(tx: BindingTransaction, taskId: string): Promise<LockedTaskRow | null> {
  const rows = await tx.$queryRaw<LockedTaskRow[]>`
    SELECT id, "userId", "wikidotUserId", "verificationCode", status,
           "createdAt", "expiresAt"
    FROM "WikidotBindingTask"
    WHERE id = ${taskId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

async function fetchBffInternal(pathnameWithQuery: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BFF_INTERNAL_FETCH_TIMEOUT_MS);
  try {
    return await fetch(`${BFF_BASE_URL}${pathnameWithQuery}`, {
      method: 'GET',
      signal: controller.signal,
      headers: BFF_INTERNAL_KEY
        ? { 'x-internal-key': BFF_INTERNAL_KEY }
        : undefined
    });
  } finally {
    clearTimeout(timer);
  }
}

export function generateVerificationCode(): string {
  let code = 'SCPPER-';
  for (let i = 0; i < VERIFICATION_CODE_LENGTH; i++) {
    code += VERIFICATION_CODE_CHARS.charAt(
      crypto.randomInt(VERIFICATION_CODE_CHARS.length)
    );
  }
  return code;
}

interface ResolvedWikidotUser {
  wikidotId: number;
  displayName: string | null;
  username: string | null;
}

export async function resolveWikidotUser(username: string): Promise<ResolvedWikidotUser | null> {
  let response: Response;
  try {
    response = await fetchBffInternal(`/internal/wikidot-user?username=${encodeURIComponent(username)}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[wikidotBinding] BFF unreachable:', err instanceof Error ? err.message : err);
    throw new Error('内部服务暂时不可用，请稍后再试');
  }

  const data = await response.json().catch(() => null) as unknown;

  if (!response.ok) {
    const errorType = data && typeof data === 'object' ? (data as { error?: string }).error : undefined;
    if (response.status === 409 && errorType === 'ambiguous') {
      throw new Error('该用户名匹配多个 Wikidot 用户，请使用更精确的用户名或联系管理员处理');
    }
    if (response.status >= 500) {
      // eslint-disable-next-line no-console
      console.error(`[wikidotBinding] BFF returned ${response.status} for wikidot-user lookup`);
      throw new Error('内部服务暂时不可用，请稍后再试');
    }
    return null;
  }

  const parsed = data as { ok?: boolean; user?: ResolvedWikidotUser };
  return parsed.ok && parsed.user ? parsed.user : null;
}

export async function resolveWikidotUserById(wikidotId: number): Promise<ResolvedWikidotUser | null> {
  let response: Response;
  try {
    response = await fetchBffInternal(`/internal/wikidot-user?wikidotId=${encodeURIComponent(String(wikidotId))}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[wikidotBinding] BFF unreachable:', err instanceof Error ? err.message : err);
    throw new Error('内部服务暂时不可用，请稍后再试');
  }

  const data = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    if (response.status >= 500) {
      // eslint-disable-next-line no-console
      console.error(`[wikidotBinding] BFF returned ${response.status} for wikidot-user-by-id lookup`);
      throw new Error('内部服务暂时不可用，请稍后再试');
    }
    return null;
  }

  const parsed = data as { ok?: boolean; user?: ResolvedWikidotUser };
  return parsed.ok && parsed.user ? parsed.user : null;
}

export async function searchWikidotUsers(query: string, limit: number = 8): Promise<ResolvedWikidotUser[]> {
  const normalizedLimit = Number.isFinite(limit) ? Math.min(Math.max(Math.floor(limit), 1), 20) : 8;

  let response: Response;
  try {
    response = await fetchBffInternal(
      `/internal/wikidot-user-search?query=${encodeURIComponent(query)}&limit=${encodeURIComponent(String(normalizedLimit))}`
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[wikidotBinding] BFF unreachable:', err instanceof Error ? err.message : err);
    throw new Error('内部服务暂时不可用，请稍后再试');
  }

  const data = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    if (response.status >= 500) {
      // eslint-disable-next-line no-console
      console.error(`[wikidotBinding] BFF returned ${response.status} for wikidot-user-search`);
      throw new Error('内部服务暂时不可用，请稍后再试');
    }
    return [];
  }

  const parsed = data as { ok?: boolean; users?: ResolvedWikidotUser[] };
  if (!parsed.ok || !Array.isArray(parsed.users)) return [];

  return parsed.users.filter((user) => Number.isFinite(user.wikidotId) && user.wikidotId > 0);
}

export interface StartBindingResult {
  task: {
    id: string;
    wikidotUserId: number;
    wikidotUsername: string | null;
    verificationCode: string;
    status: WikidotBindingStatus;
    expiresAt: Date;
  };
}

export async function startBindingTask(
  userId: string,
  payload: { wikidotUsername?: string; wikidotId?: number }
): Promise<StartBindingResult> {
  // Fail fast before the external lookup. The authoritative account check is
  // repeated under a row lock after lookup completes.
  const account = await prisma.userAccount.findUnique({
    where: { id: userId },
    select: { linkedWikidotId: true }
  });
  if (!account) {
    throw new Error('用户不存在');
  }
  if (account.linkedWikidotId !== null) {
    throw new Error('你已绑定 Wikidot 账号，如需更换请先联系管理员解绑');
  }

  // Resolve Wikidot username to ID outside the transaction so a slow BFF call
  // never holds a database lock.
  const wikidotUsername = payload.wikidotUsername?.trim() || '';
  const wikidotId = payload.wikidotId;

  let wikidotUser: ResolvedWikidotUser | null = null;
  let displayInput = '';
  if (wikidotId && Number.isFinite(wikidotId) && wikidotId > 0) {
    wikidotUser = await resolveWikidotUserById(wikidotId);
    displayInput = String(wikidotId);
  } else if (wikidotUsername) {
    wikidotUser = await resolveWikidotUser(wikidotUsername);
    displayInput = wikidotUsername;
  } else {
    throw new Error('请输入 Wikidot 用户名或 ID');
  }

  if (!wikidotUser) {
    throw new Error('未找到该 Wikidot 用户，请确认用户名正确且该用户在站点有活动记录');
  }

  // Generate a code, then serialize every state-changing step on the account
  // row. A second browser tab can cancel the first tab's task, but the database
  // can never contain two live tasks created concurrently for this account.
  const maxAttempts = 10;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const verificationCode = generateVerificationCode();
    try {
      return await runBindingTransaction(async (tx) => {
        const lockedAccount = await lockAccount(tx, userId);
        if (!lockedAccount) {
          throw new Error('用户不存在');
        }
        if (lockedAccount.linkedWikidotId !== null) {
          throw new Error('你已绑定 Wikidot 账号，如需更换请先联系管理员解绑');
        }

        // Recheck the target inside the serializable transaction. The unique
        // linkedWikidotId constraint is the final guard against a concurrent
        // completion on a different account.
        const existingLink = await tx.userAccount.findFirst({
          where: { linkedWikidotId: wikidotUser.wikidotId },
          select: { id: true }
        });
        if (existingLink) {
          throw new Error('该 Wikidot 账号已被其他用户绑定');
        }

        await tx.wikidotBindingTask.updateMany({
          where: {
            userId,
            status: WikidotBindingStatus.PENDING
          },
          data: { status: WikidotBindingStatus.CANCELLED }
        });

        const expiresAt = new Date(Date.now() + TASK_TTL_HOURS * 60 * 60 * 1000);
        const task = await tx.wikidotBindingTask.create({
          data: {
            userId,
            wikidotUserId: wikidotUser.wikidotId,
            wikidotUsername: wikidotUser.displayName || wikidotUser.username || displayInput,
            verificationCode,
            status: WikidotBindingStatus.PENDING,
            expiresAt
          }
        });

        return {
          task: {
            id: task.id,
            wikidotUserId: task.wikidotUserId,
            wikidotUsername: task.wikidotUsername,
            verificationCode: task.verificationCode,
            status: task.status,
            expiresAt: task.expiresAt
          }
        };
      });
    } catch (error) {
      // A verification-code collision aborts the transaction. Retry the whole
      // transaction with a fresh code; every other error must fail closed.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002' && attempt < maxAttempts) {
        continue;
      }
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new Error('无法生成验证码，请稍后重试');
      }
      throw error;
    }
  }
  throw new Error('无法生成验证码，请稍后重试');
}

export interface TaskStatus {
  id: string;
  wikidotUserId: number;
  wikidotUsername: string | null;
  verificationCode: string;
  status: WikidotBindingStatus;
  expiresAt: Date;
  lastCheckedAt: Date | null;
  checkCount: number;
  failureReason: string | null;
}

export async function getBindingTaskStatus(userId: string): Promise<TaskStatus | null> {
  const task = await prisma.wikidotBindingTask.findFirst({
    where: { userId },
    orderBy: [
      { createdAt: 'desc' },
      { id: 'desc' }
    ]
  });

  // Select the absolute latest task before checking status. Otherwise an older
  // PENDING/EXPIRED row could reappear after a newer task was cancelled/verified.
  if (!task || !isActionableBindingTaskStatus(task.status)) return null;

  // Auto-expire if needed
  if (task.status === WikidotBindingStatus.PENDING && task.expiresAt <= new Date()) {
    const expired = await prisma.wikidotBindingTask.updateMany({
      where: {
        id: task.id,
        userId,
        status: WikidotBindingStatus.PENDING,
        expiresAt: { lte: new Date() }
      },
      data: { status: WikidotBindingStatus.EXPIRED }
    });
    // A verifier/cancel request won the race. Never synthesize EXPIRED over its
    // terminal result; the public status endpoint should refresh auth instead.
    if (expired.count !== 1) return null;
    task.status = WikidotBindingStatus.EXPIRED;
  }

  return {
    id: task.id,
    wikidotUserId: task.wikidotUserId,
    wikidotUsername: task.wikidotUsername,
    verificationCode: task.verificationCode,
    status: task.status,
    expiresAt: task.expiresAt,
    lastCheckedAt: task.lastCheckedAt,
    checkCount: task.checkCount,
    failureReason: task.failureReason
  };
}

export async function cancelBindingTask(userId: string): Promise<boolean> {
  const task = await prisma.wikidotBindingTask.findFirst({
    where: { userId },
    orderBy: [
      { createdAt: 'desc' },
      { id: 'desc' }
    ],
    select: { id: true, status: true }
  });
  if (!task || !isActionableBindingTaskStatus(task.status)) return false;

  const cancelled = await prisma.wikidotBindingTask.updateMany({
    where: {
      id: task.id,
      userId,
      status: { in: [WikidotBindingStatus.PENDING, WikidotBindingStatus.EXPIRED] }
    },
    data: { status: WikidotBindingStatus.CANCELLED }
  });
  return cancelled.count > 0;
}

// Internal APIs for backend verification job

export interface PendingTask {
  id: string;
  userId: string;
  wikidotUserId: number;
  verificationCode: string;
  createdAt: Date;
  expiresAt: Date;
  checkCount: number;
  lastCheckedAt: Date | null;
}

export async function getPendingTasks(): Promise<PendingTask[]> {
  // Keep task states consistent: pending tasks past expiry should be marked EXPIRED.
  const now = new Date();
  await prisma.wikidotBindingTask.updateMany({
    where: {
      status: WikidotBindingStatus.PENDING,
      expiresAt: { lte: now }
    },
    data: { status: WikidotBindingStatus.EXPIRED }
  });

  // DISTINCT ON selects each account's absolute latest task across every
  // status. Filtering happens outside that selection so an older pending row
  // can never reappear behind a newer terminal task.
  return prisma.$queryRaw<PendingTask[]>`
    WITH latest AS (
      SELECT DISTINCT ON ("userId")
             id, "userId", "wikidotUserId", "verificationCode", status,
             "createdAt", "expiresAt", "checkCount", "lastCheckedAt"
      FROM "WikidotBindingTask"
      ORDER BY "userId", "createdAt" DESC, id DESC
    )
    SELECT id, "userId", "wikidotUserId", "verificationCode",
           "createdAt", "expiresAt", "checkCount", "lastCheckedAt"
    FROM latest
    WHERE status = 'PENDING'::"WikidotBindingStatus"
      AND "expiresAt" > ${now}
  `;
}

export async function completeBindingTask(
  taskId: string,
  proof: BindingCompletionProof
): Promise<boolean> {
  let result: string | null;
  try {
    result = await runBindingTransaction(async (tx) => {
      // Read only the immutable owner id first so every binding transaction can
      // lock account -> task in the same order and avoid a start/complete deadlock.
      const taskOwner = await tx.wikidotBindingTask.findUnique({
        where: { id: taskId },
        select: { userId: true }
      });
      if (!taskOwner) return null;

      const owner = await lockAccount(tx, taskOwner.userId);
      const task = await lockTask(tx, taskId);
      if (!owner || !task || task.userId !== owner.id) return null;

      const latestTask = await tx.wikidotBindingTask.findFirst({
        where: { userId: task.userId },
        orderBy: [
          { createdAt: 'desc' },
          { id: 'desc' }
        ],
        select: { id: true }
      });
      if (!isCompletableLatestBindingTask(task.id, task.status, latestTask?.id ?? null)) return null;

      if (!validateBindingCompletionProof(task, proof)) {
        return null;
      }

      if (owner.linkedWikidotId !== null) {
        await tx.wikidotBindingTask.updateMany({
          where: { id: task.id, status: WikidotBindingStatus.PENDING },
          data: {
            status: WikidotBindingStatus.CANCELLED,
            failureReason: '绑定账号已有 Wikidot 账号，任务已取消'
          }
        });
        return null;
      }

      const existingLink = await tx.userAccount.findFirst({
        where: { linkedWikidotId: task.wikidotUserId },
        select: { id: true }
      });
      if (existingLink) {
        await tx.wikidotBindingTask.updateMany({
          where: { id: task.id, status: WikidotBindingStatus.PENDING },
          data: {
            status: WikidotBindingStatus.CANCELLED,
            failureReason: '该 Wikidot 账号已被其他用户绑定'
          }
        });
        return null;
      }

      const linked = await tx.userAccount.updateMany({
        where: {
          id: owner.id,
          linkedWikidotId: null
        },
        data: { linkedWikidotId: task.wikidotUserId }
      });
      if (linked.count !== 1) {
        throw new Error('绑定账号状态发生并发变化');
      }

      const completed = await tx.wikidotBindingTask.updateMany({
        // WikidotBindingTask.createdAt/expiresAt are PostgreSQL TIMESTAMP(3).
        // The producer forwards their millisecond ISO values unchanged, so
        // exact equality is an intentional optimistic-lock contract.
        where: {
          id: task.id,
          userId: task.userId,
          wikidotUserId: proof.wikidotUserId,
          verificationCode: proof.verificationCode,
          createdAt: proof.createdAt,
          expiresAt: proof.expiresAt,
          status: WikidotBindingStatus.PENDING
        },
        data: {
          status: WikidotBindingStatus.VERIFIED,
          verifiedAt: new Date(),
          failureReason: null
        }
      });
      if (completed.count !== 1) {
        // Throwing is intentional: returning would commit the account update
        // without the matching terminal task transition.
        throw new Error('绑定任务状态发生并发变化');
      }

      return task.userId;
    });
  } catch (error) {
    // A concurrent account may claim the unique linkedWikidotId after our
    // predicate check. The failed transaction rolls back; cancel only if this
    // task is still pending, and never overwrite another terminal state.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      await prisma.wikidotBindingTask.updateMany({
        where: { id: taskId, status: WikidotBindingStatus.PENDING },
        data: {
          status: WikidotBindingStatus.CANCELLED,
          failureReason: '该 Wikidot 账号已被其他用户绑定'
        }
      });
      return false;
    }
    throw error;
  }

  if (result) {
    invalidateAuthCache(result);
    return true;
  }
  return false;
}

export async function updateTaskCheckStatus(taskId: string): Promise<void> {
  await prisma.wikidotBindingTask.updateMany({
    where: {
      id: taskId,
      status: WikidotBindingStatus.PENDING,
      expiresAt: { gt: new Date() }
    },
    data: {
      lastCheckedAt: new Date(),
      checkCount: { increment: 1 }
    }
  });
}

export async function expireTask(taskId: string): Promise<void> {
  await prisma.wikidotBindingTask.updateMany({
    where: {
      id: taskId,
      status: WikidotBindingStatus.PENDING,
      expiresAt: { lte: new Date() }
    },
    data: { status: WikidotBindingStatus.EXPIRED }
  });
}
