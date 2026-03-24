function ensureString(value, fallback = '') {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value);
}

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeRecipient(recipient) {
  if (!recipient || typeof recipient !== 'object') {
    return {};
  }
  const email = ensureString(recipient.email).trim();
  const name = ensureString(recipient.name).trim();
  return { email, name };
}

function buildVerificationTemplate(payload, context) {
  const code = ensureString(payload?.code).trim();
  if (!code) {
    throw new Error('验证码不能为空');
  }
  const ttlMinutes = Number(payload?.ttlMinutes);
  const ttlText = Number.isFinite(ttlMinutes) && ttlMinutes > 0
    ? `${ttlMinutes}分钟内`
    : '短时间内';
  const reason = ensureString(payload?.reason, context?.defaultReason || 'SCPPER-CN 验证');

  const subject = `SCPPER-CN 验证码 ${code}`;
  const text = [
    `${reason}验证码：${code}`,
    `请在${ttlText}使用该验证码。`,
    '',
    '如果不是您本人操作，请忽略此邮件。'
  ].join('\n');
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>${subject}</title>
  </head>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; padding: 24px; color: #111827;">
    <div style="max-width: 480px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 24px; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.1);">
      <h1 style="font-size: 20px; margin: 0 0 16px 0; color: #0f172a;">${escapeHtml(reason)}</h1>
      <p style="margin: 0 0 12px 0;">您的验证码：</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #2563eb; margin: 0 0 16px 0;">${escapeHtml(code)}</p>
      <p style="margin: 0 0 16px 0; color: #334155;">请在<strong>${escapeHtml(ttlText)}</strong>内使用该验证码。</p>
      <p style="margin: 0; color: #94a3b8; font-size: 12px;">如果不是您本人操作，请忽略此邮件。</p>
    </div>
  </body>
</html>`;

  return { subject, text, html };
}

// 邮件 HTML 安全标签白名单
const MAIL_SAFE_TAGS = new Set([
  'p', 'div', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'del', 'small', 'mark',
  'span', 'a', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'table', 'thead', 'tbody', 'tr', 'td', 'th',
  'img',
]);

// 邮件 HTML 安全属性白名单
const MAIL_SAFE_ATTRS = new Set([
  'href', 'src', 'alt', 'title', 'style', 'class',
  'width', 'height', 'colspan', 'rowspan', 'target', 'rel',
]);

/** 安全 URL 协议白名单 */
const SAFE_URL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * 粗略解码 HTML 实体，将属性值还原为真实文本，
 * 用于在协议校验前消除各种实体编码绕过。
 */
function decodeHtmlEntities(str) {
  // 数字实体（十六进制和十进制）
  let decoded = str.replace(/&#x([0-9a-f]+);?/gi, (_, hex) => {
    try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; }
  });
  decoded = decoded.replace(/&#(\d+);?/g, (_, dec) => {
    try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ''; }
  });
  // 命名实体：替换为对应字符（覆盖常见攻击向量）
  const namedEntities = {
    '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
    '&nbsp;': ' ', '&colon;': ':', '&tab;': '\t', '&newline;': '\n',
    '&lpar;': '(', '&rpar;': ')', '&sol;': '/', '&bsol;': '\\',
    '&comma;': ',', '&semi;': ';', '&equals;': '=', '&num;': '#',
    '&period;': '.', '&excl;': '!', '&quest;': '?', '&plus;': '+',
  };
  decoded = decoded.replace(/&[a-z]+;/gi, (entity) => {
    return namedEntities[entity.toLowerCase()] ?? '';
  });
  return decoded;
}

/**
 * 检查 URL 是否安全（白名单协议策略）。
 * 只允许 http:, https:, mailto: 和相对路径；其余一律拒绝。
 */
function isSafeUrl(rawVal) {
  const decoded = decodeHtmlEntities(rawVal).replace(/[\s\x00-\x1f]+/g, '').trim();
  if (!decoded) return false;
  // 相对路径和锚点链接视为安全
  if (decoded.startsWith('/') || decoded.startsWith('#') || decoded.startsWith('?')) return true;
  // 提取协议部分
  const colonIdx = decoded.indexOf(':');
  if (colonIdx === -1) return true; // 无协议的相对路径
  const protocol = decoded.slice(0, colonIdx + 1).toLowerCase();
  return SAFE_URL_PROTOCOLS.has(protocol);
}

/**
 * 简易 HTML 过滤：只保留白名单中的标签和属性，
 * 移除 script、iframe、事件处理器等危险内容。
 */
function sanitizeMailHtml(raw) {
  if (!raw) return '';
  // 移除 script/style/iframe 等危险标签及其内容
  let html = raw.replace(/<(script|style|iframe|object|embed|form|input|textarea|select|button)\b[^]*?<\/\1\s*>/gi, '');
  // 移除未闭合的危险标签
  html = html.replace(/<\/?(script|style|iframe|object|embed|form|input|textarea|select|button)\b[^>]*>/gi, '');
  // 过滤剩余标签：只保留白名单标签和属性
  html = html.replace(/<\/?([a-z][a-z0-9]*)\b([^>]*)?\/?>/gi, (match, tag, attrs) => {
    const lowerTag = tag.toLowerCase();
    if (!MAIL_SAFE_TAGS.has(lowerTag)) return '';
    if (!attrs || !attrs.trim()) return match.startsWith('</') ? `</${lowerTag}>` : `<${lowerTag}>`;
    // 过滤属性
    const safeAttrs = [];
    const attrRe = /([a-z][a-z0-9-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/gi;
    let m;
    while ((m = attrRe.exec(attrs)) !== null) {
      const attrName = m[1].toLowerCase();
      const attrVal = m[2] ?? m[3] ?? m[4] ?? '';
      if (!MAIL_SAFE_ATTRS.has(attrName)) continue;
      // 白名单协议校验：只允许 http/https/mailto 和相对路径
      if ((attrName === 'href' || attrName === 'src') && !isSafeUrl(attrVal)) continue;
      safeAttrs.push(`${attrName}="${attrVal.replace(/"/g, '&quot;')}"`);
    }
    const attrStr = safeAttrs.length > 0 ? ' ' + safeAttrs.join(' ') : '';
    if (match.startsWith('</')) return `</${lowerTag}>`;
    const selfClose = match.trimEnd().endsWith('/>') ? ' /' : '';
    return `<${lowerTag}${attrStr}${selfClose}>`;
  });
  // 移除所有事件属性 (on*)
  html = html.replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|\S+)/gi, '');
  return html;
}

function buildGenericTemplate(payload) {
  const subject = ensureString(payload?.subject).trim();
  if (!subject) {
    throw new Error('消息主题不能为空');
  }
  const text = ensureString(payload?.text).trim();
  const rawHtml = ensureString(payload?.html).trim() || undefined;
  const html = rawHtml ? sanitizeMailHtml(rawHtml) : undefined;
  if (!text && !html) {
    throw new Error('消息内容必须包含 text 或 html');
  }
  return { subject, text: text || undefined, html };
}

const templateBuilders = {
  verification: buildVerificationTemplate,
  generic: buildGenericTemplate
};

export function renderTemplate(type, payload, context = {}) {
  const builder = templateBuilders[type];
  if (!builder) {
    throw new Error(`暂不支持的消息类型: ${type}`);
  }
  return builder(payload, context);
}

export function formatRecipient(recipient) {
  const { email, name } = normalizeRecipient(recipient);
  if (!email) {
    throw new Error('收件人邮箱不能为空');
  }
  return name ? `${name} <${email}>` : email;
}
