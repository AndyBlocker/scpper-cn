-- =====================================================================================
-- 0203_backfill_s4_s5_s6.sql —— S4 署名 / S5 生命周期血统 / S6 冻结支撑
-- =====================================================================================
-- 回填本体：src/backfill/s456.ts
-- 本迁移只建立可重放证据与冻结护栏，不碰 vote_event / vote_current。
-- =====================================================================================

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      'refusing to apply v2 S4/S5/S6 backfill DDL to protected database % (v1 is read-only)',
      current_database();
  END IF;
END $$;

-- -------------------------------------------------------------------------------------
-- 1. legacy_votes_cn 三张原表的同型快照
-- -------------------------------------------------------------------------------------
-- 不用一个 jsonb 大口袋：那会丢掉原列型并把 timestamptz/数值做语义转换。三张 typed
-- side table 与源列逐名逐型一致；umbrella manifest 统一叫 meta.v1_legacy_snapshot。
CREATE TABLE IF NOT EXISTS meta.v1_legacy_snapshot_pages (
  "__Id"      bigint,
  "WikidotId" bigint NOT NULL,
  "SiteId"    bigint NOT NULL,
  "Name"      text   NOT NULL,
  "Title"     text
);
CREATE UNIQUE INDEX IF NOT EXISTS v1lsp_id
  ON meta.v1_legacy_snapshot_pages("__Id");

CREATE TABLE IF NOT EXISTS meta.v1_legacy_snapshot_votes (
  "__Id"          bigint,
  "PageId"        bigint NOT NULL,
  "UserId"        bigint NOT NULL,
  "Value"         smallint,
  "DateTime"      timestamptz,
  "DeltaFromPrev" smallint
);
CREATE UNIQUE INDEX IF NOT EXISTS v1lsv_id
  ON meta.v1_legacy_snapshot_votes("__Id");

CREATE TABLE IF NOT EXISTS meta.v1_legacy_snapshot_vote_history (
  "__Id"          bigint,
  "PageId"        bigint NOT NULL,
  "UserId"        bigint NOT NULL,
  "Value"         smallint,
  "DateTime"      timestamptz,
  "DeltaFromPrev" smallint
);
CREATE UNIQUE INDEX IF NOT EXISTS v1lsvh_id
  ON meta.v1_legacy_snapshot_vote_history("__Id");

CREATE TABLE IF NOT EXISTS meta.v1_legacy_snapshot (
  source_table       text PRIMARY KEY
    CHECK (source_table IN ('pages', 'votes', 'vote_history')),
  row_count          bigint NOT NULL CHECK (row_count >= 0),
  source_fingerprint text NOT NULL,
  target_fingerprint text NOT NULL,
  source_database    text NOT NULL,
  import_script_path text NOT NULL
    DEFAULT 'backend/src/cli/legacy-vote-migrate.ts',
  copied_at          timestamptz NOT NULL DEFAULT now(),
  frozen_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (source_fingerprint = target_fingerprint)
);

COMMENT ON TABLE meta.v1_legacy_snapshot IS
  'legacy_votes_cn.pages/votes/vote_history 零语义转换 typed COPY 的 manifest。'
  '原始行分别在同名前缀的三张 typed side table；manifest 指纹相等后即冻结。';
COMMENT ON COLUMN meta.v1_legacy_snapshot.import_script_path IS
  '2025-11 legacy 导入代码的 git 路径；快照与代码共同构成 9.5k 已删页的重放血统。';

-- -------------------------------------------------------------------------------------
-- 2. 存量署名的逐行映射审计
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta.v1_attribution_map (
  v1_attribution_id   int PRIMARY KEY,
  v1_page_version_id  int NOT NULL,
  page_id             int NOT NULL REFERENCES ingest.page(id),
  v1_user_id          int,
  anon_key            text,
  actor_id             int NOT NULL REFERENCES ingest."user"(id),
  role                 text NOT NULL,
  ord                  int NOT NULL,
  at_date              date,
  CHECK (
    (v1_user_id IS NOT NULL AND anon_key IS NULL AND actor_id = v1_user_id)
    OR
    (v1_user_id IS NULL AND anon_key LIKE 'anon:%')
  )
);
CREATE INDEX IF NOT EXISTS v1am_page ON meta.v1_attribution_map(page_id);
CREATE INDEX IF NOT EXISTS v1am_pv   ON meta.v1_attribution_map(v1_page_version_id);

COMMENT ON TABLE meta.v1_attribution_map IS
  'S4 逐行证据：Attribution.pageVerId → PageVersion.pageId → ingest.page.id。'
  '表中刻意没有 slug 列，物理上杜绝存量按 slug 重解析；匿名 anon_key 原样保存。';

