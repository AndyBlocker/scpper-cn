-- =====================================================================================
-- checks/backfill_finalize.sql —— Phase 2 回填收尾 gate（TODO #7）
-- =====================================================================================
-- 目标库  : scpper-v2（拒绝在 scpper-cn / scpper_cn / scpper-syncer / scpper_user 上执行）
-- 前置    : migrations/0100_backfill_gate.sql 已应用（建 meta.v1_identity /
--           meta.v1_identity_load / meta.backfill_gate_run，并把两条身份序列收窄为 int4 域）
--           checks/load_v1_identity.sh 已把 v1 身份 id 集合灌进 meta.v1_identity
--
-- 用法
-- -----
--   # 正式 gate（默认 strict）：断言 → 序列重置 → 后置断言 → 留痕
--   psql "$SYNCER2_DATABASE_URL" -f checks/backfill_finalize.sql
--
--   # 只跑断言，不动任何序列（回填中途体检）
--   psql "$SYNCER2_DATABASE_URL" -v gate_mode=dryrun -f checks/backfill_finalize.sql
--
--   # S1 身份层验收：仍是 strict，只排除依赖后续生命周期/投影回填的 A5.1/A5.2/A5.4/A5.5
--   psql "$SYNCER2_DATABASE_URL" -v gate_scope=s1 -f checks/backfill_finalize.sql
--
--   # 空库/回填前：跳过跨库断言，只把序列归位（passed 恒记 false）
--   psql "$SYNCER2_DATABASE_URL" -v gate_mode=bootstrap -f checks/backfill_finalize.sql
--
--   # 放宽快照新鲜度窗口（默认 '24 hours'）
--   psql "$SYNCER2_DATABASE_URL" -v max_load_age='72 hours' -f checks/backfill_finalize.sql
--
-- 退出码：任一断言失败 ⇒ RAISE EXCEPTION ⇒ psql 非零退出（本文件已 \set ON_ERROR_STOP on）。
--         调度器 / CI 直接用退出码当 gate，不需要解析 stdout。
--
-- 为什么先收集再抛，而不是逐条 fail-fast
-- --------------------------------------
-- 任务要求「每条断言不通过就 RAISE EXCEPTION」。这里实现成两段：
--   * A0 段（前置条件：暂存表载入状态、库名、非空性）**逐条 fail-fast** ——
--     A0 不成立时 A1+ 的结论全是假的（空集上差集恒为 0），继续算只会输出一屏
--     误导性的绿色；
--   * A1+ 段**先全量收集再一次性抛**，异常消息里逐条列出每一个失败项。
-- 理由：回填出问题时通常是一族问题（id 整体错位会同时打挂 A1.1/A1.3/A5.1）。
-- fail-fast 到第一条就停，操作者要跑五六轮才能看全；而「一次看全」并不牺牲 gate 语义 ——
-- 失败仍然是 RAISE EXCEPTION + 非零退出。
--
-- 序列重置的方向性（重要）
-- ------------------------
-- 本脚本**只上调、绝不下调**：target = GREATEST(max(id), 已交付的最高值)。
-- 0006_functions.sql §4.0 注释里的 `setval(seq, max(id))` 在「序列水位已高于 max(id)」的
-- 库上是**下调**（冒烟测试会把 page_id_seq 推到 14 而表里一行不留，实测就是这个状态），
-- 下调之后 nextval 会重新发出那些曾被分配、只因事务回滚才没落库的 id。
-- 唯一性上不冲突，但「id 永不重排 / 复用」这条对外承诺（gacha 跨库软外键依赖它）
-- 就变成了「除了回滚过的那些」。单调上调不需要这条例外。
--
-- 另外，那段注释里的 `setval(seq, (SELECT max(id) FROM ingest.page))` 在**空表**上
-- 是 `setval(seq, NULL)` ⇒ 22004。本脚本用 COALESCE + is_called 分支处理空表。
-- =====================================================================================

\set ON_ERROR_STOP on
\timing off
\pset pager off

-- 未显式给参数时的默认值
\if :{?gate_mode}
\else
  \set gate_mode strict
\endif
\if :{?max_load_age}
\else
  \set max_load_age '24 hours'
\endif
\if :{?gate_scope}
\else
  \set gate_scope full
\endif

\echo ''
\echo '========================================================================'
\echo ' backfill_finalize gate'
\echo '========================================================================'
\echo '  mode         :' :gate_mode
\echo '  scope        :' :gate_scope
\echo '  max_load_age :' :max_load_age


-- =====================================================================================
-- 0. 控制上下文 + 结果累加器
-- =====================================================================================
-- 用 TEMP 表（而不是自定义 GUC）把 psql 参数传进 DO 块：
-- 自定义 GUC 要 set_config('scpper2.x', ...)，而 0006 的经验是未注册前缀的 GUC 在不同
-- PG 版本 / 权限组合下行为不稳（函数级 SET 在 PG15+ 直接建不出来，见 README 整合期修改 #2）。
-- TEMP 表零权限要求、零版本差异，随会话消失。
--
-- ⚠ 刻意不写 `DROP TABLE IF EXISTS gate_ctl`：不带 schema 限定的 DROP 会沿 search_path
--   命中同名**永久**表。本文件设计为「一次 psql -f 一个新会话」，不需要清理上一轮。
CREATE TEMP TABLE gate_ctl (
  mode         text     NOT NULL,
  scope        text     NOT NULL,
  max_load_age interval NOT NULL
);
INSERT INTO gate_ctl(mode, scope, max_load_age)
VALUES (:'gate_mode', :'gate_scope', :'max_load_age'::interval);

CREATE TEMP TABLE gate_result (
  n      serial PRIMARY KEY,
  code   text    NOT NULL,
  title  text    NOT NULL,
  ok     boolean,              -- NULL = 被跳过（strict 模式下等同失败，见 §9）
  actual text,
  detail text
);

DO $$
DECLARE v_mode text; v_scope text;
BEGIN
  SELECT mode, scope INTO v_mode, v_scope FROM gate_ctl;
  IF v_mode NOT IN ('strict','dryrun','bootstrap') THEN
    RAISE EXCEPTION 'gate_mode 只能是 strict | dryrun | bootstrap（拿到的是 %）', v_mode
      USING ERRCODE = '22023';
  END IF;
  IF v_scope NOT IN ('full','s1') THEN
    RAISE EXCEPTION 'gate_scope 只能是 full | s1（拿到的是 %）', v_scope
      USING ERRCODE = '22023';
  END IF;
  IF current_database() IN ('scpper-cn','scpper_cn','scpper-syncer','scpper_user') THEN
    RAISE EXCEPTION
      'A0.2 失败：拒绝在受保护库 % 上执行 v2 回填 gate（v1 生产库 / 用户库只读）',
      current_database() USING ERRCODE = '42501';
  END IF;
  RAISE NOTICE '[A0.1/A0.2] mode=% / scope=% / database=% ✓',
    v_mode, v_scope, current_database();
