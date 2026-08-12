import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { evaluateRunHealth } from '../src/work/runHealth.js';
import { RuntimeBudget } from '../src/util/runtimeBudget.js';
import { RUN_BUDGET_MS } from '../src/store/workQueue.js';

test('单轮在任务边界超过预算后优雅收尾：摘要明确、exit 0', () => {
  let now = 10_000;
  const budget = new RuntimeBudget(1, () => now);
  const locks = new Set(['done', 'unfinished']);
  let processed = 0;

  assert.equal(budget.checkpoint(), false);
  locks.delete('done');
  processed++;
  now += 1_001;
  assert.equal(budget.checkpoint(), true);
  const released = locks.size;
  locks.clear();

  const health = evaluateRunHealth({
    claimed: 2,
    processed,
    partial: 0,
    failed: 0,
    deferred: released,
  });
  assert.equal(health.status, 'partial');
  assert.equal(health.exitCode, 0);
  assert.equal(locks.size, 0);
  assert.deepEqual(
    {
      stoppedByRuntimeBudget: budget.summary().stoppedByRuntimeBudget,
      maxRuntimeSec: budget.summary().maxRuntimeSec,
    },
    { stoppedByRuntimeBudget: true, maxRuntimeSec: 1 },
  );
});

test('所有 schedule:* 都显式使用共享预算，且不超过对应硬超时 60%', async () => {
  const root = new URL('../', import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const schedules = Object.entries(pkg.scripts).filter(([name]) => name.startsWith('schedule:'));
  assert.equal(schedules.length, 15);

  for (const [name, command] of schedules) {
    const job = name.slice('schedule:'.length);
    const budgetMatch = /--max-runtime-sec (\d+)/.exec(command);
    assert.ok(budgetMatch, `${name} 缺显式 --max-runtime-sec`);
    const cliMatch = /src\/cli\/([a-z0-9-]+\.ts)/.exec(command);
    assert.ok(cliMatch, `${name} 无法定位 CLI`);
    const cli = await readFile(new URL(`src/cli/${cliMatch[1]}`, root), 'utf8');
    assert.match(cli, /addRuntimeBudgetOption\(/, `${name} 没有复用共享预算选项`);

    const timeout = await readFile(
      new URL(`deploy/systemd/syncer2-job@${job}.service.d/timeout.conf`, root),
      'utf8',
    );
    const timeoutMatch = /^TimeoutStartSec=(\d+)(min|s)?$/m.exec(timeout);
    assert.ok(timeoutMatch, `${name} 缺可解析 TimeoutStartSec`);
    const timeoutSec = Number(timeoutMatch[1]) * (timeoutMatch[2] === 'min' ? 60 : 1);
    const budgetSec = Number(budgetMatch[1]);
    assert.ok(
      budgetSec <= timeoutSec * 0.6,
      `${name}: ${budgetSec}s 超过 ${timeoutSec}s 硬超时的 60%`,
    );
  }
});

test('work-queue 旧 RUN_BUDGET_MS 并入共享 CLI 参数且保持 6 分钟安全网', async () => {
  assert.equal(RUN_BUDGET_MS, 6 * 60_000);
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> };
  assert.match(
    pkg.scripts['schedule:work-queue'] ?? '',
    new RegExp(`--max-runtime-sec ${RUN_BUDGET_MS / 1_000}(?:\\s|$)`),
  );
});
