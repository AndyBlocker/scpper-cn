import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expectedUserIdForRequest,
  isExpectedUserPrivateReadPath,
  normalizeBffRequestPath,
  registerExpectedUserMismatchRecovery,
  requestExpectedUserMismatchRecovery
} from '../utils/expectedUser.ts';

const trustedAccountA = {
  authStatus: 'authenticated',
  authUserId: 'account-a',
  bffBase: '/api'
};

test('keeps account A on private reads while cookie propagation is independently delayed', () => {
  // localStorage may be unavailable and the browser cookie may already belong
  // to B. The frontend cannot read that HttpOnly cookie; it must send its last
  // trusted snapshot A so the BFF can compare A with the real cookie identity.
  for (const request of [
    '/collections',
    '/collections/42?include=items',
    '/follows',
    '/alerts/preferences',
    '/qq-binding/status',
    '/wikidot-binding/status',
    '/wikidot-binding/resolve?q=user',
    '/ftml-projects',
    '/gacha/wallet',
    '/gacha/admin/economy',
    '/admin/accounts'
  ]) {
    assert.equal(expectedUserIdForRequest({
      ...trustedAccountA,
      method: 'GET',
      request
    }), 'account-a', request);
  }
});

test('explicitly exempts the auth source of truth and public reads', () => {
  for (const request of [
    '/auth/me',
    '/collections/public/user/42',
    '/collections/public/user/42/favourites',
    '/pages/123',
    '/events'
  ]) {
    assert.equal(expectedUserIdForRequest({
      ...trustedAccountA,
      method: 'GET',
      request
    }), null, request);
  }
});

test('normalizes base-prefixed and absolute BFF URLs before classification', () => {
  assert.equal(normalizeBffRequestPath('/api/alerts?limit=10', '/api'), '/alerts');
  assert.equal(
    normalizeBffRequestPath('https://scpper.cn/api/collections/9', 'https://scpper.cn/api'),
    '/collections/9'
  );
  assert.equal(isExpectedUserPrivateReadPath('/collections/public/user/9'), false);
});

test('preserves anonymous requests, OPTIONS, and the existing mutation header', () => {
  assert.equal(expectedUserIdForRequest({
    ...trustedAccountA,
    authStatus: 'anonymous',
    method: 'GET',
    request: '/collections'
  }), null);
  assert.equal(expectedUserIdForRequest({
    ...trustedAccountA,
    method: 'OPTIONS',
    request: '/collections'
  }), null);
  assert.equal(expectedUserIdForRequest({
    ...trustedAccountA,
    method: 'POST',
    request: '/collections'
  }), 'account-a');
});

test('deduplicates mismatch recovery and permits a later recovery', async () => {
  const app = {};
  let calls = 0;
  let release;
  registerExpectedUserMismatchRecovery(app, () => {
    calls += 1;
    return new Promise(resolve => {
      release = resolve;
    });
  });

  const first = requestExpectedUserMismatchRecovery(app);
  const duplicate = requestExpectedUserMismatchRecovery(app);
  assert.equal(first, duplicate);
  assert.equal(calls, 1);

  release();
  await first;

  registerExpectedUserMismatchRecovery(app, () => {
    calls += 1;
  });
  await requestExpectedUserMismatchRecovery(app);
  assert.equal(calls, 2);
});
