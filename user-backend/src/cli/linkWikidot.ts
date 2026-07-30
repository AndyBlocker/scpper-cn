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

export async function linkWikidotUser(args: LinkArgs): Promise<LinkResult> {
  const email = args.email.trim().toLowerCase();
  const wikidotId = args.wikidotId;
  const force = Boolean(args.force);
  const takeover = Boolean(args.takeover);

  const outcome = await runBindingTransaction(async (tx) => {
    const account = await tx.userAccount.findUnique({ where: { email } });
    if (!account) {
      throw new Error(`未找到邮箱为 ${email} 的用户账号`);
    }

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

  const outcome = await runBindingTransaction(async (tx) => {
    if (args.email) {
      const email = args.email.trim().toLowerCase();
      const account = await tx.userAccount.findUnique({ where: { email } });
      if (!account) {
        throw new Error(`未找到邮箱为 ${email} 的用户账号`);
      }
      if (!account.linkedWikidotId) {
        throw new Error(`账号 ${account.email} 未绑定 wikidotId，无法解绑`);
      }
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
          previousLinkedWikidotId: account.linkedWikidotId
        },
        invalidatedAccountIds: [updated.id]
      };
    }

    const wikidotId = args.wikidotId as number;
    if (!Number.isInteger(wikidotId) || wikidotId <= 0) {
      throw new Error('wikidotId 必须是正整数');
    }
    const accountWithId = await tx.userAccount.findUnique({ where: { linkedWikidotId: wikidotId } });
    if (!accountWithId) {
      throw new Error(`wikidotId=${wikidotId} 未绑定任何账号`);
    }
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
        previousLinkedWikidotId: wikidotId
      },
      invalidatedAccountIds: [updated.id]
    };
  });

  for (const accountId of outcome.invalidatedAccountIds) {
    invalidateAuthCache(accountId);
  }
  return outcome.result;
}
