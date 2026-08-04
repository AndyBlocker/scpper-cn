/**
 * qqbot 轮询入口：只读 scpper-v2，stdout 恰好一行无敏感字段的 JSON。
 */

import { createLogger, emitSummary, redirectConsoleToStderr } from '../util/log.js';

redirectConsoleToStderr();

import { loadConfig } from '../config.js';
import { collectImReconcileReport } from '../reconcile/im.js';
import { assertTimezoneRoundTrip, createPool, query } from '../store/db.js';

const log = createLogger('qq-report');

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl, { max: 2 });
  try {
    await assertTimezoneRoundTrip(pool);
    const target = await query<{ db: string }>(
      pool,
      'qq-report:target',
      `SELECT current_database() AS db`,
    );
    if (target.rows[0]?.db !== 'scpper-v2') {
      throw new Error(`QQ 简报只允许读取 scpper-v2，实际为 ${target.rows[0]?.db ?? '?'}`);
    }
    emitSummary(await collectImReconcileReport(pool));
  } finally {
    await pool.end().catch(() => undefined);
  }
}

main().catch((err) => {
  log.error('生成 QQ 简报失败', {
    error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  });
  process.exitCode = 1;
});
