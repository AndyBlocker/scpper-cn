import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDigestDueAt, utc8HourToday } from '../src/jobs/NotificationDispatchJob.js';

const DAY = 24 * 3600 * 1000;
const hoursFrom = (base: Date, h: number) => new Date(base.getTime() + h * 3600 * 1000);

test('从未发过时，到期时刻是今天的设定整点', () => {
  const due = nextDigestDueAt(null, 21);
  assert.equal(due.getTime(), utc8HourToday(21).getTime());
});

test('正常节奏：上次是昨天该点，下次就是今天该点', () => {
  const today21 = utc8HourToday(21);
  const yesterday21 = new Date(today21.getTime() - DAY);
  assert.equal(nextDigestDueAt(yesterday21, 21).getTime(), today21.getTime(),
    '相邻两天的边界应当刚好差一天');
});

test('跨午夜宕机：逾期的汇总应立刻补上，而不是等到明天（review P1）', () => {
  // 周二 21:00 那封没发出去；现在是周三凌晨
  const today21 = utc8HourToday(21);
  const twoDaysAgo21 = new Date(today21.getTime() - 2 * DAY);
  const due = nextDigestDueAt(twoDaysAgo21, 21);
  // 到期时刻应是「上次之后的第一个边界」= 昨天 21:00，早已过去 → 立刻可发
  assert.equal(due.getTime(), new Date(today21.getTime() - DAY).getTime(),
    '应回到逾期的那个边界，而不是跳到今天/明天');
  assert.ok(due.getTime() < Date.now(), '既然逾期，现在就该发');
});

test('刚发过就不再重复：到期时刻顺延到下一天', () => {
  const today21 = utc8HourToday(21);
  const due = nextDigestDueAt(today21, 21);
  assert.equal(due.getTime(), today21.getTime() + DAY, '今天已发过则顺延');
  assert.ok(due.getTime() > Date.now() || today21.getTime() > Date.now(),
    '顺延后不应立刻再次到期');
});

test('改时点后仍以「上次截止线之后的第一个新边界」为准', () => {
  // 上次按 10 点发过，随后改成 21 点
  const today10 = utc8HourToday(10);
  const due = nextDigestDueAt(today10, 21);
  assert.equal(due.getTime(), utc8HourToday(21).getTime(),
    '同一天内改晚时点，当天 21 点就是下一个边界 —— 不必等到明天');
  assert.ok(due.getTime() > today10.getTime(), '新边界必须晚于上次截止线');
});

test('任意上次时刻都能得到严格晚于它的到期时刻（不变量）', () => {
  const base = utc8HourToday(21);
  for (const offset of [-73, -49, -25, -24, -23, -1, -0.5]) {
    const last = hoursFrom(base, offset);
    const due = nextDigestDueAt(last, 21);
    assert.ok(due.getTime() > last.getTime(),
      `offset=${offset}h 时到期时刻必须晚于上次截止线，否则会重复发送`);
  }
});
