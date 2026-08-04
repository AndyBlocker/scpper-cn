/**
 * T5.2 · 大批量与属性测试（批量 = 逐行等价性，合入 gate）
 * =====================================================================================
 * 对应 0006_functions.sql 文件末自测清单 T5.1 / T5.2 / T5.3。
 *
 * ── 被测的性质 ──────────────────────────────────────────────────────────────────
 * `ingest.apply_vote_observation`（单票 CAS）是**转移语义的规范定义**；
 * `ingest.apply_vote_cas_batch` 是它的集合化实现，用一条语句完成
 * 事件 INSERT…SELECT + vote_current 批量 upsert + page_current 单次增量。
 * 两者必须**逐位等价** —— 否则同一份上游数据走 snapshot 协议和走单票协议会得到
 * 不同的库状态，而"哪条路径跑过"是运行期才决定的，等于把不一致做成了随机事件。
 *
 * 集合化实现里有三处特别容易在"量大了以后"才暴露的分歧，正是本文件要盯的：
 *   1. 聚合增量从 `cas`(语句快照) 算而不是从写后状态算 —— 写错就变成"批量少加/多加"；
 *   2. 精度改善副作用单独一条语句 —— 并进同一个 CTE 时 PG 只保证"不碰同一行时可用"，
 *      官方文档明确说这类效果 unspecified；
 *   3. `first_voted_at` 只在插入时设置、`COALESCE(vc.first_voted_at, EXCLUDED…)` 保留最早值。
 * 12 格转移矩阵冒烟已经逐格断言过（S2），这里补的是**规模**与**随机组合**。
 *
 * ── 为什么冒烟做不到 ────────────────────────────────────────────────────────────
 * 5,575 条的大批需要在测试侧生成数据并逐条比对两条路径的产物；随机属性测试需要一个
 * 带种子的生成器和"跑完再回读断言"的循环。psql 单文件能勉强用 generate_series 造数据，
 * 但没法在失败时把 seed 和反例打出来，也没法把"覆盖了哪些形态"统计出来。
 *
 * ── 数据策略 ────────────────────────────────────────────────────────────────────
 * 单会话 ⇒ 全程一个事务，末尾 ROLLBACK。跑完库里零残留（只有序列前进，序列本就不回滚）。
 * 两段测试各用一个独立事务，互不干扰。
 *
 * 5,575 = 实测站内最大页 scp-cn-2000 的真实票数（2026-07-27 抓取）。
 */

import test from 'node:test';
import { openSess, type Sess } from './helpers/pg.js';
import { Report, mulberry32, stable } from './helpers/report.js';
import { OBSERVED_ISO, createRun, ensureUsers, registerPage, type UserKind } from './helpers/fixture.js';

/** 属性测试的随机种子。失败时原样重跑即可复现。 */
const SEED = Number(process.env.SYNCER2_TEST_SEED ?? 20260727);
/** 属性测试迭代次数。 */
const ITERATIONS = Number(process.env.SYNCER2_TEST_ITERATIONS ?? 60);
/** 实测站内最大页 scp-cn-2000 的票数。 */
const BIG_PAGE_VOTES = 5575;

interface Entry {
  voter_id: number;
  direction: number;
}

interface SnapshotOpts {
  isComplete?: boolean;
  claimedTotal?: number | null;
  claimedRating?: number | null;
  visibleKinds?: string[];
  policy?: 'candidate' | 'event' | 'forbidden';
  /** 单页熔断阈值。属性测试里刻意关掉（1e6 条 / 比例 1.0，absent ⊆ active 故永不触发）。 */
  maxAbsence?: number;
  maxAbsenceRatio?: number;
}

async function applySnapshot(
  s: Sess,
  page: number,
  entries: Entry[],
  run: number,
  o: SnapshotOpts = {},
): Promise<Record<string, unknown>> {
  const res = await s.val<Record<string, unknown>>(
    'apply_vote_snapshot',
    `SELECT ingest.apply_vote_snapshot(
              $1::int, $2::jsonb, $3::boolean, $4::int, $5::int,
              $6::text[], $7::timestamptz, 'test_wikidot', $8::bigint, NULL,
              $9::text, $10::int, $11::real) AS r`,
    [
      page,
      JSON.stringify(entries),
      o.isComplete ?? true,
      o.claimedTotal === undefined ? entries.length : o.claimedTotal,
      o.claimedRating === undefined ? sumSign(entries) : o.claimedRating,
      o.visibleKinds ?? ['wikidot'],
      OBSERVED_ISO,
      run,
      o.policy ?? 'candidate',
      o.maxAbsence ?? 1_000_000,
      o.maxAbsenceRatio ?? 1.0,
    ],
  );
  return res;
}

function sumSign(entries: Entry[]): number {
  return entries.reduce((acc, e) => acc + Math.sign(e.direction), 0);
}

/** 按 voter 去重（保留 |direction| 最大的那条），复刻 apply_vote_snapshot 的 DISTINCT ON 语义。 */
function dedupe(entries: Entry[]): Entry[] {
  const best = new Map<number, Entry>();
  for (const e of entries) {
    const cur = best.get(e.voter_id);
    if (!cur || Math.abs(e.direction) > Math.abs(cur.direction)) best.set(e.voter_id, e);
  }
  return [...best.values()].sort((a, b) => a.voter_id - b.voter_id);
}

