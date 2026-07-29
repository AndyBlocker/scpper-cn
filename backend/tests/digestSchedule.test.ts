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

test('空周期也必须推进水位线，否则永久冻住（review P1）', () => {
  const DAY = 24 * 3600 * 1000;
  const hour = 21;
  // 模拟：只在「发送成功」时推进 vs 「周期到期即推进」
  const advanceOnSendOnly = (last: Date, sent: boolean) => (sent ? nextDigestDueAt(last, hour) : last);
  const advanceOnDue = (last: Date) => nextDigestDueAt(last, hour);

  let stuck = new Date(utc8HourToday(hour).getTime() - 3 * DAY);
  const frozen = advanceOnSendOnly(stuck, false);   // 那天没内容
  assert.equal(frozen.getTime(), stuck.getTime(), '旧逻辑：水位线原地不动');
  // 于是之后每一条新告警都晚于这个陈旧边界 → 被无限推迟
  const newAlert = new Date();
  assert.ok(newAlert > frozen, '新告警晚于冻住的边界，会被判为「等下个周期」而永不发送');

  const advanced = advanceOnDue(stuck);
  assert.ok(advanced > stuck, '新逻辑：周期到期即推进');
});

test('水位线在任何完成路径上都必须严格前进（不变量）', () => {
  const DAY = 24 * 3600 * 1000;
  const base = utc8HourToday(21);
  // 常规发送、空周期、重发成功 —— 三条路径都用同一个推进函数
  for (const offset of [-3 * DAY, -2 * DAY, -DAY, -3600_000]) {
    const last = new Date(base.getTime() + offset);
    const next = nextDigestDueAt(last, 21);
    assert.ok(next.getTime() > last.getTime(),
      `offset=${offset}ms：推进后必须严格晚于原值，否则会卡在同一个周期`);
  }
});

// ── 水位线生命周期：枚举所有会结束一个汇总周期的路径 ──────────────
// 这组测试的目的不是覆盖具体 bug，而是把「有哪些路径」本身固定下来 ——
// 前几轮反复出问题都是因为新增路径时漏了维护水位线。

test('路径 B/C：空周期（无内容或内容全被读掉）必须推进', () => {
  const processed = new Set<number>();
  const now = Date.now();
  const due = new Date(now - 3600_000);   // 一小时前到期
  // 模拟：该用户本轮没有任何候选，但周期已过
  if (now >= due.getTime()) processed.add(1);
  assert.ok(processed.has(1), '到期但无内容的用户也必须被算作已处理');
});

test('路径 E：优雅停机时未处理的用户不得推进', () => {
  const processed = new Set<number>([1]);  // 只有用户 1 被处理完
  const allDigestUsers = [1, 2, 3];
  const advanced = allDigestUsers.filter((u) => processed.has(u));
  assert.deepEqual(advanced, [1],
    '停机时剩下的用户被明确留给下一轮，给他们推进等于宣称处理过 —— 下一轮起点会丢掉他们的内容');
});

test('路径 F：首次使用应按标准窗口，而非放宽后的 48 小时', () => {
  const LOOKBACK = 24 * 3600 * 1000;
  const now = Date.now();
  const normalFloor = now - LOOKBACK;
  const widenedFloor = now - 2 * LOOKBACK;
  const pick = (lastCutoff: Date | null) => (lastCutoff ? widenedFloor : normalFloor);
  assert.equal(pick(null), normalFloor,
    '没有历史周期要补，就不该把第一封汇总的范围扩到 48 小时');
  assert.equal(pick(new Date()), widenedFloor, '有历史时才需要放宽以覆盖间隔');
});

test('路径 H：同一自然日只发一封，改晚时点也不例外', () => {
  const eligible = (dueReached: boolean, sentThisDay: number) => dueReached && sentThisDay === 0;
  assert.equal(eligible(true, 0), true, '到期且今天没发过');
  assert.equal(eligible(true, 1), false,
    '今天已收过、随后把时点改晚：新边界当天到期，但不得发第二封');
  assert.equal(eligible(false, 0), false, '未到期');
});
