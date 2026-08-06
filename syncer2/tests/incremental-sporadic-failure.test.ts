/**
 * L1 走的**增量**路径也必须把零星批失败判 partial。
 *
 * 教训：同一判据此前只加在全站扫描路径（listpages.ts）上，并配了 7 个测试用例——
 * 但那些用例全部针对全站路径的常量，**没有一个验证 L1 的真实调用链**。
 * 于是 tests 全绿而生产每 5 分钟挂一次：验证了逻辑，没验证逻辑被用到。
 *
 * 这里断言两条路径共用同一组常量，且增量路径确实引用了它们。
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  LISTPAGES_SPORADIC_FAILED_BATCHES,
  LISTPAGES_SPORADIC_FAILED_BATCH_RATIO,
} from '../src/collect/listpages.js';

describe('增量路径的零星批失败判据', () => {
  it('增量扫描必须引用与全站扫描相同的常量，而不是各自硬编码', async () => {
    const src = await readFile(
      new URL('../src/collect/incrementalListPages.ts', import.meta.url),
      'utf8',
    );
    assert.match(src, /LISTPAGES_SPORADIC_FAILED_BATCHES/);
    assert.match(src, /LISTPAGES_SPORADIC_FAILED_BATCH_RATIO/);
    // 硬判据必须走 sporadic 分支，不能再无条件把批失败推进 hardReasons
    assert.match(src, /sporadicBatchFailure/);
    assert.doesNotMatch(
      src,
      /if \(batchesFailed > 0\) hardReasons\.push/,
      '批失败不得无条件升级为 hard——那正是 L1 每 5 分钟挂一次的原因',
    );
  });

  it('生产实测形态：146 批中 1 批失败必须落在零星区间内', () => {
    const failed = 1;
    const expected = 146;
    assert.ok(failed <= LISTPAGES_SPORADIC_FAILED_BATCHES);
    assert.ok(failed / expected <= LISTPAGES_SPORADIC_FAILED_BATCH_RATIO);
  });

  it('大比例失败仍必须是 hard——抓不到大半个站不能安静退出', () => {
    const failed = 40;
    const expected = 146;
    assert.ok(
      failed > LISTPAGES_SPORADIC_FAILED_BATCHES
        || failed / expected > LISTPAGES_SPORADIC_FAILED_BATCH_RATIO,
    );
  });

  it('expectedBatches 未知时不得放行——无法判断占比就按最坏处理', async () => {
    const src = await readFile(
      new URL('../src/collect/incrementalListPages.ts', import.meta.url),
      'utf8',
    );
    assert.match(src, /expectedBatches === null\s*\n?\s*\?\s*false/);
  });
});