test('T5.2 · 大批量与属性测试：批量 = 逐行等价 + 不变式', async (t) => {
  const rep = new Report('T5.2 · 大批量与属性测试（批量 = 逐行等价 / 随机属性不变式）');
  const s = await openSess('t5');

  try {
    // =================================================================================
    // 第一段 · 5,575 票大页：apply_vote_snapshot(批量) 与 apply_vote_observation(逐行) 全等
    // =================================================================================
    await t.test(`T5.2a ${BIG_PAGE_VOTES} 票大页：批量与逐行三重全等`, async () => {
      await s.begin();
      try {
        const run = await createRun(s);
        const pBatch = await registerPage(s, 801, 'ts2test:t5-batch');
        const pRow = await registerPage(s, 802, 'ts2test:t5-row');
        const t0 = Date.now();
        const voters = await ensureUsers(s, 'wikidot', 10_000, BIG_PAGE_VOTES);
        rep.eq('T5.2a 固件', `铸 ${BIG_PAGE_VOTES} 个 wikidot voter`, voters.length, BIG_PAGE_VOTES, `${Date.now() - t0}ms`);

        // ---- 逐行路径的执行器：pg_temp 里的循环，N 次真实函数调用 ---------------------
        // 为什么放服务端：5,575 次网络往返会让固件比被测逻辑慢一个数量级，
        // 而"逐行"的语义是"N 次独立的函数调用"，与是否跨网络无关。
        await s.q(
          'create-helper',
          `CREATE FUNCTION pg_temp.apply_rows(p_page int, p_entries jsonb,
                                              p_observed timestamptz, p_source text, p_run bigint)
           RETURNS int LANGUAGE plpgsql AS $fn$
           DECLARE r record; n int := 0; ev bigint;
           BEGIN
             FOR r IN SELECT (e.v ->> 'voter_id')::int AS vid,
                             COALESCE((e.v ->> 'direction')::int, 0) AS dir
                        FROM jsonb_array_elements(p_entries) AS e(v)
                       ORDER BY (e.v ->> 'voter_id')::int
             LOOP
               ev := ingest.apply_vote_observation(p_page, r.vid, r.dir,
                       p_observed, p_observed, 'observed', p_source, p_run);
               IF ev IS NOT NULL THEN n := n + 1; END IF;
             END LOOP;
             RETURN n;
           END $fn$`,
        );

        // ---- 第 1 轮：混合方向的初始快照（含 ±2，走归一化 + quarantine）---------------
        const rnd = mulberry32(SEED ^ 0x5a5a);
        const round1: Entry[] = voters.map((v) => {
          const x = rnd();
          const direction = x < 0.78 ? 1 : x < 0.88 ? -1 : x < 0.95 ? 0 : x < 0.98 ? 2 : -2;
          return { voter_id: v, direction };
        });
        const expectEv1 = round1.filter((e) => Math.sign(e.direction) !== 0).length;

        const tb1 = Date.now();
        const res1 = await applySnapshot(s, pBatch, round1, run);
        const msBatch1 = Date.now() - tb1;
        const tr1 = Date.now();
        const rowEv1 = await s.num(
          'apply_rows-1',
          `SELECT pg_temp.apply_rows($1::int, $2::jsonb, $3::timestamptz, 'test_wikidot', $4::bigint)`,
          [pRow, JSON.stringify(round1), OBSERVED_ISO, run],
        );
        const msRow1 = Date.now() - tr1;

        rep.eq('T5.2a 第1轮', '批量路径事件数 = 期望（sign≠0 的条数）', Number(res1['events']), expectEv1, `${msBatch1}ms`);
        rep.eq('T5.2a 第1轮', '逐行路径事件数 = 期望', rowEv1, expectEv1, `${msRow1}ms`);
        rep.eq('T5.2a 第1轮', '四重门控全过（absence_allowed=true）', res1['absence_allowed'], true);
        rep.eq('T5.2a 第1轮', 'checksum_ok=true（Σsign = 谎报的 %%rating%%）', res1['checksum_ok'], true);
        rep.eq('T5.2a 第1轮', '全员在场 ⇒ absence_count=0', Number(res1['absence_count']), 0);
        rep.eq('T5.2a 第1轮', '候选零新增', Number(res1['candidates_written']), 0);
        await assertEquivalent(s, rep, 'T5.2a 第1轮', pBatch, pRow);

        // ---- ±2 归一化留痕 -----------------------------------------------------------
        const outOfRange = round1.filter((e) => Math.abs(e.direction) > 1).length;
        const qN = await s.num(
          'quarantine',
          `SELECT count(*) FROM meta.vote_quarantine
            WHERE page_id = $1 AND reason = 'direction_out_of_range'`,
          [pBatch],
        );
        rep.eq('T5.2a 第1轮', '±2 原始值全部进 meta.vote_quarantine 留痕', qN, outOfRange, `${outOfRange} 条 ±2`);
        const badVc = await s.num(
          'bad-vc',
          `SELECT count(*) FROM serve.vote_current WHERE page_id = ANY($1::int[]) AND abs(direction) > 1`,
          [[pBatch, pRow]],
        );
        rep.eq('T5.2a 第1轮', 'vote_current 里没有 |direction|>1 的残留', badVc, 0);

        // ---- T5.3 顺序无关性：打乱 p_targets 顺序，结果不变 --------------------------
        // 必须在第 2 轮**之前**比：对照页 pBatch 此刻只应用过 round1，
        // 拿一个只应用过 round1 的乱序页去比一个已经跑到 round2 的页是测试自身的错。
        const pShuf = await registerPage(s, 803, 'ts2test:t5-shuffled');
        const shuffled = [...round1];
        const rnd3 = mulberry32(SEED ^ 0x7777);
        for (let i = shuffled.length - 1; i > 0; i--) {
          const j = Math.floor(rnd3() * (i + 1));
          [shuffled[i], shuffled[j]] = [shuffled[j] as Entry, shuffled[i] as Entry];
        }
        const resShuf = await applySnapshot(s, pShuf, shuffled, run);
        rep.eq('T5.2a T5.3', '乱序输入的事件数与顺序输入相同', Number(resShuf['events']), expectEv1);
        const shufEv = await compareEvents(s, pShuf, pBatch);
        rep.eq(
          'T5.2a T5.3',
          '打乱输入顺序后事件序列逐位全等（seq 分配按 voter_id 确定化）',
          { n: shufEv.nb, nr: shufEv.nr, mismatch: shufEv.mismatch, symdiff: shufEv.symdiff },
          { n: shufEv.nb, nr: shufEv.nb, mismatch: 0, symdiff: 0 },
        );
        const shufEq = await compareVoteCurrent(s, pShuf, pBatch);
        rep.eq('T5.2a T5.3', '打乱输入顺序后 vote_current 终态全等', shufEq, {
          nb: shufEq.nb,
          nr: shufEq.nb,
          mismatch: 0,
        });
        const shufAggA = await pageAgg(s, pShuf);
        const shufAggB = await pageAgg(s, pBatch);
        rep.eq('T5.2a T5.3', '打乱输入顺序后 page_current 四列全等', shufAggA, shufAggB, stable(shufAggA));

        // ---- 第 2 轮：约 30% 的票发生转移（revote / revoke / 新票）--------------------
        const rnd2 = mulberry32(SEED ^ 0x1234);
        const round2: Entry[] = round1.map((e) => {
          if (rnd2() > 0.3) return e; // 70% 原样（应产生零转移）
          const x = rnd2();
          const direction = x < 0.4 ? -Math.sign(e.direction) || 1 : x < 0.7 ? 0 : x < 0.9 ? 1 : -1;
          return { voter_id: e.voter_id, direction };
        });
        const expectEv2 = round2.filter(
          (e, i) => Math.sign(e.direction) !== Math.sign((round1[i] as Entry).direction),
        ).length;

        const res2 = await applySnapshot(s, pBatch, round2, run);
        const rowEv2 = await s.num(
          'apply_rows-2',
          `SELECT pg_temp.apply_rows($1::int, $2::jsonb, $3::timestamptz, 'test_wikidot', $4::bigint)`,
          [pRow, JSON.stringify(round2), OBSERVED_ISO, run],
        );
        rep.eq('T5.2a 第2轮', '批量路径转移数 = 期望（sign 变化的条数）', Number(res2['events']), expectEv2);
        rep.eq('T5.2a 第2轮', '逐行路径转移数 = 期望', rowEv2, expectEv2);
        await assertEquivalent(s, rep, 'T5.2a 第2轮', pBatch, pRow);

        // ---- 重放幂等：同一份快照再来一次 ⇒ 零转移 -----------------------------------
        const res2b = await applySnapshot(s, pBatch, round2, run);
        rep.eq('T5.2a 重放', '同一份快照重放 ⇒ 零新事件（幂等）', Number(res2b['events']), 0);
        const rowEv2b = await s.num(
          'apply_rows-2b',
          `SELECT pg_temp.apply_rows($1::int, $2::jsonb, $3::timestamptz, 'test_wikidot', $4::bigint)`,
          [pRow, JSON.stringify(round2), OBSERVED_ISO, run],
        );
        rep.eq('T5.2a 重放', '逐行路径重放 ⇒ 零新事件', rowEv2b, 0);
        await assertEquivalent(s, rep, 'T5.2a 重放', pBatch, pRow);

        // ---- 同 voter 多记录：cas_batch 必须报错，snapshot 必须去重 -------------------
        const v0 = voters[0] as number;
        const dupErr = await s.expectError(
          'cas_batch-dup',
          `SELECT ingest.apply_vote_cas_batch($1::int, $2::jsonb, $3::timestamptz, 'test_wikidot', NULL)`,
          [
            pBatch,
            JSON.stringify([
              { voter_id: v0, direction: 1, occurred_at: OBSERVED_ISO, precision: 'observed' },
              { voter_id: v0, direction: -1, occurred_at: OBSERVED_ISO, precision: 'observed' },
            ]),
            OBSERVED_ISO,
          ],
          true,
        );
        rep.eq(
          'T5.2a 同 voter 多记录',
          'cas_batch 直调遇重复 voter ⇒ 抛 22000（绝不静默择一）',
          dupErr.sqlstate,
          '22000',
        );

        const pDup = await registerPage(s, 804, 'ts2test:t5-dup');
        const dupVoters = voters.slice(0, 4) as number[];
        // 每人两条，|direction| 不同 ⇒ 去重结果唯一可断言（取 |d| 大的那条）
        const dupEntries: Entry[] = [
          { voter_id: dupVoters[0] as number, direction: 2 },
          { voter_id: dupVoters[0] as number, direction: 0 },
          { voter_id: dupVoters[1] as number, direction: -2 },
          { voter_id: dupVoters[1] as number, direction: 1 },
          { voter_id: dupVoters[2] as number, direction: 1 },
          { voter_id: dupVoters[2] as number, direction: 0 },
          { voter_id: dupVoters[3] as number, direction: 0 },
        ];
        const kept = dedupe(dupEntries);
        const resDup = await applySnapshot(s, pDup, dupEntries, run, {
          claimedTotal: kept.length,
          claimedRating: sumSign(kept),
        });
        rep.eq('T5.2a 同 voter 多记录', 'snapshot 去重后 unique_voters = 4', Number(resDup['unique_voters']), 4);
        rep.eq('T5.2a 同 voter 多记录', 'snapshot 原始条数 raw_entries = 7', Number(resDup['raw_entries']), 7);
        rep.eq('T5.2a 同 voter 多记录', '去重后 checksum 与门控②③④一致 ⇒ absence 允许', resDup['absence_allowed'], true);
        const dupState = await s.q<{ voter_id: number; direction: number }>(
          'dup-state',
          `SELECT voter_id, direction FROM serve.vote_current WHERE page_id = $1 ORDER BY voter_id`,
          [pDup],
        );
        rep.eq(
          'T5.2a 同 voter 多记录',
          '去重取 |direction| 较大的那条（sign 后落库）',
          dupState.map((r) => ({ v: Number(r.voter_id), d: Number(r.direction) })),
          // 注意：去重后 direction=0 的 voter 在**全新页**上不产生任何行 ——
          // cur=NULL ∧ tgt=NULL ⇒ 无转移（幻影 revoke 在此不可构造，S2★ 的同一条性质）。
          // 所以期望值要把 sign=0 的那位过滤掉，而不是期望一行 direction=0。
          kept.filter((e) => Math.sign(e.direction) !== 0).map((e) => ({ v: e.voter_id, d: Math.sign(e.direction) })),
        );
        const zeroOnly = kept.filter((e) => Math.sign(e.direction) === 0).map((e) => e.voter_id);
        const zeroRows = await s.num(
          'zero-only-rows',
          `SELECT count(*) FROM serve.vote_current WHERE page_id = $1 AND voter_id = ANY($2::int[])`,
          [pDup, zeroOnly],
        );
        rep.eq(
          'T5.2a 同 voter 多记录',
          '去重后 direction=0 且此前无票的 voter ⇒ 零行零事件（幻影 revoke 不可构造）',
          zeroRows,
          0,
          `voter=[${zeroOnly.join(',')}]`,
        );
      } finally {
        await s.rollback();
      }
    });

    // =================================================================================
    // 第二段 · 属性测试生成器
    // =================================================================================
    await t.test(`T5.2b 属性测试生成器（seed=${SEED}, ${ITERATIONS} 轮）`, async () => {
      await s.begin();
      try {
        const run = await createRun(s);
        const pages: number[] = [];
        for (let i = 0; i < 8; i++) pages.push(await registerPage(s, 820 + i, `ts2test:t5-prop-${i}`));

        // 混合 kind 的 voter 池。'deleted' 不在 v2 的 kind 词表里（wikidot|guest|anon|synthetic），
        // v1 的"已删账号/合成身份"在 v2 收敛为 synthetic，故按可执行词表取 synthetic。
        // 被测性质是门控③：visible_kinds 只放 'wikidot' 进 absence diff，其余 kind 一律不参与。
        const pool: Array<{ id: number; kind: UserKind }> = [];
        const kinds: Array<[UserKind, number, number]> = [
          ['wikidot', 20_000, 60],
          ['anon', 20_100, 15],
          ['guest', 20_200, 15],
          ['synthetic', 20_300, 15],
        ];
        for (const [kind, from, n] of kinds) {
          const ids = await ensureUsers(s, kind, from, n);
          for (const id of ids) pool.push({ id, kind });
        }
        rep.eq('T5.2b 固件', '混合 kind voter 池（wikidot/anon/guest/synthetic）', pool.length, 105);

        const rnd = mulberry32(SEED);
        const coverage: Record<string, number> = {
          clean: 0,
          dup: 0,
          empty: 0,
          incomplete: 0,
          badTotal: 0,
          noRating: 0,
          badChecksum: 0,
          forbidden: 0,
          plusMinus2: 0,
          zeroDirection: 0,
          nonWikidotVoter: 0,
          absenceProduced: 0,
        };
        let prevTotalEvents = 0;
        const failures: string[] = [];

        for (let it = 0; it < ITERATIONS; it++) {
          const page = pages[Math.floor(rnd() * pages.length)] as number;

          // ---- 生成 entries -----------------------------------------------------------
          const size = Math.floor(rnd() * 40);
          const picked = new Set<number>();
          const entries: Entry[] = [];
          for (let k = 0; k < size; k++) {
            const u = pool[Math.floor(rnd() * pool.length)] as { id: number; kind: UserKind };
            if (picked.has(u.id)) continue;
            picked.add(u.id);
            const x = rnd();
            const direction = x < 0.45 ? 1 : x < 0.7 ? -1 : x < 0.85 ? 0 : x < 0.93 ? 2 : -2;
            entries.push({ voter_id: u.id, direction });
            if (Math.abs(direction) > 1) coverage['plusMinus2'] = (coverage['plusMinus2'] ?? 0) + 1;
            if (direction === 0) coverage['zeroDirection'] = (coverage['zeroDirection'] ?? 0) + 1;
            if (u.kind !== 'wikidot') coverage['nonWikidotVoter'] = (coverage['nonWikidotVoter'] ?? 0) + 1;
          }

          // ---- 形态选择 ---------------------------------------------------------------
          const variantRoll = rnd();
          let variant = 'clean';
          const o: SnapshotOpts = {};
          if (variantRoll < 0.1 && entries.length > 0) {
            variant = 'dup';
            const e = entries[Math.floor(rnd() * entries.length)] as Entry;
            entries.push({ voter_id: e.voter_id, direction: Math.abs(e.direction) > 1 ? 0 : 2 });
          } else if (variantRoll < 0.18) {
            variant = 'empty';
            entries.length = 0;
          } else if (variantRoll < 0.3) {
            variant = 'incomplete';
            o.isComplete = false;
          } else if (variantRoll < 0.42) {
            variant = 'badTotal';
          } else if (variantRoll < 0.52) {
            variant = 'noRating';
            o.claimedRating = null;
          } else if (variantRoll < 0.66) {
            variant = 'badChecksum';
          } else if (variantRoll < 0.72) {
            variant = 'forbidden';
            o.policy = 'forbidden';
          }
          coverage[variant] = (coverage[variant] ?? 0) + 1;

          const kept = dedupe(entries);
          const uniq = kept.length;
          const checksum = sumSign(kept);
          if (variant === 'badTotal') o.claimedTotal = uniq + 1;
          if (variant === 'badChecksum') o.claimedRating = checksum + 3;
          if (o.claimedTotal === undefined) o.claimedTotal = uniq;
          if (o.claimedRating === undefined) o.claimedRating = checksum;

          // ---- 期望的门控结论（把函数注释里的判据独立复算一遍）------------------------
          const isComplete = o.isComplete ?? true;
          const gate2 = o.claimedTotal === null || uniq === o.claimedTotal;
          const gate4: boolean | null = o.claimedRating === null ? null : checksum === o.claimedRating;
          const gate5 = !(uniq === 0 && (o.claimedTotal ?? 1) > 0);
          const expectAllow =
            isComplete && gate2 && gate5 && gate4 === true && (o.policy ?? 'candidate') !== 'forbidden';
          const expectStatus = !gate5 ? 'failed' : isComplete && gate2 && (gate4 ?? true) ? 'ok' : 'partial';

          const before = await pageState(s, page);
          const res = await applySnapshot(s, page, entries, run, o);
          const after = await pageState(s, page);

          const ctx = `it=${it} variant=${variant} page=${page} uniq=${uniq} checksum=${checksum}`;

          // ---- 不变式 1：门控结论与独立复算一致 --------------------------------------
          if (res['absence_allowed'] !== expectAllow) {
            failures.push(`${ctx} absence_allowed=${String(res['absence_allowed'])} 期望 ${expectAllow}`);
          }
          if (res['scan_status'] !== expectStatus) {
            failures.push(`${ctx} scan_status=${String(res['scan_status'])} 期望 ${expectStatus}`);
          }
          if (res['checksum_ok'] !== gate4) {
            failures.push(`${ctx} checksum_ok=${String(res['checksum_ok'])} 期望 ${String(gate4)}`);
          }
          if (Number(res['unique_voters']) !== uniq) {
            failures.push(`${ctx} unique_voters=${String(res['unique_voters'])} 期望 ${uniq}`);
          }
          if (Number(res['checksum_actual']) !== checksum) {
            failures.push(`${ctx} checksum_actual=${String(res['checksum_actual'])} 期望 ${checksum}`);
          }

          // ---- 不变式 2：事件数单调不减 ----------------------------------------------
          if (after.events < before.events) {
            failures.push(`${ctx} 事件数倒退 ${before.events} → ${after.events}`);
          }

          // ---- 不变式 3：absence 从不直接产生 revoke 事件（policy=candidate）--------
          if (Number(res['revoke_events']) !== 0) {
            failures.push(`${ctx} absence 直接产生了 revoke 事件 ${String(res['revoke_events'])}`);
          }
          if (Number(res['candidates_written']) > 0) coverage['absenceProduced'] = (coverage['absenceProduced'] ?? 0) + 1;

          // ---- 不变式 4：门控未过时候选表不得增长 ------------------------------------
          if (!expectAllow && after.candidates > before.candidates) {
            failures.push(`${ctx} 门控未过但 revoke_candidate 增长 ${before.candidates} → ${after.candidates}`);
          }

          // ---- 不变式 5：空快照 + claimed_total>0 ⇒ failed 且一票未动 ----------------
          if (uniq === 0 && (o.claimedTotal ?? 1) > 0) {
            if (res['scan_status'] !== 'failed' || Number(res['events']) !== 0) {
              failures.push(`${ctx} 空快照红线失效：status=${String(res['scan_status'])} events=${String(res['events'])}`);
            }
          }

          // ---- 不变式 6：重放幂等 ----------------------------------------------------
          const replay = await applySnapshot(s, page, entries, run, o);
          const afterReplay = await pageState(s, page);
          if (Number(replay['events']) !== 0) {
            failures.push(`${ctx} 重放产生了 ${String(replay['events'])} 条事件（应为 0）`);
          }
          if (afterReplay.events !== after.events || afterReplay.vc !== after.vc || afterReplay.pc !== after.pc) {
            failures.push(
              `${ctx} 重放改变了状态：events ${after.events}→${afterReplay.events} vc ${after.vc}→${afterReplay.vc} pc ${after.pc}→${afterReplay.pc}`,
            );
          }

          // ---- 不变式 7-12：全局结构不变式（每轮都跑）--------------------------------
          const inv = await globalInvariants(s, pages);
          if (inv.badAgg !== 0) failures.push(`${ctx} I1-I4 破：page_current 与 vote_current 折叠不符 ${inv.badAgg} 页`);
          if (inv.badChain !== 0) failures.push(`${ctx} 事件链断裂 ${inv.badChain} 条`);
          if (inv.firstNotVote !== 0) failures.push(`${ctx} 有 (page,voter) 的首事件不是 'vote'（幻影 revoke）${inv.firstNotVote} 条`);
          if (inv.phantomRevoke !== 0) failures.push(`${ctx} 出现 old_direction IS NULL 的 revoke 事件 ${inv.phantomRevoke} 条`);
          if (inv.badDir !== 0) failures.push(`${ctx} 事件里出现 |direction|>1 ${inv.badDir} 条`);
          if (inv.badVc !== 0) failures.push(`${ctx} vote_current 里出现 |direction|>1 ${inv.badVc} 行`);
          if (inv.candNonVisible !== 0) failures.push(`${ctx} revoke_candidate 里出现非 wikidot voter ${inv.candNonVisible} 行（门控③破）`);
          if (inv.pdefault !== 0) failures.push(`${ctx} vote_event_pdefault 非空 ${inv.pdefault} 行`);
          if (inv.totalEvents < prevTotalEvents) {
            failures.push(`${ctx} 全局事件数倒退 ${prevTotalEvents} → ${inv.totalEvents}`);
          }
          prevTotalEvents = inv.totalEvents;

          if (failures.length > 12) break; // 反例够多了，不必跑完
        }

        // ---- 汇总断言 ---------------------------------------------------------------
        rep.chk(
          'T5.2b 不变式',
          `${ITERATIONS} 轮随机快照全部满足不变式`,
          failures.length === 0,
          failures.length === 0 ? `seed=${SEED}` : `seed=${SEED} 反例:\n      ${failures.join('\n      ')}`,
        );

        // 生成器覆盖面：每个形态至少出现一次，否则"跑过了"其实没测到
        const mustCover = [
          'clean',
          'dup',
          'empty',
          'incomplete',
          'badTotal',
          'noRating',
          'badChecksum',
          'forbidden',
          'plusMinus2',
          'zeroDirection',
          'nonWikidotVoter',
          'absenceProduced',
        ];
        const missing = mustCover.filter((k) => (coverage[k] ?? 0) === 0);
        rep.eq('T5.2b 覆盖面', '生成器覆盖全部必需形态', missing, [], stable(coverage));

        // 终局全局不变式再确认一次
        const inv = await globalInvariants(s, pages);
        rep.eq('T5.2b 终局', 'I1-I4：page_current 四列 = vote_current 逐页折叠', inv.badAgg, 0);
        rep.eq('T5.2b 终局', '每条事件链首事件均为 vote、相邻事件 old=prev.new', inv.badChain, 0);
        rep.eq('T5.2b 终局', '幻影 revoke 零条（old_direction IS NULL 的 revoke）', inv.phantomRevoke, 0);
        rep.eq('T5.2b 终局', 'vote_event_pdefault 恒空', inv.pdefault, 0);
        rep.chk('T5.2b 终局', '确实产生了事实（生成器不是空转）', inv.totalEvents > 0, `${inv.totalEvents} 条事件`);
      } finally {
        await s.rollback();
      }
    });
  } finally {
    await s.end();
  }

  rep.finish();
});

