#!/usr/bin/env node

import { Command, InvalidArgumentError } from 'commander';
import { Pool } from 'pg';

import { loadEnv } from '../config.js';
import {
  VIEW_SOURCE_TABLES,
  assertDatabaseNames,
  assertV1SessionReadOnly,
  assertViewMigrationSchema,
  createV1ReadOnlyClient,
  reconcileViewMigration,
  runViewMigration,
  type ViewMigrationMode,
  type ViewSourceTable,
} from '../migrate/viewEvents.js';

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`必须是正整数，收到 ${value}`);
  }
  return parsed;
}

function mode(value: string): ViewMigrationMode {
  if (value !== 'full' && value !== 'incremental') {
    throw new InvalidArgumentError(`mode 只允许 full 或 incremental，收到 ${value}`);
  }
  return value;
}

function tables(value: string): ViewSourceTable[] {
  const requested = value.split(',').map((item) => item.trim()).filter(Boolean);
  const invalid = requested.filter(
    (item): item is string => !VIEW_SOURCE_TABLES.includes(item as ViewSourceTable),
  );
  if (invalid.length > 0 || requested.length === 0) {
    throw new InvalidArgumentError(
      `tables 只允许 ${VIEW_SOURCE_TABLES.join(',')}，收到 ${value}`,
    );
  }
  return requested as ViewSourceTable[];
}

function requiredEnv(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) throw new Error(`缺少必需环境变量 ${key}`);
  return value;
}

async function main(): Promise<void> {
  loadEnv();
  const program = new Command();
  program
    .name('view-migrate')
    .description('v1→v2 浏览类应用数据迁移；同一实现支持 full 与 incremental')
    .option('--mode <mode>', 'full=首次快照；incremental=切流前追平', mode, 'full')
    .option('--execute', '写入 v2；缺省为只读状态预览', false)
    .option('--batch-size <n>', '每个 v2 事务的来源行数', positiveInt, 2_000)
    .option('--max-batches <n>', '本次最多提交多少批（中断/续跑演练）', positiveInt)
    .option('--max-catchup-passes <n>', '增量高水位连续前移时的安全上限', positiveInt, 20)
    .option('--retry-limit <n>', '每表本轮最多重试多少条未解决映射', positiveInt, 10_000)
    .option('--no-retry-failures', '本轮不重试历史未解决映射')
    .option('--tables <list>', '逗号分隔的来源表白名单', tables, [...VIEW_SOURCE_TABLES])
    .option('--json', '只在 stdout 输出最终 JSON', false)
    .parse(process.argv);
  const options = program.opts<{
    mode: ViewMigrationMode;
    execute: boolean;
    batchSize: number;
    maxBatches?: number;
    maxCatchupPasses: number;
    retryLimit: number;
    retryFailures: boolean;
    tables: ViewSourceTable[];
    json: boolean;
  }>();

  const sourceUrl = requiredEnv('SYNCER2_V1_DATABASE_URL');
  const targetUrl = requiredEnv('SYNCER2_DATABASE_URL');
  assertDatabaseNames(sourceUrl, targetUrl);
  const source = createV1ReadOnlyClient(sourceUrl);
  const pool = new Pool({
    connectionString: targetUrl,
    max: 1,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'syncer2-view-migration-v2',
    options: '-c statement_timeout=0',
  });
  const target = await pool.connect();
  try {
    await source.connect();
    await assertV1SessionReadOnly(source);
    const targetGuard = await target.query<{ database: string; read_only: string }>(
      `SELECT current_database() AS database,
              current_setting('transaction_read_only') AS read_only`,
    );
    if (targetGuard.rows[0]?.database !== 'scpper-v2' || targetGuard.rows[0]?.read_only !== 'off') {
      throw new Error(
        `v2 写入硬关卡失败：db=${targetGuard.rows[0]?.database ?? '<none>'}, ` +
          `read_only=${targetGuard.rows[0]?.read_only ?? '<none>'}`,
      );
    }
    await assertViewMigrationSchema(target);

    const reconciliation = options.execute
      ? await runViewMigration(source, target, {
          mode: options.mode,
          batchSize: options.batchSize,
          maxBatches: options.maxBatches,
          maxCatchupPasses: options.maxCatchupPasses,
          retryFailures: options.retryFailures,
          retryLimit: options.retryLimit,
          tables: options.tables,
          onBatch: options.json
            ? undefined
            : (table, result) => {
                process.stderr.write(
                  `[${table}] scanned=${result.scanned} mapped=${result.mapped} ` +
                    `rejected=${result.rejected} written=${result.insertedOrUpdated}\n`,
                );
              },
        })
      : await reconcileViewMigration(target, options.tables);
    process.stdout.write(
      `${JSON.stringify(
        {
          execute: options.execute,
          mode: options.mode,
          v1ReadOnly: true,
          reconciliation,
        },
        null,
        2,
      )}\n`,
    );
  } finally {
    await source.end().catch(() => undefined);
    target.release();
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
