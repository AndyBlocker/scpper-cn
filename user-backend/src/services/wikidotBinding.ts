import { prisma } from '../db.js';
import { WikidotBindingStatus } from '@prisma/client';

const VERIFICATION_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // Excluding 0/O, 1/I/L
const VERIFICATION_CODE_LENGTH = 6;
const TASK_TTL_HOURS = 48;

// BFF base URL for resolving Wikidot users
const BFF_BASE_URL = process.env.BFF_BASE_URL || 'http://127.0.0.1:4396';

export function generateVerificationCode(): string {
  let code = 'SCPPER-';
  for (let i = 0; i < VERIFICATION_CODE_LENGTH; i++) {
    code += VERIFICATION_CODE_CHARS.charAt(
      Math.floor(Math.random() * VERIFICATION_CODE_CHARS.length)
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
  try {
    const response = await fetch(`${BFF_BASE_URL}/internal/wikidot-user?username=${encodeURIComponent(username)}`);
    if (!response.ok) {
      return null;
    }
    const data = await response.json() as { ok: boolean; user?: ResolvedWikidotUser };
    return data.ok && data.user ? data.user : null;
  } catch {
    return null;
  }
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
  wikidotUsername: string
): Promise<StartBindingResult> {
  // 1. Check if user already has a linked Wikidot account
  const account = await prisma.userAccount.findUnique({
    where: { id: userId }
  });
  if (!account) {
    throw new Error('用户不存在');
  }
  if (account.linkedWikidotId) {
    throw new Error('你已绑定 Wikidot 账号，如需更换请先联系管理员解绑');
  }

  // 2. Resolve Wikidot username to ID
  const wikidotUser = await resolveWikidotUser(wikidotUsername);
  if (!wikidotUser) {
    throw new Error('未找到该 Wikidot 用户，请确认用户名正确且该用户在站点有活动记录');
  }

  // 3. Check if this Wikidot ID is already linked to another account
  const existingLink = await prisma.userAccount.findFirst({
    where: { linkedWikidotId: wikidotUser.wikidotId }
  });
  if (existingLink) {
    throw new Error('该 Wikidot 账号已被其他用户绑定');
  }

  // 4. Check for existing PENDING task for this user
  const existingTask = await prisma.wikidotBindingTask.findFirst({
    where: {
      userId,
      status: WikidotBindingStatus.PENDING
    }
  });
  if (existingTask) {
    // Cancel the old task
    await prisma.wikidotBindingTask.update({
      where: { id: existingTask.id },
      data: { status: WikidotBindingStatus.CANCELLED }
    });
  }

  // 5. Generate unique verification code
  let verificationCode: string;
  let attempts = 0;
  const maxAttempts = 10;
  while (true) {
    verificationCode = generateVerificationCode();
    const existing = await prisma.wikidotBindingTask.findUnique({
      where: { verificationCode }
    });
    if (!existing) break;
    attempts++;
    if (attempts >= maxAttempts) {
      throw new Error('无法生成验证码，请稍后重试');
    }
  }

  // 6. Create new binding task
  const expiresAt = new Date(Date.now() + TASK_TTL_HOURS * 60 * 60 * 1000);
  const task = await prisma.wikidotBindingTask.create({
    data: {
      userId,
      wikidotUserId: wikidotUser.wikidotId,
      wikidotUsername: wikidotUser.displayName || wikidotUser.username || wikidotUsername,
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
    where: {
      userId,
      status: { in: [WikidotBindingStatus.PENDING, WikidotBindingStatus.EXPIRED] }
    },
    orderBy: { createdAt: 'desc' }
  });

  if (!task) return null;

  // Auto-expire if needed
  if (task.status === WikidotBindingStatus.PENDING && task.expiresAt < new Date()) {
    await prisma.wikidotBindingTask.update({
      where: { id: task.id },
      data: { status: WikidotBindingStatus.EXPIRED }
    });
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
    where: {
      userId,
      status: WikidotBindingStatus.PENDING
    }
  });

  if (!task) return false;

  await prisma.wikidotBindingTask.update({
    where: { id: task.id },
    data: { status: WikidotBindingStatus.CANCELLED }
  });

  return true;
}

// Internal APIs for backend verification job

export interface PendingTask {
  id: string;
  userId: string;
  wikidotUserId: number;
  verificationCode: string;
  createdAt: Date;
  expiresAt: Date;
}

export async function getPendingTasks(): Promise<PendingTask[]> {
  const tasks = await prisma.wikidotBindingTask.findMany({
    where: {
      status: WikidotBindingStatus.PENDING,
      expiresAt: { gt: new Date() }
    }
  });

  return tasks.map(t => ({
    id: t.id,
    userId: t.userId,
    wikidotUserId: t.wikidotUserId,
    verificationCode: t.verificationCode,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt
  }));
}

export async function completeBindingTask(
  taskId: string,
  revisionInfo?: { revisionId: number; timestamp: Date }
): Promise<boolean> {
  const task = await prisma.wikidotBindingTask.findUnique({
    where: { id: taskId }
  });

  if (!task || task.status !== WikidotBindingStatus.PENDING) {
    return false;
  }

  // Check if wikidotId is still available
  const existingLink = await prisma.userAccount.findFirst({
    where: { linkedWikidotId: task.wikidotUserId }
  });
  if (existingLink) {
    await prisma.wikidotBindingTask.update({
      where: { id: taskId },
      data: {
        status: WikidotBindingStatus.CANCELLED,
        failureReason: '该 Wikidot 账号已被其他用户绑定'
      }
    });
    return false;
  }

  // Complete the binding in a transaction
  await prisma.$transaction([
    prisma.userAccount.update({
      where: { id: task.userId },
      data: { linkedWikidotId: task.wikidotUserId }
    }),
    prisma.wikidotBindingTask.update({
      where: { id: taskId },
      data: {
        status: WikidotBindingStatus.VERIFIED,
        verifiedAt: new Date()
      }
    })
  ]);

  return true;
}

export async function updateTaskCheckStatus(
  taskId: string,
  checked: boolean = true
): Promise<void> {
  await prisma.wikidotBindingTask.update({
    where: { id: taskId },
    data: {
      lastCheckedAt: new Date(),
      checkCount: { increment: 1 }
    }
  });
}

export async function expireTask(taskId: string): Promise<void> {
  await prisma.wikidotBindingTask.update({
    where: { id: taskId },
    data: { status: WikidotBindingStatus.EXPIRED }
  });
}