// =====================================================================================
// 比对工具
// =====================================================================================

interface CmpResult {
  nb: number;
  nr: number;
  mismatch: number;
}

/** 事件序列（按 seq 排序后逐位比）+ 多重集（忽略 seq）双口径比较。 */
async function compareEvents(s: Sess, pb: number, pr: number): Promise<CmpResult & { symdiff: number }> {
  const row = await s.one<Record<string, string>>(
    'cmp-events',
    `WITH b AS (
       SELECT row_number() OVER (ORDER BY seq) AS rn, voter_id, kind, old_direction, new_direction,
              time_precision, source,
              (extract(epoch FROM occurred_at) * 1000)::bigint AS occ,
              (extract(epoch FROM observed_at) * 1000)::bigint AS obs
         FROM ingest.vote_event WHERE page_id = $1
     ), r AS (
       SELECT row_number() OVER (ORDER BY seq) AS rn, voter_id, kind, old_direction, new_direction,
              time_precision, source,
              (extract(epoch FROM occurred_at) * 1000)::bigint AS occ,
              (extract(epoch FROM observed_at) * 1000)::bigint AS obs
         FROM ingest.vote_event WHERE page_id = $2
     ), mm AS (
       SELECT count(*) AS n FROM b FULL JOIN r USING (rn)
        WHERE (b.voter_id, b.kind, b.old_direction, b.new_direction, b.time_precision, b.source, b.occ, b.obs)
           IS DISTINCT FROM
              (r.voter_id, r.kind, r.old_direction, r.new_direction, r.time_precision, r.source, r.occ, r.obs)
     ), sd AS (
       SELECT count(*) AS n FROM (
         (SELECT voter_id, kind, old_direction, new_direction, time_precision
            FROM ingest.vote_event WHERE page_id = $1
          EXCEPT ALL
          SELECT voter_id, kind, old_direction, new_direction, time_precision
            FROM ingest.vote_event WHERE page_id = $2)
         UNION ALL
         (SELECT voter_id, kind, old_direction, new_direction, time_precision
            FROM ingest.vote_event WHERE page_id = $2
          EXCEPT ALL
          SELECT voter_id, kind, old_direction, new_direction, time_precision
            FROM ingest.vote_event WHERE page_id = $1)
       ) d
     )
     SELECT (SELECT count(*) FROM b)::text AS nb, (SELECT count(*) FROM r)::text AS nr,
            (SELECT n FROM mm)::text AS mismatch, (SELECT n FROM sd)::text AS symdiff`,
    [pb, pr],
  );
  return {
    nb: Number(row['nb']),
    nr: Number(row['nr']),
    mismatch: Number(row['mismatch']),
    symdiff: Number(row['symdiff']),
  };
}

