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
const MAX_REDIRECTS = 5

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

function toProxyHref(raw: string): string {
  return `${CSS_PROXY_PATH}?url=${encodeURIComponent(raw)}`
}

function rewriteCssRef(rawUrl: string, base: URL): string {
  const value = String(rawUrl || '').trim()
  if (!value) return value
  if (/^\/api\/css-proxy(?:[/?#]|$)/i.test(value)) return value
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
  setResponseHeaders(event, {
    'Content-Type': 'text/css; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  })
  setResponseStatus(event, statusCode)
  return `/* css-proxy error: ${message.replace(/\*\//g, '* /')} */\n`
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
        Accept: 'text/css,*/*;q=0.1',
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

export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const url = String(query.url || '')

  if (!url || !isAllowedUrl(url)) {
    return cssErrorResponse(event, `Invalid or disallowed URL: ${url}`, 400)
  }

  try {
    const resp = await fetchAllowedUpstream(url)

    if (!resp.ok) {
      return cssErrorResponse(event, `Upstream returned ${resp.status} for ${url}`)
    }

    // Check if the response looks like HTML instead of CSS
    const contentType = resp.headers.get('content-type') || ''
    if (contentType.includes('text/html')) {
      return cssErrorResponse(event, `Upstream returned text/html instead of CSS for ${url}`)
    }

    let css = await resp.text()

    // Resolve the final URL after redirects for correct relative path resolution
    const finalUrl = resp.url || url
    if (!isAllowedUrl(finalUrl)) {
      return cssErrorResponse(event, `Disallowed final URL: ${finalUrl}`, 502)
    }
    css = rewriteCssUrls(css, finalUrl)

    setResponseHeaders(event, {
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=7200',
      'Access-Control-Allow-Origin': '*',
    })

    return css
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    return cssErrorResponse(event, `Proxy fetch failed: ${message}`)
  }
})
