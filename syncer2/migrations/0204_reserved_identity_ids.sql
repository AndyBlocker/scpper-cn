-- =====================================================================================
-- 0204_reserved_identity_ids.sql
-- 活 v1 下的 v2 保留身份段 + S4 既有 412 个匿名 actor 原子重映射
-- =====================================================================================
-- v1 在迁移期间不停写，因此任何“当前 v1 max(id) + 1”都会被追上。本迁移：
--   * v2 自铸 page 的序列从 1,500,000,000 段继续；
--   * S4 匿名 actor 与 ensure_user 自铸用户从 2,000,000,000 段继续；
--   * 把已经落在 v1 移动值域内的 412 个 S4 actor 连同全部外键原子重映射；
--   * 先把旧 user 行及逐表引用计数写入不可变审计表。
--
-- 整个 DDL、快照、clone→改引用→删旧行、序列抬升都在同一事务；任何一步失败即全回滚。
-- =====================================================================================

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      'refusing to apply v2 reserved identity migration to protected database %',
      current_database();
  END IF;
END $$;

-- 与 src/backfill/id-policy.ts 同名同值。用函数而不是散落的数字字面量，让 gate、
-- 运维查询和后续迁移都从同一个数据库常量读取。
CREATE OR REPLACE FUNCTION meta.v2_reserved_page_id_start()
RETURNS int
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT 1500000000::int $$;

CREATE OR REPLACE FUNCTION meta.v2_reserved_anonymous_actor_id_start()
RETURNS int
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT 2000000000::int $$;

CREATE OR REPLACE FUNCTION meta.v1_user_id_safety_factor()
RETURNS int
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$ SELECT 7::int $$;

COMMENT ON FUNCTION meta.v2_reserved_page_id_start() IS
  '活 v1 回填期内 v2 自铸 page 的保留段起点；不得再从 v1 当前 Page.max(id)+1 分配。';
COMMENT ON FUNCTION meta.v2_reserved_anonymous_actor_id_start() IS
  'S4 匿名 actor / v2 自铸 user 的保留段起点 2,000,000,000。'
  '2026-07-28 v1 User.max(id)=283,404,101；起点大于其 7 倍，且仍留 147,483,648 个 int4 id。';
COMMENT ON FUNCTION meta.v1_user_id_safety_factor() IS
  'full backfill gate 的匿名 actor 安全系数；min(actor_id) 必须严格大于实时 v1 User.max(id)×7。';

CREATE TABLE IF NOT EXISTS meta.v1_anonymous_actor_remap_audit (
  old_id                  int PRIMARY KEY,
  new_id                  int NOT NULL UNIQUE,
  old_kind                text NOT NULL,
  old_wikidot_id          int,
  old_anon_key            text,
  old_username            text,
  old_display_name        text,
  old_created_at          timestamptz NOT NULL,
  old_wikidot_unix_name   text,
  old_username_is_legacy  boolean NOT NULL,
  references_before       jsonb NOT NULL,
  v1_max_user_id          int NOT NULL,
  reserved_start          int NOT NULL,
  safety_factor           int NOT NULL,
  remap_reason            text NOT NULL,
  remapped_at             timestamptz NOT NULL DEFAULT now(),
  remapped_by             text NOT NULL DEFAULT session_user,
  CHECK (new_id >= reserved_start),
  CHECK (new_id > v1_max_user_id::bigint * safety_factor)
);

COMMENT ON TABLE meta.v1_anonymous_actor_remap_audit IS
  '0204 原子重映射前的 412 行 ingest.user 完整旧值，以及每个旧 id 在全部 user 外键列中的引用计数。'
  'old_id 在迁移提交后不再存在；new_id 是可追溯的新身份。';

-- 阻止 ensure_user / register_page 与本次命名空间切换并发。v1 在另一个库继续正常写；
-- 这里只锁 v2 两张身份表。
SELECT pg_advisory_xact_lock(hashtext('backfill:reserved-identity-remap'));
LOCK TABLE ingest."user" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ingest.page IN SHARE ROW EXCLUSIVE MODE;

-- 第一次执行时先固化 412 行旧值。重跑时审计已存在且旧 id 已消失，只走后置验证。
DO $$
DECLARE
  v_audit_count int;
  v_actor_count int;
  v_v1_max      int;
  v_reserved    int := meta.v2_reserved_anonymous_actor_id_start();
  v_factor      int := meta.v1_user_id_safety_factor();
