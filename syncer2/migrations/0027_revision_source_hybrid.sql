-- =====================================================================================
-- 0027_revision_source_hybrid.sql
-- 存活页源码修订全文回填。
--
-- 文件名保留旧的 “hybrid”，以便已经部署过 0027 的环境原位升级；运行策略已经从
-- PageDiff + 每 15 版锚点改为 history/PageSourceModule 每版全文。旧
-- ingest.revision_source_delta 若已存在，作为 append-only 取证遗留保留，但不再写入。
-- =====================================================================================

\set ON_ERROR_STOP on

DO $guard$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      '[0027] 拒绝在受保护库 % 上创建修订源码回填；目标必须是 scpper-v2',
      current_database()
      USING ERRCODE = '42501';
  END IF;
  IF to_regclass('ingest.revision') IS NULL
     OR to_regclass('ingest.content_blob') IS NULL
     OR to_regclass('meta.backfill_progress') IS NULL
     OR to_regclass('meta.page_scan') IS NULL THEN
    RAISE EXCEPTION '[0027] 依赖 0001/0003/0006，请先应用基础迁移';
  END IF;
END
$guard$;

BEGIN;

-- 修订级低优先队列。保留旧 edge/anchor 列以原位兼容已部署的 0027；全文任务彼此独立，
-- claim 时不再等待前一版，is_anchor 对新 job 恒为 true。
CREATE TABLE IF NOT EXISTS meta.revision_source_backfill_job (
  revision_seq              bigint PRIMARY KEY REFERENCES ingest.revision(seq),
  page_id                   int NOT NULL,
  wikidot_id                int NOT NULL,
  wikidot_revision_id       bigint NOT NULL,
  from_revision_seq         bigint,
  from_wikidot_revision_id  bigint,
  ordinal                   int NOT NULL CHECK (ordinal > 0),
  revision_total            int NOT NULL CHECK (revision_total > 0),
  is_anchor                 boolean NOT NULL DEFAULT true,
  strategy                  text NOT NULL DEFAULT 'page-source-v1',
  status                    text NOT NULL DEFAULT 'pending',
  attempts                  int NOT NULL DEFAULT 0,
  consecutive_failures      int NOT NULL DEFAULT 0,
  not_before                timestamptz NOT NULL DEFAULT now(),
  locked_by                 text,
  locked_at                 timestamptz,
  last_error                text,
  source_sha                bytea REFERENCES ingest.content_blob(sha256),
  source_bytes              int,
  response_bytes            int,
  blob_inserted             boolean,
  completed_at              timestamptz,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rsbj_status_ck CHECK (
    status IN ('pending','processing','retry','done','irreconcilable','skipped_deleted')
  ),
  CONSTRAINT rsbj_edge_ck CHECK (
    (ordinal = 1 AND from_revision_seq IS NULL AND from_wikidot_revision_id IS NULL)
    OR
    (ordinal > 1 AND from_revision_seq IS NOT NULL AND from_wikidot_revision_id IS NOT NULL)
  ),
  CONSTRAINT rsbj_strategy_ck CHECK (strategy = 'page-source-v1'),
  CONSTRAINT rsbj_sha_ck CHECK (source_sha IS NULL OR octet_length(source_sha) = 32),
  CONSTRAINT rsbj_bytes_ck CHECK (
    (source_bytes IS NULL OR source_bytes >= 0)
    AND (response_bytes IS NULL OR response_bytes >= 0)
  )
);

-- 对旧版 0027 原位补列。
ALTER TABLE meta.revision_source_backfill_job
  ADD COLUMN IF NOT EXISTS strategy text NOT NULL DEFAULT 'page-source-v1',
  ADD COLUMN IF NOT EXISTS source_sha bytea REFERENCES ingest.content_blob(sha256),
  ADD COLUMN IF NOT EXISTS source_bytes int,
  ADD COLUMN IF NOT EXISTS response_bytes int,
  ADD COLUMN IF NOT EXISTS blob_inserted boolean,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE meta.revision_source_backfill_job
  DROP CONSTRAINT IF EXISTS rsbj_strategy_ck;
