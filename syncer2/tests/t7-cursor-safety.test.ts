/**
 * T7.1 / T7.2 · 多会话乱序提交注入（游标安全水位）
 * =====================================================================================
 * 对应 0006_functions.sql 文件末自测清单的 T7.1 / T7.2 / T7.5，是设计文档 §5.5 明确要求的
 * **Phase 1 合入 gate**，也是"静默漏投影"的唯一防线。
 *
 * ── 被测的那个 bug 长什么样 ──────────────────────────────────────────────────────
 * 现实是多写者（sitemap CLI concurrency=4、Phase C 回填 concurrency=2、未来 sentinel），
 * 所以「分配 seq 的顺序 = 提交的顺序」**不成立**：
 *     写者 A  取到 seq=100 ────────────────────────(慢)────────────── 提交
 *     写者 B          取到 seq=101 ── 提交
 *     projector                          此刻 fact_seq.last_value = 101
 * 如果 projector 用 `fact_seq.last_value` 当水位，它会消费到 101、把游标推到 101，
 * 而 A 的 100 在**之后**才可见 —— 从此永远落在游标后面。没有报错、没有告警，
 * 只有投影表里少一条事实。这就是"静默漏投影"。
 *
 * ── 防线与它的一个反直觉之处（T7.5）─────────────────────────────────────────────
 * 设计 §5.5 的原始机制是 `meta.ingest_gate` 表：摄入事务分配 seq 前 INSERT(txid, seq_floor)、
 * 提交前 DELETE，projector 取 `min(seq_floor) - 1`。**但这在 MVCC 下无效**：A 未提交时
 * 它 INSERT 的那一行对 projector 不可见，`min(seq_floor)` 永远看不见"正在飞行中"的写者 ——
 * 而那恰恰是要防的对象。0006 因此把权威机制换成**事务级 advisory lock 屏障**
 * （非 MVCC、跨会话立即可见），表机制降级为取证 + "独立控制连接登记"用法。
 * T7.5 把这条反直觉性质写成断言，防止后人"优化"掉屏障锁只留表。
 *
 * ── 为什么必须用两个连接 ────────────────────────────────────────────────────────
 * 冒烟 smoke_test.sql 是单文件单事务的 psql 脚本，构造不出"A 已分配 seq 但未提交、
 * 同时 B 去读水位"这个状态 —— 同一个连接里怎么写都看不出问题（它自己看得见自己）。
 * 这就是本文件存在的原因。
 *
 * 本测试**真提交**数据（跨会话可见性是被测对象本身，回滚在语义上用不了），
 * 末尾按专属 id 段清理并断言零残留。
 */

import test from 'node:test';
import { openSess, type Sess } from './helpers/pg.js';
import { Report } from './helpers/report.js';
import {
  OBSERVED_ISO,
  assertNoResidue,
  cleanupAll,
  createRun,
  ensureUsers,
  registerPage,
} from './helpers/fixture.js';

const PROJECTION = 'test_t7_vote_current';

/** 一次单票摄入，返回新事件 seq。 */
async function applyVote(
  s: Sess,
  page: number,
  voter: number,
  direction: number,
  run: number,
): Promise<number> {
  const seq = await s.num(
    'apply_vote_observation',
    `SELECT ingest.apply_vote_observation($1::int, $2::int, $3::int,
              $4::timestamptz, $4::timestamptz, 'observed', 'test_wikidot', $5::bigint)`,
    [page, voter, direction, OBSERVED_ISO, run],
  );
  if (seq === null) throw new Error(`applyVote 返回 NULL（无转移）page=${page} voter=${voter}`);
  return seq;
}

interface RoundResult {
  window: { from: number; to: number } | null;
  consumed: number[];
  cursor: number;
}

/**
 * projector 的一轮：`projection_window()` → 读窗口内事实 → 同事务 `advance_projection_cursor()`。
 * 这就是 0006 里写的"统一模式"，测试必须照这个模式跑，否则测的不是生产路径。
 */
