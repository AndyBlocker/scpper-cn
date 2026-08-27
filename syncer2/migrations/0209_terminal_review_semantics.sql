-- =====================================================================================
-- 0209_terminal_review_semantics.sql
--
-- 三处「状态语义错位」一并修正，全部只改口径、不改数据行为：
--
-- 一、irreconcilable 巡检口径：按「复查逾期」而非「首见年龄」
--    meta.irreconcilable 是「查清了、两侧确实对不上」的显式终态，带 next_review_at
--    周期复查（work-queue 有专门的 review 车道）。巡检却按 first_seen 计年龄，
--    于是越诚实地留证据越红——26 个已归因终态项长期霸占 critical。
--    正确语义：复查按时进行 ⇒ 绿；复查逾期 ⇒ 红（那才说明 review 车道坏了）。
--
-- 二、attributions 按页应用不再记 partial（函数整体重放，仅改 record 一处）
--
-- 三、files 类的显式延后
--    用户已明确决定附件延后处理，但 177 个 files 项的 next_review_at 全部逾期、
--    永久报红。显式延后到 2026-12-01：到期未决策会重新变红提请决定，
--    而不是永远红着被学会忽略。届时恢复复查只需：
--    UPDATE meta.irreconcilable SET next_review_at = now()
--     WHERE kind='files' AND resolved_at IS NULL;
-- =====================================================================================

BEGIN;

-- 一、巡检口径
ALTER VIEW meta.pending_collection_current RENAME TO pending_collection_current_pre0209;

CREATE VIEW meta.pending_collection_current AS
  SELECT p.collection, p.family, p.pending_count, p.oldest_item_at,
         p.oldest_item_key, p.catchup, p.evidence
    FROM meta.pending_collection_current_pre0209 p
   WHERE p.family <> 'irreconcilable'

  UNION ALL

  SELECT 'irreconcilable:' || i.kind,
         'irreconcilable'::text,
         count(*)::bigint,
         min(i.next_review_at),          -- 年龄 = 复查逾期了多久
         (array_agg(i.page_id::text || ':' || COALESCE(i.instance_id::text, '-')
                    ORDER BY i.next_review_at, i.id))[1],
         false,
         jsonb_build_object(
           'semantics', 'age = review overdue; on-schedule reviews keep this green',
           'unresolved_total', (SELECT count(*) FROM meta.irreconcilable t
                                 WHERE t.kind = i.kind AND t.resolved_at IS NULL),
           'max_checks', max(i.checks)
         )
    FROM meta.irreconcilable i
   WHERE i.resolved_at IS NULL
     AND i.next_review_at <= now()
   GROUP BY i.kind
  HAVING count(*) > 0;

COMMENT ON VIEW meta.pending_collection_current IS
  '待处理集合当前态。irreconcilable 按「复查逾期」计龄：显式终态不是待处理，'
  '复查车道停摆才是。图片两类 failed 只计仍排重试者（0207）。';

