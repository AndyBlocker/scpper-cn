/**
 * 结转 v1 ForumThread.pageId 猜测关联。
 *
 * v1 连接全程 BEGIN READ ONLY；目标侧只补空/inferred，verified 永不覆盖。
 * stdout 恰好一行 JSON，便于回填编排器记录数字。
 */

import { createLogger, emitSummary, redirectConsoleToStderr } from '../util/log.js';

redirectConsoleToStderr();

import { Command } from 'commander';
import type { Pool } from 'pg';

import {
  applyInferredForumLinks,
  loadV1InferredForumLinks,
} from '../collect/forumLinks.js';
import { loadConfig, loadEnv } from '../config.js';
import { assertTimezoneRoundTrip, createPool } from '../store/db.js';

const log = createLogger('forum-link-backfill');

interface CliOptions {
  execute: boolean;
  skipTzCheck: boolean;
  v1DatabaseUrl: string;
}

async function main(): Promise<void> {
  loadEnv();
  const opts = parseArgs();
  const config = loadConfig();
  assertDatabaseName(config.databaseUrl, ['scpper-v2'], 'v2 目标库');
  assertDatabaseName(opts.v1DatabaseUrl, ['scpper-cn', 'scpper_cn'], 'v1 只读库');

  const v1 = createPool(opts.v1DatabaseUrl, { max: 1 });
  const v2 = createPool(config.databaseUrl, { max: 2 });
  const started = Date.now();
  try {
    await assertV1ReadOnlyTarget(v1);
    if (!opts.skipTzCheck) await assertTimezoneRoundTrip(v2);
    const links = await loadV1InferredForumLinks(v1);
    const applied = opts.execute
      ? await applyInferredForumLinks(v2, links)
      : {
          selected: links.length,
          applied: 0,
          skippedVerified: 0,
          skippedUnmarkedExisting: 0,
          missingThread: 0,
          missingPage: 0,
          identityMismatch: 0,
        };
    emitSummary({
      ok: applied.identityMismatch === 0,
      status: applied.identityMismatch === 0 ? 'ok' : 'failed',
      dryRun: !opts.execute,
      source: 'v1 ForumThread.pageId',
      pageIdSource: 'inferred',
      ...applied,
      durationMs: Date.now() - started,
    });
    process.exitCode = applied.identityMismatch === 0 ? 0 : 1;
  } catch (err) {
    log.error('论坛关联结转失败', { error: String(err) });
    emitSummary({
      ok: false,
      status: 'failed',
      dryRun: !opts.execute,
      error: String(err),
      durationMs: Date.now() - started,
    });
    process.exitCode = 1;
  } finally {
    await Promise.all([v1.end().catch(() => undefined), v2.end().catch(() => undefined)]);
  }
}

async function assertV1ReadOnlyTarget(pool: Pool): Promise<void> {
  const db = await pool.connect();
  try {
    await db.query('BEGIN READ ONLY');
    const result = await db.query<{ name: string; read_only: string }>(
      `SELECT current_database() AS name,
              current_setting('transaction_read_only') AS read_only`,
    );
    await db.query('ROLLBACK');
    const row = result.rows[0];
    if (!row || !['scpper-cn', 'scpper_cn'].includes(row.name) || row.read_only !== 'on') {
      throw new Error(
        `v1 只读闸不成立：db=${row?.name ?? '?'}, read_only=${row?.read_only ?? '?'}`,
      );
    }
  } finally {
    db.release();
  }
}

function assertDatabaseName(url: string, allowed: readonly string[], label: string): void {
  let name = '';
  try {
    name = decodeURIComponent(new URL(url).pathname.replace(/^\/+/, ''));
  } catch {
    throw new Error(`${label}连接串不是合法 URL`);
  }
  if (!allowed.includes(name)) {
    throw new Error(`${label}必须是 ${allowed.join('|')}，实际 ${name || '(empty)'}`);
  }
}

function parseArgs(): CliOptions {
  const program = new Command();
  program
    .name('forum-link-backfill')
    .description('把 v1 ForumThread.pageId 结转为 inferred；默认 dry-run')
    .option('--execute', '实际写入；默认只读计数')
    .option('--skip-tz-check', '跳过 v2 时区回环（仅本地调试）')
    .option(
      '--v1-database-url <url>',
      'v1 scpper-cn 只读连接',
      process.env['SYNCER2_V1_DATABASE_URL'] ?? process.env['V1_DATABASE_URL'],
    );
  program.parse();
  const raw = program.opts<{
    execute?: boolean;
    skipTzCheck?: boolean;
    v1DatabaseUrl?: string;
  }>();
  if (!raw.v1DatabaseUrl) {
    throw new Error('缺少 --v1-database-url / SYNCER2_V1_DATABASE_URL');
  }
  return {
    execute: raw.execute === true,
    skipTzCheck: raw.skipTzCheck === true,
    v1DatabaseUrl: raw.v1DatabaseUrl,
  };
}

void main();
