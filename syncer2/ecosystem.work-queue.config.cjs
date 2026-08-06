/** PM2 备选；正式全套调度见 deploy/systemd/。 */
function shortJob(name, script, args, cronRestart, killTimeout = 120000) {
  return {
    name,
    cwd: __dirname,
    script,
    interpreter: 'node',
    node_args: '--import tsx/esm',
    args,
    cron_restart: cronRestart,
    autorestart: false,
    watch: false,
    kill_timeout: killTimeout,
    env: { TZ: 'Asia/Shanghai' },
  };
}

// 所有任务正常退出后保持 stopped，只由 cron_restart 再拉起。
// 禁止 restart_delay：它会累计正常退出并最终把短进程打成 errored；这正是 v1
// 三个常驻 loop 累计 2,388 次静默失败的病根。
module.exports = {
  apps: [
    shortJob(
      'syncer2-work-queue',
      'src/cli/work-queue.ts',
      '--limit 50 --concurrency 4',
      '* * * * *',
    ),
    shortJob(
      'syncer2-l0',
      'src/cli/incremental-scan.ts',
      '--layer l0 --concurrency 3 --amc-probe skip --proxy-check warn',
      '2,32 * * * *',
    ),
    shortJob(
      'syncer2-l1',
      'src/cli/incremental-scan.ts',
      '--layer l1 --concurrency 5 --amc-probe skip --proxy-check warn',
      '7,37 * * * *',
      30000,
    ),
    shortJob(
      'syncer2-l2',
      'src/cli/sitemap-scan.ts',
      '--mode full --page-scan all --concurrency 4 --proxy-check warn',
      '27 * * * *',
    ),
    shortJob(
      'syncer2-l3',
      'src/cli/tier1-scan.ts',
      '--concurrency 5 --amc-probe require --proxy-check warn',
      '55 4 * * 0',
      30000,
    ),
    shortJob(
      'syncer2-resolve-pages',
      'src/cli/resolve-pages.ts',
      '--limit 50 --concurrency 2 --amc-probe skip --proxy-check warn',
      '*/5 * * * *',
    ),
    shortJob(
      'syncer2-forum-discovery',
      'src/cli/sitemap-scan.ts',
      '--mode threads --page-scan none --concurrency 4 --proxy-check warn',
      '23 5 * * *',
    ),
    shortJob(
      'syncer2-forum-consume',
      'src/cli/forum-scan.ts',
      '--limit 50 --concurrency 4 --amc-probe require --proxy-check warn',
      '43 5 * * *',
    ),
    shortJob(
      'syncer2-reconcile',
      'src/cli/reconcile.ts',
      '--mode all --triangle-pages 10 --concurrency 2 --amc-probe require --proxy-check warn',
      '13 6 * * *',
    ),
    shortJob(
      'syncer2-page-scan-maintenance',
      'src/cli/page-scan-maintenance.ts',
      '',
      '55 * * * *',
    ),
    shortJob(
      'syncer2-oldest-pending',
      'src/cli/oldest-pending.ts',
      '',
      '1-59/5 * * * *',
      30000,
    ),
  ],
};
