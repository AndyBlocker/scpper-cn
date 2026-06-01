import type { RedisClientType } from 'redis';

type Loader<T> = () => Promise<T>;

type RememberOptions = {
  /** When false (default), null/undefined results will not be cached */
  cacheNull?: boolean;
};

export type CacheHandle = {
  enabled: boolean;
  remember<T>(key: string, ttlSeconds: number, loader: Loader<T>, options?: RememberOptions): Promise<T>;
  getJSON<T>(key: string): Promise<T | null>;
  setJSON(key: string, value: unknown, ttlSeconds: number): Promise<void>;
};

const DEFAULT_PREFIX = 'scpcn:bff:';

// #124：统一缓存契约为"JSON 归一化值"。Redis 命中走 JSON.parse（Date 退化为字符串），
// 未命中却直接返回 loader 的原始对象（Date 仍是对象），导致同一 key 命中/未命中类型不一致、
// 消费端行为漂移。jsonClone 让未命中路径也返回归一化形态，并据此存储，使命中/未命中、
// Redis/内存后端的返回类型一律一致（日期统一为字符串，符合代码库"字段可能是字符串需转换"约定）。
function jsonClone<T>(value: T): T {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  try {
    return JSON.parse(JSON.stringify(value)) as T;
  } catch {
    return value;
  }
}

// Simple in-memory cache fallback when Redis is unavailable
const memoryCache = new Map<string, { value: unknown; expiresAt: number }>();
const MAX_MEMORY_CACHE_SIZE = 1000;

type MemoryStore = Map<string, { value: unknown; expiresAt: number }>;

function memoryGet<T>(store: MemoryStore, key: string): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry.value as T;
}

function memorySet(store: MemoryStore, maxSize: number, key: string, value: unknown, ttlSeconds: number): void {
  // Evict old entries if cache is too large
  if (store.size >= maxSize) {
    const now = Date.now();
    for (const [k, v] of store) {
      if (v.expiresAt < now) store.delete(k);
    }
    // If still too large, delete oldest entries
    if (store.size >= maxSize) {
      const keysToDelete = Array.from(store.keys()).slice(0, 100);
      keysToDelete.forEach(k => store.delete(k));
    }
  }
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

type CreateCacheOptions = {
  /** Use an isolated in-memory store instead of the shared global one */
  isolatedMemory?: boolean;
  /** Max entries for isolated memory store (default: MAX_MEMORY_CACHE_SIZE) */
  maxMemorySize?: number;
};

export function createCache(redis: RedisClientType | null, prefix?: string, options?: CreateCacheOptions): CacheHandle;
export function createCache(redis: RedisClientType | null, prefix = DEFAULT_PREFIX, options: CreateCacheOptions = {}): CacheHandle {
  // In-flight loader deduplication (singleflight) to prevent thundering herd
  const inflight = new Map<string, Promise<unknown>>();

  const maxSize = options.maxMemorySize ?? MAX_MEMORY_CACHE_SIZE;

  if (!redis) {
    const store: MemoryStore = options.isolatedMemory ? new Map() : memoryCache;
    // Use in-memory cache as fallback when Redis is unavailable
    return {
      enabled: true, // Memory cache is still caching
      async remember<T>(key: string, ttl: number, loader: Loader<T>, opts?: RememberOptions): Promise<T> {
        const fullKey = `${prefix}${key}`;
        const cached = memoryGet<T>(store, fullKey);
        if (cached !== null) return cached;

        // Deduplicate concurrent loads for the same key
        const existing = inflight.get(fullKey);
        if (existing) return existing as Promise<T>;

        const promise = (async () => {
          try {
            const result = await loader();
            if (result === undefined) return result;
            if (result === null && opts?.cacheNull !== true) return result;
            // 存储并返回归一化形态，使内存后端的命中/未命中与 Redis 后端口径一致（#124）。
            const normalized = jsonClone(result);
            memorySet(store, maxSize, fullKey, normalized, ttl);
            return normalized;
          } finally {
            inflight.delete(fullKey);
          }
        })();
        inflight.set(fullKey, promise);
        return promise as Promise<T>;
      },
      async getJSON<T>(key: string): Promise<T | null> {
        return memoryGet<T>(store, `${prefix}${key}`);
      },
      async setJSON(key: string, value: unknown, ttlSeconds: number): Promise<void> {
        if (value !== undefined) {
          memorySet(store, maxSize, `${prefix}${key}`, value, ttlSeconds);
        }
      }
    };
  }

  const client = redis as RedisClientType;
  const namespaced = (key: string) => `${prefix}${key}`;

  async function getJSON<T>(key: string): Promise<T | null> {
    try {
      const raw = await client.get(namespaced(key));
      if (!raw) return null;
      return JSON.parse(raw) as T;
    } catch (error) {
      console.warn('[cache] getJSON failed', key, error);
      return null;
    }
  }

  async function setJSON(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (value === undefined) return;
    try {
      const payload = JSON.stringify(value);
      if (ttlSeconds > 0) {
        await client.set(namespaced(key), payload, { EX: ttlSeconds });
      } else {
        await client.set(namespaced(key), payload);
      }
    } catch (error) {
      console.warn('[cache] setJSON failed', key, error);
    }
  }

  async function remember<T>(
    key: string,
    ttlSeconds: number,
    loader: Loader<T>,
    options?: RememberOptions
  ): Promise<T> {
    const cached = await getJSON<T>(key);
    if (cached !== null) {
      return cached;
    }

    const fullKey = namespaced(key);
    const existing = inflight.get(fullKey);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      try {
        const result = await loader();
        if (result === undefined) return result;
        if (result === null && options?.cacheNull !== true) return result;
        await setJSON(key, result, ttlSeconds);
        // 未命中也返回 JSON 归一化形态，与后续命中（getJSON→JSON.parse）口径一致（#124）。
        return jsonClone(result);
      } finally {
        inflight.delete(fullKey);
      }
    })();
    inflight.set(fullKey, promise);
    return promise as Promise<T>;
  }

  return {
    enabled: true,
    remember,
    getJSON,
    setJSON
  };
}