async function projectorRound(p: Sess, pages: number[]): Promise<RoundResult> {
  await p.begin();
  try {
    const w = await p.q<{ from_seq: string; to_seq: string }>(
      'projection_window',
      `SELECT from_seq::text AS from_seq, to_seq::text AS to_seq FROM meta.projection_window($1)`,
      [PROJECTION],
    );
    if (w.length === 0) {
      const cursor =
        (await p.num('cursor', `SELECT last_seq FROM meta.projection_cursor WHERE projection = $1`, [
          PROJECTION,
        ])) ?? 0;
      await p.commit();
      return { window: null, consumed: [], cursor };
    }
    const from = Number(w[0]?.from_seq);
    const to = Number(w[0]?.to_seq);
    const evs = await p.q<{ seq: string }>(
      'read-window',
      `SELECT seq::text AS seq FROM ingest.vote_event
        WHERE seq BETWEEN $1::bigint AND $2::bigint AND page_id = ANY($3::int[])
        ORDER BY seq`,
      [from, to, pages],
    );
    const cursor =
      (await p.num('advance', `SELECT meta.advance_projection_cursor($1, $2::bigint)`, [
        PROJECTION,
        to,
      ])) ?? 0;
    await p.commit();
    return { window: { from, to }, consumed: evs.map((r) => Number(r.seq)), cursor };
  } catch (err) {
    await p.rollback().catch(() => undefined);
    throw err;
  }
}

