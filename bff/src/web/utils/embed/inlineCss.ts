export const INLINE_CSS_MAX_BYTES = 4096;

/**
 * 结果：safe 版的 CSS 字符串（若被截断或拒绝，会返回空串）。
 *
 * 拒绝而非抛错的理由：CSS 是纯装饰，任何"解析不了"的情况直接回落到默认样式即可，
 * 不应该让整块嵌入 404。
 */
export function sanitizeInlineCss(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let input = raw.trim();
  if (!input) return '';

  // 超长直接截断，避免 URL 被刻意做长炸带宽
  const bytes = Buffer.byteLength(input, 'utf8');
  if (bytes > INLINE_CSS_MAX_BYTES) {
    // 截到字节上限附近；再找一个 '}' 当做安全边界，保证不会切到半条规则
    const slice = Buffer.from(input, 'utf8').slice(0, INLINE_CSS_MAX_BYTES).toString('utf8');
    const lastBrace = slice.lastIndexOf('}');
    input = lastBrace > 0 ? slice.slice(0, lastBrace + 1) : '';
    if (!input) return '';
  }

  // 剥离块注释，避免注释里绕过关键字检查；CSS 行注释 (//) 不是标准，不处理。
  let cleaned = input.replace(/\/\*[\s\S]*?\*\//g, ' ');

  // 关键字黑名单：遇到一项直接拒绝整块
  const forbidden: RegExp[] = [
    /@import/i,
    /@charset/i,
    /@namespace/i,
    /behavior\s*:/i,
    /-moz-binding/i,
    /expression\s*\(/i,
    /javascript\s*:/i,
    /vbscript\s*:/i,
    /<\s*\/?\s*style\b/i,
    /<\s*\/?\s*script\b/i,
    /<\s*\/?\s*iframe\b/i
  ];
  for (const rule of forbidden) {
    if (rule.test(cleaned)) return '';
  }

  // 限制 url(...)：只允许 http/https/相对路径 / data:image/*
  cleaned = cleaned.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, quote, urlRaw) => {
    const url = String(urlRaw).trim();
    if (!url) return 'none';
    const lower = url.toLowerCase();
    if (lower.startsWith('data:')) {
      // 只允许 data:image/*
      if (!/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);/i.test(url)) return 'none';
      return `url("${url.replace(/"/g, '')}")`;
    }
    if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('/') || lower.startsWith('./') || lower.startsWith('../')) {
      // 去掉引号反斜杠，避免 CSS 字符串注入
      const safe = url.replace(/["\\<>]/g, '');
      return `url("${safe}")`;
    }
    return 'none';
  });

  return cleaned.trim();
}
