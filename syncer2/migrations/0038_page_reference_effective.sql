-- =====================================================================================
-- 0038_page_reference_effective.sql — 当前 effective 源码的页面引用图
--
-- 决策：serve.page_reference 只保存每个页面当前 source_sha 的解析结果。源码轮动时
-- 同一事务内 upsert 新集合并删除旧集合，不把每个历史修订堆成事实；长期图指标仍可写
-- page_reference_graph_snapshot。slug→page_id 只认当前 live 身份，复用和歧义显式落列。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0038] 拒绝在受保护库 % 上修改 page_reference', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('serve.page_reference') IS NULL
     OR to_regclass('ingest.page_source') IS NULL
     OR to_regclass('meta.projection_cursor') IS NULL THEN
    RAISE EXCEPTION '[0038] 需要既有 serve.page_reference / ingest.page_source / projection_cursor';
  END IF;
END
$guard$;

BEGIN;

-- 旧表尚未投产且为空。第一次迁移时重建为自描述形状；重跑迁移不得清掉已投影的数据。
DO $shape$
DECLARE v_rows bigint;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'serve' AND table_name = 'page_reference'
       AND column_name = 'source_sha'
  ) THEN
    SELECT count(*) INTO v_rows FROM serve.page_reference;
    IF v_rows <> 0 THEN
      RAISE EXCEPTION '[0038] 旧 page_reference 非空（% 行），拒绝隐式丢弃；先显式归档/清空', v_rows;
    END IF;
    DROP TABLE serve.page_reference;
  END IF;
END
$shape$;

CREATE TABLE IF NOT EXISTS serve.page_reference (
  from_page_id             int         NOT NULL,
  source_sha               bytea       NOT NULL,
  kind                     text        NOT NULL CHECK (kind IN ('TRIPLE', 'SHORT', 'DIRECT')),
  target_scope             text        NOT NULL CHECK (target_scope IN ('internal', 'external')),
  reference_key            bytea       NOT NULL CHECK (octet_length(reference_key) = 32),
  target_key               text        NOT NULL CHECK (target_key <> ''),
  target_path              text        NOT NULL CHECK (target_path <> ''),
  target_slug              text,
  -- 空串 = 无 fragment；避免把 NULL 哨兵表达式藏进唯一索引。
  target_fragment          text        NOT NULL DEFAULT '',
  raw_target               text        NOT NULL,
  raw_text                 text        NOT NULL,
  display_texts            text[]      NOT NULL DEFAULT '{}',
  occurrence               int         NOT NULL DEFAULT 1 CHECK (occurrence > 0),
  to_page_id               int,
  resolution_status        text        NOT NULL
    CHECK (resolution_status IN ('resolved', 'missing', 'ambiguous', 'external')),
  candidate_page_ids       int[]       NOT NULL DEFAULT '{}',
  live_candidate_page_ids  int[]       NOT NULL DEFAULT '{}',
  identity_candidate_count int         NOT NULL DEFAULT 0 CHECK (identity_candidate_count >= 0),
  live_candidate_count     int         NOT NULL DEFAULT 0 CHECK (live_candidate_count >= 0),
  slug_reused              boolean     NOT NULL DEFAULT false,
  computed_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_page_id, kind, reference_key),
  CHECK (identity_candidate_count = cardinality(candidate_page_ids)),
  CHECK (live_candidate_count = cardinality(live_candidate_page_ids)),
  CHECK (slug_reused = (identity_candidate_count > 1)),
  CHECK (
    (target_scope = 'external'
      AND target_slug IS NULL AND to_page_id IS NULL
      AND resolution_status = 'external'
      AND identity_candidate_count = 0 AND live_candidate_count = 0)
    OR
    (target_scope = 'internal'
      AND target_slug IS NOT NULL AND target_slug = target_key
      AND resolution_status <> 'external'
      AND (
        (resolution_status = 'resolved' AND live_candidate_count = 1
          AND to_page_id = live_candidate_page_ids[1])
        OR (resolution_status = 'missing' AND live_candidate_count = 0 AND to_page_id IS NULL)
        OR (resolution_status = 'ambiguous' AND live_candidate_count > 1 AND to_page_id IS NULL)
      ))
  )
);

CREATE INDEX IF NOT EXISTS pr_to
  ON serve.page_reference(to_page_id, kind) WHERE to_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS pr_target_slug
  ON serve.page_reference(target_slug, resolution_status) WHERE target_scope = 'internal';
CREATE INDEX IF NOT EXISTS pr_unresolved
  ON serve.page_reference(resolution_status, target_slug)
  WHERE resolution_status IN ('missing', 'ambiguous');
