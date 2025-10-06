import { Router, type Response } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { config } from '../config.js';
import { startRegistration, completeRegistration } from '../services/registration.js';
import { issueAuthToken } from '../utils/auth-token.js';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

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

function createErrorResponse(error: unknown) {
  if (error instanceof z.ZodError) {
    return { status: 400, body: { error: error.issues[0]?.message || '参数错误' } };
  }
  if (error instanceof Error) {
    return { status: 400, body: { error: error.message } };
  }
  return { status: 500, body: { error: '未知错误' } };
}

export function authRouter() {
  const router = Router();

  function formatUser(account: { id: string; email: string; displayName: string | null; linkedWikidotId: number | null; lastLoginAt: Date | null }) {
    return {
      id: account.id,
      email: account.email,
      displayName: account.displayName,
      linkedWikidotId: account.linkedWikidotId,
      lastLoginAt: account.lastLoginAt
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

  router.post('/register/start', async (req, res) => {
    try {
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
      const payload = loginSchema.parse(req.body ?? {});
      const email = payload.email.trim().toLowerCase();
      const account = await prisma.userAccount.findUnique({ where: { email } });

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
        data: { lastLoginAt: loginAt }
      });

      const token = issueAuthToken(updated.id, updated.passwordHash ?? account.passwordHash);

      setSessionCookie(res, token);

      res.json({ ok: true, user: formatUser({
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName ?? null,
        linkedWikidotId: updated.linkedWikidotId ?? null,
        lastLoginAt: updated.lastLoginAt ?? loginAt
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
        data: { displayName: payload.displayName }
      });
      res.json({ ok: true, user: formatUser({
        id: updated.id,
        email: updated.email,
        displayName: updated.displayName ?? null,
        linkedWikidotId: updated.linkedWikidotId ?? null,
        lastLoginAt: updated.lastLoginAt ?? null
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
