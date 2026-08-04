/**
 * T6.6 · 权限矩阵：bff_role 写 ingest.vote_event 必须被拒（42501）
 * =====================================================================================
 * 对应 0006_functions.sql 文件末自测清单 T6.6，是设计文档「权限即边界」那一重保证的
 * 唯一可执行验收点。要拦的形态是 v1 的既成事故：fast-vote 路径直写聚合列，
 * 绕过了 apply_* 的全部门控，把脏页检测一起致盲。**触发器管不住它** ——
 * `trg_immutable` 只拦 UPDATE / DELETE / TRUNCATE，INSERT 是放行的；
 * 真正让"应用层写错代码也写不进事实表"成立的是 GRANT 矩阵。
 *
 * ── 为什么写成条件跳过 ──────────────────────────────────────────────────────────
 * 实测权限现实：`user_dxzbdi` 有 rolcreatedb=t，但 **rolsuper=f、rolcreaterole=f**。
 * 所以 `migrations/9000_roles_grants.sql.ADMIN` 这一步执行不了，五个角色现在还不存在。
 * 把断言写死会让本文件在角色落地前永久红灯，写掉又会让它永久缺位 —— 两者都不可接受。
 * 本文件因此分三层，能跑多少跑多少，跳过的每一条都打印补救指令：
 *
 *   第 1 层  **现在就能跑**：PUBLIC 不得持有任何事实表 DML、不得能执行任何 apply_*。
 *            （这一层不依赖角色 —— 0006 第 8 节的 REVOKE ALL FROM PUBLIC 已生效）
 *   第 2 层  角色存在则跑**目录级**断言：has_table_privilege('bff_role', …) 必须全 false。
 *            不需要成员资格，DBA 一执行 9000 就自动生效。
 *   第 3 层  当前账号是 bff_role 成员（或 superuser）则跑**行为级**断言：
 *            `SET ROLE bff_role` 后真的 INSERT 一次，必须 42501。
 *
 * 跳过 ≠ 通过：报告里 skip 独立成列，总计行看得见。
 */

import test from 'node:test';
import { openSess } from './helpers/pg.js';
import { Report } from './helpers/report.js';

const ROLES = ['bff_role', 'ingestor_role', 'projector_role', 'avatar_worker_role', 'migration_role'];

/**
 * 角色不存在时统一打印的补救指令。
 * 推荐路径是 9001 + 9002 的拆分（9001 只有 5 条 CREATE ROLE，是唯一需要 CREATEROLE 的动作；
 * 9002 的 GRANT/REVOKE 只要求对象属主身份，应用账号自己就能跑）。9000 是历史上的一把梭版本。
 */
const HINT_9000 =
  '角色不存在 ⇒ 跳过。补救：由 DBA（superuser 或持 CREATEROLE）执行 ' +
  'migrations/9001_create_roles.sql.ADMIN（仅 5 条 CREATE ROLE），然后应用账号重跑 ' +
  'migrations/9002_grants.sql + 0006 第 8 节补 GRANT EXECUTE，本断言即自动生效。' +
  '交接单见 docs/dba-handoff.md。';