ALTER TABLE meta.revision_source_backfill_job
  ADD CONSTRAINT rsbj_strategy_ck CHECK (strategy = 'page-source-v1');
ALTER TABLE meta.revision_source_backfill_job
  DROP CONSTRAINT IF EXISTS rsbj_sha_ck;
ALTER TABLE meta.revision_source_backfill_job
  ADD CONSTRAINT rsbj_sha_ck CHECK (source_sha IS NULL OR octet_length(source_sha) = 32);
ALTER TABLE meta.revision_source_backfill_job
  DROP CONSTRAINT IF EXISTS rsbj_bytes_ck;
ALTER TABLE meta.revision_source_backfill_job
  ADD CONSTRAINT rsbj_bytes_ck CHECK (
    (source_bytes IS NULL OR source_bytes >= 0)
    AND (response_bytes IS NULL OR response_bytes >= 0)
  );

CREATE INDEX IF NOT EXISTS rsbj_claim
  ON meta.revision_source_backfill_job(not_before, page_id, ordinal)
  WHERE status IN ('pending','retry');
CREATE INDEX IF NOT EXISTS rsbj_page
  ON meta.revision_source_backfill_job(page_id, ordinal);
CREATE INDEX IF NOT EXISTS rsbj_completed
  ON meta.revision_source_backfill_job(completed_at)
  WHERE status = 'done';

-- 若旧 diff worker 已经写过 job，切换策略时按 revision.source_sha 重新判定是否完成。
-- 旧 delta 不是全文落库完成证据；失败次数也不能跨策略继承。
UPDATE meta.revision_source_backfill_job j
   SET strategy = 'page-source-v1',
       is_anchor = true,
       status = CASE WHEN r.source_sha IS NULL THEN 'pending' ELSE 'done' END,
       attempts = 0,
       consecutive_failures = 0,
       not_before = now(),
       locked_by = NULL,
       locked_at = NULL,
       last_error = NULL,
       source_sha = r.source_sha,
       source_bytes = CASE WHEN r.source_sha IS NULL THEN NULL ELSE cb.byte_len END,
       response_bytes = NULL,
       blob_inserted = CASE WHEN r.source_sha IS NULL THEN NULL ELSE false END,
       completed_at = CASE WHEN r.source_sha IS NULL THEN NULL ELSE now() END,
       updated_at = now()
  FROM ingest.revision r
  LEFT JOIN ingest.content_blob cb ON cb.sha256 = r.source_sha
 WHERE r.seq = j.revision_seq
   AND (
     j.strategy IS DISTINCT FROM 'page-source-v1'
     OR j.source_sha IS DISTINCT FROM r.source_sha
     OR (j.status = 'done') IS DISTINCT FROM (r.source_sha IS NOT NULL)
   );

CREATE TABLE IF NOT EXISTS meta.revision_source_pilot (
  parser_version   text PRIMARY KEY,
  run_id           bigint REFERENCES meta.ingest_run(id) ON DELETE SET NULL,
  sample_count     int NOT NULL,
  exact_matches    int NOT NULL,
  failed_count     int NOT NULL,
  passed           boolean NOT NULL,
  anchor_interval  int NOT NULL,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rsp_pass_ck CHECK (
    NOT passed OR (sample_count >= 1000 AND exact_matches = sample_count AND failed_count = 0)
  )
);

COMMENT ON TABLE meta.revision_source_backfill_job IS
  '存活页源码修订全文低优先队列。每条 job 独立抓 history/PageSourceModule；失败逐条退避，'
  '三次后进 irreconcilable；页面不再 live 时转 skipped_deleted。';
COMMENT ON COLUMN meta.revision_source_backfill_job.blob_inserted IS
  '本次 apply 是否新插入 content_blob；false 表示 sha 已存在并发生内容寻址去重。';
COMMENT ON TABLE meta.revision_source_pilot IS
  '长跑硬门禁。page-source-v1 必须先有 1000 个修订完成抓取、sha256 入库、source_sha'
  '回填及 content_blob 逐字节回读；抽到的当前版本另与 ViewSourceModule 逐字节交叉验证。';

