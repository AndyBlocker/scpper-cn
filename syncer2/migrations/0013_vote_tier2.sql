-- =====================================================================================
-- 0013_vote_tier2.sql —— M2 投票 Tier2 的两个 schema 缺口
--   1. ingest.user.kind 保留 WhoRated 的 DeletedUser（必须带原始 data-id）
--   2. serve.page_current.last_complete_vote_snapshot_at 记录并在删除后冻结
-- =====================================================================================
-- 函数体收敛仍在 0006_functions.sql：
--   ensure_user 接受 deleted，并允许同 wid 在 wikidot↔deleted 间切换；
--   apply_vote_snapshot 四门全过时推进 last_complete_vote_snapshot_at。
-- 部署必须跑完整 apply.sh（它会先 CREATE OR REPLACE 0006，再执行本结构迁移）。

BEGIN;

DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      'refusing to apply vote Tier2 migration to v1 production database % (read-only by policy)',
      current_database();
  END IF;
  IF to_regclass('ingest."user"') IS NULL OR to_regclass('serve.page_current') IS NULL THEN
    RAISE EXCEPTION '0013_vote_tier2.sql 需要先执行 0001_ingest.sql 与 0002_serve.sql';
  END IF;
END $$;

-- 0001 自动生成的 CHECK 名在真实库中是 user_check / user_check1 / user_check2。
-- 先逐名删除，再用有语义的稳定名字重建；重复执行仍收敛。
ALTER TABLE ingest."user" DROP CONSTRAINT IF EXISTS user_kind_check;
ALTER TABLE ingest."user" DROP CONSTRAINT IF EXISTS user_check;
ALTER TABLE ingest."user" DROP CONSTRAINT IF EXISTS user_check1;
ALTER TABLE ingest."user" DROP CONSTRAINT IF EXISTS user_check2;
ALTER TABLE ingest."user" DROP CONSTRAINT IF EXISTS user_wikidot_identity_ck;
ALTER TABLE ingest."user" DROP CONSTRAINT IF EXISTS user_wikidot_id_scope_ck;
ALTER TABLE ingest."user" DROP CONSTRAINT IF EXISTS user_anon_key_ck;

ALTER TABLE ingest."user"
  ADD CONSTRAINT user_kind_check
    CHECK (kind IN ('wikidot','deleted','guest','anon','synthetic')),
  ADD CONSTRAINT user_wikidot_identity_ck
    CHECK (kind NOT IN ('wikidot','deleted') OR wikidot_id IS NOT NULL),
  ADD CONSTRAINT user_wikidot_id_scope_ck
    CHECK (wikidot_id IS NULL OR kind IN ('wikidot','deleted','guest')),
  ADD CONSTRAINT user_anon_key_ck
    CHECK (kind NOT IN ('anon','guest') OR anon_key IS NOT NULL OR kind = 'guest');

COMMENT ON COLUMN ingest."user".kind IS
  '身份当前类型:wikidot|deleted|guest|anon|synthetic。WhoRated DeletedUser 只有带原始 '
  'data-id 才可铸 deleted；无 id 的已删用户进 meta.vote_quarantine。deleted 与同 wid 的 '
  'wikidot 行原地互转，既不复制 actor，也让 visible_kinds={wikidot} 排除已删账号 absence。';

ALTER TABLE serve.page_current
  ADD COLUMN IF NOT EXISTS last_complete_vote_snapshot_at timestamptz;

CREATE INDEX IF NOT EXISTS pc_vote_snapshot_due
  ON serve.page_current(last_complete_vote_snapshot_at NULLS FIRST, first_published_at)
  WHERE status = 'live';

COMMENT ON COLUMN serve.page_current.last_complete_vote_snapshot_at IS
  '最近一次 WhoRated 四门全过（完整/条数/可见类型/Σsign=Tier1 rating）的观测时刻。'
  'apply_vote_snapshot 仅在 status=live 时推进；页面删除后自然冻结，供下游区分真 0 票与未及观测。';

COMMIT;
