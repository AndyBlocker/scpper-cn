/**
 * 站外图床「主机不存在」是确定性失败，不该无限重试。
 *
 * 实测一轮：network 25 / timeout 4，逐主机看每个只失败 1-2 次——
 * acsurlexample.com 直连 HTTP 000（DNS 都解析不了，那是文章里的示例占位 URL）、
 * a3.att.hudong.com、article.fd.zol-img.com.cn、68.media.tumblr.com
 * 都是多年前的第三方图床。不是有人限流我们，是站点本身已不存在。
 *
 * 同一个「连接失败」在主站与站外含义不同：wikidot 连不上通常是瞬时的，
 * 而 acsurlexample.com 这种域名不会某天突然复活。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isDeterministicImageFailure } from '../src/image/health.js';

describe('主机不可解析的定性', () => {
  it('host_unresolvable 属确定性，与 http_permanent 同级', () => {
    assert.equal(isDeterministicImageFailure('host_unresolvable'), true);
    assert.equal(isDeterministicImageFailure('http_permanent'), true);
  });

  it('超时与连接重置仍可重试——它们可能是真瞬时的', () => {
    assert.equal(isDeterministicImageFailure('timeout'), false);
    assert.equal(isDeterministicImageFailure('network'), false);
  });

  it('限流信号必须仍算压力，否则退让机制失去输入', () => {
    assert.equal(isDeterministicImageFailure('http_transient'), false);
  });
});
