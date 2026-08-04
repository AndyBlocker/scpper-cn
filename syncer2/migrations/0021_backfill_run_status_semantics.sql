-- =====================================================================================
-- 0021_backfill_run_status_semantics.sql
-- 只回填能由 run 自身证据证明“没有真失败、只有 partial”的旧误分类。
-- 请求耗尽、解析/身份错误、断路器与停止条件一律不匹配这些谓词。
-- =====================================================================================

BEGIN;

DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn', 'scpper-syncer', 'scpper_user') THEN
    RAISE EXCEPTION
      'refusing to backfill run status in protected database %',
      current_database();
  END IF;
END $$;

-- 旧 T2：partial 被直接加进 batches_failed 并把 run 标成 failed。
UPDATE meta.ingest_run
   SET status = 'partial',
       batches_failed = 0,
       stats = stats || jsonb_build_object(
         'statusSemanticsBackfill', '0021:t2_partial_only',
         'legacyStatus', status,
         'legacyBatchesFailed', batches_failed
       )
 WHERE source = 'wikidot_tier2'
   AND status = 'failed'
   AND stats->>'mode' = 'tier2'
   AND COALESCE(NULLIF(stats->>'failed', '')::int, 0) = 0
   AND COALESCE(NULLIF(stats->>'partial', '')::int, 0) > 0
   AND COALESCE(NULLIF(stats->>'error', ''), '') = ''
   AND COALESCE(NULLIF(stats->>'breaker', '')::boolean, false) = false
   AND COALESCE(NULLIF(stats->>'stoppedByFailureLimit', '')::boolean, false) = false;

-- 旧全站投票重放使用不同的计数字段，但语义相同。
UPDATE meta.ingest_run
   SET status = 'partial',
       batches_failed = 0,
       stats = stats || jsonb_build_object(
         'statusSemanticsBackfill', '0021:vote_replay_partial_only',
         'legacyStatus', status,
         'legacyBatchesFailed', batches_failed
       )
 WHERE source = 'wikidot_tier2'
   AND status = 'failed'
   AND stats->>'mode' = 'tier2_replay'
   AND COALESCE(NULLIF(stats->>'failedPages', '')::int, 0) = 0
   AND COALESCE(NULLIF(stats->>'partialPages', '')::int, 0) > 0
   AND COALESCE(NULLIF(stats->>'error', ''), '') = '';

-- Tier1 已经在 stats 留下 logicalStatus=partial；旧 DB 状态却写成 failed。
UPDATE meta.ingest_run
   SET status = 'partial',
       batches_failed = 0,
       stats = stats || jsonb_build_object(
         'statusSemanticsBackfill', '0021:tier1_logical_partial',
         'legacyStatus', status,
         'legacyBatchesFailed', batches_failed
       )
 WHERE source = 'wikidot_listpages'
   AND status = 'failed'
   AND stats->>'logicalStatus' = 'partial'
   AND COALESCE(NULLIF(stats->>'error', ''), '') = ''
   AND COALESCE((stats->'persistence'->>'ok')::boolean, false);

-- L1 offset 多批不是事务快照；仅重复页且所有请求成功是 partial 证据，不是失败批。
UPDATE meta.ingest_run
   SET status = 'partial',
       batches_failed = 0,
       stats = stats || jsonb_build_object(
         'statusSemanticsBackfill', '0021:l1_pagination_drift',
         'legacyStatus', status,
         'legacyBatchesFailed', batches_failed
       )
 WHERE source = 'wikidot_listpages'
   AND status = 'failed'
   AND stats->>'layer' = 'L1'
   AND stats->>'error' ~ '^Error: ListPages L1 不完整：跨批 fullname 重复 [0-9]+$'
   AND COALESCE((stats->'httpHealth'->'business'->>'transportFailures')::int, 0) = 0
   AND COALESCE((stats->'httpHealth'->'business'->'statusBuckets'->>'200')::int, 0) =
       COALESCE((stats->'httpHealth'->'business'->>'requests')::int, -1);

-- forum 旧逻辑把 partial 隐成 ok；这不影响失败率，但补齐“run 含 partial”的可观测性。
UPDATE meta.ingest_run
   SET status = 'partial',
       stats = stats || jsonb_build_object(
         'statusSemanticsBackfill', '0021:forum_partial_only',
         'legacyStatus', status,
         'legacyBatchesFailed', batches_failed
       )
 WHERE status = 'ok'
   AND stats->>'mode' = 'forum'
   AND COALESCE(NULLIF(stats->>'failed', '')::int, 0) = 0
   AND COALESCE(NULLIF(stats->>'partial', '')::int, 0) > 0
   AND COALESCE(NULLIF(stats->>'error', ''), '') = '';

-- 对账报告本身已区分 partial；旧 ingest_run 映射不应把它降格成 failed。
UPDATE meta.ingest_run
   SET status = 'partial',
       batches_failed = 0,
       stats = stats || jsonb_build_object(
         'statusSemanticsBackfill', '0021:reconcile_partial',
         'legacyStatus', status,
         'legacyBatchesFailed', batches_failed
       )
 WHERE source = 'reconcile'
   AND status = 'failed'
   AND stats->>'status' = 'partial'
   AND COALESCE(NULLIF(stats->>'error', ''), '') = '';

COMMIT;
