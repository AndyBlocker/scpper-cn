/**
 * pg 连接池 + **时区硬守卫**。
 *
 * ── 为什么这个文件有一半是时区代码 ──────────────────────────────────────────
 * v1 的 syncer/src/bridge/MainDbBridge.ts 有一个已实测确认的 BLOCKER：它用裸 node-pg
 * 直接把 JS `Date` 作为参数传给 INSERT。node-pg 会把 Date 序列化成**带本地偏移**的字符串
 * （进程 TZ=Asia/Shanghai），而主库那些列是 `timestamp without time zone`，PG 转换时丢掉
 * 偏移、保留上海墙钟 → 同一个 unix 秒数落库比 Prisma 路径晚 8 小时。而 analytics 侧又做
 * `(ts AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai'`，等于再叠一次 → 16h 偏移、跨日界串日。
 * 更糟的是这类偏差在 v1/v2 每日对账里表现为"页面元数据不一致"，没人会想到是时区。
 *
 * syncer2 用三道结构性守卫让它**不可能复发**：
 *   1. `toPgTimestamptz()` 是唯一的时间入口，返回 ISO UTC **字符串**；
 *   2. `query()` 对参数做 `assertNoRawDates()` —— 传 Date 直接抛，不给"能跑但错 8 小时"的机会；
 *   3. `assertTimezoneRoundTrip()` 启动自检：拿一个已知 epoch 真写进临时表再读回来比对，
 *      并在 UTC 与 Asia/Shanghai 两种会话时区下各跑一遍，两次必须得到同一个 epoch。
 *      不等即拒绝启动。
 * 另外所有 SQL 里的时间参数都写显式 `::timestamptz` 转型 —— 让类型推断不参与决策。
 */

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import { createLogger } from '../util/log.js';
import { sanitizePgValue } from './pgText.js';

const log = createLogger('db');

export class TimezoneGuardError extends Error {
  override readonly name = 'TimezoneGuardError';
}

export class RawDateParamError extends Error {
  override readonly name = 'RawDateParamError';
}

export function createPool(connectionString: string, opts: { max?: number } = {}): Pool {
  const pool = new Pool({
    connectionString,
    max: opts.max ?? 4,
    // 短进程模型：连接空转 5s 就该回收，进程本来也只活几秒。
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'syncer2',
  });
  pool.on('error', (err) => log.error('pool error', { error: String(err) }));
  return pool;
}

/**
 * 唯一合法的时间参数构造器：产出 ISO-8601 UTC 字符串（形如 2026-07-27T12:34:56.000Z）。
 * 配合 SQL 里的显式 `::timestamptz`，PG 会按 UTC 解释 Z 后缀，与会话时区无关。
 */
export function toPgTimestamptz(v: Date | string | number): string {
  if (v instanceof Date) {
    if (!Number.isFinite(v.getTime())) throw new TypeError('toPgTimestamptz: Invalid Date');
    return v.toISOString();
  }
  if (typeof v === 'number') {
    const d = new Date(v);
    if (!Number.isFinite(d.getTime())) throw new TypeError(`toPgTimestamptz: 非法时间戳 ${v}`);
    return d.toISOString();
  }
  const t = Date.parse(v);
  if (!Number.isFinite(t)) throw new TypeError(`toPgTimestamptz: 无法解析时间字符串 ${v}`);
  return new Date(t).toISOString();
}

/** 现在（ISO UTC 字符串）。 */
export function nowPg(): string {
  return new Date().toISOString();
}

/**
 * 拒绝把裸 Date 传给 node-pg。这是 MainDbBridge 8 小时偏移 bug 的**结构性**防线：
 * 不是"记得别这么写"，而是"这么写跑不起来"。
 */
export function assertNoRawDates(params: readonly unknown[] | undefined, label: string): void {
  if (!params) return;
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p instanceof Date) {
      throw new RawDateParamError(
        `[${label}] 第 $${i + 1} 个参数是裸 Date。node-pg 会把它序列化成带本地偏移的字符串，` +
          `落 timestamp 列即产生 8 小时偏移（v1 MainDbBridge 的既成 bug）。` +
          `请改用 toPgTimestamptz(date) 并在 SQL 里写显式 ::timestamptz。`,
      );
    }
    if (Array.isArray(p) && p.some((x) => x instanceof Date)) {
      throw new RawDateParamError(`[${label}] 第 $${i + 1} 个参数是含 Date 的数组，同上。`);
    }
  }
}

/** 带守卫的查询入口。所有 SQL 都应当走这里，而不是直接 pool.query。 */
export async function query<R extends QueryResultRow = QueryResultRow>(
  db: Pool | PoolClient,
  label: string,
  sql: string,
  params?: readonly unknown[],
): Promise<QueryResult<R>> {
  assertNoRawDates(params, label);
  const safeParams =
    params === undefined
      ? undefined
      : sanitizePgValue(params, { context: `query:${label}` }).value;
  const startedAt = Date.now();
  try {
    const res = await db.query<R>(sql, safeParams as unknown[] | undefined);
    log.debug('query ok', { label, rows: res.rowCount, ms: Date.now() - startedAt });
    return res;
  } catch (err) {
    log.error('query failed', { label, ms: Date.now() - startedAt, error: String(err) });
    throw err;
  }
}

