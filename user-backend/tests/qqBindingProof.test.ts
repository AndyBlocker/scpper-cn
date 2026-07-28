import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BINDING_CODE_CHARS,
  BINDING_CODE_LENGTH,
  MAX_VERIFY_ATTEMPTS,
  bindingCodeHint,
  evaluateChallenge,
  generateBindingCode,
  hashBindingCode,
  maskQqNumber,
  normalizeBindingCode,
  normalizeQqNumber,
  rejectionMessage,
  type ChallengeSnapshot
} from '../src/services/qqBindingProof.js';

const NOW = new Date('2026-07-28T12:00:00.000Z');

function challenge(overrides: Partial<ChallengeSnapshot> = {}): ChallengeSnapshot {
  return {
    status: 'PENDING',
    expiresAt: new Date('2026-07-28T12:10:00.000Z'),
    attemptCount: 0,
    ...overrides
  };
}

// ─── 验证码生成 ──────────────────────────────────────────────────────────

test('生成的验证码符合长度、前缀与字符集', () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateBindingCode();
    assert.ok(code.startsWith('SCPPER-'), `缺前缀: ${code}`);
    const body = code.slice('SCPPER-'.length);
    assert.equal(body.length, BINDING_CODE_LENGTH);
    for (const ch of body) {
      assert.ok(BINDING_CODE_CHARS.includes(ch), `非法字符 ${ch} in ${code}`);
    }
  }
});

test('生成的验证码不含形近字 0/O/1/I/L', () => {
  for (let i = 0; i < 200; i += 1) {
    const body = generateBindingCode().slice('SCPPER-'.length);
    assert.ok(!/[0O1IL]/.test(body), `含形近字: ${body}`);
  }
});

test('连续生成不重复（抽样）', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) seen.add(generateBindingCode());
  assert.equal(seen.size, 500);
});

// ─── 归一化 ──────────────────────────────────────────────────────────────

test('归一化容忍大小写、前缀有无、空格与连字符', () => {
  const canonical = 'ABCDEFGH2345';
  assert.equal(normalizeBindingCode('ABCDEFGH2345'), canonical);
  assert.equal(normalizeBindingCode('SCPPER-ABCDEFGH2345'), canonical);
  assert.equal(normalizeBindingCode('scpper-abcdefgh2345'), canonical);
  assert.equal(normalizeBindingCode('ABCD EFGH 2345'), canonical);
  assert.equal(normalizeBindingCode('ABCDEF-GH2345'), canonical);
  assert.equal(normalizeBindingCode('  SCPPER_ABCDEFGH2345  '), canonical);
});

test('归一化拒绝长度错误与非法字符', () => {
  assert.equal(normalizeBindingCode('ABCDEFGH234'), null);    // 11 位
  assert.equal(normalizeBindingCode('ABCDEFGH23456'), null);  // 13 位
  assert.equal(normalizeBindingCode('ABCDEFGH2340'), null);   // 含 0
  assert.equal(normalizeBindingCode('ABCDEFGH234O'), null);   // 含 O
  assert.equal(normalizeBindingCode(''), null);
  assert.equal(normalizeBindingCode(null), null);
  assert.equal(normalizeBindingCode(undefined), null);
});

test('自己生成的码一定能被自己归一化（往返）', () => {
  for (let i = 0; i < 100; i += 1) {
    const code = generateBindingCode();
    assert.equal(normalizeBindingCode(code), code.slice('SCPPER-'.length));
  }
});

// ─── 哈希 ────────────────────────────────────────────────────────────────

test('哈希对「同一个码的不同写法」稳定', () => {
  const h = hashBindingCode('SCPPER-ABCDEFGH2345');
  assert.equal(hashBindingCode('abcdefgh2345'), h);
  assert.equal(hashBindingCode('ABCD-EFGH-2345'), h);
  assert.equal(h.length, 64);
});

test('哈希不是明文，且不同码哈希不同', () => {
  const h = hashBindingCode('SCPPER-ABCDEFGH2345');
  assert.ok(!h.includes('ABCDEFGH2345'));
  assert.notEqual(h, hashBindingCode('SCPPER-ABCDEFGH2346'));
});

test('提示只暴露末 4 位', () => {
  assert.equal(bindingCodeHint('SCPPER-ABCDEFGH2345'), '2345');
  assert.equal(bindingCodeHint('bad'), '');
});

