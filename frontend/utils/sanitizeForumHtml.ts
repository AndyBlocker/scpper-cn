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

// 对 style 属性进行 CSS 属性级别过滤（DOMPurify 钩子，模块加载时注册一次）
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.hasAttribute('style')) {
    let cleaned = sanitizeCss(node.getAttribute('style')!)
    // 折叠块的 display 由 CSS 类控制，需要移除内联 display（否则优先级更高会覆盖 CSS 规则）
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
  'target', 'rel', 'width', 'height',
  'colspan', 'rowspan', 'scope', 'headers',
  'start', 'type', 'reversed', // 列表属性
  'open', // details
  'lang', 'dir',
  'color', 'size', 'face', // <font> 属性
]

/**
 * 对论坛帖子的 HTML 内容进行安全过滤并转换 Wikidot 相对链接。
 *
 * - 允许 Wikidot 渲染引擎生成的格式化标签（p, strong, a, img, table 等）
 * - 移除危险标签（script, iframe, style, form, object 等）和事件处理属性
 * - 内联 style 属性通过 CSS 属性白名单过滤（允许 color、display 等，禁止 position、z-index 等）
 * - 将 Wikidot 站内相对链接转换为绝对链接
 * - 保留已转义的 HTML 实体（如 &lt;div&gt;），不会二次渲染为标签
 */
export function sanitizeForumHtml(html: string | null | undefined): string {
  if (!html) return ''

  // 1. 先转换 Wikidot 相对链接为绝对链接
  const withAbsoluteLinks = html.replace(
    /href="\/([^"]*?)"/g,
    'href="https://scp-wiki-cn.wikidot.com/$1" target="_blank" rel="noopener noreferrer"',
  )

  // 2. DOMPurify 过滤：只保留安全标签和属性
  return DOMPurify.sanitize(withAbsoluteLinks, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  })
}
