import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

export function intEnv(name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function clientRateLimitKey(req: Request): string {
  const ip = ipKeyGenerator(req.ip || req.socket.remoteAddress || 'unknown');
  const signal = [
    req.get('user-agent') || '',
    req.get('accept-language') || '',
    req.get('sec-ch-ua-platform') || '',
    req.get('sec-ch-ua-mobile') || '',
    req.get('x-tls-fingerprint') || ''
  ].join('|');
  return `${ip}:${shortHash(signal)}`;
}

export function rateLimitHandler(scope: string) {
  return (req: Request, res: Response, _next: NextFunction, options: { statusCode: number; message: unknown }) => {
    // Keep this intentionally small: never log full headers, cookies, or query strings here.
    // eslint-disable-next-line no-console
    console.warn('[rate-limit]', {
      scope,
      method: req.method,
      path: req.path,
      ip: req.ip || req.socket.remoteAddress || 'unknown'
    });
    res.status(options.statusCode).json(options.message);
  };
}
