/**
 * 测试固件与清理。
 *
 * ── 两种"不留数据"的策略，按测试形态选 ────────────────────────────────────────
 *   A. **单会话 → 单事务 + ROLLBACK**（T5.2 用）。最干净，跑完零残留。
 *      唯一的"残留"是序列前进（`ingest.fact_seq` / `page_id_seq` / `user_id_seq`）——
 *      序列本就不回滚，冒烟 smoke_test.sql 同理。`vote_event` 的 p0000 分区上界是
 *      20,000,000，一次大批测试消耗约 1.2 万个 seq，量级上无关紧要。
 *   B. **多会话 → 真提交 + 末尾按 id 段删除**（T7 用）。跨会话可见性是被测对象本身，
 *      事务回滚在语义上就用不了。所以必须真写、真删。
 *
 * 策略 B 的删除要越过 append-only 触发器（`ingest.vote_event` 等 8 张表挂了
 * `trg_immutable` + `trg_no_truncate`），唯一合法入口是 `SET LOCAL scpper.bypass_guard='on'`
 * ——这正是 0006 第 3 节留的迁移逃生舱，测试清理是它的正当用途之一。
 * 反过来说：**清理函数本身就是逃生舱的一次真实回归**（如果哪天有人把它优化掉，
 * 这里会立刻以"删不掉"的形式炸出来）。
 *
 * 所有测试对象都落在专属 id 段，清理靠这个段来定位，绝不 `DELETE ... WHERE true`：
 *   · page.wikidot_id  ∈ [2_100_000_000, 2_109_999_999]
 *   · user.wikidot_id  ∈ [2_110_000_000, 2_119_999_999]
 *   · 非 wikidot 用户   anon_key LIKE 'ts2test:%'
 *   · meta.ingest_run  source = 'test_syncer2'
 *   · projection_cursor projection LIKE 'test\_%'
 * 与 smoke_test.sql 的 990001+ 段不重叠（那边是 6 位数量级），两套测试可以并存。
 */

import type { Sess } from './pg.js';
import { toPgTimestamptz } from './pg.js';

// 旧段 970m/980m 与真实 Wikidot id 重叠：2026-07-28 清理曾误删 9 个 S1 page。
// 改用 int4 顶部的测试保留段；启动/清理仍只按 wikidot_id，不碰 v1 page.id 值域。
export const PAGE_WID_LO = 2_100_000_000;
export const PAGE_WID_HI = 2_109_999_999;
export const USER_WID_LO = 2_110_000_000;
export const USER_WID_HI = 2_119_999_999;
export const TEST_KEY_PREFIX = 'ts2test:';
export const TEST_RUN_SOURCE = 'test_syncer2';
export const TEST_PROJECTION_PREFIX = 'test_';

/** 测试用的固定观测时刻（不带整点/整日对称性，任何 ±整小时偏移都会被打出来）。 */
export const OBSERVED_ISO = toPgTimestamptz(Date.UTC(2026, 6, 27, 12, 34, 56, 789));

export type UserKind = 'wikidot' | 'guest' | 'anon' | 'synthetic';

/**
 * 建一个"够格做 absence 推断"的 run：status=ok、coverage_ratio = 36000/36173 ≈ 0.995 ≥ 0.98、
 * batches_failed = 0。门控用的就是这三个字段（R9）。
 */
export async function createRun(sess: Sess, status = 'ok'): Promise<number> {
  const id = await sess.num(
    'createRun',
    `INSERT INTO meta.ingest_run(source, status, pages_enumerated, remote_total,
                                remote_total_source, batches_total, batches_failed)
     VALUES ($1, $2, 36000, 36173, 'listpages_total', 145, 0)
     RETURNING id`,
    [TEST_RUN_SOURCE, status],
  );
  if (id === null) throw new Error('createRun 未拿到 id');
  return id;
}

/** 注册一个测试页。`n` 是段内序号（wikidot_id = PAGE_WID_LO + n）。 */
export async function registerPage(sess: Sess, n: number, slug?: string): Promise<number> {
  const wid = PAGE_WID_LO + n;
  const id = await sess.num(
    'registerPage',
    `SELECT ingest.register_page($1::int, $2::text, $3::timestamptz, 'test_wikidot',
                                 NULL, $3::timestamptz, NULL)`,
    [wid, slug ?? `ts2test:page-${n}`, OBSERVED_ISO],
  );
  if (id === null) throw new Error('registerPage 未拿到 page_id');
  return id;
}