END $$;


-- =====================================================================================
-- 1. A0 前置条件 —— 逐条 fail-fast
-- =====================================================================================
-- 这一段的存在理由就是「防止 gate 沦为安慰剂」。
-- 差集断言在集合为空时恒真，所以必须先证明暂存表确实被载入、载入完整、且不比 v2 的
-- 身份注册更旧。这几条不成立时，后面每一条绿色都是假的。
DO $$
DECLARE
  v_mode   text;
  v_age    interval;
  r        record;
  v_actual bigint;
  v_pages  bigint;
  v_users  bigint;
  v_newest timestamptz;
BEGIN
  SELECT mode, max_load_age INTO v_mode, v_age FROM gate_ctl;

  SELECT count(*) INTO v_pages FROM ingest.page;
  SELECT count(*) INTO v_users FROM ingest."user";

  IF v_mode = 'bootstrap' THEN
    RAISE WARNING
      '[A0] mode=bootstrap：跳过全部跨库一一对应断言（A1/A2/A3）与派生一致性断言（A5）。'
      'ingest.page=% 行 / ingest."user"=% 行。'
      '本次执行在 meta.backfill_gate_run 里一律记 passed=false —— '
      'bootstrap 只负责把序列归位，不构成「回填已验收」的证据。', v_pages, v_users;
    RETURN;
  END IF;

  -- A0.3 载入记录必须存在
  FOR r IN
    SELECT unnest(ARRAY['page','user','gacha_page_ref','vote_anon']) AS entity
  LOOP
    IF NOT EXISTS (SELECT 1 FROM meta.v1_identity_load l WHERE l.entity = r.entity) THEN
      RAISE EXCEPTION
        'A0.3 失败：meta.v1_identity_load 缺 entity=% 的载入记录。'
        '先跑 checks/load_v1_identity.sh 把 v1 身份 id 集合灌进来 —— '
        '暂存表为空时「v1↔v2 一一对应」断言会真空通过，所以这里必须硬失败。',
        r.entity USING ERRCODE = 'P0002';
    END IF;
  END LOOP;

  -- A0.4 源库不能是自己；A0.5 行数对账；A0.6 strict 不允许空集；A0.7a 新鲜度
  FOR r IN SELECT * FROM meta.v1_identity_load ORDER BY entity LOOP
    IF r.source_database = current_database() THEN
      RAISE EXCEPTION
        'A0.4 失败：entity=% 的 source_database=% 与当前库相同 —— 自己灌自己等于零信息量',
        r.entity, r.source_database USING ERRCODE = '22023';
    END IF;

    SELECT count(*) INTO v_actual FROM meta.v1_identity i WHERE i.entity = r.entity;
    IF v_actual <> r.expected_rows THEN
      RAISE EXCEPTION
        'A0.5 失败：entity=% 暂存行数 %，载入元数据声明 %（差 %）。'
        'COPY 被截断（管道中断 / 磁盘满 / 权限）正好是这个形态，'
        '此刻任何差集断言的结论都是假的，必须直接判 gate 失败。',
        r.entity, v_actual, r.expected_rows, v_actual - r.expected_rows
        USING ERRCODE = '22000';
    END IF;

    IF v_mode = 'strict'
       AND r.entity IN ('page','user','gacha_page_ref')
       AND r.expected_rows = 0 THEN
      RAISE EXCEPTION
        'A0.6 失败：entity=% 的暂存集合为空。strict 模式不接受空集 —— '
        '【2026-07-27 实测】v1 Page 47,861 行 / User 37,455 行，空集只可能是载入器出错。'
        '若确实只想在空库上做序列归位，用 -v gate_mode=bootstrap。',
        r.entity USING ERRCODE = '22000';
    END IF;

    IF now() - r.loaded_at > v_age THEN
      RAISE EXCEPTION
        'A0.7a 失败：entity=% 的暂存快照载入于 %（距今 %），超过 max_load_age=%。'
        '过期快照对账出的「一一对应」不代表现在的状态。重新载入，'
        '或显式放宽 -v max_load_age=''...''。',
        r.entity, r.loaded_at, now() - r.loaded_at, v_age USING ERRCODE = '22000';
    END IF;
  END LOOP;

  -- A0.7b 暂存快照必须不早于 v2 最后一次身份注册。
  -- 场景：先载入 v1 快照，回填又跑了两小时铸了几千个身份，然后跑 gate。
  -- 此时 A1.2「v2 有 v1 无」会把那几千个新身份全判成非法（它们的 id 来自 v1 值域内）。
  -- 与其让操作者对着一屏假失败排查，不如在这里点明「顺序错了」。
  SELECT max(created_at) INTO v_newest FROM ingest.page;
  IF v_newest IS NOT NULL AND EXISTS (
    SELECT 1 FROM meta.v1_identity_load l WHERE l.entity = 'page' AND l.loaded_at < v_newest
  ) THEN
    RAISE EXCEPTION
      'A0.7b 失败：entity=page 的暂存快照早于 ingest.page 最新一行的 created_at（%）。'
      '回填在载入之后仍在继续 ⇒ 现在对账没有意义。先让回填静止，再重载快照，再跑 gate。',
      v_newest USING ERRCODE = '22000';
  END IF;

  -- A0.8 strict 下 v2 身份表必须非空（这是「回填收尾」gate，不是空库自检）
  IF v_mode = 'strict' AND (v_pages = 0 OR v_users = 0) THEN
    RAISE EXCEPTION
      'A0.8 失败：strict 模式要求 v2 身份表已回填，实测 ingest.page=% 行 / ingest."user"=% 行。'
      '空库请用 -v gate_mode=bootstrap。', v_pages, v_users USING ERRCODE = '22000';
  END IF;

  RAISE NOTICE '[A0] 前置条件全部通过（暂存表已载入且完整、快照新鲜、v2 身份表非空）';
END $$;


