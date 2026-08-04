import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('systemd 分层调度全部是有限超时的 oneshot + timer', async () => {
  const service = await readFile(
    new URL('../deploy/systemd/syncer2-job@.service', import.meta.url),
    'utf8',
  );
  const workTimer = await readFile(
    new URL('../deploy/systemd/syncer2-work-queue.timer', import.meta.url),
    'utf8',
  );
  const layerTimers = await Promise.all(
    ['l0', 'l1', 'l2', 'l3'].map((layer) =>
      readFile(new URL(`../deploy/systemd/syncer2-${layer}.timer`, import.meta.url), 'utf8'),
    ),
  );
  const timeoutDropIns = await Promise.all(
    ['l0', 'l1', 'l2', 'l3', 'work-queue'].map((job) =>
      readFile(
        new URL(`../deploy/systemd/syncer2-job@${job}.service.d/timeout.conf`, import.meta.url),
        'utf8',
      ),
    ),
  );
  const pm2Fallback = await readFile(
    new URL('../ecosystem.work-queue.config.cjs', import.meta.url),
    'utf8',
  );

  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/env npm run schedule:%i$/m);
  assert.match(service, /^TimeoutStartSec=15min$/m);
  assert.doesNotMatch(service, /TimeoutStartSec=infinity/);
  assert.match(service, /禁止.*restart_delay/);
  assert.match(service, /2,388 次静默失败/);
  assert.doesNotMatch(service, /^Restart=/m);
  assert.match(workTimer, /^OnUnitInactiveSec=1min$/m);
  assert.match(workTimer, /^Unit=syncer2-job@work-queue\.service$/m);
  assert.match(layerTimers[0]!, /^OnCalendar=\*-\*-\* \*:02,32:00 Asia\/Shanghai$/m);
  assert.match(layerTimers[1]!, /^OnCalendar=\*-\*-\* \*:07,37:00 Asia\/Shanghai$/m);
  assert.match(layerTimers[2]!, /^OnCalendar=\*-\*-\* \*:27:00 Asia\/Shanghai$/m);
  assert.match(layerTimers[3]!, /^OnCalendar=Sun \*-\*-\* 04:55:00 Asia\/Shanghai$/m);
  assert.match(timeoutDropIns[0]!, /^TimeoutStartSec=5min$/m);
  assert.match(timeoutDropIns[1]!, /^TimeoutStartSec=45min$/m);
  assert.match(timeoutDropIns[2]!, /^TimeoutStartSec=10min$/m);
  assert.match(timeoutDropIns[3]!, /^TimeoutStartSec=45min$/m);
  assert.match(timeoutDropIns[4]!, /^TimeoutStartSec=10min$/m);
  for (const oldTimer of ['sitemap-delta', 'sitemap-full', 'tier1']) {
    await assert.rejects(
      readFile(new URL(`../deploy/systemd/syncer2-${oldTimer}.timer`, import.meta.url), 'utf8'),
      { code: 'ENOENT' },
    );
  }
  assert.match(pm2Fallback, /autorestart: false/);
  assert.doesNotMatch(pm2Fallback, /\brestart_delay\s*:/);
  for (const layer of ['l0', 'l1', 'l2', 'l3']) {
    assert.match(pm2Fallback, new RegExp(`['"]syncer2-${layer}['"]`));
  }
});

test('调度脚本钉住共享 IP 预算与时区护栏', async () => {
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> };
  assert.match(pkg.scripts['schedule:work-queue'] ?? '', /--limit 50/);
  assert.match(pkg.scripts['schedule:work-queue'] ?? '', /--concurrency 4/);
  assert.match(pkg.scripts['schedule:l0'] ?? '', /incremental-scan.*--layer l0/);
  assert.match(pkg.scripts['schedule:l1'] ?? '', /incremental-scan.*--layer l1/);
  assert.match(pkg.scripts['schedule:l2'] ?? '', /sitemap-scan.*--mode full.*--page-scan all/);
  assert.match(pkg.scripts['schedule:l3'] ?? '', /tier1-scan.*--concurrency 5/);
  assert.equal(pkg.scripts['schedule:sitemap-delta'], undefined);
  assert.equal(pkg.scripts['schedule:sitemap-full'], undefined);
  assert.equal(pkg.scripts['schedule:tier1'], undefined);
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (name.startsWith('schedule:')) {
      assert.doesNotMatch(command, /--skip-tz-check/, name);
    }
  }
});

test('page_scan 保留策略先聚合，保留真实失败与最近两轮枚举', async () => {
  const migration = await readFile(
    new URL('../migrations/0017_page_scan_retention.sql', import.meta.url),
    'utf8',
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS meta\.page_scan_run_summary/);
  assert.match(migration, /p_success_retention interval DEFAULT interval '1 hour'/);
  assert.match(migration, /p_failure_retention interval DEFAULT interval '30 days'/);
  assert.match(migration, /finished\.finished_at IS NOT NULL/);
  assert.match(migration, /ordinal <= 2/);
  assert.match(migration, /newer\.page_id=ps\.page_id/);
  assert.match(migration, /tier1_claim_only/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE[\s\S]*ingestor_role/);
  assert.match(migration, /REVOKE ALL ON FUNCTION meta\.maintain_page_scan/);
  assert.match(migration, /current_database\(\) IN \('scpper-cn'/);
});

test('run partial/inconclusive 与真 failed 分账，不制造调度失败', async () => {
  const [migration, backfill, workQueue, tier1, sitemap, forum, reconcile] = await Promise.all([
    readFile(new URL('../migrations/0020_health_sample_and_run_status.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/0021_backfill_run_status_semantics.sql', import.meta.url), 'utf8'),
    readFile(new URL('../src/cli/work-queue.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/cli/tier1-scan.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/cli/sitemap-scan.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/cli/forum-scan.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/cli/reconcile.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(migration, /status IN \('running','ok','partial','failed','aborted'\)/);
  assert.match(migration, /partial=执行完成但含正常的不完整证据/);
  assert.match(backfill, /statusSemanticsBackfill/);
  assert.match(backfill, /COALESCE\(NULLIF\(stats->>'failed', ''\)::int, 0\) = 0/);
  assert.match(backfill, /跨批 fullname 重复 \[0-9\]\+/);
  assert.match(workQueue, /evaluateWorkQueueHealth/);
  assert.match(forum, /counters\.partial > 0[\s\S]{0,80}\? 'partial'/);
  assert.match(reconcile, /report\.status === 'partial'[\s\S]{0,80}\? 'partial'/);
  assert.match(reconcile, /report\.status === 'inconclusive'[\s\S]{0,80}\? 'partial'/);
  assert.match(reconcile, /ok: !isReconcileFailure\(finalReport\.status\)/);
  // 退出码只留给工具级故障与「未解释占比显著恶化」；发现分歧本身走报表，不占用单元失败信号位。
  // 行为断言见 tests/reconcile-exit-semantics.test.ts，这里只钉住调用点没有被绕过。
  assert.match(reconcile, /toolFailed \|\| regressed \? 1 : 0/);
  assert.match(reconcile, /isReconcileToolFailure\(finalReport\.status\)/);
  assert.match(reconcile, /unexplainedRatioRegressed\(/);
  assert.match(workQueue, /ok: health\.exitCode === 0/);
  for (const source of [tier1, sitemap, forum]) {
    assert.match(
      source,
      /(?:status|logicalStatus|outcome\.status|finalReport\.status) === 'ok' \|\| [\s\S]{0,40}=== 'partial'/,
    );
  }
});
