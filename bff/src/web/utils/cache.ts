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

// Simple in-memory cache fallback when Redis is unavailable
const memoryCache = new Map<string, { value: unknown; expiresAt: number }>();
const MAX_MEMORY_CACHE_SIZE = 1000;

function memoryGet<T>(key: string): T | null {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return entry.value as T;
}

function memorySet(key: string, value: unknown, ttlSeconds: number): void {
  // Evict old entries if cache is too large
  if (memoryCache.size >= MAX_MEMORY_CACHE_SIZE) {
    const now = Date.now();
    for (const [k, v] of memoryCache) {
      if (v.expiresAt < now) memoryCache.delete(k);
    }
    // If still too large, delete oldest entries
    if (memoryCache.size >= MAX_MEMORY_CACHE_SIZE) {
      const keysToDelete = Array.from(memoryCache.keys()).slice(0, 100);
      keysToDelete.forEach(k => memoryCache.delete(k));
    }
  }
  memoryCache.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export function createCache(redis: RedisClientType | null, prefix = DEFAULT_PREFIX): CacheHandle {
  if (!redis) {
    // Use in-memory cache as fallback when Redis is unavailable
    return {
      enabled: true, // Memory cache is still caching
      async remember<T>(key: string, ttl: number, loader: Loader<T>, options?: RememberOptions): Promise<T> {
        const fullKey = `${prefix}${key}`;
        const cached = memoryGet<T>(fullKey);
        if (cached !== null) return cached;

        const result = await loader();
        if (result === undefined) return result;
        if (result === null && options?.cacheNull !== true) return result;

        memorySet(fullKey, result, ttl);
        return result;
      },
      async getJSON<T>(key: string): Promise<T | null> {
        return memoryGet<T>(`${prefix}${key}`);
      },
      async setJSON(key: string, value: unknown, ttlSeconds: number): Promise<void> {
        if (value !== undefined) {
          memorySet(`${prefix}${key}`, value, ttlSeconds);
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

    const result = await loader();
    if (result === undefined) {
      return result;
    }
    if ((result === null) && options?.cacheNull !== true) {
      return result;
    }

    await setJSON(key, result, ttlSeconds);
    return result;
  }

  return {
    enabled: true,
    remember,
    getJSON,
    setJSON
  };
}