-- =====================================================================================
-- 2. A1 —— v1 Page.id ↔ v2 ingest.page.id 一一对应
-- =====================================================================================
-- 这是 gacha 跨库软外键的硬承诺（0001_ingest.sql 对 ingest.page.id 的注释：
-- 「user-backend 的 GachaCardDefinition.pageId 等跨库软外键依赖此不变量」）。
-- 一一对应 = 三件事同时成立，缺一不可：
--   ① v1 的每个 id 在 v2 都在（漏页 ⇒ gacha 卡片指向空气）
--   ② v2 里 v1 值域内不得有 v1 没有的 id（多出来 ⇒ 回填造了不该存在的身份）
--   ③ 同一个 id 两边的 wikidot_id 必须相等 —— ① ② 都过而 ③ 不过 = **id 整体错位**，
--     这是最危险的一种：所有计数都对得上，只是每张卡都指向了别的页面。
--
-- ⚠ 实现细节：模式过滤一律写在 `HAVING`，不能写在 `WHERE`。
--   `SELECT count(*)=0 ... WHERE false` 在聚合查询里仍然返回一行（count=0 ⇒ ok=true），
--   于是 bootstrap 模式会得到一屏**假通过**。HAVING false 才真正抑制那一行。
INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A1.1', 'v1 Page.id 全部存在于 v2 ingest.page',
       count(*) = 0,
       count(*)::text || ' 个缺失',
       CASE WHEN count(*) > 0
            THEN '样例 v1_id: ' || (SELECT string_agg(x::text, ',')
                                      FROM (SELECT v1_id x FROM meta.v1_identity i2
                                             WHERE i2.entity = 'page'
                                               AND NOT EXISTS (SELECT 1 FROM ingest.page p
                                                                WHERE p.id = i2.v1_id)
                                             ORDER BY v1_id LIMIT 10) s)
       END
  FROM meta.v1_identity i
 WHERE i.entity = 'page'
   AND NOT EXISTS (SELECT 1 FROM ingest.page p WHERE p.id = i.v1_id)
HAVING (SELECT mode FROM gate_ctl) <> 'bootstrap';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A1.2', 'v2 ingest.page 在 v1 值域内没有额外 id（新铸只能在 v1 上界之上）',
       count(*) = 0,
       count(*)::text || ' 个越界额外 id',
       CASE WHEN count(*) > 0
            THEN '样例 id: ' || (SELECT string_agg(id::text, ',') FROM (
                    SELECT p2.id FROM ingest.page p2
                     WHERE NOT EXISTS (SELECT 1 FROM meta.v1_identity i2
                                        WHERE i2.entity = 'page' AND i2.v1_id = p2.id)
                       AND p2.id <= (SELECT max(v1_id) FROM meta.v1_identity WHERE entity='page')
                     ORDER BY p2.id LIMIT 10) s)
       END
  FROM ingest.page p
 WHERE NOT EXISTS (SELECT 1 FROM meta.v1_identity i WHERE i.entity='page' AND i.v1_id = p.id)
   AND p.id <= (SELECT max(v1_id) FROM meta.v1_identity WHERE entity='page')
HAVING (SELECT mode FROM gate_ctl) <> 'bootstrap';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A1.3', 'v1↔v2 逐行 wikidot_id 相等（防 id 整体错位）',
       count(*) = 0,
       count(*)::text || ' 行配对不一致',
       CASE WHEN count(*) > 0
            THEN '样例: ' || (SELECT string_agg(format('id=%s v1_wid=%s v2_wid=%s',
                                                       i2.v1_id, i2.wikidot_id, p2.wikidot_id), '; ')
                                FROM meta.v1_identity i2
                                JOIN ingest.page p2 ON p2.id = i2.v1_id
                               WHERE i2.entity = 'page'
                                 AND i2.wikidot_id IS DISTINCT FROM p2.wikidot_id)
       END
  FROM meta.v1_identity i
  JOIN ingest.page p ON p.id = i.v1_id
 WHERE i.entity = 'page'
   AND i.wikidot_id IS DISTINCT FROM p.wikidot_id
HAVING (SELECT mode FROM gate_ctl) <> 'bootstrap';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A1.4', 'ingest.page.wikidot_id 无重复（UNIQUE 约束的回归断言）',
       count(*) = 0, count(*)::text || ' 个 wikidot_id 出现多次',
       '约束已保证；这条在于「约束被某次迁移 DROP 掉了」时能显形'
  FROM (SELECT wikidot_id FROM ingest.page GROUP BY 1 HAVING count(*) > 1) t;

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A1.5', 'ingest.page.id 全部为正（setval 域前提）',
       count(*) = 0, count(*)::text || ' 行 id <= 0',
       'setval 的 min_value 是 1；出现非正 id 说明回填把某个 sentinel 值写进了身份表'
  FROM ingest.page WHERE id <= 0;


-- =====================================================================================
-- 3. A2 —— v1 User.id ↔ v2 ingest."user".id 一一对应
-- =====================================================================================
-- 与 page 同构，另加两条 v1 特有形态的断言：
-- 【2026-07-27 实测】v1 User 37,455 行里 1,097 行 wikidotId IS NULL（论坛 guest /
-- BFF 合成 / 匿名署名三类），且 **0 行满足 id = wikidotId** —— v1 的 User.id 是独立自增，
-- 不是 wikidotId 的别名。回填时若图省事拿 wikidotId 当 id，A2.1 与 A2.3 会同时炸。
-- 另：max(User.id)=282,240,277 而只有 37,455 行，值域极度稀疏（8,743 行 id > 200 万），
-- 所以「id 连续」这种朴素直觉在 user 域完全不成立，任何基于连续性的断言都会误报。
INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A2.1', 'v1 User.id 全部存在于 v2 ingest."user"',
       count(*) = 0, count(*)::text || ' 个缺失',
       CASE WHEN count(*) > 0
            THEN '样例 v1_id: ' || (SELECT string_agg(x::text, ',')
                                      FROM (SELECT v1_id x FROM meta.v1_identity i2
                                             WHERE i2.entity = 'user'
                                               AND NOT EXISTS (SELECT 1 FROM ingest."user" u
                                                                WHERE u.id = i2.v1_id)
                                             ORDER BY v1_id LIMIT 10) s)
       END
  FROM meta.v1_identity i
 WHERE i.entity = 'user'
   AND NOT EXISTS (SELECT 1 FROM ingest."user" u WHERE u.id = i.v1_id)
HAVING (SELECT mode FROM gate_ctl) <> 'bootstrap';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A2.2', 'v2 ingest."user" 在 v1 值域内没有额外 id',
       count(*) = 0, count(*)::text || ' 个越界额外 id',
       CASE WHEN count(*) > 0
            THEN '样例 id: ' || (SELECT string_agg(id::text, ',') FROM (
                    SELECT u2.id FROM ingest."user" u2
                     WHERE NOT EXISTS (SELECT 1 FROM meta.v1_identity i2
                                        WHERE i2.entity='user' AND i2.v1_id = u2.id)
                       AND u2.id <= (SELECT max(v1_id) FROM meta.v1_identity WHERE entity='user')
                     ORDER BY u2.id LIMIT 10) s)
       END
  FROM ingest."user" u
 WHERE NOT EXISTS (SELECT 1 FROM meta.v1_identity i WHERE i.entity='user' AND i.v1_id = u.id)
   AND u.id <= (SELECT max(v1_id) FROM meta.v1_identity WHERE entity='user')
