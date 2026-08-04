-- =====================================================================================
-- checks/embedding_smoke.sql —— 0008_serve_embedding.sql 的功能冒烟
-- =====================================================================================
-- 单独成文件而不是塞进 migrations/smoke_test.sql:那个文件正被并行任务改动,
-- 两边同时写同一文件必然冲突。执行方式:
--   psql "$SYNCER2_DATABASE_URL" --set=ON_ERROR_STOP=1 -f checks/embedding_smoke.sql
-- 全部写入在文件末 ROLLBACK,不留测试数据。
--
-- 断言编号 E1..E13。任一失败即 RAISE EXCEPTION,psql 带 ON_ERROR_STOP 会非零退出。
-- pgvector 缺失时 E10/E11 自动降级为"跳过"并打 NOTICE(不算失败)。
-- =====================================================================================

\set ON_ERROR_STOP on
\timing off
\pset footer off

BEGIN;

DO $$
DECLARE
  pass int := 0;
  skip int := 0;
  sha1 bytea;
  txt  text;
  n    int;
  ok   boolean;
  has_vector boolean;
BEGIN
  -- ── 前置:造一个页面与当前态 ────────────────────────────────────────────────
  INSERT INTO ingest.page (id, wikidot_id) VALUES (-9001, -9001);
  -- 正文:刻意做成 3,000 字符 —— 在窗口 1500/步长 1300 下应当切 2 块。
  txt := repeat('异常收容措施与项目描述。', 250);   -- 12 字符 × 250 = 3000
  sha1 := sha256(convert_to(txt, 'UTF8'));

  INSERT INTO serve.page_current (page_id, wikidot_id, slug, status, title, search_text)
  VALUES (-9001, -9001, 'zz-embedding-smoke', 'live', 'smoke', txt);

  -- ── E1 backlog 视图能看见"从未索引"的页 ───────────────────────────────────
  SELECT reason = 'missing' INTO ok FROM serve.embedding_backlog WHERE page_id = -9001;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'E1 失败:未索引页的 reason 应为 missing'; END IF;
  pass := pass + 1;

  -- ── E2 current_text_sha 由视图算出且与我们算的一致 ────────────────────────
  SELECT current_text_sha = sha1 INTO ok FROM serve.embedding_backlog WHERE page_id = -9001;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'E2 失败:视图算的 current_text_sha 与 sha256(search_text) 不等'; END IF;
  pass := pass + 1;

  -- ── E3 分块落库:2 块,边界 0-1500 / 1300-3000 ──────────────────────────────
  INSERT INTO serve.text_chunk (text_sha, chunker, chunk_index, chunk_total, char_start, char_end, content, text_len)
  VALUES
    (sha1, 'v2-fixed-1500-1300', 0, 2, 0,    1500, substr(txt, 1,    1500), 3000),
    (sha1, 'v2-fixed-1500-1300', 1, 2, 1300, 3000, substr(txt, 1301, 1700), 3000);
  SELECT count(*) INTO n FROM serve.text_chunk WHERE text_sha = sha1;
  IF n <> 2 THEN RAISE EXCEPTION 'E3 失败:期望 2 块,实际 %', n; END IF;
  pass := pass + 1;

  -- ── E4 tc_content_len 约束真的拦得住"content 与区间长度不符" ───────────────
  BEGIN
    INSERT INTO serve.text_chunk (text_sha, chunker, chunk_index, chunk_total, char_start, char_end, content, text_len)
    VALUES (sha1, 'v2-fixed-1500-1300', 2, 3, 0, 1500, 'too short', 3000);
    RAISE EXCEPTION 'E4 失败:content 长度与区间不符竟然写进去了(v1 正是这里长年不一致)';
  EXCEPTION WHEN check_violation THEN
    pass := pass + 1;
  END;

  -- ── E5 chunk_index >= chunk_total 被拒 ────────────────────────────────────
  BEGIN
    INSERT INTO serve.text_chunk (text_sha, chunker, chunk_index, chunk_total, char_start, char_end, content, text_len)
    VALUES (sha1, 'v2-fixed-1500-1300', 5, 2, 0, 10, substr(txt, 1, 10), 3000);
    RAISE EXCEPTION 'E5 失败:chunk_index >= chunk_total 竟然写进去了';
  EXCEPTION WHEN check_violation THEN
    pass := pass + 1;
  END;

  -- ── E6 未注册的 chunker 被外键拒 ──────────────────────────────────────────
  BEGIN
    INSERT INTO serve.text_chunk (text_sha, chunker, chunk_index, chunk_total, char_start, char_end, content, text_len)
    VALUES (sha1, 'no-such-chunker', 0, 1, 0, 10, substr(txt, 1, 10), 3000);
    RAISE EXCEPTION 'E6 失败:未注册 chunker 竟然写进去了';
  EXCEPTION WHEN foreign_key_violation THEN
    pass := pass + 1;
  END;

  -- ── E7 页级状态:已分块未算向量 → awaiting_embedding ───────────────────────
  INSERT INTO serve.page_semantic
    (page_id, text_sha, text_len, chunker, chunk_count, truncated, extractor)
  VALUES (-9001, sha1, 3000, 'v2-fixed-1500-1300', 2, false, 'extractText@0.1');
  SELECT reason = 'awaiting_embedding' INTO ok FROM serve.embedding_backlog WHERE page_id = -9001;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'E7 失败:已分块未算向量的 reason 应为 awaiting_embedding'; END IF;
  pass := pass + 1;

  -- ── E8 model_id 与 embedded_at 必须同时给或同时不给 ───────────────────────
  BEGIN
    UPDATE serve.page_semantic SET model_id = 1 WHERE page_id = -9001;
    RAISE EXCEPTION 'E8 失败:model_id 有值而 embedded_at 为空竟然通过了';
  EXCEPTION WHEN check_violation THEN
    pass := pass + 1;
  END;

  -- ── E9 正文变了 → text_changed(这正是 v1 完全缺位的增量信号)───────────────
  UPDATE serve.page_semantic SET model_id = 1, embedded_at = now() WHERE page_id = -9001;
  SELECT reason = 'ok' INTO ok FROM serve.embedding_backlog WHERE page_id = -9001;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'E9a 失败:齐活后 reason 应为 ok'; END IF;
  UPDATE serve.page_current SET search_text = txt || '追加一句改动。' WHERE page_id = -9001;
  SELECT reason = 'text_changed' INTO ok FROM serve.embedding_backlog WHERE page_id = -9001;
  IF ok IS NOT TRUE THEN RAISE EXCEPTION 'E9b 失败:正文变更后 reason 应为 text_changed'; END IF;
  pass := pass + 1;

  -- ── E10 / E11 向量表(pgvector 缺失时跳过)─────────────────────────────────
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') INTO has_vector;
  IF has_vector AND to_regclass('serve.chunk_embedding') IS NOT NULL THEN
    -- E10 向量能落库并被复合外键约束到已存在的 chunk
    EXECUTE format(
      'INSERT INTO serve.chunk_embedding (text_sha, chunker, chunk_index, model_id, embedding) '
      || 'VALUES ($1, %L, 0, 1, %L::halfvec)', 'v2-fixed-1500-1300',
      '[' || array_to_string(array_fill(0.1::real, ARRAY[(SELECT dim FROM serve.embedding_model WHERE model_id = 1)]), ',') || ']')
      USING sha1;
    pass := pass + 1;
    -- E11 指向不存在 chunk 的向量被拒
    BEGIN
      EXECUTE format(
        'INSERT INTO serve.chunk_embedding (text_sha, chunker, chunk_index, model_id, embedding) '
        || 'VALUES ($1, %L, 99, 1, %L::halfvec)', 'v2-fixed-1500-1300',
        '[' || array_to_string(array_fill(0.1::real, ARRAY[(SELECT dim FROM serve.embedding_model WHERE model_id = 1)]), ',') || ']')
        USING sha1;
      RAISE EXCEPTION 'E11 失败:指向不存在 chunk 的向量竟然写进去了';
    EXCEPTION WHEN foreign_key_violation THEN
      pass := pass + 1;
    END;
  ELSE
    skip := skip + 2;
    RAISE NOTICE 'E10/E11 跳过:pgvector 未安装,serve.chunk_embedding 不存在(见 0008 文件头 TODO(DBA))';
  END IF;

  -- ── E12 唯一活跃模型 / 唯一活跃分块器 ─────────────────────────────────────
  BEGIN
    INSERT INTO serve.embedding_model (model_id, name, dim, is_active)
    VALUES (-1, 'zz-smoke-model', 1024, true);
    RAISE EXCEPTION 'E12 失败:第二个 is_active 模型竟然写进去了(读路径会静默混检两套向量空间)';
  EXCEPTION WHEN unique_violation THEN
    pass := pass + 1;
  END;

  -- ── E13 向量表的键形状(不依赖 pgvector)───────────────────────────────────
  -- pgvector 装不上时 E10/E11 只能跳过,但那两条真正验的是**复合外键的形状**,
  -- 而不是 halfvec 这个类型。这里用同形状的替身表(embedding 换成 bytea)把
  -- 键形状单独验一遍 —— 唯一留给 DBA 装完扩展后再验的,只剩类型本身。
  CREATE TABLE serve.zz_ce_probe (   -- 真表而非 TEMP:临时表的约束不能引用永久表;整个文件在 ROLLBACK 里,不留痕
    text_sha    bytea    NOT NULL,
    chunker     text     NOT NULL,
    chunk_index smallint NOT NULL,
    model_id    smallint NOT NULL REFERENCES serve.embedding_model(model_id),
    embedding   bytea    NOT NULL,
    PRIMARY KEY (text_sha, chunker, chunk_index, model_id),
    FOREIGN KEY (text_sha, chunker, chunk_index)
      REFERENCES serve.text_chunk (text_sha, chunker, chunk_index) ON DELETE CASCADE
  );
  INSERT INTO serve.zz_ce_probe VALUES (sha1, 'v2-fixed-1500-1300', 0, 1, '\x00'::bytea);
  BEGIN
    INSERT INTO serve.zz_ce_probe VALUES (sha1, 'v2-fixed-1500-1300', 99, 1, '\x00'::bytea);
    RAISE EXCEPTION 'E13 失败:指向不存在 chunk 的行竟然写进去了(复合外键形状不对)';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
  -- ON DELETE CASCADE:删掉 chunk,向量应当跟着走(否则会留下指向空的孤儿向量)
  DELETE FROM serve.text_chunk WHERE text_sha = sha1 AND chunk_index = 0;
  SELECT count(*) INTO n FROM serve.zz_ce_probe;
  IF n <> 0 THEN RAISE EXCEPTION 'E13 失败:chunk 已删而向量残留 % 行', n; END IF;
  pass := pass + 1;

  -- ── 覆盖率函数可执行且键齐全 ──────────────────────────────────────────────
  SELECT count(*) INTO n FROM serve.semantic_coverage();
  IF n < 10 THEN RAISE EXCEPTION '覆盖率函数返回项数异常:%', n; END IF;

  RAISE NOTICE '=== embedding_smoke: % 条通过, % 条跳过 ===', pass, skip;
END $$;

ROLLBACK;