export async function withTransaction<T>(
  pool: Pool,
  label: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    log.error('transaction rolled back', { label, error: String(err) });
    throw err;
  } finally {
    client.release();
  }
}

// ─── 时区启动自检 ────────────────────────────────────────────────────────────

/** 一个**没有整点/整日对称性**的已知时刻，任何 ±整小时偏移都会被打出来。 */
const PROBE_EPOCH_MS = Date.UTC(2026, 6, 27, 12, 34, 56, 789); // 2026-07-27T12:34:56.789Z

export interface TimezoneProbeReport {
  probeIso: string;
  probeEpochMs: number;
  serverTimeZone: string;
  /** 在这些会话时区下各跑一遍，结果必须全部相等。 */
  sessionZonesTested: string[];
  processTz: string;
  processClockSkewMs: number;
}

/**
 * 写一个已知 epoch 进临时表、读回来比对；不等即抛 TimezoneGuardError（调用方拒绝启动）。
 *
 * 用 `CREATE TEMP TABLE ... ON COMMIT DROP` 而不是往真表里写：
 *   · 真正走了 INSERT → 参数绑定 → 存储 → 读取 → 驱动反序列化 的完整回环
 *     （只 `SELECT $1::timestamptz` 是测不出存储层问题的）；
 *   · 临时表不需要任何 schema 权限，也不污染 v2 库（任务 A-D 才是建表的人）。
 *
 * 三重比对：
 *   a) PG 侧 `extract(epoch from ts)` === 已知 epoch（证明存进去的是对的瞬间）；
 *   b) node-pg 反序列化出的 Date.getTime() === 已知 epoch（证明读回来也是对的瞬间）；
 *   c) 在 UTC 与 Asia/Shanghai 两种会话时区下 a/b 都成立且彼此相等
 *      （证明结果与会话时区无关 —— 这正是 v1 踩坑的那一维）。
 */
export async function assertTimezoneRoundTrip(pool: Pool): Promise<TimezoneProbeReport> {
  const probeIso = new Date(PROBE_EPOCH_MS).toISOString();
  const sessionZones = ['UTC', 'Asia/Shanghai'];
  const client = await pool.connect();
  try {
    const tzRow = await client.query<{ tz: string; now_ms: string }>(
      `SELECT current_setting('TimeZone') AS tz, (extract(epoch from now()) * 1000)::text AS now_ms`,
    );
    const serverTimeZone = tzRow.rows[0]?.tz ?? '(unknown)';
    const serverNowMs = Number(tzRow.rows[0]?.now_ms ?? '0');

    for (const zone of sessionZones) {
      await client.query('BEGIN');
      try {
        await client.query(`SET LOCAL TIME ZONE '${zone}'`);
        await client.query(
          `CREATE TEMP TABLE syncer2_tz_probe (id int PRIMARY KEY, ts timestamptz NOT NULL) ON COMMIT DROP`,
        );
        assertNoRawDates([probeIso], 'tz-probe');
        await client.query(`INSERT INTO syncer2_tz_probe (id, ts) VALUES (1, $1::timestamptz)`, [
          probeIso,
        ]);
        const back = await client.query<{ pg_ms: string; ts: Date }>(
          `SELECT (extract(epoch from ts) * 1000)::text AS pg_ms, ts FROM syncer2_tz_probe WHERE id = 1`,
        );
        const row = back.rows[0];
        if (!row) throw new TimezoneGuardError(`时区自检：临时表读回 0 行（会话时区 ${zone}）`);

        const pgMs = Number(row.pg_ms);
        if (pgMs !== PROBE_EPOCH_MS) {
          throw new TimezoneGuardError(
            `时区自检失败（PG 侧，会话时区 ${zone}）：写入 ${probeIso}（epoch ${PROBE_EPOCH_MS}），` +
              `PG 读回 epoch ${pgMs}，偏差 ${(pgMs - PROBE_EPOCH_MS) / 3_600_000} 小时。` +
              `这正是 v1 MainDbBridge 的 8 小时偏移模式。拒绝启动。`,
          );
        }

        const driverMs = row.ts instanceof Date ? row.ts.getTime() : Date.parse(String(row.ts));
        if (driverMs !== PROBE_EPOCH_MS) {
          throw new TimezoneGuardError(
            `时区自检失败（驱动侧，会话时区 ${zone}）：node-pg 反序列化得到 epoch ${driverMs}，` +
              `期望 ${PROBE_EPOCH_MS}，偏差 ${(driverMs - PROBE_EPOCH_MS) / 3_600_000} 小时。拒绝启动。`,
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    }

    const processClockSkewMs = Math.abs(serverNowMs - Date.now());
    if (processClockSkewMs > 5 * 60_000) {
      // 只告警不拒启动：DB 与本机时钟不同步不影响时区正确性，但会让 lastmod 比较的"新鲜度"判断失真。
      log.warn('DB 与本进程时钟偏差超过 5 分钟', { processClockSkewMs, serverTimeZone });
    }

    const report: TimezoneProbeReport = {
      probeIso,
      probeEpochMs: PROBE_EPOCH_MS,
      serverTimeZone,
      sessionZonesTested: sessionZones,
      processTz: process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      processClockSkewMs,
    };
    log.info('assertTimezoneRoundTrip 通过', report);
    return report;
  } finally {
    client.release();
  }
}
