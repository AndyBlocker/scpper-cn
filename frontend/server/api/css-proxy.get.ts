/**
 * Proxy CSS files from Wikidot CDN (wdfiles.com / wikidot.com).
 *
 * Usage: GET /api/css-proxy?url=<encoded-url>
 *
 * Only allows URLs from trusted Wikidot domains to prevent open-proxy abuse.
 * Rewrites nested url()/@import references in CSS so dependent assets stay
 * reachable when the stylesheet is served from our domain.
 *
 * On upstream errors, returns an empty CSS response with a comment describing
 * the error, so the browser always receives valid text/css (avoiding strict
 * MIME-type rejection of HTML error pages).
 */

import {
  defineEventHandler,
  getQuery,
  setResponseHeaders,
  setResponseStatus,
  type H3Event,
} from 'h3'

const ALLOWED_HOSTS = [
  'scp-wiki-cn.wikidot.com',
  'scp-wiki-cn.wdfiles.com',
  'www.wikidot.com',
  'd3g0gp89917ko0.cloudfront.net',
  'files.wikidot.com',
]
const DEFAULT_CACHE_CONTROL = 'public, max-age=3600, s-maxage=7200'
const MAX_REDIRECTS = 5
const MAX_RESPONSE_SIZE = 2 * 1024 * 1024 // 2 MB

function isAllowedUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    const protocol = String(u.protocol || '').toLowerCase()
    if (protocol !== 'http:' && protocol !== 'https:') return false
    if (u.username || u.password) return false
    return ALLOWED_HOSTS.some(
      (h) => u.hostname === h || u.hostname.endsWith(`.${h}`),
    )
  } catch {
    return false
  }
}

const CSS_PROXY_PATH = '/api/css-proxy'

function isAlreadyProxyRef(raw: string): boolean {
  const value = String(raw || '').trim()
  if (!value) return false
  if (/^\/api\/css-proxy(?:[/?#]|$)/i.test(value)) return true
  try {
    const parsed = new URL(value, 'https://scpper.mer.run')
    return /\/api\/css-proxy$/i.test(parsed.pathname)
  } catch {
    return false
  }
}

function toProxyHref(raw: string): string {
  return `${CSS_PROXY_PATH}?url=${encodeURIComponent(raw)}`
}

function rewriteCssRef(rawUrl: string, base: URL): string {
  const value = String(rawUrl || '').trim()
  if (!value) return value
  if (isAlreadyProxyRef(value)) return value
  if (/^(?:data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return value
  if (/^var\(/i.test(value)) return value

  try {
    const abs = new URL(value, base).href
    return isAllowedUrl(abs) ? toProxyHref(abs) : abs
  } catch {
    return value
  }
}

/** Rewrite url() and @import references so nested CSS assets stay reachable. */
function rewriteCssUrls(css: string, baseUrl: string): string {
  const base = new URL(baseUrl)
  return css
    .replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_all, quote, rawUrl) => {
      const rewritten = rewriteCssRef(rawUrl, base)
      return `url(${quote}${rewritten}${quote})`
    })
    .replace(
      /@import\s+url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
      (_all, quote, rawUrl) => `@import url(${quote}${rewriteCssRef(rawUrl, base)}${quote})`,
    )
    .replace(
      /@import\s+(["'])([^"']+)\1/gi,
      (_all, quote, rawUrl) => `@import ${quote}${rewriteCssRef(rawUrl, base)}${quote}`,
    )
}

/** Return an empty CSS response with a comment describing the error. */
function cssErrorResponse(event: H3Event, message: string, statusCode = 200) {
  setProxyHeaders(event, 'text/css; charset=utf-8', 'no-cache')
  setResponseStatus(event, statusCode)
  return `/* css-proxy error: ${message.replace(/\*\//g, '* /')} */\n`
}

function textErrorResponse(event: H3Event, message: string, statusCode = 502) {
  setProxyHeaders(event, 'text/plain; charset=utf-8', 'no-cache')
  setResponseStatus(event, statusCode)
  return message
}

function setProxyHeaders(event: H3Event, contentType: string, cacheControl: string) {
  setResponseHeaders(event, {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
  })
}

function requestWantsCss(event: H3Event, url: string): boolean {
  const dest = String(event.node.req.headers['sec-fetch-dest'] || '').toLowerCase()
  if (dest === 'style') return true
  const accept = String(event.node.req.headers.accept || '').toLowerCase()
  if (accept.includes('text/css')) return true
  return /\/local--code\//i.test(url)
}

async function fetchAllowedUpstream(inputUrl: string): Promise<Response> {
  let currentUrl = inputUrl

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    if (!isAllowedUrl(currentUrl)) {
      throw new Error(`Redirected to disallowed URL: ${currentUrl}`)
    }

    const resp = await fetch(currentUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; scpper-css-proxy/1.0)',
        Accept: '*/*',
      },
      redirect: 'manual',
    })

    if (![301, 302, 303, 307, 308].includes(resp.status)) {
      return resp
    }

    const location = resp.headers.get('location')
    if (!location) {
      throw new Error(`Redirect response missing location header for ${currentUrl}`)
    }

    currentUrl = new URL(location, currentUrl).href
  }

  throw new Error(`Too many redirects while fetching ${inputUrl}`)
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        throw new Error('Response too large')
      }
      chunks.push(decoder.decode(value, { stream: true }))
    }
    chunks.push(decoder.decode())
  } finally {
    reader.releaseLock()
  }

  return chunks.join('')
}

