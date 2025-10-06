function ensureString(value, fallback = '') {
  if (value === undefined || value === null) {
    return fallback;
  }
  return String(value);
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
      <h1 style="font-size: 20px; margin: 0 0 16px 0; color: #0f172a;">${reason}</h1>
      <p style="margin: 0 0 12px 0;">您的验证码：</p>
      <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px; color: #2563eb; margin: 0 0 16px 0;">${code}</p>
      <p style="margin: 0 0 16px 0; color: #334155;">请在<strong>${ttlText}</strong>内使用该验证码。</p>
      <p style="margin: 0; color: #94a3b8; font-size: 12px;">如果不是您本人操作，请忽略此邮件。</p>
    </div>
  </body>
</html>`;

  return { subject, text, html };
}

function buildGenericTemplate(payload) {
  const subject = ensureString(payload?.subject).trim();
  if (!subject) {
    throw new Error('消息主题不能为空');
  }
  const text = ensureString(payload?.text).trim();
  const html = ensureString(payload?.html).trim() || undefined;
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
