\set ON_ERROR_STOP on

DO $check$
DECLARE
  v_bad int;
BEGIN
  IF to_regclass('meta.revision_source_backfill_job') IS NULL
     OR to_regclass('meta.revision_source_pilot') IS NULL
     OR to_regprocedure(
       'ingest.apply_revision_source_full(bigint,integer,bigint,text,bytea,bytea,integer,timestamptz)'
     ) IS NULL THEN
    RAISE EXCEPTION 'revision full-source objects are incomplete';
  END IF;

  SELECT count(*) INTO v_bad
    FROM meta.revision_source_backfill_job j
   WHERE j.strategy <> 'page-source-v1'
      OR (j.source_sha IS NOT NULL AND octet_length(j.source_sha) <> 32)
      OR (j.status = 'done' AND (
            j.source_sha IS NULL
            OR j.source_bytes IS NULL
            OR j.completed_at IS NULL
            OR NOT EXISTS (
              SELECT 1
                FROM ingest.revision r
               WHERE r.seq = j.revision_seq
                 AND r.page_id = j.page_id
                 AND r.wikidot_revision_id = j.wikidot_revision_id
                 AND r.source_sha = j.source_sha
            )
          ));
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'revision source job invariant violations=%', v_bad;
  END IF;

  SELECT count(*) INTO v_bad
    FROM meta.revision_source_pilot p
   WHERE p.parser_version = 'page-source-v1'
     AND p.passed
     AND (
       p.sample_count < 1000
       OR p.exact_matches <> p.sample_count
       OR p.failed_count <> 0
       OR p.anchor_interval <> 1
       OR p.detail->>'comparison' <> 'utf8_byte_exact_after_content_blob_readback'
     );
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'invalid passed full-source pilot rows=%', v_bad;
  END IF;

  SELECT 2 - count(*) INTO v_bad
    FROM meta.parse_health_baseline b
   WHERE b.source = 'wikidot_tier2'
     AND b.mode = 'revision_source_backfill'
     AND b.population_type = 'revision_source_full'
     AND b.metric IN ('http_status_dist','transport_failure_rate')
     AND b.enabled;
  IF v_bad <> 0 THEN
    RAISE EXCEPTION 'revision full-source PH5 policies missing=%', v_bad;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM meta.parse_health_baseline b
     WHERE b.source = 'wikidot_tier2'
       AND b.mode = 'revision_source_backfill'
       AND b.population_type = 'revision_source_full'
       AND b.metric = 'parse_drop_rate'
       AND b.enabled
  ) THEN
    RAISE EXCEPTION 'revision_source_full parse_drop_rate 语义不是解析丢行，必须 evidence-only';
  END IF;

  IF has_function_privilege(
       'public',
       'ingest.apply_revision_source_full(bigint,integer,bigint,text,bytea,bytea,integer,timestamptz)',
       'EXECUTE'
     ) THEN
    RAISE EXCEPTION 'PUBLIC can execute apply_revision_source_full';
  END IF;
END
$check$;
