import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../db.js';
import { verifyInternalKey } from '../utils/internalAuth.js';
import { invalidateAuthCache } from '../middleware/requireAuth.js';

/** 连续失败多少次后自动暂停渠道 */
const FAILURE_THRESHOLD = Math.max(1, Number(process.env.NOTIFY_CHANNEL_FAILURE_THRESHOLD ?? '3') || 3);

const reportSchema = z.object({
  accountId: z.string().min(1),
  /**
   * 绑定行的不可变 id。可选是为了兼容尚未升级的投递器；
   * 带了就按它精确定位，不会误伤解绑后新建的那一行。
   */
  bindingId: z.string().min(1).optional(),
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

      // 优先按 bindingId 精确定位。
      // 只按 (userId, channel) 查的话，用户在投递器缓存宽限期内解绑再重绑
      // ——那是一行**全新记录**——旧地址的成功/失败会被记到新绑定上，
      // 连续失败甚至能把一个健康的新绑定推到自动暂停。
      // 同时校验 userId：bindingId 来自内网可信调用方，但越权写别人的绑定
      // 代价太大，多一次比对不亏。
      const binding = payload.bindingId
        ? await prisma.notificationChannelBinding.findFirst({
            where: { id: payload.bindingId, userId: payload.accountId, channel: 'QQ' },
            select: { id: true, failureCount: true, status: true }
          })
        : await prisma.notificationChannelBinding.findUnique({
            where: { userId_channel: { userId: payload.accountId, channel: 'QQ' } },
            select: { id: true, failureCount: true, status: true }
          });
      // 找不到通常意味着那次投递针对的绑定已经被删/被替换 —— 直接忽略，
      // 不要退回到「按 userId 找一个」，那正是本次要避免的误伤。
      if (!binding) return res.json({ ok: true, updated: false, reason: 'binding_gone' });

      if (payload.outcome === 'sent') {
        // 成功即清零，避免偶发失败累积到阈值把正常渠道停掉
        await prisma.notificationChannelBinding.update({
          where: { id: binding.id },
          data: { failureCount: 0, lastFailureCode: null, lastSentAt: new Date() }
        });
        // 若此前已被**自动**暂停，成功投递就是它恢复健康的证明，应当解除暂停。
        //
        // 不解除的话会卡死：一条达到阈值的失败回报把绑定置为 PAUSED，
        // 紧随其后的成功回报只清零计数、状态仍是 PAUSED；
        // 而投递器只加载 ACTIVE 绑定 —— 一个刚刚成功送达过的渠道就此永久停用，
        // 用户界面显示「已暂停」，却不知道为什么，也没有任何后续投递能救它。
        // 条件限定 PAUSED：REVOKED（用户已解绑）绝不能被复活。
        const resumed = await prisma.notificationChannelBinding.updateMany({
          where: { id: binding.id, status: 'PAUSED' },
          data: { status: 'ACTIVE', suspendedUntil: null }
        });
        if (resumed.count > 0) {
          // 绑定态经 /auth/me 带到前端，恢复后要让用户立刻看到
          invalidateAuthCache(payload.accountId);
          // eslint-disable-next-line no-console
          console.log(`[notify] 账号 ${payload.accountId} 的 QQ 渠道投递成功，已解除自动暂停`);
        }
        return res.json({ ok: true, updated: true, paused: false, resumed: resumed.count > 0 });
      }

      // 用原子自增拿到**真实**的累计值，不能「先读再算再写」。
      //
      // 同一绑定的两条失败回报重叠时（重发路径与常规路径可能同时回报），
      // 两边会读到同一个 failureCount、算出同一个 next、互相覆盖 ——
      // 少记一次失败，绑定就可能越过阈值仍不暂停。
      // increment 由数据库保证串行，返回值就是自增后的结果。
      const updated = await prisma.notificationChannelBinding.update({
        where: { id: binding.id },
        data: {
          failureCount: { increment: 1 },
          lastFailureCode: payload.code ?? null
        },
        select: { failureCount: true, status: true }
      });
      const next = updated.failureCount;
      const shouldPause = next >= FAILURE_THRESHOLD && updated.status === 'ACTIVE';
      let pausedNow = false;
      if (shouldPause) {
        // 暂停条件里必须**同时**带上失败计数，不能只看 status。
        // 自增与这一步之间，一条成功回报可能已经把 failureCount 清零了 ——
        // 只判 status 的话，我们仍会把一个刚刚证明自己健康的绑定停掉，
        // 用户于是莫名其妙收不到推送，还得自己去页面重新启用。
        const paused = await prisma.notificationChannelBinding.updateMany({
          where: {
            id: binding.id,
            status: 'ACTIVE',
            failureCount: { gte: FAILURE_THRESHOLD }
          },
          data: { status: 'PAUSED', suspendedUntil: null }
        });
        pausedNow = paused.count > 0;
      }
      if (pausedNow) {
        // 绑定态会经 /auth/me 带到前端，暂停后要让用户立刻看到
        invalidateAuthCache(payload.accountId);
        // eslint-disable-next-line no-console
        console.warn(`[notify] 账号 ${payload.accountId} 的 QQ 渠道连续失败 ${next} 次（${payload.code}），已自动暂停`);
      }
      res.json({ ok: true, updated: true, paused: pausedNow, failureCount: next });
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
