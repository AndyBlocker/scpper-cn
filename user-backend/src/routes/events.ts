import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';

const listQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  includeUnpublished: z.string().optional()
});

export function eventsRouter() {
  const router = Router();

  // Public list of published events; optional date range filter
  router.get('/', async (req, res, next) => {
    try {
      const { from, to } = listQuerySchema.parse(req.query ?? {});
      const where: any = { isPublished: true };
      if (from || to) {
        where.AND = [] as any[];
        if (from) {
          where.AND.push({ endsAt: { gte: new Date(from) } });
        }
        if (to) {
          where.AND.push({ startsAt: { lte: new Date(to) } });
        }
      }
      const items = await prisma.calendarEvent.findMany({
        where,
        orderBy: [{ startsAt: 'asc' }, { endsAt: 'asc' }],
        select: {
          id: true,
          title: true,
          summary: true,
          color: true,
          startsAt: true,
          endsAt: true,
          isPublished: true
        }
      });
      res.json({ items });
    } catch (err) {
      next(err);
    }
  });

  // Public event details (if published)
  router.get('/:id', async (req, res, next) => {
    try {
      const { id } = req.params as Record<string, string>;
      const event = await prisma.calendarEvent.findUnique({ where: { id } });
      if (!event || !event.isPublished) {
        return res.status(404).json({ error: '未找到活动' });
      }
      res.json({
        id: event.id,
        title: event.title,
        summary: event.summary,
        color: event.color,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        detailsMd: event.detailsMd,
        isPublished: event.isPublished
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

