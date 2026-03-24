import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_BYTES = 64 * 1024; // 64 KiB
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days cap for user-supplied TTL
const MAX_SNIPPET_FILES = 1000;
const SNIPPET_ROUTE_BASES = ['/html-snippet', '/html-snippets'] as const;
const EXPRESS_PATHS = SNIPPET_ROUTE_BASES.flatMap((base) => [base, `/api${base}`]);
const HTML_SNIPPET_DIR =
  process.env.HTML_SNIPPET_DIR || path.resolve(process.cwd(), 'data/html-snippets');

function getMaxBytes() {
  const raw = process.env.HTML_SNIPPET_MAX_BYTES;
  const parsed = raw ? Number(raw) : DEFAULT_MAX_BYTES;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BYTES;
}

function getDefaultTtlMs() {
  const raw = process.env.HTML_SNIPPET_TTL_MS;
  const parsed = raw ? Number(raw) : DEFAULT_TTL_MS;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS;
}

function getMaxTtlMs() {
  const raw = process.env.HTML_SNIPPET_MAX_TTL_MS;
  if (raw === undefined) {
    return DEFAULT_MAX_TTL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_TTL_MS;
}

type StoredSnippet = {
  createdAt: number;
  html: string;
  ttlMs: number | null;
};

async function ensureDir() {
  await fs.mkdir(HTML_SNIPPET_DIR, { recursive: true });
}

function buildPath(id: string) {
  return path.join(HTML_SNIPPET_DIR, `${id}.json`);
}

function buildId(html: string) {
  return crypto.createHash('sha256').update(html).digest('hex').slice(0, 32);
}

function coerceForwardedPrefix(req: Request) {
  const raw =
    (req.headers['x-forwarded-prefix'] as string | undefined) ||
    (req.headers['x-forwarded-path'] as string | undefined);
  const first = raw?.split(',')[0]?.trim();
  if (!first) {
    return '';
  }
  const normalized = first.startsWith('/') ? first : `/${first}`;
  return normalized.replace(/\/+$/, '');
}

function detectPathPrefix(req: Request) {
  const forwardedPrefix = coerceForwardedPrefix(req);
  if (forwardedPrefix) {
    return forwardedPrefix;
  }

  const original = req.originalUrl || '';
  for (const basePath of SNIPPET_ROUTE_BASES) {
    const idx = original.indexOf(basePath);
    if (idx > 0) {
      return original.slice(0, idx).replace(/\/+$/, '');
    }
  }
  return '';
}

function cleanHost(value: string | undefined) {
  if (!value) return '';
  return value.split(',')[0]?.trim() || '';
}

function isLoopbackHost(host: string) {
  if (!host) return true;
  const normalized = host
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/:\d+$/, '')
    .trim()
    .toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

function hostAndProtoFromUrl(raw: string | undefined) {
  if (!raw) return { host: '', proto: '' };
  try {
    const parsed = new URL(raw);
    return {
      host: parsed.host || '',
      proto: parsed.protocol ? parsed.protocol.replace(/:$/, '') : ''
    };
  } catch {
    return { host: '', proto: '' };
  }
}

function sanitizeBaseUrl(base: string | undefined, req: Request) {
  const prefix = detectPathPrefix(req);
  if (base && base.trim().length > 0) {
    const cleaned = base.trim().replace(/\/+$/, '');
    return prefix ? `${cleaned}${prefix}`.replace(/\/+$/, '') : cleaned;
  }
  const forwardedHost = cleanHost(req.headers['x-forwarded-host'] as string | undefined);
  const forwardedProto = cleanHost(req.headers['x-forwarded-proto'] as string | undefined);
  const originParts = hostAndProtoFromUrl(String(req.get('origin') || ''));
  const refererParts = hostAndProtoFromUrl(String(req.get('referer') || ''));

  let host = forwardedHost || cleanHost(req.get('host') || '');
  if (!host || isLoopbackHost(host)) {
    host = originParts.host || refererParts.host || host;
  }

  let proto = forwardedProto || req.protocol;
  if (!proto || proto === 'http') {
    proto = originParts.proto || refererParts.proto || proto;
  }

  const raw = `${proto}://${host}${prefix}`;
  return raw.replace(/\/+$/, '');
}

function buildSnippetUrl(baseUrl: string, routeBase: string, id: string) {
  const normalizedBase = baseUrl.replace(/\/+$/, '');
  const normalizedRoute = `/${routeBase.replace(/^\/+/, '')}`;
  return `${normalizedBase}${normalizedRoute}/${id}`;
}

async function loadSnippetIfFresh(
  id: string,
  defaultTtlMs: number,
  maxTtlMs: number
): Promise<StoredSnippet | null> {
  try {
    const raw = await fs.readFile(buildPath(id), 'utf8');
    const parsed: StoredSnippet & { ttlMs?: number | null } = JSON.parse(raw);
    const effectiveTtl = parsed.ttlMs === undefined ? defaultTtlMs : parsed.ttlMs;

    if (effectiveTtl !== null) {
      const cappedTtl = Math.min(effectiveTtl, maxTtlMs);
      const age = Date.now() - parsed.createdAt;
      if (age > cappedTtl) {
        await fs.rm(buildPath(id), { force: true });
        return null;
      }
    }
    return { ...parsed, ttlMs: effectiveTtl };
  } catch {
    return null;
  }
}

async function evictOldestSnippets(): Promise<void> {
  try {
    const entries = await fs.readdir(HTML_SNIPPET_DIR);
    const jsonFiles = entries.filter(e => e.endsWith('.json'));
    if (jsonFiles.length < MAX_SNIPPET_FILES) return;

    // Gather mtime for each file and sort oldest-first
    const withStats = await Promise.all(
      jsonFiles.map(async (name) => {
        const filePath = path.join(HTML_SNIPPET_DIR, name);
        try {
          const stat = await fs.stat(filePath);
          return { name, filePath, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
    );
    const valid = withStats.filter((s): s is NonNullable<typeof s> => s !== null);
    valid.sort((a, b) => a.mtimeMs - b.mtimeMs);

    // Remove oldest files until we're under the limit
    const toRemove = valid.length - MAX_SNIPPET_FILES + 1; // +1 to make room for the new file
    for (let i = 0; i < toRemove; i++) {
      await fs.rm(valid[i].filePath, { force: true });
    }
  } catch { /* ignore eviction errors */ }
}

async function persistSnippet(id: string, snippet: StoredSnippet) {
  await ensureDir();
  await evictOldestSnippets();
  await fs.writeFile(buildPath(id), JSON.stringify(snippet), 'utf8');
}

function validateId(id: string) {
  return /^[a-f0-9]{32}$/i.test(id);
}

function parseTtlMsFromRequest(body: any): { ttlMs: number | null; persistent: boolean } {
  const persistFlag = body?.persist === true;
  const defaultTtl = getDefaultTtlMs();
  const maxTtl = getMaxTtlMs();

  if (persistFlag) {
    return { ttlMs: null, persistent: true };
  }

  const raw = body?.ttlSeconds ?? body?.ttl;
  const parsedSeconds = Number(raw);
  let ttlMs = defaultTtl;
  if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
    ttlMs = Math.min(parsedSeconds * 1000, maxTtl);
  }

  return { ttlMs, persistent: false };
}

export const htmlSnippetsRouter = Router();

function createPostHandler(routeBase: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Require internal API key for write operations
      const expectedKey = (process.env.BFF_INTERNAL_API_KEY || '').trim();
      if (expectedKey) {
        const providedKey = String(req.get('x-internal-key') || '').trim();
        if (providedKey !== expectedKey) {
          return res.status(403).json({ error: 'forbidden' });
        }
      }

      const rawHtml = typeof req.body?.html === 'string' ? req.body.html : req.body?.content;
      if (typeof rawHtml !== 'string' || rawHtml.trim().length === 0) {
        return res.status(400).json({ error: 'invalid_html' });
      }

      const html = rawHtml.trim();
      const maxBytes = getMaxBytes();
      const bytes = Buffer.byteLength(html, 'utf8');
      if (bytes > maxBytes) {
        return res.status(413).json({ error: 'html_too_large', maxBytes });
      }

      const { ttlMs, persistent } = parseTtlMsFromRequest(req.body);
      const id = buildId(html);
      const createdAt = Date.now();

      await persistSnippet(id, { html, createdAt, ttlMs });

      const baseUrl = sanitizeBaseUrl(process.env.HTML_SNIPPET_PUBLIC_BASE, req);
      const url = buildSnippetUrl(baseUrl, routeBase, id);
      const expiresAt = ttlMs === null ? null : new Date(createdAt + ttlMs).toISOString();

      const ttlSeconds = ttlMs === null ? null : Math.max(1, Math.ceil(ttlMs / 1000));

      return res.status(201).json({
        id,
        url,
        expiresAt,
        bytes,
        maxBytes,
        ttlSeconds,
        persistent
      });
    } catch (error) {
      return next(error);
    }
  };
}

async function handleGetSnippet(req: Request, res: Response, next: NextFunction) {
  try {
    const { id } = req.params;
    if (!validateId(id)) {
      return res.status(400).json({ error: 'invalid_id' });
    }

    const defaultTtl = getDefaultTtlMs();
    const maxTtl = getMaxTtlMs();
    const snippet = await loadSnippetIfFresh(id, defaultTtl, maxTtl);
    if (!snippet) {
      return res.status(404).json({ error: 'not_found' });
    }

    const ttlMs = snippet.ttlMs ?? defaultTtl;
    const cacheSeconds =
      ttlMs === null
        ? 31536000
        : Math.max(Math.floor((Math.min(ttlMs, maxTtl) - (Date.now() - snippet.createdAt)) / 1000), 0);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', `public, max-age=${cacheSeconds}`);
    // Explicitly allow embedding from same origin; avoid upstream defaults like DENY.
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src *; frame-ancestors 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return res.status(200).send(snippet.html);
  } catch (error) {
    return next(error);
  }
}

for (const routeBase of SNIPPET_ROUTE_BASES) {
  for (const expressPath of EXPRESS_PATHS.filter((path) => path.endsWith(routeBase))) {
    htmlSnippetsRouter.post(expressPath, createPostHandler(routeBase));
    htmlSnippetsRouter.get(`${expressPath}/:id`, handleGetSnippet);
  }
}