HAVING (SELECT mode FROM gate_ctl) <> 'bootstrap';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A2.3', 'v1 有 wikidotId 的用户：v2 侧 wikidot_id 相等且 kind=wikidot',
       count(*) = 0, count(*)::text || ' 行不一致',
       CASE WHEN count(*) > 0
            THEN '样例: ' || (SELECT string_agg(format('id=%s v1_wid=%s v2_wid=%s kind=%s',
                                                 i2.v1_id, i2.wikidot_id, u2.wikidot_id, u2.kind), '; ')
                                FROM meta.v1_identity i2
                                JOIN ingest."user" u2 ON u2.id = i2.v1_id
                               WHERE i2.entity = 'user' AND i2.wikidot_id IS NOT NULL
                                 AND (i2.wikidot_id IS DISTINCT FROM u2.wikidot_id
                                      OR u2.kind <> 'wikidot'))
       END
  FROM meta.v1_identity i
  JOIN ingest."user" u ON u.id = i.v1_id
 WHERE i.entity = 'user' AND i.wikidot_id IS NOT NULL
   AND (i.wikidot_id IS DISTINCT FROM u.wikidot_id OR u.kind <> 'wikidot')
HAVING (SELECT mode FROM gate_ctl) <> 'bootstrap';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A2.4', 'v1 无 wikidotId 的用户（实测 1,097 行）：v2 侧 kind ∈ guest|anon|synthetic',
       count(*) = 0, count(*)::text || ' 行 kind 归类错误',
       'wikidotId 为空却被回填成 kind=wikidot ⇒ 0001 的 CHECK (kind<>''wikidot'' OR '
       'wikidot_id IS NOT NULL) 本该拦住；能走到这里说明回填绕过了 ensure_user 直插表'
  FROM meta.v1_identity i
  JOIN ingest."user" u ON u.id = i.v1_id
 WHERE i.entity = 'user' AND i.wikidot_id IS NULL
   AND u.kind NOT IN ('guest','anon','synthetic')
HAVING (SELECT mode FROM gate_ctl) <> 'bootstrap';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A2.5', 'ingest."user".id 全部为正',
       count(*) = 0, count(*)::text || ' 行 id <= 0', NULL
  FROM ingest."user" WHERE id <= 0;

-- S1 第三条硬断言：loader 在 v1 上独立 count，再把命中行与 expected_rows 单向灌入。
-- A0 已保证载入记录存在且 expected_rows=实际证据行数，所以这里不会在“没查过”的空表上绿。
INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A2.6', 'v1 投票域匿名票数 = 0',
       l.expected_rows = 0 AND count(i.v1_id) = 0,
       format('v1 count=%s / evidence rows=%s', l.expected_rows, count(i.v1_id)),
       CASE WHEN l.expected_rows <> 0 OR count(i.v1_id) <> 0
            THEN 'anonKey IS NOT NULL 非零与生产实测基线冲突；必须中止并人工介入，不能自动铸匿名 voter'
       END
  FROM meta.v1_identity_load l
  LEFT JOIN meta.v1_identity i ON i.entity='vote_anon'
 WHERE l.entity='vote_anon'
 GROUP BY l.expected_rows
HAVING (SELECT mode FROM gate_ctl) <> 'bootstrap';


-- =====================================================================================
-- 4. A3 —— gacha 跨库软外键（scpper_user."GachaCardDefinition"."pageId"）
-- =====================================================================================
-- 这条断言是「id 一一对应」这个承诺的**债主**：0001_ingest.sql 的注释点名了它。
-- 【2026-07-27 实测】82,184 张卡定义引用 36,957 个 distinct pageId（min 301 / max 106,804），
-- 全部落在 v1 Page.id 值域内。
-- A3.1 是 strict 输入：非 bootstrap 模式下，A0.3 已强制要求 gacha_page_ref 的
-- load metadata 存在且 A0.5 已核对 COPY 完整，不能再用 WARNING/SKIP 绕过债主检查。
INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A3.1', 'gacha 引用的每个 pageId 都存在于 v2 ingest.page',
       count(*) = 0,
       count(*)::text || ' 个悬空引用',
       CASE WHEN count(*) > 0
            THEN '样例 pageId: ' || (SELECT string_agg(x::text, ',')
                   FROM (SELECT v1_id x FROM meta.v1_identity i2
                          WHERE i2.entity = 'gacha_page_ref'
                            AND NOT EXISTS (SELECT 1 FROM ingest.page p WHERE p.id = i2.v1_id)
                          ORDER BY v1_id LIMIT 10) s)
       END
  FROM meta.v1_identity i
 WHERE i.entity = 'gacha_page_ref'
   AND NOT EXISTS (SELECT 1 FROM ingest.page p WHERE p.id = i.v1_id)
HAVING (SELECT mode FROM gate_ctl) <> 'bootstrap';


-- =====================================================================================
-- 5. A4 —— 「id 空洞冲突」的语义澄清 + int4 域断言
-- =====================================================================================
-- 先把语义说清楚，因为「空洞」这个词很容易被理解错：
--   * max(id) 以下的空洞本身**无害**。v1 Page.id 从 301 起、47,861 行铺到 106,804，
--     天然有约 5.9 万个空位；序列不会回填它们，所以不产生冲突。
--   * 真正致命的形态是**序列水位之上还有已占用 id**：序列停在 N，而表里存在 id > N。
--     nextval 迟早走到那个 id 上 ⇒ 主键冲突。这才是 TODO #7 里「id 空洞冲突」要拦的东西，
--     也是「回填只灌了一部分 / 回填后忘了 setval」的必然症状。
--     它的强断言在 §8 的 A6.2（重置之后必须为 0），这里只打诊断 NOTICE。
DO $$
DECLARE
  r        record;
  v_last   bigint;
  v_called boolean;
  v_high   bigint;
  v_above  bigint;
  v_max    bigint;
  v_min    bigint;
  v_cnt    bigint;
BEGIN
  FOR r IN
    SELECT 'ingest.page_id_seq'::text AS seq, 'ingest.page'::text AS tbl
    UNION ALL
    SELECT 'ingest.user_id_seq', 'ingest."user"'
  LOOP
    EXECUTE format('SELECT last_value, is_called FROM %s', r.seq) INTO v_last, v_called;
    v_high := CASE WHEN v_called THEN v_last ELSE v_last - 1 END;
    EXECUTE format('SELECT count(*), min(id), max(id) FROM %s', r.tbl)
      INTO v_cnt, v_min, v_max;
    EXECUTE format('SELECT count(*) FROM %s WHERE id > %s', r.tbl, v_high) INTO v_above;

    RAISE NOTICE '[A4 诊断] %：count=% / [min,max]=[%,%] / 空位 % 个（无害）'
                 ' | % 已交付水位=% / 水位之上已占用 % 行',
      r.tbl, v_cnt, COALESCE(v_min::text,'-'), COALESCE(v_max::text,'-'),
      CASE WHEN v_max IS NULL THEN 0 ELSE (v_max - v_min + 1) - v_cnt END,
      r.seq, v_high, v_above;

    INSERT INTO gate_result(code, title, ok, actual, detail)
    VALUES (format('A4.1[%s]', r.tbl),
            format('%s 的 max(id) 落在 int4 域内', r.tbl),
            COALESCE(v_max, 0) BETWEEN 0 AND 2147483647,
            format('max(id)=%s / 余量 %s',
                   COALESCE(v_max::text,'-'), 2147483647 - COALESCE(v_max, 0)),
            '列类型是 int，越界本不可能发生（INSERT 会先炸）；'
            '这条是对「外部工具直接 COPY 进身份表」这条旁路的兜底');
  END LOOP;
