import { redirectConsoleToStderr, emitSummary } from '../util/log.js';

redirectConsoleToStderr();

import { loadConfig } from '../config.js';
import { assertTimezoneRoundTrip, createPool, query } from '../store/db.js';

async function main(): Promise<void> {
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
    await query(pool, 'page_scan_maintenance:vacuum', `VACUUM (ANALYZE) meta.page_scan`);
    emitSummary({
      ok: true,
      status: 'ok',
      result: maintained.rows[0]?.result ?? {},
    });
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  emitSummary({ ok: false, status: 'failed', error: String(err) });
  process.exitCode = 1;
});
