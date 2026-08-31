import { Router } from 'express';
import type { Request, Response as ExpressResponse } from 'express';
import { createHash } from 'crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  isAllowedUrl,
  rewriteCssUrls,
} from '../utils/asset-proxy.js';
import { hasInternalKey } from '../utils/internal-key.js';

// ── Disk cache ──
//
// 缓存策略是 stale-while-revalidate：
// 上游（wikidot / wdfiles）对国内是一条不稳定的链路，经常整段时间连不上。
// 旧实现按 7 天硬过期并在读到时删除条目，一旦此时回源失败，资源就永久消失了。
// 现在过期只代表"不新鲜"：照样先把旧内容吐出去，再在后台悄悄回源刷新；
// 回源失败就继续用旧的。淘汰改由容量上限的 LRU 负责。
const DISK_CACHE_DIR = process.env.CSS_PROXY_CACHE_DIR ||
  path.resolve(process.cwd(), 'cache/css-proxy');
const DISK_CACHE_ENABLED = process.env.CSS_PROXY_DISK_CACHE !== '0';
/** 超过这个年龄就在后台刷新，但内容仍然可用 */
const DISK_CACHE_FRESH_MS = Number(process.env.CSS_PROXY_FRESH_MS || 7 * 24 * 60 * 60 * 1000);
/** 缓存目录容量上限，超了按最久未使用淘汰 */
const DISK_CACHE_MAX_BYTES = Number(process.env.CSS_PROXY_MAX_BYTES || 20 * 1024 * 1024 * 1024);
const DISK_CACHE_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

if (DISK_CACHE_ENABLED) {
  try { fs.mkdirSync(DISK_CACHE_DIR, { recursive: true }); } catch { /* ignore */ }
}