BEGIN
  SELECT count(*) INTO v_audit_count FROM meta.v1_anonymous_actor_remap_audit;
  SELECT count(DISTINCT actor_id) INTO v_actor_count
    FROM meta.v1_attribution_map
   WHERE v1_user_id IS NULL;
  SELECT COALESCE(max(v1_id), 0)::int INTO v_v1_max
    FROM meta.v1_identity
   WHERE entity = 'user';

  IF v_actor_count <> 412 THEN
    RAISE EXCEPTION
      '0204 期望 S4 匿名 actor=412，实际 %；拒绝猜测重映射集合', v_actor_count;
  END IF;

  IF v_audit_count <> 0 THEN
    IF v_audit_count <> 412 THEN
      RAISE EXCEPTION '0204 审计表应为 412 行，实际 %', v_audit_count;
    END IF;
    RETURN;
  END IF;

  IF v_reserved <= v_v1_max::bigint * v_factor THEN
    RAISE EXCEPTION
      '匿名保留段结构性 gate 失败：reserved_start=% <= v1_max=% × factor=%',
      v_reserved, v_v1_max, v_factor;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM meta.v1_attribution_map m
     WHERE m.v1_user_id IS NULL
       AND m.actor_id >= v_reserved
  ) THEN
    RAISE EXCEPTION '首次 0204 执行前已有 S4 actor 落在保留段，拒绝混合新旧映射';
  END IF;

  IF EXISTS (
    WITH desired AS (
      SELECT (v_reserved::bigint + row_number() OVER (ORDER BY u.anon_key, u.id) - 1)::int id
        FROM ingest."user" u
        JOIN (
          SELECT DISTINCT actor_id
            FROM meta.v1_attribution_map
           WHERE v1_user_id IS NULL
        ) a ON a.actor_id = u.id
    )
    SELECT 1 FROM desired d JOIN ingest."user" occupied USING (id)
  ) THEN
    RAISE EXCEPTION '0204 目标保留 id 已被占用';
  END IF;

  INSERT INTO meta.v1_anonymous_actor_remap_audit(
    old_id,new_id,old_kind,old_wikidot_id,old_anon_key,old_username,
    old_display_name,old_created_at,old_wikidot_unix_name,old_username_is_legacy,
    references_before,v1_max_user_id,reserved_start,safety_factor,remap_reason
  )
  WITH actors AS (
    SELECT u.*,
           (v_reserved::bigint + row_number() OVER (ORDER BY u.anon_key, u.id) - 1)::int
             AS new_id
      FROM ingest."user" u
      JOIN (
        SELECT DISTINCT actor_id
          FROM meta.v1_attribution_map
         WHERE v1_user_id IS NULL
      ) a ON a.actor_id = u.id
  )
  SELECT
    a.id,a.new_id,a.kind,a.wikidot_id,a.anon_key,a.username,a.display_name,
    a.created_at,a.wikidot_unix_name,a.username_is_legacy,
    jsonb_build_object(
      'ingest.attribution_event.actor_id',
        (SELECT count(*) FROM ingest.attribution_event x WHERE x.actor_id=a.id),
      'serve.attribution_current.actor_id',
        (SELECT count(*) FROM serve.attribution_current x WHERE x.actor_id=a.id),
      'meta.v1_attribution_map.actor_id',
        (SELECT count(*) FROM meta.v1_attribution_map x WHERE x.actor_id=a.id),
      'app.collection_account_owner.user_id',
        (SELECT count(*) FROM app.collection_account_owner x WHERE x.user_id=a.id),
      'app.forum_interaction_alert.actor_user_id',
        (SELECT count(*) FROM app.forum_interaction_alert x WHERE x.actor_user_id=a.id),
      'app.forum_interaction_alert.recipient_user_id',
        (SELECT count(*) FROM app.forum_interaction_alert x WHERE x.recipient_user_id=a.id),
      'ingest.forum_post.author_user_id',
        (SELECT count(*) FROM ingest.forum_post x WHERE x.author_user_id=a.id),
      'ingest.forum_thread.created_by_user_id',
        (SELECT count(*) FROM ingest.forum_thread x WHERE x.created_by_user_id=a.id),
      'app.page_metric_watch.user_id',
        (SELECT count(*) FROM app.page_metric_watch x WHERE x.user_id=a.id),
      'ingest.revision.author_id',
        (SELECT count(*) FROM ingest.revision x WHERE x.author_id=a.id),
      'app.user_activity_alert.follower_id',
        (SELECT count(*) FROM app.user_activity_alert x WHERE x.follower_id=a.id),
      'app.user_activity_alert.target_user_id',
        (SELECT count(*) FROM app.user_activity_alert x WHERE x.target_user_id=a.id),
      'app.user_collection.owner_id',
        (SELECT count(*) FROM app.user_collection x WHERE x.owner_id=a.id),
      'app.user_follow.follower_id',
        (SELECT count(*) FROM app.user_follow x WHERE x.follower_id=a.id),
      'app.user_follow.target_user_id',
        (SELECT count(*) FROM app.user_follow x WHERE x.target_user_id=a.id),
      'app.user_metric_preference.user_id',
        (SELECT count(*) FROM app.user_metric_preference x WHERE x.user_id=a.id),
      'app.user_pixel_event.user_id',
        (SELECT count(*) FROM app.user_pixel_event x WHERE x.user_id=a.id),
      'serve.vote_current.voter_id',
        (SELECT count(*) FROM serve.vote_current x WHERE x.voter_id=a.id),
      'ingest.vote_event.voter_id',
        (SELECT count(*) FROM ingest.vote_event x WHERE x.voter_id=a.id)
    ),
    v_v1_max,v_reserved,v_factor,
    'S4 actor 离开仍在增长的 v1 User.id 值域，进入具名保留高位段'
  FROM actors a;

  IF (SELECT count(*) FROM meta.v1_anonymous_actor_remap_audit) <> 412 THEN
    RAISE EXCEPTION '0204 旧值快照没有完整写入 412 行';
  END IF;
