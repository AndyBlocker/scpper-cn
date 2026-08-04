-- =====================================================================================
-- 0200_backfill_s1_identity.sql —— v1→v2 S1 身份层回填支撑
-- =====================================================================================
-- 本文件只补 S1 所需的 schema/provenance 与既有 gate 输入词表：
--   * ingest."user".username_is_legacy：标记 v1 username 的 legacy provenance；
--   * page_slug_history 的自然幂等键；
--   * meta.v1_identity(_load) 增加 vote_anon 证据族，供现有 finalize gate 断言。
-- 回填本体在 src/backfill/s1.ts，跨库只走应用层，v1 连接强制 read-only。
-- =====================================================================================

\set ON_ERROR_STOP on

BEGIN;

DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      'refusing to apply v2 S1 backfill DDL to protected database % (v1 is read-only)',
      current_database();
  END IF;
END $$;

ALTER TABLE ingest."user"
  ADD COLUMN IF NOT EXISTS username_is_legacy boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN ingest."user".username_is_legacy IS
  'true = username 原样来自 v1 User.username，未经纠正或覆盖。'
  '生产实测约 91.8% 命中 lower(replace(display_name,'' '',''_'')) 伪造公式；'
  '真实 wikidot unixName 必须写 wikidot_unix_name，不得写回 username。';

-- page_slug_history 没有上游行 id；(page_id, slug, valid_from) 是 S1 重跑时的稳定自然键。
-- 同一 slug 日后可再次启用，只要 valid_from 不同，不会被错误折叠。
CREATE UNIQUE INDEX IF NOT EXISTS psh_backfill_identity
  ON ingest.page_slug_history(page_id, slug, valid_from);

-- 复用 0100 的跨库证据基础设施。vote_anon 的 v1_id 是 Vote.id；正常生产基线应为零行，
-- meta.v1_identity_load.expected_rows=0 则明确证明“查过且为零”，不是空表真空通过。
ALTER TABLE meta.v1_identity
  DROP CONSTRAINT IF EXISTS v1_identity_entity_check;
ALTER TABLE meta.v1_identity
  ADD CONSTRAINT v1_identity_entity_check
  CHECK (entity IN ('page', 'user', 'gacha_page_ref', 'vote_anon'));

ALTER TABLE meta.v1_identity_load
  DROP CONSTRAINT IF EXISTS v1_identity_load_entity_check;
ALTER TABLE meta.v1_identity_load
  ADD CONSTRAINT v1_identity_load_entity_check
  CHECK (entity IN ('page', 'user', 'gacha_page_ref', 'vote_anon'));

COMMENT ON COLUMN meta.v1_identity.entity IS
  '''page'' / ''user'' = v1 身份；''gacha_page_ref'' = 跨库软外键债主；'
  '''vote_anon'' = v1 Vote.anonKey IS NOT NULL 的证据行（生产基线必须为 0）。';

COMMIT;

