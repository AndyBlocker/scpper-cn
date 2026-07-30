import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { parseCookieHeader } from '../utils/cookies.js';
import { extractUserId, verifyAuthToken } from '../utils/auth-token.js';
import { maskQqNumber } from '../services/qqBindingProof.js';
import {
  qqFeatureEnabled,
  qqNotificationsEnabled,
  type QqFeatureEnvironment
} from '../utils/qqFeature.js';
import { rejectExpectedUserMismatch } from '../utils/expectedUser.js';

/** 通知渠道绑定摘要。**只含掩码**，完整地址不出 user-backend 的投递路径。 */
export interface AuthChannelBinding {
  bound: boolean;
  addressMask: string | null;
  status: string | null;
  pendingChallenge: boolean;
  capabilities: {
    featureEnabled: boolean;
    createBinding: boolean;
    deliverNotifications: boolean;
    manageExistingBinding: boolean;
  };
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

/**
 * /auth/login、/auth/profile 与 /auth/me 共用的 QQ 摘要格式。
 *
 * featureEnabled 表示投递总开关；createBinding 还要求机器人账号配置就绪；
 * deliverNotifications 与 backend 投递器使用相同判据，不会因纯展示用途的
 * QQ_BOT_SELF_ID 缺失而谎报“不会投递”。manageExistingBinding 则刻意不受
 * 总开关限制，确保下线期间已有绑定或待取消挑战仍有退出入口。
 */
export function formatAuthQqBinding(
  binding: { address: string; status: string } | null | undefined,
  pendingChallenge: boolean,
  environment: QqFeatureEnvironment = process.env
): AuthChannelBinding {
  const bound = Boolean(binding && binding.status !== 'REVOKED');
  const status = bound ? binding?.status ?? null : null;
  const featureEnabled = qqNotificationsEnabled(environment);
  const createBindingEnabled = qqFeatureEnabled(environment);
  return {
    bound,
    addressMask: bound && binding ? maskQqNumber(binding.address) : null,
    status,
    pendingChallenge,
    capabilities: {
      featureEnabled,
      createBinding: createBindingEnabled && !bound,
      deliverNotifications: featureEnabled && bound && status === 'ACTIVE',
      manageExistingBinding: bound || pendingChallenge
    }
  };
}

interface CachedUser {
  id: string;
  email: string;
  displayName: string | null;
  linkedWikidotId: number | null;
  lastLoginAt: Date | null;
  updatedAt: Date;
  status: string;
  passwordHash: string | null;
  qqBinding: AuthChannelBinding;
  cachedAt: number;
}

const userCache = new Map<string, CachedUser>();
// Deduplicate concurrent in-flight lookups for the same userId
const inflightLookups = new Map<string, Promise<CachedUser | null>>();
// invalidateAuthCache 会把旧 Promise 从 inflightLookups 移走以允许新查询；
// 单独计数才能知道那些已被移走、但数据库调用仍未结束的旧查询何时真正退出。
const activeLookupCounts = new Map<string, number>();

/**
 * 每用户的失效世代号。
 *
 * 光从两个 Map 里 delete 挡不住**已经在跑**的那次查询：它稍后仍会
 * userCache.set 把失效**之前**读到的结果写回去，于是绑定刚完成的用户
 * 在整个 TTL 内 /auth/me 都还报 bound:false，界面上像是没绑上。
 * 查询开始时抓一份世代号，写回前比对，不一致就丢弃。
 * 带时间戳是为了能清理：超过缓存 TTL 且已经没有活跃查询时，这个世代号
 * 才不再需要；仍有旧查询运行时必须保留，避免它误把缺失世代当成初始世代。
 */
let generationCounter = 0;
const cacheGeneration = new Map<string, { gen: number; at: number }>();
const generationOf = (userId: string) => cacheGeneration.get(userId)?.gen ?? 0;

function beginActiveLookup(userId: string) {
  activeLookupCounts.set(userId, (activeLookupCounts.get(userId) ?? 0) + 1);
}

function endActiveLookup(userId: string) {
  const remaining = (activeLookupCounts.get(userId) ?? 1) - 1;
  if (remaining > 0) {
    activeLookupCounts.set(userId, remaining);
  } else {
    activeLookupCounts.delete(userId);
  }
}

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
  beginActiveLookup(userId);
  const promise = (async () => {
    try {
      const user = await prisma.userAccount.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          displayName: true,
          linkedWikidotId: true,
          lastLoginAt: true,
          // 跨进程缓存版本。CLI 不能触及在线服务的内存 Map，因此缓存命中时
          // 会用一次只取 updatedAt 的轻量查询确认这份快照仍是当前版本。
          updatedAt: true,
          status: true,
          passwordHash: true,
          // 一并取出通知渠道绑定：这个查询本来就有 30 秒缓存，且绑定变更时会
          // invalidateAuthCache，所以代价是「每次缓存未命中多一个 join」而不是每请求一次。
          // 放在这里的另一个好处是 BFF 的 fetchAuthUser 走 /auth/me 就能拿到，不必再加一跳。
          channelBindings: {
            where: { channel: 'QQ' },
            select: { address: true, status: true }
          },
          channelChallenges: {
            where: {
              channel: 'QQ',
              status: 'PENDING',
              expiresAt: { gt: new Date() }
            },
            select: { id: true },
            take: 1
          }
        }
      });

