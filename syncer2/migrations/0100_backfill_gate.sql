-- =====================================================================================
-- 0100_backfill_gate.sql —— Phase 2 回填收尾 gate 的落地载体（TODO #7）
-- =====================================================================================
-- 目标库    : scpper-v2（全新独立库，与 v1 生产库 scpper-cn 物理隔离）
-- 配套脚本  : checks/backfill_finalize.sql   断言 + 序列重置（本文件建的表是它的输入/输出）
--             checks/load_v1_identity.sh    把 v1 身份 id 集合单向 COPY 进暂存表
--
-- 为什么需要新表（= 为什么不能只写一个 SQL 脚本就完事）：
--   TODO #7 要求的核心断言是「v1 Page.id ↔ v2 ingest.page.id 一一对应」。这是**跨库**
--   断言：v1 在 scpper-cn，v2 在 scpper-v2。PostgreSQL 里跨库只有 dblink / postgres_fdw，
--   而两者都**不是 trusted extension**（实测）：
--       scpper-v2=> CREATE EXTENSION dblink;
--       ERROR:  permission denied to create extension "dblink"
--       HINT:   Must be superuser to create this extension.
--   当前账号 user_dxzbdi rolsuper=f / rolcreaterole=f（README「权限现实」一节），
--   所以这条路在本机是死的。
--   ⇒ 改为「暂存表 + 单向 COPY」：checks/load_v1_identity.sh 在 v1 上跑**只读**的
--     `COPY (SELECT id, "wikidotId" FROM "Page") TO STDOUT`，管道灌进 v2 的 meta.v1_identity，
--     之后所有断言都是 scpper-v2 内部的纯 SQL。v1 侧只发生 SELECT，符合「主库只读」硬约束。
--
-- 【偏离设计文档之处 · 逐条理由】
--   E1. 文档 §4.7 的 meta 表清单里没有 v1_identity / v1_identity_load / backfill_gate_run。
--       理由：文档（以及 0001_ingest.sql 对 ingest.page.id 的注释）写的是「迁移脚本内置断言」，
--       但没说断言的证据从哪来。断言若只活在回填脚本的内存里，gate 就无法**事后重跑**、
--       无法留痕、也无法在 CI 里独立验证。落成表之后「回填是否真的一一对应」变成一条
--       任何人任何时候都能重跑的 SQL。
--   E2. ingest.page_id_seq / ingest.user_id_seq 由默认 bigint 收窄为 `AS integer`。
--       理由见下方 §3 的注释块（不是风格偏好，是让 setval 的非法值当场被拒）。
--
-- 【为什么编号从 0100 起，而不是紧接 0006 的 0007】
--   0001–00xx 留给 Phase 1 的 schema 迁移（同一轮里还有若干并行任务在占 0007–0012），
--   本文件是**Phase 2 专属**：它建的三张表在 Phase 2 回填结束、v2 成为唯一写入源之后
--   就只剩考古价值（暂存表可 TRUNCATE，gate 留痕表长期只读）。
--   把 Phase 2 的迁移收进独立的 0100+ 区段，一是与 Phase 1 的编号竞争彻底脱钩，
--   二是「哪些迁移在切换完成后可以退役」这个问题从此看编号就能回答。
--   apply.sh 用 `LC_ALL=C sort` 排序 `[0-9]*.sql`，0100 稳定落在 0012 之后、9000 之前。
--
-- 幂等：全部 CREATE ... IF NOT EXISTS / 条件化 ALTER。已实测连跑两遍零错误。
--       本文件**不含任何 DROP**，重跑不会丢暂存数据。
-- =====================================================================================

\set ON_ERROR_STOP on

BEGIN;

-- -------------------------------------------------------------------------------------
-- 安全闸：本文件永远不允许落到 v1 生产库 / 用户库（与 0001–0006 同一道闸）
-- -------------------------------------------------------------------------------------
DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      'refusing to apply v2 backfill-gate DDL to protected database % (read-only by policy)',
      current_database();
  END IF;
