import http from 'http';
import { config } from './config.mjs';
import { createMailer } from './lib/mailer.mjs';
import { RateLimiterManager } from './lib/rateLimiter.mjs';
import { formatRecipient, renderTemplate } from './lib/templates.mjs';

const mailer = createMailer(config);
const rateLimiter = new RateLimiterManager(config.rateLimit.default, config.rateLimit.overrides);

function createLogger() {
  function log(level, message, meta = {}) {
    const entry = {
      ts: new Date().toISOString(),
      level,
      message,
      ...meta
    };
    const line = JSON.stringify(entry);
    if (level === 'error') {
      console.error(line);
    } else if (level === 'warn') {
      console.warn(line);
    } else {
      console.log(line);
    }
  }
  return {
    info: (message, meta) => log('info', message, meta),
    warn: (message, meta) => log('warn', message, meta),
    error: (message, meta) => log('error', message, meta)
  };
}

const logger = createLogger();

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

function normalizePath(url, hostHeader) {
  try {
    const parsed = new URL(url, `http://${hostHeader || 'localhost'}`);
    return parsed.pathname;
  } catch (error) {
    return url;
  }
}

function readRequestBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', (error) => reject(error));
  });
}

function normalizeType(value) {
  return String(value || '').trim();
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function createRateKey(type, email) {
  const normalizedType = normalizeType(type) || 'generic';
  const normalizedEmail = normalizeEmail(email);
  return `${normalizedType}:${normalizedEmail}`;
}

async function handleSend(req, res) {
  const raw = await readRequestBody(req, config.http.bodyLimit);
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch (error) {
    sendJson(res, 400, { error: '请求体不是有效的 JSON' });
    return;
  }

  const type = normalizeType(payload.type);
  const recipient = payload.recipient;
  const messagePayload = payload.payload;
  const metadata = payload.metadata || {};

  if (!type) {
    sendJson(res, 400, { error: 'type 不能为空' });
    return;
  }
  if (!recipient || typeof recipient !== 'object' || !recipient.email) {
    sendJson(res, 400, { error: 'recipient.email 不能为空' });
    return;
  }

  const rateKey = createRateKey(type, recipient.email);
  const rateResult = rateLimiter.consume(rateKey, type);
  if (!rateResult.allowed) {
    sendJson(res, 429, {
      error: '请求过于频繁，请稍后再试',
      retryAfterMs: rateResult.retryAfterMs
    });
    return;
  }

  let rendered;
  try {
    rendered = renderTemplate(type, messagePayload, metadata);
  } catch (error) {
    sendJson(res, 400, { error: error.message || '模板渲染失败' });
    return;
  }

  let formattedRecipient;
  try {
    formattedRecipient = formatRecipient(recipient);
  } catch (error) {
    sendJson(res, 400, { error: error.message || '收件人信息有误' });
    return;
  }

  try {
    const info = await mailer.send({
      to: formattedRecipient,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: {
        'X-SCP-CN-Message-Type': type,
        ...metadata?.headers
      }
    });
    logger.info('mail sent', {
      to: recipient.email,
      type,
      messageId: info.messageId,
      rateRemaining: rateResult.remaining
    });
    sendJson(res, 200, {
      messageId: info.messageId,
      accepted: info.accepted,
      rejected: info.rejected,
      envelope: info.envelope
    });
  } catch (error) {
    logger.error('mail send failed', {
      to: recipient.email,
      type,
      error: error && error.message ? error.message : String(error)
    });
    sendJson(res, 502, { error: '邮件发送失败' });
  }
}

const server = http.createServer(async (req, res) => {
  const path = normalizePath(req.url, req.headers.host);

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
    res.end();
    return;
  }

  if (req.method === 'GET' && path === '/health') {
    sendJson(res, 200, { status: 'ok', now: new Date().toISOString() });
    return;
  }

  if (req.method === 'POST' && path === '/send') {
    try {
      await handleSend(req, res);
    } catch (error) {
      if (error.message === 'Payload too large') {
        sendJson(res, 413, { error: '请求体过大' });
        return;
      }
      logger.error('unhandled error', { error: error.message || String(error) });
      sendJson(res, 500, { error: '服务器内部错误' });
    }
    return;
  }

  sendJson(res, 404, { error: '未找到对应的接口' });
});

server.listen(config.http.port, () => {
  logger.info('mail-agent listening', {
    port: config.http.port,
    rateLimit: config.rateLimit
  });
});

function handleShutdown(signal) {
  logger.info('received shutdown signal', { signal });
  server.close(() => {
    logger.info('server closed gracefully');
    process.exit(0);
  });
  setTimeout(() => {
    logger.warn('forcing shutdown');
    process.exit(1);
  }, 5000).unref();
}

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);
