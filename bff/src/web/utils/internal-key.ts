import type { Request } from 'express';

/**
 * 判断请求是否带着有效的内部密钥。
 *
 * 用于把可信的服务端调用（例如资源预热脚本）排除在限流之外。
 * 这里刻意不看来源 IP —— 前端 Nuxt 把 /api/** 代理到 127.0.0.1:4396，
 * 公网请求到了 BFF 同样表现为本机来源，仅凭回环地址判断等于对所有人放行。
 */
export function hasInternalKey(req: Request): boolean {
  const expected = (process.env.BFF_INTERNAL_API_KEY || '').trim();
  if (!expected) return false;
  const provided = String(req.get('x-internal-key') || '').trim();
  return provided.length > 0 && provided === expected;
}