END $$;


-- =====================================================================================
-- 1. meta.v1_identity —— v1 身份 id 集合的只读暂存
-- =====================================================================================
-- 一次性载入（Phase 2 回填前后各载一次即可），之后只被 SELECT。
-- 刻意**不加**指向 ingest.page / ingest."user" 的外键：这张表的用途正是发现
-- 「v1 有而 v2 没有」，加了外键就永远装不进那些缺失行，断言自我阉割。
CREATE TABLE IF NOT EXISTS meta.v1_identity (
  entity     text NOT NULL CHECK (entity IN ('page','user','gacha_page_ref')),
  v1_id      int  NOT NULL,
  wikidot_id int,                    -- v1 Page."wikidotId" / User."wikidotId"；gacha_page_ref 恒 NULL
  detail     jsonb,                  -- 可选：slug / display_name，便于报错时定位到具体页面
  PRIMARY KEY (entity, v1_id)
);
COMMENT ON TABLE meta.v1_identity IS
  'v1 身份 id 集合的只读暂存，由 checks/load_v1_identity.sh 从 scpper-cn / scpper_user 单向 COPY 灌入。'
  '存在的唯一理由：dblink / postgres_fdw 都需要 superuser（实测 42501），跨库断言只能靠暂存表落地。'
  '刻意无外键 —— 它必须能装下「v1 有而 v2 没有」的行，否则断言自我阉割。';