-- -------------------------------------------------------------------------------------
-- 3. v1 双 isDeleted 发散审计
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta.v1_page_life_divergence_audit (
  page_id                    int PRIMARY KEY REFERENCES ingest.page(id),
  v1_page_is_deleted         boolean NOT NULL,
  v1_current_version_id      int NOT NULL,
  v1_current_version_deleted boolean NOT NULL,
  resolved_deleted           boolean NOT NULL,
  resolution                 text NOT NULL
    CHECK (resolution = 'page_life_event_from_v1_page_state'),
  captured_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE meta.v1_page_life_divergence_audit IS
  'S5 双真相源发散的原值。resolved_deleted 只用于生成一次 page_life_event；'
  '迁移后 serve.page_current.status 只能由 page_life_event 裁决。';

-- -------------------------------------------------------------------------------------
-- 4. 一次性回填产物冻结
-- -------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta.v1_backfill_artifact_freeze (
  artifact    text PRIMARY KEY CHECK (
    artifact IN ('v1_attribution_map', 'v1_version_map')
  ),
  row_count   bigint NOT NULL CHECK (row_count >= 0),
  fingerprint text NOT NULL,
  frozen_at   timestamptz NOT NULL DEFAULT now(),
  frozen_by   text NOT NULL DEFAULT current_user
);

CREATE OR REPLACE FUNCTION meta.guard_frozen_v1_artifact()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_artifact text;
BEGIN
  v_artifact := CASE TG_TABLE_NAME
    WHEN 'v1_attribution_map' THEN 'v1_attribution_map'
    WHEN 'v1_version_map'     THEN 'v1_version_map'
    ELSE NULL
  END;
  IF v_artifact IS NOT NULL AND EXISTS (
    SELECT 1 FROM meta.v1_backfill_artifact_freeze f WHERE f.artifact = v_artifact
  ) THEN
    RAISE EXCEPTION '% 已冻结，拒绝 %', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, TG_OP
      USING ERRCODE = '25006';
  END IF;
  IF TG_LEVEL = 'STATEMENT' THEN
    RETURN NULL;
  ELSIF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_v1am_frozen_row ON meta.v1_attribution_map;
CREATE TRIGGER trg_v1am_frozen_row
  BEFORE INSERT OR UPDATE OR DELETE ON meta.v1_attribution_map
  FOR EACH ROW EXECUTE FUNCTION meta.guard_frozen_v1_artifact();
DROP TRIGGER IF EXISTS trg_v1am_frozen_truncate ON meta.v1_attribution_map;
CREATE TRIGGER trg_v1am_frozen_truncate
  BEFORE TRUNCATE ON meta.v1_attribution_map
  FOR EACH STATEMENT EXECUTE FUNCTION meta.guard_frozen_v1_artifact();

DROP TRIGGER IF EXISTS trg_vvm_frozen_row ON meta.v1_version_map;
CREATE TRIGGER trg_vvm_frozen_row
  BEFORE INSERT OR UPDATE OR DELETE ON meta.v1_version_map
  FOR EACH ROW EXECUTE FUNCTION meta.guard_frozen_v1_artifact();
DROP TRIGGER IF EXISTS trg_vvm_frozen_truncate ON meta.v1_version_map;
CREATE TRIGGER trg_vvm_frozen_truncate
  BEFORE TRUNCATE ON meta.v1_version_map
  FOR EACH STATEMENT EXECUTE FUNCTION meta.guard_frozen_v1_artifact();

-- legacy typed 快照在对应 manifest 行出现后不再接受任何 DML；UPDATE/DELETE/TRUNCATE 从
-- 一开始就没有合法用例。需要重做时只能在冻结前让整笔 COPY 事务回滚。
CREATE OR REPLACE FUNCTION meta.guard_v1_legacy_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE v_source text;
BEGIN
  v_source := CASE TG_TABLE_NAME
    WHEN 'v1_legacy_snapshot_pages'       THEN 'pages'
    WHEN 'v1_legacy_snapshot_votes'       THEN 'votes'
    WHEN 'v1_legacy_snapshot_vote_history' THEN 'vote_history'
    ELSE NULL
  END;
  IF TG_OP <> 'INSERT'
     OR EXISTS (SELECT 1 FROM meta.v1_legacy_snapshot s WHERE s.source_table = v_source) THEN
    RAISE EXCEPTION '% 是冻结血统快照，拒绝 %', TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, TG_OP
      USING ERRCODE = '25006';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'v1_legacy_snapshot_pages',
    'v1_legacy_snapshot_votes',
    'v1_legacy_snapshot_vote_history'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_frozen_row ON meta.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_frozen_row BEFORE INSERT OR UPDATE OR DELETE ON meta.%I '
      'FOR EACH ROW EXECUTE FUNCTION meta.guard_v1_legacy_snapshot()', t, t);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_frozen_truncate ON meta.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_frozen_truncate BEFORE TRUNCATE ON meta.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION meta.guard_v1_legacy_snapshot()', t, t);
  END LOOP;
END $$;

COMMIT;
