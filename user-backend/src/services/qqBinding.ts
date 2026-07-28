/**
 * QQ 渠道绑定的业务逻辑。
 *
 * 与 wikidotBinding.ts 的关键差异：
 *  - Wikidot 绑定是**轮询式**的（后台任务定期去 wikidot 查修订注释里有没有码）；
 *    QQ 绑定是**推送式**的（用户把码填进好友验证消息，机器人收到后立刻回调这里）。
 *    所以这里没有 pending 任务扫描，核销由 verifyQqBinding 一次完成。
 *  - 验证码只存哈希（services/AGENTS.md：验证码明文落库是反模式）。
 *    Wikidot 那边存明文有其特殊性 —— 那个码本来就要被公开写进 wikidot 修订注释。
 */

import { Prisma, ChannelBindingStatus, ChannelChallengeStatus, NotificationChannel } from '@prisma/client';
import { prisma } from '../db.js';
import { invalidateAuthCache } from '../middleware/requireAuth.js';
import {
  bindingCodeHint,
  evaluateChallenge,
  generateBindingCode,
  hashBindingCode,
  maskQqNumber,
  normalizeBindingCode,
  normalizeQqNumber,
  rejectionMessage,
  type VerifyRejection
} from './qqBindingProof.js';

const CHALLENGE_TTL_MINUTES = Math.min(
  30,
  Math.max(10, Number(process.env.QQ_BINDING_TTL_MINUTES ?? '15') || 15)
);
const SERIALIZABLE_RETRY_ATTEMPTS = 3;

type Tx = Prisma.TransactionClient;

function isRetryableTransactionError(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('could not serialize access')
    || message.includes('serialization failure')
    || message.includes('deadlock detected')
    || message.includes('40001')
    || message.includes('40p01');
}

async function runBindingTransaction<T>(operation: (tx: Tx) => Promise<T>): Promise<T> {
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
      if (!isRetryableTransactionError(error) || attempt === SERIALIZABLE_RETRY_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 25 * attempt)));
    }
  }
  throw lastError ?? new Error('绑定事务执行失败');
}

/**
 * 加锁顺序固定为「先账号后挑战」。
 *
 * startQqBinding 与 verifyQqBinding 会同时触及这两张表，顺序不一致就会死锁
 * （A 持账号锁等挑战锁、B 持挑战锁等账号锁）。这与 wikidotBinding.ts 的约定一致，
 * 改动任一函数时都不要打破它。
 */
