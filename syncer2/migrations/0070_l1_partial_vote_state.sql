-- =====================================================================================
-- 0070_l1_partial_vote_state.sql
--
-- 降档时 L1 只能完成全站 ListPages 的一部分。已明确看到的 rating/rating_votes 是可靠
-- 正向证据，但它不能推进完整 L1 的修订覆盖、漂移 streak 或全站 seen 水位。用独立状态
-- 保存这种投票观测，物理隔离“检测投票变化”和“授权完整覆盖/absence”两种语义。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION '[0070] 拒绝在受保护库 % 上创建 L1 部分投票状态', current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('meta.incremental_page_state') IS NULL
     OR to_regclass('meta.ingest_run') IS NULL THEN
    RAISE EXCEPTION '[0070] 缺少 0018 incremental_page_state/ingest_run 前置对象'
      USING ERRCODE = '55000';
  END IF;
END
$guard$;

BEGIN;

CREATE TABLE IF NOT EXISTS meta.l1_partial_vote_state (
  slug               text PRIMARY KEY,
  page_id            int,
  rating             int         NOT NULL,
  rating_votes       int         NOT NULL,
  observed_at        timestamptz NOT NULL,
  run_id             bigint REFERENCES meta.ingest_run(id) ON DELETE SET NULL,
  observation_scope  text        NOT NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT l1pvs_slug_nonempty_ck CHECK (btrim(slug) <> ''),
  CONSTRAINT l1pvs_rating_votes_nonnegative_ck CHECK (rating_votes >= 0),
  CONSTRAINT l1pvs_scope_ck CHECK (observation_scope IN ('partial', 'full'))
);

CREATE INDEX IF NOT EXISTS l1pvs_observed_at
  ON meta.l1_partial_vote_state(observed_at DESC);
CREATE INDEX IF NOT EXISTS l1pvs_page_id
  ON meta.l1_partial_vote_state(page_id)
  WHERE page_id IS NOT NULL;

COMMENT ON TABLE meta.l1_partial_vote_state IS
  'L1 部分/完整轮共享的投票变化比较水位；只保存明确看到的正向观测。不得用于全站覆盖、'
  '缺席、删除、修订覆盖或漂移连续性推断。';
COMMENT ON COLUMN meta.l1_partial_vote_state.observation_scope IS
  'partial=预算内已完成批次；full=完整 L1 同步。两者都只表达本 slug 被明确观测到。';

-- 首次部署后立刻继承最近完整 L1 的投票水位；否则第一轮降档只能建 baseline，检测不到
-- 已经发生的变化。重跑迁移时 DO NOTHING，绝不拿更旧的完整轮覆盖更新的部分观测。
INSERT INTO meta.l1_partial_vote_state(
  slug, page_id, rating, rating_votes, observed_at, run_id, observation_scope
)
SELECT slug, page_id, last_l1_rating, last_l1_rating_votes,
       last_l1_seen_at, last_l1_run_id, 'full'
  FROM meta.incremental_page_state
 WHERE last_l1_rating IS NOT NULL
   AND last_l1_rating_votes IS NOT NULL
   AND last_l1_seen_at IS NOT NULL
ON CONFLICT (slug) DO NOTHING;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ingestor_role') THEN
    GRANT SELECT, INSERT, UPDATE ON meta.l1_partial_vote_state TO ingestor_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'projector_role') THEN
    GRANT SELECT ON meta.l1_partial_vote_state TO projector_role;
  END IF;
END
$grants$;

COMMIT;
