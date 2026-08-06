import { redirectConsoleToStderr, emitSummary } from '../util/log.js';

redirectConsoleToStderr();

import { loadConfig } from '../config.js';
import { captureOldestPending } from '../observability/oldestPending.js';
import { assertTimezoneRoundTrip, createPool } from '../store/db.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, { max: 2 });
  try {
    await assertTimezoneRoundTrip(pool);
    const result = await captureOldestPending(pool);
    emitSummary({ ok: true, status: 'ok', ...result });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((error) => {
  emitSummary({ ok: false, status: 'failed', error: String(error) });
  process.exitCode = 1;
});
