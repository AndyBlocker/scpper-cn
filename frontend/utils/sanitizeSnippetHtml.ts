import DOMPurify from 'isomorphic-dompurify'

/**
 * 对搜索 snippet HTML 进行安全过滤。
 * 只允许安全的内联格式化标签，移除所有脚本、事件属性等。
 */
export function sanitizeSnippetHtml(html: string | null | undefined): string {
  if (!html) return ''
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['mark', 'b', 'em', 'span', 'strong', 'i'],
    ALLOWED_ATTR: ['class'],
    ALLOW_DATA_ATTR: false,
  })
}
