import { Router } from 'express';
import type { Request, Response as ExpressResponse } from 'express';

const ALLOWED_EXACT_HOSTS = [
  'd3g0gp89917ko0.cloudfront.net',
  'files.wikidot.com',
];
const ALLOWED_HOST_SUFFIXES = [
  'wikidot.com',
  'wdfiles.com',
  'scpwikicn.com',
];
const DEFAULT_CACHE_CONTROL =
  process.env.CSS_PROXY_CACHE_CONTROL || 'public, max-age=3600, s-maxage=7200';
const MAX_REDIRECTS = 5;
const MAX_RESPONSE_SIZE = 2 * 1024 * 1024; // 2 MB
const RATE_WINDOW_MS = 60_000;
const RATE_MAX_PER_IP = 60;

// Simple in-memory per-IP rate limiter
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
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
}, RATE_WINDOW_MS).unref();

function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    const protocol = String(u.protocol || '').toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    const host = String(u.hostname || '').toLowerCase();
    if (!host) return false;
    if (ALLOWED_EXACT_HOSTS.includes(host)) return true;
    return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch {
    return false;
  }
}

function isAlreadyProxyRef(raw: string): boolean {
  const value = String(raw || '').trim();
  if (!value) return false;
  if (/^\/(?:api\/)?css-proxy(?:[/?#]|$)/i.test(value)) return true;
  try {
    const parsed = new URL(value, 'https://scpper.mer.run');
    return /\/(?:api\/)?css-proxy$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function proxyPathForRequest(_req: Request): string {
  // Always generate externally reachable path via site gateway.
  // Internal upstream path may be rewritten to '/css-proxy' by reverse proxy.
  return '/api/css-proxy';
}

function toProxyHref(proxyPath: string, raw: string): string {
  return `${proxyPath}?url=${encodeURIComponent(raw)}`;
}

function rewriteCssRef(rawUrl: string, base: URL, proxyPath: string): string {
  const value = String(rawUrl || '').trim();
  if (!value) return value;
  if (isAlreadyProxyRef(value)) return value;
  if (/^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return value;
  if (/^var\(/i.test(value)) return value;

  try {
    const abs = new URL(value, base).href;
    return isAllowedUrl(abs) ? toProxyHref(proxyPath, abs) : abs;
  } catch {
    return value;
  }
}

function rewriteCssUrls(css: string, baseUrl: string, proxyPath: string): string {
  const base = new URL(baseUrl);
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_all, quote, rawUrl) => {
      const rewritten = rewriteCssRef(rawUrl, base, proxyPath);
      return `url(${quote}${rewritten}${quote})`;
    })
    .replace(
      /@import\s+url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
      (_all, quote, rawUrl) =>
        `@import url(${quote}${rewriteCssRef(rawUrl, base, proxyPath)}${quote})`,
    )
    .replace(
      /@import\s+(["'])([^"']+)\1/gi,
      (_all, quote, rawUrl) => `@import ${quote}${rewriteCssRef(rawUrl, base, proxyPath)}${quote}`,
    );
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

async function fetchAllowedUpstream(inputUrl: string): Promise<globalThis.Response> {
  let currentUrl = inputUrl;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    if (!isAllowedUrl(currentUrl)) {
      throw new Error(`Redirected to disallowed URL`);
    }

    const upstream = await fetch(currentUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; scpper-css-proxy/1.0)',
        Accept: '*/*',
      },
      redirect: 'manual',
    });

    if (![301, 302, 303, 307, 308].includes(upstream.status)) {
      return upstream;
    }

    const location = upstream.headers.get('location');
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

export function cssProxyRouter() {
  const router = Router();

  router.get(['/css-proxy', '/api/css-proxy'], async (req, res) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(clientIp)) {
      setHeaders(res, 'text/plain; charset=utf-8', 'no-cache');
      return res.status(429).send('Too many requests');
    }

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

    try {
      const upstream = await fetchAllowedUpstream(url);

      // Check Content-Length early if available
      const declaredLength = Number(upstream.headers.get('content-length'));
      if (declaredLength && declaredLength > MAX_RESPONSE_SIZE) {
        if (wantsCss) {
          const body = cssErrorComment('Upstream response too large');
          setHeaders(res, 'text/css; charset=utf-8', 'no-cache');
          return res.status(200).send(body);
        }
        setHeaders(res, 'text/plain; charset=utf-8', 'no-cache');
        return res.status(502).send('upstream response too large');
      }

      if (!upstream.ok) {
        if (wantsCss) {
          const body = cssErrorComment(`Upstream returned ${upstream.status}`);
          setHeaders(res, 'text/css; charset=utf-8', 'no-cache');
          return res.status(200).send(body);
        }
        setHeaders(res, 'text/plain; charset=utf-8', 'no-cache');
        return res.status(upstream.status).send(`proxy upstream error`);
      }

      const contentType = String(upstream.headers.get('content-type') || '').toLowerCase();
      const finalUrl = upstream.url || url;
      if (!isAllowedUrl(finalUrl)) {
        throw new Error('Disallowed final URL');
      }

      if (contentType.includes('text/html')) {
        if (wantsCss) {
          const body = cssErrorComment('Upstream returned text/html instead of CSS');
          setHeaders(res, 'text/css; charset=utf-8', 'no-cache');
          return res.status(200).send(body);
        }
        setHeaders(res, 'text/plain; charset=utf-8', 'no-cache');
        return res.status(502).send('proxy upstream returned html');
      }

      if (contentType.includes('text/css') || contentType.includes('/css')) {
        let css = await readLimitedText(upstream, MAX_RESPONSE_SIZE);
        css = rewriteCssUrls(css, finalUrl, proxyPath);
        setHeaders(res, 'text/css; charset=utf-8', DEFAULT_CACHE_CONTROL);
        return res.status(200).send(css);
      }

      const buf = await readLimitedBuffer(upstream, MAX_RESPONSE_SIZE);
      setHeaders(res, contentType || 'application/octet-stream', DEFAULT_CACHE_CONTROL);
      return res.status(200).send(buf);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      const isOversize = message === 'Response too large';
      if (wantsCss) {
        const body = cssErrorComment(isOversize ? 'Response too large' : 'Proxy fetch failed');
        setHeaders(res, 'text/css; charset=utf-8', 'no-cache');
        return res.status(200).send(body);
      }
      setHeaders(res, 'text/plain; charset=utf-8', 'no-cache');
      return res.status(502).send(isOversize ? 'upstream response too large' : 'proxy fetch failed');
    }
  });

  return router;
}
