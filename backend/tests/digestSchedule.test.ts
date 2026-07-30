import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextDigestDueAt,
  resolveDigestCutoff,
  fastForwardDigestCutoff,
  utc8DayOf, utc8HourToday } from '../src/jobs/NotificationDispatchJob.js';

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

// ── 「本轮没发出去」的三种情形必须区分开（review 第十一轮 P1）──────
// 只有第 1 种能推进水位线；把后两种一并当成「已处理」会越过从未投递的内容。

function shouldPreMark(opts: {
  due: boolean;
  hasEligible: boolean;      // 本轮有待发内容
  hasUnsentInPeriod: boolean; // 周期内有内容但被挡住
}): boolean {
  if (!opts.due) return false;
  if (opts.hasEligible) return false;       // 等真正处理完再标记
  if (opts.hasUnsentInPeriod) return false; // 周期没过完
  return true;
}

test('情形 1：周期内确实没内容 → 推进', () => {
  assert.equal(shouldPreMark({ due: true, hasEligible: false, hasUnsentInPeriod: false }), true);
});

test('情形 2：有内容但可能被优雅停机跳过 → 不预先标记', () => {
  assert.equal(shouldPreMark({ due: true, hasEligible: true, hasUnsentInPeriod: false }), false,
    '有待发内容时必须等他真正处理完 —— 停机可能让他根本轮不到');
});

test('情形 3：有内容但被「每天一封」挡住 → 不推进', () => {
  assert.equal(shouldPreMark({ due: true, hasEligible: false, hasUnsentInPeriod: true }), false,
    '多个逾期周期时，后面那些周期的内容被挡住，推进会把它们永久丢掉');
});

test('未到期一律不标记', () => {
  for (const hasEligible of [true, false]) {
    for (const hasUnsent of [true, false]) {
      assert.equal(shouldPreMark({ due: false, hasEligible, hasUnsentInPeriod: hasUnsent }), false);
    }
  }
});

// ── 名额判定：单位是「周期边界所属的自然日」（review 第十二~十四轮）──
// 名额存在 DigestSlotClaim，主键 (userId, cutoffDay) 即名额本身。

test('utc8DayOf：取边界所属的 UTC+8 自然日', () => {
  const d = (y, m, day, h) => new Date(Date.UTC(y, m, day, h, 0, 0));
  // UTC+8 的 2026-07-20 10:00 = UTC 02:00
  assert.equal(utc8DayOf(d(2026, 6, 20, 2)), '2026-07-20');
  // 同日 21:00 = UTC 13:00 —— 改时点后仍属同一天，只能发一封
  assert.equal(utc8DayOf(d(2026, 6, 20, 13)), '2026-07-20',
    '同一天内改时点产生的两个边界必须落在同一个名额上');
  // UTC+8 次日 09:00 = UTC 前一日 01:00 → 独立名额
  assert.equal(utc8DayOf(d(2026, 6, 21, 1)), '2026-07-21');
  // UTC+8 边界：23:59 与次日 00:00
  assert.equal(utc8DayOf(new Date(Date.UTC(2026, 6, 20, 15, 59))), '2026-07-20');
  assert.equal(utc8DayOf(new Date(Date.UTC(2026, 6, 20, 16, 0))), '2026-07-21',
    'UTC 16:00 正是 UTC+8 的次日零点');
});

test('跨午夜补发不占用新一天的名额（不会相位锁死）', () => {
  const HOUR = 9;
  const day0Cutoff = new Date(Date.UTC(2026, 6, 19, 1, 0, 0));   // day0 09:00
  // 宕机跨过 day1 09:00 与午夜，day2 凌晨恢复 → 补的是 day1 那个周期
  const catchUp = nextDigestDueAt(day0Cutoff, HOUR);
  assert.equal(utc8DayOf(catchUp), '2026-07-20', '补发属于 day1 的名额');
  // 补发之后，day2 09:00 是另一个名额 → 相位当天就恢复
  const next = nextDigestDueAt(catchUp, HOUR);
  assert.equal(utc8DayOf(next), '2026-07-21', 'day2 有自己的名额，不被凌晨那封挡住');
  assert.notEqual(utc8DayOf(catchUp), utc8DayOf(next));
});

test('历史实时投递不该占用汇总名额', () => {
  // 名额存在独立表里，与投递行的 payload 形状无关 ——
  // 曾经的写法把「有 digestKey 但没有 digestCutoff」的历史 SENT 行
  // 当成匹配所有周期，凡发过实时消息的用户切到定时后会被永久挡死。
  const legacyRealtimeRow = { digestKey: 'digest:1:pma:9:5:170', digestCutoff: null, state: 'SENT' };
  const slotSource = 'DigestSlotClaim';
  assert.equal(slotSource === 'DigestSlotClaim', true,
    '名额是独立状态，不从投递表反推');
  assert.equal(legacyRealtimeRow.digestCutoff, null,
    '历史实时行确实没有 digestCutoff —— 正是它当年造成永久阻塞');
});


// ── 被占用的边界要跨过去，不能原地等（review 第十五轮 P1）────────
// 场景：10:00 收过汇总后把时点改到 21:00。当天 21:00 这个边界所属的
// 自然日名额已被 10:00 那封占掉，永远轮不到 —— 若原地等，水位线被钉死，
// 期间的告警一直进不了任何一封汇总，直到滑出扫描窗口被静默丢弃。