test('T6.6 · 权限矩阵：bff_role 写事实表被拒（角色未落地则条件跳过）', async (t) => {
  const rep = new Report('T6.6 · 权限矩阵（bff_role 写 ingest.vote_event 必须 42501）');
  const s = await openSess('t6');

  try {
    // ── 环境实况 ─────────────────────────────────────────────────────────────────
    const who = await s.one<Record<string, string | boolean>>(
      'whoami',
      `SELECT current_user::text AS cur, session_user::text AS sess,
              rolsuper, rolcreaterole, rolcreatedb
         FROM pg_roles WHERE rolname = current_user`,
    );
    const existing = await s.q<{ rolname: string }>(
      'roles',
      `SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`,
      [ROLES],
    );
    const have = new Set(existing.map((r) => r.rolname));
    rep.chk(
      'T6.6 环境',
      '记录当前账号与角色落地情况',
      true,
      `current_user=${String(who['cur'])} rolsuper=${String(who['rolsuper'])} ` +
        `rolcreaterole=${String(who['rolcreaterole'])} 已建角色=[${[...have].join(',') || '无'}]`,
    );

    // =================================================================================
    // 第 1 层 · 不依赖角色：PUBLIC 边界（0006 第 8 节的 REVOKE 已生效，现在就该全绿）
    // =================================================================================
    await t.test('第1层 PUBLIC 边界（无需角色）', async () => {
      const factTables = [
        'ingest.vote_event',
        'ingest.attribution_event',
        'ingest.page_life_event',
        'ingest.page_attr_history',
        'ingest.page_slug_history',
        'ingest.revision',
        'ingest.page_source',
        'ingest.content_blob',
      ];
      for (const tbl of factTables) {
        const row = await s.one<Record<string, boolean>>(
          'public-dml',
          `SELECT has_table_privilege('public', $1, 'INSERT') AS ins,
                  has_table_privilege('public', $1, 'UPDATE') AS upd,
                  has_table_privilege('public', $1, 'DELETE') AS del`,
          [tbl],
        );
        rep.eq(
          '第1层 PUBLIC',
          `PUBLIC 对 ${tbl} 无 INSERT/UPDATE/DELETE`,
          { ins: row['ins'], upd: row['upd'], del: row['del'] },
          { ins: false, upd: false, del: false },
        );
      }

      // 0006 第 8 节：所有 SECURITY DEFINER 函数 REVOKE ALL FROM PUBLIC。
      // 这一条是"权限即边界"里唯一**不需要 CREATEROLE 就能生效**的部分，必须真的成立 ——
      // 否则任何能连库的账号都能以属主身份跑 apply_*，前面那一堆门控全部形同虚设。
      const leaky = await s.q<{ fn: string }>(
        'public-exec',
        `SELECT p.oid::regprocedure::text AS fn
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname IN ('ingest', 'meta')
            AND p.prosecdef
            AND has_function_privilege('public', p.oid, 'EXECUTE')
          ORDER BY 1`,
      );
      rep.eq(
        '第1层 PUBLIC',
        'PUBLIC 不能 EXECUTE 任何 SECURITY DEFINER 函数',
        leaky.map((r) => r.fn),
        [],
      );

      // 反面对照：不可变触发器**不拦 INSERT**（拦 INSERT 的只能是权限）。
      // 这条断言的作用是钉住"为什么必须有 GRANT 矩阵"：如果哪天有人以为触发器够了，
      // 这里会提醒他 INSERT 从来没被触发器管过。
      const trg = await s.q<{ tgname: string; ev: string }>(
        'trigger-events',
        `SELECT t.tgname,
                CASE WHEN (t.tgtype & 4) <> 0 THEN 'INSERT' ELSE '' END ||
                CASE WHEN (t.tgtype & 16) <> 0 THEN 'UPDATE' ELSE '' END ||
                CASE WHEN (t.tgtype & 8) <> 0 THEN 'DELETE' ELSE '' END ||
                CASE WHEN (t.tgtype & 32) <> 0 THEN 'TRUNCATE' ELSE '' END AS ev
           FROM pg_trigger t
          WHERE t.tgrelid = 'ingest.vote_event'::regclass AND NOT t.tgisinternal
          ORDER BY t.tgname`,
      );
      rep.chk(
        '第1层 PUBLIC',
        'ingest.vote_event 的不可变触发器不覆盖 INSERT（⇒ 拦直写只能靠 GRANT）',
        trg.length > 0 && trg.every((r) => !r.ev.includes('INSERT')),
        trg.map((r) => `${r.tgname}:${r.ev}`).join(' '),
      );
    });

    // =================================================================================
    // 第 2 层 · 目录级：角色存在即可断言，无需成员资格
    // =================================================================================
    await t.test('第2层 目录级权限矩阵（需角色已建）', async () => {
      if (!have.has('bff_role')) {
        rep.skip('第2层 目录级', "has_table_privilege('bff_role','ingest.vote_event','INSERT') = false", HINT_9000);
        rep.skip('第2层 目录级', "bff_role 对 serve Tier-1 无 UPDATE", HINT_9000);
        rep.skip('第2层 目录级', 'bff_role 对 meta.* 零权限', HINT_9000);
      } else {
        const neg = await s.one<Record<string, boolean>>(
          'bff-neg',
          `SELECT has_table_privilege('bff_role','ingest.vote_event','INSERT')  AS ins_vote_event,
                  has_table_privilege('bff_role','ingest.vote_event','UPDATE')  AS upd_vote_event,
                  has_table_privilege('bff_role','ingest.vote_event','DELETE')  AS del_vote_event,
                  has_table_privilege('bff_role','serve.vote_current','UPDATE') AS upd_vote_current,
                  has_table_privilege('bff_role','serve.page_current','UPDATE') AS upd_page_current,
                  has_table_privilege('bff_role','meta.ingest_run','INSERT')    AS ins_meta_run,
                  has_table_privilege('bff_role','meta.revoke_candidate','SELECT') AS sel_meta_cand`,
        );
        rep.eq(
          '第2层 目录级',
          'bff_role 对 ingest.vote_event 无任何 DML',
          {
            ins: neg['ins_vote_event'],
            upd: neg['upd_vote_event'],
            del: neg['del_vote_event'],
          },
          { ins: false, upd: false, del: false },
        );
        rep.eq(
          '第2层 目录级',
          'bff_role 对 serve Tier-1 投影无 UPDATE',
          { vc: neg['upd_vote_current'], pc: neg['upd_page_current'] },
          { vc: false, pc: false },
        );
        rep.eq(
          '第2层 目录级',
          'bff_role 对 meta.* 零权限',
          { ins: neg['ins_meta_run'], sel: neg['sel_meta_cand'] },
          { ins: false, sel: false },
        );
        const pos = await s.one<Record<string, boolean>>(
          'bff-pos',
          `SELECT has_table_privilege('bff_role','serve.page_current','SELECT') AS sel_page_current,
                  has_function_privilege('bff_role',
                    'ingest.ensure_user(text,int,text,text,text,text,int)', 'EXECUTE') AS exec_ensure_user`,
        );
        rep.eq(
          '第2层 目录级',
          '正面对照：bff_role 能 SELECT serve 读面、能 EXECUTE ensure_user',
          { sel: pos['sel_page_current'], exec: pos['exec_ensure_user'] },
          { sel: true, exec: true },
        );
      }

      if (!have.has('ingestor_role')) {
        rep.skip('第2层 目录级', 'ingestor_role 不能直写事实表但能 EXECUTE apply_*', HINT_9000);
      } else {
        const ing = await s.one<Record<string, boolean>>(
          'ingestor',
          `SELECT has_table_privilege('ingestor_role','ingest.vote_event','INSERT')  AS direct_insert,
                  has_table_privilege('ingestor_role','serve.vote_current','UPDATE') AS direct_update,
                  has_function_privilege('ingestor_role',
                    'ingest.apply_vote_observation(int,int,int,timestamptz,timestamptz,text,text,bigint,int)',
                    'EXECUTE') AS exec_apply`,
        );
        rep.eq(
          '第2层 目录级',
          'ingestor_role 对事实表零直接 DML，只能经 SECURITY DEFINER 函数',
          { ins: ing['direct_insert'], upd: ing['direct_update'], exec: ing['exec_apply'] },
          { ins: false, upd: false, exec: true },
        );
      }

      if (!have.has('projector_role')) {
        rep.skip('第2层 目录级', 'projector_role 不写事实 / 不写 Tier-1、可写 Tier-2', HINT_9000);
      } else {
        const proj = await s.one<Record<string, boolean>>(
          'projector',
          `SELECT has_table_privilege('projector_role','ingest.vote_event','INSERT') AS ins_fact,
                  has_table_privilege('projector_role','serve.page_current','UPDATE') AS upd_tier1,
                  has_table_privilege('projector_role','serve.page_stats','UPDATE')   AS upd_tier2`,
        );
        rep.eq(
          '第2层 目录级',
          'projector_role 不写事实、不写 Tier-1、可写 Tier-2',
          { fact: proj['ins_fact'], t1: proj['upd_tier1'], t2: proj['upd_tier2'] },
          { fact: false, t1: false, t2: true },
        );
      }
    });

    // =================================================================================
    // 第 3 层 · 行为级：真的 SET ROLE bff_role 再 INSERT，必须 42501
    // =================================================================================
    await t.test('第3层 行为级 42501（需 bff_role 成员资格）', async () => {
      if (!have.has('bff_role')) {
        rep.skip('第3层 行为级', 'SET ROLE bff_role 后 INSERT ingest.vote_event ⇒ 42501', HINT_9000);
        return;
      }
      const canSet = await s.val<boolean>(
        'can-set-role',
        `SELECT pg_has_role(session_user, 'bff_role', 'MEMBER')`,
      );
      if (!canSet) {
        rep.skip(
          '第3层 行为级',
          'SET ROLE bff_role 后 INSERT ingest.vote_event ⇒ 42501',
          `当前账号不是 bff_role 成员（且非 superuser）⇒ 跳过。补救：GRANT bff_role TO ${String(who['sess'])};` +
            '（需 superuser 或该角色的 ADMIN OPTION）。或用 9000 第 11 节的登录账号模板另建连接跑本层。',
        );
        return;
      }

      await s.q('set-role', `SET ROLE bff_role`);
      try {
        const err = await s.expectError(
          'bff-insert',
          `INSERT INTO ingest.vote_event(page_id, voter_id, kind, old_direction, new_direction,
                                         occurred_at, observed_at, time_precision, source)
           VALUES (1, 1, 'vote', NULL, 1, now(), now(), 'observed', 'test_illegal')`,
        );
        rep.eq(
          '第3层 行为级',
          'bff_role INSERT ingest.vote_event ⇒ 42501（权限拒，不是触发器拦）',
          err.sqlstate,
          '42501',
          err.message.slice(0, 90),
        );
        const err2 = await s.expectError(
          'bff-update-tier1',
          `UPDATE serve.page_current SET rating = rating + 1 WHERE page_id = -1`,
        );
        rep.eq('第3层 行为级', 'bff_role UPDATE serve.page_current ⇒ 42501', err2.sqlstate, '42501');
        const okSel = await s.num('bff-select', `SELECT count(*) FROM serve.page_current`);
        rep.chk('第3层 行为级', '正面对照：bff_role 能 SELECT serve.page_current', okSel !== null, `${okSel} 行`);
      } finally {
        await s.q('reset-role', `RESET ROLE`);
      }
    });

    // =================================================================================
    // 第 4 层 · 机制自检：用一个**现存的无权角色**把 T6.6 的行为级路径完整排演一遍
    // =================================================================================
    // 第 3 层在角色落地前必然跳过，而"跳过的断言"没有任何证明力 —— 它连自己写对了都证明不了。
    // 这一层用 `pg_database_owner`（预定义角色，当前账号作为库主天然是其成员，
    // 且它对 ingest/serve 零权限）把同一条路径真的走一遍：
    //   GRANT USAGE ON SCHEMA → SET LOCAL ROLE → INSERT 事实表 ⇒ 必须 42501（表级，不是 schema 级）
    // 这样能证明的事：
    //   ① `SET ROLE` + 捕获 sqlstate 这套机制本身可用；
    //   ② `ingest.vote_event` 对**任何未被授权的角色**都是 42501，而不是靠触发器拦；
    //   ③ 第 3 层的断言体一旦角色到位就能原样生效（只差把角色名换成 bff_role）。
    // 全程包在一个事务里并 ROLLBACK —— GRANT/REVOKE 在 PG 里是事务性的，
    // 所以这些临时授权不会泄漏出测试（末尾有一条负向断言专门证明这一点）。
    await t.test('第4层 机制自检：无权角色写事实表确实 42501（不依赖 9000）', async () => {
      await s.begin();
      try {
        // 先授 schema USAGE：不授的话会在 schema 级就被拒（同样是 42501，但证明力弱一档 ——
        // bff_role 是有 schema USAGE 的，它必须**在表级**被拒，那才是 GRANT 矩阵真正的边界）。
        await s.q('grant-usage', `GRANT USAGE ON SCHEMA ingest, serve TO pg_database_owner`);
        await s.q('grant-select', `GRANT SELECT ON serve.page_current TO pg_database_owner`);
        await s.q('set-local-role', `SET LOCAL ROLE pg_database_owner`);

        const cur = await s.val<string>('cur-user', `SELECT current_user::text`);
        rep.eq('第4层 机制自检', 'SET LOCAL ROLE 生效（current_user 已切换）', cur, 'pg_database_owner');

        const e1 = await s.expectError(
          'insert-fact',
          `INSERT INTO ingest.vote_event(page_id, voter_id, kind, old_direction, new_direction,
                                         occurred_at, observed_at, time_precision, source)
           VALUES (1, 1, 'vote', NULL, 1, now(), now(), 'observed', 'test_illegal')`,
          undefined,
          true,
        );
        rep.eq(
          '第4层 机制自检',
          '无权角色 INSERT ingest.vote_event ⇒ 42501（表级拒）',
          { state: e1.sqlstate, tableLevel: /table (ingest\.)?vote_event/.test(e1.message) },
          { state: '42501', tableLevel: true },
          e1.message.slice(0, 80),
        );

        const e2 = await s.expectError(
          'update-tier1',
          `UPDATE serve.page_current SET rating = rating + 1 WHERE page_id = -1`,
          undefined,
          true,
        );
        rep.eq(
          '第4层 机制自检',
          '无权角色 UPDATE serve.page_current(Tier-1 投影) ⇒ 42501',
          { state: e2.sqlstate, tableLevel: /table (serve\.)?page_current/.test(e2.message) },
          { state: '42501', tableLevel: true },
          e2.message.slice(0, 80),
        );

        const e3 = await s.expectError(
          'exec-apply',
          `SELECT ingest.apply_vote_observation(1, 1, 1, now(), now(), 'observed', 'x', NULL)`,
          undefined,
          true,
        );
        rep.eq(
          '第4层 机制自检',
          '未授权角色连 apply_vote_observation 都不能执行 ⇒ 42501（0006 第8节的 REVOKE FROM PUBLIC 生效）',
          e3.sqlstate,
          '42501',
          e3.message.slice(0, 80),
        );

        const n = await s.num('select-granted', `SELECT count(*) FROM serve.page_current`);
        rep.chk('第4层 机制自检', '正面对照：显式授了 SELECT 的表读得到（证明拒绝是精准的，不是全盘不通）', n !== null, `${n} 行`);

        await s.q('reset-local-role', `RESET ROLE`);
      } finally {
        await s.rollback();
      }

      // 负向断言：临时授权必须随事务回滚一起消失，不能泄漏到库里
      const leaked = await s.one<Record<string, boolean>>(
        'leak-check',
        `SELECT has_table_privilege('pg_database_owner','serve.page_current','SELECT') AS sel,
                has_schema_privilege('pg_database_owner','ingest','USAGE')            AS usg`,
      );
      rep.eq(
        '第4层 机制自检',
        '临时授权已随 ROLLBACK 完全消失（GRANT 在 PG 里是事务性的）',
        { sel: leaked['sel'], usg: leaked['usg'] },
        { sel: false, usg: false },
      );
    });
  } finally {
    await s.end();
  }

  rep.finish();
});
