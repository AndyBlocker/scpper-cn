/**
 * 测试用 pg 会话门面（多连接）。
 *
 * ── 为什么要单独一层，而不是直接用 src/store/db.ts 的 Pool ──────────────────────
 * 本目录里的三组测试（T7.1/T7.2 乱序提交注入、T5.2 大批与属性、T6.6 权限被拒）
 * 全都需要**把连接当作有身份的会话来控制**：
 *   · T7 要让会话 A 停在"已分配 seq、尚未提交"的状态，同时用会话 B 去读安全水位。
 *     Pool 的 `withTransaction` 是"进去-出来"的闭包语义，表达不了"停在中间"。
 *   · T7.5 要断言 `meta.ingest_gate` 的行在 A 未提交时对 B **不可见**（MVCC 边界），
 *     这条断言只有在"两个物理连接"上才成立 —— 同一个连接怎么写都看不出问题。
 *   · T6.6 要 `SET ROLE bff_role` 再复位，连接必须是独占的（池化连接被别的查询借走
 *     就会带着残留的 role 跑，属于典型的池化陷阱）。
 * 所以这里用裸 `Client`（一连接一会话），不用池。
 *
 * 沿用 src/store/db.ts 的两条纪律：
 *   1. 时间参数一律走 `toPgTimestamptz()` 出 ISO UTC 字符串 + SQL 里显式 `::timestamptz`；
 *   2. `assertNoRawDates()` 拒收裸 Date（v1 MainDbBridge 8 小时偏移 bug 的结构性防线）。
 */

import { Client, type QueryResultRow } from 'pg';
import * as dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertNoRawDates, toPgTimestamptz } from '../../src/store/db.js';

export { toPgTimestamptz };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** syncer2 项目根（tests/helpers 的上两级）。 */
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

let envLoaded = false;
function loadEnvOnce(): void {
  if (envLoaded) return;
  dotenv.config({ path: path.join(PROJECT_ROOT, '.env'), quiet: true });
  envLoaded = true;
}

/**
 * 受保护库黑名单。与 migrations/apply.sh 的黑名单同源、同理由：
 * 并行期 v1 主库是**只读**的，测试要写数据，所以必须在连库之前就把这条物理闸落下。
 * 含 URL 解码：`scpper%2Dcn` 这种写法绕不过去。
 */
const PROTECTED_DBS = new Set([
  'scpper-cn',
  'scpper_cn',
  'scpper-syncer',
  'scpper_syncer',
  'scpper_user',
  'postgres',
  'template0',
  'template1',
]);

