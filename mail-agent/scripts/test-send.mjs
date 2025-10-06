import 'dotenv/config';
import { randomInt } from 'node:crypto';

function trimOrUndefined(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

const baseUrl = trimOrUndefined(process.env.MAIL_AGENT_URL) || 'http://localhost:3110';
const endpoint = `${baseUrl.replace(/\/$/, '')}/send`;
const type = trimOrUndefined(process.env.MAIL_AGENT_TEST_TYPE) || 'verification';
const toEmail = trimOrUndefined(process.env.MAIL_AGENT_TEST_TO) || trimOrUndefined(process.env.TEST_TO);
const toName = trimOrUndefined(process.env.MAIL_AGENT_TEST_NAME);

if (!toEmail) {
  console.error('请设置 MAIL_AGENT_TEST_TO 或 TEST_TO 环境变量');
  process.exit(1);
}

const metadataHeaders = {};
const requestId = `mail-agent-test-${Date.now()}`;
metadataHeaders['X-Request-ID'] = requestId;

function buildPayload() {
  if (type === 'verification') {
    const ttlMinutesRaw = trimOrUndefined(process.env.MAIL_AGENT_TEST_TTL_MINUTES);
    const ttlMinutes = ttlMinutesRaw ? Number(ttlMinutesRaw) : 15;
    const code = trimOrUndefined(process.env.MAIL_AGENT_TEST_CODE) || String(randomInt(100000, 999999));
    const reason = trimOrUndefined(process.env.MAIL_AGENT_TEST_REASON) || 'SCPPER-CN 验证';
    return {
      payload: {
        code,
        ttlMinutes: Number.isFinite(ttlMinutes) ? ttlMinutes : 15,
        reason
      }
    };
  }

  const subject = trimOrUndefined(process.env.MAIL_AGENT_TEST_SUBJECT) || `mail-agent 测试 ${new Date().toISOString()}`;
  const text = trimOrUndefined(process.env.MAIL_AGENT_TEST_TEXT) || `这是一封来自 mail-agent 的测试消息，时间 ${new Date().toISOString()}`;
  const html = trimOrUndefined(process.env.MAIL_AGENT_TEST_HTML);

  return {
    payload: {
      subject,
      text,
      html
    }
  };
}

const { payload } = buildPayload();

const body = {
  type,
  recipient: {
    email: toEmail,
    name: toName
  },
  payload,
  metadata: {
    headers: metadataHeaders
  }
};

async function main() {
  console.log('发送测试请求到 mail-agent', { endpoint, type, to: toEmail, requestId });

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    const resultText = await response.text();
    let result;
    try {
      result = JSON.parse(resultText);
    } catch (error) {
      result = resultText;
    }

    if (!response.ok) {
      console.error('mail-agent 返回错误', {
        status: response.status,
        body: result
      });
      process.exit(1);
    }

    console.log('mail-agent 返回成功', result);
  } catch (error) {
    console.error('请求 mail-agent 失败', error);
    process.exit(1);
  }
}

main();
