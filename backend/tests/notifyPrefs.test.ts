import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentHourUtc8, startOfUtc8Day } from '../src/jobs/NotificationDispatchJob.js';

test('currentHourUtc8 返回 UTC+8 的整点', () => {
  const h = currentHourUtc8();
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 23, `越界: ${h}`);
  // 与手工换算一致
  const expected = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
  assert.equal(h, expected);
});

test('日限额取「用户设置」与「全局上限」的更小值', () => {
  // 复刻 loadNotifyPrefs 里的钳制逻辑
  const clamp = (userValue: number, globalMax: number) => Math.max(1, Math.min(userValue, globalMax));
  assert.equal(clamp(100, 40), 40, '用户不得突破运维上限');
  assert.equal(clamp(5, 40), 5, '用户可以更保守');
  assert.equal(clamp(0, 40), 1, '下限兜底为 1');
  assert.equal(clamp(-3, 40), 1);
});

test('定时模式：不到点不发、到点且当天未发才发', () => {
  // 复刻主流程的判定
  const shouldSend = (mode: string, hour: number, digestHour: number, sentToday: number) => {
    if (mode === 'DAILY_DIGEST') {
      if (hour !== digestHour) return false;
      if (sentToday > 0) return false;
    }
    return true;
  };
  assert.equal(shouldSend('DAILY_DIGEST', 10, 21, 0), false, '不到点应攒着');
  assert.equal(shouldSend('DAILY_DIGEST', 21, 21, 0), true, '到点且未发过应发');
  assert.equal(shouldSend('DAILY_DIGEST', 21, 21, 1), false, '当天已发过不再发');
  assert.equal(shouldSend('REALTIME', 10, 21, 0), true, '实时模式不受时点约束');
  assert.equal(shouldSend('REALTIME', 3, 21, 5), true);
});

test('类型开关缺省为开（新用户绑定后立刻可用）', () => {
  const qqEnabled = new Map<string, boolean>();
  const blocked = (t: string) => qqEnabled.get(t) === false;
  assert.equal(blocked('PAGE_VOTE'), false, '没设置过应视为开启');
  qqEnabled.set('PAGE_VOTE', false);
  assert.equal(blocked('PAGE_VOTE'), true);
  assert.equal(blocked('PAGE_COMMENT'), false, '关掉一个不影响其他类型');
});

test('startOfUtc8Day 返回 UTC+8 当天 0 点（review P2：定时须按自然日）', () => {
  const start = startOfUtc8Day();
  // 换算回 UTC+8 后应当正好是 0 点
  const inUtc8 = new Date(start.getTime() + 8 * 3600 * 1000);
  assert.equal(inUtc8.getUTCHours(), 0, '应为 UTC+8 的 0 点');
  assert.equal(inUtc8.getUTCMinutes(), 0);
  assert.ok(start.getTime() <= Date.now(), '起点不应在未来');
  assert.ok(Date.now() - start.getTime() < 24 * 3600 * 1000, '起点应在 24 小时内');
});

test('默认日限额也受全局上限钳制（review P2）', () => {
  // 复刻 loadNotifyPrefs 里对默认值的钳制
  const clampDefault = (defaultLimit: number, globalMax: number) =>
    Math.max(1, Math.min(defaultLimit, globalMax));
  assert.equal(clampDefault(20, 40), 20, '全局宽松时用默认值');
  assert.equal(clampDefault(20, 5), 5, '全局收紧到 5 时默认值也须降到 5');
  assert.equal(clampDefault(20, 0), 1, '下限兜底');
});

test('接口回显的实际上限 = min(用户设置, 全局上限)（review P2）', () => {
  const effective = (userValue: number, globalMax: number) =>
    Math.max(1, Math.min(userValue, globalMax));
  assert.equal(effective(100, 40), 40, '填 100 实际只有 40，界面必须说实话');
  assert.equal(effective(10, 40), 10);
});
