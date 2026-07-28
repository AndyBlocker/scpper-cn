import { timingSafeEqual } from 'crypto';
import type { Request } from 'express';

/**
 * 服务间共享密钥的常数时间比较。
 *
 * 现有的 wikidotBinding.ts:229、bff/src/web/router.ts:57、mail-agent 都用的是裸 `!==`：
 * 字符串比较在首个不同字节处短路，攻击者可以用响应耗时逐字节爆破出密钥。
 * 同仓的 utils/auth-token.ts 已经正确用了 timingSafeEqual，新代码统一走这里。
 *
 * 长度不等直接判否 —— 长度本身会泄露，这是该原语的固有取舍，可接受。
 */
export function safeKeyEquals(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export type InternalAuthResult =
  | { ok: true }
  | { ok: false; status: 503 | 403; body: { error: string } };

/**
 * 校验 x-internal-key。
 *
 * 密钥未配置时 **fail closed 返回 503**，而不是放行。
 * 放行的话，一次漏配 .env 就等于把内部接口开给所有人，而且没有任何报错线索。
 *
 * @param envName 环境变量名。**不同调用方必须用不同的密钥** ——
 *   例如 qqbot 拿到的 QQ_BOT_INTERNAL_KEY 不应该同时能调
 *   /internal/wikidot-binding/complete（那意味着它能把任意 Wikidot 账号绑到任意用户）。
 */
export function verifyInternalKey(req: Request, envName: string): InternalAuthResult {
  const expected = (process.env[envName] || '').trim();
  if (!expected) {
    return { ok: false, status: 503, body: { error: 'Internal API key not configured' } };
  }
  const provided = String(req.headers['x-internal-key'] || '').trim();
  if (!provided || !safeKeyEquals(provided, expected)) {
    return { ok: false, status: 403, body: { error: 'Forbidden' } };
  }
  return { ok: true };
}
