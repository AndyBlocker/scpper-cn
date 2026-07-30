import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { startRegistration, completeRegistration } from '../services/registration.js';
import { issueAuthToken } from '../utils/auth-token.js';
import { prisma } from '../db.js';
import { requireAuth, invalidateAuthCache, formatAuthQqBinding } from '../middleware/requireAuth.js';
import { startPasswordReset, completePasswordReset } from '../services/passwordReset.js';
import { SlidingWindowRateLimiter } from '../utils/rateLimiter.js';

const loginLimiter = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, maxHits: 20 });
const registerStartLimiter = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, maxHits: 5 });
const resetStartLimiter = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, maxHits: 5 });

function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

const startSchema = z.object({
  email: z.string().email('电子邮箱格式不正确'),
  displayName: z.string().trim().min(1, '昵称至少 1 个字符').max(64, '昵称过长').optional()
});

const completeSchema = z.object({
  email: z.string().email('电子邮箱格式不正确'),
  code: z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{${config.verification.codeLength}}$`), `验证码应为 ${config.verification.codeLength} 位数字`),
  password: z
    .string()
    .min(8, '密码至少 8 位')
    .max(128, '密码长度过长'),
  displayName: z.string().trim().min(1, '昵称至少 1 个字符').max(64, '昵称过长').optional()
});

const loginSchema = z.object({
  email: z.string().email('电子邮箱格式不正确'),
  password: z.string().min(1, '请输入密码')
});

const profileSchema = z.object({
  displayName: z
    .string()
    .trim()
    .min(1, '昵称至少 1 个字符')
    .max(64, '昵称过长')
    .optional()
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: z.string().min(8, '新密码至少 8 位').max(128, '新密码过长')
});

const resetStartSchema = z.object({
  email: z.string().email('电子邮箱格式不正确')
});

const resetCompleteSchema = z.object({
  email: z.string().email('电子邮箱格式不正确'),
  code: z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{${config.verification.codeLength}}$`), `验证码应为 ${config.verification.codeLength} 位数字`),
  password: z
    .string()
    .min(8, '密码至少 8 位')
    .max(128, '密码长度过长')
});

// Known business error messages that are safe to expose to the client
const SAFE_ERROR_MESSAGES = new Set([
  '验证码请求过于频繁，请稍后再试',
  '该邮箱已注册',
  '该账号已被禁用',
  '账号不存在，请先请求验证码',
  '请先请求验证码',
  '验证码已过期',
  '验证码尝试次数过多，请重新请求',
  '验证码不正确',
  '验证码不正确或已过期',
  '邮箱或密码错误',
  '账号异常',
  '当前密码不正确',
  '未提供需要更新的内容',
  '登录尝试过于频繁，请 15 分钟后再试',
  '请求过于频繁，请稍后再试'
]);

function createErrorResponse(error: unknown) {
  if (error instanceof z.ZodError) {
    return { status: 400, body: { error: error.issues[0]?.message || '参数错误' } };
  }
  if (error instanceof Error && SAFE_ERROR_MESSAGES.has(error.message)) {
    return { status: 400, body: { error: error.message } };
  }
  if (error instanceof Error) {
    // Do not leak internal error messages (e.g. database errors)
    // eslint-disable-next-line no-console
    console.error('[auth] unexpected error:', error);
    return { status: 500, body: { error: '服务器内部错误' } };
  }
  return { status: 500, body: { error: '未知错误' } };
}

