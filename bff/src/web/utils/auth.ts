import type { Request } from 'express';
import type { Pool } from 'pg';

export interface AuthUserPayload {
  id: string;
  email: string;
  displayName: string | null;
  linkedWikidotId: number | null;
  lastLoginAt: string | null;
}

const USER_BACKEND_DEFAULT = 'http://127.0.0.1:4455';

export async function fetchAuthUser(req: Request): Promise<AuthUserPayload | null> {
  const base = process.env.USER_BACKEND_BASE_URL || USER_BACKEND_DEFAULT;
  if (!base || base === 'disable') return null;
  const target = base.replace(/\/$/, '') + '/auth/me';
  try {
    const response = await fetch(target, {
      method: 'GET',
      headers: { accept: 'application/json', cookie: req.headers.cookie ?? '' }
    });
    if (response.status === 401 || !response.ok) return null;
    const data = await response.json();
    if (!data?.ok || !data.user) return null;
    return {
      id: String(data.user.id),
      email: String(data.user.email || ''),
      displayName: data.user.displayName ?? null,
      linkedWikidotId: data.user.linkedWikidotId != null ? Number(data.user.linkedWikidotId) : null,
      lastLoginAt: data.user.lastLoginAt ?? null
    };
  } catch {
    return null;
  }
}

export async function ensureUserByWikidotId(pool: Pool, wikidotId: number): Promise<number | null> {
  if (!Number.isFinite(wikidotId) || wikidotId <= 0) return null;
  const found = await pool.query<{ id: number }>('SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1', [wikidotId]);
  if (found.rows.length > 0) return found.rows[0].id;
  const inserted = await pool.query<{ id: number }>(
    'INSERT INTO "User" ("wikidotId") VALUES ($1) ON CONFLICT ("wikidotId") DO NOTHING RETURNING id',
    [wikidotId]
  );
  if (inserted.rows.length > 0) return inserted.rows[0].id;
  const again = await pool.query<{ id: number }>('SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1', [wikidotId]);
  return again.rows.length > 0 ? again.rows[0].id : null;
}
