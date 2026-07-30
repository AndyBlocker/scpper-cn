import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { invalidateAuthCache } from '../middleware/requireAuth.js';

interface LinkArgs {
  email: string;
  wikidotId: number;
  force?: boolean;
  takeover?: boolean;
}

interface LinkResult {
  updatedAccount: {
    id: string;
    email: string;
    linkedWikidotId: number | null;
  };
  clearedAccountEmail?: string;
  previousLinkedWikidotId?: number | null;
}

interface UnlinkArgs {
  email?: string;
  wikidotId?: number;
}

interface UnlinkResult {
  email: string;
  previousLinkedWikidotId: number;
}

const SERIALIZABLE_RETRY_ATTEMPTS = 3;
const COLLECTION_OWNER_PIN_ERROR = '收藏归属预固定失败，身份变更已取消';

interface AccountIdentitySnapshot {
  id: string;
  email: string;
  linkedWikidotId: number | null;
}

function nextAuthCacheVersion(...currentVersions: Date[]): Date {
  return new Date(Math.max(
    Date.now(),
    ...currentVersions.map((current) => current.getTime() + 1)
  ));
}

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

async function runBindingTransaction<T>(
  operation: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  // 并发改绑若读取了同一旧版本，只允许一个事务提交；否则两次不同状态
  // 可能写出相同 updatedAt，使版本探测误把中间快照当成最新值。
  let lastError: unknown;
  for (let attempt = 1; attempt <= SERIALIZABLE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await prisma.$transaction(operation, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable
      });
    } catch (error) {
      lastError = error;
      if (!isRetryableTransactionError(error) || attempt === SERIALIZABLE_RETRY_ATTEMPTS) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 25 * attempt)));
    }
  }
  throw lastError ?? new Error('改绑事务执行失败');
}

function assertIdentitySnapshot(
  current: AccountIdentitySnapshot,
  expected: AccountIdentitySnapshot
): void {
  if (
    current.id !== expected.id
    || current.linkedWikidotId !== expected.linkedWikidotId
  ) {
    throw new Error('账号绑定状态已变化，请重试');
  }
}

export async function pinCollectionOwnerBeforeIdentityTransition(
  accountId: string,
  wikidotId: number
): Promise<void> {
  const internalKey = String(process.env.BFF_INTERNAL_API_KEY || '').trim();
  if (!internalKey) {
    throw new Error(COLLECTION_OWNER_PIN_ERROR);
  }
  const bffBaseUrl = String(
    process.env.BFF_BASE_URL || 'http://127.0.0.1:4396'
  ).replace(/\/$/, '');
  const timeoutValue = Number(
    process.env.BFF_INTERNAL_FETCH_TIMEOUT_MS ?? '4500'
  );
  const timeoutMs = Math.min(
    Math.max(Number.isFinite(timeoutValue) ? Math.floor(timeoutValue) : 4500, 250),
    10_000
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const response = await fetch(
      `${bffBaseUrl}/internal/collection-owner/pin`,
      {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          'x-internal-key': internalKey
        },
        body: JSON.stringify({ accountId, wikidotId })
      }
    );
    const payload = await response.json().catch(() => null) as {
      ok?: boolean;
      pinned?: {
        accountId?: string;
        wikidotId?: number;
      };
    } | null;
    if (
      !response.ok
      || payload?.ok !== true
      || payload.pinned?.accountId !== accountId
      || payload.pinned?.wikidotId !== wikidotId
    ) {
      throw new Error(COLLECTION_OWNER_PIN_ERROR);
    }
  } catch (error) {
    if (error instanceof Error && error.message === COLLECTION_OWNER_PIN_ERROR) {
      throw error;
    }
    throw new Error(COLLECTION_OWNER_PIN_ERROR);
  } finally {
    clearTimeout(timer);
  }
}