test('T7 · 多会话乱序提交注入：游标安全水位（设计 §5.5 / Phase 1 合入 gate）', async (t) => {
  const rep = new Report('T7 · 多会话乱序提交注入（游标安全水位）');

  const ctl = await openSess('ctl'); // 控制/观察连接（不做摄入，不持屏障锁）
  const A = await openSess('writerA');
  const B = await openSess('writerB');
  const C = await openSess('writerC');
  const D = await openSess('writerD');
  const P = await openSess('projector');

  try {
    // ── 前置清理：上一次跑崩留下的残留会让断言无从下手 ────────────────────────────
    await cleanupAll(ctl);

    const run = await createRun(ctl);
    const pA = await registerPage(ctl, 701, 'ts2test:t7-a');
    const pB = await registerPage(ctl, 702, 'ts2test:t7-b');
    const pC = await registerPage(ctl, 703, 'ts2test:t7-c');
    const pD = await registerPage(ctl, 704, 'ts2test:t7-d');
    const users = await ensureUsers(ctl, 'wikidot', 701, 12);
    const pages = [pA, pB, pC, pD];

    // 游标起点 = 当前安全水位（此刻无人持屏障锁，一定拿得到）。
    const startMark = await ctl.num('start-mark', `SELECT meta.safe_seq_watermark()`);
    rep.chk('T7.0 前置', '建游标前能拿到安全水位', startMark !== null, `水位=${startMark}`);
    await ctl.q(
      'register-projection',
      `INSERT INTO meta.projection_cursor(projection, event_domain, last_seq, rebuild_from)
       VALUES ($1, 'vote', $2::bigint,
               '(测试专用) ingest.vote_event 折叠到 serve.vote_current')
       ON CONFLICT (projection) DO UPDATE SET last_seq = EXCLUDED.last_seq`,
      [PROJECTION, startMark ?? 0],
    );

    // 起手时 gate 表里不该有 in-progress 行（前置清理刚 sweep 过）
    const gate0 = await ctl.num(
      'gate0',
      `SELECT count(*) FROM meta.ingest_gate
        WHERE COALESCE(txid_status(txid), 'committed') = 'in progress'`,
    );
    rep.eq('T7.0 前置', 'gate 表无 in-progress 残留行', gate0, 0);

    // =================================================================================
    // T7.1 · A 分配 seq 但不提交 ⇒ B 读到的水位绝不 ≥ A 的 seq
    // =================================================================================
    await t.test('T7.1 未提交的 seq 绝不进入安全水位', async () => {
      await A.begin();
      const seqA = await applyVote(A, pA, users[0] as number, 1, run);

      // (a) 朴素水位（= 序列 last_value）此刻**已经**越过了 A 的 seq —— 这就是要防的对象。
      const naive = await ctl.num('naive', `SELECT pg_sequence_last_value('ingest.fact_seq')`);
      rep.chk(
        'T7.1',
        '朴素水位(fact_seq.last_value) 已越过未提交的 seq（反例基线）',
        naive !== null && naive >= seqA,
        `last_value=${naive} ≥ seqA=${seqA}`,
      );

      // (b) T7.5：A 的 gate 行对 B 不可见 —— 表机制单独用是无效的
      const gateVisible = await ctl.num(
        'gate-visible',
        `SELECT count(*) FROM meta.ingest_gate WHERE txid = txid_current()`,
      );
      const gateInProgress = await ctl.num(
        'gate-inprogress',
        `SELECT count(*) FROM meta.ingest_gate
          WHERE COALESCE(txid_status(txid), 'committed') = 'in progress'`,
      );
      rep.eq('T7.5', 'A 未提交时它的 ingest_gate 行对他人不可见（MVCC 边界）', gateInProgress, 0);
      rep.eq('T7.5', '控制连接自身没有 gate 行（未做摄入）', gateVisible, 0);
      const tableOnly = await ctl.num(
        'table-only',
        `SELECT COALESCE(min(seq_floor) - 1, pg_sequence_last_value('ingest.fact_seq'))
           FROM meta.ingest_gate
          WHERE COALESCE(txid_status(txid), 'committed') = 'in progress'`,
      );
      rep.chk(
        'T7.5',
        '只用 min(seq_floor) 的表机制会算出不安全的水位（所以屏障锁不可被"优化"掉）',
        tableOnly !== null && tableOnly >= seqA,
        `表机制水位=${tableOnly} ≥ seqA=${seqA}`,
      );

      // (c) 真正的断言：safe_seq_watermark() 绝不返回 ≥ seqA
      const mark = await ctl.num('mark-during', `SELECT meta.safe_seq_watermark(1, 0)`);
      rep.chk(
        'T7.1',
        'A 未提交时 safe_seq_watermark() 不越过 A 的 seq',
        mark === null || mark < seqA,
        mark === null ? '返回 NULL（屏障锁被 A 持有 ⇒ 本轮不推进游标）' : `水位=${mark} < seqA=${seqA}`,
      );

      // (d) 窗口必须为空 —— projector 这一轮什么都不该消费
      const r = await projectorRound(P, pages);
      rep.eq('T7.1', 'A 未提交时 projection_window() 为空窗口', r.window, null);
      rep.eq('T7.1', 'A 未提交时 projector 消费 0 条', r.consumed.length, 0);

      // (e) A 提交后水位必须追上
      await A.commit();
      const markAfter = await ctl.num('mark-after', `SELECT meta.safe_seq_watermark()`);
      rep.chk(
        'T7.1',
        'A 提交后 safe_seq_watermark() ≥ A 的 seq',
        markAfter !== null && markAfter >= seqA,
        `水位=${markAfter} ≥ seqA=${seqA}`,
      );

      // (f) 提交后 A 的 gate 行不再算 in-progress（同事务 INSERT+DELETE，实际连行都不剩）
      const gateAfter = await ctl.num(
        'gate-after',
        `SELECT count(*) FROM meta.ingest_gate
          WHERE COALESCE(txid_status(txid), 'committed') = 'in progress'`,
      );
      rep.eq('T7.1', 'A 提交后 gate 表无 in-progress 行', gateAfter, 0);

      // ⚠ 实测发现（本测试的副产物，README 里原本的描述不准确）：
      // `apply_*` 只在入口调 `meta.ingest_gate_open()`，**从不调 `ingest_gate_close()`**
      //（0006 里它被标为"可选出口"）。所以 gate 行不是"同事务 INSERT+DELETE"，
      // 而是**提交后留在表里**（状态 committed，不影响水位正确性，因为
      // `safe_seq_watermark` 只统计 `txid_status = 'in progress'` 的行）。
      // 后果是运维层面的：这张表会随摄入量单调增长，必须有一个周期任务调
      // `meta.ingest_gate_sweep()`。这条断言把这个事实钉住 —— 哪天有人给 apply_* 加上
      // gate_close，它会变红并提醒同步删掉 sweep 的调度依赖。
      const gateRows = await ctl.num('gate-rows', `SELECT count(*) FROM meta.ingest_gate`);
      rep.chk(
        'T7.1',
        'apply_* 提交后 gate 行残留（不调 gate_close）⇒ 必须有周期 ingest_gate_sweep()',
        gateRows !== null && gateRows > 0,
        `ingest_gate 现存 ${gateRows} 行（全部 committed，不影响水位）`,
      );

      // (g) 现在该消费到 A 的事件了
      const r2 = await projectorRound(P, pages);
      rep.eq('T7.1', 'A 提交后 projector 恰好消费 A 的那一条', r2.consumed, [seqA]);
    });

    // =================================================================================
    // T7.2 · 三写者交错取 seq / 交错提交 ⇒ 每条事实被恰好消费一次
    // =================================================================================
    await t.test('T7.2 交错提交下每条 vote_event 被恰好消费一次', async () => {
      const consumedAll: number[] = [];
      const record = (r: RoundResult): RoundResult => {
        consumedAll.push(...r.consumed);
        return r;
      };

      // ---- 三个写者各开事务、按 A→B→C 的顺序分配 seq --------------------------------
      await A.begin();
      const a1 = await applyVote(A, pA, users[1] as number, 1, run);
      await B.begin();
      const b1 = await applyVote(B, pB, users[2] as number, 1, run);
      await C.begin();
      const c1 = await applyVote(C, pC, users[3] as number, -1, run);
      rep.chk(
        'T7.2',
        'seq 按 A→B→C 分配（a1 < b1 < c1）',
        a1 < b1 && b1 < c1,
        `a1=${a1} b1=${b1} c1=${c1}`,
      );

      // ---- 第 1 轮：三者都在飞行中 ⇒ 空窗口 -----------------------------------------
      const r1 = record(await projectorRound(P, pages));
      rep.eq('T7.2', '第1轮(A,B,C 均未提交) 空窗口', r1.window, null);

      // ---- C 先提交（乱序！C 的 seq 最大却最先提交）---------------------------------
      await C.commit();
      const r2 = record(await projectorRound(P, pages));
      rep.eq('T7.2', '第2轮(C 已提交,A/B 在飞) 仍为空窗口 ⇒ 不会跳过 a1/b1', r2.window, null);
      rep.eq('T7.2', '第2轮消费 0 条（关键：朴素水位会在此消费 c1 并跳过 a1/b1）', r2.consumed, []);

      // ---- B 提交 ------------------------------------------------------------------
      await B.commit();
      const r3 = record(await projectorRound(P, pages));
      rep.eq('T7.2', '第3轮(仅 A 在飞) 仍为空窗口', r3.window, null);

      // ---- A 在同一事务里再取一个 seq，然后才提交 -------------------------------------
      const a2 = await applyVote(A, pA, users[4] as number, 1, run);
      const r4 = record(await projectorRound(P, pages));
      rep.eq('T7.2', '第4轮(A 又取了一个 seq) 仍为空窗口', r4.window, null);
      await A.commit();

      // ---- 第 5 轮：全部提交 ⇒ 一次性消费四条，顺序按 seq --------------------------
      const r5 = record(await projectorRound(P, pages));
      rep.eq('T7.2', '第5轮一次消费全部四条（含乱序提交的 c1）', r5.consumed, [a1, b1, c1, a2]);

      // ---- 追加两个"正常"写者（分配即提交），验证游标继续前进 ------------------------
      await A.begin();
      const a3 = await applyVote(A, pA, users[5] as number, -1, run);
      await A.commit();
      await B.begin();
      const b2 = await applyVote(B, pB, users[6] as number, 1, run);
      await B.commit();
      const r6 = record(await projectorRound(P, pages));
      rep.eq('T7.2', '第6轮消费后续两条', r6.consumed, [a3, b2]);

      // ---- 回滚的写者：seq 被烧掉但没有事实行，projector 不得卡住 --------------------
      await D.begin();
      const d1 = await applyVote(D, pD, users[7] as number, 1, run);
      await D.rollback();
      const r7 = record(await projectorRound(P, pages));
      rep.chk(
        'T7.2',
        '回滚写者烧掉的 seq 不产生事实行，游标照常越过（不卡住）',
        r7.consumed.length === 0 && r7.cursor >= d1,
        `d1=${d1} 被烧掉，游标推进到 ${r7.cursor}`,
      );

      // ---- 空转一轮：没有新事实 ⇒ 空窗口，且不重复消费 ------------------------------
      const r8 = record(await projectorRound(P, pages));
      rep.eq('T7.2', '无新事实时为空窗口（不重复消费）', r8.consumed, []);

      // ---- 终局：0 漏投影 / 0 重复 -------------------------------------------------
      const expected = [a1, b1, c1, a2, a3, b2].sort((x, y) => x - y);
      const actual = [...consumedAll].sort((x, y) => x - y);
      rep.eq('T7.2', '每条 vote_event 被恰好消费一次（0 漏 / 0 重复）', actual, expected);
      const dupes = actual.filter((v, i) => i > 0 && v === actual[i - 1]);
      rep.eq('T7.2', '消费序列无重复项', dupes, []);

      // 库里真实存在的测试事件数必须等于被消费数（0 漏投影的独立口径）
      const inDb = await ctl.num(
        'events-in-db',
        `SELECT count(*) FROM ingest.vote_event WHERE page_id = ANY($1::int[]) AND seq > $2::bigint`,
        [pages, startMark ?? 0],
      );
      rep.eq('T7.2', '库内事实条数 = 被消费条数 + T7.1 的一条', inDb, expected.length + 1);
    });

    // =================================================================================
    // T7.3 / T7.4 的多会话补充：拿不到水位时必须抛 55006，而不是静默推进
    // =================================================================================
    await t.test('T7.4 拿不到安全水位时 advance_projection_cursor 抛 55006', async () => {
      const before =
        (await ctl.num('cursor-before', `SELECT last_seq FROM meta.projection_cursor WHERE projection = $1`, [
          PROJECTION,
        ])) ?? 0;

      // C 开一个摄入事务并持住屏障锁（不提交）
      await C.begin();
      await applyVote(C, pC, users[8] as number, 1, run);

      // 用一个"重试极短"的包装：直接调 safe_seq_watermark(1,0) 确认拿不到，
      // 再调 advance_projection_cursor（它内部用默认 3×100ms 重试，C 一直持锁 ⇒ 必失败）
      const markNull = await ctl.num('mark-null', `SELECT meta.safe_seq_watermark(1, 0)`);
      rep.eq('T7.4', '摄入侧持锁时 safe_seq_watermark(1,0) 返回 NULL', markNull, null);

      const err = await ctl.expectError(
        'advance-should-fail',
        `SELECT meta.advance_projection_cursor($1, 9223372036854775000::bigint)`,
        [PROJECTION],
      );
      rep.eq('T7.4', 'advance_projection_cursor 抛 55006（绝不猜水位）', err.sqlstate, '55006');

      const after =
        (await ctl.num('cursor-after', `SELECT last_seq FROM meta.projection_cursor WHERE projection = $1`, [
          PROJECTION,
        ])) ?? 0;
      rep.eq('T7.4', '抛错后游标一动不动', after, before);

      await C.rollback();

      // T7.3 的多会话版：无人持锁时传一个天文数字，只能推到水位
      const mark = await ctl.num('mark-final', `SELECT meta.safe_seq_watermark()`);
      const pushed = await ctl.num(
        'advance-clamp',
        `SELECT meta.advance_projection_cursor($1, 9223372036854775000::bigint)`,
        [PROJECTION],
      );
      rep.eq('T7.3', 'p_to_seq 远超水位时只推到水位（双重钳制）', pushed, mark);
    });

    // ── 清理 + 零残留证据 ─────────────────────────────────────────────────────────
    await t.test('清理：测试数据零残留', async () => {
      const counts = await cleanupAll(ctl);
      const deleted = Object.entries(counts)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}=${n}`)
        .join(' ');
      rep.chk('清理', '清理语句执行成功', true, deleted || '（无可删）');
      const residue = await assertNoResidue(ctl);
      const total = Object.values(residue).reduce((a, b) => a + b, 0);
      rep.eq('清理', '专属 id 段内零残留', total, 0, JSON.stringify(residue));
    });
  } finally {
    await Promise.all([A.end(), B.end(), C.end(), D.end(), P.end(), ctl.end()]);
  }

  rep.finish();
});
