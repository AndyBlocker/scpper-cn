import { resolve } from "node:path";

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
};


