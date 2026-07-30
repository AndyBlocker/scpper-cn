import { Router, type Request, type Response, type NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { getQqBotSelfId, qqFeatureEnabled } from '../utils/qqFeature.js';
import { verifyInternalKey } from '../utils/internalAuth.js';
import { SlidingWindowRateLimiter } from '../utils/rateLimiter.js';
import {
  QQ_BINDING_ERRORS,
  cancelQqBinding,
  getQqBindingStatus,
  startQqBinding,
  unbindQq,
  verifyQqBinding
} from '../services/qqBinding.js';

// ─── 限流 ────────────────────────────────────────────────────────────────
// wikidotBinding 的 /start 完全没有限流，这里补上。两个维度都要：
// 按 userId 防单账号刷码，按 IP 防「注册一堆账号各刷几次」绕过账号维度。
const startByUser = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, maxHits: 5 });
const startByIp = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, maxHits: 20 });
// 内部核销接口：按 QQ 号 + 全局。qqbot 侧还有一层进程内节流，这里是服务端兜底 ——
// 机器人被绕过或被替换时，爆破防护不能只依赖调用方自觉。
const verifyByAddress = new SlidingWindowRateLimiter({ windowMs: 10 * 60 * 1000, maxHits: 10 });
const verifyGlobal = new SlidingWindowRateLimiter({ windowMs: 10 * 60 * 1000, maxHits: 300 });
/**
 * 解绑的密码校验限流。
 *
 * 这个接口要求密码正是为了防「会话被劫持后静默改推送目标」，
 * 但不限流的话，拿到会话的人可以在这里无限次猜密码 —— 它就变成了
 * 一个在线密码预言机；而且每次都会跑一遍 bcrypt（故意设计得很慢），
 * 同时也是 CPU 消耗面。必须在调用 bcrypt **之前**就挡住。
 */
const unbindByUser = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, maxHits: 5 });
const unbindByIp = new SlidingWindowRateLimiter({ windowMs: 15 * 60 * 1000, maxHits: 20 });

const unbindSchema = z.object({
  password: z.string().min(1, QQ_BINDING_ERRORS.passwordRequired)
});

const verifySchema = z.object({
  qq: z.union([z.string(), z.number()]),
  code: z.string().min(1),
  source: z.string().max(40).optional(),
  botSelfId: z.string().max(40).optional()
});

// 可安全回给客户端的业务错误，必须与 services/qqBinding.ts 抛出的保持同步
const SAFE_ERROR_MESSAGES = new Set<string>(Object.values(QQ_BINDING_ERRORS));

function createErrorResponse(error: unknown) {
  if (error instanceof z.ZodError) {
    return { status: 400, body: { error: error.issues[0]?.message || '参数错误' } };
  }
  if (error instanceof Error && SAFE_ERROR_MESSAGES.has(error.message)) {
    return { status: 400, body: { error: error.message } };
  }
  if (error instanceof Error) {
    // eslint-disable-next-line no-console
    console.error('[qq-binding] unexpected error:', error);
    return { status: 500, body: { error: '操作失败' } };
  }
  return { status: 500, body: { error: '未知错误' } };
}

/** 用户侧路由（需登录） */
/**
 * QQ 通知与绑定的总开关（2026-07-30 起该功能暂时下线）。
 *
 * 默认关闭。置 QQ_NOTIFY_ENABLED=1 可恢复，需与前端的同名变量一起开。
 * 现有绑定数据一律保留（下线时库里有 19 条 ACTIVE），不做任何清理。
 */
/**
 * 功能下线时挡住**新建**绑定的路径。
 *
 * 只挡新建（/start 与机器人回调 /verify），不挡 /unbind、/cancel ——
 * 已经绑好的用户必须始终能自己解绑，把退出的路也堵上等于把人困住。
 * 回调一并挡住是刻意的：验证不通过，机器人会拒绝好友申请，
 * 这正是我们想要的失败方向（宁可不加好友，也不要建立新绑定）。
 */
function requireQqEnabled(_req: Request, res: Response, next: NextFunction) {
  if (qqFeatureEnabled()) return next();
  return res.status(503).json({ error: 'QQ 通知功能已暂时下线' });
}