function cacheKeyFor(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

type CachedEntry = { contentType: string; body: Buffer; fresh: boolean };

/**
 * 读缓存。全程异步 —— 缓存命中是最热的路径（且刻意不受限流约束），
 * 单进程的 BFF 在这里做同步读会把事件循环卡住，一张图最大 8MB。
 */
async function readFromDisk(url: string): Promise<CachedEntry | null> {
  if (!DISK_CACHE_ENABLED) return null;
  const key = cacheKeyFor(url);
  const metaPath = path.join(DISK_CACHE_DIR, key + '.meta');
  const dataPath = path.join(DISK_CACHE_DIR, key + '.data');
  try {
    const [stat, contentType, body] = await Promise.all([
      fsp.stat(metaPath),
      fsp.readFile(metaPath, 'utf-8'),
      fsp.readFile(dataPath),
    ]);
    return {
      contentType: contentType.trim(),
      body,
      fresh: Date.now() - stat.mtimeMs <= DISK_CACHE_FRESH_MS,
    };
  } catch {
    return null;
  }
}

/**
 * 写缓存。
 *
 * 必须先写临时文件再 rename：后台回源会覆盖正在被其他请求读取的条目，
 * 直接原地截断重写的话，读到一半的请求会拿到残缺内容，还会带着
 * `public, max-age=3600` 进浏览器缓存待上一小时。rename 在同一文件系统上是原子的。
 * 顺序也重要 —— 先落 .data 再落 .meta，readFromDisk 以 .meta 为准。
 */
async function writeToDisk(url: string, contentType: string, body: Buffer | string): Promise<void> {
  if (!DISK_CACHE_ENABLED) return;
  noteBytesWritten(Buffer.byteLength(body as Buffer));
  const key = cacheKeyFor(url);
  const dataTmp = path.join(DISK_CACHE_DIR, `${key}.${process.pid}.tmp`);
  const metaTmp = path.join(DISK_CACHE_DIR, `${key}.${process.pid}.meta.tmp`);
  try {
    await fsp.writeFile(dataTmp, body);
    await fsp.rename(dataTmp, path.join(DISK_CACHE_DIR, key + '.data'));
    await fsp.writeFile(metaTmp, contentType, 'utf-8');
    await fsp.rename(metaTmp, path.join(DISK_CACHE_DIR, key + '.meta'));
  } catch {
    await fsp.rm(dataTmp, { force: true }).catch(() => {});
    await fsp.rm(metaTmp, { force: true }).catch(() => {});
  }
}

/** 记一次命中，让 LRU 能识别热条目。发出去就不管了，不阻塞响应 */
function touchOnDisk(url: string): void {
  if (!DISK_CACHE_ENABLED) return;
  const dataPath = path.join(DISK_CACHE_DIR, cacheKeyFor(url) + '.data');
  void (async () => {
    try {
      const stat = await fsp.stat(dataPath);
      await fsp.utimes(dataPath, new Date(), stat.mtime);
    } catch { /* 条目可能刚被淘汰 */ }
  })();
}

/**
 * 写入量到阈值就触发一次淘汰，光靠定时器不够：
 * 一轮批量预热完全可能在两次定时扫描之间就把容量上限写穿。
 * 扫描是合并的 —— 正在跑就不再排队。
 */
const SWEEP_WRITE_THRESHOLD = Math.max(64 * 1024 * 1024, DISK_CACHE_MAX_BYTES / 20);
let bytesSinceSweep = 0;
let sweepInFlight = false;

function noteBytesWritten(bytes: number): void {
  bytesSinceSweep += bytes;
  if (bytesSinceSweep < SWEEP_WRITE_THRESHOLD || sweepInFlight) return;
  bytesSinceSweep = 0;
  sweepInFlight = true;
  void sweepDiskCache().finally(() => { sweepInFlight = false; });
}

// 按容量上限做 LRU 淘汰（不再按年龄删除 —— 见上面的缓存策略说明）
async function sweepDiskCache(): Promise<void> {
  try {
    const names = await fsp.readdir(DISK_CACHE_DIR);
    const dataKeys = new Set<string>();
    const items: Array<{ key: string; bytes: number; atimeMs: number }> = [];
    let total = 0;

    for (const name of names) {
      // 清理中断留下的临时文件
      if (name.endsWith('.tmp')) {
        await fsp.rm(path.join(DISK_CACHE_DIR, name), { force: true }).catch(() => {});
        continue;
      }
      if (!name.endsWith('.data')) continue;
      const key = name.replace(/\.data$/, '');
      dataKeys.add(key);
      try {
        const stat = await fsp.stat(path.join(DISK_CACHE_DIR, name));
        items.push({ key, bytes: stat.size, atimeMs: stat.atimeMs });
        total += stat.size;
      } catch { /* ignore per-file errors */ }
    }

    // 回收没有对应 .data 的孤儿 .meta（写入中途失败会留下）
    for (const name of names) {
      if (!name.endsWith('.meta')) continue;
      if (dataKeys.has(name.replace(/\.meta$/, ''))) continue;
      await fsp.rm(path.join(DISK_CACHE_DIR, name), { force: true }).catch(() => {});
    }

    if (total <= DISK_CACHE_MAX_BYTES) return;
    // 最久未访问的先淘汰，直到回到上限的 90%
    const target = DISK_CACHE_MAX_BYTES * 0.9;
    items.sort((a, b) => a.atimeMs - b.atimeMs);
    for (const item of items) {
      if (total <= target) break;
      await fsp.rm(path.join(DISK_CACHE_DIR, item.key + '.data'), { force: true });
      await fsp.rm(path.join(DISK_CACHE_DIR, item.key + '.meta'), { force: true });
      total -= item.bytes;
    }
  } catch { /* ignore sweep errors */ }
}

if (DISK_CACHE_ENABLED) {
  // 启动后先扫一次：setInterval 要等满一个周期才首次触发，
  // 而一轮资源预热可能在这一个小时里就把容量写超。
  setTimeout(() => { void sweepDiskCache(); }, 30_000).unref();
  setInterval(() => { void sweepDiskCache(); }, DISK_CACHE_CLEANUP_INTERVAL_MS).unref();
}

const DEFAULT_CACHE_CONTROL =
  process.env.CSS_PROXY_CACHE_CONTROL || 'public, max-age=3600, s-maxage=7200';
const MAX_REDIRECTS = 5;
/** 单个资源体积上限；SCP 正文里的大幅插图经常超过 2MB */
const MAX_RESPONSE_SIZE = Number(process.env.CSS_PROXY_MAX_RESPONSE_BYTES || 8 * 1024 * 1024);
/**
 * 回源超时分两段。
 *
 * 不能只用一个 AbortSignal.timeout()：它同时管住响应体的下载，10 秒一到连正在
 * 传输的数据也会被掐断 —— 对慢链路上的大图（正是把上限提到 8MB 想救的那些）
 * 等于必然失败。所以握手/响应头一个短超时，拿到响应头后换成一个宽松的整体超时。
 */
const UPSTREAM_TIMEOUT_MS = Number(process.env.CSS_PROXY_UPSTREAM_TIMEOUT_MS || 10_000);
const UPSTREAM_BODY_TIMEOUT_MS = Number(process.env.CSS_PROXY_BODY_TIMEOUT_MS || 60_000);
const RATE_WINDOW_MS = 60_000;
// 限流只作用于真正需要回源的请求（缓存命中不计数）。
// 一个预览页要拉 13~15 个资源，旧的 60/min 意味着看四个页面就全被 429 掉。
const RATE_MAX_PER_IP = Number(process.env.CSS_PROXY_RATE_MAX || 300);
const RATE_BUCKETS_MAX_SIZE = 10_000;

// Simple in-memory per-IP rate limiter
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    // Refuse new entries when map is at capacity (OOM protection)
    if (!bucket && rateBuckets.size >= RATE_BUCKETS_MAX_SIZE) {
      return true;
    }
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_MAX_PER_IP;
}