END $$;

-- 只有首次执行（旧 id 仍在）才解除旧 fingerprint 冻结。整个动作与映射更新同事务；
-- 随后的 S4 execute 会用新 actor_id 重新核对并写回 freeze manifest。
DELETE FROM meta.v1_backfill_artifact_freeze f
 WHERE f.artifact = 'v1_attribution_map'
   AND EXISTS (
     SELECT 1
       FROM meta.v1_anonymous_actor_remap_audit a
       JOIN ingest."user" u ON u.id = a.old_id
   );

-- append-only attribution_event 只在这笔受审计迁移事务内允许 UPDATE。
SET LOCAL scpper.bypass_guard = 'on';

-- anon_key 有 UNIQUE：先把旧行临时改名，再按审计快照 clone 新行。事务外永远看不到临时 key。
UPDATE ingest."user" u
   SET anon_key = '0204-remap-old:' || u.id::text || ':' || COALESCE(u.anon_key, '')
  FROM meta.v1_anonymous_actor_remap_audit a
 WHERE u.id = a.old_id;

INSERT INTO ingest."user"(
  id,kind,wikidot_id,anon_key,username,display_name,created_at,
  wikidot_unix_name,username_is_legacy
)
SELECT new_id,old_kind,old_wikidot_id,old_anon_key,old_username,old_display_name,
       old_created_at,old_wikidot_unix_name,old_username_is_legacy
  FROM meta.v1_anonymous_actor_remap_audit a
 WHERE EXISTS (SELECT 1 FROM ingest."user" old WHERE old.id=a.old_id)
ON CONFLICT (id) DO NOTHING;

-- 显式覆盖当前数据库里 ingest.user 的全部唯一外键列。即使某表当前引用数为 0，也不靠
-- “现在恰好为空”跳过；后面的 pg_constraint 动态断言还会拦住未来新增但未处理的外键。
UPDATE ingest.attribution_event x SET actor_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.actor_id=a.old_id;
UPDATE serve.attribution_current x SET actor_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.actor_id=a.old_id;
UPDATE meta.v1_attribution_map x SET actor_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.actor_id=a.old_id;
UPDATE app.collection_account_owner x SET user_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.user_id=a.old_id;
UPDATE app.forum_interaction_alert x SET actor_user_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.actor_user_id=a.old_id;
UPDATE app.forum_interaction_alert x SET recipient_user_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.recipient_user_id=a.old_id;
UPDATE ingest.forum_post x SET author_user_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.author_user_id=a.old_id;
UPDATE ingest.forum_thread x SET created_by_user_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.created_by_user_id=a.old_id;
UPDATE app.page_metric_watch x SET user_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.user_id=a.old_id;
UPDATE ingest.revision x SET author_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.author_id=a.old_id;
UPDATE app.user_activity_alert x SET follower_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.follower_id=a.old_id;
UPDATE app.user_activity_alert x SET target_user_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.target_user_id=a.old_id;
UPDATE app.user_collection x SET owner_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.owner_id=a.old_id;
UPDATE app.user_follow x SET follower_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.follower_id=a.old_id;
UPDATE app.user_follow x SET target_user_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.target_user_id=a.old_id;
UPDATE app.user_metric_preference x SET user_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.user_id=a.old_id;
UPDATE app.user_pixel_event x SET user_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.user_id=a.old_id;
UPDATE serve.vote_current x SET voter_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.voter_id=a.old_id;
UPDATE ingest.vote_event x SET voter_id=a.new_id
  FROM meta.v1_anonymous_actor_remap_audit a WHERE x.voter_id=a.old_id;

DELETE FROM ingest."user" u
 USING meta.v1_anonymous_actor_remap_audit a
 WHERE u.id=a.old_id;

