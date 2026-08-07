/**
 * 全站署名表的零星坏行必须跳过，而不是让整表长期挂起。
 *
 * 事故：3,262 行里 2 行社区手工录入时少填了列，原实现即整体判 partial，
 * 理由「禁止全量 removal」——但 applyNewAttributionEntriesBySlug 只处理新增、
 * 从不删除，那个担心在当前实现下不会发生。代价是任务每 24 小时重来、
 * 永远 partial，全站新增署名 212 小时未更新。
 *
 * 与「一个矛盾身份劫持整页 3,245 票」同型：局部脏数据阻断全局处理。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ATTRIBUTION_REJECT_ABSOLUTE_LIMIT,
  ATTRIBUTION_REJECT_RATIO_LIMIT,
} from '../src/collect/conventions.js';

/** 与 conventions.ts 判定同构，用于锁住阈值语义。 */
function systemic(rejected: number, total: number): boolean {
  const ratio = total > 0 ? rejected / total : 0;
  return rejected > ATTRIBUTION_REJECT_ABSOLUTE_LIMIT || ratio > ATTRIBUTION_REJECT_RATIO_LIMIT;
}

describe('署名表坏行处理', () => {
  it('生产实测形态：3,262 行里 2 行坏 ⇒ 跳过、不挂起', () => {
    assert.equal(systemic(2, 3262), false);
  });

  it('解析器真的失效（大比例坏行）⇒ 仍须升级，别把保护拆了', () => {
    assert.equal(systemic(1000, 3262), true);
  });

  it('绝对条数超限即升级，即使占比很低', () => {
    assert.equal(systemic(ATTRIBUTION_REJECT_ABSOLUTE_LIMIT + 1, 1_000_000), true);
  });

  it('占比超限即升级，即使条数很少', () => {
    // 5/100 = 5% 远超 1%，属小表上的系统性失败
    assert.equal(systemic(5, 100), true);
  });

  it('零坏行不触发任何升级', () => {
    assert.equal(systemic(0, 3262), false);
  });

  it('阈值是有意的少数派，不能被放宽成「几乎不可能触发」', () => {
    assert.ok(ATTRIBUTION_REJECT_RATIO_LIMIT > 0 && ATTRIBUTION_REJECT_RATIO_LIMIT <= 0.05);
    assert.ok(ATTRIBUTION_REJECT_ABSOLUTE_LIMIT >= 1 && ATTRIBUTION_REJECT_ABSOLUTE_LIMIT <= 100);
  });
});