/**
 * 批量铸用户。一次往返造 N 个 —— 5,575 次单独 round trip 会让 T5.2 的固件比被测逻辑还慢。
 * 返回按段内序号升序的 user_id 数组。
 *
 * `deleted` 不在 v2 的 kind 词表里：v2 只有 wikidot / guest / anon / synthetic
 * （`ingest.user_kind_check`）。任务描述里的 "deleted" 在 v2 的对应物是 `synthetic`
 * （v1 的"已删账号/合成身份"都收敛到它），这里按**可执行的词表**取 synthetic，
 * 覆盖面等价：门控③ `visible_kinds` 只放 'wikidot' 进 absence diff，
 * 其余三种 kind 一律不参与，这才是被测的性质。
 */
export async function ensureUsers(
  sess: Sess,
  kind: UserKind,
  from: number,
  count: number,
): Promise<number[]> {
  if (count <= 0) return [];
  const rows =
    kind === 'wikidot'
      ? await sess.q<{ id: number }>(
          'ensureUsers/wikidot',
          `SELECT ingest.ensure_user('wikidot', ($3::int + g)::int, NULL,
                                     'ts2test wikidot ' || g, NULL, NULL, NULL) AS id
             FROM generate_series($1::int, $2::int) g
            ORDER BY g`,
          [from, from + count - 1, USER_WID_LO],
        )
      : await sess.q<{ id: number }>(
          `ensureUsers/${kind}`,
          `SELECT ingest.ensure_user($3::text, NULL, $4::text || g::text,
                                     'ts2test ' || $3 || ' ' || g, NULL, NULL, NULL) AS id
             FROM generate_series($1::int, $2::int) g
            ORDER BY g`,
          [from, from + count - 1, kind, `${TEST_KEY_PREFIX}${kind}:`],
        );
  return rows.map((r) => Number(r.id));
}

export interface CleanupCounts {
  [table: string]: number;
}

/**
 * 清掉全部测试残留。幂等：没有残留时每条都删 0 行。
 *
 * 顺序按外键依赖倒着来（子表先删）。`ingest.*` 那几张事实表要靠
 * `SET LOCAL scpper.bypass_guard='on'` 越过 append-only 触发器。
 */