      // 查询期间发生失效时，这份结果不仅不能写缓存，也不能返回给当前请求：
      // 它可能仍含旧 passwordHash 或绑定摘要。失效函数已经解除旧 Promise 的去重，
      // 因此这里会加入更新一轮查询，或在尚未开始时自己发起一轮。
      if (generationOf(userId) !== startedGeneration) {
        return fetchAndCacheUser(userId);
      }
      if (!user) return null;

      const qq = user.channelBindings[0];
      const qqBinding = formatAuthQqBinding(qq, user.channelChallenges.length > 0);
      const cached: CachedUser = {
        id: user.id,
        email: user.email,
        displayName: user.displayName ?? null,
        linkedWikidotId: user.linkedWikidotId ?? null,
        lastLoginAt: user.lastLoginAt ?? null,
        updatedAt: user.updatedAt,
        status: user.status,
        passwordHash: user.passwordHash,
        qqBinding,
        cachedAt: Date.now()
      };
      userCache.set(userId, cached);
      return cached;
    } finally {
      endActiveLookup(userId);
    }
  })();

  inflightLookups.set(userId, promise);
  try {
    return await promise;
  } finally {
    // 失效后可能已经为同一用户启动了更新的一轮查询；旧 Promise 结束时不能
    // 把那一轮从去重表误删，否则并发 /auth/me 会再次打出重复查询。
    if (inflightLookups.get(userId) === promise) {
      inflightLookups.delete(userId);
    }
  }
}

/**
 * 返回经过数据库版本校验的认证快照。
 *
 * 管理员路由与 CLI 都可能在别的 Node 进程修改 UserAccount。纯 TTL 缓存会让
 * 旧 linkedWikidotId/passwordHash 最多继续生效 30 秒；每次缓存命中只查询
 * updatedAt，发现变化后复用现有世代机制失效并完整刷新。查询失败会向上抛出，
 * 不会在无法确认版本时继续信任旧认证数据。
 */
async function fetchCurrentUser(userId: string): Promise<CachedUser | null> {
  const cached = getCachedUser(userId);
  if (!cached) return fetchAndCacheUser(userId);

  const current = await prisma.userAccount.findUnique({
    where: { id: userId },
    select: { updatedAt: true }
  });
  if (
    !current
    || current.updatedAt.getTime() !== cached.updatedAt.getTime()
  ) {
    invalidateAuthCache(userId);
    return fetchAndCacheUser(userId);
  }
  return cached;
}

/**
 * Immediately evict a user from the auth cache.
 * Call after any operation that changes an AuthUser field or token verification input.
 */
export function invalidateAuthCache(userId: string) {
  generationCounter += 1;
  cacheGeneration.set(userId, { gen: generationCounter, at: Date.now() });
  userCache.delete(userId);
  inflightLookups.delete(userId);
}

/**
 * 只供无数据库副作用的并发证明测试使用；生产路由不会引用这个导出。
 * 测试需要控制 Prisma Promise 的完成顺序，才能稳定复现“查询中失效”竞态。
 */
export const __authCacheTesting = {
  fetchAndCacheUser,
  fetchCurrentUser,
  getCachedUser,
  reset() {
    userCache.clear();
    inflightLookups.clear();
    activeLookupCounts.clear();
    cacheGeneration.clear();
    generationCounter = 0;
  }
};

// Periodic cleanup to prevent memory leaks (every 60 seconds)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of userCache) {
    if (now - entry.cachedAt > AUTH_CACHE_TTL_MS) {
      userCache.delete(key);
    }
  }
  // 世代号同样要清理，否则会随用户数无限增长。仍有旧查询活跃时不能删：
  // 删除会让 generationOf 回到 0，使失效前启动的超慢查询误判为「世代未变」。
  for (const [key, entry] of cacheGeneration) {
    if (
      now - entry.at > AUTH_CACHE_TTL_MS
      && !activeLookupCounts.has(key)
    ) {
      cacheGeneration.delete(key);
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
    const user = await fetchCurrentUser(userId);
    if (!user || user.status !== 'ACTIVE') {
      return res.status(401).json({ error: '账号不可用' });
    }
    const verification = verifyAuthToken(token, user.passwordHash);
    if (!verification.valid) {
      return res.status(401).json({ error: verification.expired ? '登录状态已过期' : '登录状态无效' });
    }
    // The optional header comes from the frontend's last trusted auth
    // snapshot. A cookie replaced by another tab must not turn a stale form
    // submission into a mutation against that other account.
    if (rejectExpectedUserMismatch(req, res, user.id)) {
      return;
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