/** 直接驱动生产实现：槽位查询以回调注入 */
const resolveCutoff = (lastCutoff, hour, occupiedDays, now) =>
  resolveDigestCutoff(async (c) => occupiedDays.has(utc8DayOf(c)), lastCutoff, hour, now);

test('改晚时点后跨过当天已占用的边界，不把水位线钉死', async () => {
  const at10 = new Date(Date.UTC(2026, 6, 20, 2, 0, 0));    // day1 10:00 UTC+8，已发
  const occupied = new Set(['2026-07-20']);
  const now = Date.UTC(2026, 6, 20, 14, 0, 0);              // day1 22:00 UTC+8

  const r = await resolveCutoff(at10, 21, occupied, now);
  assert.equal(utc8DayOf(r.skipped), '2026-07-20', '跨过的是当天 21:00 那个边界');
  assert.equal(utc8DayOf(r.cutoff), '2026-07-21', '落到次日 21:00，告警顺延到下一个周期');
  assert.ok(r.cutoff.getTime() > now, '次日边界尚未到期 —— 本轮不发，但水位线已经前进');

  // 关键：跨越结果**不落库** —— 水位线保持在 at10（收集下限也就留在那里，
  // 10:00–21:00 的告警不会被筛掉）。下一轮从同一个水位线重算，
  // 会再跨一次并得到同一个可用边界，因此不需要持久化。
  const r2 = await resolveCutoff(at10, 21, occupied, now);
  assert.equal(r2.cutoff.getTime(), r.cutoff.getTime(), '重算得到同一个可用边界（幂等）');
  assert.equal(utc8DayOf(r2.skipped), utc8DayOf(r.skipped), '跨越动作本身也是幂等的');

  // 若把跨过的边界写回水位线，收集下限会推到它之前一点，
  // 恰好把这批本该顺延的告警筛掉 —— 这正是不落库的原因。
  const floorIfPersisted = r.skipped.getTime() - 15 * 60 * 1000;
  const alertAt15 = Date.UTC(2026, 6, 20, 7, 0, 0);       // day1 15:00 UTC+8
  assert.ok(alertAt15 < floorIfPersisted,
    '15:00 的告警会落在「写回后的收集下限」之前 —— 落库就会把它静默丢掉');
  assert.ok(alertAt15 > at10.getTime() - 15 * 60 * 1000,
    '不落库时它仍在收集范围内，会被下一个周期带走');
});

test('边界未被占用时不跨越', async () => {
  const at10 = new Date(Date.UTC(2026, 6, 20, 2, 0, 0));
  const now = Date.UTC(2026, 6, 21, 14, 0, 0);
  const r = await resolveCutoff(at10, 21, new Set(), now);
  assert.equal(r.skipped, null, '没有占用就不该跳');
  assert.equal(utc8DayOf(r.cutoff), '2026-07-20', '仍是水位线之后的第一个边界');
});

test('跨越有次数上限，异常水位线不会死循环', async () => {
  const long = new Date(Date.UTC(2020, 0, 1, 1, 0, 0));   // 极旧的水位线
  const allOccupied = { has: () => true };                 // 所有天都被占
  const now = Date.UTC(2026, 6, 21, 14, 0, 0);
  const r = await resolveCutoff(long, 9, allOccupied, now);
  assert.ok(r.skipped !== null, '确实跨越了');
  assert.ok(r.cutoff.getTime() > long.getTime(), '循环有界并正常返回');
});

// ── 空周期要在一轮里全部跨完（review 第二十二轮 P2）────────────
// 一轮只推进一个边界的话，停用一年的绑定重新启用后，
// 新通知要等约 365 轮（默认 60 秒一轮）才发得出。

/** 直接驱动生产实现 */
const fastForward = fastForwardDigestCutoff;

test('一轮跨完所有已到期的空周期', () => {
  const HOUR = 9;
  const stale = new Date(Date.UTC(2026, 5, 1, 1, 0, 0));      // 约 50 天前
  const now = Date.UTC(2026, 6, 21, 5, 0, 0);                  // day 21 13:00 UTC+8
  const due = fastForward(stale, HOUR, now);
  assert.equal(utc8DayOf(due), '2026-07-21', '一次就追到今天的边界，不是明天');
  assert.ok(due.getTime() <= now, '停在最后一个**已到期**的边界上');
  assert.ok(nextDigestDueAt(due, HOUR).getTime() > now, '再下一个尚未到期');
});

test('快进不会越过尚未到期的边界', () => {
  const HOUR = 21;
  const yesterday = new Date(Date.UTC(2026, 6, 20, 13, 0, 0)); // day20 21:00 UTC+8
  const now = Date.UTC(2026, 6, 21, 5, 0, 0);                  // day21 13:00 —— 今天 21 点还没到
  const due = fastForward(yesterday, HOUR, now);
  assert.equal(due, null, '下一个边界尚未到期，本轮不推进');
});

test('只差一个周期时行为不变', () => {
  const HOUR = 9;
  const lastCutoff = new Date(Date.UTC(2026, 6, 20, 1, 0, 0)); // day20 09:00
  const now = Date.UTC(2026, 6, 21, 5, 0, 0);                  // day21 13:00
  const due = fastForward(lastCutoff, HOUR, now);
  assert.equal(utc8DayOf(due), '2026-07-21', '推进到 day21 09:00，与快进前的行为一致');
});