-- page_scan 是失败证据出口，单独 kind 避免与当前正文 content 扫描互相覆盖。
ALTER TABLE meta.page_scan DROP CONSTRAINT IF EXISTS page_scan_kind_ck;
ALTER TABLE meta.page_scan ADD CONSTRAINT page_scan_kind_ck
  CHECK (kind IN ('meta','votes','revisions','content','attributions','forum',
                  'discussion','files','revision_source'));

-- 新策略必须使用独立 population_type，不能借 diff/hybrid、targeted_queue 或 L0/L1 的历史。
UPDATE meta.parse_health_baseline
   SET enabled = false
 WHERE source = 'wikidot_tier2'
   AND mode = 'revision_source_backfill'
   AND population_type = 'revision_source_hybrid';

INSERT INTO meta.parse_health_baseline
  (source, mode, population_type, metric, window_days, lower_bound, upper_bound,
   min_history_windows, max_rel_deviation, direction, action, enabled)
VALUES
  ('wikidot_tier2','revision_source_backfill','revision_source_full',
   'http_status_dist',7,NULL,0.10,3,NULL,'up','freeze_write',true),
  ('wikidot_tier2','revision_source_backfill','revision_source_full',
   'transport_failure_rate',7,NULL,0.10,3,NULL,'up','freeze_write',true),
  ('wikidot_tier2','revision_source_backfill','revision_source_full',
   'parse_drop_rate',7,NULL,0.005,3,NULL,'up','freeze_write',true)
ON CONFLICT (source, mode, population_type, metric) DO UPDATE
  SET enabled = EXCLUDED.enabled;

-- diff 写入口退役；旧 append-only delta 表（若存在）不删。
DROP FUNCTION IF EXISTS ingest.apply_revision_source_delta(
  bigint,int,bigint,bigint,bigint,int,int,text,jsonb,bytea,bytea,text,text[],text[],
  timestamptz,timestamptz,boolean,bytea,int,timestamptz
);

