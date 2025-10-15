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

  return router;
}

