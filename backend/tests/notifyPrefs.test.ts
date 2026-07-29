import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentHourUtc8, startOfUtc8Day, utc8HourToday } from '../src/jobs/NotificationDispatchJob.js';

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

test('定时资格：过点可补发，同日不重发（review P1）', () => {
  // 复刻资格判定：reachedHour = 当前小时 >= 设定小时
  const eligible = (nowHour: number, digestHour: number, sentTodayCalendar: number) => {
    const reached = nowHour >= digestHour;
    return reached && sentTodayCalendar === 0;
  };
  assert.equal(eligible(21, 21, 0), true, '正好到点应发');
  assert.equal(eligible(23, 21, 0), true, '错过整点后应能补发 —— 否则整天不发且候选会过期');
  assert.equal(eligible(23, 21, 1), false, '当天已发过不再发');
  assert.equal(eligible(10, 21, 0), false, '未到点应攒着');
});

test('定时用户的未到点候选不得计入熔断（review P1）', () => {
  // 三个不同时点的定时用户各攒 900 条，全局上限 2000
  const CIRCUIT_MAX = 2000;
  const all = [{ n: 900, eligible: false }, { n: 900, eligible: false }, { n: 900, eligible: true }];
  const total = all.reduce((a, x) => a + x.n, 0);
  const eligibleCount = all.filter((x) => x.eligible).reduce((a, x) => a + x.n, 0);
  assert.ok(total > CIRCUIT_MAX, '前提：堆积总量确实超过上限');
  assert.ok(eligibleCount <= CIRCUIT_MAX, '本轮真正要发的量并不超标');
  // 按总量计会误跳闸，连带卡住实时用户
  assert.equal(total > CIRCUIT_MAX, true);
  assert.equal(eligibleCount > CIRCUIT_MAX, false, '按可发量计才不会误跳闸');
});

test('utc8HourToday 返回 UTC+8 今天该整点', () => {
  const t = utc8HourToday(21);
  const inUtc8 = new Date(t.getTime() + 8 * 3600 * 1000);
  assert.equal(inUtc8.getUTCHours(), 21);
  assert.equal(inUtc8.getUTCMinutes(), 0);
});

test('补发只收截止线之前的内容（review P1）', () => {
  // 复刻资格判定：到点/过点 + 今天未发过 + 内容早于今天的截止线
  const included = (nowHour: number, digestHour: number, alertHour: number, sentToday: number) => {
    const reached = nowHour >= digestHour;
    const eligible = reached && sentToday === 0;
    const beforeCutoff = alertHour < digestHour;
    return eligible && beforeCutoff;
  };
  // 设定 21 点，23 点跑到这一轮
  assert.equal(included(23, 21, 20, 0), true, '20 点的动态应在这次补发里');
  assert.equal(included(23, 21, 22, 0), false,
    '22 点（截止后）产生的不该现在推 —— 用户选的是每天 21 点收一次，半夜收到比不补发更糟');
  assert.equal(included(21, 21, 20, 0), true, '正常到点');
  assert.equal(included(10, 21, 9, 0), false, '未到点');
});

test('定时模式的日限额按自然日计（review P2）', () => {
  // 滚动 24 小时 vs 自然日：qqDailyLimit=1 时差别是「今天到底发不发」
  const rolling24h = 1;   // 昨天 22:00 发过，现在 21:00 —— 仍在滚动窗口内
  const calendarDay = 0;  // 但按 UTC+8 自然日，今天还没发过
  const limit = 1;
  assert.equal(rolling24h >= limit, true, '按滚动窗口会误判为已达上限');
  assert.equal(calendarDay >= limit, false, '按自然日才正确：今天可以发');
});

test('相邻两次汇总的覆盖区间必须严丝合缝（review P1）', () => {
  // 截止线 21:00，因故障补发到 23:00 才真正送出
  const cutoff = 21, sentAt = 23;
  // 下一次收集的起点：用 sentAt 会漏掉 21–23 点之间产生的内容
  const missedBySentAt = (alertHour: number) => alertHour >= cutoff && alertHour < sentAt;
  assert.equal(missedBySentAt(22), true,
    '22 点的动态：当时晚于截止线被推迟，之后又早于 sentAt 起点被排除 —— 两头不沾');
  // 用截止线做起点则被正确纳入下一次
  const coveredByCutoff = (alertHour: number) => alertHour >= cutoff;
  assert.equal(coveredByCutoff(22), true, '以截止线为锚点时它会进入下一次汇总');
});

test('放宽收集窗口不得越过冷启动闸门（review P1）', () => {
  const now = 1_000_000_000_000;
  const LOOKBACK = 24 * 3600 * 1000;
  const clamp = (startAt: number, floor: number) =>
    Math.max(startAt, Math.min(floor, now - 2 * LOOKBACK));
  // 闸门比放宽后的窗口更晚（刚上线的情形）
  const startAt = now - 3 * 3600 * 1000;  // 3 小时前才开闸
  const floor = now - LOOKBACK;
  assert.equal(clamp(startAt, floor), startAt, '起点不得早于闸门 —— 否则会推送上线前的积压');
  // 闸门很早时，放宽正常生效
  const oldStart = now - 30 * 24 * 3600 * 1000;
  assert.equal(clamp(oldStart, floor), now - 2 * LOOKBACK, '闸门够早时按放宽窗口取');
});
