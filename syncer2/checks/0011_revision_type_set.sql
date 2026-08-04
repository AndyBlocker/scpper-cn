-- revision.type 必须是单一、可查询的 text[] 物理形态；unknown 只能用 NULL 表达。
DO $check$
DECLARE
  v_udt text;
  v_constraint_valid boolean;
  v_total bigint;
  v_null bigint;
  v_json_shape bigint;
  v_unknown_literal bigint;
  v_invalid bigint;
BEGIN
  SELECT udt_name INTO v_udt
    FROM information_schema.columns
   WHERE table_schema='ingest' AND table_name='revision' AND column_name='type';
  IF v_udt IS DISTINCT FROM '_text' THEN
    RAISE EXCEPTION 'ingest.revision.type 不是 text[]，实际 udt=%', COALESCE(v_udt, '<missing>');
  END IF;

  SELECT convalidated INTO v_constraint_valid
    FROM pg_constraint
   WHERE conrelid='ingest.revision'::regclass AND conname='revision_type_set_ck';
  IF v_constraint_valid IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'revision_type_set_ck 不存在或未验证';
  END IF;

  SELECT count(*),
         count(*) FILTER (WHERE type IS NULL),
         count(*) FILTER (WHERE type::text LIKE '[%'),
         count(*) FILTER (WHERE type && ARRAY['unknown']::text[]),
         count(*) FILTER (
           WHERE type IS NOT NULL AND NOT ingest.revision_types_valid(type)
         )
    INTO v_total, v_null, v_json_shape, v_unknown_literal, v_invalid
    FROM ingest.revision;
  IF v_json_shape <> 0 OR v_unknown_literal <> 0 OR v_invalid <> 0 THEN
    RAISE EXCEPTION
      'revision.type 形态回归：json_shape=% unknown_literal=% invalid=%',
      v_json_shape, v_unknown_literal, v_invalid;
  END IF;

  RAISE NOTICE
    'revision type set PASS: rows=% null_unknown=% json_shape=% unknown_literal=% invalid=%',
    v_total, v_null, v_json_shape, v_unknown_literal, v_invalid;
END
$check$;
