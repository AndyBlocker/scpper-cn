import { redirectConsoleToStderr, emitSummary } from '../util/log.js';

redirectConsoleToStderr();

import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { assertTimezoneRoundTrip, createPool, query } from '../store/db.js';
import {
  addRuntimeBudgetOption,
  parseRuntimeBudgetSec,
  RuntimeBudget,
} from '../util/runtimeBudget.js';

async function main(): Promise<void> {
  const maxRuntimeSec = parseArgs();
  const budget = new RuntimeBudget(maxRuntimeSec);
  const startedMs = Date.now();
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, { max: 2 });
  try {
    await assertTimezoneRoundTrip(pool);
    const database = await query<{ database: string }>(
      pool,
      'page_scan_maintenance:database_guard',
      `SELECT current_database() AS database`,
    );
    const name = database.rows[0]?.database ?? '';
    if (['scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user'].includes(name)) {
      throw new Error(`拒绝在受保护库 ${name} 执行 page_scan 维护`);
    }
    const maintained = await query<{ result: Record<string, unknown> }>(
      pool,
      'page_scan_maintenance:maintain',
      `SELECT meta.maintain_page_scan(interval '1 hour', interval '30 days') AS result`,
    );
    let vacuumCompleted = false;
    if (!budget.checkpoint()) {
      await query(pool, 'page_scan_maintenance:vacuum', `VACUUM (ANALYZE) meta.page_scan`);
      vacuumCompleted = true;
      budget.checkpoint();
    }
    emitSummary({
      ok: true,
      status: budget.stoppedByRuntimeBudget ? 'partial' : 'ok',
      result: maintained.rows[0]?.result ?? {},
      vacuumCompleted,
      durationMs: Date.now() - startedMs,
      ...budget.summary(),
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function parseArgs(): number {
  const command = new Command().name('page-scan-maintenance');
  command.configureOutput({
    writeOut: (text) => process.stderr.write(text),
    writeErr: (text) => process.stderr.write(text),
  });
  addRuntimeBudgetOption(command, { defaultSec: 60, minSec: 1, maxSec: 3_600 });
  command.parse(process.argv);
  return parseRuntimeBudgetSec(command.opts<{ maxRuntimeSec: number }>().maxRuntimeSec, {
    minSec: 1,
    maxSec: 3_600,
  });
}

main().catch((err) => {
  emitSummary({ ok: false, status: 'failed', error: String(err) });
  process.exitCode = 1;
});