export async function cleanupAll(sess: Sess): Promise<CleanupCounts> {
  const pagesSub = `(SELECT id FROM ingest.page WHERE wikidot_id BETWEEN ${PAGE_WID_LO} AND ${PAGE_WID_HI})`;
  const steps: Array<[string, string]> = [
    ['meta.revision_regression_identity_state',
      `DELETE FROM meta.revision_regression_identity_state WHERE page_id IN ${pagesSub}`],
    ['meta.vote_sweep_page_state', `DELETE FROM meta.vote_sweep_page_state WHERE page_id IN ${pagesSub}`],
    ['meta.vote_seed_budget', `DELETE FROM meta.vote_seed_budget WHERE budget_key LIKE 'test:%'`],
    ['meta.revoke_candidate', `DELETE FROM meta.revoke_candidate WHERE page_id IN ${pagesSub}`],
    ['meta.vote_quarantine', `DELETE FROM meta.vote_quarantine WHERE page_id IN ${pagesSub}`],
    ['meta.page_scan', `DELETE FROM meta.page_scan WHERE page_id IN ${pagesSub}`],
    ['meta.scan_task', `DELETE FROM meta.scan_task WHERE page_id IN ${pagesSub}`],
    ['ingest.vote_event', `DELETE FROM ingest.vote_event WHERE page_id IN ${pagesSub}`],
    ['ingest.attribution_event', `DELETE FROM ingest.attribution_event WHERE page_id IN ${pagesSub}`],
    ['ingest.revision', `DELETE FROM ingest.revision WHERE page_id IN ${pagesSub}`],
    ['ingest.page_source', `DELETE FROM ingest.page_source WHERE page_id IN ${pagesSub}`],
    ['ingest.page_life_event', `DELETE FROM ingest.page_life_event WHERE page_id IN ${pagesSub}`],
    ['ingest.page_attr_history', `DELETE FROM ingest.page_attr_history WHERE page_id IN ${pagesSub}`],
    ['ingest.page_slug_history', `DELETE FROM ingest.page_slug_history WHERE page_id IN ${pagesSub}`],
    ['ingest.page_lineage', `DELETE FROM ingest.page_lineage WHERE successor_id IN ${pagesSub} OR predecessor_id IN ${pagesSub}`],
    ['serve.vote_current', `DELETE FROM serve.vote_current WHERE page_id IN ${pagesSub}`],
    ['serve.attribution_current', `DELETE FROM serve.attribution_current WHERE page_id IN ${pagesSub}`],
    ['serve.page_current', `DELETE FROM serve.page_current WHERE page_id IN ${pagesSub}`],
    ['ingest.page', `DELETE FROM ingest.page WHERE wikidot_id BETWEEN ${PAGE_WID_LO} AND ${PAGE_WID_HI}`],
    [
      'ingest.user',
      `DELETE FROM ingest."user"
        WHERE (wikidot_id BETWEEN ${USER_WID_LO} AND ${USER_WID_HI})
           OR anon_key LIKE '${TEST_KEY_PREFIX}%'`,
    ],
    [
      'meta.projection_cursor',
      `DELETE FROM meta.projection_cursor WHERE projection LIKE '${TEST_PROJECTION_PREFIX}%'`,
    ],
    ['meta.ingest_run', `DELETE FROM meta.ingest_run WHERE source = '${TEST_RUN_SOURCE}'`],
  ];

  const counts: CleanupCounts = {};
  await sess.begin();
  try {
    await sess.q('bypass', `SET LOCAL scpper.bypass_guard = 'on'`);
    for (const [label, sql] of steps) {
      const rows = await sess.q<{ n: string }>(
        `cleanup/${label}`,
        `WITH d AS (${sql} RETURNING 1) SELECT count(*)::text AS n FROM d`,
      );
      counts[label] = Number(rows[0]?.n ?? 0);
    }
    await sess.commit();
  } catch (err) {
    await sess.rollback().catch(() => undefined);
    throw err;
  }
  // gate 表里已结束事务留下的行：正常路径由 apply_* 的同事务 INSERT+DELETE 抹掉，
  // 但"独立控制连接登记"用法与崩溃写者会留行。sweep 是它的官方清理口。
  counts['meta.ingest_gate(sweep)'] = (await sess.num('sweep', `SELECT meta.ingest_gate_sweep()`)) ?? 0;
  return counts;
}

/** 断言库里已经没有任何测试残留（清理后的正向证据）。 */
export async function assertNoResidue(sess: Sess): Promise<Record<string, number>> {
  const pagesSub = `(SELECT id FROM ingest.page WHERE wikidot_id BETWEEN ${PAGE_WID_LO} AND ${PAGE_WID_HI})`;
  const row = await sess.one<Record<string, string>>(
    'residue',
    `SELECT
       (SELECT count(*) FROM ingest.page WHERE wikidot_id BETWEEN ${PAGE_WID_LO} AND ${PAGE_WID_HI})::text AS page,
       (SELECT count(*) FROM ingest."user"
         WHERE (wikidot_id BETWEEN ${USER_WID_LO} AND ${USER_WID_HI})
            OR anon_key LIKE '${TEST_KEY_PREFIX}%')::text AS "user",
       (SELECT count(*) FROM ingest.vote_event WHERE page_id IN ${pagesSub})::text AS vote_event,
       (SELECT count(*) FROM serve.page_current WHERE page_id IN ${pagesSub})::text AS page_current,
       (SELECT count(*) FROM serve.vote_current WHERE page_id IN ${pagesSub})::text AS vote_current,
       (SELECT count(*) FROM meta.ingest_run WHERE source = '${TEST_RUN_SOURCE}')::text AS ingest_run,
       (SELECT count(*) FROM meta.projection_cursor WHERE projection LIKE '${TEST_PROJECTION_PREFIX}%')::text AS projection_cursor,
       (SELECT count(*) FROM meta.ingest_gate
         WHERE COALESCE(pg_catalog.txid_status(txid), 'committed') = 'in progress')::text AS gate_in_progress`,
  );
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
}
