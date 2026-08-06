-- 新增 meta/serve/app 表却未判断“它是不是待处理集合”时，CI 必须红灯。
\set ON_ERROR_STOP on

DO $coverage$
DECLARE v_missing text[]; v_ghost text[]; v_bad bigint;
BEGIN
  IF to_regclass('meta.pending_collection_audit_registry') IS NULL
     OR to_regclass('meta.pending_collection_sample') IS NULL
     OR to_regclass('meta.pending_collection_alert') IS NULL
     OR to_regclass('meta.pending_collection_current') IS NULL THEN
    RAISE EXCEPTION 'oldest-pending 常驻对象不完整；先跑 0039/0040';
  END IF;

  SELECT array_agg(actual.name ORDER BY actual.name) INTO v_missing
    FROM (
      SELECT table_schema || '.' || table_name AS name
        FROM information_schema.tables
       WHERE table_schema IN ('meta','serve','app') AND table_type = 'BASE TABLE'
      EXCEPT
      SELECT schema_name || '.' || relation_name
        FROM meta.pending_collection_audit_registry
    ) actual;
  IF cardinality(v_missing) > 0 THEN
    RAISE EXCEPTION '未审计是否具备 pending 语义的新表：%', v_missing;
  END IF;

  SELECT array_agg(reg.name ORDER BY reg.name) INTO v_ghost
    FROM (
      SELECT schema_name || '.' || relation_name AS name
        FROM meta.pending_collection_audit_registry
      EXCEPT
      SELECT table_schema || '.' || table_name
        FROM information_schema.tables
       WHERE table_schema IN ('meta','serve','app') AND table_type = 'BASE TABLE'
    ) reg;
  IF cardinality(v_ghost) > 0 THEN
    RAISE EXCEPTION 'pending 审计登记了不存在的表：%', v_ghost;
  END IF;

  SELECT count(*) INTO v_bad
    FROM meta.irreconcilable
   WHERE kind LIKE '%:%'
      OR (kind = 'revision_source') IS DISTINCT FROM (instance_id IS NOT NULL);
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'irreconcilable 类型/实例仍混用：% 行', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM meta.pending_collection_audit_registry
   WHERE classification = 'covered' AND cardinality(collection_families) = 0;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'covered 表没有声明 collection family：% 行', v_bad;
  END IF;
END
$coverage$;