async function pinIdentitySnapshots(
  identities: AccountIdentitySnapshot[]
): Promise<void> {
  const unique = new Map<string, AccountIdentitySnapshot>();
  for (const identity of identities) {
    if (identity.linkedWikidotId == null) continue;
    unique.set(
      `${identity.id}:${identity.linkedWikidotId}`,
      identity
    );
  }
  // Deterministic order keeps behavior stable if a force+takeover needs to pin
  // both sides. The BFF serializes each call with its reconciliation lock.
  for (const identity of [...unique.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  )) {
    await pinCollectionOwnerBeforeIdentityTransition(
      identity.id,
      identity.linkedWikidotId!
    );
  }
}

export async function linkWikidotUser(args: LinkArgs): Promise<LinkResult> {
  const email = args.email.trim().toLowerCase();
  const wikidotId = args.wikidotId;
  const force = Boolean(args.force);
  const takeover = Boolean(args.takeover);

  // Read and pre-pin identity provenance before opening the user DB
  // transaction. A slow/unavailable BFF must never hold a UserAccount lock.
  // The serializable transaction below re-reads and compares this exact state
  // before writing, so these reads are not treated as authorization by
  // themselves.
  const accountSnapshot = await prisma.userAccount.findUnique({
    where: { email }
  });
  if (!accountSnapshot) {
    throw new Error(`未找到邮箱为 ${email} 的用户账号`);
  }
  if (
    accountSnapshot.linkedWikidotId
    && accountSnapshot.linkedWikidotId !== wikidotId
    && !force
  ) {
    throw new Error(`该账号已绑定 wikidotId=${accountSnapshot.linkedWikidotId}，如需覆盖请添加 --force`);
  }
  const existingSnapshot = await prisma.userAccount.findUnique({
    where: { linkedWikidotId: wikidotId }
  });
  if (
    existingSnapshot
    && existingSnapshot.id !== accountSnapshot.id
    && !takeover
  ) {
    throw new Error(`wikidotId=${wikidotId} 已绑定到账号 ${existingSnapshot.email}，如需转移请添加 --takeover`);
  }

  const snapshotsToPin: AccountIdentitySnapshot[] = [];
  if (
    accountSnapshot.linkedWikidotId != null
    && accountSnapshot.linkedWikidotId !== wikidotId
  ) {
    snapshotsToPin.push(accountSnapshot);
  }
  if (existingSnapshot && existingSnapshot.id !== accountSnapshot.id) {
    snapshotsToPin.push(existingSnapshot);
  }
  await pinIdentitySnapshots(snapshotsToPin);

  const outcome = await runBindingTransaction(async (tx) => {
    const account = await tx.userAccount.findUnique({ where: { email } });
    if (!account) {
      throw new Error(`未找到邮箱为 ${email} 的用户账号`);
    }
    assertIdentitySnapshot(account, accountSnapshot);

    if (account.linkedWikidotId === wikidotId) {
      return {
        result: {
          updatedAccount: {
            id: account.id,
            email: account.email,
            linkedWikidotId: account.linkedWikidotId ?? null
          },
          previousLinkedWikidotId: account.linkedWikidotId ?? null
        },
        invalidatedAccountIds: [account.id]
      };
    }

    if (account.linkedWikidotId && account.linkedWikidotId !== wikidotId && !force) {
      throw new Error(`该账号已绑定 wikidotId=${account.linkedWikidotId}，如需覆盖请添加 --force`);
    }

    const existing = await tx.userAccount.findUnique({ where: { linkedWikidotId: wikidotId } });
    if ((existing?.id ?? null) !== (existingSnapshot?.id ?? null)) {
      throw new Error('账号绑定状态已变化，请重试');
    }
    let clearedAccountEmail: string | undefined;
    let clearedAccountId: string | undefined;
    const transitionVersion = nextAuthCacheVersion(
      account.updatedAt,
      ...(existing && existing.id !== account.id ? [existing.updatedAt] : [])
    );
    if (existing && existing.id !== account.id) {
      if (!takeover) {
        throw new Error(`wikidotId=${wikidotId} 已绑定到账号 ${existing.email}，如需转移请添加 --takeover`);
      }
      await tx.userAccount.update({
        where: { id: existing.id },
        data: {
          linkedWikidotId: null,
          // takeover 两端共享同一个事务版本，既标记同一次身份转移，
          // 也保证两个在线缓存都能识别到版本变化。
          updatedAt: transitionVersion
        }
      });
      clearedAccountEmail = existing.email;
      clearedAccountId = existing.id;
    }

    const updated = await tx.userAccount.update({
      where: { id: account.id },
      data: {
        linkedWikidotId: wikidotId,
        // updatedAt 同时承担跨进程认证缓存版本。显式保证至少递增 1ms，
        // 避免同一 TIMESTAMP(3) 毫秒内的改绑无法被在线服务识别。
        updatedAt: transitionVersion
      }
    });

    return {
      result: {
        updatedAccount: {
          id: updated.id,
          email: updated.email,
          linkedWikidotId: updated.linkedWikidotId ?? null
        },
        clearedAccountEmail,
        previousLinkedWikidotId: account.linkedWikidotId ?? null
      },
      invalidatedAccountIds: [updated.id, ...(clearedAccountId ? [clearedAccountId] : [])]
    };
  });

  // 管理员 HTTP 路由与 CLI 共用本函数：前者在当前服务进程立即失效；
  // 后者运行在独立进程，在线服务会在下次缓存命中时用 updatedAt 探测到变更。
  for (const accountId of outcome.invalidatedAccountIds) {
    invalidateAuthCache(accountId);
  }
  return outcome.result;
}

