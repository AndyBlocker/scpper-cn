import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPrewarmResponse, shouldFailPrewarm } from './prewarm-preview-result.mjs';

function response({ status = 200, type = 'image/png', source } = {}) {
  const headers = new Headers({ 'Content-Type': type });
  if (source !== undefined) headers.set('X-Avatar-Source', source);
  return new Response(null, { status, headers });
}

test('头像本地缓存和陈旧缓存成功，不要求 CSS 磁盘条目', () => {
  for (const source of ['local', 'stale']) {
    assert.equal(classifyPrewarmResponse(response({ source })), 'avatar-warmed');
    assert.equal(classifyPrewarmResponse(response({ source, type: 'IMAGE/PNG; charset=binary' })), 'avatar-warmed');
  }
});

test('默认头像是独立兜底，不宣称原图已缓存', () => {
  assert.equal(classifyPrewarmResponse(response({ source: 'default' })), 'avatar-fallback');
  assert.equal(classifyPrewarmResponse(response({ source: 'default' }), { diskCached: true }), 'avatar-fallback');
});

test('4xx/5xx 即使带头像缓存 header 或旧磁盘条目也失败', () => {
  for (const status of [400, 403, 404, 429, 500, 502, 503, 504]) {
    assert.equal(classifyPrewarmResponse(response({ status, source: 'local' }), { diskCached: true }), 'failed');
  }
});

test('200 CSS 软失败和伪头像 header 不能冒充头像预热成功', () => {
  for (const source of [undefined, 'local', 'stale', 'default']) {
    const softFailure = new Response('/* css-proxy error: Proxy fetch failed */', {
      headers: { 'Content-Type': 'text/css; charset=utf-8', ...(source ? { 'X-Avatar-Source': source } : {}) },
    });
    assert.equal(classifyPrewarmResponse(softFailure), 'failed');
    assert.equal(classifyPrewarmResponse(softFailure, { diskCached: true }), 'warmed');
    assert.equal(classifyPrewarmResponse(softFailure, { diskCached: true, wasCached: true }), 'hit');
  }
});

test('缺失、混合和未知头像来源值不会被当作缓存成功', () => {
  for (const source of [undefined, '', 'LOCAL', 'meta', 'remote', 'local, stale', 'local; default', 'localx', '__proto__', '<script>']) {
    assert.equal(classifyPrewarmResponse(response({ source })), 'failed');
  }
});

test('伪造 image 前缀、无类型和 HTML/JSON 响应不算头像缓存成功', () => {
  for (const type of ['', 'image/*', 'image/', 'image/png garbage', 'image/png<script>', 'imageevil/png', 'text/html', 'application/json']) {
    assert.equal(classifyPrewarmResponse(response({ source: 'local', type })), 'failed');
  }
});

test('普通图片与字体仍使用真实磁盘缓存判定新抓和命中', () => {
  for (const type of ['image/png', 'font/woff2']) {
    assert.equal(classifyPrewarmResponse(response({ type })), 'failed');
    assert.equal(classifyPrewarmResponse(response({ type }), { diskCached: true }), 'warmed');
    assert.equal(classifyPrewarmResponse(response({ type }), { diskCached: true, wasCached: true }), 'hit');
  }
});

test('只有头像缓存成功且有其他失败时，不再错误退出', () => {
  assert.equal(shouldFailPrewarm({ avatarWarmed: 1, failed: 2 }), false);
  assert.equal(shouldFailPrewarm({ warmed: 1, failed: 2 }), false);
  assert.equal(shouldFailPrewarm({ avatarWarmed: 1, avatarFallback: 2 }), false);
});

test('只有失败或默认头像兜底时明确失败，全缓存命中保持原有成功行为', () => {
  assert.equal(shouldFailPrewarm({ failed: 1 }), true);
  assert.equal(shouldFailPrewarm({ avatarFallback: 1 }), true);
  assert.equal(shouldFailPrewarm({ failed: 1, avatarFallback: 1 }), true);
  assert.equal(shouldFailPrewarm({}), false);
});
