import type { Request, Response } from 'express';

export const EXPECTED_USER_ID_HEADER = 'x-scpper-expected-user-id';

function expectedUserId(req: Request): string | null {
  const raw = req.headers[EXPECTED_USER_ID_HEADER];
  if (raw === undefined) return null;
  if (Array.isArray(raw)) return raw.join(',');
  return String(raw).trim();
}

function isAuthSourceOfTruth(req: Request): boolean {
  const raw = String(req.originalUrl || req.url || req.path || '/');
  const path = (raw.split(/[?#]/u, 1)[0] || '/').replace(/\/+$/u, '') || '/';
  return path === '/auth/me';
}

/**
 * Reject an authenticated request when the browser's last trusted account
 * snapshot no longer matches the identity represented by the current session
 * cookie. This includes account-private GETs such as gacha/admin reads.
 *
 * Missing headers remain valid for rolling deploys and older clients.
 * Authentication is still owned by requireAuth; this is an additional
 * optimistic-concurrency/privacy boundary, not an authorization mechanism.
 * `/auth/me` is always exempt because it is the source used to recover from a
 * mismatch; the frontend deliberately sends no expected-user header there.
 */
export function rejectExpectedUserMismatch(
  req: Request,
  res: Response,
  actualUserId: string
): boolean {
  const expected = expectedUserId(req);
  if (
    expected === null
    || req.method.toUpperCase() === 'OPTIONS'
    || isAuthSourceOfTruth(req)
  ) {
    return false;
  }
  if (expected === actualUserId) return false;

  res.status(409).json({
    code: 'account_mismatch',
    error: '登录账号已切换，请刷新后重试。'
  });
  return true;
}