// Periodic cleanup to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(ip);
  }
  // Hard cap: if map is still oversized after expiry sweep, evict oldest half
  if (rateBuckets.size > RATE_BUCKETS_MAX_SIZE) {
    const entries = [...rateBuckets.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
    const toRemove = Math.ceil(entries.length / 2);
    for (let i = 0; i < toRemove; i++) {
      rateBuckets.delete(entries[i][0]);
    }
  }
}, RATE_WINDOW_MS).unref();

function proxyPathForRequest(_req: Request): string {
  // Always generate externally reachable path via site gateway.
  // Internal upstream path may be rewritten to '/css-proxy' by reverse proxy.
  return '/api/css-proxy';
}

function cssErrorComment(message: string): string {
  return `/* css-proxy error: ${message.replace(/\*\//g, '* /')} */\n`;
}

function setHeaders(res: ExpressResponse, contentType: string, cacheControl: string) {
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function requestWantsCss(req: Request, url: string): boolean {
  const dest = String(req.get('sec-fetch-dest') || '').toLowerCase();
  if (dest === 'style') return true;
  const accept = String(req.get('accept') || '').toLowerCase();
  if (accept.includes('text/css')) return true;
  return /\/local--code\//i.test(url);
}

// 响应体超时定时器要跟着响应走，读完或丢弃时才清掉
const bodyTimers = new WeakMap<globalThis.Response, ReturnType<typeof setTimeout>>();

function clearBodyTimer(response: globalThis.Response): void {
  const timer = bodyTimers.get(response);
  if (timer) {
    clearTimeout(timer);
    bodyTimers.delete(response);
  }
}

/** 提前返回时丢弃响应体，否则 undici 会一直占着这条连接直到 GC */
async function discard(response: globalThis.Response): Promise<void> {
  clearBodyTimer(response);
  try { await response.body?.cancel(); } catch { /* 已消费或已关闭 */ }
}

async function fetchAllowedUpstream(inputUrl: string): Promise<globalThis.Response> {
  let currentUrl = inputUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    if (!isAllowedUrl(currentUrl)) {
      throw new Error(`Redirected to disallowed URL`);
    }

    const controller = new AbortController();
    const headersTimer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; scpper-css-proxy/1.0)',
          Accept: '*/*',
        },
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(headersTimer);
    }
    // 响应头已到，改成给整个响应体一个宽松的上限
    const bodyTimer = setTimeout(() => controller.abort(), UPSTREAM_BODY_TIMEOUT_MS);
    bodyTimers.set(upstream, bodyTimer);

    if (![301, 302, 303, 307, 308].includes(upstream.status)) {
      return upstream;
    }

    const location = upstream.headers.get('location');
    await discard(upstream);
    if (!location) {
      throw new Error(`Redirect response missing location header`);
    }

    currentUrl = new URL(location, currentUrl).href;
  }

  throw new Error(`Too many redirects`);
}

async function readLimitedText(response: globalThis.Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error('Response too large');
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } finally {
    reader.releaseLock();
  }

  return chunks.join('');
}

