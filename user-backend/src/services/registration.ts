import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { generateNumericCode, hashVerificationCode } from '../utils/verification.js';
import { sendVerificationEmail } from './mail.js';

const ACCOUNT_STATUS = {
  PENDING_VERIFICATION: 'PENDING_VERIFICATION',
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED'
} as const;

const VERIFICATION_PURPOSE = {
  REGISTER: 'REGISTER',
  PASSWORD_RESET: 'PASSWORD_RESET'
} as const;

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeDisplayName(displayName?: string | null) {
  const trimmed = displayName?.trim();
  return trimmed ? trimmed : null;
}

export async function startRegistration(email: string, displayName?: string | null) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedDisplayName = normalizeDisplayName(displayName);
  const now = new Date();
  const rateWindowStart = new Date(now.getTime() - config.rateLimit.registerWindowSeconds * 1000);

  const recentToken = await prisma.verificationToken.findFirst({
    where: {
      email: normalizedEmail,
      purpose: VERIFICATION_PURPOSE.REGISTER,
      createdAt: { gte: rateWindowStart },
      consumedAt: null
    },
    orderBy: { createdAt: 'desc' }
  });

  if (recentToken) {
    throw new Error('验证码请求过于频繁，请稍后再试');
  }

  const existingAccount = await prisma.userAccount.findUnique({
    where: { email: normalizedEmail }
  });

  if (existingAccount?.status === ACCOUNT_STATUS.ACTIVE) {
    throw new Error('该邮箱已注册');
  }
  if (existingAccount?.status === ACCOUNT_STATUS.DISABLED) {
    throw new Error('该账号已被禁用');
  }

  const account = existingAccount
    ? await prisma.userAccount.update({
        where: { id: existingAccount.id },
        data: { displayName: normalizedDisplayName ?? existingAccount.displayName }
      })
    : await prisma.userAccount.create({
        data: {
          email: normalizedEmail,
          displayName: normalizedDisplayName
        }
      });

  const code = generateNumericCode(config.verification.codeLength);
  const codeHash = hashVerificationCode(code);
  const expiresAt = new Date(now.getTime() + config.verification.ttlMinutes * 60 * 1000);

  await prisma.verificationToken.create({
    data: {
      userId: account.id,
      email: normalizedEmail,
      codeHash,
      purpose: VERIFICATION_PURPOSE.REGISTER,
      expiresAt
    }
  });

  await sendVerificationEmail({
    email: normalizedEmail,
    code,
    ttlMinutes: config.verification.ttlMinutes,
    displayName: account.displayName
  });

  return {
    expiresAt
  };
}

export async function completeRegistration(email: string, code: string, password: string, displayName?: string | null) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedDisplayName = normalizeDisplayName(displayName);
  const now = new Date();
  const hashedInput = hashVerificationCode(code);

  const result = await prisma.$transaction(async (tx) => {
    const account = await tx.userAccount.findUnique({ where: { email: normalizedEmail } });
    if (!account) {
      throw new Error('账号不存在，请先请求验证码');
    }
    if (account.status === ACCOUNT_STATUS.DISABLED) {
      throw new Error('该账号已被禁用');
    }

    const token = await tx.verificationToken.findFirst({
      where: {
        userId: account.id,
        purpose: VERIFICATION_PURPOSE.REGISTER,
        consumedAt: null
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!token) {
      throw new Error('请先请求验证码');
    }
    if (token.expiresAt < now) {
      throw new Error('验证码已过期');
    }

    if (token.attemptCount >= config.verification.maxAttempts) {
      throw new Error('验证码尝试次数过多，请重新请求');
    }

    if (token.codeHash !== hashedInput) {
      await tx.verificationToken.update({
        where: { id: token.id },
        data: { attemptCount: { increment: 1 } }
      });
      throw new Error('验证码不正确');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const updatedAccount = await tx.userAccount.update({
      where: { id: account.id },
      data: {
        passwordHash,
        status: ACCOUNT_STATUS.ACTIVE,
        emailVerifiedAt: now,
        displayName: normalizedDisplayName ?? account.displayName
      }
    });

    await tx.verificationToken.update({
      where: { id: token.id },
      data: {
        consumedAt: now,
        attemptCount: token.attemptCount + 1
      }
    });

    return updatedAccount;
  });

  return {
    id: result.id,
    email: result.email,
    displayName: result.displayName,
    status: result.status,
    emailVerifiedAt: result.emailVerifiedAt
  };
}
