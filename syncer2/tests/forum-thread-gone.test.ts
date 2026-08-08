/**
 * 讨论串已在站上删除是**确定性结论**，不是故障。
 *
 * 此前 ForumViewThreadModule 返回 no_thread 一律判 failed，于是每轮 forum-consume
 * 都被同一个已删串打成非零退出（实测连续复发）。
 *
 * 这是同一模式的第五次：slug 复用杀整轮、矛盾身份劫持整页 3,245 票、
 * 1/146 批失败杀整轮 L1、2/3262 坏行阻断全站署名 212 小时，现在是已删讨论串。
 * 五次的保守判断都没错，错在**没有终态出口**。
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isThreadGoneStatus } from '../src/collect/forum.js';

describe('已删讨论串的终态判定', () => {
  it('no_thread 是确定性「不存在」，实测消息为「您尝试显示的讨论串似乎已被删除」', () => {
    assert.equal(isThreadGoneStatus('no_thread'), true);
  });

  it('invalid_thread 同样不该重试', () => {
    assert.equal(isThreadGoneStatus('invalid_thread'), true);
  });

  it('ok 不属于 gone', () => {
    assert.equal(isThreadGoneStatus('ok'), false);
  });

  it('瞬时/未知失败不得被误判为 gone——否则真故障会被当成删除', () => {
    for (const s of ['not_ok', 'no_permission', 'try_again', 'error', '']) {
      assert.equal(isThreadGoneStatus(s), false, s);
    }
  });
});