async function lockAccount(tx: Tx, userId: string): Promise<{ id: string } | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "UserAccount" WHERE id = ${userId} FOR UPDATE
  `;
  return rows[0] ?? null;
}

interface LockedChallenge {
  id: string;
  userId: string;
  status: ChannelChallengeStatus;
  expiresAt: Date;
  attemptCount: number;
}

async function lockChallenge(tx: Tx, challengeId: string): Promise<LockedChallenge | null> {
  const rows = await tx.$queryRaw<LockedChallenge[]>`
    SELECT id, "userId", status, "expiresAt", "attemptCount"
    FROM "ChannelBindingChallenge"
    WHERE id = ${challengeId}
    FOR UPDATE
  `;
  return rows[0] ?? null;
}

// ─── 对外的错误文案白名单（与 routes 层的 SAFE_ERROR_MESSAGES 保持一致）───

export const QQ_BINDING_ERRORS = {
  accountMissing: '用户不存在',
  alreadyBound: '你已绑定 QQ，如需更换请先解绑',
  addressTaken: '该 QQ 已被其他账号绑定',
  noBinding: '你还没有绑定 QQ',
  noChallenge: '没有进行中的绑定请求',
  passwordRequired: '请输入登录密码以确认解绑',
  passwordWrong: '密码不正确'
} as const;

export interface StartResult {
  /** 明文验证码。**只在这一次返回**，之后任何接口都拿不到（库里只有哈希）。 */
  code: string;
  expiresAt: Date;
  ttlMinutes: number;
  /** 用于引导文案的机器人 QQ 号 */
  botQq: string | null;
}

/**
 * 发起绑定：作废该账号旧的 PENDING 挑战，生成新码。
 *
 * 「作废旧的」不是可选项 —— 否则用户在两个标签页各点一次，就会有两个都能用的码，
 * 而其中一个的明文只存在于已经被关掉的那个页面里，无法撤销。
 */
export async function startQqBinding(userId: string, botQq: string | null): Promise<StartResult> {
  // 先快速失败，避免在事务里做无谓的工作；事务内还会在行锁下再查一次（权威判定）
  const existing = await prisma.notificationChannelBinding.findUnique({
    where: { userId_channel: { userId, channel: NotificationChannel.QQ } },
    select: { id: true, status: true }
  });
  if (existing && existing.status !== ChannelBindingStatus.REVOKED) {
    throw new Error(QQ_BINDING_ERRORS.alreadyBound);
  }

  const code = generateBindingCode();
  const codeHash = hashBindingCode(code);
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MINUTES * 60 * 1000);

  await runBindingTransaction(async (tx) => {
    const account = await lockAccount(tx, userId);
    if (!account) throw new Error(QQ_BINDING_ERRORS.accountMissing);

    const bound = await tx.notificationChannelBinding.findUnique({
      where: { userId_channel: { userId, channel: NotificationChannel.QQ } },
      select: { id: true, status: true }
    });
    if (bound && bound.status !== ChannelBindingStatus.REVOKED) {
      throw new Error(QQ_BINDING_ERRORS.alreadyBound);
    }

    await tx.channelBindingChallenge.updateMany({
      where: { userId, channel: NotificationChannel.QQ, status: ChannelChallengeStatus.PENDING },
      data: { status: ChannelChallengeStatus.CANCELLED, failureReason: 'superseded' }
    });

    await tx.channelBindingChallenge.create({
      data: {
        userId,
        channel: NotificationChannel.QQ,
        codeHash,
        codeHint: bindingCodeHint(code),
        expiresAt
      }
    });
  });

  return { code, expiresAt, ttlMinutes: CHALLENGE_TTL_MINUTES, botQq };
}

export interface BindingStatus {
  binding: {
    addressMask: string;
    displayName: string | null;
    status: ChannelBindingStatus;
    verifiedAt: Date;
    suspendedUntil: Date | null;
  } | null;
  challenge: {
    /** 明文不再返回，只给末 4 位帮用户确认「屏幕上那个码是不是这个」 */
    codeHint: string;
    expiresAt: Date;
    createdAt: Date;
  } | null;
}

export async function getQqBindingStatus(userId: string): Promise<BindingStatus> {
  const [binding, challenge] = await Promise.all([
    prisma.notificationChannelBinding.findUnique({
      where: { userId_channel: { userId, channel: NotificationChannel.QQ } }
    }),
    prisma.channelBindingChallenge.findFirst({
      where: {
        userId,
        channel: NotificationChannel.QQ,
        status: ChannelChallengeStatus.PENDING,
        expiresAt: { gt: new Date() }
      },
      orderBy: { createdAt: 'desc' }
    })
  ]);

  return {
    binding: binding && binding.status !== ChannelBindingStatus.REVOKED
      ? {
          addressMask: maskQqNumber(binding.address),
          displayName: binding.displayName,
          status: binding.status,
          verifiedAt: binding.verifiedAt,
          suspendedUntil: binding.suspendedUntil
        }
      : null,
    challenge: challenge
      ? { codeHint: challenge.codeHint, expiresAt: challenge.expiresAt, createdAt: challenge.createdAt }
      : null
  };
}

export async function cancelQqBinding(userId: string): Promise<boolean> {
  const result = await prisma.channelBindingChallenge.updateMany({
    where: { userId, channel: NotificationChannel.QQ, status: ChannelChallengeStatus.PENDING },
    data: { status: ChannelChallengeStatus.CANCELLED, failureReason: 'user_cancelled' }
  });
  return result.count > 0;
}

export interface VerifyOutcome {
  matched: boolean;
  reason?: VerifyRejection | 'address_taken' | 'already_bound';
  reply: string;
}

/**
 * 核销验证码并建立绑定。由 qqbot 在收到好友验证消息/私聊时回调。
 *
 * 返回值同时是给用户看的文案 —— 机器人会把 reply 原样私聊回去，
 * 所以这里是「中文提示文案的单一权威」，qqbot 侧不再自己拼文案。
 */
export async function verifyQqBinding(params: {
  qq: unknown;
  code: unknown;
  source?: string;
}): Promise<VerifyOutcome> {
  const address = normalizeQqNumber(params.qq);
  if (!address) {
    return { matched: false, reason: 'code_malformed', reply: rejectionMessage('code_malformed') };
  }

  const normalized = normalizeBindingCode(typeof params.code === 'string' ? params.code : null);
  if (!normalized) {
    // 格式就不对，不必查库
    return { matched: false, reason: 'code_malformed', reply: rejectionMessage('code_malformed') };
  }

  const codeHash = hashBindingCode(normalized);
  const found = await prisma.channelBindingChallenge.findUnique({
    where: { codeHash },
    select: { id: true, userId: true }
  });
  if (!found) {
    // 与「过期」「已取消」返回同一句话，避免探测某个码是否存在过
    return { matched: false, reason: 'code_unknown', reply: rejectionMessage('code_unknown') };
  }

  return runBindingTransaction(async (tx): Promise<VerifyOutcome> => {
    // 锁顺序：账号 → 挑战（见 lockAccount 的注释）
    const account = await lockAccount(tx, found.userId);
    if (!account) {
      return { matched: false, reason: 'code_unknown', reply: rejectionMessage('code_unknown') };
    }
    const challenge = await lockChallenge(tx, found.id);
    if (!challenge) {
      return { matched: false, reason: 'code_unknown', reply: rejectionMessage('code_unknown') };
    }

    const decision = evaluateChallenge(
      { status: challenge.status, expiresAt: challenge.expiresAt, attemptCount: challenge.attemptCount },
      new Date()
    );
    if (!decision.ok) {
      return { matched: false, reason: decision.reason, reply: rejectionMessage(decision.reason) };
    }

    // 该 QQ 是否已被别人绑走
    const addressOwner = await tx.notificationChannelBinding.findUnique({
      where: { channel_address: { channel: NotificationChannel.QQ, address } },
      select: { userId: true, status: true }
    });
    if (addressOwner && addressOwner.userId !== found.userId && addressOwner.status !== ChannelBindingStatus.REVOKED) {
      await bumpAttempt(tx, challenge.id, challenge.attemptCount, 'address_taken');
      return {
        matched: false,
        reason: 'address_taken',
        reply: '这个 QQ 已经绑定到另一个站点账号了。如需换绑，请先在原账号解绑。'
      };
    }

    // 该账号是否已绑了别的 QQ
    const accountBinding = await tx.notificationChannelBinding.findUnique({
      where: { userId_channel: { userId: found.userId, channel: NotificationChannel.QQ } },
      select: { id: true, address: true, status: true }
    });
    if (
      accountBinding
      && accountBinding.status !== ChannelBindingStatus.REVOKED
      && accountBinding.address !== address
    ) {
      await bumpAttempt(tx, challenge.id, challenge.attemptCount, 'already_bound');
      return {
        matched: false,
        reason: 'already_bound',
        reply: '你的账号已经绑定了另一个 QQ，请先在网站解绑后再重新绑定。'
      };
    }

    const now = new Date();
    // upsert 而非 create：REVOKED 的旧行会占着 (userId, channel) 唯一键，
    // 用户解绑后重新绑定时必须复用同一行，否则会撞唯一约束。
    await tx.notificationChannelBinding.upsert({
      where: { userId_channel: { userId: found.userId, channel: NotificationChannel.QQ } },
      create: {
        userId: found.userId,
        channel: NotificationChannel.QQ,
        address,
        status: ChannelBindingStatus.ACTIVE,
        verifiedAt: now
      },
      update: {
        address,
        status: ChannelBindingStatus.ACTIVE,
        verifiedAt: now,
        failureCount: 0,
        lastFailureCode: null,
        suspendedUntil: null
      }
    });

    await tx.channelBindingChallenge.update({
      where: { id: challenge.id },
      data: {
        status: ChannelChallengeStatus.VERIFIED,
        verifiedAt: now,
        boundAddress: address,
        failureReason: null
      }
    });

    return {
      matched: true,
      reply: '绑定成功！之后 SCPper CN 的站点通知会通过这里发给你。\n可随时在网站「账号设置 → 通知」调整推送内容。'
    };
  }).then(async (outcome) => {
    // 事务外失效缓存：/auth/me 会带出绑定态，不失效的话前端最多 30 秒看不到变化
    if (outcome.matched) invalidateAuthCache(found.userId);
    return outcome;
  });
}

async function bumpAttempt(tx: Tx, challengeId: string, current: number, reason: string): Promise<void> {
  const next = current + 1;
  await tx.channelBindingChallenge.update({
    where: { id: challengeId },
    data: {
      attemptCount: next,
      failureReason: reason,
      // 达上限直接作废，不留给下一次尝试
      ...(next >= 5 ? { status: ChannelChallengeStatus.FAILED } : {})
    }
  });
}

/**
 * 解绑。
 *
 * 要求二次凭据（密码）不是形式主义：没有它，拿到会话的人可以静默把推送目标改成自己的 QQ，
 * 从而持续窃取受害者的站点活动情报，而受害者只会觉得「怎么收不到通知了」。
 */
export async function unbindQq(userId: string, verifyPassword: (hash: string | null) => Promise<boolean>): Promise<void> {
  const account = await prisma.userAccount.findUnique({
    where: { id: userId },
    select: { passwordHash: true }
  });
  if (!account) throw new Error(QQ_BINDING_ERRORS.accountMissing);

  const ok = await verifyPassword(account.passwordHash);
  if (!ok) throw new Error(QQ_BINDING_ERRORS.passwordWrong);

  const binding = await prisma.notificationChannelBinding.findUnique({
    where: { userId_channel: { userId, channel: NotificationChannel.QQ } },
    select: { id: true, status: true }
  });
  if (!binding || binding.status === ChannelBindingStatus.REVOKED) {
    throw new Error(QQ_BINDING_ERRORS.noBinding);
  }

  await prisma.notificationChannelBinding.update({
    where: { id: binding.id },
    data: { status: ChannelBindingStatus.REVOKED, resolvedMatrix: Prisma.DbNull }
  });
  invalidateAuthCache(userId);
}

/** 供 /auth/me 等接口带出绑定态，只返回掩码。 */
export async function getQqBindingSummary(userId: string): Promise<{
  bound: boolean;
  addressMask: string | null;
  status: ChannelBindingStatus | null;
} | null> {
  const binding = await prisma.notificationChannelBinding.findUnique({
    where: { userId_channel: { userId, channel: NotificationChannel.QQ } },
    select: { address: true, status: true }
  });
  if (!binding || binding.status === ChannelBindingStatus.REVOKED) {
    return { bound: false, addressMask: null, status: null };
  }
  return { bound: true, addressMask: maskQqNumber(binding.address), status: binding.status };
}
