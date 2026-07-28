/**
 * QQ 绑定的纯判定逻辑。
 *
 * 与 wikidotBindingProof.ts 同构：把「不碰数据库、不碰时钟以外的外部状态」的部分
 * 单独拆出来，好处是这些恰恰是最容易出错、也最值得写单测的地方
 * （过期判定、尝试次数上限、状态机流转、掩码不泄露原值）。
 */

import { createHash, randomInt } from 'crypto';

/** 与 qqbot 侧 binding.py 的 CODE_ALPHABET 保持一致：去掉了 0/O、1/I/L 等形近字。 */
export const BINDING_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const BINDING_CODE_LENGTH = 12;
export const BINDING_CODE_PREFIX = 'SCPPER-';

/** 单个挑战允许的最大校验失败次数，超过即作废，防止拿一个码反复试。 */
export const MAX_VERIFY_ATTEMPTS = 5;

/**
 * 生成验证码明文。
 *
 * 熵：31^12 ≈ 2^59.4。配合 15 分钟 TTL 与多层限流，爆破不可行。
 * 用 crypto.randomInt 而非 Math.random —— 后者是可预测的 PRNG。
 */
export function generateBindingCode(): string {
  let code = '';
  for (let i = 0; i < BINDING_CODE_LENGTH; i += 1) {
    code += BINDING_CODE_CHARS.charAt(randomInt(BINDING_CODE_CHARS.length));
  }
  return `${BINDING_CODE_PREFIX}${code}`;
}

/** sha256(明文)。验证码不明文落库，回调时按哈希反查。 */
export function hashBindingCode(code: string): string {
  return createHash('sha256').update(normalizeBindingCode(code) ?? '').digest('hex');
}

/**
 * 归一化用户/机器人回传的验证码。
 *
 * 用户可能：小写抄写、带或不带 SCPPER- 前缀、中间打了空格或连字符。
 * 归一化失败（长度不对、含非法字符）返回 null —— 调用方据此在查库之前就拒掉，
 * 既省一次查询，也让「格式就不对」和「码不存在」在日志里可区分。
 */
export function normalizeBindingCode(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = String(input).toUpperCase().replace(/[\s\-_　]+/g, '');
  if (s.startsWith('SCPPER')) s = s.slice(6);
  if (s.length !== BINDING_CODE_LENGTH) return null;
  for (const ch of s) {
    if (!BINDING_CODE_CHARS.includes(ch)) return null;
  }
  return s;
}

/** 取明文码的末 4 位做提示。不足以反推完整码（剩余熵仍有 31^8 ≈ 2^39.6）。 */
export function bindingCodeHint(code: string): string {
  const normalized = normalizeBindingCode(code);
  return normalized ? normalized.slice(-4) : '';
}

/**
 * 校验并归一化 QQ 号。
 *
 * QQ 号是 5–11 位数字且无前导零。刻意不接受更宽松的输入：
 * 这个值会成为唯一约束的一部分，"00123" 和 "123" 若都能进库就会绕过唯一性。
 */
export function normalizeQqNumber(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!/^[1-9][0-9]{4,10}$/.test(s)) return null;
  return s;
}

/**
 * 展示用掩码：前 4 位 + *** + 末 1 位。
 *
 * 所有对外 API（/auth/me、绑定状态、管理端列表）一律只返回它，
 * 完整号只在 user-backend 的投递路径与 backend dispatcher 内部使用。
 */
export function maskQqNumber(address: string): string {
  const s = String(address);
  if (s.length <= 5) return `${s.slice(0, 1)}***`;
  return `${s.slice(0, 4)}***${s.slice(-1)}`;
}

export type ChallengeStatus = 'PENDING' | 'VERIFIED' | 'EXPIRED' | 'CANCELLED' | 'FAILED';

export interface ChallengeSnapshot {
  status: ChallengeStatus;
  expiresAt: Date;
  attemptCount: number;
}

export type VerifyRejection =
  | 'code_malformed'
  | 'code_unknown'
  | 'code_expired'
  | 'code_consumed'
  | 'code_cancelled'
  | 'too_many_attempts';

export type VerifyDecision =
  | { ok: true }
  | { ok: false; reason: VerifyRejection };

/**
 * 判断一个挑战当下是否还能被核销。
 *
 * 注意 EXPIRED 与「状态是 PENDING 但已过 expiresAt」要给同一个结果 ——
 * 过期状态的落库是由清理任务异步做的，不能指望读到的 status 一定是最新的。
 */
export function evaluateChallenge(challenge: ChallengeSnapshot, now: Date): VerifyDecision {
  if (challenge.status === 'VERIFIED') return { ok: false, reason: 'code_consumed' };
  if (challenge.status === 'CANCELLED') return { ok: false, reason: 'code_cancelled' };
  if (challenge.status === 'FAILED') return { ok: false, reason: 'too_many_attempts' };
  if (challenge.status === 'EXPIRED') return { ok: false, reason: 'code_expired' };
  if (challenge.expiresAt.getTime() <= now.getTime()) return { ok: false, reason: 'code_expired' };
  if (challenge.attemptCount >= MAX_VERIFY_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };
  return { ok: true };
}

/**
 * 面向用户的拒绝文案。
 *
 * 「码不存在」「码已过期」「不是最新的码」刻意返回**同一句话** ——
 * 区分开会让攻击者能探测某个码是否存在过，等于把爆破的搜索空间免费缩小。
 * 只有「试太多次」和「已经用过」给出不同提示，因为这两种情况用户自己就知道发生了什么，
 * 不告诉他反而会让人反复重试。
 */
export function rejectionMessage(reason: VerifyRejection): string {
  switch (reason) {
    case 'too_many_attempts':
      return '这个验证码尝试次数过多已作废，请回网站重新生成。';
    case 'code_consumed':
      return '这个验证码已经用过了。如果不是你本人操作，请立即回网站解绑并修改密码。';
    default:
      return '验证码无效或已过期，请回网站重新生成后再试。';
  }
}
