import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from './requireAuth.js';

// Parse and cache admin emails at module load time
const _adminEmailsRaw = (process.env.USER_ADMIN_EMAILS || '').trim();
const _adminEmails: Set<string> = new Set(
  _adminEmailsRaw.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s.length > 0)
);
const _isWildcard = _adminEmailsRaw === '*' && process.env.NODE_ENV !== 'production';

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  if (_adminEmails.size === 0) {
    return _isWildcard;
  }
  return _adminEmails.has(email.toLowerCase());
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    // Ensure authenticated first.
    await new Promise<void>((resolve, reject) => {
      requireAuth(req, res, (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
    if (res.headersSent || !req.authUser) {
      return;
    }
    if (!isAdminEmail(req.authUser.email)) {
      res.status(403).json({ error: '无权限' });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}
