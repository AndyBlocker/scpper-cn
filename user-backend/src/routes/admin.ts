import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { requireAdmin } from '../middleware/requireAdmin.js';
import { linkWikidotUser, unlinkWikidotUser } from '../cli/linkWikidot.js';

const listSchema = z.object({
  query: z.string().trim().optional(),
  limit: z.string().trim().optional(),
  offset: z.string().trim().optional()
});

const linkSchema = z.object({
  wikidotId: z.number().int().positive(),
  force: z.boolean().optional(),
  takeover: z.boolean().optional()
});

export function adminRouter() {
  const router = Router();

  // List user accounts (admin-only)
  router.get('/accounts', requireAdmin, async (req, res, next) => {
    try {
      const { query, limit = '20', offset = '0' } = listSchema.parse(req.query ?? {});
      const limitInt = Math.max(1, Math.min(parseInt(String(limit), 10) || 20, 200));
      const offsetInt = Math.max(0, parseInt(String(offset), 10) || 0);

      const where = (() => {
        if (!query || query.length === 0) return {};
        const q = query.trim();
        const numericId = Number(q);
        const numFilter = Number.isInteger(numericId) && numericId > 0
          ? [{ linkedWikidotId: numericId }]
          : [] as any[];
        return {
          OR: [
            { email: { contains: q, mode: 'insensitive' as const } },
            { displayName: { contains: q, mode: 'insensitive' as const } },
            ...numFilter
          ]
        };
      })();

      const [items, total, totalUsers, boundUsers] = await Promise.all([
        prisma.userAccount.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip: offsetInt,
          take: limitInt,
          select: {
            id: true,
            email: true,
            displayName: true,
            status: true,
            linkedWikidotId: true,
            createdAt: true,
            lastLoginAt: true
          }
        }),
        prisma.userAccount.count({ where }),
        prisma.userAccount.count(),
        prisma.userAccount.count({ where: { linkedWikidotId: { not: null } } })
      ]);

      res.json({
        items: items.map((i) => ({
          ...i,
          linkedWikidotId: i.linkedWikidotId ?? null
        })),
        total,
        overview: { totalUsers, boundUsers },
        limit: limitInt,
        offset: offsetInt
      });
    } catch (err) {
      next(err);
    }
  });

  // Link wikidotId to account by account id (admin-only)
  router.post('/accounts/:id/link', requireAdmin, async (req, res, next) => {
    try {
      const { id } = req.params as Record<string, string>;
      const payload = linkSchema.parse(req.body ?? {});
      const account = await prisma.userAccount.findUnique({ where: { id } });
      if (!account) {
        return res.status(404).json({ error: '账号不存在' });
      }
      const result = await linkWikidotUser({
        email: account.email,
        wikidotId: payload.wikidotId,
        force: payload.force,
        takeover: payload.takeover
      });
      res.json({ ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : '绑定失败';
      res.status(400).json({ error: message });
    }
  });

  // Unlink wikidotId from account by account id (admin-only)
  router.post('/accounts/:id/unlink', requireAdmin, async (req, res, next) => {
    try {
      const { id } = req.params as Record<string, string>;
      const account = await prisma.userAccount.findUnique({ where: { id } });
      if (!account) {
        return res.status(404).json({ error: '账号不存在' });
      }
      if (!account.linkedWikidotId) {
        return res.status(400).json({ error: '该账号未绑定 wikidotId' });
      }
      const result = await unlinkWikidotUser({ email: account.email });
      res.json({ ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : '解绑失败';
      res.status(400).json({ error: message });
    }
  });

  // Delete account by account id (admin-only)
  router.delete('/accounts/:id', requireAdmin, async (req, res, next) => {
    try {
      const { id } = req.params as Record<string, string>;
      const account = await prisma.userAccount.findUnique({
        where: { id },
        select: { id: true, email: true }
      });
      if (!account) {
        return res.status(404).json({ error: '账号不存在' });
      }
      // Prevent admin from deleting themselves
      if (req.authUser?.id === id) {
        return res.status(400).json({ error: '无法删除当前登录的账号' });
      }
      // Delete the account (Prisma cascade will handle related records)
      await prisma.userAccount.delete({ where: { id } });
      res.json({ ok: true, deletedEmail: account.email });
    } catch (err) {
      const message = err instanceof Error ? err.message : '删除失败';
      res.status(400).json({ error: message });
    }
  });

  // ===== Calendar Events Management =====
  const eventCreateSchema = z.object({
    title: z.string().trim().min(1),
    summary: z.string().trim().optional().nullable(),
    color: z.string().trim().optional().nullable(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    detailsMd: z.string().optional().nullable(),
    isPublished: z.boolean().optional()
  });

  const eventUpdateSchema = z.object({
    title: z.string().trim().min(1).optional(),
    summary: z.string().trim().optional().nullable(),
    color: z.string().trim().optional().nullable(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    detailsMd: z.string().optional().nullable(),
    isPublished: z.boolean().optional()
  });

  // List all events (admin-only)
  router.get('/events', requireAdmin, async (_req, res, next) => {
    try {
      const items = await prisma.calendarEvent.findMany({
        orderBy: [{ startsAt: 'desc' }, { updatedAt: 'desc' }]
      });
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  // Create event (admin-only)
  router.post('/events', requireAdmin, async (req, res, next) => {
    try {
      const payload = eventCreateSchema.parse(req.body ?? {});
      const startsAt = new Date(payload.startsAt);
      const endsAt = new Date(payload.endsAt);
      if (!(startsAt instanceof Date && !isNaN(startsAt.valueOf())) || !(endsAt instanceof Date && !isNaN(endsAt.valueOf()))) {
        return res.status(400).json({ error: '开始或结束时间无效' });
      }
      if (endsAt < startsAt) {
        return res.status(400).json({ error: '结束时间需大于开始时间' });
      }
      const event = await prisma.calendarEvent.create({
        data: {
          title: payload.title,
          summary: payload.summary ?? null,
          color: payload.color ?? null,
          startsAt,
          endsAt,
          detailsMd: payload.detailsMd ?? null,
          isPublished: payload.isPublished ?? true,
          createdById: req.authUser?.id
        }
      });
      res.json({ ok: true, event });
    } catch (err) {
      next(err);
    }
  });

  // Update event (admin-only)
  router.patch('/events/:id', requireAdmin, async (req, res, next) => {
    try {
      const { id } = req.params as Record<string, string>;
      const payload = eventUpdateSchema.parse(req.body ?? {});
      const data: any = { ...payload };
      if (typeof data.startsAt === 'string') data.startsAt = new Date(data.startsAt);
      if (typeof data.endsAt === 'string') data.endsAt = new Date(data.endsAt);
      if (data.endsAt && data.startsAt && data.endsAt < data.startsAt) {
        return res.status(400).json({ error: '结束时间需大于开始时间' });
      }
      const event = await prisma.calendarEvent.update({ where: { id }, data });
      res.json({ ok: true, event });
    } catch (err) {
      next(err);
    }
  });

  // Delete event (admin-only)
  router.delete('/events/:id', requireAdmin, async (req, res, next) => {
    try {
      const { id } = req.params as Record<string, string>;
      await prisma.calendarEvent.delete({ where: { id } });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
