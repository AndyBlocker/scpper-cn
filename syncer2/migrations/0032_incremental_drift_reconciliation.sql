-- =====================================================================================
-- 0032_incremental_drift_reconciliation.sql
-- L1 声明值与事实投影的跨轮对账证据。首次差额只记证据，连续第二轮才允许深扫。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0032] 拒绝在受保护库 % 上创建对账状态；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
END
$guard$;

BEGIN;

CREATE TABLE IF NOT EXISTS meta.incremental_drift_state (
  page_id                   int         NOT NULL,
  kind                      text        NOT NULL,
  slug                      text        NOT NULL,
  first_detected_at         timestamptz NOT NULL,
  last_detected_at          timestamptz NOT NULL,
  last_observation_run_id   bigint      NOT NULL
    REFERENCES meta.ingest_run(id) ON DELETE CASCADE,
  consecutive_observations  int         NOT NULL DEFAULT 1,
  local_value               jsonb       NOT NULL,
  remote_value              jsonb       NOT NULL,
  last_enqueued_at          timestamptz,
  resolved_at               timestamptz,
  PRIMARY KEY (page_id, kind),
  CONSTRAINT ids_kind_ck CHECK (kind IN ('votes_full','revisions_full')),
  CONSTRAINT ids_slug_nonempty_ck CHECK (btrim(slug) <> ''),
  CONSTRAINT ids_consecutive_ck CHECK (consecutive_observations >= 0),
  CONSTRAINT ids_time_ck CHECK (last_detected_at >= first_detected_at)
);

CREATE INDEX IF NOT EXISTS ids_open_kind_streak
  ON meta.incremental_drift_state(kind, consecutive_observations DESC, last_detected_at)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE meta.incremental_drift_state IS
  'L1 rating/rating_votes/revisions 与事实投影的跨轮差额证据。无 ±1 容差；'
  '连续至少两次成功 L1 才入队，执行失败的退避与终态由 scan_task/meta.irreconcilable 负责。';
COMMENT ON COLUMN meta.incremental_drift_state.last_observation_run_id IS
  '最近一次形成该差额的完整 L1 run；同一 run 重放不得增加 consecutive_observations。';
COMMENT ON COLUMN meta.incremental_drift_state.last_enqueued_at IS
  '最近一次通过滞回和总量闸门的时间；不表示执行成功，执行证据在 meta.page_scan。';

-- 用当前已持久化的成功 L1 状态重建“第一轮”证据，零请求。
-- 下一轮完整 L1 若仍不一致，才达到 consecutive=2 并入队。
WITH live AS (
  SELECT pc.*,
         count(*) OVER (PARTITION BY pc.slug) AS live_slug_count
    FROM serve.page_current pc
   WHERE pc.status = 'live'
),
aligned AS (
  SELECT ips.page_id, ips.slug, ips.last_l1_seen_at, ips.last_l1_run_id,
         ips.last_l1_rating, ips.last_l1_rating_votes, ips.last_l1_revision,
         live.rating, live.vote_up + live.vote_down AS vote_count,
         live.revision_count
    FROM meta.incremental_page_state ips
    JOIN live ON live.page_id = ips.page_id
             AND live.slug = ips.slug
             AND live.live_slug_count = 1
    JOIN meta.ingest_run ir ON ir.id = ips.last_l1_run_id
                           AND ir.status = 'ok'
   WHERE ips.last_l1_seen_at IS NOT NULL
)
INSERT INTO meta.incremental_drift_state
  (page_id, kind, slug, first_detected_at, last_detected_at,
   last_observation_run_id, consecutive_observations, local_value, remote_value)
SELECT page_id, 'votes_full', slug, last_l1_seen_at, last_l1_seen_at,
       last_l1_run_id, 1,
       jsonb_build_object('rating', rating, 'vote_count', vote_count),
       jsonb_build_object('rating', last_l1_rating, 'vote_count', last_l1_rating_votes)
  FROM aligned
 WHERE rating <> last_l1_rating
    OR vote_count <> last_l1_rating_votes
ON CONFLICT (page_id, kind) DO NOTHING;

WITH live AS (
  SELECT pc.*,
         count(*) OVER (PARTITION BY pc.slug) AS live_slug_count
    FROM serve.page_current pc
   WHERE pc.status = 'live'
),
aligned AS (
  SELECT ips.page_id, ips.slug, ips.last_l1_seen_at, ips.last_l1_run_id,
         ips.last_l1_revision, live.revision_count
    FROM meta.incremental_page_state ips
    JOIN live ON live.page_id = ips.page_id
             AND live.slug = ips.slug
             AND live.live_slug_count = 1
    JOIN meta.ingest_run ir ON ir.id = ips.last_l1_run_id
                           AND ir.status = 'ok'
   WHERE ips.last_l1_seen_at IS NOT NULL
)
INSERT INTO meta.incremental_drift_state
  (page_id, kind, slug, first_detected_at, last_detected_at,
   last_observation_run_id, consecutive_observations, local_value, remote_value)
SELECT page_id, 'revisions_full', slug, last_l1_seen_at, last_l1_seen_at,
       last_l1_run_id, 1,
       jsonb_build_object('revision_count', revision_count),
       jsonb_build_object(
         'revision_claim', last_l1_revision,
         'expected_revision_count', last_l1_revision + 1
       )
  FROM aligned
 WHERE revision_count <> last_l1_revision + 1
ON CONFLICT (page_id, kind) DO NOTHING;

DO $grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ingestor_role') THEN
    GRANT SELECT, INSERT, UPDATE ON meta.incremental_drift_state TO ingestor_role;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'projector_role') THEN
    GRANT SELECT ON meta.incremental_drift_state TO projector_role;
  END IF;
END
$grants$;

COMMIT;