COMMENT ON COLUMN meta.v1_identity.entity IS
  '''page''           = v1 public."Page"（scpper-cn）；'
  '''user''           = v1 public."User"（scpper-cn）；'
  '''gacha_page_ref'' = v1 public."GachaCardDefinition"."pageId" 的 distinct 集合（scpper_user，跨库软外键）。'
  '【2026-07-27 实测】gacha 侧 82,184 张卡定义引用 36,957 个 distinct pageId（min 301 / max 106,804），'
  '全部落在 v1 Page.id 值域内 —— 这就是 0001_ingest.sql 里「id 永不重排/复用」那句承诺的债主。';
COMMENT ON COLUMN meta.v1_identity.wikidot_id IS
  'v1 侧观测身份。断言 A1.3 / A2.3 用它验「id 没有整体错位」：只比 id 集合相等是不够的 ——'
  '两边 id 集合可以完全相同而 id→wikidot_id 的配对整体错乱（回填时 ORDER BY 写错就是这个形态）。';
COMMENT ON COLUMN meta.v1_identity.detail IS
  '可选诊断字段（slug / display_name / 引用该 page 的卡片数）。断言不读它，只在报错消息里回显。';

CREATE INDEX IF NOT EXISTS v1i_wid ON meta.v1_identity(entity, wikidot_id)
  WHERE wikidot_id IS NOT NULL;


-- =====================================================================================
-- 2. meta.v1_identity_load —— 载入元数据（防「空表让断言真空通过」）
-- =====================================================================================
-- 这张表是整套 gate 里最容易被省掉、也最关键的一环。
-- 反面教材：`SELECT count(*) FROM (v1 集合 EXCEPT v2 集合)` 在 v1 集合为空时返回 0，
-- 于是「一一对应」这条断言在**暂存表根本没载入**的情况下全绿，gate 沦为安慰剂。
-- 所以断言 A0 先校验：载入记录存在 / 未过期 / expected_rows 与实际行数逐条相等 /
-- 源库名不是 scpper-v2 自己。
--
-- 单列主键 entity（不是复合键）：每个 entity 只应有一次「当前有效」的载入记录，
-- 重载走 INSERT ... ON CONFLICT (entity) DO UPDATE，语义即「覆盖上一次载入」。
CREATE TABLE IF NOT EXISTS meta.v1_identity_load (
  entity          text        PRIMARY KEY
                    CHECK (entity IN ('page','user','gacha_page_ref')),
  source_database text        NOT NULL,
  expected_rows   bigint      NOT NULL CHECK (expected_rows >= 0),
  loaded_at       timestamptz NOT NULL DEFAULT now(),
  loader          text        NOT NULL DEFAULT current_user,
  note            text
);
COMMENT ON TABLE meta.v1_identity_load IS
  '每个 entity 一行的载入元数据。gate 的断言 A0 用它把「暂存表没载入」和「暂存表载入了且确实为空」'
  '区分开 —— 没有这张表，跨库一一对应断言在空表上会真空通过。'
  'expected_rows 由 loader 在 v1 侧独立 count 得到，与 v2 侧实际行数逐条对账。';
COMMENT ON COLUMN meta.v1_identity_load.source_database IS
  '源库名（''scpper-cn'' / ''scpper_user''）。断言 A0 拒绝 ''scpper-v2'' —— 自己灌自己等于零信息。';
COMMENT ON COLUMN meta.v1_identity_load.expected_rows IS
  '载入时在 v1 侧独立跑的 count(*)。与 v2 侧实际行数不等 ⇒ COPY 被截断（管道中断 / 磁盘满 / 权限），'
  '此时任何差集断言的结论都是假的，必须直接判 gate 失败而不是继续算。';
COMMENT ON COLUMN meta.v1_identity_load.loaded_at IS
  '载入时刻。gate 有一道「过期」断言：暂存快照比 ingest.page 最新一行的 created_at 还旧 ⇒'
  '回填在载入之后仍在继续，此刻做一一对应对账没有意义。';


-- =====================================================================================
-- 3. 身份序列收窄为 int4 域（偏离项 E2）
-- =====================================================================================
-- ingest.page.id / ingest."user".id 都是 `int`（0001_ingest.sql，原样保留 V1 值域），
-- 而 0006_functions.sql §4.0 建的 ingest.page_id_seq / user_id_seq 是 `CREATE SEQUENCE`
-- 的默认 bigint，register_page / ensure_user 里写的是 `nextval(...)::int`。
--
-- 这个组合有一个**只在 gate 这一刻才能便宜地拦住**的坑：
--   scpper-v2=> SELECT setval('ingest.page_id_seq', 3000000000);   -- 今天：成功
--   scpper-v2=> SELECT ingest.register_page(...);                  -- 明天：22003 integer out of range
-- setval 正是回填收尾脚本要跑的动作，它今天接受一个 nextval 永远无法交付的值，
-- 错误因此从「setval 当场报错」推迟到「某次真实注册页面时炸」，而且现场已经不在 gate 里了。
-- 收窄为 `AS integer` 后 setval 自己就会拒（22003），失败点回到出错的那条语句上；
-- 序列耗尽也变成语义正确的 2200H `reached maximum value of sequence` 而不是类型转换错。
--
-- 【2026-07-27 实测的实际水位】v1 max(Page.id) = 106,804；v1 max(User.id) = 282,240,277
-- （User.id 不是紧凑自增：37,455 行里 8,743 行 id > 2,000,000）。
-- 收窄后 user_id_seq 剩余余量 = 2,147,483,647 − 282,240,277 ≈ 18.6 亿，够用；
-- 但这条余量现在**可被断言监控**（pg_sequences.max_value 有了有限值），以前是隐式的。
DO $$
DECLARE
  r      record;
  v_last bigint;
BEGIN
  FOR r IN SELECT unnest(ARRAY['page_id_seq','user_id_seq']) AS seqname
  LOOP
    IF EXISTS (
      SELECT 1 FROM pg_sequences s
       WHERE s.schemaname = 'ingest' AND s.sequencename = r.seqname
         AND s.data_type = 'integer'::regtype
    ) THEN
      RAISE NOTICE '[0100] ingest.% 已是 integer 域，跳过', r.seqname;
      CONTINUE;
    END IF;

    -- 水位已超出 int4 ⇒ 收窄会失败。这属于「已经出事了」，直接抛而不是静默跳过。
    EXECUTE format('SELECT last_value FROM ingest.%I', r.seqname) INTO v_last;
    IF v_last > 2147483647 THEN
      RAISE EXCEPTION
        '[0100] ingest.% 的 last_value=% 已超出 int4 域，无法收窄；'
        'ingest.page.id / ingest."user".id 是 int，该序列已不可能再交付合法 id',
        r.seqname, v_last USING ERRCODE = '22003';
    END IF;

    EXECUTE format('ALTER SEQUENCE ingest.%I AS integer MAXVALUE 2147483647', r.seqname);
    RAISE NOTICE '[0100] ingest.% 已收窄为 integer（MAXVALUE 2147483647）', r.seqname;
  END LOOP;
END $$;

COMMENT ON SEQUENCE ingest.page_id_seq IS
  'v2 新铸 page 身份的 id 分配序（回填进来的 v1 id 走 register_page 的 p_page_id 显式传入，不经本序列）。'
  '域收窄为 integer（0100 偏离项 E2）：ingest.page.id 是 int，让 setval 的非法值当场被拒，'
  '而不是推迟到某次 register_page 的 nextval()::int 上炸。'
  '⚠ Phase 2 回填后必须由 checks/backfill_finalize.sql 重置水位。';
COMMENT ON SEQUENCE ingest.user_id_seq IS
  'v2 新铸 user 身份的 id 分配序。同 page_id_seq，域为 integer。'
  '【2026-07-27 实测】v1 max(User.id)=282,240,277（非紧凑自增），重置后余量约 18.6 亿。';


-- =====================================================================================
-- 4. meta.backfill_gate_run —— gate 执行留痕
-- =====================================================================================
-- gate 是「可以重跑」的，所以必须能回答「上一次什么时候过的、过的时候库里是什么水位」。
-- 只 INSERT，不 UPDATE：每次执行一行。
CREATE TABLE IF NOT EXISTS meta.backfill_gate_run (
  id         bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  gate       text        NOT NULL,          -- 'backfill_finalize'
  mode       text        NOT NULL CHECK (mode IN ('strict','dryrun','bootstrap')),
  passed     boolean     NOT NULL,
  assertions int         NOT NULL DEFAULT 0,
  skipped    int         NOT NULL DEFAULT 0,
  detail     jsonb,                          -- 各表计数 / 序列水位快照
  ran_at     timestamptz NOT NULL DEFAULT now(),
  ran_by     text        NOT NULL DEFAULT current_user
);
CREATE INDEX IF NOT EXISTS bgr_gate ON meta.backfill_gate_run(gate, ran_at DESC);
COMMENT ON TABLE meta.backfill_gate_run IS
  '回填 gate 每次执行一行（append-only，不 UPDATE）。detail 里存当次的表计数与序列水位快照。'
  '用途：读切换评审时能拿出「gate 在什么水位下过的」，而不是一句「跑过了」。'
  'mode=bootstrap 的行 passed 恒为 false —— 空库上跳过了跨库断言，不算通过。';
COMMENT ON COLUMN meta.backfill_gate_run.skipped IS
  '被跳过的断言数。> 0 且 mode=strict 是矛盾状态（strict 不允许跳过），gate 自己会拒。';

COMMIT;

-- =====================================================================================
-- 自检（按需手工执行）：
--   SELECT sequencename, data_type, max_value, last_value FROM pg_sequences
--    WHERE schemaname='ingest' AND sequencename IN ('page_id_seq','user_id_seq');
--   -- 期望 data_type=integer / max_value=2147483647
--
--   SELECT table_name FROM information_schema.tables
--    WHERE table_schema='meta'
--      AND (table_name LIKE 'v1_identity%' OR table_name='backfill_gate_run') ORDER BY 1;
--   -- 期望 backfill_gate_run / v1_identity / v1_identity_load
-- =====================================================================================
