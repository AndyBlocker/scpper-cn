-- =====================================================================================
-- 0008_serve_embedding.sql —— 语义检索域的四 schema 归属(README TODO #8)
-- =====================================================================================
-- 目标库: scpper-v2
--
-- 【背景】主库有 `PageEmbedding`(678 MB / 124,955 行 / BAAI-bge-m3 halfvec(1024))、
--   以及 `EmbeddingService.ts` 里提到但**生产库里根本不存在**的 `SearchIndex` / `SearchChunk`
--   (实测 `to_regclass` 皆为 NULL,已被 `backend/scripts/drop-search-tables.ts` 删掉,
--   `HybridSearchService` 全方法 return 空 —— 那条链路是死代码)。
--   设计文档 data-model-v2-redesign 全文检索不到 embedding / SearchIndex / SearchChunk,
--   四 schema 里因此没有它们的位置。本文件把这个洞补上。
--
-- 【归属判定】三张表**都是 serve 层的派生投影**,理由:
--   · 它们不是上游给的事实(ingest),不是运维元数据(meta),不是用户自有域(app);
--   · 它们 100% 由 `正文文本 + 分块参数 + 模型` 决定,丢掉可以整表重算 —— 这正是
--     设计文档 §4.5 对 Tier-2 投影的定义,所以必须声明 rebuild_from 并登记
--     meta.projection_cursor(否则 meta.projection_window() 会对未登记投影抛 23503)。
--   · `SearchIndex`/`SearchChunk` 不做一比一搬迁:前者(页级平均向量)在 v1 里就没被
--     任何读路径用过,平均向量本身也是公认的坏主意;后者的职责由 serve.text_chunk 承担。
--
-- 【与 v1 的四处结构性偏离】每处都写了理由,详见 docs/embedding-migration.md:
--   ① **内容寻址**:chunk 与向量的键是 `text_sha`(= sha256(归一化正文)),不是
--      pageVersionId。v1 的 `PageEmbedding.chunkCharStart/chunkCharEnd` 是
--      `PageVersion.textContent` 的字符偏移,而 textContent 会被同步器就地覆盖 ——
--      实测 500 页抽样里 26 页(5.3%)的偏移已经和当前文本对不上,qqbot 的
--      `semantic_search()` 按这些偏移切 snippet 会切到错位的文本。内容寻址后
--      "偏移指向的文本"由 sha 钉死,这类错位在机制上不可能。
--      副作用是真去重:同文本的已删页/重复页共享一份向量。
--   ② **chunk 存正文**:`serve.text_chunk.content` 存一份 chunk 文本。
--      实测代价:100 页真实语料 675 chunk 的 content 共 2.43 MB(均 3,601 字节/chunk,
--      含 13% 窗口重叠冗余),按全站 ~128,000 chunk 外推**原始文本约 460 MB**,
--      落库后经 TOAST/lz4 压缩预计 250–400 MB。
--      换来两件事:
--        (a) 读路径自包含 —— 不必回 join serve.page_current.search_text 再 substr,
--            也就不会因为 search_text 被覆盖而切错(v1 正是这个 bug);
--        (b) **已删页仍可检索** —— 已删页在 v2 是 tombstone,search_text 未必保留,
--            而 v1 语料里 9,528 个已删页的正文来自一次性 legacy 回填、**没有再生路径**
--            (synthesis #3)。不存 content 就等于哪天把它们从语义检索里永久删掉。
--   ③ **分块器参数变成数据**(serve.text_chunker 一行一版):v1 的窗口 1500 / 步长 1300 /
--      上限 16 块是**硬编码在一个已经不存在的脚本里**的,只能从生产库
--      chunkCharStart/chunkCharEnd 逆向出来(实测 100/100 页吻合)。参数进表之后,
--      "换分块策略"变成加一行 + 重算,而不是考古。
--   ④ **truncated 真的落库**:v1 的 `sourceTruncated` 列 124,955 行全为 false,
--      而实测 1,029 个当前页正文超过 16 块能覆盖的 21,000 字符 —— 也就是说
--      **上千页的尾部内容被静默丢弃,而标记位说没丢**。这里 truncated 由
--      chunk_total 与文本长度共同约束(见 CHECK),写错会被数据库拒绝。
--
-- 【pgvector 未装的降级】`vector` 扩展在 scpper-v2 上**未安装**且需要 superuser
--   (实测 `CREATE EXTENSION vector` → `permission denied ... Must be superuser`)。
--   与 0005_indexes_pgroonga.sql 同一套哲学:向量表单独成段、放在 DO 块里,
--   扩展缺失时**跳过该段并 RAISE WARNING**,其余(注册表 / 分块 / 页级状态 / 游标登记)
--   照常建成。补装扩展后重跑本文件即补齐,幂等。
--   TODO(DBA):在 scpper-v2 上执行(需 superuser)
--       CREATE EXTENSION IF NOT EXISTS vector;   -- 0.8.3 已在 pg_available_extensions
--     然后重跑本文件。
--
-- 【编号说明】本文件的文件名由工作流指定为 0008_serve_embedding.sql。并行任务曾另外产出一个
--   同号的 `0008_serve_modeling_decisions.sql`;**整合阶段(2026-07-27)已把它改号为
--   `0009_serve_modeling_decisions.sql`**,序号撞车已消除。两者互不依赖,先后顺序无所谓。
--
-- 依赖:0001_ingest.sql(ingest.page / ingest.content_blob)、0002_serve.sql
--       (serve.page_current)、0003_meta.sql(meta.projection_cursor)。
-- 可重复执行:全部 CREATE ... IF NOT EXISTS / ON CONFLICT DO NOTHING。
-- =====================================================================================

BEGIN;

DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn') THEN
    RAISE EXCEPTION '拒绝把 0008 应用到 v1 生产库 %', current_database();
  END IF;
  IF to_regclass('ingest.page') IS NULL
     OR to_regclass('serve.page_current') IS NULL
     OR to_regclass('meta.projection_cursor') IS NULL THEN
    RAISE EXCEPTION '0008 需要先执行 0001_ingest.sql / 0002_serve.sql / 0003_meta.sql';
  END IF;
END $$;


-- =====================================================================================
-- 1. serve.text_chunker —— 分块契约(参数即数据)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS serve.text_chunker (
  chunker      text PRIMARY KEY,          -- 稳定标识,进 text_chunk 主键
  strategy     text NOT NULL CHECK (strategy IN ('fixed-window', 'sentence-window', 'semantic')),
  window_chars int  NOT NULL CHECK (window_chars > 0),
  stride_chars int  NOT NULL CHECK (stride_chars > 0),
  max_chunks   int  NOT NULL CHECK (max_chunks > 0),
  -- 归一化器标识:同一份 HTML 经不同归一化会得到不同 text_sha,必须显式区分。
  normalizer   text NOT NULL,
  is_active    boolean NOT NULL DEFAULT false,
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  -- 步长 > 窗口意味着有文本落在所有 chunk 之外(静默丢内容),直接禁掉。
  CONSTRAINT text_chunker_stride_le_window CHECK (stride_chars <= window_chars)
);

COMMENT ON TABLE serve.text_chunker IS
  'rebuild_from=NONE(分块契约配置表,不是投影;删掉等于丢掉 text_chunk 的语义)';
COMMENT ON COLUMN serve.text_chunker.max_chunks IS
  '单份文本最多切几块。v1 是 16,配合窗口 1500/步长 1300 只覆盖前 21,000 字符 —— '
  '实测 1,029 个当前页超过该长度,尾部被静默丢弃且 sourceTruncated 仍写 false。';

INSERT INTO serve.text_chunker (chunker, strategy, window_chars, stride_chars, max_chunks, normalizer, is_active, notes)
VALUES
  -- v1 参数,逆向自生产库 PageEmbedding 的 chunkCharStart/chunkCharEnd(100 页抽样 100% 吻合)。
  -- 归一化 = trim → \n{3,}→\n\n → [ \t]{2,}→' '(同样是逆向出来的,三步全对才能对上长度)。
  ('v1-fixed-1500-1300', 'fixed-window', 1500, 1300, 16, 'v1-crom-collapse', false,
   '逆向自 v1 PageEmbedding;仅供迁移期对账与差异复现,不用于 v2 写入'),
  -- v2 首版:参数与 v1 一致(刻意如此 —— 这次只换文本来源,不换分块策略,
  -- 好让"差异全部来自文本"这件事可归因)。归一化换成我方 normalizeExtracted()。
  ('v2-fixed-1500-1300', 'fixed-window', 1500, 1300, 16, 'v2-collapse-ws-v1', true,
   'v2 首版:参数照抄 v1,只换文本来源(CROM 渲染文本 → extractTextContent(html))')
ON CONFLICT (chunker) DO NOTHING;


-- =====================================================================================
-- 2. serve.embedding_model —— 模型注册表
-- =====================================================================================
CREATE TABLE IF NOT EXISTS serve.embedding_model (
  -- 显式 smallint 而不是拿 name 当键:name 要进 chunk_embedding 的主键与 HNSW 索引,
  -- 64 字符的 text 键会把索引撑大一倍(v1 就是 `model varchar(64)` 进唯一键)。
  model_id   smallint PRIMARY KEY,
  name       text NOT NULL UNIQUE,
  dim        int  NOT NULL CHECK (dim > 0 AND dim <= 4096),
  metric     text NOT NULL DEFAULT 'cosine' CHECK (metric IN ('cosine', 'l2', 'ip')),
  normalized boolean NOT NULL DEFAULT true,   -- 向量是否已 L2 归一(cosine 下影响查询写法)
  storage    text NOT NULL DEFAULT 'halfvec' CHECK (storage IN ('halfvec', 'vector')),
  is_active  boolean NOT NULL DEFAULT false,
  endpoint   text,                            -- 生成服务(自托管 TEI 等),便于运维定位
  notes      text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- 唯一活跃模型:读路径靠 is_active 选模型,两个活跃就会静默混检两套向量空间。
CREATE UNIQUE INDEX IF NOT EXISTS em_one_active ON serve.embedding_model ((true)) WHERE is_active;

COMMENT ON TABLE serve.embedding_model IS
  'rebuild_from=NONE(模型注册表配置,不是投影;dim/metric 是读路径构造查询向量的前提)';

INSERT INTO serve.embedding_model (model_id, name, dim, metric, normalized, storage, is_active, endpoint, notes)
VALUES
  (1, 'BAAI/bge-m3', 1024, 'cosine', true, 'halfvec', true, 'http://127.0.0.1:18080/embed',
   '与 v1 PageEmbedding 同模型同维度(halfvec(1024))。自托管、无 API 计费;'
   '实测 v1 全量 124,955 chunk 用了 23h09m(92.2 chunk/min,CPU-only)。'
   '注意该端口在 2026-07-27 实测**未监听** —— qqbot 的 /sem 命令当前是坏的。')
ON CONFLICT (model_id) DO NOTHING;


-- =====================================================================================
-- 3. serve.text_chunk —— 分块投影(内容寻址)
-- =====================================================================================
-- 键是 text_sha 而不是 page_id/version:见文件头偏离 ①。
-- 刻意**不**对 ingest.content_blob 加外键:content_blob 的 sha256 是源码(wikitext)的
-- 摘要,而这里的 text_sha 是**渲染正文**的摘要,两者不是同一个键空间;而且 content_blob
-- 在按需抓取策略下长期稀疏(0001 的表注释原文:"不要假设每个 revision 都有 blob"),
-- 加外键会让"有正文但没源码"的页无法落库。
CREATE TABLE IF NOT EXISTS serve.text_chunk (
  text_sha    bytea    NOT NULL,                                   -- sha256(归一化正文 UTF-8)
  chunker     text     NOT NULL REFERENCES serve.text_chunker(chunker),
  chunk_index smallint NOT NULL CHECK (chunk_index >= 0),
  chunk_total smallint NOT NULL CHECK (chunk_total > 0),
  char_start  int      NOT NULL CHECK (char_start >= 0),
  char_end    int      NOT NULL,
  content     text     NOT NULL,                                   -- 见偏离 ②
  text_len    int      NOT NULL CHECK (text_len >= 0),             -- 整份正文长度(冗余,便于对账)
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (text_sha, chunker, chunk_index),
  CONSTRAINT tc_range CHECK (char_end > char_start),
  CONSTRAINT tc_index_lt_total CHECK (chunk_index < chunk_total),
  -- content 必须真的等于该区间长度。v1 没有任何这类约束,于是
  -- sourceCharLen 与 chunkCharEnd-chunkCharStart 常年不等(差值是一段没人记得的前缀)。
  CONSTRAINT tc_content_len CHECK (length(content) = char_end - char_start)
);

-- content 是本表 90% 以上的体积,显式用 lz4 而不是默认 pglz:
-- lz4 在 UTF-8 中文上压缩率相近但解压快数倍,而这一列**每次检索都要读**。
-- 用 DO 块包住:lz4 需要编译期 --with-lz4,缺失时只是保持 pglz,不该让整个迁移失败。
DO $$
BEGIN
  EXECUTE 'ALTER TABLE serve.text_chunk ALTER COLUMN content SET COMPRESSION lz4';
  RAISE NOTICE '[0008] serve.text_chunk.content 压缩=lz4';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE '[0008] lz4 不可用(%),content 保持默认压缩(%)', SQLERRM, current_setting('default_toast_compression');
END $$;

CREATE INDEX IF NOT EXISTS tc_chunker ON serve.text_chunk (chunker);
-- text_sha 全量扫描的唯一场景是重算,按 chunker 分区式过滤足够;不额外建索引。

COMMENT ON TABLE serve.text_chunk IS
  'rebuild_from=ingest.content_blob.text_content(或 serve.page_current.search_text)+ serve.text_chunker 参数';
COMMENT ON COLUMN serve.text_chunk.text_sha IS
  'sha256(归一化正文的 UTF-8 字节)。内容寻址:同文本只切一次,不同页面共享。'
  '这是修 v1 "偏移指向可变文本" 那个 bug 的关键(实测 5.3% 抽样页偏移已错位)。';
COMMENT ON COLUMN serve.text_chunk.content IS
  '该 chunk 的正文原文。存它是为了让读路径自包含 —— 不回 join 全文再 substring,'
  '所以全文被覆盖也切不错。代价约 +190 MB(含 13% 窗口重叠冗余)。';


-- =====================================================================================
-- 4. serve.page_semantic —— 页级语义检索状态(读路径入口 + 重算驱动)
-- =====================================================================================
CREATE TABLE IF NOT EXISTS serve.page_semantic (
  page_id       int      PRIMARY KEY REFERENCES ingest.page(id) ON DELETE CASCADE,
  text_sha      bytea    NOT NULL,
  text_len      int      NOT NULL CHECK (text_len >= 0),
  chunker       text     NOT NULL REFERENCES serve.text_chunker(chunker),
  chunk_count   smallint NOT NULL CHECK (chunk_count >= 0),
  -- 正文超出 chunker 覆盖范围(window + (max_chunks-1)*stride)时为 true。
  -- 见偏离 ④:v1 这个标记全库是 false,而实测 1,029 页真的被截断了。
  truncated     boolean  NOT NULL DEFAULT false,
  -- 提取器版本:extractTextContent 的规则改了(例如新增一条 DROP_CLASSES)
  -- 会改变 text_sha,必须能按版本圈定重算面。
  extractor     text     NOT NULL,
  extracted_at  timestamptz NOT NULL DEFAULT now(),
  -- 向量侧状态。model_id 为 NULL = 已分块但还没算向量(冷启动/重算中的正常中间态)。
  model_id      smallint REFERENCES serve.embedding_model(model_id),
  embedded_at   timestamptz,
  -- 源码 blob(若该次抓取顺带拿到了)。可空 —— content_blob 长期稀疏,仅作追溯。
  source_blob_sha bytea,
  cursor_seq    bigint,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ps_embedded_pair CHECK ((model_id IS NULL) = (embedded_at IS NULL))
);

CREATE INDEX IF NOT EXISTS ps_text_sha ON serve.page_semantic (text_sha);
CREATE INDEX IF NOT EXISTS ps_pending  ON serve.page_semantic (extracted_at) WHERE model_id IS NULL;
CREATE INDEX IF NOT EXISTS ps_truncated ON serve.page_semantic (page_id) WHERE truncated;

COMMENT ON TABLE serve.page_semantic IS
  'rebuild_from=serve.page_current.search_text + serve.text_chunker + serve.embedding_model';
COMMENT ON COLUMN serve.page_semantic.text_sha IS
  '当前正文的 sha256。与 serve.text_chunk.text_sha 相接;'
  'sha 变了就是要重算的信号 —— 这取代了 v1 完全缺位的增量机制(v1 从 2026-04 那一轮之后再没更新过)。';


-- =====================================================================================
-- 5. serve.chunk_embedding —— 向量(pgvector;扩展缺失则跳过本段)
-- =====================================================================================
DO $$
DECLARE
  has_vector boolean;
  dim        int;
BEGIN
  SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') INTO has_vector;

  IF NOT has_vector THEN
    BEGIN
      EXECUTE 'CREATE EXTENSION IF NOT EXISTS vector';
      has_vector := true;
      RAISE NOTICE '[0008] vector 扩展创建成功';
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE '[0008] vector 扩展不可用(%)', SQLERRM;
    END;
  END IF;

  IF NOT has_vector THEN
    RAISE WARNING '[0008] TODO(DBA):serve.chunk_embedding **未创建** —— 需要 superuser 执行 '
                  'CREATE EXTENSION vector; 然后重跑本文件(幂等)。'
                  '在此之前语义检索无处落向量;注册表/分块/页级状态与游标登记均已就绪。';
    RETURN;
  END IF;

  SELECT em.dim INTO dim FROM serve.embedding_model em WHERE em.model_id = 1;
  IF dim IS NULL THEN
    RAISE EXCEPTION '[0008] serve.embedding_model 缺 model_id=1,无法确定向量维度';
  END IF;

  -- 维度写死在列类型里(pgvector 的要求)。**换维度必须新建表 + 新 model_id**,
  -- 刻意不做"一张表容纳多维度"的 sqlvector 变体:那样 HNSW 索引就没法建。
  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS serve.chunk_embedding (
      text_sha    bytea    NOT NULL,
      chunker     text     NOT NULL,
      chunk_index smallint NOT NULL,
      model_id    smallint NOT NULL REFERENCES serve.embedding_model(model_id),
      embedding   halfvec(%s) NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (text_sha, chunker, chunk_index, model_id),
      FOREIGN KEY (text_sha, chunker, chunk_index)
        REFERENCES serve.text_chunk (text_sha, chunker, chunk_index) ON DELETE CASCADE
    )$f$, dim);

  -- HNSW。v1 同规模索引实测 325 MB / m=16 / ef_construction=64,沿用同参数。
  EXECUTE 'CREATE INDEX IF NOT EXISTS ce_hnsw ON serve.chunk_embedding '
          'USING hnsw (embedding halfvec_cosine_ops) WITH (m = 16, ef_construction = 64)';
  -- 按模型过滤的部分索引前提:同时只有一个活跃模型(见 em_one_active)。
  EXECUTE 'CREATE INDEX IF NOT EXISTS ce_model ON serve.chunk_embedding (model_id)';

  EXECUTE $c$COMMENT ON TABLE serve.chunk_embedding IS
    'rebuild_from=serve.text_chunk.content + serve.embedding_model(纯派生,可整表丢弃后重算)'$c$;

  RAISE NOTICE '[0008] serve.chunk_embedding 就绪(halfvec(%),HNSW m=16/ef=64)', dim;
END $$;


-- =====================================================================================
-- 6. serve.embedding_backlog —— 待重算面(视图,零状态)
-- =====================================================================================
-- 刻意做成**视图**而不是队列表:队列表会与 meta.scan_task / meta.observation_queue
-- 的所有权打架(那两张由采集侧持有,README TODO #6 还在改 kind 词表),
-- 而"该重算哪些页"是可以从当前态直接算出来的,没有必要存状态。
CREATE OR REPLACE VIEW serve.embedding_backlog AS
SELECT pc.page_id,
       pc.slug,
       length(pc.search_text)                                    AS text_len,
       ps.text_sha                                               AS indexed_text_sha,
       sha256(convert_to(pc.search_text, 'UTF8'))                AS current_text_sha,
       ps.chunker                                                AS indexed_chunker,
       ps.extractor                                              AS indexed_extractor,
       ps.model_id                                               AS indexed_model_id,
       CASE
         WHEN ps.page_id IS NULL                                       THEN 'missing'
         WHEN ps.text_sha <> sha256(convert_to(pc.search_text, 'UTF8')) THEN 'text_changed'
         WHEN ps.model_id IS NULL                                      THEN 'awaiting_embedding'
         WHEN ps.chunker  <> (SELECT tk.chunker FROM serve.text_chunker tk WHERE tk.is_active)
                                                                       THEN 'chunker_changed'
         WHEN ps.model_id <> (SELECT em.model_id FROM serve.embedding_model em WHERE em.is_active)
                                                                       THEN 'model_changed'
         ELSE 'ok'
       END                                                       AS reason
  FROM serve.page_current pc
  LEFT JOIN serve.page_semantic ps ON ps.page_id = pc.page_id
 -- 只看 live 页。**这是有意的**,不是漏了:已删页在 v2 是 tombstone、search_text 未必保留,
 -- 它们的 chunk 与向量靠 text_chunk.content 自包含地**留在索引里继续可检索**
 -- (v1 语料里 9,528 个已删页的正文来自一次性 legacy 回填,没有再生路径)。
 -- 换句话说:活着的时候算一次,删了之后冻结 —— 而不是"删了就从 backlog 消失所以永远算不上"。
 WHERE pc.status = 'live'
   AND pc.search_text IS NOT NULL
   AND length(pc.search_text) > 0;

COMMENT ON VIEW serve.embedding_backlog IS
  '语义索引待办面。reason: missing(从未索引)/ text_changed(正文变了,sha 不等)/ '
  'awaiting_embedding(已分块未算向量)/ chunker_changed / model_changed / ok。'
  '刻意是视图不是队列表:所有权不与 meta.scan_task 打架,且当前态足以算出待办。';


-- =====================================================================================
-- 7. serve.semantic_coverage() —— 覆盖率对账(替代 v1 的 check_embedding_coverage())
-- =====================================================================================
CREATE OR REPLACE FUNCTION serve.semantic_coverage()
RETURNS TABLE (metric text, value numeric)
LANGUAGE sql STABLE
AS $$
  SELECT 'live_pages_with_text', count(*)::numeric FROM serve.embedding_backlog
  UNION ALL
  SELECT 'indexed_ok',        count(*)::numeric FROM serve.embedding_backlog WHERE reason = 'ok'
  UNION ALL
  SELECT 'missing',           count(*)::numeric FROM serve.embedding_backlog WHERE reason = 'missing'
  UNION ALL
  SELECT 'text_changed',      count(*)::numeric FROM serve.embedding_backlog WHERE reason = 'text_changed'
  UNION ALL
  SELECT 'awaiting_embedding',count(*)::numeric FROM serve.embedding_backlog WHERE reason = 'awaiting_embedding'
  UNION ALL
  SELECT 'chunker_changed',   count(*)::numeric FROM serve.embedding_backlog WHERE reason = 'chunker_changed'
  UNION ALL
  SELECT 'model_changed',     count(*)::numeric FROM serve.embedding_backlog WHERE reason = 'model_changed'
  UNION ALL
  SELECT 'truncated_pages',   count(*)::numeric FROM serve.page_semantic WHERE truncated
  UNION ALL
  SELECT 'chunks_total',      count(*)::numeric FROM serve.text_chunk
  UNION ALL
  SELECT 'coverage_ratio',
         CASE WHEN (SELECT count(*) FROM serve.embedding_backlog) = 0 THEN 0::numeric
              ELSE round((SELECT count(*) FROM serve.embedding_backlog WHERE reason = 'ok')::numeric
                         / (SELECT count(*) FROM serve.embedding_backlog), 4)
         END;
$$;

COMMENT ON FUNCTION serve.semantic_coverage() IS
  '语义索引覆盖率。v1 的 check_embedding_coverage() 在生产库里根本不存在(EmbeddingService '
  '调它会报错并被 catch 吞掉),所以 v1 时代没有人知道覆盖率是多少 —— 实测当前 38,087 个'
  '当前态有文本页中 6,142 页从未有向量、4,120 个有向量的版本已经不是当前版本。';


-- =====================================================================================
-- 8. meta.projection_cursor 登记
-- =====================================================================================
-- ⚠ 与并行任务(README TODO #3 的初始登记清单)可能重叠 —— 用 ON CONFLICT DO NOTHING:
--   谁先跑谁写入,后跑的不覆盖。**这里刻意不做 DO UPDATE**:rebuild_from 一旦被两个
--   迁移互相覆盖,"注释与游标逐字一致"这条纪律就失去意义了,冲突应当由人看见并解决。
--
-- rebuild_from 不手写字面量,而是从 pg_class 注释读回来(obj_description),
-- 这样"与 COMMENT ON TABLE 逐字一致"由构造保证,不靠人肉复制 —— 正是 TODO #3
-- 想要的那条 CI 断言,把它前移成了不可能漂移。
INSERT INTO meta.projection_cursor (projection, event_domain, rebuild_from)
SELECT t.projection, t.event_domain, obj_description(to_regclass(t.projection), 'pg_class')
  FROM (VALUES
          ('serve.text_chunker',    'none'),
          ('serve.embedding_model', 'none'),
          ('serve.text_chunk',      'content'),
          ('serve.page_semantic',   'content'),
          ('serve.chunk_embedding', 'content')
       ) AS t(projection, event_domain)
 WHERE to_regclass(t.projection) IS NOT NULL          -- chunk_embedding 在无 pgvector 时不存在
   AND obj_description(to_regclass(t.projection), 'pg_class') IS NOT NULL
ON CONFLICT (projection) DO NOTHING;

DO $$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(p, ', ') INTO missing
    FROM (VALUES ('serve.text_chunker'), ('serve.embedding_model'),
                 ('serve.text_chunk'), ('serve.page_semantic'), ('serve.chunk_embedding')) v(p)
   WHERE NOT EXISTS (SELECT 1 FROM meta.projection_cursor pc WHERE pc.projection = v.p);
  IF missing IS NOT NULL THEN
    RAISE NOTICE '[0008] 未登记的投影(pgvector 缺失时 chunk_embedding 属正常):%', missing;
  END IF;
END $$;


-- =====================================================================================
-- 9. pgroonga:chunk 级全文索引(混合检索的 FTS 侧;扩展缺失则跳过)
-- =====================================================================================
-- 0005 只覆盖了 page_current / user / forum_post 三张表。chunk 级 FTS 是混合检索
-- (向量 + 关键词)真正需要的那一半 —— v1 的 hybrid_search() 函数在生产库里同样不存在。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgroonga') THEN
    RAISE NOTICE '[0008] 无 pgroonga,跳过 serve.text_chunk.content 的全文索引(补装后重跑 0008)';
    RETURN;
  END IF;
  EXECUTE 'CREATE INDEX IF NOT EXISTS tc_content_pgroonga ON serve.text_chunk USING pgroonga (content)';
  RAISE NOTICE '[0008] tc_content_pgroonga 就绪';
END $$;

COMMIT;


-- =====================================================================================
-- 回滚(v2 是空库,回退代价 = 执行以下几条)
-- =====================================================================================
--   DROP VIEW IF EXISTS serve.embedding_backlog;
--   DROP FUNCTION IF EXISTS serve.semantic_coverage();
--   DROP TABLE IF EXISTS serve.chunk_embedding;
--   DROP TABLE IF EXISTS serve.text_chunk;
--   DROP TABLE IF EXISTS serve.page_semantic;
--   DROP TABLE IF EXISTS serve.embedding_model;
--   DROP TABLE IF EXISTS serve.text_chunker;
--   DELETE FROM meta.projection_cursor WHERE projection IN
--     ('serve.text_chunker','serve.embedding_model','serve.text_chunk',
--      'serve.page_semantic','serve.chunk_embedding');
-- =====================================================================================
