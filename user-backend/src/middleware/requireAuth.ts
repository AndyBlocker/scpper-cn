import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { parseCookieHeader } from '../utils/cookies.js';
import { extractUserId, verifyAuthToken } from '../utils/auth-token.js';
import { maskQqNumber } from '../services/qqBindingProof.js';

/** 通知渠道绑定摘要。**只含掩码**，完整地址不出 user-backend 的投递路径。 */
export interface AuthChannelBinding {
  bound: boolean;
  addressMask: string | null;
  status: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    authUser?: {
      id: string;
      email: string;
      displayName: string | null;
      linkedWikidotId: number | null;
      lastLoginAt: Date | null;
      qqBinding: AuthChannelBinding;
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
  qqBinding: AuthChannelBinding;
  cachedAt: number;
}

const userCache = new Map<string, CachedUser>();
// Deduplicate concurrent in-flight lookups for the same userId
const inflightLookups = new Map<string, Promise<CachedUser | null>>();

/**
 * 每用户的失效世代号。
 *
 * 光从两个 Map 里 delete 挡不住**已经在跑**的那次查询：它稍后仍会
 * userCache.set 把失效**之前**读到的结果写回去，于是绑定刚完成的用户
 * 在整个 TTL 内 /auth/me 都还报 bound:false，界面上像是没绑上。
 * 查询开始时抓一份世代号，写回前比对，不一致就丢弃。
 * 带时间戳是为了能清理：一个世代号只对「在它之前启动、之后才结束」的
 * 查询有意义，超过缓存 TTL 就没有保留价值了。
 */
let generationCounter = 0;
const cacheGeneration = new Map<string, { gen: number; at: number }>();
const generationOf = (userId: string) => cacheGeneration.get(userId)?.gen ?? 0;

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

  const startedGeneration = generationOf(userId);
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
        passwordHash: true,
        // 一并取出通知渠道绑定：这个查询本来就有 30 秒缓存，且绑定变更时会
        // invalidateAuthCache，所以代价是「每次缓存未命中多一个 join」而不是每请求一次。
        // 放在这里的另一个好处是 BFF 的 fetchAuthUser 走 /auth/me 就能拿到，不必再加一跳。
        channelBindings: {
          where: { channel: 'QQ' },
          select: { address: true, status: true }
        }
      }
    });
    if (!user) return null;
    const qq = user.channelBindings[0];
    const qqBinding: AuthChannelBinding = qq && qq.status !== 'REVOKED'
      ? { bound: true, addressMask: maskQqNumber(qq.address), status: qq.status }
      : { bound: false, addressMask: null, status: null };
    const cached: CachedUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName ?? null,
      linkedWikidotId: user.linkedWikidotId ?? null,
      lastLoginAt: user.lastLoginAt ?? null,
      status: user.status,
      passwordHash: user.passwordHash,
      qqBinding,
      cachedAt: Date.now()
    };
    // 期间被失效过就不写回，否则会把失效前的旧状态再撑一个 TTL
    if (generationOf(userId) === startedGeneration) userCache.set(userId, cached);
    return cached;
  })();

  inflightLookups.set(userId, promise);
  try {
    return await promise;
  } finally {
    inflightLookups.delete(userId);
  }
}

/**
 * Immediately evict a user from the auth cache.
 * Call after any operation that changes passwordHash, status, or linkedWikidotId.
 */
export function invalidateAuthCache(userId: string) {
  generationCounter += 1;
  cacheGeneration.set(userId, { gen: generationCounter, at: Date.now() });
  userCache.delete(userId);
  inflightLookups.delete(userId);
}

// Periodic cleanup to prevent memory leaks (every 60 seconds)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of userCache) {
    if (now - entry.cachedAt > AUTH_CACHE_TTL_MS) {
      userCache.delete(key);
    }
  }
  // 世代号同样要清理，否则会随用户数无限增长
  for (const [key, entry] of cacheGeneration) {
    if (now - entry.at > AUTH_CACHE_TTL_MS) cacheGeneration.delete(key);
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
      lastLoginAt: user.lastLoginAt ?? null,
      qqBinding: user.qqBinding
    };
    next();
  } catch (error) {
    next(error);
  }
}