export function qqBindingRouter() {
  const router = Router();

  router.use((_req, res, next) => {
    // 绑定状态含验证码相关信息，任何中间层都不应缓存
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // 发起绑定：返回明文验证码（**只此一次**，库里只存哈希）
  router.post('/start', requireAuth, requireQqEnabled, async (req, res) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const botQq = getQqBotSelfId();

      // 没配机器人 QQ 就别放行：会生成一个挑战、返回成功，
      // 而界面只能告诉用户「添加（机器人账号）为好友」—— 一个他无从得知的号码。
      // 用户既加不了好友，还白白消耗一次发起限流额度，验证码也只能等它过期。
      // 这个检查必须在限流之前，配置缺失不该算到用户头上。
      if (!botQq) {
        // eslint-disable-next-line no-console
        console.error('[qq-binding] QQ_BOT_SELF_ID 未配置，拒绝发起绑定');
        return res.status(503).json({ error: 'QQ 绑定暂不可用，请稍后再试' });
      }

      const ip = req.ip || 'unknown';
      if (!startByUser.hit(req.authUser.id) || !startByIp.hit(ip)) {
        return res.status(429).json({ error: '操作过于频繁，请稍后再试' });
      }

      const result = await startQqBinding(req.authUser.id, botQq);
      res.json({
        ok: true,
        code: result.code,
        expiresAt: result.expiresAt.toISOString(),
        ttlMinutes: result.ttlMinutes,
        botQq: result.botQq,
        instructions: {
          step1: `添加 QQ ${result.botQq ?? '（机器人账号）'} 为好友`,
          step2: '在好友申请的「验证信息」里填入上面的验证码',
          step3: '通过后本页会自动确认，无需再发消息',
          note: '验证码只显示这一次，刷新页面后需要重新生成'
        }
      });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  // 查询绑定状态（前端轮询这个接口确认绑定完成）
  router.get('/status', requireAuth, async (req, res) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const status = await getQqBindingStatus(req.authUser.id);
      res.json({
        ok: true,
        botQq: getQqBotSelfId(),
        binding: status.binding
          ? {
              addressMask: status.binding.addressMask,
              displayName: status.binding.displayName,
              status: status.binding.status,
              verifiedAt: status.binding.verifiedAt.toISOString(),
              suspendedUntil: status.binding.suspendedUntil?.toISOString() ?? null
            }
          : null,
        challenge: status.challenge
          ? {
              codeHint: status.challenge.codeHint,
              expiresAt: status.challenge.expiresAt.toISOString(),
              createdAt: status.challenge.createdAt.toISOString()
            }
          : null
      });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  // 取消进行中的绑定
  router.delete('/cancel', requireAuth, async (req, res) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const cancelled = await cancelQqBinding(req.authUser.id);
      if (!cancelled) return res.status(404).json({ error: QQ_BINDING_ERRORS.noChallenge });
      res.json({ ok: true });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  // 解绑：必须二次凭据。没有它，会话被劫持者可以静默把推送目标改到自己的 QQ，
  // 持续窃取受害者的站点活动情报，而受害者只会以为「通知坏了」。
  router.post('/unbind', requireAuth, async (req, res) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });

      // 限流必须在 bcrypt.compare 之前 —— 否则挡住的只是结果，CPU 已经被消耗掉了
      const ip = req.ip || 'unknown';
      if (!unbindByUser.hit(req.authUser.id) || !unbindByIp.hit(ip)) {
        return res.status(429).json({ error: '尝试过于频繁，请稍后再试' });
      }

      const payload = unbindSchema.parse(req.body ?? {});
      await unbindQq(req.authUser.id, async (hash) => {
        if (!hash) return false;
        return bcrypt.compare(payload.password, hash);
      });
      res.json({ ok: true });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  return router;
}

/** 内部路由：供 qqbot 回调核销验证码。不使用 requireAuth，仅限内网调用。 */
export function qqBindingInternalRouter() {
  const router = Router();

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.use((req, res, next) => {
    // 独立密钥：qqbot 不应该同时拿到能调 /internal/wikidot-binding/complete 的钥匙
    const auth = verifyInternalKey(req, 'QQ_BOT_INTERNAL_KEY');
    if (!auth.ok) return res.status(auth.status).json(auth.body);
    next();
  });

  router.post('/verify', requireQqEnabled, async (req, res) => {
    try {
      const payload = verifySchema.parse(req.body ?? {});

      const addressKey = String(payload.qq);
      if (!verifyGlobal.hit('global') || !verifyByAddress.hit(addressKey)) {
        // 200 而非 429：机器人会把 reply 原样发给用户，让用户看到人话而不是状态码
        return res.json({
          ok: true,
          matched: false,
          reason: 'rate_limited',
          reply: '尝试太频繁了，请稍等几分钟再试。'
        });
      }

      const outcome = await verifyQqBinding({ qq: payload.qq, code: payload.code, source: payload.source });
      res.json({ ok: true, matched: outcome.matched, reason: outcome.reason ?? null, reply: outcome.reply });
    } catch (error) {
      const { status, body } = createErrorResponse(error);
      res.status(status).json(body);
    }
  });

  return router;
}
