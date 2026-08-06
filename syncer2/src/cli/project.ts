/**
 * M8 L2 projector CLI。
 *
 * 默认单次运行、完成即退出；`--watch` 才进入常驻模式。stdout 仍只在进程结束时输出
 * 一行 JSON，过程与心跳全部写 stderr。
 */

import { createLogger, emitSummary, redirectConsoleToStderr } from '../util/log.js';

redirectConsoleToStderr();

import { Command } from 'commander';
import type { Pool } from 'pg';
import { loadConfig } from '../config.js';
import { assertTimezoneRoundTrip, createPool } from '../store/db.js';
import {
  DEFAULT_PROJECTION_ORDER,
  expandProjectionDependencies,
  runProjections,
  selectStalledBusy,
} from '../project/runner.js';

/*
 * busy 升级为失败的滞后阈值。取 30 分钟：projector timer 每 5 分钟一轮，
 * 连续 6 轮都抢不到 gate 才判定为真停滞，足以吸收源码回填期的高频写入碰撞，
 * 又不会让「长期推不动」无限静默。
 */
const BUSY_STALL_LAG_SEC = 30 * 60;
import {
  normalizeProjectionName,
  type ProjectionName,
  type ProjectionRunResult,
} from '../project/types.js';

const log = createLogger('project');

interface CliOptions {
  projections: ProjectionName[];
  rebuild: boolean;
  includeDeletedPages: boolean | null;
  skipTzCheck: boolean;
  watch: boolean;
  intervalMs: number;
  staleMs: number;
}

interface IterationResult {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  rebuild: boolean;
  includeDeletedPages: boolean;
  projections: ProjectionRunResult[];
}

async function runIteration(
  pool: Pool,
  options: CliOptions,
  includeDeletedPages: boolean,
): Promise<IterationResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const results = await runProjections(pool, options.projections, {
    rebuild: options.rebuild,
    includeDeletedPages,
  });
  for (const result of results) {
    if (result.lagBeforeSeconds > 60) {
      log.warn('projection lag 超过 60 秒', {
        projection: result.projection,
        lagBeforeSeconds: result.lagBeforeSeconds,
        previousSeq: result.previousSeq,
        watermark: result.watermark,
      });
    }
  }
  /*
   * busy 是 safe_seq_watermark() 契约里的良性信号：摄入侧正持有 gate 屏障锁，
   * 本轮不推进游标、下轮自愈。此前把它算作 ok=false ⇒ exit 1，于是「摄入越忙、
   * 投影越爱失败」，源码回填期间几乎每轮都告警，告警通道因此失去意义。
   *
   * 但不能无条件放行，否则摄入侧若真的永久占锁，投影会静默停止推进。
   * 判据：busy 本身不失败，只有 busy 同时伴随游标已明显陈旧（lag 超阈）才失败——
   * 「暂时抢不到锁」与「长期推不动」是两件事，必须分开。
   */
  const busy = results.filter((result) => result.status === 'busy');
  const stalled = selectStalledBusy(results, BUSY_STALL_LAG_SEC);
  if (busy.length > 0) {
    log.warn('本轮有投影因摄入侧持锁未推进（下轮自愈）', {
      busy: busy.map((r) => r.projection),
      stalled,
    });
  }
  return {
    ok: stalled.length === 0,
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    rebuild: options.rebuild,
    includeDeletedPages,
    projections: results,
  };
}

