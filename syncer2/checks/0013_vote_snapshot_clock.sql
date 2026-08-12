-- 任一 live 页只要存在 votes/ok 成功证据，派生时钟就必须至少到该证据。
DO $check$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM serve.page_current pc
      CROSS JOIN LATERAL (
        SELECT ps.scanned_at
          FROM meta.page_scan ps
         WHERE ps.page_id = pc.page_id
           AND ps.kind = 'votes'
           AND ps.status = 'ok'
         ORDER BY ps.scanned_at DESC
         LIMIT 1
      ) latest
     WHERE pc.status = 'live'
       AND (
         pc.last_complete_vote_snapshot_at IS NULL
         OR pc.last_complete_vote_snapshot_at < latest.scanned_at
       )
  ) THEN
    RAISE EXCEPTION '存在 votes/ok 已落库但 last_complete_vote_snapshot_at 落后的 live 页'
      USING ERRCODE = '23514';
  END IF;
END
$check$;

