import { emitSummary } from '../util/log.js';

import path from 'node:path';

import { assertSqlTuningBindings } from '../health/sqlTuningCheck.js';

async function main(): Promise<void> {
  const root = path.resolve(import.meta.dirname, '..');
  await assertSqlTuningBindings(root);
  emitSummary({ ok: true, status: 'ok', checkedRoot: root });
}

main().catch((error) => {
  emitSummary({ ok: false, status: 'failed', error: String(error) });
  process.exitCode = 1;
});
