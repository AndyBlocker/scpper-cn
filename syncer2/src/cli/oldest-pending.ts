import { redirectConsoleToStderr, emitSummary } from '../util/log.js';

redirectConsoleToStderr();

import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { captureOldestPending } from '../observability/oldestPending.js';
import { assertTimezoneRoundTrip, createPool } from '../store/db.js';
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
    const result = await captureOldestPending(pool);
    budget.checkpoint();
    emitSummary({
      ok: true,
      status: budget.stoppedByRuntimeBudget ? 'partial' : 'ok',
      durationMs: Date.now() - startedMs,
      ...budget.summary(),
      ...result,
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function parseArgs(): number {
  const command = new Command().name('oldest-pending');
  command.configureOutput({
    writeOut: (text) => process.stderr.write(text),
    writeErr: (text) => process.stderr.write(text),
  });
  addRuntimeBudgetOption(command, { defaultSec: 30, minSec: 1, maxSec: 600 });
  command.parse(process.argv);
  return parseRuntimeBudgetSec(command.opts<{ maxRuntimeSec: number }>().maxRuntimeSec, {
    minSec: 1,
    maxSec: 600,
  });
}

main().catch((error) => {
  emitSummary({ ok: false, status: 'failed', error: String(error) });
  process.exitCode = 1;
});
