import crypto from 'crypto';
import { config } from '../config.js';

const TOKEN_PARTS = 3;

function base64UrlEncode(input: string) {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function base64UrlDecode(input: string) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

function passwordSignature(passwordHash: string | null | undefined) {
  if (!passwordHash) {
    return '';
  }
  return crypto.createHash('sha256').update(passwordHash).digest('hex');
}

function computeSignature(userId: string, issuedAt: number, passwordHash: string | null | undefined) {
  const signatureBase = `${userId}.${issuedAt}.${passwordSignature(passwordHash)}`;
  return crypto.createHmac('sha256', config.session.secret).update(signatureBase).digest('base64url');
}

export function issueAuthToken(userId: string, passwordHash: string | null | undefined): string {
  const issuedAt = Date.now();
  const signature = computeSignature(userId, issuedAt, passwordHash);
  const encodedId = base64UrlEncode(userId);
  const issuedToken = `${encodedId}.${issuedAt.toString(36)}.${signature}`;
  return issuedToken;
}

export function extractUserId(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== TOKEN_PARTS) return null;
  const [encodedId] = parts;
  if (!encodedId) return null;
  try {
    return base64UrlDecode(encodedId);
  } catch {
    return null;
  }
}

export function verifyAuthToken(token: string, passwordHash: string | null | undefined) {
  try {
    if (!token) return { valid: false } as const;
    const parts = token.split('.');
    if (parts.length !== TOKEN_PARTS) {
      return { valid: false } as const;
    }
    const [encodedId, issuedAtPart, signaturePart] = parts;
    const userId = base64UrlDecode(encodedId);
    const issuedAt = parseInt(issuedAtPart, 36);
    if (!userId || Number.isNaN(issuedAt)) {
      return { valid: false } as const;
    }
    const expected = computeSignature(userId, issuedAt, passwordHash);
    const providedBuf = Buffer.from(signaturePart, 'base64url');
    const expectedBuf = Buffer.from(expected, 'base64url');
    if (providedBuf.length !== expectedBuf.length) {
      return { valid: false } as const;
    }
    if (!crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      return { valid: false } as const;
    }
    const expiresAt = issuedAt + config.session.ttlHours * 60 * 60 * 1000;
    if (Date.now() > expiresAt) {
      return { valid: false, expired: true as const };
    }
    return { valid: true as const, userId, issuedAt };
  } catch {
    return { valid: false } as const;
  }
}