/** vote_current 全表比较（direction / first_voted_at / last_voted_at / last_precision）。 */
async function compareVoteCurrent(s: Sess, pb: number, pr: number): Promise<CmpResult> {
  const row = await s.one<Record<string, string>>(
    'cmp-vote-current',
    `WITH b AS (
       SELECT voter_id, direction,
              (extract(epoch FROM first_voted_at) * 1000)::bigint AS fva,
              (extract(epoch FROM last_voted_at) * 1000)::bigint AS lva,
              last_precision
         FROM serve.vote_current WHERE page_id = $1
     ), r AS (
       SELECT voter_id, direction,
              (extract(epoch FROM first_voted_at) * 1000)::bigint AS fva,
              (extract(epoch FROM last_voted_at) * 1000)::bigint AS lva,
              last_precision
         FROM serve.vote_current WHERE page_id = $2
     )
     SELECT (SELECT count(*) FROM b)::text AS nb, (SELECT count(*) FROM r)::text AS nr,
            (SELECT count(*) FROM b FULL JOIN r USING (voter_id)
              WHERE (b.direction, b.fva, b.lva, b.last_precision)
                 IS DISTINCT FROM (r.direction, r.fva, r.lva, r.last_precision))::text AS mismatch`,
    [pb, pr],
  );
  return { nb: Number(row['nb']), nr: Number(row['nr']), mismatch: Number(row['mismatch']) };
}

