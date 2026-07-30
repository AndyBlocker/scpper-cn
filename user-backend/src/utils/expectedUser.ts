import type { Request, Response } from 'express';

export const EXPECTED_USER_ID_HEADER = 'x-scpper-expected-user-id';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function expectedUserId(req: Request): string | null {
  const raw = req.headers[EXPECTED_USER_ID_HEADER];
  if (raw === undefined) return null;
  if (Array.isArray(raw)) return raw.join(',');
  return String(raw).trim();
}

/**
 * Reject a mutation when the browser's last trusted account snapshot no
 * longer matches the identity represented by the current session cookie.
 *
 * Missing headers remain valid for rolling deploys and older clients.
 * Authentication is still owned by requireAuth; this is an additional
 * optimistic-concurrency boundary, not an authorization mechanism.
 */
export function rejectExpectedUserMismatch(
  req: Request,
  res: Response,
  actualUserId: string
): boolean {
  const expected = expectedUserId(req);
  if (expected === null || SAFE_METHODS.has(req.method.toUpperCase())) {
    return false;
  }
  if (expected === actualUserId) return false;

  res.status(409).json({
    code: 'account_mismatch',
    error: '登录账号已切换，请刷新后重试。'
  });
  return true;
}