DO $$
DECLARE
  r             record;
  v_remaining   bigint;
  v_bad         bigint;
  v_v1_max      bigint;
  v_actor_min   bigint;
BEGIN
  -- 动态枚举所有指向 ingest.user(id) 的单列外键；显式 UPDATE 漏任何一列都会整笔回滚。
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, a.attname AS col
      FROM pg_constraint c
      JOIN pg_attribute a
        ON a.attrelid=c.conrelid AND a.attnum=c.conkey[1]
     WHERE c.contype='f'
       AND c.confrelid='ingest."user"'::regclass
       AND cardinality(c.conkey)=1
       AND cardinality(c.confkey)=1
       AND c.conparentid=0
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %s x JOIN meta.v1_anonymous_actor_remap_audit a'
      ' ON x.%I=a.old_id',
      r.tbl, r.col
    ) INTO v_remaining;
    IF v_remaining <> 0 THEN
      RAISE EXCEPTION '0204 漏更新 %.%：仍有 % 个旧 id 引用',
        r.tbl, r.col, v_remaining;
    END IF;
  END LOOP;

  SELECT count(*) INTO v_bad
    FROM meta.v1_anonymous_actor_remap_audit a
    LEFT JOIN ingest."user" u ON u.id=a.new_id
   WHERE u.id IS NULL
      OR (u.kind,u.wikidot_id,u.anon_key,u.username,u.display_name,u.created_at,
          u.wikidot_unix_name,u.username_is_legacy)
         IS DISTINCT FROM
         (a.old_kind,a.old_wikidot_id,a.old_anon_key,a.old_username,a.old_display_name,
          a.old_created_at,a.old_wikidot_unix_name,a.old_username_is_legacy);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION '0204 新 actor 与旧值快照有 % 行不一致', v_bad;
  END IF;

  IF EXISTS (
    SELECT 1 FROM meta.v1_anonymous_actor_remap_audit a
    JOIN ingest."user" u ON u.id=a.old_id
  ) THEN
    RAISE EXCEPTION '0204 仍残留旧 actor 行';
  END IF;

  SELECT min(actor_id), count(DISTINCT actor_id)
    INTO v_actor_min, v_bad
    FROM meta.v1_attribution_map
   WHERE v1_user_id IS NULL;
  SELECT COALESCE(max(v1_id),0) INTO v_v1_max
    FROM meta.v1_identity WHERE entity='user';

  IF v_bad <> 412
     OR v_actor_min < meta.v2_reserved_anonymous_actor_id_start()
     OR v_actor_min <= v_v1_max * meta.v1_user_id_safety_factor() THEN
    RAISE EXCEPTION
      '0204 保留段 gate 失败：actors=% min=% v1_max=% factor=%',
      v_bad,v_actor_min,v_v1_max,meta.v1_user_id_safety_factor();
  END IF;
END $$;

-- S4 之后所有没有显式 p_*_id 的 v2 自铸身份都从保留段序列继续。v1 top-up 仍显式插入
-- 原 id；各 reset 脚本只单调上调，因此不会把这两个水位拉回移动的 v1 max。
DO $$
DECLARE
  v_last   bigint;
  v_called boolean;
  v_high   bigint;
  v_target bigint;
BEGIN
  SELECT last_value,is_called INTO v_last,v_called FROM ingest.page_id_seq;
  v_high := CASE WHEN v_called THEN v_last ELSE v_last-1 END;
  v_target := GREATEST(v_high, meta.v2_reserved_page_id_start()::bigint-1);
  IF v_target > v_high THEN
    PERFORM setval('ingest.page_id_seq',v_target,true);
  END IF;

  SELECT last_value,is_called INTO v_last,v_called FROM ingest.user_id_seq;
  v_high := CASE WHEN v_called THEN v_last ELSE v_last-1 END;
  SELECT GREATEST(
           v_high,
           meta.v2_reserved_anonymous_actor_id_start()::bigint-1,
           COALESCE(max(id),0)
         )
    INTO v_target
    FROM ingest."user";
  IF v_target > v_high THEN
    PERFORM setval('ingest.user_id_seq',v_target,true);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION meta.guard_v1_anonymous_actor_remap_audit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'meta.v1_anonymous_actor_remap_audit 是不可变迁移证据，拒绝 %', TG_OP
    USING ERRCODE='25006';
END;
$$;

DROP TRIGGER IF EXISTS trg_v1aar_audit_immutable
  ON meta.v1_anonymous_actor_remap_audit;
CREATE TRIGGER trg_v1aar_audit_immutable
  BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE
  ON meta.v1_anonymous_actor_remap_audit
  FOR EACH STATEMENT
  EXECUTE FUNCTION meta.guard_v1_anonymous_actor_remap_audit();

COMMIT;