async function readLimitedBuffer(response: Response, maxBytes: number): Promise<Buffer> {
  const reader = response.body?.getReader()
  if (!reader) return Buffer.alloc(0)
  const chunks: Uint8Array[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      totalBytes += value.byteLength
      if (totalBytes > maxBytes) {
        throw new Error('Response too large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }

  return Buffer.concat(chunks)
}

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const url = String(query.url || '')
  const wantsCss = requestWantsCss(event, url)

  if (!url || !isAllowedUrl(url)) {
    return wantsCss
      ? cssErrorResponse(event, `Invalid or disallowed URL: ${url}`, 400)
      : textErrorResponse(event, 'Invalid or disallowed URL', 400)
  }

  try {
    const resp = await fetchAllowedUpstream(url)

    const declaredLength = Number(resp.headers.get('content-length'))
    if (declaredLength && declaredLength > MAX_RESPONSE_SIZE) {
      return wantsCss
        ? cssErrorResponse(event, 'Upstream response too large')
        : textErrorResponse(event, 'upstream response too large')
    }

    if (!resp.ok) {
      return wantsCss
        ? cssErrorResponse(event, `Upstream returned ${resp.status} for ${url}`)
        : textErrorResponse(event, 'proxy upstream error', resp.status)
    }

    const contentType = String(resp.headers.get('content-type') || '').toLowerCase()
    if (contentType.includes('text/html')) {
      return wantsCss
        ? cssErrorResponse(event, `Upstream returned text/html instead of CSS for ${url}`)
        : textErrorResponse(event, 'proxy upstream returned html')
    }

    const finalUrl = resp.url || url
    if (!isAllowedUrl(finalUrl)) {
      return wantsCss
        ? cssErrorResponse(event, `Disallowed final URL: ${finalUrl}`, 502)
        : textErrorResponse(event, 'proxy fetch failed')
    }

    if (contentType.includes('text/css') || contentType.includes('/css')) {
      let css = await readLimitedText(resp, MAX_RESPONSE_SIZE)
      css = rewriteCssUrls(css, finalUrl)
      setProxyHeaders(event, 'text/css; charset=utf-8', DEFAULT_CACHE_CONTROL)
      return css
    }

    const body = await readLimitedBuffer(resp, MAX_RESPONSE_SIZE)
    setProxyHeaders(event, contentType || 'application/octet-stream', DEFAULT_CACHE_CONTROL)
    return body
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    const isOversize = message === 'Response too large'
    return wantsCss
      ? cssErrorResponse(event, isOversize ? 'Response too large' : `Proxy fetch failed: ${message}`)
      : textErrorResponse(event, isOversize ? 'upstream response too large' : 'proxy fetch failed')
  }
})