-- 唯一全文写入口：live 守卫、revision 身份守卫、sha 复算、content_blob 幂等插入，
-- 最后在受控 GUC 窗口内把 revision.source_sha 从 NULL 单向补值。
CREATE OR REPLACE FUNCTION ingest.apply_revision_source_full(
  p_revision_seq       bigint,
  p_page               int,
  p_wikidot_revision_id bigint,
  p_source             text,
  p_source_sha         bytea,
  p_response_sha       bytea DEFAULT NULL,
  p_response_bytes     int DEFAULT NULL,
  p_observed           timestamptz DEFAULT now()
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $function$
DECLARE
  v_guc_prev text;
  v_blob_inserted int := 0;
  v_source_bytes int;
BEGIN
  IF p_source IS NULL THEN
    RAISE EXCEPTION 'apply_revision_source_full: source 不能为 NULL（空串是合法空源码）'
      USING ERRCODE = '22004';
  END IF;
  IF p_source_sha IS NULL OR octet_length(p_source_sha) <> 32
     OR (p_response_sha IS NOT NULL AND octet_length(p_response_sha) <> 32) THEN
    RAISE EXCEPTION 'apply_revision_source_full: sha 必须是 32 字节'
      USING ERRCODE = '22023';
  END IF;
  IF sha256(convert_to(p_source, 'UTF8')) <> p_source_sha THEN
    RAISE EXCEPTION 'apply_revision_source_full: source 的 UTF-8 sha256 与入参不一致'
      USING ERRCODE = '22000';
  END IF;
  IF p_response_bytes IS NOT NULL AND p_response_bytes < 0 THEN
    RAISE EXCEPTION 'apply_revision_source_full: response_bytes 不能为负'
      USING ERRCODE = '22023';
  END IF;

  PERFORM meta.assert_writes_allowed('revision');
  PERFORM meta.assert_writes_allowed('content');
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  IF NOT EXISTS (
    SELECT 1
      FROM ingest.revision r
     WHERE r.seq = p_revision_seq
       AND r.page_id = p_page
       AND r.wikidot_revision_id = p_wikidot_revision_id
  ) THEN
    RAISE EXCEPTION
      'apply_revision_source_full: revision/page/wid 不一致 seq=% page=% wid=%',
      p_revision_seq, p_page, p_wikidot_revision_id
      USING ERRCODE = '23503';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM serve.page_current pc
     WHERE pc.page_id = p_page AND pc.status = 'live'
  ) THEN
    RAISE EXCEPTION 'apply_revision_source_full: page=% 已非 live，禁止保存已删页修订源码',
      p_page USING ERRCODE = 'PGRSD';
  END IF;
  IF EXISTS (
    SELECT 1 FROM ingest.revision r
     WHERE r.seq = p_revision_seq
       AND r.source_sha IS NOT NULL
       AND r.source_sha <> p_source_sha
  ) THEN
    RAISE EXCEPTION 'apply_revision_source_full: revision.source_sha 已指向其它内容'
      USING ERRCODE = '23505';
  END IF;

  v_source_bytes := octet_length(convert_to(p_source, 'UTF8'));
  INSERT INTO ingest.content_blob(
    sha256, source, text_content, byte_len, text_len, created_at
  )
  VALUES (p_source_sha, p_source, NULL, v_source_bytes, 0, now())
  ON CONFLICT (sha256) DO NOTHING;
  GET DIAGNOSTICS v_blob_inserted = ROW_COUNT;

  -- SHA 碰撞、错误摘要口径或历史脏 blob 都不能被 “ON CONFLICT” 掩盖。
  IF NOT EXISTS (
    SELECT 1 FROM ingest.content_blob b
     WHERE b.sha256 = p_source_sha
       AND b.source IS NOT DISTINCT FROM p_source
       AND b.byte_len = v_source_bytes
  ) THEN
    RAISE EXCEPTION 'apply_revision_source_full: 已有 content_blob 与全文/字节数不一致'
      USING ERRCODE = '23505';
  END IF;

  v_guc_prev := current_setting('scpper.revision_backfill', true);
  PERFORM set_config('scpper.revision_backfill', 'on', true);
  UPDATE ingest.revision
     SET source_sha = p_source_sha
   WHERE seq = p_revision_seq AND source_sha IS NULL;
  PERFORM set_config('scpper.revision_backfill', COALESCE(v_guc_prev, 'off'), true);

  RETURN jsonb_build_object(
    'revision_seq', p_revision_seq,
    'source_sha', encode(p_source_sha, 'hex'),
    'source_bytes', v_source_bytes,
    'response_sha', CASE WHEN p_response_sha IS NULL
                         THEN NULL ELSE encode(p_response_sha, 'hex') END,
    'response_bytes', p_response_bytes,
    'blob_inserted', v_blob_inserted = 1
  );
END;
$function$;

COMMENT ON FUNCTION ingest.apply_revision_source_full(
  bigint,int,bigint,text,bytea,bytea,int,timestamptz
) IS
  'PageSource 全文的幂等唯一写入口：只接收 live 页，sha256 内容寻址去重，并单向补'
  'revision.source_sha；冲突内容和已删页均拒绝。';

REVOKE ALL ON meta.revision_source_backfill_job FROM PUBLIC;
REVOKE ALL ON meta.revision_source_pilot FROM PUBLIC;
REVOKE ALL ON FUNCTION ingest.apply_revision_source_full(
  bigint,int,bigint,text,bytea,bytea,int,timestamptz
) FROM PUBLIC;

DO $grants$
BEGIN
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON meta.revision_source_backfill_job, meta.revision_source_pilot, meta.backfill_progress
      TO ingestor_role;
    GRANT EXECUTE ON FUNCTION ingest.apply_revision_source_full(
      bigint,int,bigint,text,bytea,bytea,int,timestamptz
    ) TO ingestor_role;
  END IF;
  IF to_regrole('migration_role') IS NOT NULL THEN
    GRANT ALL ON meta.revision_source_backfill_job, meta.revision_source_pilot
      TO migration_role;
    GRANT EXECUTE ON FUNCTION ingest.apply_revision_source_full(
      bigint,int,bigint,text,bytea,bytea,int,timestamptz
    ) TO migration_role;
  END IF;
END
$grants$;

COMMIT;
