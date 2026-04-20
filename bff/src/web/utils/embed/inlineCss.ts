export const INLINE_CSS_MAX_BYTES = 4096;

/**
 * 把 CSS 转义（`\HH ` / `\HHHHHH` / `\X`）展开成真实字符。
 *
 * 该函数只用于"检测输入里是否混入了需要被拒绝的关键字"。实际返回给客户端的仍然是
 * 原始字符串：让浏览器自己按 CSS 规范重新识别转义，这样作者还能用 `\feff` 之类的
 * 合法写法。参考 CSS Syntax Module Level 3 §4.3.7。
 *
 * 尾随的 whitespace 可以是 `[\t\n\f\r ]` 中一项，或 CRLF 作为整体被吞掉；
 * 单独的 \r\n 也允许。参见 §4.3.7 的 "whitespace" token 定义。
 */
function decodeCssEscapes(src: string): string {
  return src.replace(/\\([0-9a-fA-F]{1,6})(?:\r\n|[\t\n\f\r ])?|\\([^\n\r\f])/g, (_, hex, other) => {
    if (hex) {
      const code = parseInt(hex, 16);
      if (!Number.isFinite(code) || code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) {
        return '\ufffd';
      }
      try {
        return String.fromCodePoint(code);
      } catch {
        return '\ufffd';
      }
    }
    return other || '';
  });
}

const FORBIDDEN_DECODED: RegExp[] = [
  /@import/i,
  /@charset/i,
  /@namespace/i,
  /@document/i,
  /behavior\s*:/i,
  /-moz-binding/i,
  /expression\s*\(/i,
  /javascript\s*:/i,
  /vbscript\s*:/i,
  /data\s*:\s*text\//i,
  /data\s*:\s*application\/(x-)?javascript/i
];

// HTML-层 break-out 必须对原始字符串匹配：HTML 解析器看 <style> 里的文本时
// 只找字面 `</style>` / `</script>`，不过任何 CSS 转义，所以检测必须基于原文。
const FORBIDDEN_RAW: RegExp[] = [
  /<\s*\/?\s*style\b/i,
  /<\s*\/?\s*script\b/i,
  /<\s*\/?\s*iframe\b/i
];

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

  // HTML break-out 必须基于"原始输入（未剥注释）"匹配：<style> 元素的 HTML raw-text
  // 解析模式只会扫字面 </style>，根本不理解 CSS 注释，所以 `/* </style> */` 这类写法
  // 会提前关掉 <style> 并让后续内容逃出。
  for (const rule of FORBIDDEN_RAW) {
    if (rule.test(input)) return '';
  }

  // 剥离块注释后再做关键字与 url() 检查；CSS 行注释 (//) 不是标准，不处理。
  const commentStripped = input.replace(/\/\*[\s\S]*?\*\//g, ' ');

  // 其他关键字用"CSS 转义展开后"的文本匹配，堵掉 `@\41import` / `ex\70 ression(` 之类绕过
  const decoded = decodeCssEscapes(commentStripped);
  for (const rule of FORBIDDEN_DECODED) {
    if (rule.test(decoded)) return '';
  }

  // 限制 url(...)：
  //   - `url("...")` / `url('...')` 分支单独匹配，允许 URL 内部包含 `)` 和转义字符
  //     （`(?:\\.|[^"\\])*` 允许 `\\"`、`\\\\` 这类合法 CSS string escape，否则
  //     遇到 `url("https://x/a\\""` 这类输入正则会整体不命中，导致原文直接透传）
  //   - 不带引号的走 URL-token 分支，内部不可出现 `'"()` 和空白
  const URL_REGEX = /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^'")\s]+))\s*\)/gi;
  const urlCleaned = commentStripped.replace(URL_REGEX, (_full, dq, sq, bare) => {
    const url = String(dq ?? sq ?? bare ?? '').trim();
    if (!url) return 'none';
    const decodedUrl = decodeCssEscapes(url).toLowerCase();
    if (decodedUrl.startsWith('data:')) {
      if (!/^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);/i.test(decodedUrl)) return 'none';
      return `url("${url.replace(/["\\<>]/g, '')}")`;
    }
    if (decodedUrl.startsWith('/') && !decodedUrl.startsWith('//')) {
      return `url("${url.replace(/["\\<>]/g, '')}")`;
    }
    // 其他（含 http:/https:/相对路径/协议相对）一律清洗掉，防止追踪像素
    return 'none';
  });

  return urlCleaned.trim();
}
