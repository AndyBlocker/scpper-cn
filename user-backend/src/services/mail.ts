import { fetch } from 'undici';
import { config } from '../config.js';

const MAIL_AGENT_API_KEY = (process.env.MAIL_AGENT_API_KEY || '').trim();

function mailHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (MAIL_AGENT_API_KEY) {
    h['x-internal-key'] = MAIL_AGENT_API_KEY;
  }
  return h;
}

interface VerificationEmailPayload {
  email: string;
  code: string;
  ttlMinutes: number;
  displayName?: string | null;
}

export async function sendVerificationEmail({ email, code, ttlMinutes, displayName }: VerificationEmailPayload) {
  const url = new URL('/send', config.mailAgent.baseUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: mailHeaders(),
    body: JSON.stringify({
      type: 'verification',
      recipient: {
        email,
        name: displayName || undefined
      },
      payload: {
        code,
        ttlMinutes,
        reason: 'SCPPER-CN 注册'
      },
      metadata: {
        headers: {
          'X-SCP-CN-Context': 'user-register'
        }
      }
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`mail-agent error: ${response.status} ${response.statusText} ${body}`.trim());
  }
}

export async function sendPasswordResetEmail({ email, code, ttlMinutes, displayName }: VerificationEmailPayload) {
  const url = new URL('/send', config.mailAgent.baseUrl);
  const response = await fetch(url, {
    method: 'POST',
    headers: mailHeaders(),
    body: JSON.stringify({
      type: 'verification',
      recipient: {
        email,
        name: displayName || undefined
      },
      payload: {
        code,
        ttlMinutes,
        reason: 'SCPPER-CN 密码重置'
      },
      metadata: {
        headers: {
          'X-SCP-CN-Context': 'user-password-reset'
        }
      }
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`mail-agent error: ${response.status} ${response.statusText} ${body}`.trim());
  }
}