END $$;


-- =====================================================================================
-- 6. A5 —— 派生一致性（回填绕过 register_page 就在这里暴露）
-- =====================================================================================
-- register_page 的契约是「铸 ingest.page + page_slug_history 开区间 + serve.page_current 行
-- + page_life_event(created) 四件事在同一事务里发生」。
-- 回填如果为了速度直接 COPY 进 ingest.page（47,861 行逐行调函数确实不快，很可能会），
-- 这四件事就会分叉。v1 的 PageStats「6,706 孤儿 + 11,593 缺行」正是这个病的成品，
-- 所以下面几条不是洁癖，是对着已知病例写的。
INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A5.1', 'serve.page_current 与 ingest.page 一一对应（双向差集为 0）',
       miss = 0 AND orphan = 0,
       format('page 缺 page_current %s 行 / page_current 孤儿 %s 行', miss, orphan),
       'page_current 侧孤儿由外键保证为 0；缺行则是回填绕过 register_page 的签名症状'
  FROM (SELECT (SELECT count(*) FROM ingest.page p
                 WHERE NOT EXISTS (SELECT 1 FROM serve.page_current c WHERE c.page_id = p.id)) miss,
               (SELECT count(*) FROM serve.page_current c
                 WHERE NOT EXISTS (SELECT 1 FROM ingest.page p WHERE p.id = c.page_id)) orphan) d
 WHERE (SELECT mode FROM gate_ctl) <> 'bootstrap'
   AND (SELECT scope FROM gate_ctl) = 'full';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A5.2', 'serve.page_current.wikidot_id 与 ingest.page.wikidot_id 逐行相等',
       count(*) = 0, count(*)::text || ' 行不一致', NULL
 FROM ingest.page p JOIN serve.page_current c ON c.page_id = p.id
 WHERE c.wikidot_id <> p.wikidot_id
HAVING (SELECT mode FROM gate_ctl) <> 'bootstrap'
   AND (SELECT scope FROM gate_ctl) = 'full';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A5.3', '每个 page 恰有一个当前 slug（page_slug_history.valid_to IS NULL）',
       count(*) = 0, count(*)::text || ' 个 page 的当前 slug 数 <> 1',
       'psh_current 部分唯一索引只保证 <= 1；= 0（一条都没有）它拦不住'
  FROM (SELECT p.id,
               (SELECT count(*) FROM ingest.page_slug_history h
                 WHERE h.page_id = p.id AND h.valid_to IS NULL) AS n
          FROM ingest.page p) t
 WHERE t.n <> 1
HAVING (SELECT mode FROM gate_ctl) <> 'bootstrap';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A5.4', 'serve.page_current.slug = page_slug_history 的当前 slug',
       count(*) = 0, count(*)::text || ' 行不一致',
       'slug 解析有 by-slug 与 fullname 两条通道，两边分叉会让同一页面在两条通道下解析到不同 page_id'
 FROM serve.page_current c
  JOIN ingest.page_slug_history h ON h.page_id = c.page_id AND h.valid_to IS NULL
 WHERE h.slug <> c.slug
HAVING (SELECT mode FROM gate_ctl) <> 'bootstrap'
   AND (SELECT scope FROM gate_ctl) = 'full';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A5.5', '每个 page 至少一条 page_life_event',
       count(*) = 0, count(*)::text || ' 个 page 无任何生命周期事件',
       '页面「存在过」这件事在 v2 里由 page_life_event 表达；缺失 ⇒ 时间线起点丢失'
 FROM ingest.page p
 WHERE NOT EXISTS (SELECT 1 FROM ingest.page_life_event e WHERE e.page_id = p.id)
HAVING (SELECT mode FROM gate_ctl) <> 'bootstrap'
   AND (SELECT scope FROM gate_ctl) = 'full';

-- S4/S5/S6 的事实/冻结强断言。0203 迁移把一次性源行与冻结 manifest 都做成正式对象，
-- 所以这里不靠“脚本日志里看起来跑过”。
INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A5.6', 'page_current.status 与 page_life_event 单一真相源一致',
       count(*) = 0, count(*)::text || ' 个 page 状态发散',
       '只看 created/deleted/restored 的最后一条；renamed 不改变生死。'
  FROM serve.page_current pc
  LEFT JOIN LATERAL (
    SELECT e.kind
      FROM ingest.page_life_event e
     WHERE e.page_id=pc.page_id AND e.kind IN ('created','deleted','restored')
     ORDER BY e.seq DESC LIMIT 1
  ) last_life ON true
 WHERE last_life.kind IS NULL
    OR pc.status <> CASE last_life.kind WHEN 'deleted' THEN 'deleted' ELSE 'live' END
