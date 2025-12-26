import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../db.js';
import { requireAuth } from '../middleware/requireAuth.js';

const MAX_PROJECTS_PER_USER = 50;
const MAX_SOURCE_LENGTH = 500 * 1024; // 500 KB

const createProjectSchema = z.object({
  title: z.string().trim().min(1, '项目标题不能为空').max(200, '项目标题过长').optional(),
  source: z.string().max(MAX_SOURCE_LENGTH, '源文本过大').optional(),
  pageTitle: z.string().max(200).optional(),
  pageTags: z.array(z.string().max(50)).max(100).optional(),
  settings: z.record(z.unknown()).optional()
});

const updateProjectSchema = z.object({
  title: z.string().trim().min(1, '项目标题不能为空').max(200, '项目标题过长').optional(),
  source: z.string().max(MAX_SOURCE_LENGTH, '源文本过大').optional(),
  pageTitle: z.string().max(200).nullable().optional(),
  pageTags: z.array(z.string().max(50)).max(100).optional(),
  settings: z.record(z.unknown()).nullable().optional(),
  isArchived: z.boolean().optional()
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

// Middleware to check if user has linked Wikidot account
function requireWikidotLinked(
  req: Parameters<typeof requireAuth>[0],
  res: Parameters<typeof requireAuth>[1],
  next: Parameters<typeof requireAuth>[2]
) {
  if (!req.authUser) {
    return res.status(401).json({ error: '未登录' });
  }
  if (!req.authUser.linkedWikidotId) {
    return res.status(403).json({ error: 'wikidot_not_linked', message: '请先绑定 Wikidot 账号' });
  }
  next();
}

export function ftmlProjectsRouter() {
  const router = Router();

  // List user's projects
  router.get('/', requireAuth, requireWikidotLinked, async (req, res) => {
    try {
      const userId = req.authUser!.id;
      const includeArchived = req.query.archived === 'true';

      const projects = await prisma.ftmlProject.findMany({
        where: {
          userId,
          ...(includeArchived ? {} : { isArchived: false })
        },
        select: {
          id: true,
          title: true,
          pageTitle: true,
          pageTags: true,
          isArchived: true,
          createdAt: true,
          updatedAt: true
        },
        orderBy: { updatedAt: 'desc' }
      });

      res.json({ ok: true, projects });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  // Get single project
  router.get('/:id', requireAuth, requireWikidotLinked, async (req, res) => {
    try {
      const userId = req.authUser!.id;
      const { id } = req.params;

      const project = await prisma.ftmlProject.findFirst({
        where: { id, userId }
      });

      if (!project) {
        return res.status(404).json({ error: '项目不存在' });
      }

      res.json({ ok: true, project });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  // Create new project
  router.post('/', requireAuth, requireWikidotLinked, async (req, res) => {
    try {
      const userId = req.authUser!.id;

      // Check project limit
      const projectCount = await prisma.ftmlProject.count({
        where: { userId, isArchived: false }
      });

      if (projectCount >= MAX_PROJECTS_PER_USER) {
        return res.status(400).json({
          error: 'project_limit_reached',
          message: `最多只能创建 ${MAX_PROJECTS_PER_USER} 个活跃项目`
        });
      }

      const payload = createProjectSchema.parse(req.body ?? {});

      const project = await prisma.ftmlProject.create({
        data: {
          userId,
          title: payload.title ?? '未命名项目',
          source: payload.source ?? '',
          pageTitle: payload.pageTitle ?? null,
          pageTags: payload.pageTags ?? [],
          settings: payload.settings ? (payload.settings as Prisma.InputJsonValue) : Prisma.JsonNull
        }
      });

      res.status(201).json({ ok: true, project });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  // Update project
  router.patch('/:id', requireAuth, requireWikidotLinked, async (req, res) => {
    try {
      const userId = req.authUser!.id;
      const { id } = req.params;

      // Verify ownership
      const existing = await prisma.ftmlProject.findFirst({
        where: { id, userId },
        select: { id: true }
      });

      if (!existing) {
        return res.status(404).json({ error: '项目不存在' });
      }

      const payload = updateProjectSchema.parse(req.body ?? {});

      const updateData: Prisma.FtmlProjectUpdateInput = {};
      if (payload.title !== undefined) updateData.title = payload.title;
      if (payload.source !== undefined) updateData.source = payload.source;
      if (payload.pageTitle !== undefined) updateData.pageTitle = payload.pageTitle;
      if (payload.pageTags !== undefined) updateData.pageTags = payload.pageTags;
      if (payload.settings !== undefined) {
        updateData.settings = payload.settings === null
          ? Prisma.JsonNull
          : (payload.settings as Prisma.InputJsonValue);
      }
      if (payload.isArchived !== undefined) updateData.isArchived = payload.isArchived;

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: '未提供需要更新的内容' });
      }

      const project = await prisma.ftmlProject.update({
        where: { id },
        data: updateData
      });

      res.json({ ok: true, project });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  // Delete project
  router.delete('/:id', requireAuth, requireWikidotLinked, async (req, res) => {
    try {
      const userId = req.authUser!.id;
      const { id } = req.params;

      // Verify ownership
      const existing = await prisma.ftmlProject.findFirst({
        where: { id, userId },
        select: { id: true }
      });

      if (!existing) {
        return res.status(404).json({ error: '项目不存在' });
      }

      await prisma.ftmlProject.delete({ where: { id } });

      res.json({ ok: true });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  // Duplicate project
  router.post('/:id/duplicate', requireAuth, requireWikidotLinked, async (req, res) => {
    try {
      const userId = req.authUser!.id;
      const { id } = req.params;

      // Check project limit
      const projectCount = await prisma.ftmlProject.count({
        where: { userId, isArchived: false }
      });

      if (projectCount >= MAX_PROJECTS_PER_USER) {
        return res.status(400).json({
          error: 'project_limit_reached',
          message: `最多只能创建 ${MAX_PROJECTS_PER_USER} 个活跃项目`
        });
      }

      // Get source project
      const source = await prisma.ftmlProject.findFirst({
        where: { id, userId }
      });

      if (!source) {
        return res.status(404).json({ error: '项目不存在' });
      }

      const project = await prisma.ftmlProject.create({
        data: {
          userId,
          title: `${source.title} (副本)`,
          source: source.source,
          pageTitle: source.pageTitle,
          pageTags: source.pageTags,
          settings: source.settings !== null ? (source.settings as Prisma.InputJsonValue) : Prisma.JsonNull
        }
      });

      res.status(201).json({ ok: true, project });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  return router;
}
