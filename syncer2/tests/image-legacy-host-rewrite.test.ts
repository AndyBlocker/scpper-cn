/**
 * 旧域名图片主机改写。
 *
 * 这些 URL 的失败一度被误判为「主机不可达」并终态化，实测是 TLS 主机名不匹配：
 * 目标 IP 的 443/80 都能连，服务端为 scp-wiki.net 出示 *.wikidot.com 证书。
 * 换出口 IP 无效（7890 固定 2 次 + 7891 轮换池 5 次，全部相同失败）。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_IMAGE_HOST_REWRITES,
  rewriteLegacyImageHost,
} from '../src/image/legacyHosts.js';

test('旧域名的 local--files 改写到其文件主机，并升到 https', () => {
  const a = rewriteLegacyImageHost(
    'https://ja.scp-wiki.net/local--files/scp-185-ko-stairdown/tunnel-841434_1280.jpg',
  );
  assert.equal(
    a.url,
    'https://scp-jp.wdfiles.com/local--files/scp-185-ko-stairdown/tunnel-841434_1280.jpg',
  );
  assert.equal(a.rewrittenFrom, 'ja.scp-wiki.net');

  // http 入参同样升到 https：目标文件主机证书有效，不需要放宽校验。
  const b = rewriteLegacyImageHost('http://www.scp-wiki.net/local--files/come-back-kid/x.png');
  assert.equal(b.url, 'https://scp-wiki.wdfiles.com/local--files/come-back-kid/x.png');
});

test('非 local--files 路径不改写——站点根路径的跳转目标不是 wdfiles', () => {
  const r = rewriteLegacyImageHost('https://www.scp-wiki.net/scp-173');
  assert.equal(r.rewrittenFrom, null);
  assert.equal(r.url, 'https://www.scp-wiki.net/scp-173');
});

test('未登记的主机原样返回，不做臆测改写', () => {
  for (const url of [
    'https://scp-wiki.wdfiles.com/local--files/a/b.png',
    'https://www.scpwiki.com/local--files/a/b.png',
    'https://example.com/local--files/a/b.png',
  ]) {
    const r = rewriteLegacyImageHost(url);
    assert.equal(r.rewrittenFrom, null, `${url} 不应被改写`);
    assert.equal(r.url, url);
  }
});

test('非法 URL 不抛异常，原样返回', () => {
  const r = rewriteLegacyImageHost('not a url');
  assert.equal(r.rewrittenFrom, null);
  assert.equal(r.url, 'not a url');
});

test('改写表只含已实测确认跳转关系的主机', () => {
  // 每一条都对应站点自身可观测的 301/302，不是猜测。
  assert.deepEqual(
    [...LEGACY_IMAGE_HOST_REWRITES.entries()].sort(),
    [
      ['ja.scp-wiki.net', 'scp-jp.wdfiles.com'],
      ['scp-wiki.net', 'scp-wiki.wdfiles.com'],
      ['www.scp-wiki.net', 'scp-wiki.wdfiles.com'],
    ],
  );
});
