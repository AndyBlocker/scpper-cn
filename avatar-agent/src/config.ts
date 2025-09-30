import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

type EnvLoaderProcess = typeof process & {
  loadEnvFile?: (path?: string) => Record<string, string> | undefined;
};

const maybeLoadEnvFile = (target?: string): boolean => {
  const loader = (process as EnvLoaderProcess).loadEnvFile;
  if (typeof loader !== 'function') return false;
  try {
    loader(target);
    return true;
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err?.code === 'ENOENT') return false;
    throw error;
  }
};

const moduleDir = dirname(fileURLToPath(import.meta.url));
maybeLoadEnvFile(resolve(moduleDir, '../../.env'))
  || maybeLoadEnvFile(resolve(moduleDir, '../.env'))
  || maybeLoadEnvFile(resolve(process.cwd(), '.env'))
  || maybeLoadEnvFile();

function num(name: string, def: number) {
  const v = process.env[name];
  return v ? Number(v) : def;
}
function str(name: string, def: string) {
  return process.env[name] ?? def;
}
function bool(name: string, def: boolean) {
  const v = process.env[name];
  return v ? ["1","true","yes"].includes(v.toLowerCase()) : def;
}

export const cfg = {
  host: str("HOST", "0.0.0.0"),
  port: num("PORT", 3200),
  logLevel: str("LOG_LEVEL", "info"),

  avatarRoot: resolve(str("AVATAR_ROOT", "/var/lib/avatar-agent/avatars")),
  defaultAvatar: resolve(str("DEFAULT_AVATAR", "./default-avatar.png")),
  ttlDays: num("AVATAR_TTL_DAYS", 60),
  maxBytes: num("AVATAR_MAX_BYTES", 2 * 1024 * 1024),
  userIdRegex: new RegExp(str("ALLOWED_USERID_REGEX", "^[1-9][0-9]{0,12}$")),

  inlineBudgetMs: num("REFRESH_INLINE_TIMEOUT_MS", 1200),
  resolveTtlDays: num("RESOLVE_TTL_DAYS", 30),
  backoffBaseMin: num("BACKOFF_BASE_MINUTES", 5),
  backoffMaxHours: num("BACKOFF_MAX_HOURS", 24),

  upstreamWikidot: str("UPSTREAM_WIKIDOT", "https://www.wikidot.com/avatar.php"),
  upstreamCfHost: str("UPSTREAM_CLOUDFRONT_HOST", "d2qhngyckgiutd.cloudfront.net"),
  upstreamAllowedHosts: str("UPSTREAM_ALLOWED_HOSTS", "d2qhngyckgiutd.cloudfront.net,graph.facebook.com")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean),

  timeoutHeadMs: num("TIMEOUT_HEAD_MS", 1500),
  timeoutGetMs: num("TIMEOUT_GET_MS", 5000),

  clientRateRpm: num("CLIENT_RATE_LIMIT_RPM", 60),
  cfRateRps: num("CF_RATE_LIMIT_RPS", 5),
  wikidotRateRps: num("WIKIDOT_RATE_LIMIT_RPS", 0.5),

  pruneKeepDays: num("PRUNE_KEEP_DAYS", 120),
  pruneDiskWatermark: num("PRUNE_DISK_WATERMARK", 80),

  imageCache: {
    enabled: bool("PAGE_IMAGE_WORKER_ENABLED", false),
    databaseUrl: str("PAGE_IMAGE_DATABASE_URL", process.env.DATABASE_URL || ""),
    assetRoot: resolve(str("PAGE_IMAGE_ROOT", "./.data/page-images")),
    concurrency: num("PAGE_IMAGE_WORKER_CONCURRENCY", 1),
    fetchDelayMs: num("PAGE_IMAGE_FETCH_DELAY_MS", 2500),
    idleDelayMs: num("PAGE_IMAGE_IDLE_DELAY_MS", 5000),
    requestTimeoutMs: num("PAGE_IMAGE_REQUEST_TIMEOUT_MS", 10000),
    retryBaseMs: num("PAGE_IMAGE_RETRY_BASE_MS", 60000),
    retryMaxMs: num("PAGE_IMAGE_RETRY_MAX_MS", 3600000),
    maxBytes: num("PAGE_IMAGE_MAX_BYTES", 5 * 1024 * 1024),
    userAgent: str("PAGE_IMAGE_USER_AGENT", "scpper-image-cache/1.0"),
    storageMode: str("PAGE_IMAGE_STORAGE_MODE", "hash"),
  }
};
