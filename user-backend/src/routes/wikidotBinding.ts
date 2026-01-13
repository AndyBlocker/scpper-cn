import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  startBindingTask,
  getBindingTaskStatus,
  cancelBindingTask,
  getPendingTasks,
  completeBindingTask,
  updateTaskCheckStatus,
  expireTask
} from '../services/wikidotBinding.js';

const startSchema = z.object({
  wikidotUsername: z.string().trim().min(1, '请输入 Wikidot 用户名').max(100, '用户名过长')
});

const completeSchema = z.object({
  taskId: z.string().min(1, '任务 ID 不能为空'),
  revisionId: z.number().optional(),
  timestamp: z.string().optional()
});

const expireSchema = z.object({
  taskId: z.string().min(1, '任务 ID 不能为空')
});

const updateCheckSchema = z.object({
  taskId: z.string().min(1, '任务 ID 不能为空')
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

/**
 * Public routes for users (require authentication)
 */
export function wikidotBindingRouter() {
  const router = Router();

  // Start a new binding task
  router.post('/start', requireAuth, async (req, res) => {
    try {
      if (!req.authUser) {
        return res.status(401).json({ error: '未登录' });
      }

      const payload = startSchema.parse(req.body ?? {});
      const result = await startBindingTask(req.authUser.id, payload.wikidotUsername);

      res.json({
        ok: true,
        task: {
          id: result.task.id,
          wikidotUserId: result.task.wikidotUserId,
          wikidotUsername: result.task.wikidotUsername,
          verificationCode: result.task.verificationCode,
          status: result.task.status,
          expiresAt: result.task.expiresAt.toISOString()
        },
        instructions: {
          targetPage: 'https://scp-wiki-cn.wikidot.com/andyblocker',
          step1: '访问上方链接打开验证页面',
          step2: '点击页面右下角的「编辑」按钮',
          step3: '在「本次编辑的简要说明:」框中填入验证码，注意请不要修改页面源代码',
          step4: '保存页面，等待系统自动验证（通常需要数小时）'
        }
      });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  // Get current task status
  router.get('/status', requireAuth, async (req, res) => {
    try {
      if (!req.authUser) {
        return res.status(401).json({ error: '未登录' });
      }

      const task = await getBindingTaskStatus(req.authUser.id);

      if (!task) {
        return res.json({ ok: true, task: null });
      }

      res.json({
        ok: true,
        task: {
          id: task.id,
          wikidotUserId: task.wikidotUserId,
          wikidotUsername: task.wikidotUsername,
          verificationCode: task.verificationCode,
          status: task.status,
          expiresAt: task.expiresAt.toISOString(),
          lastCheckedAt: task.lastCheckedAt?.toISOString() || null,
          checkCount: task.checkCount,
          failureReason: task.failureReason
        }
      });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  // Cancel current task
  router.delete('/cancel', requireAuth, async (req, res) => {
    try {
      if (!req.authUser) {
        return res.status(401).json({ error: '未登录' });
      }

      const cancelled = await cancelBindingTask(req.authUser.id);

      if (!cancelled) {
        return res.status(404).json({ error: '没有进行中的绑定任务' });
      }

      res.json({ ok: true });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  return router;
}

/**
 * Internal routes for backend verification job (no auth, internal network only)
 */
export function wikidotBindingInternalRouter() {
  const router = Router();

  // Get all pending tasks
  router.get('/pending', async (_req, res) => {
    try {
      const tasks = await getPendingTasks();
      res.json({ ok: true, tasks });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  // Complete a binding task (called when verification succeeds)
  router.post('/complete', async (req, res) => {
    try {
      const payload = completeSchema.parse(req.body ?? {});
      const revisionInfo = payload.revisionId
        ? { revisionId: payload.revisionId, timestamp: payload.timestamp ? new Date(payload.timestamp) : new Date() }
        : undefined;

      const success = await completeBindingTask(payload.taskId, revisionInfo);

      if (!success) {
        return res.status(400).json({ error: '任务不存在或已完成' });
      }

      res.json({ ok: true });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  // Update task check status (called after each check)
  router.post('/update-check', async (req, res) => {
    try {
      const payload = updateCheckSchema.parse(req.body ?? {});
      await updateTaskCheckStatus(payload.taskId);
      res.json({ ok: true });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  // Mark task as expired
  router.post('/expire', async (req, res) => {
    try {
      const payload = expireSchema.parse(req.body ?? {});
      await expireTask(payload.taskId);
      res.json({ ok: true });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  return router;
}