/** page_current 的四个聚合列。 */
async function pageAgg(s: Sess, page: number): Promise<Record<string, number>> {
  const row = await s.one<Record<string, number>>(
    'page-agg',
    `SELECT rating, vote_up, vote_down, vote_revoked FROM serve.page_current WHERE page_id = $1`,
    [page],
  );
  return {
    rating: Number(row['rating']),
    vote_up: Number(row['vote_up']),
    vote_down: Number(row['vote_down']),
    vote_revoked: Number(row['vote_revoked']),
  };
}

/** 三重全等断言：事件序列 + vote_current 终态 + page_current 聚合。 */
async function assertEquivalent(
  s: Sess,
  rep: Report,
  section: string,
  pBatch: number,
  pRow: number,
): Promise<void> {
  const ev = await compareEvents(s, pBatch, pRow);
  rep.eq(section, '① 事件序列逐位全等（按 seq 排序）', { n: ev.nb, mismatch: ev.mismatch }, { n: ev.nb, mismatch: 0 });
  rep.eq(section, '① 两侧事件条数相等', ev.nr, ev.nb);
  rep.eq(section, '① 事件多重集对称差为 0（忽略 seq 绝对值）', ev.symdiff, 0);

  const vc = await compareVoteCurrent(s, pBatch, pRow);
  rep.eq(section, '② vote_current 终态全等', { n: vc.nb, mismatch: vc.mismatch }, { n: vc.nb, mismatch: 0 });
  rep.eq(section, '② 两侧 vote_current 行数相等', vc.nr, vc.nb);

  const ab = await pageAgg(s, pBatch);
  const ar = await pageAgg(s, pRow);
  rep.eq(section, '③ page_current 四列聚合全等', ab, ar, stable(ab));
}

