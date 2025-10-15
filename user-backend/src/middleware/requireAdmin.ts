import type { Request, Response, NextFunction } from 'express';
import { requireAuth } from './requireAuth.js';

function parseAdminEmails(): Set<string> {
  const raw = process.env.USER_ADMIN_EMAILS || '';
  const emails = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return new Set(emails);
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const admins = parseAdminEmails();
  if (admins.size === 0) {
    // In development, allow wildcard for convenience: USER_ADMIN_EMAILS=*
    // Never default to allow-all in production.
    const wildcard = (process.env.USER_ADMIN_EMAILS || '').trim();
    if (wildcard === '*' && process.env.NODE_ENV !== 'production') return true;
    return false;
  }
  return admins.has(email.toLowerCase());
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  // Ensure authenticated first
  await new Promise<void>((resolve) => requireAuth(req, res, () => resolve()));
  if (!req.authUser) return; // requireAuth already responded with 401
  if (!isAdminEmail(req.authUser.email)) {
    res.status(403).json({ error: '无权限' });
    return;
  }
  next();
}