export async function unlinkWikidotUser(args: UnlinkArgs): Promise<UnlinkResult> {
  if ((args.email && args.wikidotId) || (!args.email && !args.wikidotId)) {
    throw new Error('请提供 --email 或 --wikidotId（且只能提供一个）');
  }

  const email = args.email?.trim().toLowerCase();
  const wikidotId = args.wikidotId;
  if (wikidotId !== undefined && (!Number.isInteger(wikidotId) || wikidotId <= 0)) {
    throw new Error('wikidotId 必须是正整数');
  }
  const accountSnapshot = email
    ? await prisma.userAccount.findUnique({ where: { email } })
    : await prisma.userAccount.findUnique({
        where: { linkedWikidotId: wikidotId as number }
      });
  if (!accountSnapshot) {
    if (email) {
      throw new Error(`未找到邮箱为 ${email} 的用户账号`);
    }
    throw new Error(`wikidotId=${wikidotId} 未绑定任何账号`);
  }
  if (!accountSnapshot.linkedWikidotId) {
    throw new Error(`账号 ${accountSnapshot.email} 未绑定 wikidotId，无法解绑`);
  }

  await pinIdentitySnapshots([accountSnapshot]);

  const outcome = await runBindingTransaction(async (tx) => {
    if (email) {
      const account = await tx.userAccount.findUnique({ where: { email } });
      if (!account) {
        throw new Error(`未找到邮箱为 ${email} 的用户账号`);
      }
      assertIdentitySnapshot(account, accountSnapshot);
      const updated = await tx.userAccount.update({
        where: { id: account.id },
        data: {
          linkedWikidotId: null,
          updatedAt: nextAuthCacheVersion(account.updatedAt)
        }
      });
      return {
        result: {
          email: updated.email,
          previousLinkedWikidotId: account.linkedWikidotId as number
        },
        invalidatedAccountIds: [updated.id]
      };
    }

    const accountWithId = await tx.userAccount.findUnique({
      where: { linkedWikidotId: wikidotId as number }
    });
    if (!accountWithId) {
      throw new Error(`wikidotId=${wikidotId} 未绑定任何账号`);
    }
    assertIdentitySnapshot(accountWithId, accountSnapshot);
    const updated = await tx.userAccount.update({
      where: { id: accountWithId.id },
      data: {
        linkedWikidotId: null,
        updatedAt: nextAuthCacheVersion(accountWithId.updatedAt)
      }
    });
    return {
      result: {
        email: updated.email,
        previousLinkedWikidotId: wikidotId as number
      },
      invalidatedAccountIds: [updated.id]
    };
  });

  for (const accountId of outcome.invalidatedAccountIds) {
    invalidateAuthCache(accountId);
  }
  return outcome.result;
}
