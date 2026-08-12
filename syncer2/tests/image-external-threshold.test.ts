/**
 * 站外图床的失败率阈值必须独立于 wikidot 主站。
 *
 * 事故：image-ingest 每轮判 failed，失败率 25.5%——而统一阈值正好是 25%。
 * 实测失败构成：http_transient 456、network 31（均可重试瞬时错误），
 * 确定性的 invalid_content_type 68 / blocked_host 7 / http_permanent 6 已另计。
 * 站外图床（wdfiles 等）防盗链、限流、死链造成 25% 瞬时失败是常态而非故障。
 *
 * 用 wikidot 的标准衡量另一个站点，等于把「A 站健康线」当成「所有出站的健康线」。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateRunHealth, RUN_FAILURE_RATE_THRESHOLD } from '../src/work/runHealth.js';
import { EXTERNAL_IMAGE_FAILURE_RATE_THRESHOLD } from '../src/image/health.js';

const run = (failed: number, processed: number, threshold?: number) =>
  evaluateRunHealth({
    claimed: processed,
    processed,
    partial: 0,
    failed,
    ...(threshold === undefined ? {} : { failureRateThreshold: threshold }),
  });

describe('站外图片失败率阈值', () => {
  it('生产实测形态：25.5% 站外失败，用站外阈值不判 failed', () => {
    const r = run(56, 220, EXTERNAL_IMAGE_FAILURE_RATE_THRESHOLD);
    assert.equal(r.exitCode, 0);
  });

  it('同样的数字用统一阈值会判 failed——这正是此前每轮失败的原因', () => {
    const r = run(56, 220);
    assert.equal(r.exitCode, 1);
  });

  it('站外阈值必须显著高于主站阈值，但不能高到失去意义', () => {
    assert.ok(EXTERNAL_IMAGE_FAILURE_RATE_THRESHOLD > RUN_FAILURE_RATE_THRESHOLD);
    assert.ok(EXTERNAL_IMAGE_FAILURE_RATE_THRESHOLD <= 0.8);
  });

  it('站外真的大面积失败时仍必须报——别把保护拆了', () => {
    const r = run(200, 220, EXTERNAL_IMAGE_FAILURE_RATE_THRESHOLD);
    assert.equal(r.exitCode, 1);
  });

  it('wikidot 主站不放宽：省略阈值即用统一标准', () => {
    assert.equal(run(56, 220).exitCode, 1);
    assert.equal(run(10, 220).exitCode, 0);
  });
});
