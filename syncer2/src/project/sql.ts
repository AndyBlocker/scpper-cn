import type { PoolClient, QueryResultRow } from 'pg';
import { query } from '../store/db.js';

export async function exec(
  client: PoolClient,
  label: string,
  sql: string,
  params?: readonly unknown[],
): Promise<number> {
  const result = await query(client, label, sql, params);
  return result.rowCount ?? 0;
}

export async function rows<R extends QueryResultRow>(
  client: PoolClient,
  label: string,
  sql: string,
  params?: readonly unknown[],
): Promise<R[]> {
  return (await query<R>(client, label, sql, params)).rows;
}

export function asNumber(value: string | number | null | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${label} 不是安全整数：${String(value)}`);
  }
  return parsed;
}

/**
 * 事实时间切日的唯一 SQL 表达式。
 *
 * bootstrap 在调用方 WHERE 中整体排除；这里故意不为它提供分支，避免后来有人
 * “顺手复用”时把 166 万冷启动票重新塞回逐日投影。
 */
export const VOTE_DAY_SQL = `CASE
  WHEN ve.time_precision IN ('exact', 'observed')
    THEN (ve.occurred_at AT TIME ZONE 'Asia/Shanghai')::date
  WHEN ve.time_precision IN ('day', 'clamped')
    THEN (ve.occurred_at AT TIME ZONE 'UTC')::date
END`;

/** vote/revote/revoke 对页面 rating 的状态转移增量。 */
export const RATING_DELTA_SQL =
  `(COALESCE(ve.new_direction, 0) - COALESCE(ve.old_direction, 0))`;