HAVING (SELECT mode FROM gate_ctl) <> 'bootstrap'
   AND (SELECT scope FROM gate_ctl) = 'full';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A5.7', 'attribution_current 的计数与 is_display 物化规则一致',
       bad_count = 0 AND bad_display = 0,
       format('page_current.attribution_count 错 %s 页 / is_display 错 %s 行',
              bad_count, bad_display),
       '只有 SUBMITTER 的页必须显示；出现任一非 SUBMITTER 后才抑制 SUBMITTER。'
  FROM (
    SELECT
      (SELECT count(*) FROM serve.page_current pc
        WHERE pc.attribution_count <>
              (SELECT count(*) FROM serve.attribution_current ac
                WHERE ac.page_id=pc.page_id)) AS bad_count,
      (SELECT count(*) FROM serve.attribution_current ac
        WHERE ac.is_display <> NOT (
          upper(ac.role)='SUBMITTER' AND EXISTS (
            SELECT 1 FROM serve.attribution_current o
             WHERE o.page_id=ac.page_id AND upper(o.role)<>'SUBMITTER'
          ))) AS bad_display
  ) d
 WHERE (SELECT mode FROM gate_ctl) <> 'bootstrap'
   AND (SELECT scope FROM gate_ctl) = 'full';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A5.8', 'v1 署名映射已冻结，匿名 actor 位于安全保留段',
       f.artifact IS NOT NULL
         AND f.row_count = d.map_count
         AND f.row_count > 0
         AND d.remap_audit_count = 412
         AND d.anon_actor_count > 0
         AND d.anon_actor_min >= meta.v2_reserved_anonymous_actor_id_start()
         AND d.anon_actor_min >
               d.v1_user_max::bigint * meta.v1_user_id_safety_factor(),
       format(
         'map=%s / frozen=%s / audit=%s / anon actors=%s min=%s / '
         'v1 max=%s × factor=%s ⇒ required >%s',
         d.map_count,COALESCE(f.row_count::text,'missing'),d.remap_audit_count,
         d.anon_actor_count,d.anon_actor_min,d.v1_user_max,
         meta.v1_user_id_safety_factor(),
         d.v1_user_max::bigint * meta.v1_user_id_safety_factor()
       ),
       'meta.v1_attribution_map 不含 slug；0204 先审计 412 个旧 actor，再原子更新全部引用。'
       '保留段断言每次 full gate 都以最新 v1 identity 快照重算，不把某次 max 当永久上界。'
  FROM (
    SELECT
      (SELECT count(*) FROM meta.v1_attribution_map) AS map_count,
      (SELECT count(*) FROM meta.v1_anonymous_actor_remap_audit) AS remap_audit_count,
      count(DISTINCT actor_id) FILTER (WHERE v1_user_id IS NULL) AS anon_actor_count,
      min(actor_id) FILTER (WHERE v1_user_id IS NULL) AS anon_actor_min,
      (SELECT COALESCE(max(v1_id),0) FROM meta.v1_identity WHERE entity='user')
        AS v1_user_max
      FROM meta.v1_attribution_map
  ) d
  LEFT JOIN meta.v1_backfill_artifact_freeze f
    ON f.artifact='v1_attribution_map'
 WHERE (SELECT mode FROM gate_ctl) <> 'bootstrap'
   AND (SELECT scope FROM gate_ctl) = 'full';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A5.9', 'legacy_votes_cn 三张 typed 快照已逐表对账并冻结',
       manifests = 3 AND bad_counts = 0,
       format('manifest=%s/3 / count mismatch=%s', manifests, bad_counts),
       'pages/votes/vote_history 保留源列名与原生类型；manifest 要求 source/target fingerprint 相等。'
  FROM (
    SELECT
      (SELECT count(*) FROM meta.v1_legacy_snapshot) AS manifests,
      (SELECT count(*) FROM (
        SELECT 'pages' t, count(*)::bigint n FROM meta.v1_legacy_snapshot_pages
        UNION ALL
        SELECT 'votes', count(*) FROM meta.v1_legacy_snapshot_votes
        UNION ALL
        SELECT 'vote_history', count(*) FROM meta.v1_legacy_snapshot_vote_history
      ) x JOIN meta.v1_legacy_snapshot s ON s.source_table=x.t
       WHERE x.n<>s.row_count) AS bad_counts
  ) d
 WHERE (SELECT mode FROM gate_ctl) <> 'bootstrap'
   AND (SELECT scope FROM gate_ctl) = 'full';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A5.10', 'deleted 生命周期来源与 inferred 删除时刻完整',
       bad_source = 0 AND bad_time = 0 AND legacy_rows > 0,
       format('bad source=%s / bad deleted_at=%s / legacy_import=%s',
              bad_source,bad_time,legacy_rows),
       '2025-11 legacy 指纹必须单列为 legacy_import_2025_11；v1 没有精确删除事件，不能冒充 exact。'
  FROM (
    SELECT
      (SELECT count(*) FROM ingest.page_life_event
        WHERE kind='deleted'
          AND source NOT IN ('v1_backfill','legacy_import_2025_11')) AS bad_source,
      (SELECT count(*) FROM serve.page_current
        WHERE status='deleted'
          AND (deleted_at IS NULL OR deleted_at_precision<>'inferred')) AS bad_time,
      (SELECT count(*) FROM ingest.page_life_event
        WHERE kind='deleted' AND source='legacy_import_2025_11') AS legacy_rows
  ) d
 WHERE (SELECT mode FROM gate_ctl) <> 'bootstrap'
   AND (SELECT scope FROM gate_ctl) = 'full';

INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A5.11', 'meta.v1_version_map 已完整冻结（老 /versions/:id 解析）',
       f.artifact IS NOT NULL
         AND f.row_count=(SELECT count(*) FROM meta.v1_version_map)
         AND f.row_count>0
         AND NOT EXISTS (
           SELECT 1 FROM meta.v1_version_map m
            WHERE NOT EXISTS (SELECT 1 FROM ingest.page p WHERE p.id=m.page_id)
         ),
       format('map=%s / frozen=%s',
              (SELECT count(*) FROM meta.v1_version_map),
              COALESCE(f.row_count::text,'missing')),
       '冻结后 INSERT/UPDATE/DELETE/TRUNCATE 均为 25006；version_no 对应 page_version_display。'
  FROM (SELECT 1) one
  LEFT JOIN meta.v1_backfill_artifact_freeze f ON f.artifact='v1_version_map'
 WHERE (SELECT mode FROM gate_ctl) <> 'bootstrap'
   AND (SELECT scope FROM gate_ctl) = 'full';


-- =====================================================================================
-- 7. 序列重置（dryrun 模式整段跳过）
-- =====================================================================================
-- 覆盖两族序列：
--   ① ingest.page_id_seq / ingest.user_id_seq —— 身份表**没有** DEFAULT，
--      序列是 0006_functions.sql §4.0 单独 CREATE 的独立对象，
--      pg_get_serial_sequence('ingest.page','id') 返回 NULL（实测），必须按名字点到。
--   ② app 的 identity 序列 —— **动态发现**（attidentity <> ''），不硬编码表名。
--      0004_app.sql 文件尾注释里那段 DO 块硬编码了 13 张表名；今天数目恰好正确
--      （第 14 张 app.collection_account_owner 没有 id 列，实测确认），但下次给 app 加表
--      就会静默漏掉一条，而漏掉的那张表 BFF 第一次 INSERT 就撞主键、gate 却全绿。
--
-- 刻意**不**覆盖：
--   * ingest.fact_seq —— 0001 明文「不可重置、不可回绕」，回绕会让 append-only 因果序失效。
--   * meta.* 与 ingest 事实层的 bigserial 序列 —— 它们不承接 v1 的 id 值域，
--     回填不显式指定这些表的 id（meta.v1_version_map 直接拿 v1 主键当自己的主键，无序列），
--     因此天然无冲突。
--   * serve.* —— Tier-1/Tier-2 全是可 TRUNCATE 重建的投影，它们的 id 不对外承诺。
--     （唯一的 serve.page_reference_graph_snapshot_id_seq 也属此类。）
--
-- 方向性：只上调，绝不下调。page/user 还必须保持在 0204 的具名保留段：
-- v1 仍在增长，若只对 max(id) 归位，下一次 v2 自铸身份仍会落回移动靶旁边。
DO $$
DECLARE
  r        record;
  v_mode   text;
  v_last   bigint;
  v_called boolean;
  v_high   bigint;
  v_max    bigint;
  v_target bigint;
  v_n      int := 0;
