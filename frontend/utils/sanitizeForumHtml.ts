import DOMPurify from 'isomorphic-dompurify'

// ── CSS 属性白名单 ──
// 只允许安全的样式属性，过滤掉 position/z-index/expression 等可用于攻击的属性
const SAFE_CSS_PROPS = new Set([
  'text-align', 'text-decoration', 'text-indent', 'text-transform',
  'color', 'background-color', 'background',
  'font-size', 'font-weight', 'font-style', 'font-family', 'font-variant',
  'width', 'max-width', 'min-width', 'height', 'max-height', 'min-height',
  'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
  'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border', 'border-top', 'border-right', 'border-bottom', 'border-left',
  'border-color', 'border-width', 'border-style', 'border-radius',
  'border-collapse', 'border-spacing',
  'display', 'float', 'clear', 'overflow', 'overflow-x', 'overflow-y',
  'list-style', 'list-style-type', 'list-style-position',
  'vertical-align', 'white-space', 'word-break', 'word-wrap',
  'line-height', 'letter-spacing',
  'opacity',
  'table-layout',
])

function sanitizeCss(cssText: string): string {
  return cssText
    .split(';')
    .map(d => d.trim())
    .filter(d => {
      if (!d) return false
      const i = d.indexOf(':')
      if (i === -1) return false
      const prop = d.slice(0, i).trim().toLowerCase()
      const val = d.slice(i + 1).trim().toLowerCase()
      if (val.includes('expression') || val.includes('javascript:') || val.includes('-moz-binding')) return false
      return SAFE_CSS_PROPS.has(prop)
    })
    .join('; ')
}

function rewriteRelativeCssUrls(cssText: string): string {
  return cssText.replace(
    /url\(\s*(["']?)(\/[^)"']*)\1\s*\)/gi,
    (_match, quote, path) => `url(${quote}${absolutizeWikidotPath(path)}${quote})`,
  )
}

// 使用独立的 DOMPurify 钩子注册，避免污染全局 DOMPurify 实例。
// 通过 flag 确保只注册一次（即使模块被 HMR 重新加载）。
let hookRegistered = false

function ensureHook(): void {
  if (hookRegistered) return
  hookRegistered = true
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.hasAttribute('style')) {
      let cleaned = sanitizeCss(node.getAttribute('style')!)
      cleaned = rewriteRelativeCssUrls(cleaned)
      // 折叠块的 display 由 CSS 类控制，需要移除内联 display
      if ((node as Element).classList?.contains('collapsible-block-unfolded')) {
        cleaned = cleaned
          .split(';')
          .filter(d => !d.trim().toLowerCase().startsWith('display'))
          .join('; ')
          .trim()
      }
      if (cleaned) {
        node.setAttribute('style', cleaned)
      } else {
        node.removeAttribute('style')
      }
    }
  })
}

// ── HTML 标签 / 属性白名单 ──

const ALLOWED_TAGS = [
  // 块级元素
  'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'blockquote', 'pre', 'hr', 'br',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup', 'col',
  'figure', 'figcaption', 'details', 'summary',
  // 内联元素
  'a', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins',
  'sub', 'sup', 'small', 'mark', 'abbr', 'cite',
  'code', 'tt', 'kbd', 'var', 'samp',
  'span', 'ruby', 'rt', 'rp',
  // 媒体
  'img',
  // Wikidot 遗留元素
  'center', 'font',
]

const ALLOWED_ATTR = [
  'href', 'src', 'alt', 'title', 'class', 'id',
  'style', // 通过 afterSanitizeAttributes 钩子做 CSS 属性级过滤
  'srcset',
  'target', 'rel', 'width', 'height',
  'colspan', 'rowspan', 'scope', 'headers',
  'start', 'type', 'reversed', // 列表属性
  'open', // details
  'lang', 'dir',
  'color', 'size', 'face', // <font> 属性
]

const WIKIDOT_SITE_BASE = 'https://scp-wiki-cn.wikidot.com'

function absolutizeWikidotPath(path: string): string {
  return `${WIKIDOT_SITE_BASE}/${String(path || '').replace(/^\/+/u, '')}`
}

function rewriteRelativeSrcset(rawSrcset: string): string {
  return rawSrcset
    .split(',')
    .map((part) => {
      const segment = part.trim()
      if (!segment) return ''
      const [rawUrl, ...descriptors] = segment.split(/\s+/u)
      if (!rawUrl) return ''
      const nextUrl = rawUrl.startsWith('/') ? absolutizeWikidotPath(rawUrl) : rawUrl
      return [nextUrl, ...descriptors].join(' ')
    })
    .filter(Boolean)
    .join(', ')
}

function rewriteRelativeForumUrls(html: string): string {
  return html
    .replace(
      /href="\/([^"]*?)"/g,
      (_match, path) => `href="${absolutizeWikidotPath(path)}" target="_blank" rel="noopener noreferrer"`,
    )
    .replace(
      /\b(src|poster)="\/([^"]*?)"/g,
      (_match, attr, path) => `${attr}="${absolutizeWikidotPath(path)}"`,
    )
    .replace(
      /\bsrcset="([^"]*?)"/g,
      (_match, srcset) => `srcset="${rewriteRelativeSrcset(srcset)}"`,
    )
}

/**
 * 对论坛帖子的 HTML 内容进行安全过滤并转换 Wikidot 相对链接。
 *
 * - 允许 Wikidot 渲染引擎生成的格式化标签（p, strong, a, img, table 等）
 * - 移除危险标签（script, iframe, style, form, object 等）和事件处理属性
 * - 内联 style 属性通过 CSS 属性白名单过滤（允许 color、display 等，禁止 position、z-index 等）
 * - 将 Wikidot 站内相对链接和媒体地址转换为绝对链接（在净化之后执行）
 * - 保留已转义的 HTML 实体（如 &lt;div&gt;），不会二次渲染为标签
 */
export function sanitizeForumHtml(html: string | null | undefined): string {
  if (!html) return ''

  // 确保 CSS 过滤钩子已注册（幂等，只注册一次）
  ensureHook()

  // 1. DOMPurify 过滤：只保留安全标签和属性
  let sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  })

  // 2. 转换 Wikidot 相对链接和媒体地址为绝对链接（在净化之后执行，更安全）
  sanitized = rewriteRelativeForumUrls(sanitized)

  return sanitized
}
