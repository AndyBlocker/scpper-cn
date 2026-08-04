-- =====================================================================================
-- 0009_serve_modeling_decisions.sql —— 两处需要产品决策的建模缺口(README TODO #5)
-- =====================================================================================
-- 目标库: scpper-v2
--
--   缺口 ①  serve.page_reference 的主键要求 to_page_id NOT NULL ⇒ **红链无处安放**
--            (0002 的列注释原文:「未解析到 page 的红链不入本表(见迁移待办)」)。
--   缺口 ②  serve.trending_stats.entity_id NOT NULL(int)⇒ **标签维度趋势无法落库**
--            (标签的身份是字符串,不是 int id;v1 的 trending 有 tag 维度)。
--
-- ⚠ 本文件承载的是**可撤销的产品决策**,不是技术必然。单独成文件就是为了让它可整体回退:
--   文件末尾附了逐条 rollback SQL(v2 目前是空库,回退代价 = 执行那几条 ALTER)。
--   两处都选择了「加一列文本自然键 + 放宽 int id 为可空 + 换主键」这条形状,
--   代价是每张表多一列、主键变宽;换来的是两类数据从「无处安放」变成「一等公民」。
--
-- 依赖:0002_serve.sql。与 0007 无先后关系(此处按编号排在其后)。
-- 可重复执行:ADD COLUMN IF NOT EXISTS / 主键按定义比对后再换 / DROP CONSTRAINT IF EXISTS。
-- =====================================================================================

BEGIN;

DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn') THEN
    RAISE EXCEPTION 'refusing to apply 0009 to the v1 production database %', current_database();
  END IF;
  IF to_regclass('serve.page_reference') IS NULL OR to_regclass('serve.trending_stats') IS NULL THEN
    RAISE EXCEPTION '0009 需要先执行 0002_serve.sql';
  END IF;
END $$;


-- =====================================================================================
-- ① serve.page_reference —— 红链(指向不存在页面的链接)
-- =====================================================================================
-- 【方案 A(未采纳)】红链另建一张 serve.page_redlink(from_page_id, target_slug, kind, …)。
--   + 现有表形状零改动,to_page_id 保持 NOT NULL,语义上「已解析」与「未解析」物理分家。
--   − 三个真实代价:
--     (a) 红链变蓝(目标页被创建)与蓝链变红(目标页被删)是本站**高频**事件
--         —— SCP 分部大量「先写引用后建页」。每次都要跨表搬行,搬迁期的
--         「两张表都有/都没有」是新的一致性缺口,而且搬迁不是幂等的。
--     (b) 「谁引用了这一页」与「哪些引用还没落地」是同一个业务问题(反链面板),
--         分两表 ⇒ 读侧每处都要 UNION ALL,重建脚本也要写两套。
--     (c) 图指标(serve.page_reference_graph_snapshot 的 rebuild_from)会漏掉红链,
--         而「红链密度」恰恰是分部内容健康度指标之一。
--
-- 【方案 B(采纳)】红链与蓝链同表:新增 target_slug NOT NULL,to_page_id 放宽为可空,
--   主键换成 (from_page_id, target_slug, kind)。
--   + 唯一性保住了(同一页对同一目标同一 kind 只有一行),且主键**不再随解析结果变化**:
--     红链变蓝只是把同一行的 to_page_id 从 NULL 填上,零搬迁、天然幂等。
--   + 红链 = `WHERE to_page_id IS NULL`,一个部分索引就够。
--   − 代价:多一列;需要一个稳定的 slug 归一化口径(见 serve.normalize_target_slug);
--     并且旧主键隐含的「按 to_page_id 聚簇查反链」要靠 pr_to 索引而不是主键前缀。
--
-- 与设计文档的偏离说明:文档 §4.5 的 page_reference 原文是 (from,to,kind) 主键。
--   本文件按 0002 列注释里已经写明的「(见迁移待办)」把它补完 —— 不是推翻文档,
--   而是关闭文档留下的空缺;偏离点只有「主键第二列换成 target_slug」这一处。
-- =====================================================================================

-- 归一化口径必须只有一处。v1 「5 种当前版本写法」的病根就是同一语义散落多处实现。
CREATE OR REPLACE FUNCTION serve.normalize_target_slug(p_path text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
  -- 归一化:去协议+主机 → 去首尾斜杠 → 砍掉 #fragment 与 ?query → 小写。
  -- wikidot 的 slug 本身是小写、不带前导斜杠的 'category:name' 形态。
  SELECT NULLIF(lower(btrim(
           regexp_replace(
             regexp_replace(
               regexp_replace(COALESCE(p_path, ''), '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]+', ''),
               '[#?].*$', ''),
             '^/+|/+$', '', 'g')
         )), '');
$$;

COMMENT ON FUNCTION serve.normalize_target_slug(text) IS
  'page_reference.target_slug 的唯一归一化口径:去协议主机 → 去首尾斜杠 → 砍 #fragment/?query → 小写。'
  'IMMUTABLE,可用于表达式索引。projector 与回填脚本必须都调它,不许各写一份正则。';

-- ---- 1. 新列 target_slug ------------------------------------------------------------
ALTER TABLE serve.page_reference ADD COLUMN IF NOT EXISTS target_slug text;

-- 回填(v2 空库时是 0 行;写出来是为了本文件在有数据的库上也能用)
UPDATE serve.page_reference
   SET target_slug = COALESCE(serve.normalize_target_slug(target_path),
                              serve.normalize_target_slug(target_fragment),
                              'unresolved:' || to_page_id::text)
 WHERE target_slug IS NULL;

ALTER TABLE serve.page_reference ALTER COLUMN target_slug SET NOT NULL;

ALTER TABLE serve.page_reference DROP CONSTRAINT IF EXISTS page_reference_target_slug_ck;
ALTER TABLE serve.page_reference ADD  CONSTRAINT page_reference_target_slug_ck
  CHECK (target_slug <> '' AND target_slug = lower(target_slug));

-- ---- 2. 主键切换 (from_page_id, target_slug, kind) ------------------------------------
-- ⚠ 顺序:必须先换主键、再放宽 to_page_id 的 NOT NULL。反过来会撞
--   `ERROR: column "to_page_id" is in a primary key` —— PK 隐含 NOT NULL,只要它还在主键里
--   就 DROP NOT NULL 不掉(本文件初版实测到这一条)。
DO $$
DECLARE v_name text; v_def text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO v_name, v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'serve.page_reference'::regclass AND c.contype = 'p';

  IF v_name IS NOT NULL AND v_def <> 'PRIMARY KEY (from_page_id, target_slug, kind)' THEN
    EXECUTE format('ALTER TABLE serve.page_reference DROP CONSTRAINT %I', v_name);
    v_name := NULL;
  END IF;

  IF v_name IS NULL THEN
    ALTER TABLE serve.page_reference
      ADD CONSTRAINT page_reference_pkey PRIMARY KEY (from_page_id, target_slug, kind);
    RAISE NOTICE '[0009] serve.page_reference 主键已切换为 (from_page_id, target_slug, kind)';
  END IF;
END $$;

-- ---- 3. to_page_id 放宽为可空(必须在主键切换之后)-----------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = 'serve.page_reference'::regclass
                AND a.attname = 'to_page_id' AND a.attnotnull) THEN
    ALTER TABLE serve.page_reference ALTER COLUMN to_page_id DROP NOT NULL;
  END IF;
END $$;

-- ---- 4. 红链索引 + 注释更新 ----------------------------------------------------------
CREATE INDEX IF NOT EXISTS pr_redlink ON serve.page_reference (target_slug)
  WHERE to_page_id IS NULL;

-- COMMENT ON TABLE 刻意不重写:它就是 meta.projection_cursor.rebuild_from 的来源,
-- 在这里复述一遍等于给「逐字一致」开一个手抄的漂移口子(0007 §3 的全部意义就是消掉手抄)。
COMMENT ON COLUMN serve.page_reference.target_slug IS
  '归一化目标 slug(serve.normalize_target_slug 的输出),**主键第二列**。0009 决策:红链与蓝链同表,'
  '主键不随解析结果变化 ⇒ 红链变蓝只是把同一行的 to_page_id 从 NULL 填上,零搬迁、天然幂等。';
COMMENT ON COLUMN serve.page_reference.to_page_id IS
  '解析到的目标 page_id;**NULL = 红链**(目标页当前不存在/已删/尚未创建)。'
  '0009 前本列 NOT NULL 且进主键,红链因此无处安放。红链查询:WHERE to_page_id IS NULL(部分索引 pr_redlink)。';
COMMENT ON COLUMN serve.page_reference.target_path IS
  '首次见到的原始路径(未归一化,保留大小写/fragment 以便追溯)。同一 (from,target_slug,kind) 若有多条'
  '不同原始路径(重定向/别名),occurrence 累加、target_path 取首个。';


-- =====================================================================================
-- ② serve.trending_stats —— 标签维度趋势
-- =====================================================================================
-- 【方案 A(未采纳)】给标签铸 int 代理键(新建 serve.tag_dim(tag_id serial, tag text unique)),
--   entity_id 保持 NOT NULL int。
--   + trending_stats 形状零改动;所有维度统一 int,主键最窄。
--   − 代价:凭空多一个身份体系。标签在本系统里**没有身份**——它是 page_current.tags 里的
--     一个字符串元素,增删改随时发生、没有稳定 id 的来源。铸代理键就要维护
--     「标签改名/合并」的映射与孤儿回收,而这些在 wikidot 侧完全没有事件通知。
--     serve.tag_records / serve.user_tag_preference / serve.tag_validation_cache 三张现有表
--     都是**直接以 tag 文本为键**的,单给 trending 引一套 int 身份会造成同一维度两种键。
--
-- 【方案 B(采纳)】entity_key text NOT NULL 作为统一自然键,entity_id 放宽为可空(仅 int 型
--   实体填,保留给读侧做 JOIN),主键换成 (entity_type, entity_key, period)。
--   + 标签维度直接 entity_type='tag' + entity_key='原创';page/user 维度
--     entity_key = entity_id::text,由 CHECK 强制两列一致 ⇒ 同一实体不可能出现两行。
--   + 与 tag_records / user_tag_preference / tag_validation_cache 的「以 tag 文本为键」一致。
--   − 代价:多一列;int 实体的键被存了两遍(用 CHECK 消除不一致的可能);
--     主键从 (text,int,text) 变 (text,text,text),索引略宽。
--
-- 与设计文档的偏离:文档 §4.5 的 trending_stats 是 (entity_type, entity_id, period)。
--   0002 的列注释已经把 v1 的 (stat_type, entity_type) 折叠进 entity_type 命名空间,
--   本文件继续同一思路把「实体标识」也文本化,理由是标签维度在文档里根本没被建模到。
-- =====================================================================================

ALTER TABLE serve.trending_stats ADD COLUMN IF NOT EXISTS entity_key text;

UPDATE serve.trending_stats SET entity_key = entity_id::text WHERE entity_key IS NULL;

ALTER TABLE serve.trending_stats ALTER COLUMN entity_key SET NOT NULL;

ALTER TABLE serve.trending_stats DROP CONSTRAINT IF EXISTS trending_stats_entity_key_ck;
ALTER TABLE serve.trending_stats ADD  CONSTRAINT trending_stats_entity_key_ck
  -- 双列一致性:int 实体的 entity_key 必须逐字等于 entity_id::text。
  -- 没有这条,同一个 page 可以同时以 entity_key='123' 与 '0123' 存两行,
  -- 「趋势榜里同一页出现两次」就成了可构造的状态。
  CHECK (entity_key <> '' AND (entity_id IS NULL OR entity_key = entity_id::text));

DO $$
DECLARE v_name text; v_def text;
BEGIN
  SELECT c.conname, pg_get_constraintdef(c.oid) INTO v_name, v_def
    FROM pg_constraint c
   WHERE c.conrelid = 'serve.trending_stats'::regclass AND c.contype = 'p';

  IF v_name IS NOT NULL AND v_def <> 'PRIMARY KEY (entity_type, entity_key, period)' THEN
    EXECUTE format('ALTER TABLE serve.trending_stats DROP CONSTRAINT %I', v_name);
    v_name := NULL;
  END IF;

  IF v_name IS NULL THEN
    ALTER TABLE serve.trending_stats
      ADD CONSTRAINT trending_stats_pkey PRIMARY KEY (entity_type, entity_key, period);
    RAISE NOTICE '[0009] serve.trending_stats 主键已切换为 (entity_type, entity_key, period)';
  END IF;
END $$;

-- entity_id 放宽为可空 —— 同上,必须在主键切换之后(PK 隐含 NOT NULL)。
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute a
              WHERE a.attrelid = 'serve.trending_stats'::regclass
                AND a.attname = 'entity_id' AND a.attnotnull) THEN
    ALTER TABLE serve.trending_stats ALTER COLUMN entity_id DROP NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS ts_entity_id ON serve.trending_stats (entity_type, entity_id)
  WHERE entity_id IS NOT NULL;

