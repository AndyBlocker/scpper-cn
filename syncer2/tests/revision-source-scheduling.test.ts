import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { wikidotEgressChannelQuota } from '../src/http/egressCapacity.js';
import {
  decideRevisionSourceRealtimeContention,
  probeRevisionSourceStartupIfNeeded,
  REVISION_SOURCE_SCHEDULE_INTERVAL_MS,
  revisionSourceDispatchUpperBoundMs,
} from '../src/store/revisionSource.js';

test('完全无 active/unseeded 工作时廉价跳过且不调用 AMC probe', async () => {
  let probes = 0;
  const empty = await probeRevisionSourceStartupIfNeeded(
    { activeJobs: 0, hasUnseededEligible: false, hasWork: false },
    async () => ++probes,
  );
  assert.deepEqual(empty, {
    action: 'skip',
    reason: 'no_pending_or_unseeded_revision_source_work',
    probe: null,
  });
  assert.equal(probes, 0);

  const pending = await probeRevisionSourceStartupIfNeeded(
    { activeJobs: 1, hasUnseededEligible: false, hasWork: true },
    async () => ++probes,
  );
  assert.equal(pending.action, 'probe');
  assert.equal(probes, 1, '有活时启动探针行为保持不变');
});

test('实时采集持续繁忙仍逐轮获得执行机会，定时器相位不能退化为永久跳过', () => {
  const phaseAlignedRounds = Array.from({ length: 10_000 }, (_, round) =>
    decideRevisionSourceRealtimeContention([round % 2 === 0 ? 'l1_votes' : 'unknown'])
  );
  assert.ok(phaseAlignedRounds.every((decision) => decision.action === 'execute'));
  assert.ok(
    phaseAlignedRounds.every(
      (decision) => decision.coordination === 'background_token_bucket',
    ),
  );
});

test('任一 due/live 等待任务按 FIFO 位置有可推导的调度机会界', () => {
  assert.equal(REVISION_SOURCE_SCHEDULE_INTERVAL_MS, 30 * 60_000);
  assert.equal(revisionSourceDispatchUpperBoundMs(1, 1), 30 * 60_000);
  assert.equal(revisionSourceDispatchUpperBoundMs(2, 1), 60 * 60_000);
  assert.equal(
    revisionSourceDispatchUpperBoundMs(2_315, 1),
    2_315 * 30 * 60_000,
    '不把每轮 300 的上限偷换为最低吞吐；硬界是 2,315 轮/48.23 天',
  );
});

test('background 配额覆盖每半小时 300 条，不需要靠躲避 L1 控速', () => {
  const quota = wikidotEgressChannelQuota('revision-source');
  assert.deepEqual(quota, {
    group: 'background',
    requestsPerHour: 800,
    bucketCapacity: 400,
    priority: 10,
  });
  assert.ok(quota.requestsPerHour >= 300 * 2);
  assert.ok(quota.bucketCapacity >= 300);
});

test('生产入口不再包含 l0_l1_active 整轮跳过分支', async () => {
  const [source, storeSource, packageJson, timer] = await Promise.all([
    readFile(new URL('../src/cli/revision-source-backfill.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/store/revisionSource.ts', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
    readFile(
      new URL('../deploy/systemd/syncer2-revision-source-backfill.timer', import.meta.url),
      'utf8',
    ),
  ]);
  assert.doesNotMatch(source, /l0_l1_active/);
  assert.match(
    source,
    /if \(active\.length > 0\) \{\s*log\.info\([\s\S]{0,300}\}\);\s*\}/,
  );
  assert.match(source, /deterministicFailures: counters\.deterministicFailures/);
  assert.ok(
    source.indexOf('if (!opts.pilot && !workAvailability.hasWork)') <
      source.indexOf('const http = createRestrictedStableHttp({'),
    '无待办判定必须发生在客户端/session 构造和 AMC probe 之前',
  );
  assert.match(source, /if \(disposition === 'deterministic'\) counters\.deterministicFailures\+\+/);
  assert.match(
    storeSource,
    /releaseRevisionSourceClaims[\s\S]{0,900}not_before = now\(\)[\s\S]{0,500}attempts = GREATEST\(0, attempts - 1\)/,
    '预算中断的队头必须归还 attempt 并更新 FIFO 时钟，不能下轮原地自旋',
  );
  assert.match(storeSource, /ORDER BY j\.not_before, j\.page_id, j\.ordinal/);

  const scripts = JSON.parse(packageJson) as { scripts: Record<string, string> };
  assert.match(scripts.scripts['schedule:revision-source-backfill'] ?? '', /--limit 300\b/);
  assert.match(timer, /^OnCalendar=\*-\*-\* \*:25,55:00 Asia\/Shanghai$/m);
});
