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
  /** 删除单个 key（幂等，key 不存在也不报错） */
  del(key: string): Promise<void>;
  /**
   * 按前缀批量失效。用于「一次写操作影响一族缓存键」的场景，
   * 例如提醒列表的 key 形如 alerts:{wikidotId}:{metric}:{limit}:{offset}，
   * 标记已读后必须把该用户名下所有分页/指标组合一并失效，否则未读数会回弹（最长一个 TTL）。
   * Redis 侧用 SCAN 游标遍历而非 KEYS —— KEYS 是 O(N) 且会阻塞整个实例。
   */
  delByPrefix(keyPrefix: string): Promise<void>;
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

  // 失效世代号。仅仅从 inflight 里删掉条目挡不住已经在跑的 loader ——
  // 它稍后仍会调用 memorySet/setJSON 把**失效前**的旧值写回缓存，
  // 于是「标记已读 → 未读数回弹」在一次并发读写下依然会发生。
  // loader 启动时抓一份世代号，写回前比对：不一致就丢弃结果。
  // 同理，loader 的 finally 也只能删自己那次登记的 promise，
  // 否则会误删后来者新建的 inflight 条目。
  let generation = 0;
  const keyGeneration = new Map<string, number>();
  const bumpGeneration = (fullKey: string) => {
    generation += 1;
    keyGeneration.set(fullKey, generation);
  };
  const generationOf = (fullKey: string) => keyGeneration.get(fullKey) ?? 0;

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

        const startedGeneration = generationOf(fullKey);
        // 用容器持有自身引用：直接在 promise 的 finally 里引用 `promise` 会撞 TDZ
        const self: { p?: Promise<T> } = {};
        const promise = (async () => {
          try {
            const result = await loader();
            if (result === undefined) return result;
            if (result === null && opts?.cacheNull !== true) return result;
            // 存储并返回归一化形态，使内存后端的命中/未命中与 Redis 后端口径一致（#124）。
            const normalized = jsonClone(result);
            // 期间被失效过就不写回，否则会把陈旧的未读数再撑 TTL 秒
            if (generationOf(fullKey) === startedGeneration) {
              memorySet(store, maxSize, fullKey, normalized, ttl);
            }
            return normalized;
          } finally {
            // 只删自己登记的那个 promise，不误删后来者的
            if (inflight.get(fullKey) === self.p) inflight.delete(fullKey);
          }
        })();
        self.p = promise as Promise<T>;
        inflight.set(fullKey, promise);
        return promise as Promise<T>;
      },
      async getJSON<T>(key: string): Promise<T | null> {
        return memoryGet<T>(store, `${prefix}${key}`);
      },
      async setJSON(key: string, value: unknown, ttlSeconds: number): Promise<void> {
        if (value !== undefined) {
          // 存归一化形态，使内存后端的 getJSON 与 Redis(JSON 往返)口径一致（#124）。
          memorySet(store, maxSize, `${prefix}${key}`, jsonClone(value), ttlSeconds);
        }
      },
      async del(key: string): Promise<void> {
        const fullKey = `${prefix}${key}`;
        store.delete(fullKey);
        // 提升世代号：在途 loader 稍后写回时会发现世代已变而丢弃结果
        bumpGeneration(fullKey);
        inflight.delete(fullKey);
      },
      async delByPrefix(keyPrefix: string): Promise<void> {
        const fullPrefix = `${prefix}${keyPrefix}`;
        for (const k of Array.from(store.keys())) {
          if (k.startsWith(fullPrefix)) store.delete(k);
        }
        for (const k of Array.from(inflight.keys())) {
          if (k.startsWith(fullPrefix)) { bumpGeneration(k); inflight.delete(k); }
        }
        // 在途但尚未登记过世代的 key 也要覆盖到：直接给整个前缀记一个新世代
        bumpGeneration(fullPrefix);
        for (const k of Array.from(keyGeneration.keys())) {
          if (k.startsWith(fullPrefix)) bumpGeneration(k);
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

    const startedGeneration = generationOf(fullKey);
    // 同上：容器持有自身引用，避免 TDZ
    const self: { p?: Promise<T> } = {};
    const promise = (async () => {
      try {
        const result = await loader();
        if (result === undefined) return result;
        if (result === null && options?.cacheNull !== true) return result;
        // 期间被失效过就不写回（理由同内存分支）
        if (generationOf(fullKey) === startedGeneration) {
          await setJSON(key, result, ttlSeconds);
        }
        // 未命中也返回 JSON 归一化形态，与后续命中（getJSON→JSON.parse）口径一致（#124）。
        return jsonClone(result);
      } finally {
        if (inflight.get(fullKey) === self.p) inflight.delete(fullKey);
      }
    })();
    self.p = promise as Promise<T>;
    inflight.set(fullKey, promise);
    return promise as Promise<T>;
  }

  async function del(key: string): Promise<void> {
    const fullKey = namespaced(key);
    bumpGeneration(fullKey);
    inflight.delete(fullKey);
    try {
      await client.del(fullKey);
    } catch (error) {
      console.warn('[cache] del failed', key, error);
    }
  }

  async function delByPrefix(keyPrefix: string): Promise<void> {
    const fullPrefix = namespaced(keyPrefix);
    for (const k of Array.from(inflight.keys())) {
      if (k.startsWith(fullPrefix)) { bumpGeneration(k); inflight.delete(k); }
    }
    bumpGeneration(fullPrefix);
    for (const k of Array.from(keyGeneration.keys())) {
      if (k.startsWith(fullPrefix)) bumpGeneration(k);
    }
    try {
      // scanIterator 内部管理游标：不阻塞实例，对并发写入安全
      // （可能重复返回同一 key，但 DEL 是幂等的，无妨）。
      // MATCH 里的 glob 元字符必须转义，否则 key 前缀中的 [ ? * 会被当成通配符，
      // 造成误删其他用户的缓存。
      const pattern = `${fullPrefix.replace(/[\\*?[\]^]/g, (ch) => `\\${ch}`)}*`;
      let batch: string[] = [];
      for await (const key of client.scanIterator({ MATCH: pattern, COUNT: 200 })) {
        batch.push(key);
        if (batch.length >= 200) {
          await client.del(batch);
          batch = [];
        }
      }
      if (batch.length > 0) {
        await client.del(batch);
      }
    } catch (error) {
      console.warn('[cache] delByPrefix failed', keyPrefix, error);
    }
  }

  return {
    enabled: true,
    remember,
    getJSON,
    setJSON,
    del,
    delByPrefix
  };
}
