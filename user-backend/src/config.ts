import 'dotenv/config';

function toNumber(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const config = {
  port: toNumber(process.env.USER_BACKEND_PORT, 4455),
  verification: {
    codeLength: toNumber(process.env.USER_VERIFICATION_CODE_LENGTH, 6),
    ttlMinutes: toNumber(process.env.USER_VERIFICATION_TTL_MINUTES, 10),
    maxAttempts: toNumber(process.env.USER_VERIFICATION_MAX_ATTEMPTS, 5)
  },
  rateLimit: {
    registerWindowSeconds: toNumber(process.env.USER_REGISTER_RATE_WINDOW_SECONDS, 60)
  },
  mailAgent: {
    baseUrl: process.env.MAIL_AGENT_BASE_URL || 'http://127.0.0.1:3110'
  },
  session: {
    cookieName: process.env.USER_SESSION_COOKIE || 'scpper_session',
    ttlHours: toNumber(process.env.USER_SESSION_TTL_HOURS, 24 * 7),
    sameSite: (process.env.USER_SESSION_SAMESITE as 'lax' | 'strict' | 'none' | undefined) || 'lax',
    secure: process.env.USER_SESSION_SECURE === 'true',
    secret: process.env.USER_SESSION_SECRET || 'scpper-dev-secret'
  }
};
