/**
 * 时区回环守卫测试（README「后续 TODO」#11 第三组）。
 *
 * 正对照：assertTimezoneRoundTrip() 在**正确写法**（toPgTimestamptz + 显式 ::timestamptz +
 *         timestamptz 列）下通过。
 * 负对照：重演 v1 `syncer/src/bridge/MainDbBridge.ts` 的**裸 Date 写法**，断言它确实产生
 *         +8 小时偏移、并在 analytics 的二次换算下变成 +16 小时跨日串日。
 *
 * 为什么必须有负对照：一道守卫如果从来没见过它要防的失效模式，就无法证明它还瞄得准。
 * 将来若有人"顺手简化"（把 toPgTimestamptz 去掉、把列改回 timestamp without time zone、
 * 或把 assertNoRawDates 注释掉），负对照这几条会立刻变红，并且红的地方直接指出病因。
 * 负对照全程只写 **TEMP 表**，不碰 v2 的任何真实表，也绝不连主库（见下面的连接串硬关卡）。
 *
 * 运行前提：scpper-v2 可连（SYNCER2_DATABASE_URL）。**刻意不做"连不上就 skip"**——
 * 静默跳过的守卫等于没有守卫，这与本项目"空结果与失败必须可区分"的红线是同一条原则。
 */

// 进程时区必须是 Asia/Shanghai：v1 那个 bug 的产生条件之一就是进程 TZ 非 UTC，
// 负对照要复现它就必须在这个时区下跑。ESM 的 import 会被提升到本行之前执行，
// 但 node-pg 序列化 Date 时才调 getTimezoneOffset()，而 Node 在 process.env.TZ
// 被赋值时会重置 V8 的时区缓存 —— 所以此处赋值有效（已实测：offset = -480）。
process.env.TZ = 'Asia/Shanghai';
process.env.SYNCER2_LOG_LEVEL = 'error';

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';

import { loadConfig } from '../src/config.js';
import {
  RawDateParamError,
  TimezoneGuardError,
  assertNoRawDates,
  assertTimezoneRoundTrip,
  createPool,
  nowPg,
  query,
  toPgTimestamptz,
  withTransaction,
} from '../src/store/db.js';
import { recordPageScan, startIngestRun } from '../src/store/meta.js';
import {
  PAGE_SCAN_ERROR_MAX_UTF8_BYTES,
  pgTextSanitizationCounters,
  sanitizePageScanError,
  sanitizePgText,
  toPgJson,
} from '../src/store/pgText.js';

/** 与 db.ts 里同一个"无整点/整日对称性"的探针时刻。 */
const PROBE_EPOCH_MS = Date.UTC(2026, 6, 27, 12, 34, 56, 789); // 2026-07-27T12:34:56.789Z
const PROBE_ISO = new Date(PROBE_EPOCH_MS).toISOString();
const HOUR_MS = 3_600_000;

let pool: Pool;
let databaseUrl: string;