async function readLimitedBuffer(response: globalThis.Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        throw new Error('Response too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

type FetchOk = { ok: true; contentType: string; body: Buffer | string };
type FetchFail = { ok: false; reason: string; status: number };
type FetchResult = FetchOk | FetchFail;

/**
 * 回源抓取并写入缓存。主请求路径与后台刷新共用这一份实现。
 */
async function fetchAndStore(url: string, proxyPath: string): Promise<FetchResult> {
  try {
    const upstream = await fetchAllowedUpstream(url);

    const declaredLength = Number(upstream.headers.get('content-length'));
    if (declaredLength && declaredLength > MAX_RESPONSE_SIZE) {
      await discard(upstream);
      return { ok: false, reason: 'Upstream response too large', status: 502 };
    }

    if (!upstream.ok) {
      const status = upstream.status;
      await discard(upstream);
      return { ok: false, reason: `Upstream returned ${status}`, status };
    }

    const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
    const finalUrl = upstream.url || url;
    if (!isAllowedUrl(finalUrl)) {
      await discard(upstream);
      return { ok: false, reason: 'Disallowed final URL', status: 502 };
    }

    if (contentType.includes('text/html')) {
      await discard(upstream);
      return { ok: false, reason: 'Upstream returned text/html instead of CSS', status: 502 };
    }

    if (contentType.includes('text/css') || contentType.includes('/css')) {
      let css = await readLimitedText(upstream, MAX_RESPONSE_SIZE);
      clearBodyTimer(upstream);
      css = rewriteCssUrls(css, finalUrl, proxyPath);
      await writeToDisk(url, 'text/css; charset=utf-8', css);
      return { ok: true, contentType: 'text/css; charset=utf-8', body: css };
    }

    const buf = await readLimitedBuffer(upstream, MAX_RESPONSE_SIZE);
    clearBodyTimer(upstream);
    const finalContentType = contentType || 'application/octet-stream';
    await writeToDisk(url, finalContentType, buf);
    return { ok: true, contentType: finalContentType, body: buf };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const oversize = message === 'Response too large';
    return {
      ok: false,
      reason: oversize ? 'Response too large' : 'Proxy fetch failed',
      status: 502,
    };
  }
}

// 后台刷新是绕过限流的（请求本身命中了缓存，不占额度），所以必须自己设闸门：
// 去重保证同一个 URL 只跑一份，并发上限防止爬虫扫过大量陈旧 URL 时
// 一次性打出成百上千个 10 秒超时的上游连接。超出上限就跳过，
// 内容仍是可用的旧值，下次请求再刷。
const revalidating = new Set<string>();
const MAX_CONCURRENT_REVALIDATIONS = Number(process.env.CSS_PROXY_REVALIDATE_CONCURRENCY || 4);

function revalidateInBackground(url: string, proxyPath: string): void {
  if (revalidating.has(url)) return;
  if (revalidating.size >= MAX_CONCURRENT_REVALIDATIONS) return;
  revalidating.add(url);
  void fetchAndStore(url, proxyPath).finally(() => revalidating.delete(url));
}

export function cssProxyRouter() {
  const router = Router();

  router.get(['/css-proxy', '/api/css-proxy'], async (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    // 资源预热脚本带内部密钥，不占限流额度；不能用回环地址判断（见 start.ts 的说明）
    const trusted = hasInternalKey(req);

    const queryValue = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;
    const url = String(queryValue || '');
    const proxyPath = proxyPathForRequest(req);
    const wantsCss = requestWantsCss(req, url);

    if (!url || !isAllowedUrl(url)) {
      if (wantsCss) {
        const body = cssErrorComment('Invalid or disallowed URL');
        setHeaders(res, 'text/css; charset=utf-8', 'no-cache');
        return res.status(400).send(body);
      }
      setHeaders(res, 'text/plain; charset=utf-8', 'no-cache');
      return res.status(400).send('invalid or disallowed url');
    }

    // 缓存优先：命中就直接吐，不占限流额度。
    // 限流的目的是保护上游和本机出口带宽，命中缓存的请求两者都不消耗。
    const cached = await readFromDisk(url);
    if (cached) {
      touchOnDisk(url);
      if (!cached.fresh) {
        // 不新鲜 —— 先把旧内容给出去，回源放到后台，避免用户等一个可能连不上的上游
        void revalidateInBackground(url, proxyPath);
      }
      setHeaders(res, cached.contentType, DEFAULT_CACHE_CONTROL);
      return res.status(200).send(cached.body);
    }

    // 到这里才是真的要回源，限流从这里开始算
    if (!trusted && isRateLimited(clientIp)) {
      if (wantsCss) {
        const body = cssErrorComment('Rate limited');
        setHeaders(res, 'text/css; charset=utf-8', 'no-cache');
        return res.status(200).send(body);
      }
      setHeaders(res, 'text/plain; charset=utf-8', 'no-cache');
      return res.status(429).send('Too many requests');
    }

    const result = await fetchAndStore(url, proxyPath);

    if (result.ok) {
      setHeaders(res, result.contentType, DEFAULT_CACHE_CONTROL);
      return res.status(200).send(result.body);
    }

    // 回源失败且本地没有可退回的旧内容：CSS 用注释形式软失败（避免整页样式炸掉），
    // 其余资源如实返回错误状态
    if (wantsCss) {
      setHeaders(res, 'text/css; charset=utf-8', 'no-cache');
      return res.status(200).send(cssErrorComment(result.reason));
    }
    setHeaders(res, 'text/plain; charset=utf-8', 'no-cache');
    return res.status(result.status).send('proxy fetch failed');
  });

  return router;
}