interface PageState {
  events: number;
  candidates: number;
  vc: string;
  pc: string;
}

async function pageState(s: Sess, page: number): Promise<PageState> {
  const row = await s.one<Record<string, string>>(
    'page-state',
    `SELECT
       (SELECT count(*) FROM ingest.vote_event WHERE page_id = $1)::text AS events,
       (SELECT count(*) FROM meta.revoke_candidate WHERE page_id = $1)::text AS candidates,
       (SELECT COALESCE(md5(string_agg(voter_id || ':' || direction || ':' || last_precision, ','
                                       ORDER BY voter_id)), '-')
          FROM serve.vote_current WHERE page_id = $1) AS vc,
       (SELECT rating || '/' || vote_up || '/' || vote_down || '/' || vote_revoked
          FROM serve.page_current WHERE page_id = $1) AS pc`,
    [page],
  );
  return {
    events: Number(row['events']),
    candidates: Number(row['candidates']),
    vc: String(row['vc']),
    pc: String(row['pc']),
  };
}

interface Invariants {
  badAgg: number;
  badChain: number;
  firstNotVote: number;
  phantomRevoke: number;
  badDir: number;
  badVc: number;
  candNonVisible: number;
  pdefault: number;
  totalEvents: number;
}

/**
 * 全局结构不变式。一条查询里算完，避免属性测试每轮打十次往返。
 *   · I1–I4  page_current 四列 = vote_current 逐页折叠
 *   · 事件链  每 (page,voter) 首事件 old IS NULL 且 kind='vote'；相邻事件 old = prev.new
 *   · 幻影 revoke  old_direction IS NULL 的 revoke 事件必须零条
 *   · 方向域  事件与 vote_current 里都不得出现 |direction| > 1
 *   · 门控③  revoke_candidate 里不得出现非 wikidot 的 voter（本测试 visible_kinds 恒为 {wikidot}）
 *   · 分区    vote_event_pdefault 恒空
 */
