import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMerged } from '../src/jobs/NotificationDispatchJob.js';

const URL1 = 'https://scpper.mer.run/page/1234567';

test('同一页面的多个指标合并成一行', () => {
  const out = renderMerged([
    { line: 'x', groupKey: 'page:1234567', mergeHead: '你的《SCP-CN-1000（大门）》', mergePart: '投票 +12', mergeTail: URL1 },
    { line: 'x', groupKey: 'page:1234567', mergeHead: '你的《SCP-CN-1000（大门）》', mergePart: '评论 +3', mergeTail: URL1 },
    { line: 'x', groupKey: 'page:1234567', mergeHead: '你的《SCP-CN-1000（大门）》', mergePart: '编辑 +1', mergeTail: URL1 }
  ], 0);
  const body = out.split('\n').filter((l) => l.startsWith('· '));
  assert.equal(body.length, 1, '三条应合并为一行');
  assert.match(body[0]!, /投票 \+12、评论 \+3、编辑 \+1/);
  assert.ok(body[0]!.includes(URL1));
});

test('不同页面不合并', () => {
  const out = renderMerged([
    { line: 'a', groupKey: 'page:1', mergeHead: '你的《A》', mergePart: '投票 +1', mergeTail: 'u1' },
    { line: 'b', groupKey: 'page:2', mergeHead: '你的《B》', mergePart: '投票 +2', mergeTail: 'u2' }
  ], 0);
  assert.equal(out.split('\n').filter((l) => l.startsWith('· ')).length, 2);
});

test('不可拼接的同组用「（N 条）」收敛', () => {
  const out = renderMerged([
    { line: 'Sven 回复了你 「话题」', groupKey: 'forum:9' },
    { line: 'Sven 回复了你 「话题」', groupKey: 'forum:9' }
  ], 0);
  const body = out.split('\n').filter((l) => l.startsWith('· '));
  assert.equal(body.length, 1);
  assert.match(body[0]!, /（2 条）$/);
});

test('无 groupKey 的历史数据各自成行', () => {
  const out = renderMerged([{ line: 'x' }, { line: 'y' }], 0);
  assert.equal(out.split('\n').filter((l) => l.startsWith('· ')).length, 2);
});

test('文案要求：品牌小写、无「你有新的站点动态」、无「查看全部」', () => {
  const out = renderMerged([{ line: 'x' }], 0);
  assert.ok(out.includes('【scpper-cn】'), '应含小写品牌串');
  assert.ok(!out.includes('SCPper CN'), '不应含旧的大写品牌串');
  assert.ok(!out.includes('你有新的站点动态'), '不应含该提示语');
  assert.ok(!out.includes('查看全部'), '不应含查看全部');
});

test('溢出提示仍保留', () => {
  const out = renderMerged([{ line: 'x' }], 5);
  assert.match(out, /…另有 5 条/);
});

test('重发路径还原 payload 后应与首次渲染一致（review P2）', () => {
  // 模拟首次：三条同页指标
  const first = renderMerged([
    { line: 'l1', groupKey: 'page:1', mergeHead: '你的《X》', mergePart: '投票 +1', mergeTail: 'u' },
    { line: 'l2', groupKey: 'page:1', mergeHead: '你的《X》', mergePart: '评论 +2', mergeTail: 'u' }
  ], 0);
  // 模拟重发：从 payload 还原（这正是 resumeScheduledBatches 现在做的）
  const payloads = [
    { line: 'l1', groupKey: 'page:1', mergeHead: '你的《X》', mergePart: '投票 +1', mergeTail: 'u' },
    { line: 'l2', groupKey: 'page:1', mergeHead: '你的《X》', mergePart: '评论 +2', mergeTail: 'u' }
  ];
  const replay = renderMerged(payloads, 0);
  assert.equal(replay, first, '重发渲染必须与首次一致，否则用户会看到同一批通知第二次变样');
  assert.equal(replay.split('\n').filter((l) => l.startsWith('· ')).length, 1);
});

test('同名被关注者的动态不得被合并（review P2）', () => {
  // groupKey 用稳定 id 区分；若退回用显示名，两条会并成一条且丢掉后者
  const out = renderMerged([
    { line: 'A 编辑了《P》', groupKey: 'follow:1001:9' },
    { line: 'B 编辑了《P》', groupKey: 'follow:1002:9' }
  ], 0);
  const body = out.split('\n').filter((l) => l.startsWith('· '));
  assert.equal(body.length, 2, '不同被关注者应各占一行');
  assert.ok(body.some((l) => l.includes('A 编辑了')));
  assert.ok(body.some((l) => l.includes('B 编辑了')));
});