-- COMMENT ON TABLE 同样刻意不重写(见上)。
COMMENT ON COLUMN serve.trending_stats.entity_key IS
  '实体自然键(**主键第二列**)。page/user 维度 = entity_id::text(CHECK 强制一致);'
  'tag 维度 = 标签文本本身(entity_type=''tag'',entity_id 为 NULL)。'
  '0009 决策:标签在本系统里没有身份(只是 page_current.tags 的字符串元素),'
  '为它铸 int 代理键会引入无法维护的改名/合并映射,且与 tag_records / user_tag_preference /'
  ' tag_validation_cache 三表「以 tag 文本为键」的既有口径打架。';
COMMENT ON COLUMN serve.trending_stats.entity_id IS
  'int 型实体(page/user)的 id;**tag 等文本型实体为 NULL**。0009 前本列 NOT NULL 且进主键,'
  '标签维度趋势因此无法落库。读侧 JOIN 走本列(部分索引 ts_entity_id),唯一性走 entity_key。';


COMMIT;

-- =====================================================================================
-- 回退(本文件承载的是可撤销的产品决策;v2 空库上执行以下语句即回到 0002 的形状)
-- -------------------------------------------------------------------------------------
-- BEGIN;
--   ALTER TABLE serve.page_reference DROP CONSTRAINT page_reference_pkey;
--   DELETE FROM serve.page_reference WHERE to_page_id IS NULL;   -- 红链无处安放,只能丢
--   ALTER TABLE serve.page_reference ALTER COLUMN to_page_id SET NOT NULL;
--   ALTER TABLE serve.page_reference ADD CONSTRAINT page_reference_pkey
--     PRIMARY KEY (from_page_id, to_page_id, kind);
--   DROP INDEX serve.pr_redlink;
--   ALTER TABLE serve.page_reference DROP CONSTRAINT page_reference_target_slug_ck;
--   ALTER TABLE serve.page_reference DROP COLUMN target_slug;
--   DROP FUNCTION serve.normalize_target_slug(text);
--
--   ALTER TABLE serve.trending_stats DROP CONSTRAINT trending_stats_pkey;
--   DELETE FROM serve.trending_stats WHERE entity_id IS NULL;    -- 标签维度只能丢
--   ALTER TABLE serve.trending_stats ALTER COLUMN entity_id SET NOT NULL;
--   ALTER TABLE serve.trending_stats ADD CONSTRAINT trending_stats_pkey
--     PRIMARY KEY (entity_type, entity_id, period);
--   DROP INDEX serve.ts_entity_id;
--   ALTER TABLE serve.trending_stats DROP CONSTRAINT trending_stats_entity_key_ck;
--   ALTER TABLE serve.trending_stats DROP COLUMN entity_key;
-- COMMIT;
-- 注意:回退会**丢数据**(红链行、标签维度行),这正是「缺口」的具体含义。
-- =====================================================================================