-- URL 可超过 btree 单索引项上限；完整 URL 留在 target_key，可查键走固定 32-byte hash。
DO $external_index$
BEGIN
  IF to_regclass('serve.pr_external') IS NOT NULL
     AND pg_get_indexdef('serve.pr_external'::regclass) NOT LIKE '%(reference_key)%' THEN
    DROP INDEX serve.pr_external;
  END IF;
END
$external_index$;
CREATE INDEX IF NOT EXISTS pr_external
  ON serve.page_reference(reference_key) WHERE target_scope = 'external';
CREATE INDEX IF NOT EXISTS pr_source_sha ON serve.page_reference(source_sha);

COMMENT ON TABLE serve.page_reference IS
  'rebuild_from=serve.page_current.source_sha ⋈ ingest.content_blob.source（只解析 effective）'
  ' + ingest.page_source.change_seq（源码增量） + ingest.page_life_event（live slug 解析增量）';
COMMENT ON COLUMN serve.page_reference.source_sha IS
  'from_page_id 当前 effective 源码的 sha；源码轮动时旧集合在同一事务中被替换。';
COMMENT ON COLUMN serve.page_reference.target_key IS
  '稳定目标键：内链=规范 slug，站外=http(s) URL（不含 fragment）。';
COMMENT ON COLUMN serve.page_reference.reference_key IS
  'sha256(target_scope + target_key + target_fragment)；只用于固定宽度幂等键，目标原文仍完整可读。';
COMMENT ON COLUMN serve.page_reference.target_fragment IS
  '规范 fragment；空串表示无 fragment，并作为主键一部分保留同页不同锚点。';
COMMENT ON COLUMN serve.page_reference.resolution_status IS
  'resolved=恰一条 current live 身份；missing=零条；ambiguous=多条 live（绝不任选）；external=站外。';
COMMENT ON COLUMN serve.page_reference.candidate_page_ids IS
  '同 slug 的全部历史身份，按 page_id 排序；即使恰一条 live 可解析，也显式暴露 slug 复用。';
COMMENT ON COLUMN serve.page_reference.live_candidate_page_ids IS
  '同 slug 的 current live 身份；多于一条时 to_page_id 必须为空且 status=ambiguous。';

-- page_source 原先只有表内 identity id，不能参与全局安全水位。新增行在任何 seq 分配前
-- 先进入 ingest gate，再取全局 fact_seq；旧行保留 NULL，由首次 --rebuild 覆盖。
ALTER TABLE ingest.page_source ADD COLUMN IF NOT EXISTS change_seq bigint;

CREATE OR REPLACE FUNCTION ingest.fn_page_source_change_seq()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  PERFORM meta.ingest_gate_open();
  IF NEW.change_seq IS NULL THEN
    NEW.change_seq := nextval('ingest.fact_seq');
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_page_source_change_seq ON ingest.page_source;
CREATE TRIGGER trg_page_source_change_seq
  BEFORE INSERT ON ingest.page_source
  FOR EACH ROW EXECUTE FUNCTION ingest.fn_page_source_change_seq();

CREATE UNIQUE INDEX IF NOT EXISTS ps_change_seq
  ON ingest.page_source(change_seq) WHERE change_seq IS NOT NULL;

COMMENT ON COLUMN ingest.page_source.change_seq IS
  '0038 起新源码指认的全局安全水位信号。旧存量为 NULL，首次 page_reference --rebuild 直接读 effective source_sha。';
COMMENT ON FUNCTION ingest.fn_page_source_change_seq() IS
  'page_source INSERT：先登记 ingest gate，再分配全局 fact_seq，供内容投影无漏增量消费。';

-- rebuild_from 变了就把旧游标归零；同形状重跑不得倒退已推进游标。
INSERT INTO meta.projection_cursor(projection, event_domain, last_seq, rebuild_from)
VALUES (
  'serve.page_reference',
  'content',
  0,
  obj_description('serve.page_reference'::regclass, 'pg_class')
)
ON CONFLICT (projection) DO UPDATE SET
  event_domain = EXCLUDED.event_domain,
  last_seq = CASE
    WHEN meta.projection_cursor.rebuild_from IS DISTINCT FROM EXCLUDED.rebuild_from THEN 0
    ELSE meta.projection_cursor.last_seq
  END,
  rebuild_from = EXCLUDED.rebuild_from,
  updated_at = CASE
    WHEN meta.projection_cursor.rebuild_from IS DISTINCT FROM EXCLUDED.rebuild_from THEN now()
    ELSE meta.projection_cursor.updated_at
  END;

-- DROP/CREATE 会丢旧 ACL，按既有角色边界恢复。角色不存在时保持可移植。
DO $grant$
BEGIN
  IF to_regrole('bff_role') IS NOT NULL THEN
    GRANT SELECT ON serve.page_reference TO bff_role;
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON serve.page_reference TO projector_role;
  END IF;
END
$grant$;

COMMIT;
