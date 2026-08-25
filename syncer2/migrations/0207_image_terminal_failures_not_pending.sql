-- =====================================================================================
-- 0207_image_terminal_failures_not_pending.sql
--
-- image_ingest_job:failed 与 serve.page_image:failed 被巡检当作「待处理集合」，
-- 按最老实例年龄判定，于是长期报 critical（实测 6,169 / 6,095 条、534 小时）。
--
-- 但实测这些行 not_before 全部为 NULL —— 它们是**确定性终态**，不是待处理：
--   invalid_image_content 3,296（wikidot 对不存在文件返回 200 + "The file does not exist" HTML）
--   invalid_content_type    799、network 544、blocked_host 163、host_unresolvable 97 …
-- 没有任何一条排着重试，也没有任何机制会再动它们。
--
-- 「永远红着的指标等于没有指标」：真正的图片链路故障发生时，这两个集合不会有
-- 任何可分辨的变化，值守早已学会忽略它们。
--
-- 因此改口径：只有**仍排着重试**（not_before IS NOT NULL）的失败才算待处理。
-- 终态失败的可观测性由失败分类计数与 health 判据承担，不再混进「最老待处理项」。
--
-- 沿用本库既有的视图分层约定（参见 _pre0073）：重命名旧层、在其上叠加修正层。
-- =====================================================================================

BEGIN;

ALTER VIEW meta.pending_collection_current RENAME TO pending_collection_current_pre0207;

CREATE VIEW meta.pending_collection_current AS
  SELECT p.collection, p.family, p.pending_count, p.oldest_item_at,
         p.oldest_item_key, p.catchup, p.evidence
    FROM meta.pending_collection_current_pre0207 p
   WHERE p.collection NOT IN ('image_ingest_job:failed', 'serve.page_image:failed')

  UNION ALL

  -- 仅统计仍排着重试的失败任务；终态失败不属于待处理语义。
  SELECT 'image_ingest_job:failed'::text,
         'image_ingest_job'::text,
         count(*)::bigint,
         min(j.created_at),
         (array_agg(j.id::text ORDER BY j.created_at, j.id))[1],
         false,
         jsonb_build_object(
           'max_attempts', max(j.attempts),
           'semantics', 'only retry-scheduled failures; terminal failures excluded'
         )
    FROM meta.image_ingest_job j
   WHERE j.status = 'failed' AND j.not_before IS NOT NULL
  HAVING count(*) > 0

  UNION ALL

  -- page_image 自身没有重试调度列，其待处理与否取决于对应 job 是否还排着重试。
  SELECT 'serve.page_image:failed'::text,
         'serve_page_image'::text,
         count(*)::bigint,
         min(COALESCE(i.last_queued_at, i.extracted_at)),
         (array_agg(i.page_id::text || ':' || i.normalized_url
                    ORDER BY COALESCE(i.last_queued_at, i.extracted_at),
                             i.page_id, i.normalized_url))[1],
         false,
         jsonb_build_object(
           'max_failure_count', max(i.failure_count),
           'semantics', 'only failures whose ingest job is still retry-scheduled'
         )
    FROM serve.page_image i
   WHERE i.status = 'failed'
     AND EXISTS (
       SELECT 1 FROM meta.image_ingest_job j
        WHERE j.page_id = i.page_id
          AND j.normalized_url = i.normalized_url
          AND j.not_before IS NOT NULL
     )
  HAVING count(*) > 0;

COMMENT ON VIEW meta.pending_collection_current IS
  '待处理集合当前态。图片两类 failed 只计仍排重试者——终态失败不是待处理，'
  '把它们计入会让集合永久报红，从而掩盖真实故障。';

COMMIT;