BEGIN
  SELECT mode INTO v_mode FROM gate_ctl;
  IF v_mode = 'dryrun' THEN
    RAISE NOTICE '[序列重置] mode=dryrun，整段跳过（一个 setval 都不发）';
    RETURN;
  END IF;

  FOR r IN
    SELECT 'ingest.page_id_seq'::text AS seq, 'ingest.page'::text AS tbl,
           'id'::text AS col, meta.v2_reserved_page_id_start()::bigint-1 AS floor
    UNION ALL
    SELECT 'ingest.user_id_seq', 'ingest."user"', 'id',
           meta.v2_reserved_anonymous_actor_id_start()::bigint-1
    UNION ALL
    SELECT pg_get_serial_sequence(format('app.%I', c.relname), a.attname),
           format('app.%I', c.relname), a.attname, 0::bigint
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'app' AND c.relkind = 'r' AND a.attidentity <> ''
     ORDER BY 1
  LOOP
    EXECUTE format('SELECT last_value, is_called FROM %s', r.seq) INTO v_last, v_called;
    v_high := CASE WHEN v_called THEN v_last ELSE v_last - 1 END;

    EXECUTE format('SELECT COALESCE(max(%I), 0) FROM %s', r.col, r.tbl) INTO v_max;

    v_target := GREATEST(v_max, v_high, r.floor, 0);

    IF v_target = 0 THEN
      -- 表空且序列从未交付过 ⇒ 归位到「下一个 nextval 返回 1」
      PERFORM setval(r.seq, 1, false);
      RAISE NOTICE '[序列重置] % ← 1 (is_called=false)：% 为空且序列未交付过', r.seq, r.tbl;
    ELSIF v_target > v_high THEN
      PERFORM setval(r.seq, v_target, true);
      RAISE NOTICE '[序列重置] % ← %（上调 +%）：max(%.%)=%',
        r.seq, v_target, v_target - v_high, r.tbl, r.col, v_max;
    ELSE
      RAISE NOTICE '[序列重置] % 保持 %（已 >= max(%.%)=%，不下调）',
        r.seq, v_high, r.tbl, r.col, v_max;
    END IF;
    v_n := v_n + 1;
  END LOOP;

  RAISE NOTICE '[序列重置] 共处理 % 条序列', v_n;
END $$;


-- =====================================================================================
-- 8. A6 —— 重置后的强断言
-- =====================================================================================
-- dryrun 下也跑：它回答的是「如果现在不重置，会不会撞」。
DO $$
DECLARE
  r        record;
  v_last   bigint;
  v_called boolean;
  v_high   bigint;
  v_max    bigint;
  v_above  bigint;
BEGIN
  FOR r IN
    SELECT 'ingest.page_id_seq'::text AS seq, 'ingest.page'::text AS tbl,
           'id'::text AS col, meta.v2_reserved_page_id_start()::bigint-1 AS floor
    UNION ALL
    SELECT 'ingest.user_id_seq', 'ingest."user"', 'id',
           meta.v2_reserved_anonymous_actor_id_start()::bigint-1
    UNION ALL
    SELECT pg_get_serial_sequence(format('app.%I', c.relname), a.attname),
           format('app.%I', c.relname), a.attname, 0::bigint
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
     WHERE n.nspname = 'app' AND c.relkind = 'r' AND a.attidentity <> ''
     ORDER BY 1
  LOOP
    EXECUTE format('SELECT last_value, is_called FROM %s', r.seq) INTO v_last, v_called;
    v_high := CASE WHEN v_called THEN v_last ELSE v_last - 1 END;
    EXECUTE format('SELECT COALESCE(max(%I),0) FROM %s', r.col, r.tbl) INTO v_max;
    EXECUTE format('SELECT count(*) FROM %s WHERE %I > %s', r.tbl, r.col, v_high) INTO v_above;

    INSERT INTO gate_result(code, title, ok, actual, detail)
    VALUES (format('A6.1[%s]', r.seq),
            format('%s 已交付水位 >= max(%s.%s) 且不低于保留段', r.seq, r.tbl, r.col),
            v_high >= v_max AND v_high >= r.floor,
            format('水位 %s / max %s / floor %s', v_high, v_max, r.floor),
            CASE WHEN v_high < v_max OR v_high < r.floor
                 THEN format('下一个 nextval 会返回 %s，而它已被占用 ⇒ 主键冲突', v_high + 1)
            END);

    INSERT INTO gate_result(code, title, ok, actual, detail)
    VALUES (format('A6.2[%s]', r.tbl),
            format('%s 序列水位之上无已占用 %s（「id 空洞冲突」的强形式）', r.tbl, r.col),
            v_above = 0,
            format('%s 行 %s > %s', v_above, r.col, v_high),
            CASE WHEN v_above > 0
                 THEN 'nextval 迟早走到这些 id 上。dryrun 下出现此项 ⇒ 去掉 dryrun 重跑即可修复'
            END);
  END LOOP;
END $$;

-- A6.3 两条身份序列的域必须是 integer（0100 §3 收窄的回归断言）
INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A6.3', '两条身份序列的域是 integer（0100 §3 收窄的回归断言）',
       count(*) = 2,
       count(*)::text || ' / 2 条在 integer 域',
       'bigint 域的序列会接受一个 nextval()::int 永远无法交付的 setval 值，'
       '把错误从 setval 当场报错推迟到某次 register_page'
  FROM pg_sequences s
 WHERE s.schemaname = 'ingest'
   AND s.sequencename IN ('page_id_seq','user_id_seq')
   AND s.data_type = 'integer'::regtype;

-- A6.4 动态发现的 app identity 序列集合，必须与 0004_app.sql 文件尾注释里那张硬编码
--      表名清单**逐名相等**。这条断言不是给本脚本兜底（本脚本走动态发现，不会漏），
--      而是让「0004 的注释过期了」这件事显形 —— 否则别人照抄那段注释就会漏表。
INSERT INTO gate_result(code, title, ok, actual, detail)
SELECT 'A6.4', 'app identity 表集合 = 0004_app.sql 注释里的硬编码 14 张清单',
       d.only_live = 0 AND d.only_doc = 0,
       format('动态发现 %s 张；仅存在于库中 %s 张，仅存在于注释清单中 %s 张',
              d.live_cnt, d.only_live, d.only_doc),
       '不等 ⇒ 去更新 0004_app.sql 文件尾那段注释（或者它引用的表已被删）。'
       '本脚本自身不受影响。'
  FROM (
    WITH live AS (
      SELECT c.relname AS t
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE n.nspname = 'app' AND c.relkind = 'r' AND a.attidentity <> ''
    ), doc AS (
      SELECT unnest(ARRAY['user_collection','user_collection_item','user_follow',
                          'user_metric_preference','page_metric_watch','page_metric_alert',
                          'user_activity_alert','forum_interaction_alert','page_view_event',
                          'user_pixel_event','user_page_view','tracking_debug_event','tag_definition',
                          'tag_guide_sync']) AS t
    )
    SELECT (SELECT count(*) FROM live)                                     AS live_cnt,
           (SELECT count(*) FROM (SELECT t FROM live EXCEPT SELECT t FROM doc) x) AS only_live,
           (SELECT count(*) FROM (SELECT t FROM doc EXCEPT SELECT t FROM live) y) AS only_doc
  ) d;


