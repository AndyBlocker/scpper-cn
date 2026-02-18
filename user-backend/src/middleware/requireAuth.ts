import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { parseCookieHeader } from '../utils/cookies.js';
import { extractUserId, verifyAuthToken } from '../utils/auth-token.js';

declare module 'express-serve-static-core' {
  interface Request {
    authUser?: {
      id: string;
      email: string;
      displayName: string | null;
      linkedWikidotId: number | null;
      lastLoginAt: Date | null;
    };
  }
}

// ─── In-memory user cache (short TTL to reduce DB round-trips) ────────
const AUTH_CACHE_TTL_MS = 30_000; // 30 seconds

interface CachedUser {
  id: string;
  email: string;
  displayName: string | null;
  linkedWikidotId: number | null;
  lastLoginAt: Date | null;
  status: string;
  passwordHash: string | null;
  cachedAt: number;
}

const userCache = new Map<string, CachedUser>();
// Deduplicate concurrent in-flight lookups for the same userId
const inflightLookups = new Map<string, Promise<CachedUser | null>>();

function getCachedUser(userId: string): CachedUser | null {
  const entry = userCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > AUTH_CACHE_TTL_MS) {
    userCache.delete(userId);
    return null;
  }
  return entry;
}

async function fetchAndCacheUser(userId: string): Promise<CachedUser | null> {
  // If there's already an in-flight lookup for this userId, reuse it
  const inflight = inflightLookups.get(userId);
  if (inflight) return inflight;

  const promise = (async () => {
    const user = await prisma.userAccount.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        displayName: true,
        linkedWikidotId: true,
        lastLoginAt: true,
        status: true,
        passwordHash: true
      }
    });
    if (!user) return null;
    const cached: CachedUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? null,
      linkedWikidotId: user.linkedWikidotId ?? null,
      lastLoginAt: user.lastLoginAt ?? null,
      status: user.status,
      passwordHash: user.passwordHash,
      cachedAt: Date.now()
    };
    userCache.set(userId, cached);
    return cached;
  })();

  inflightLookups.set(userId, promise);
  try {
    return await promise;
  } finally {
    inflightLookups.delete(userId);
  }
}

// Periodic cleanup to prevent memory leaks (every 60 seconds)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of userCache) {
    if (now - entry.cachedAt > AUTH_CACHE_TTL_MS) {
      userCache.delete(key);
    }
  }
}, 60_000).unref();

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const cookies = parseCookieHeader(req.headers.cookie);
    const token = cookies[config.session.cookieName];
    if (!token) {
      return res.status(401).json({ error: '未登录' });
    }
    const userId = extractUserId(token);
    if (!userId) {
      return res.status(401).json({ error: '登录状态已失效' });
    }
    const user = getCachedUser(userId) ?? await fetchAndCacheUser(userId);
    if (!user || user.status !== 'ACTIVE') {
      return res.status(401).json({ error: '账号不可用' });
    }
    const verification = verifyAuthToken(token, user.passwordHash);
    if (!verification.valid) {
      return res.status(401).json({ error: verification.expired ? '登录状态已过期' : '登录状态无效' });
    }
    req.authUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? null,
      linkedWikidotId: user.linkedWikidotId ?? null,
      lastLoginAt: user.lastLoginAt ?? null
    };
    next();
  } catch (error) {
    next(error);
  }
}
