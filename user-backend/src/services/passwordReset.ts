import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { generateNumericCode, hashVerificationCode } from '../utils/verification.js';
import { sendPasswordResetEmail } from './mail.js';

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

export async function startPasswordReset(email: string) {
  const normalizedEmail = normalizeEmail(email);
  const now = new Date();
  const rateWindowStart = new Date(now.getTime() - config.rateLimit.registerWindowSeconds * 1000);

  // Silently succeed if account not found or not active (avoid account enumeration)
  const account = await prisma.userAccount.findUnique({ where: { email: normalizedEmail } });
  if (!account || account.status !== ACCOUNT_STATUS.ACTIVE) {
    return { ok: true } as const;
  }

  // Respect rate limit window per email for PASSWORD_RESET
  const recentToken = await prisma.verificationToken.findFirst({
    where: {
      email: normalizedEmail,
      purpose: VERIFICATION_PURPOSE.PASSWORD_RESET,
      createdAt: { gte: rateWindowStart },
      consumedAt: null
    },
    orderBy: { createdAt: 'desc' }
  });

  if (recentToken) {
    // Do not send again; still return ok
    return { ok: true } as const;
  }

  const code = generateNumericCode(config.verification.codeLength);
  const codeHash = hashVerificationCode(code);
  const expiresAt = new Date(now.getTime() + config.verification.ttlMinutes * 60 * 1000);

  await prisma.verificationToken.create({
    data: {
      userId: account.id,
      email: normalizedEmail,
      codeHash,
      purpose: VERIFICATION_PURPOSE.PASSWORD_RESET,
      expiresAt
    }
  });

  await sendPasswordResetEmail({
    email: normalizedEmail,
    code,
    ttlMinutes: config.verification.ttlMinutes,
    displayName: account.displayName
  });

  return { ok: true } as const;
}

export async function completePasswordReset(email: string, code: string, password: string) {
  const normalizedEmail = normalizeEmail(email);
  const now = new Date();
  const hashedInput = hashVerificationCode(code);

  await prisma.$transaction(async (tx) => {
    const account = await tx.userAccount.findUnique({ where: { email: normalizedEmail } });
    if (!account || account.status !== ACCOUNT_STATUS.ACTIVE) {
      throw new Error('验证码不正确或已过期');
    }

    const token = await tx.verificationToken.findFirst({
      where: {
        userId: account.id,
        purpose: VERIFICATION_PURPOSE.PASSWORD_RESET,
        consumedAt: null
      },
      orderBy: { createdAt: 'desc' }
    });

    if (!token || token.expiresAt < now) {
      if (token) {
        await tx.verificationToken.update({ where: { id: token.id }, data: { attemptCount: token.attemptCount + 1 } });
      }
      throw new Error('验证码不正确或已过期');
    }

    if (token.attemptCount >= config.verification.maxAttempts) {
      throw new Error('验证码尝试次数过多，请重新请求');
    }

    if (token.codeHash !== hashedInput) {
      await tx.verificationToken.update({ where: { id: token.id }, data: { attemptCount: token.attemptCount + 1 } });
      throw new Error('验证码不正确或已过期');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    await tx.userAccount.update({
      where: { id: account.id },
      data: { passwordHash }
    });

    await tx.verificationToken.update({
      where: { id: token.id },
      data: { consumedAt: now, attemptCount: token.attemptCount + 1 }
    });
  });

  return { ok: true } as const;
}