async function globalInvariants(s: Sess, pages: number[]): Promise<Invariants> {
  const row = await s.one<Record<string, string>>(
    'invariants',
    `WITH fold AS (
       SELECT p AS page_id,
              COALESCE(sum(vc.direction), 0)::int AS rating,
              count(*) FILTER (WHERE vc.direction = 1)::int  AS up,
              count(*) FILTER (WHERE vc.direction = -1)::int AS down,
              count(*) FILTER (WHERE vc.direction = 0)::int  AS revoked
         FROM unnest($1::int[]) AS p
         LEFT JOIN serve.vote_current vc ON vc.page_id = p
        GROUP BY p
     ), chain AS (
       SELECT kind, old_direction, new_direction,
              row_number() OVER w AS rn,
              lag(new_direction) OVER w AS prev_new
         FROM ingest.vote_event
        WHERE page_id = ANY($1::int[])
       WINDOW w AS (PARTITION BY page_id, voter_id ORDER BY seq)
     )
     SELECT
       (SELECT count(*) FROM fold f JOIN serve.page_current pc ON pc.page_id = f.page_id
         WHERE (pc.rating, pc.vote_up, pc.vote_down, pc.vote_revoked)
            IS DISTINCT FROM (f.rating, f.up, f.down, f.revoked))::text AS bad_agg,
       (SELECT count(*) FROM chain
         WHERE (rn = 1 AND old_direction IS NOT NULL)
            OR (rn > 1 AND old_direction IS DISTINCT FROM prev_new))::text AS bad_chain,
       (SELECT count(*) FROM chain WHERE rn = 1 AND kind <> 'vote')::text AS first_not_vote,
       (SELECT count(*) FROM ingest.vote_event
         WHERE page_id = ANY($1::int[]) AND kind = 'revoke' AND old_direction IS NULL)::text AS phantom_revoke,
       (SELECT count(*) FROM ingest.vote_event
         WHERE page_id = ANY($1::int[])
           AND (abs(COALESCE(old_direction, 0)) > 1 OR abs(COALESCE(new_direction, 0)) > 1))::text AS bad_dir,
       (SELECT count(*) FROM serve.vote_current
         WHERE page_id = ANY($1::int[]) AND abs(direction) > 1)::text AS bad_vc,
       (SELECT count(*) FROM meta.revoke_candidate rc JOIN ingest."user" u ON u.id = rc.voter_id
         WHERE rc.page_id = ANY($1::int[]) AND u.kind <> 'wikidot')::text AS cand_non_visible,
       (SELECT count(*) FROM ingest.vote_event_pdefault)::text AS pdefault,
       (SELECT count(*) FROM ingest.vote_event WHERE page_id = ANY($1::int[]))::text AS total_events`,
    [pages],
  );
  return {
    badAgg: Number(row['bad_agg']),
    badChain: Number(row['bad_chain']),
    firstNotVote: Number(row['first_not_vote']),
    phantomRevoke: Number(row['phantom_revoke']),
    badDir: Number(row['bad_dir']),
    badVc: Number(row['bad_vc']),
    candNonVisible: Number(row['cand_non_visible']),
    pdefault: Number(row['pdefault']),
    totalEvents: Number(row['total_events']),
  };
}