async function main(): Promise<void> {
  const options = parseArgs();
  const config = loadConfig();
  const includeDeletedPages =
    options.includeDeletedPages ?? config.projectIncludeDeletedPages;
  const pool = createPool(config.databaseUrl, { max: 2 });
  let final: IterationResult | null = null;
  try {
    if (options.skipTzCheck) {
      log.warn('--skip-tz-check 仅限本地调试，调度器禁止使用');
    } else {
      await assertTimezoneRoundTrip(pool);
    }

    if (!options.watch) {
      final = await runIteration(pool, options, includeDeletedPages);
      emitSummary(final);
      if (!final.ok) process.exitCode = 1;
      return;
    }

    let lastSuccessAt = Date.now();
    for (;;) {
      try {
        const iteration = await runIteration(pool, options, includeDeletedPages);
        final = iteration;
        if (iteration.ok) lastSuccessAt = Date.now();
        log.info('projector heartbeat', {
          ok: iteration.ok,
          durationMs: iteration.durationMs,
          projections: iteration.projections.map((item) => ({
            name: item.projection,
            status: item.status,
            advancedTo: item.advancedTo,
          })),
        });
      } catch (err) {
        log.error('projector 一轮失败', { error: String(err) });
      }

      if (Date.now() - lastSuccessAt > options.staleMs) {
        throw new Error(
          `projector 连续 ${Math.round(options.staleMs / 60_000)} 分钟无成功心跳，主动退出交 PM2/systemd 重启`,
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, options.intervalMs));
    }
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function collect(value: string, previous: string[]): string[] {
  previous.push(value);
  return previous;
}

function parseArgs(): CliOptions {
  const program = new Command();
  program.configureOutput({
    writeOut: (text) => process.stderr.write(text),
    writeErr: (text) => process.stderr.write(text),
  });
  program
    .name('project')
    .description('安全 fact_seq 水位驱动的 L2 投影（含 effective page-reference）')
    .option(
      '-p, --projection <name>',
      '只运行指定投影，可重复；允许 page_stats 或 serve.page_stats',
      collect,
      [],
    )
    .option('--rebuild', '按 rebuild_from 契约全量重建（page_daily_stats 不会 TRUNCATE）', false)
    .option('--include-deleted-pages', 'user_page/user_stats 纳入已删页作品', false)
    .option('--exclude-deleted-pages', 'user_page/user_stats 排除已删页作品', false)
    .option('--skip-tz-check', '跳过时区回环（仅限本地调试）', false)
    .option('--watch', '常驻运行并启用无成功心跳自杀', false)
    .option('--interval-seconds <n>', 'watch 轮询秒数，默认 30', Number, 30)
    .option('--stale-minutes <n>', 'watch 无成功心跳自杀分钟数，默认 10', Number, 10);
  program.parse(process.argv);
  const raw = program.opts<{
    projection: string[];
    rebuild: boolean;
    includeDeletedPages: boolean;
    excludeDeletedPages: boolean;
    skipTzCheck: boolean;
    watch: boolean;
    intervalSeconds: number;
    staleMinutes: number;
  }>();

  if (raw.includeDeletedPages && raw.excludeDeletedPages) {
    throw new Error('--include-deleted-pages 与 --exclude-deleted-pages 不能同时使用');
  }
  if (raw.rebuild && raw.watch) {
    throw new Error('--rebuild 是一次性运维动作，禁止与 --watch 同时使用');
  }
  if (!Number.isFinite(raw.intervalSeconds) || raw.intervalSeconds < 1 || raw.intervalSeconds > 300) {
    throw new Error(`--interval-seconds 必须在 1..300，收到 ${raw.intervalSeconds}`);
  }
  if (!Number.isFinite(raw.staleMinutes) || raw.staleMinutes < 1 || raw.staleMinutes > 1440) {
    throw new Error(`--stale-minutes 必须在 1..1440，收到 ${raw.staleMinutes}`);
  }

  const requested =
    raw.projection.length === 0
      ? [...DEFAULT_PROJECTION_ORDER]
      : [...new Set(raw.projection.map(normalizeProjectionName))];
  return {
    projections: expandProjectionDependencies(requested),
    rebuild: raw.rebuild,
    includeDeletedPages: raw.includeDeletedPages
      ? true
      : raw.excludeDeletedPages
        ? false
        : null,
    skipTzCheck: raw.skipTzCheck,
    watch: raw.watch,
    intervalMs: Math.round(raw.intervalSeconds * 1_000),
    staleMs: Math.round(raw.staleMinutes * 60_000),
  };
}

main().catch((err) => {
  log.error('致命错误', { error: String(err) });
  emitSummary({ ok: false, status: 'failed', error: String(err) });
  process.exitCode = 1;
});