before(() => {
  const config = loadConfig({ requireDatabase: true });
  databaseUrl = config.databaseUrl;
  // ★ 硬关卡：只允许打到 scpper-v2。主库 scpper-cn 是只读生产库，测试连都不许连。
  const dbName = new URL(config.databaseUrl).pathname.replace(/^\//, '');
  assert.equal(
    dbName,
    'scpper-v2',
    `测试只允许连 scpper-v2，当前是 "${dbName}"。主库 scpper-cn 只读，禁止任何写入（含 TEMP 表）。`,
  );
  // max:1 —— 后面几条断言依赖"同一个会话"（TEMP 表是会话级的）。
  pool = createPool(config.databaseUrl, { max: 1 });
});

after(async () => {
  await pool?.end().catch(() => undefined);
});

// ─── 时间入口：纯函数部分 ────────────────────────────────────────────────────

describe('toPgTimestamptz：唯一合法的时间参数构造器', () => {
  it('Date / number / string 三种入参都产出 ISO UTC 字符串', () => {
    assert.equal(toPgTimestamptz(new Date(PROBE_EPOCH_MS)), PROBE_ISO);
    assert.equal(toPgTimestamptz(PROBE_EPOCH_MS), PROBE_ISO);
    assert.equal(toPgTimestamptz(PROBE_ISO), PROBE_ISO);
    assert.equal(typeof toPgTimestamptz(new Date()), 'string', '返回的必须是字符串而不是 Date');
  });

  it('带偏移的字符串被换算到 UTC（不是截断偏移）', () => {
    // 进程 TZ=Asia/Shanghai，这个输入正是 v1 落库后看到的那种"上海墙钟"
    assert.equal(toPgTimestamptz('2026-07-27T20:34:56.789+08:00'), PROBE_ISO);
    assert.equal(toPgTimestamptz('2026-07-27T12:34:56.789Z'), PROBE_ISO);
  });

  it('**无时区的字符串按本地时区解释** —— 已知语义，钉住免得被当成新 bug', () => {
    // Date.parse('2026-07-27T20:34:56.789')（无 Z/无偏移）按 ES 规范作本地时间处理，
    // 在 TZ=Asia/Shanghai 下等价于 12:34:56.789Z。所以：**上游给的时间字符串必须带时区**，
    // 否则正确性依赖进程 TZ。sitemap 的 lastmod 实测 100% 带 +00:00，无此风险；
    // 将来接 ListPages/AMC 的裸时间串时，必须在解析处补时区，而不是指望这里。
    assert.equal(toPgTimestamptz('2026-07-27T20:34:56.789'), PROBE_ISO);
  });

  it('非法输入抛 TypeError（不静默产生一个"看起来对"的时间）', () => {
    assert.throws(() => toPgTimestamptz(new Date('nope')), /Invalid Date/);
    assert.throws(() => toPgTimestamptz('not-a-date'), /无法解析时间字符串/);
    assert.throws(() => toPgTimestamptz(Number.NaN), /非法时间戳/);
  });

  it('nowPg() 是 ISO UTC 字符串且以 Z 结尾', () => {
    const s = nowPg();
    assert.match(s, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.ok(Math.abs(Date.parse(s) - Date.now()) < 5_000);
  });
});

describe('assertNoRawDates：裸 Date 参数在到达驱动之前就被拦住', () => {
  it('Date / 含 Date 的数组 → RawDateParamError，且错误信息给出正确写法', () => {
    assert.throws(() => assertNoRawDates([new Date()], 'test'), (err: unknown) => {
      assert.ok(err instanceof RawDateParamError, `应当是 RawDateParamError，实际 ${err}`);
      assert.match(err.message, /第 \$1 个参数是裸 Date/);
      assert.match(err.message, /8 小时偏移/);
      assert.match(err.message, /toPgTimestamptz/); // 告诉人怎么改
      return true;
    });
    assert.throws(() => assertNoRawDates(['a', 1, new Date()], 'test'), /第 \$3 个参数是裸 Date/);
    assert.throws(() => assertNoRawDates([[new Date()]], 'test'), /含 Date 的数组/);
  });

  it('合法参数（字符串/数字/null/undefined/无参）一律放行', () => {
    assert.doesNotThrow(() => assertNoRawDates([PROBE_ISO, 1, null, undefined], 'test'));
    assert.doesNotThrow(() => assertNoRawDates(undefined, 'test'));
    assert.doesNotThrow(() => assertNoRawDates([], 'test'));
  });

  it('query() 在**碰到驱动之前**就拒绝：假 db 的 query 一次都不会被调用', async () => {
    let called = 0;
    const fakeDb = {
      query: () => {
        called++;
        throw new Error('不该被调用');
      },
    } as unknown as Pool;
    await assert.rejects(
      query(fakeDb, 'test:raw-date', 'INSERT INTO t (ts) VALUES ($1)', [new Date()]),
      RawDateParamError,
    );
    assert.equal(called, 0, '守卫必须前置于驱动调用，否则错误的值可能已经上线');
  });
});

// ─── 正对照：启动自检真的通过 ───────────────────────────────────────────────

describe('assertTimezoneRoundTrip：正确写法下通过（启动自检 #2）', () => {
  it('回环通过，报告字段齐全，两种会话时区都测了', async () => {
    const report = await assertTimezoneRoundTrip(pool);
    assert.equal(report.probeEpochMs, PROBE_EPOCH_MS);
    assert.equal(report.probeIso, PROBE_ISO);
    assert.deepEqual(report.sessionZonesTested, ['UTC', 'Asia/Shanghai']);
    assert.ok(report.serverTimeZone.length > 0);
    assert.equal(report.processTz, 'Asia/Shanghai');
    assert.equal(typeof report.processClockSkewMs, 'number');
    assert.ok(report.processClockSkewMs >= 0);
  });

  it('自检不留痕：ON COMMIT DROP 之后临时表不存在（同一会话验证）', async () => {
    const res = await query<{ reg: string | null }>(
      pool,
      'test:no-leak',
      `SELECT to_regclass('syncer2_tz_probe')::text AS reg`,
    );
    assert.equal(res.rows[0]!.reg, null, '自检的临时表必须不残留（也不需要任何 schema 权限）');
  });

  it('幂等：连跑两次都通过（自检写在启动路径上，必须能反复执行）', async () => {
    await assertTimezoneRoundTrip(pool);
    await assertTimezoneRoundTrip(pool);
  });

  it('TimezoneGuardError 是独立错误类型（调用方要能据此拒绝启动）', () => {
    const e = new TimezoneGuardError('x');
    assert.equal(e.name, 'TimezoneGuardError');
    assert.ok(e instanceof Error);
  });
});

// ─── 负对照：重演 v1 的裸 Date 写法 ─────────────────────────────────────────

describe('负对照：v1 MainDbBridge 的裸 Date 写法确实错 8 小时', () => {
  it('前置条件：进程时区是 Asia/Shanghai（否则这组负对照没有意义）', () => {
    assert.equal(
      new Date(PROBE_EPOCH_MS).getTimezoneOffset(),
      -480,
      '本组测试必须在 TZ=Asia/Shanghai 下运行（文件顶部已设置）',
    );
  });

  /**
   * 一次事务里同时跑三条路径，共用同一个瞬间：
   *   A. v1 写法：裸 Date → `timestamp without time zone` 列（**绕过** query() 的守卫，
   *      直接调 client.query —— 因为要测的正是"守卫不在时会怎样"）
   *   B. v1 写法：裸 Date → `timestamptz` 列
   *   C. v2 写法：toPgTimestamptz 字符串 + 显式 ::timestamptz → `timestamptz` 列
   */
  async function replay(): Promise<{
    naiveText: string;
    naiveAsUtcMs: number;
    naiveDoubleShiftedMs: number;
    naiveDateText: string;
    v1IntoTimestamptzMs: number;
    v2Ms: number;
    v2DriverMs: number;
  }> {
    const client: PoolClient = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `CREATE TEMP TABLE v1_replay (
           id            int PRIMARY KEY,
           ts_naive      timestamp   NOT NULL,  -- v1 主库那些列的类型
           ts_tz         timestamptz NOT NULL
         ) ON COMMIT DROP`,
      );
      const rawDate = new Date(PROBE_EPOCH_MS);
      // 这里刻意不走 query()：query() 会用 assertNoRawDates 把它拦住（那正是修复本身）。
      await client.query('INSERT INTO v1_replay (id, ts_naive, ts_tz) VALUES (1, $1, $2)', [
        rawDate,
        rawDate,
      ]);
      // 注意两个占位符不能共用一个 $1：同一参数被推断成 timestamp 与 timestamptz 两种类型时
      // PG 直接报 42P08（inconsistent types deduced for parameter）。各写一次转型最清楚。
      await client.query(
        `INSERT INTO v1_replay (id, ts_naive, ts_tz)
         VALUES (2, $1::timestamptz AT TIME ZONE 'UTC', $2::timestamptz)`,
        [toPgTimestamptz(rawDate), toPgTimestamptz(rawDate)],
      );

      const r = await client.query<{
        naive_text: string;
        naive_as_utc_ms: string;
        naive_double_ms: string;
        naive_date_text: string;
        v1_tz_ms: string;
        v2_ms: string;
        v2_ts: Date;
      }>(
        `SELECT
           (SELECT ts_naive::text FROM v1_replay WHERE id = 1)                      AS naive_text,
           (SELECT (extract(epoch from ts_naive AT TIME ZONE 'UTC') * 1000)::text
              FROM v1_replay WHERE id = 1)                                          AS naive_as_utc_ms,
           -- analytics 侧的二次换算：(ts AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai'
           (SELECT (extract(epoch from ((ts_naive AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai')) * 1000)::text
              FROM v1_replay WHERE id = 1)                                          AS naive_double_ms,
           (SELECT ts_naive::date::text FROM v1_replay WHERE id = 1)                AS naive_date_text,
           (SELECT (extract(epoch from ts_tz) * 1000)::text FROM v1_replay WHERE id = 1) AS v1_tz_ms,
           (SELECT (extract(epoch from ts_tz) * 1000)::text FROM v1_replay WHERE id = 2) AS v2_ms,
           (SELECT ts_tz FROM v1_replay WHERE id = 2)                               AS v2_ts`,
      );
      const row = r.rows[0]!;
      await client.query('COMMIT');
      return {
        naiveText: row.naive_text,
        naiveAsUtcMs: Number(row.naive_as_utc_ms),
        naiveDoubleShiftedMs: Number(row.naive_double_ms),
        naiveDateText: row.naive_date_text,
        v1IntoTimestamptzMs: Number(row.v1_tz_ms),
        v2Ms: Number(row.v2_ms),
        v2DriverMs: row.v2_ts instanceof Date ? row.v2_ts.getTime() : Date.parse(String(row.v2_ts)),
      };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  it('裸 Date → timestamp 列：落库是上海墙钟，按 UTC 读回恰好晚 8 小时', async () => {
    const r = await replay();
    // node-pg 把 Date 序列化成 '2026-07-27T20:34:56.789+08:00'，
    // timestamp without time zone 丢掉偏移只留墙钟 → 20:34:56.789
    assert.equal(r.naiveText, '2026-07-27 20:34:56.789');
    assert.equal((r.naiveAsUtcMs - PROBE_EPOCH_MS) / HOUR_MS, 8, '这就是 v1 的 8 小时偏移');
  });

  it('analytics 的二次换算把 8 小时叠成 16 小时，并且跨日界串日', async () => {
    const r = await replay();
    assert.equal((r.naiveDoubleShiftedMs - PROBE_EPOCH_MS) / HOUR_MS, 16);
    // 原本是 07-27 的事件，落到 analytics 变成 07-28 → 日聚合串日
    assert.equal(new Date(r.naiveDoubleShiftedMs).toISOString().slice(0, 10), '2026-07-28');
    assert.equal(r.naiveDateText, '2026-07-27'); // 库里存的日期本身还是 27，所以对账时对得上、更难发现
  });

  it('同一个裸 Date 写进 **timestamptz** 列反而是对的 —— 病因是列类型 × 参数类型的组合', async () => {
    const r = await replay();
    assert.equal(r.v1IntoTimestamptzMs, PROBE_EPOCH_MS);
    // 这解释了 v2 的选择：全库统一 timestamptz，让"参数怎么写"不再决定正确性；
    // 而 assertNoRawDates 是第二道 —— 万一某处又出现 timestamp 列，也不会静默错 8 小时。
  });

  it('v2 写法（toPgTimestamptz + ::timestamptz）零偏移，PG 侧与驱动侧都对', async () => {
    const r = await replay();
    assert.equal(r.v2Ms, PROBE_EPOCH_MS);
    assert.equal(r.v2DriverMs, PROBE_EPOCH_MS);
    assert.equal(r.v2Ms - r.naiveAsUtcMs, -8 * HOUR_MS, '两条路径的差正好是那 8 小时');
  });

  it('守卫在位时这条路走不通：query() 直接拒掉同样的裸 Date', async () => {
    await assert.rejects(
      query(pool, 'test:v1-replay-blocked', 'SELECT $1::timestamp AS ts', [
        new Date(PROBE_EPOCH_MS),
      ]),
      RawDateParamError,
    );
  });
});

// ─── 事务与连接池的基本契约 ─────────────────────────────────────────────────

describe('withTransaction：失败必须回滚（发现层"宁可重算，绝不半写"的基础）', () => {
  it('断言事务持有两张投影锁时并发发布会等待，稳定态真不一致仍可见', async () => {
    const writer = createPool(databaseUrl, { max: 1 });
    const curveTable = 'meta._test_b2b4_snapshot_curve';
    const statsTable = 'meta._test_b2b4_snapshot_stats';
    const mismatchSql = `
      SELECT count(*)::int AS mismatched
        FROM ${curveTable} curve
        JOIN ${statsTable} stats USING (user_id)
       WHERE curve.cum_rating <> stats.total_rating`;
    try {
      await writer.query(`DROP TABLE IF EXISTS ${curveTable}, ${statsTable}`);
      await writer.query(
        `CREATE UNLOGGED TABLE ${curveTable} (
           user_id int PRIMARY KEY,
           cum_rating int NOT NULL
         )`,
      );
      await writer.query(
        `CREATE UNLOGGED TABLE ${statsTable} (
           user_id int PRIMARY KEY,
           total_rating int NOT NULL
         )`,
      );
      await writer.query(
        `INSERT INTO ${curveTable} VALUES (37715, 1351);
         INSERT INTO ${statsTable} VALUES (37715, 1351)`,
      );

      let competing: Promise<void> | undefined;
      await withTransaction(pool, 'test:b2b4-pair-lock', async (reader) => {
        await reader.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('serve.user_attr_daily', 72391231))`,
        );
        await reader.query(
          `SELECT pg_advisory_xact_lock(hashtextextended('serve.user_stats', 72391231))`,
        );
        const before = await reader.query<{ mismatched: number }>(mismatchSql);
        assert.equal(before.rows[0]?.mismatched, 0);

        // 模拟另一轮 projector 先发布曲线、再发布统计；两轮都遵守生产 advisory lock。
        competing = (async () => {
          await writer.query(
            `BEGIN;
             SELECT pg_advisory_xact_lock(
               hashtextextended('serve.user_attr_daily', 72391231)
             );
             UPDATE ${curveTable} SET cum_rating=1352 WHERE user_id=37715;
             COMMIT`,
          );
          await writer.query(
            `BEGIN;
             SELECT pg_advisory_xact_lock(
               hashtextextended('serve.user_attr_daily', 72391231)
             );
             SELECT pg_advisory_xact_lock(hashtextextended('serve.user_stats', 72391231));
             UPDATE ${statsTable} SET total_rating=1352 WHERE user_id=37715;
             COMMIT`,
          );
        })();
        await new Promise((resolve) => setTimeout(resolve, 100));
        const during = await reader.query<{ mismatched: number }>(mismatchSql);
        assert.equal(during.rows[0]?.mismatched, 0, '并发发布必须等断言事务释放成对锁');
      });
      await competing;

      const published = await writer.query<{ mismatched: number }>(mismatchSql);
      assert.equal(published.rows[0]?.mismatched, 0, '等待后两张表均可正常发布');

      await writer.query(
        `UPDATE ${statsTable} SET total_rating=1353 WHERE user_id=37715`,
      );
      const realMismatch = await writer.query<{ mismatched: number }>(mismatchSql);
      assert.equal(realMismatch.rows[0]?.mismatched, 1, '稳定态真实不一致必须检出');
    } finally {
      await writer.query(`DROP TABLE IF EXISTS ${curveTable}, ${statsTable}`).catch(() => undefined);
      await writer.end().catch(() => undefined);
    }
  });

  it('抛异常 → ROLLBACK，已插入的行不可见；成功 → COMMIT 可见', async () => {
    // max:1 的池 → 全程同一个会话，TEMP 表在多次事务间可见
    await withTransaction(pool, 'test:setup', async (c) => {
      await c.query('CREATE TEMP TABLE tx_probe (id int PRIMARY KEY)');
    });

    await assert.rejects(
      withTransaction(pool, 'test:boom', async (c) => {
        await c.query('INSERT INTO tx_probe (id) VALUES (1)');
        throw new Error('故意炸');
      }),
      /故意炸/,
    );
    const afterRollback = await query<{ n: string }>(
      pool,
      'test:count',
      'SELECT count(*)::text AS n FROM tx_probe',
    );
    assert.equal(afterRollback.rows[0]!.n, '0', '回滚后不该留下任何行');

    await withTransaction(pool, 'test:ok', async (c) => {
      await c.query('INSERT INTO tx_probe (id) VALUES (2)');
    });
    const afterCommit = await query<{ n: string }>(
      pool,
      'test:count',
      'SELECT count(*)::text AS n FROM tx_probe',
    );
    assert.equal(afterCommit.rows[0]!.n, '1');

    await query(pool, 'test:cleanup', 'DROP TABLE tx_probe');
  });
});

describe('PostgreSQL 自由文本边界：NUL / 孤立代理项必须可落库且留痕', () => {
  it('纯函数保留合法代理对，替换 NUL 与两种孤立代理项，并增加计数', () => {
    const before = pgTextSanitizationCounters();
    const input = `A\u0000B\uD800C\uDC00D😀`;
    const cleaned = sanitizePgText(input, { context: 'test:pg-text' });
    assert.equal(cleaned.value, 'A�B�C�D😀');
    assert.equal(cleaned.sanitation.nulCodeUnits, 1);
    assert.equal(cleaned.sanitation.loneSurrogates, 2);
    const afterCounters = pgTextSanitizationCounters();
    assert.equal(afterCounters.nulCodeUnits - before.nulCodeUnits, 1);
    assert.equal(afterCounters.loneSurrogates - before.loneSurrogates, 2);
    assert.deepEqual(
      JSON.parse(toPgJson({ ['键\u0000']: '值\u0000' }, 'test:json-key')),
      { '键�': '值�' },
    );
  });

  it('正文 text 与 JSONB 中的站点文本经统一边界后真实写入 TEMP 表', async () => {
    await query(
      pool,
      'test:pg-text:create',
      'CREATE TEMP TABLE pg_text_probe (body text NOT NULL, attrs jsonb NOT NULL)',
    );
    await query(
      pool,
      'test:pg-text:insert',
      'INSERT INTO pg_text_probe(body, attrs) VALUES ($1::text, $2::jsonb)',
      [
        '正文\u0000尾\uD800',
        toPgJson(
          {
            source_wikitext: '源码\u0000尾\uD800',
            text_content: '渲染\u0000尾\uDC00',
          },
          'test:content-json',
        ),
      ],
    );
    const result = await query<{
      body: string;
      source: string;
      text_content: string;
    }>(
      pool,
      'test:pg-text:read',
      `SELECT body,
              attrs->>'source_wikitext' AS source,
              attrs->>'text_content' AS text_content
         FROM pg_text_probe`,
    );
    assert.deepEqual(result.rows[0], {
      body: '正文�尾�',
      source: '源码�尾�',
      text_content: '渲染�尾�',
    });
    await query(pool, 'test:pg-text:drop', 'DROP TABLE pg_text_probe');
  });

  it('record_page_scan 的任意错误证据清洗、UTF-8 安全截断并在行内留标记', async () => {
    const source = `test:nulfix:${process.pid}`;
    const runId = await startIngestRun(pool, source, PROBE_ISO);
    assert.notEqual(runId, null);
    const raw = `前缀\u0000中间\uD800${'界'.repeat(20_000)}`;
    await recordPageScan(pool, {
      runId,
      pageId: 999_990_001,
      kind: 'content',
      status: 'failed',
      error: raw,
    });
    const result = await query<{ error: string; bytes: number }>(
      pool,
      'test:page-scan:read-sanitized',
      `SELECT error, octet_length(error)::int AS bytes
         FROM meta.page_scan
        WHERE run_id = $1 AND page_id = $2 AND kind = 'content'`,
      [runId, 999_990_001],
    );
    const stored = result.rows[0]!;
    assert.ok(stored.bytes <= PAGE_SCAN_ERROR_MAX_UTF8_BYTES);
    assert.doesNotMatch(stored.error, /\u0000/);
    assert.match(
      stored.error,
      /\[syncer2:text_sanitized nul=1 lone_surrogate=1 truncated=1\]$/,
    );
    assert.equal(
      sanitizePageScanError(raw),
      stored.error,
      '持久化值必须与共享证据清洗器同源',
    );
    await query(pool, 'test:page-scan:cleanup', 'DELETE FROM meta.ingest_run WHERE id = $1', [
      runId,
    ]);
  });
});
