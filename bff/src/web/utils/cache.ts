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

export function createCache(redis: RedisClientType | null, prefix = DEFAULT_PREFIX): CacheHandle {
  if (!redis) {
    return {
      enabled: false,
      async remember<T>(_key: string, _ttl: number, loader: Loader<T>): Promise<T> {
        return loader();
      },
      async getJSON<T>(_key: string): Promise<T | null> {
        return null;
      },
      async setJSON(): Promise<void> {
        // noop
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