function parseDbName(url: string): string {
  // 连接串里库名带连字符，URL 形式解析最稳；解析失败时退回字符串切分。
  try {
    const u = new URL(url);
    return decodeURIComponent(u.pathname.replace(/^\//, ''));
  } catch {
    const m = /\/([^/?]+)(\?|$)/.exec(url);
    return m?.[1] ? decodeURIComponent(m[1]) : '';
  }
}

/**
 * 解析测试目标库连接串。优先级：
 *   SYNCER2_TEST_DATABASE_URL > SYNCER2_DATABASE_URL > DATABASE_URL
 * 落在受保护库上直接抛错拒绝启动。
 */
export function resolveTestDatabaseUrl(): string {
  loadEnvOnce();
  const url =
    process.env.SYNCER2_TEST_DATABASE_URL ??
    process.env.SYNCER2_DATABASE_URL ??
    process.env.DATABASE_URL;
  if (!url || url.trim() === '') {
    throw new Error(
      '缺少数据库连接串：请设置 SYNCER2_TEST_DATABASE_URL 或 SYNCER2_DATABASE_URL' +
        '（指向 scpper-v2，绝不能指向 v1 主库 scpper-cn）',
    );
  }
  const db = parseDbName(url.trim());
  if (PROTECTED_DBS.has(db)) {
    throw new Error(
      `拒绝在受保护库「${db}」上运行测试。v2 的测试会真实写入数据，` +
        `并行期 v1 主库 scpper-cn 只读。请把连接串指向 scpper-v2。`,
    );
  }
  return url.trim();
}

export interface SqlError {
  sqlstate: string;
  message: string;
}

export class SyntheticTestWriteError extends Error {
  override readonly name = 'SyntheticTestWriteError';
}

const SYNTHETIC_PAGE_FEATURE = /^(?:test|synthetic)-(?:image-)?page-[0-9]{10,}$/i;
const SYNTHETIC_USER_FEATURE = /^(?:test|synthetic)-(?:image-)?(?:user|actor)-[0-9]{10,}$/i;

/**
 * 客户端第一道门：只审查明确写向 serve/ingest 的语句及其绑定值。
 * `test-log-*` 等真实站点 slug 不命中；数据库 0042 触发器是不可绕过的第二道门。
 */
export function assertNoSyntheticServeIngestWrite(
  sql: string,
  params: readonly unknown[] | undefined,
): void {
  if (!/\b(?:insert\s+into|update)\s+(?:serve|ingest)\b/i.test(sql)
      && !/\bingest\.(?:register_page|ensure_user)\s*\(/i.test(sql)) {
    return;
  }
  const strings = (params ?? []).flatMap((value) => {
    if (typeof value === 'string') return [value];
    if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
    return [];
  });
  const inlineTokens = sql.match(/[a-z0-9:_-]+/gi) ?? [];
  const offending = [...strings, ...inlineTokens].find(
    (value) => SYNTHETIC_PAGE_FEATURE.test(value) || SYNTHETIC_USER_FEATURE.test(value),
  );
  if (offending !== undefined) {
    throw new SyntheticTestWriteError(
      `拒绝测试把合成身份写入 serve/ingest：${offending}。请使用事务回滚固件或纯解析测试。`,
    );
  }
}

/** 一个独占连接 = 一个可以停在事务中间的会话。 */
export class Sess {
  readonly name: string;
  private readonly client: Client;
  private connected = false;

  constructor(name: string, url = resolveTestDatabaseUrl()) {
    this.name = name;
    this.client = new Client({ connectionString: url, application_name: `syncer2-test:${name}` });
  }

  async connect(): Promise<this> {
    if (!this.connected) {
      await this.client.connect();
      this.connected = true;
      // 会话时区固定 UTC：测试里所有时间断言都用 epoch 比，避免本机 TZ 参与决策。
      await this.client.query(`SET TIME ZONE 'UTC'`);
    }
    return this;
  }

  async end(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.client.end();
  }

  async q<R extends QueryResultRow = QueryResultRow>(
    label: string,
    sql: string,
    params?: readonly unknown[],
  ): Promise<R[]> {
    assertNoRawDates(params, `${this.name}/${label}`);
    assertNoSyntheticServeIngestWrite(sql, params);
    const res = await this.client.query<R>(sql, params as unknown[] | undefined);
    return res.rows;
  }

  /** 取唯一一行；0 行或多行都是测试自身的 bug，直接抛。 */
  async one<R extends QueryResultRow = QueryResultRow>(
    label: string,
    sql: string,
    params?: readonly unknown[],
  ): Promise<R> {
    const rows = await this.q<R>(label, sql, params);
    if (rows.length !== 1) {
      throw new Error(`[${this.name}/${label}] 期望恰好 1 行，实得 ${rows.length} 行`);
    }
    return rows[0] as R;
  }

  /** 取单值（单行单列）。 */
  async val<T>(label: string, sql: string, params?: readonly unknown[]): Promise<T> {
    const row = await this.one<QueryResultRow>(label, sql, params);
    const keys = Object.keys(row);
    if (keys.length !== 1) {
      throw new Error(`[${this.name}/${label}] 期望单列，实得 ${keys.length} 列`);
    }
    return row[keys[0] as string] as T;
  }

  /** 取 bigint 单值并转 number（seq / 计数场景，量级远小于 2^53）。 */
  async num(label: string, sql: string, params?: readonly unknown[]): Promise<number | null> {
    const v = await this.val<string | number | null>(label, sql, params);
    return v === null ? null : Number(v);
  }

  async begin(): Promise<void> {
    await this.q('begin', 'BEGIN');
  }
  async commit(): Promise<void> {
    await this.q('commit', 'COMMIT');
  }
  async rollback(): Promise<void> {
    await this.q('rollback', 'ROLLBACK');
  }

  /**
   * 「这条语句必须抛错」。返回捕获到的 sqlstate + message，由调用方断言。
   * 注意：PG 里一条语句报错会把整个事务打成 aborted，所以在事务中使用时
   * 必须自己套 SAVEPOINT —— 本方法自动处理（`inTx` 为 true 时）。
   */
  async expectError(
    label: string,
    sql: string,
    params?: readonly unknown[],
    inTx = false,
  ): Promise<SqlError> {
    const sp = `sp_${Math.random().toString(36).slice(2, 10)}`;
    if (inTx) await this.q('savepoint', `SAVEPOINT ${sp}`);
    try {
      await this.q(label, sql, params);
      if (inTx) await this.q('release', `RELEASE SAVEPOINT ${sp}`);
      throw new Error(`[${this.name}/${label}] 本应抛错但成功执行了`);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      if (!e.code) throw err; // 不是 PG 错误（比如上面那条"本应抛错"），原样抛出
      if (inTx) await this.q('rollback-to', `ROLLBACK TO SAVEPOINT ${sp}`);
      return { sqlstate: e.code, message: String(e.message ?? '') };
    }
  }
}

/** 建连接并连上（简写）。 */
export async function openSess(name: string): Promise<Sess> {
  return new Sess(name).connect();
}
