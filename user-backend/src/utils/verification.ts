import { createHash, randomInt } from 'crypto';

export function generateNumericCode(length: number) {
  if (length <= 0) throw new Error('code length must be positive');
  const max = 10 ** length;
  const value = randomInt(0, max);
  return value.toString().padStart(length, '0');
}

export function hashVerificationCode(code: string) {
  return createHash('sha256').update(code).digest('hex');
}