export function authRouter() {
  const router = Router();

  function formatUser(account: {
    id: string;
    email: string;
    displayName: string | null;
    linkedWikidotId: number | null;
    lastLoginAt: Date | null;
    channelBindings: Array<{ address: string; status: string }>;
    channelChallenges: Array<{ id: string }>;
  }) {
    const qq = account.channelBindings[0];
    const qqBinding = formatAuthQqBinding(qq, account.channelChallenges.length > 0);
    return {
      id: account.id,
      email: account.email,
      displayName: account.displayName,
      linkedWikidotId: account.linkedWikidotId,
      lastLoginAt: account.lastLoginAt,
      qqBinding
    };
  }

  function setSessionCookie(res: Response, token: string) {
    const maxAgeMs = config.session.ttlHours * 60 * 60 * 1000;
    res.cookie(config.session.cookieName, token, {
      httpOnly: true,
      sameSite: config.session.sameSite,
      secure: config.session.secure,
      maxAge: maxAgeMs,
      path: '/'
    });
  }

  router.get('/healthz', (_req, res) => {
    res.json({ ok: true });
  });

  router.post('/register/start', async (req, res) => {
    try {
      const ip = getClientIp(req);
      if (!registerStartLimiter.hit(ip)) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
      }
      const payload = startSchema.parse(req.body ?? {});
      const result = await startRegistration(payload.email, payload.displayName);
      res.json({ ok: true, expiresAt: result.expiresAt.toISOString() });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  router.post('/register/complete', async (req, res) => {
    try {
      const payload = completeSchema.parse(req.body ?? {});
      const result = await completeRegistration(
        payload.email,
        payload.code,
        payload.password,
        payload.displayName
      );
      res.json({ ok: true, user: result });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  router.post('/login', async (req, res) => {
    try {
      const ip = getClientIp(req);
      if (!loginLimiter.hit(ip)) {
        return res.status(429).json({ error: '登录尝试过于频繁，请 15 分钟后再试' });
      }
      const payload = loginSchema.parse(req.body ?? {});
      const email = payload.email.trim().toLowerCase();
      const account = await prisma.userAccount.findUnique({
        where: { email },
        select: {
          id: true,
          passwordHash: true,
          status: true
        }
      });

      if (!account || !account.passwordHash || account.status !== 'ACTIVE') {
        throw new Error('邮箱或密码错误');
      }

      const passwordOk = await bcrypt.compare(payload.password, account.passwordHash);
      if (!passwordOk) {
        throw new Error('邮箱或密码错误');
      }

      const loginAt = new Date();
      const updated = await prisma.userAccount.update({
        where: { id: account.id },
        data: { lastLoginAt: loginAt },
        include: {
          channelBindings: {
            where: { channel: 'QQ' },
            select: { address: true, status: true }
          },
          channelChallenges: {
            where: {
              channel: 'QQ',
              status: 'PENDING',
              expiresAt: { gt: new Date() }
            },
            select: { id: true },
            take: 1
          }
        }
      });

      const token = issueAuthToken(updated.id, updated.passwordHash ?? account.passwordHash);

      setSessionCookie(res, token);
      // 同一账号可能仍有另一枚有效 cookie；避免它在 30 秒内读到旧 lastLoginAt。
      invalidateAuthCache(updated.id);

      res.json({ ok: true, user: formatUser({
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName ?? null,
        linkedWikidotId: updated.linkedWikidotId ?? null,
        lastLoginAt: updated.lastLoginAt ?? loginAt,
        channelBindings: updated.channelBindings,
        channelChallenges: updated.channelChallenges
      }) });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  router.post('/logout', async (_req, res) => {
    res.clearCookie(config.session.cookieName, {
      httpOnly: true,
      sameSite: config.session.sameSite,
      secure: config.session.secure,
      path: '/'
    });
    res.json({ ok: true });
  });

  // Request password reset code (always returns ok)
  router.post('/password/reset/start', async (req, res) => {
    try {
      const ip = getClientIp(req);
      if (!resetStartLimiter.hit(ip)) {
        return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
      }
      const payload = resetStartSchema.parse(req.body ?? {});
      await startPasswordReset(payload.email);
      res.json({ ok: true });
    } catch (error) {
      // Even if validation fails, keep explicit message
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  // Complete password reset using email + code
  router.post('/password/reset/complete', async (req, res) => {
    try {
      const payload = resetCompleteSchema.parse(req.body ?? {});
      const result = await completePasswordReset(payload.email, payload.code, payload.password);
      invalidateAuthCache(result.userId);
      res.json({ ok: true });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  router.get('/me', requireAuth, async (req, res) => {
    if (!req.authUser) {
      return res.status(401).json({ error: '未登录' });
    }
    res.json({ ok: true, user: req.authUser });
  });

  router.patch('/profile', requireAuth, async (req, res) => {
    try {
      if (!req.authUser) {
        return res.status(401).json({ error: '未登录' });
      }
      const payload = profileSchema.parse(req.body ?? {});
      if (!payload.displayName) {
        return res.status(400).json({ error: '未提供需要更新的内容' });
      }
      const updated = await prisma.userAccount.update({
        where: { id: req.authUser.id },
        data: { displayName: payload.displayName },
        include: {
          channelBindings: {
            where: { channel: 'QQ' },
            select: { address: true, status: true }
          },
          channelChallenges: {
            where: {
              channel: 'QQ',
              status: 'PENDING',
              expiresAt: { gt: new Date() }
            },
            select: { id: true },
            take: 1
          }
        }
      });
      // /auth/me 复用 requireAuth 的 30 秒缓存；不失效会让刚保存的昵称回滚。
      invalidateAuthCache(updated.id);
      res.json({ ok: true, user: formatUser({
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName ?? null,
        linkedWikidotId: updated.linkedWikidotId ?? null,
        lastLoginAt: updated.lastLoginAt ?? null,
        channelBindings: updated.channelBindings,
        channelChallenges: updated.channelChallenges
      }) });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  router.patch('/password', requireAuth, async (req, res) => {
    try {
      if (!req.authUser) {
        return res.status(401).json({ error: '未登录' });
      }
      const payload = passwordSchema.parse(req.body ?? {});
      const account = await prisma.userAccount.findUnique({ where: { id: req.authUser.id } });
      if (!account || !account.passwordHash) {
        throw new Error('账号异常');
      }
      const currentOk = await bcrypt.compare(payload.currentPassword, account.passwordHash);
      if (!currentOk) {
        throw new Error('当前密码不正确');
      }
      const newHash = await bcrypt.hash(payload.newPassword, 12);
      await prisma.userAccount.update({
        where: { id: account.id },
        data: { passwordHash: newHash }
      });
      invalidateAuthCache(account.id);
      res.clearCookie(config.session.cookieName, {
        httpOnly: true,
        sameSite: config.session.sameSite,
        secure: config.session.secure,
        path: '/'
      });
      res.json({ ok: true });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  return router;
}