// ─── QQ 号 ───────────────────────────────────────────────────────────────

test('接受合法 QQ 号', () => {
  assert.equal(normalizeQqNumber('12345'), '12345');
  assert.equal(normalizeQqNumber(1248393597), '1248393597');
  assert.equal(normalizeQqNumber('  1248393597  '), '1248393597');
});

test('拒绝前导零 —— 否则 00123 与 123 会绕过唯一约束', () => {
  assert.equal(normalizeQqNumber('0123456'), null);
  assert.equal(normalizeQqNumber('00000'), null);
});

test('拒绝长度越界与非数字', () => {
  assert.equal(normalizeQqNumber('1234'), null);            // 太短
  assert.equal(normalizeQqNumber('123456789012'), null);    // 12 位，太长
  assert.equal(normalizeQqNumber('12345abc'), null);
  assert.equal(normalizeQqNumber(''), null);
  assert.equal(normalizeQqNumber(null), null);
  assert.equal(normalizeQqNumber({}), null);
});

test('掩码保留可辨识度但不泄露完整号', () => {
  assert.equal(maskQqNumber('1248393597'), '1248***7');
  assert.equal(maskQqNumber('12345'), '1***');
  const masked = maskQqNumber('1248393597');
  assert.ok(!masked.includes('839359'));
});

// ─── 挑战状态机 ──────────────────────────────────────────────────────────

test('PENDING 且未过期且未超次数 → 可核销', () => {
  assert.deepEqual(evaluateChallenge(challenge(), NOW), { ok: true });
});

test('已过 expiresAt 即便状态还是 PENDING 也算过期', () => {
  const c = challenge({ expiresAt: new Date('2026-07-28T11:59:59.000Z') });
  assert.deepEqual(evaluateChallenge(c, NOW), { ok: false, reason: 'code_expired' });
});

test('恰好到期算过期（边界）', () => {
  const c = challenge({ expiresAt: NOW });
  assert.deepEqual(evaluateChallenge(c, NOW), { ok: false, reason: 'code_expired' });
});

test('各终态分别给出对应拒因', () => {
  assert.deepEqual(evaluateChallenge(challenge({ status: 'VERIFIED' }), NOW), { ok: false, reason: 'code_consumed' });
  assert.deepEqual(evaluateChallenge(challenge({ status: 'CANCELLED' }), NOW), { ok: false, reason: 'code_cancelled' });
  assert.deepEqual(evaluateChallenge(challenge({ status: 'FAILED' }), NOW), { ok: false, reason: 'too_many_attempts' });
  assert.deepEqual(evaluateChallenge(challenge({ status: 'EXPIRED' }), NOW), { ok: false, reason: 'code_expired' });
});

test('尝试次数达上限即不可核销', () => {
  const c = challenge({ attemptCount: MAX_VERIFY_ATTEMPTS });
  assert.deepEqual(evaluateChallenge(c, NOW), { ok: false, reason: 'too_many_attempts' });
  assert.deepEqual(evaluateChallenge(challenge({ attemptCount: MAX_VERIFY_ATTEMPTS - 1 }), NOW), { ok: true });
});

test('终态优先于过期判定（已核销的码不该被说成过期）', () => {
  const c = challenge({ status: 'VERIFIED', expiresAt: new Date('2026-01-01T00:00:00.000Z') });
  assert.deepEqual(evaluateChallenge(c, NOW), { ok: false, reason: 'code_consumed' });
});

// ─── 文案 ────────────────────────────────────────────────────────────────

test('码不存在/过期/被取消返回同一句话，避免枚举探测', () => {
  const a = rejectionMessage('code_unknown');
  const b = rejectionMessage('code_expired');
  const c = rejectionMessage('code_cancelled');
  const d = rejectionMessage('code_malformed');
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(c, d);
});

test('尝试超限与已核销给出可区分的提示', () => {
  const generic = rejectionMessage('code_unknown');
  assert.notEqual(rejectionMessage('too_many_attempts'), generic);
  assert.notEqual(rejectionMessage('code_consumed'), generic);
  assert.notEqual(rejectionMessage('too_many_attempts'), rejectionMessage('code_consumed'));
});

test('拒绝文案不回显验证码内容', () => {
  for (const r of ['code_unknown', 'code_expired', 'code_consumed', 'too_many_attempts'] as const) {
    assert.ok(!/[A-Z0-9]{12}/.test(rejectionMessage(r)));
  }
});
