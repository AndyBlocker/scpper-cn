/**
 * 确定性图片失败不该驱动链路压力判定。
 *
 * 实测链路：降速 + 自适应退让生效后 http_transient 从 836 归零，
 * 剩下主体变成 http_permanent 50——手工验证
 * https://i.loli.net/2020/11/26/… 返回 HTTP 404，是 2020 年的免费图床
 * 链接早已失效。SCP 页面引用外部图床失效是常态。
 *
 * 若把它计入失败率，链路会永远判 failed，反而掩盖真正的限流信号
 * （429/503）。与 EGRESS 那轮「确定性失败不计入压力分子」一致。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  emptyImageRouteCounters,
  isImageFailureExcludedFromHealth,
} from '../src/image/health.js';

describe('确定性图片失败分类', () => {
  it('死链/非图片/被封主机都是确定性的', () => {
    for (const c of ['http_permanent', 'invalid_content_type', 'blocked_host']) {
      assert.equal(isImageFailureExcludedFromHealth(c), true, c);
    }
  });

  it('限流与瞬时错误必须仍算压力——它们正是要驱动退让的信号', () => {
    for (const c of ['http_transient', 'network', 'timeout', 'unknown', null, undefined]) {
      assert.equal(isImageFailureExcludedFromHealth(c), false, String(c));
    }
  });

  it('计数器带 healthExcluded 字段且初值为 0', () => {
    const c = emptyImageRouteCounters();
    assert.equal(c.healthExcluded, 0);
    assert.deepEqual(
      Object.keys(c).sort(),
      ['claimed', 'completed', 'failed', 'healthExcluded', 'retry'],
    );
  });
});
