import 'dotenv/config';

function parseNumber(value, fallback) {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (value === '1' || value === 'true') {
    return true;
  }
  if (value === '0' || value === 'false') {
    return false;
  }
  return fallback;
}

function safeParseJson(value) {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    console.warn('[mail-agent] Failed to parse JSON config:', error.message);
    return undefined;
  }
}

const smtpHost = process.env.MAIL_SMTP_HOST || 'smtpdm.aliyun.com';
const smtpPort = parseNumber(process.env.MAIL_SMTP_PORT, 465);
const smtpSecure = parseBoolean(process.env.MAIL_SMTP_SECURE, smtpPort === 465);
const smtpUser = process.env.MAIL_SMTP_USER || process.env.ALI_SMTP_USER;
const smtpPass = process.env.MAIL_SMTP_PASS || process.env.ALI_SMTP_PASS;

if (!smtpUser || !smtpPass) {
  throw new Error('[mail-agent] Missing SMTP credentials. Set MAIL_SMTP_USER and MAIL_SMTP_PASS.');
}

const fromName = process.env.MAIL_FROM_NAME || 'SCPPER-CN 验证';
const fromAddress = process.env.MAIL_FROM_ADDRESS || smtpUser;
const replyTo = process.env.MAIL_REPLY_TO || process.env.REPLY_TO || 'support@scp-cn.wiki';

const httpPort = parseNumber(process.env.MAIL_AGENT_PORT, 3110);
const bodyLimit = parseNumber(process.env.MAIL_AGENT_MAX_BODY_BYTES, 16 * 1024);

const defaultWindowMs = parseNumber(process.env.MAIL_AGENT_RATE_WINDOW_MS, 10 * 60 * 1000);
const defaultMax = parseNumber(process.env.MAIL_AGENT_RATE_MAX, 5);
const overridesInput = safeParseJson(process.env.MAIL_AGENT_RATE_LIMIT_OVERRIDES);

const rateLimitOverrides = {};
if (overridesInput && typeof overridesInput === 'object') {
  for (const [type, rawConfig] of Object.entries(overridesInput)) {
    if (!rawConfig || typeof rawConfig !== 'object') {
      continue;
    }
    const windowMs = parseNumber(rawConfig.windowMs, defaultWindowMs);
    const max = parseNumber(rawConfig.max, defaultMax);
    rateLimitOverrides[type] = { windowMs, max };
  }
}

export const config = {
  smtp: {
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    user: smtpUser,
    pass: smtpPass,
    fromName,
    fromAddress
  },
  defaults: {
    replyTo,
    locale: process.env.MAIL_LOCALE || 'zh-CN'
  },
  http: {
    port: httpPort,
    bodyLimit
  },
  rateLimit: {
    default: {
      windowMs: defaultWindowMs,
      max: defaultMax
    },
    overrides: rateLimitOverrides
  }
};