-- =====================================================================================
-- 9. 报告 + 留痕 + 抛出
-- =====================================================================================
\echo ''
\echo '--- 断言明细 ---'
SELECT n,
       code,
       CASE ok WHEN true THEN 'PASS' WHEN false THEN 'FAIL' ELSE 'SKIP' END AS r,
       title,
       actual
  FROM gate_result ORDER BY n;

\echo ''
\echo '--- 序列水位快照 ---'
SELECT s.schemaname || '.' || s.sequencename AS sequence,
       s.data_type::text                     AS domain,
       s.last_value,
       s.max_value
  FROM pg_sequences s
 WHERE (s.schemaname = 'ingest' AND s.sequencename IN ('page_id_seq','user_id_seq'))
    OR s.schemaname = 'app'
 ORDER BY 1;

\echo ''
\echo '--- 汇总 ---'
SELECT count(*) FILTER (WHERE ok)          AS pass,
       count(*) FILTER (WHERE ok IS FALSE) AS fail,
       count(*) FILTER (WHERE ok IS NULL)  AS skip,
       count(*)                            AS total
  FROM gate_result;

-- 留痕必须在抛出**之前**：一旦 RAISE EXCEPTION，psql 就退出了，
-- 而「gate 失败」这件事同样需要在 meta.backfill_gate_run 里留下一行。
-- 本文件刻意不开显式事务，各语句自动提交，所以这行 INSERT 落地不受后面的异常影响。
INSERT INTO meta.backfill_gate_run(gate, mode, passed, assertions, skipped, detail)
SELECT CASE (SELECT scope FROM gate_ctl)
         WHEN 's1' THEN 'backfill_finalize:s1'
         ELSE 'backfill_finalize'
       END,
       (SELECT mode FROM gate_ctl),
       -- bootstrap 恒 false：它跳过了全部跨库断言，不构成验收证据
       (SELECT mode FROM gate_ctl) <> 'bootstrap'
         AND NOT EXISTS (SELECT 1 FROM gate_result WHERE ok IS FALSE)
         AND NOT EXISTS (SELECT 1 FROM gate_result WHERE ok IS NULL),
       (SELECT count(*)::int FROM gate_result WHERE ok IS NOT NULL),
       (SELECT count(*)::int FROM gate_result WHERE ok IS NULL),
       jsonb_build_object(
         'scope', (SELECT scope FROM gate_ctl),
         'max_load_age', (SELECT max_load_age::text FROM gate_ctl),
         'counts', jsonb_build_object(
             'ingest.page',        (SELECT count(*) FROM ingest.page),
             'ingest.user',        (SELECT count(*) FROM ingest."user"),
             'serve.page_current', (SELECT count(*) FROM serve.page_current),
             'v1_identity',        COALESCE((SELECT jsonb_object_agg(entity, c)
                                               FROM (SELECT entity, count(*) c
                                                       FROM meta.v1_identity GROUP BY entity) t),
                                            '{}'::jsonb)),
         'sequences', (SELECT jsonb_object_agg(schemaname || '.' || sequencename,
                                jsonb_build_object('last_value', last_value,
                                                   'max_value',  max_value,
                                                   'domain',     data_type::text))
                         FROM pg_sequences
                        WHERE (schemaname = 'ingest'
                               AND sequencename IN ('page_id_seq','user_id_seq'))
                           OR schemaname = 'app'),
         'failures', COALESCE((SELECT jsonb_agg(jsonb_build_object(
                                  'code', code, 'title', title, 'actual', actual) ORDER BY n)
                                 FROM gate_result WHERE ok IS FALSE), '[]'::jsonb),
         'skipped',  COALESCE((SELECT jsonb_agg(code ORDER BY n)
                                 FROM gate_result WHERE ok IS NULL), '[]'::jsonb));

-- 抛出点。失败项 / 被跳过项逐条列在异常消息里（见文件头「为什么先收集再抛」）。
DO $$
DECLARE
  v_mode text;
  v_scope text;
  v_fail int;
  v_skip int;
  v_msg  text;
BEGIN
  SELECT mode, scope INTO v_mode, v_scope FROM gate_ctl;
  SELECT count(*) FILTER (WHERE ok IS FALSE), count(*) FILTER (WHERE ok IS NULL)
    INTO v_fail, v_skip FROM gate_result;

  IF v_fail > 0 THEN
    SELECT string_agg(format(E'\n  ✗ %s  %s\n      实测: %s%s',
                             code, title, COALESCE(actual,'-'),
                             CASE WHEN detail IS NOT NULL
                                  THEN E'\n      说明: ' || detail ELSE '' END),
                      '' ORDER BY n)
      INTO v_msg FROM gate_result WHERE ok IS FALSE;
    RAISE EXCEPTION E'backfill_finalize gate 失败：% 条断言不通过%', v_fail, v_msg
      USING ERRCODE = 'P0001',
            HINT = '本次执行已记入 meta.backfill_gate_run（passed=false）；'
                   '修完回填后原样重跑本脚本即可（幂等）。';
  END IF;

  IF v_skip > 0 AND v_mode = 'strict' THEN
    SELECT string_agg(format(E'\n  ? %s  %s（%s）', code, title, COALESCE(detail,'-')),
                      '' ORDER BY n)
      INTO v_msg FROM gate_result WHERE ok IS NULL;
    RAISE EXCEPTION
      E'backfill_finalize gate 失败：strict 模式不允许跳过断言，被跳过 % 条%', v_skip, v_msg
      USING ERRCODE = 'P0001',
            HINT = '把缺的输入补齐（通常是 load_v1_identity.sh 没带 --user-database-url，'
                   '导致 gacha 软外键那族没载入）；确实要放过就用 -v gate_mode=dryrun。';
  END IF;

  IF v_mode = 'bootstrap' THEN
    RAISE WARNING
      'backfill_finalize：mode=bootstrap 完成（序列已归位），但**不算 gate 通过** —— '
      '跨库一一对应断言全被跳过。Phase 2 回填结束后必须以 strict 再跑一次。';
  ELSE
    RAISE NOTICE 'backfill_finalize gate 通过：% 条断言全绿（mode=% / scope=%）',
      (SELECT count(*) FROM gate_result WHERE ok), v_mode, v_scope;
  END IF;
END $$;

\echo ''
\echo '--- 本次留痕 ---'
SELECT id, mode, passed, assertions, skipped, ran_at
  FROM meta.backfill_gate_run
 WHERE gate = CASE (SELECT scope FROM gate_ctl)
                WHEN 's1' THEN 'backfill_finalize:s1'
                ELSE 'backfill_finalize'
              END
 ORDER BY id DESC LIMIT 1;
