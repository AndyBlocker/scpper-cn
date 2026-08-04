/**
 * 零星批失败必须判 partial，大比例失败仍必须 failed。
 *
 * partial 本就不持久化、不推进增量状态、不入队、不算覆盖率，缺失推断拿不到这一轮，
 * 因此改判在数据上零风险；但比例一高就是系统性故障，安静退出才是最危险的形态。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LISTPAGES_SPORADIC_FAILED_BATCHES,
  LISTPAGES_SPORADIC_FAILED_BATCH_RATIO,
} from '../src/collect/listpages.js';

/** 与 listpages.ts 判定同构的纯函数，用于锁住阈值语义。 */
function isSporadic(actualFailed: number, expectedBatches: number | null): boolean {
  const ratio =
    expectedBatches !== null && expectedBatches > 0
      ? actualFailed / expectedBatches
      : actualFailed > 0
        ? 1
        : 0;
  return (
    actualFailed > 0
    && actualFailed <= LISTPAGES_SPORADIC_FAILED_BATCHES
    && ratio <= LISTPAGES_SPORADIC_FAILED_BATCH_RATIO
  );
}

describe('ListPages 零星批失败', () => {
  it('全站 145 批里 1 批失败 = 偶发（这正是 http_503 造成的那一类）', () => {
    assert.equal(isSporadic(1, 145), true);
  });

  it('145 批里 3 批失败仍在阈值内（3/145 ≈ 2.1%）', () => {
    assert.equal(isSporadic(3, 145), true);
  });

  it('绝对条数超限即不算偶发，即使占比很低', () => {
    // 4 批 / 1000 批 = 0.4%，占比达标但绝对条数超限。
    assert.equal(isSporadic(4, 1000), false);
  });

  it('占比超限即不算偶发，即使只有 1 批', () => {
    // L0 只有 1--3 批：1/1 = 100%，绝对条数达标但占比爆表。
    assert.equal(isSporadic(1, 1), false);
    assert.equal(isSporadic(1, 2), false);
  });

  it('抓不到大半个站必须仍是系统性失败', () => {
    assert.equal(isSporadic(100, 145), false);
  });

  it('零失败不触发偶发分支（该走 ok/partial 的其它判据）', () => {
    assert.equal(isSporadic(0, 145), false);
  });

  it('expectedBatches 未知时按最坏情况处理，不放行', () => {
    assert.equal(isSporadic(1, null), false);
  });
});
