import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { verifyInternalKey } from '../utils/internalAuth.js';
import { invalidateAuthCache } from '../middleware/requireAuth.js';

/** 连续失败多少次后自动暂停渠道 */
const FAILURE_THRESHOLD = Math.max(1, Number(process.env.NOTIFY_CHANNEL_FAILURE_THRESHOLD ?? '3') || 3);

const reportSchema = z.object({
  accountId: z.string().min(1),
  channel: z.literal('QQ'),
  outcome: z.enum(['sent', 'failed']),
  code: z.string().max(64).optional()
});

/**
 * 供 backend 的投递器回报送达结果。
 *
 * 为什么必须有：投递失败只写主库的 NotificationDelivery 的话，用户库这边的绑定
 * 一直是 ACTIVE、界面显示「已绑定」一切正常，而每条新告警都有新的 dedupeKey，
 * 于是对着一个早就把机器人删掉的用户永远重试下去。
 */
export function internalNotificationsRouter() {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.use((req, res, next) => {
    const auth = verifyInternalKey(req, 'NOTIFY_INTERNAL_KEY');
    if (!auth.ok) return res.status(auth.status).json(auth.body);
    next();
  });

  router.post('/report-delivery', async (req, res) => {
    try {
      const payload = reportSchema.parse(req.body ?? {});
      const binding = await prisma.notificationChannelBinding.findUnique({
        where: { userId_channel: { userId: payload.accountId, channel: 'QQ' } },
        select: { id: true, failureCount: true, status: true }
      });
      if (!binding) return res.json({ ok: true, updated: false });

      if (payload.outcome === 'sent') {
        // 成功即清零，避免偶发失败累积到阈值把正常渠道停掉
        await prisma.notificationChannelBinding.update({
          where: { id: binding.id },
          data: { failureCount: 0, lastFailureCode: null, lastSentAt: new Date() }
        });
        return res.json({ ok: true, updated: true, paused: false });
      }

      const next = binding.failureCount + 1;
      const shouldPause = next >= FAILURE_THRESHOLD && binding.status === 'ACTIVE';
      await prisma.notificationChannelBinding.update({
        where: { id: binding.id },
        data: {
          failureCount: next,
          lastFailureCode: payload.code ?? null,
          ...(shouldPause ? { status: 'PAUSED' as const, suspendedUntil: null } : {})
        }
      });
      if (shouldPause) {
        // 绑定态会经 /auth/me 带到前端，暂停后要让用户立刻看到
        invalidateAuthCache(payload.accountId);
        // eslint-disable-next-line no-console
        console.warn(`[notify] 账号 ${payload.accountId} 的 QQ 渠道连续失败 ${next} 次（${payload.code}），已自动暂停`);
      }
      res.json({ ok: true, updated: true, paused: shouldPause, failureCount: next });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ error: error.issues[0]?.message || '参数错误' });
      }
      // eslint-disable-next-line no-console
      console.error('[internal-notifications] unexpected error:', error);
      res.status(500).json({ error: '操作失败' });
    }
  });

  return router;
}
