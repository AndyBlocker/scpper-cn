-- 当前极值 + 最近持久判定。真正的时间序列由 schedule:oldest-pending 每 5 分钟写 meta。
\set ON_ERROR_STOP on

WITH latest AS (
  SELECT DISTINCT ON (collection)
         collection, observed_at, severity, worsening_started_at, decision
    FROM meta.pending_collection_sample
   ORDER BY collection, observed_at DESC
)
SELECT current.collection AS 集合,
       current.pending_count AS 待处理,
       round((extract(epoch FROM now() - current.oldest_item_at) / 3600)::numeric, 1)
         AS 最老小时,
       current.oldest_item_key AS 最老实例,
       current.catchup AS 追平集合,
       COALESCE(latest.severity, '尚无样本') AS 最近判定,
       latest.worsening_started_at AS 恶化起点,
       latest.decision AS 判据
  FROM meta.pending_collection_current current
  LEFT JOIN latest USING (collection)
 ORDER BY current.oldest_item_at NULLS LAST, current.collection;

-- 每个未关闭告警都必须能追到恶化起点和至少一条原始样本。
DO $evidence$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM meta.pending_collection_alert a
     WHERE a.resolved_at IS NULL
       AND (
         a.started_at IS NULL
         OR NOT EXISTS (
           SELECT 1 FROM meta.pending_collection_sample s
            WHERE s.collection = a.collection
              AND s.observed_at >= a.started_at
              AND s.severity <> 'ok'
         )
       )
  ) THEN
    RAISE EXCEPTION '存在没有时间序列/恶化起点证据的 oldest-pending 告警';
  END IF;
END
$evidence$;
