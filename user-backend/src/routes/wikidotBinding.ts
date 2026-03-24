import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import {
  startBindingTask,
  searchWikidotUsers,
  getBindingTaskStatus,
  cancelBindingTask,
  getPendingTasks,
  completeBindingTask,
  updateTaskCheckStatus,
  expireTask
} from '../services/wikidotBinding.js';

const startSchema = z.object({
  wikidotUsername: z.string().trim().min(1, '请输入 Wikidot 用户名').max(100, '用户名过长').optional(),
  wikidotId: z.preprocess((value) => {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim()) return Number(value);
    return undefined;
  }, z.number().int().positive('Wikidot ID 必须是正整数').optional())
}).refine((data) => Boolean(data.wikidotUsername || data.wikidotId), {
  message: '请输入 Wikidot 用户名或 Wikidot ID'
});

const resolveSchema = z.object({
  query: z.preprocess(
    (value) => Array.isArray(value) ? value[0] : value,
    z.string().trim().max(100, '查询过长').optional()
  ),
  limit: z.preprocess((value) => {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && raw.trim()) return Number.parseInt(raw, 10);
    return undefined;
  }, z.number().int().min(1).max(20).optional())
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

// Known business error messages that are safe to expose to the client.
// Must stay in sync with errors thrown in services/wikidotBinding.ts.
const SAFE_ERROR_MESSAGES = new Set([
  '用户不存在',
  '你已绑定 Wikidot 账号，如需更换请先联系管理员解绑',
  '请输入 Wikidot 用户名或 ID',
  '未找到该 Wikidot 用户，请确认用户名正确且该用户在站点有活动记录',
  '该 Wikidot 账号已被其他用户绑定',
  '该用户名匹配多个 Wikidot 用户，请使用更精确的用户名或联系管理员处理',
  '无法生成验证码，请稍后重试',
  '内部服务暂时不可用，请稍后再试'
]);

function createErrorResponse(error: unknown) {
  if (error instanceof z.ZodError) {
    return { status: 400, body: { error: error.issues[0]?.message || '参数错误' } };
  }
  if (error instanceof Error && SAFE_ERROR_MESSAGES.has(error.message)) {
    return { status: 400, body: { error: error.message } };
  }
  if (error instanceof Error) {
    // eslint-disable-next-line no-console
    console.error('[wikidot-binding] unexpected error:', error);
    return { status: 500, body: { error: '操作失败' } };
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
      const result = await startBindingTask(req.authUser.id, {
        wikidotUsername: payload.wikidotUsername,
        wikidotId: payload.wikidotId
      });

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

  // Resolve Wikidot users by query (username/displayName/id)
  router.get('/resolve', requireAuth, async (req, res) => {
    try {
      if (!req.authUser) {
        return res.status(401).json({ error: '未登录' });
      }

      const payload = resolveSchema.parse(req.query ?? {});
      const query = payload.query?.trim() || '';
      if (!query) {
        return res.json({ ok: true, users: [] });
      }

      const users = await searchWikidotUsers(query, payload.limit ?? 8);
      return res.json({ ok: true, users });
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
        return res.status(404).json({ error: '没有可取消的绑定任务' });
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
 * Internal routes for backend verification job (require internal API key)
 */
export function wikidotBindingInternalRouter() {
  const router = Router();

  // Validate internal API key on all internal routes
  router.use((req, res, next) => {
    const expectedKey = (process.env.INTERNAL_API_KEY || '').trim();
    if (!expectedKey) {
      return res.status(503).json({ error: 'Internal API key not configured' });
    }
    const provided = (req.headers['x-internal-key'] as string || '').trim();
    if (!provided || provided !== expectedKey) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  });

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