-- 二、attributions 按页应用
CREATE OR REPLACE FUNCTION ingest.apply_attribution_snapshot(p_page integer, p_entries jsonb, p_is_complete boolean, p_observed timestamp with time zone, p_source text, p_run bigint DEFAULT NULL::bigint, p_wikidot_id integer DEFAULT NULL::integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
DECLARE
  v_added int := 0; v_updated int := 0; v_removed int := 0;
  v_total int; v_raw int;
BEGIN
  IF p_entries IS NULL OR jsonb_typeof(p_entries) <> 'array' THEN
    RAISE EXCEPTION 'apply_attribution_snapshot: p_entries 必须是 jsonb array' USING ERRCODE = '22023';
  END IF;

  -- 【0007 增补】R10 熔断的物理开关:被冻结的域一律 PGF01,先于任何写入与锁。
  --   冻结的是写入,不是采集 —— meta.* 的证据链(ingest_run/page_scan/scan_task/quarantine)不受影响。
  PERFORM meta.assert_writes_allowed('attribution');
  PERFORM meta.ingest_gate_open();
  PERFORM ingest.assert_page_identity(p_page, p_wikidot_id);
  PERFORM pg_advisory_xact_lock(meta.lock_class_page(), p_page);

  SELECT count(*)::int INTO v_raw FROM jsonb_array_elements(p_entries) AS e(r);

  -- ---- added ------------------------------------------------------------------------
  WITH inc AS MATERIALIZED (
    SELECT DISTINCT ON (role, actor_id) role, actor_id, ord, at_date
      FROM (
        SELECT (r ->> 'role')                       AS role,
               (r ->> 'actor_id')::int              AS actor_id,
               COALESCE(NULLIF(r ->> 'ord','')::int, 0) AS ord,
               NULLIF(r ->> 'at_date','')::date     AS at_date
          FROM jsonb_array_elements(p_entries) AS e(r)
         WHERE NULLIF(r ->> 'actor_id','') IS NOT NULL AND NULLIF(r ->> 'role','') IS NOT NULL
      ) x
     ORDER BY role, actor_id, ord
  ), add AS MATERIALIZED (
    SELECT i.* FROM inc i
     WHERE NOT EXISTS (SELECT 1 FROM serve.attribution_current ac
                        WHERE ac.page_id = p_page AND ac.role = i.role AND ac.actor_id = i.actor_id)
  ), ev AS (
    INSERT INTO ingest.attribution_event(page_id, actor_id, role, action, at_date,
                                         observed_at, source)
    SELECT p_page, a.actor_id, a.role, 'added', a.at_date, p_observed, p_source
      FROM add a ORDER BY a.role, a.actor_id
    RETURNING seq, role, actor_id
  ), ins AS (
    INSERT INTO serve.attribution_current(page_id, role, actor_id, ord, at_date, is_display, last_seq)
    SELECT p_page, a.role, a.actor_id, a.ord, a.at_date, true, e.seq
      FROM add a JOIN ev e ON e.role = a.role AND e.actor_id = a.actor_id
    ON CONFLICT (page_id, role, actor_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::int INTO v_added FROM ins;

  -- ---- updated(能捕捉原地更新,不再寄生版本轮转)----------------------------------
  WITH inc AS MATERIALIZED (
    SELECT DISTINCT ON (role, actor_id) role, actor_id, ord, at_date
      FROM (
        SELECT (r ->> 'role') AS role, (r ->> 'actor_id')::int AS actor_id,
               COALESCE(NULLIF(r ->> 'ord','')::int, 0) AS ord,
               NULLIF(r ->> 'at_date','')::date AS at_date
          FROM jsonb_array_elements(p_entries) AS e(r)
         WHERE NULLIF(r ->> 'actor_id','') IS NOT NULL AND NULLIF(r ->> 'role','') IS NOT NULL
      ) x
     ORDER BY role, actor_id, ord
  ), chg AS MATERIALIZED (
    SELECT i.role, i.actor_id, i.ord, i.at_date
      FROM inc i
      JOIN serve.attribution_current ac
        ON ac.page_id = p_page AND ac.role = i.role AND ac.actor_id = i.actor_id
     WHERE (ac.ord, ac.at_date) IS DISTINCT FROM (i.ord, i.at_date)
  ), ev AS (
    INSERT INTO ingest.attribution_event(page_id, actor_id, role, action, at_date,
                                         observed_at, source)
    SELECT p_page, c.actor_id, c.role, 'updated', c.at_date, p_observed, p_source
      FROM chg c ORDER BY c.role, c.actor_id
    RETURNING seq, role, actor_id
  ), upd AS (
    UPDATE serve.attribution_current ac
       SET ord = c.ord, at_date = c.at_date, last_seq = e.seq
      FROM chg c JOIN ev e ON e.role = c.role AND e.actor_id = c.actor_id
     WHERE ac.page_id = p_page AND ac.role = c.role AND ac.actor_id = c.actor_id
    RETURNING 1
  )
  SELECT count(*)::int INTO v_updated FROM upd;

  -- ---- removed(仅 is_complete=true)------------------------------------------------
  -- 与投票域同一条红线:不完整的观测只允许「增」。归属的 absence 同样可能来自
  -- 约定页解析失败(实测:attribution-metadata 两页是全站归属的唯一来源,
  -- 一次解析变形就会让全站归属集体「消失」)。
  IF COALESCE(p_is_complete, false) THEN
    WITH inc AS MATERIALIZED (
      SELECT (r ->> 'role') AS role, (r ->> 'actor_id')::int AS actor_id
        FROM jsonb_array_elements(p_entries) AS e(r)
       WHERE NULLIF(r ->> 'actor_id','') IS NOT NULL AND NULLIF(r ->> 'role','') IS NOT NULL
    ), gone AS MATERIALIZED (
      SELECT ac.role, ac.actor_id, ac.at_date
        FROM serve.attribution_current ac
       WHERE ac.page_id = p_page
         AND NOT EXISTS (SELECT 1 FROM inc i WHERE i.role = ac.role AND i.actor_id = ac.actor_id)
    ), ev AS (
      INSERT INTO ingest.attribution_event(page_id, actor_id, role, action, at_date,
                                           observed_at, source)
      SELECT p_page, g.actor_id, g.role, 'removed', g.at_date, p_observed, p_source
        FROM gone g ORDER BY g.role, g.actor_id
      RETURNING seq, role, actor_id
    ), del AS (
      DELETE FROM serve.attribution_current ac
       USING gone g
       WHERE ac.page_id = p_page AND ac.role = g.role AND ac.actor_id = g.actor_id
      RETURNING 1
    )
    SELECT count(*)::int INTO v_removed FROM del;
  END IF;

  -- ---- is_display 写时物化(SUBMITTER 抑制)-----------------------------------------
  -- v1 有 7+ 处 BOOL_OR / 窗口函数样板在读时重复这个判断。规则:该页存在任何
  -- 非 SUBMITTER 归属时,SUBMITTER 不参与展示/计分。
  -- 【2026-07-27 实测·P1-4】70% 的 attribution 是 SUBMITTER、41,800 个 pageVersion 只有
  -- SUBMITTER —— 所以「只有 SUBMITTER」必须保持 is_display=true,否则这些页的作者会集体消失。
  UPDATE serve.attribution_current ac
     SET is_display = NOT (upper(ac.role) = 'SUBMITTER' AND EXISTS (
           SELECT 1 FROM serve.attribution_current o
            WHERE o.page_id = p_page AND upper(o.role) <> 'SUBMITTER'))
   WHERE ac.page_id = p_page
     AND ac.is_display <> NOT (upper(ac.role) = 'SUBMITTER' AND EXISTS (
           SELECT 1 FROM serve.attribution_current o
            WHERE o.page_id = p_page AND upper(o.role) <> 'SUBMITTER'));

  SELECT count(*)::int INTO v_total FROM serve.attribution_current WHERE page_id = p_page;
  UPDATE serve.page_current
     SET attribution_count = v_total, updated_at = now()
   WHERE page_id = p_page AND attribution_count <> v_total;

  -- 按页应用在其声明范围内是全量成功的：is_complete=false 只表示「本路径是
  -- 只新增语义、removal 检测不在范围内」，不是抓取或应用失败。把它记成 partial
  -- 曾让 page_scan 每 48 小时多出 7,859 条假 partial（对照真实 ok 仅 1 条），
  -- 使「按 kind 统计失败率」对 attributions 完全失效——监控曾据此误报链路全挂。
  -- 范围限制保留在备注列，不再污染状态列。
  PERFORM meta.record_page_scan(p_run, p_page, 'attributions', 'ok',
                                NULL, v_raw, NULL, NULL, NULL, NULL,
                                CASE WHEN NOT COALESCE(p_is_complete, false)
                                     THEN '仅新增语义（is_complete=false）：removal 检测不在本路径范围' END);

  RETURN jsonb_build_object('raw', v_raw, 'added', v_added, 'updated', v_updated,
                            'removed', v_removed, 'attribution_count', v_total);
END;
$function$;

-- 三、files 显式延后（用户决定：附件延后处理）
UPDATE meta.irreconcilable
   SET next_review_at = '2026-12-01 00:00:00+08'
 WHERE kind = 'files' AND resolved_at IS NULL AND next_review_at < '2026-12-01 00:00:00+08';

COMMIT;
