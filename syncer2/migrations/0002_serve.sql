-- =====================================================================
-- 0002_serve.sql — scpper-v2  serve schema(BFF 唯一读面)
-- ---------------------------------------------------------------------
-- 依据:docs/data-model-v2-redesign-2026-07-03.md
--        §4.4 Tier-1 投影(与事实同事务;全库唯一一份当前态)
--        §4.5 Tier-2 投影(projector 异步,游标驱动,全部声明 rebuild_from)
--        §3 原则 1 / 6(可从事实重建的数据必须显式声明重建来源)
--
-- 约定:
--   1. 本文件只建表 + 建普通索引 + 建守卫触发器,不建任何扩展依赖索引。
--      pgroonga 索引(page_current.search_text / title / alternate_title)统一
--      拆到 0005_indexes_pgroonga.sql —— 本文件不 CREATE EXTENSION、不引用 pgroonga。
--   2. 本文件不含 CREATE ROLE / GRANT。当前连接用户没有 CREATEROLE、非 superuser,
--      角色与授权(bff_role / ingestor_role / projector_role / avatar_worker_role /
--      migration_role)另见需 DBA 执行的 9000_roles_grants.sql.ADMIN。
--   3. 全文件可重复执行(IF NOT EXISTS / CREATE OR REPLACE / DROP TRIGGER IF EXISTS),
--      BEGIN/COMMIT 包裹,失败整体回滚。
--   4. Tier-1 表带 ingest.* 外键(与事实同事务写入,身份必须已存在);
--      Tier-2 表按设计文档原文不挂跨 schema 外键 —— projector 会 TRUNCATE 重建,
--      外键只会制造重建期锁竞争,身份完整性由 projector 的输入查询保证。
--
-- 依赖:0001_ingest.sql(ingest schema:page / "user" / content_blob / 事实表)
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. 前置依赖断言(Tier-1 外键指向 ingest 身份层)
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('ingest.page') IS NULL
     OR to_regclass('ingest."user"') IS NULL
     OR to_regclass('ingest.content_blob') IS NULL THEN
    RAISE EXCEPTION
      '0002_serve.sql 需要先执行 0001_ingest.sql(缺 ingest.page / ingest."user" / ingest.content_blob)';
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS serve;
COMMENT ON SCHEMA serve IS
  'BFF 唯一读面。Tier-1 由 ingest.apply_* 同事务维护;Tier-2 由 projector 异步游标驱动,每表 COMMENT 必须声明 rebuild_from。';


-- =====================================================================
-- 1. 守卫基础设施
-- =====================================================================

-- 统一逃生舱:迁移窗口/DBA 手工修复时允许绕过守卫。
--   * 会话级:SET LOCAL scpper.bypass_guard = 'on';
--   * 角色级:migration_role 成员天然放行(角色不存在时该分支静默跳过)。
CREATE OR REPLACE FUNCTION serve.write_bypass_enabled()
RETURNS boolean
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_flag text;
  v_role oid;
BEGIN
  v_flag := current_setting('scpper.bypass_guard', true);
  IF v_flag IS NOT NULL AND lower(v_flag) IN ('on', 'true', '1', 'yes') THEN
    RETURN true;
  END IF;

  v_role := to_regrole('migration_role');
  IF v_role IS NOT NULL AND pg_has_role(current_user, v_role, 'MEMBER') THEN
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

COMMENT ON FUNCTION serve.write_bypass_enabled() IS
  '守卫逃生舱:SET LOCAL scpper.bypass_guard=''on'' 或 migration_role 成员身份;仅迁移窗口使用。';


-- =====================================================================
-- 2. Tier-1 投影(§4.4)—— 与事实同事务,仅 ingest.apply_* 函数维护
--    生命周期:可 TRUNCATE 后从 ingest 事实表全量重放重建
-- =====================================================================

-- 2.1 serve.vote_current ------------------------------------------------
-- 同时是 CAS 比对基准与读取点,全库只此一份当前态。
-- 撤票不删行:direction=0 表示"曾投过、当前撤票"的终态 → novotes 是 O(1) 状态读数,
-- 且已删页的撤票名单在迁移后仍可追溯。
CREATE TABLE IF NOT EXISTS serve.vote_current (
  page_id        int      NOT NULL REFERENCES ingest.page(id),
  voter_id       int      NOT NULL REFERENCES ingest."user"(id),
  direction      smallint NOT NULL CHECK (direction IN (-1, 0, 1)),  -- 0 = 撤票终态
  first_voted_at timestamptz,
  last_voted_at  timestamptz NOT NULL,
  last_precision text     NOT NULL,
  last_seq       bigint   NOT NULL,
  PRIMARY KEY (page_id, voter_id)        -- ← "数重不可能"的物理保证
);

CREATE INDEX IF NOT EXISTS vc_voter
  ON serve.vote_current (voter_id, last_voted_at DESC);
-- 高票页 votes 列表 keyset 分页
CREATE INDEX IF NOT EXISTS vc_page_time
  ON serve.vote_current (page_id, last_voted_at DESC, voter_id);

COMMENT ON TABLE serve.vote_current IS
  'Tier-1 投影。rebuild_from=''ingest.vote_event''(按 seq 全量重放)。仅 ingest.apply_vote* 同事务写入。';
COMMENT ON COLUMN serve.vote_current.direction IS
  '-1/1 = 当前有效票;0 = 撤票终态(行永不删除)。';
COMMENT ON COLUMN serve.vote_current.last_precision IS
  '最后一次转移事件的 time_precision:exact|observed|day|clamped|bootstrap。';


-- 2.2 serve.attribution_current ----------------------------------------
CREATE TABLE IF NOT EXISTS serve.attribution_current (
  page_id    int     NOT NULL REFERENCES ingest.page(id),
  role       text    NOT NULL,
  actor_id   int     NOT NULL REFERENCES ingest."user"(id),
  ord        int     NOT NULL DEFAULT 0,
  at_date    date,
  is_display boolean NOT NULL DEFAULT true,   -- SUBMITTER 抑制预解析:7 处窗口函数收编为一列
  last_seq   bigint  NOT NULL,
  PRIMARY KEY (page_id, role, actor_id)
);

CREATE INDEX IF NOT EXISTS ac_actor
  ON serve.attribution_current (actor_id) WHERE is_display;

COMMENT ON TABLE serve.attribution_current IS
  'Tier-1 投影。rebuild_from=''ingest.attribution_event''(集合 diff 重放)。仅 ingest.apply_attributions 同事务写入。';
COMMENT ON COLUMN serve.attribution_current.is_display IS
  'SUBMITTER 抑制的预解析结果:false 表示该归属不参与展示/计分。';


-- 2.3 serve.page_current ------------------------------------------------
-- 页面当前态一等实体;删除只翻 status,元数据原地保留最后已知值。
CREATE TABLE IF NOT EXISTS serve.page_current (
  page_id              int  PRIMARY KEY REFERENCES ingest.page(id),
  wikidot_id           int  NOT NULL UNIQUE,
  slug                 text NOT NULL,
  status               text NOT NULL CHECK (status IN ('live', 'deleted')),
  deleted_at           timestamptz,
  deleted_at_precision text CHECK (deleted_at_precision IN ('exact', 'inferred')),
  title                text,
  alternate_title      text,
  tags                 text[] NOT NULL DEFAULT '{}',
  category             text,
  parent_page_id       int,
  first_published_at   timestamptz,
  discussion_thread_id bigint,                 -- Page↔Thread 从页面元数据取,不再 title-as-slug 猜测
  rating               int  NOT NULL DEFAULT 0,
  vote_up              int  NOT NULL DEFAULT 0,
  vote_down            int  NOT NULL DEFAULT 0,
  vote_revoked         int  NOT NULL DEFAULT 0, -- 当前撤票态 voter 数(vote-distribution.novotes 的 O(1) 读点)
  revision_count       int  NOT NULL DEFAULT 0, -- 真实修订行数，包含从 0 开始的首条修订
  comment_count        int  NOT NULL DEFAULT 0, -- apply_page_meta 写入,论坛 projector 对账
  attribution_count    int  NOT NULL DEFAULT 0,
  source_sha           bytea REFERENCES ingest.content_blob(sha256),
  search_text          text,                    -- = V1 textContent(渲染文本);quotes/snippet 直读本列
  cursor_seq           bigint NOT NULL DEFAULT 0,
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pc_slug
  ON serve.page_current (slug text_pattern_ops);   -- urlStartsWith → slug 前缀
CREATE INDEX IF NOT EXISTS pc_status_rating
  ON serve.page_current (status, rating DESC);
CREATE INDEX IF NOT EXISTS pc_tags
  ON serve.page_current USING gin (tags);
-- pgroonga: pc_search / pc_title_search / pc_alt_search → 0005_indexes_pgroonga.sql

COMMENT ON TABLE serve.page_current IS
  'Tier-1 投影。rebuild_from=''ingest.page + page_life_event + page_attr_history + vote_current + revision''。仅 ingest.apply_* 同事务写入。by-url/by-slug 裁决:WHERE slug=$1 ORDER BY (status=''live'') DESC, deleted_at DESC NULLS LAST LIMIT 1。';
COMMENT ON COLUMN serve.page_current.slug IS
  'slug 可被两行共享(旧 deleted + 新 live);URL→slug 归一在 BFF 入口完成。';
COMMENT ON COLUMN serve.page_current.vote_revoked IS
  'vote_current 中 direction=0 的行数;vote-distribution.novotes 直读本列。';
COMMENT ON COLUMN serve.page_current.revision_count IS
  '真实修订数，即 COUNT(ingest.revision)，包含 revision 0。'
  '因此它比 Wikidot %%revisions%% / CROM revisionCount 的零基声明值恒大 offset(1)；'
  '不允许用远端声明值直接覆盖（不变式 I8）。';


-- =====================================================================
-- 3. Tier-2 投影(§4.5)—— projector 异步,游标驱动
--    每表必须声明 rebuild_from(§3 原则 6 硬要求)
-- =====================================================================

-- 3.1 serve.page_stats --------------------------------------------------
CREATE TABLE IF NOT EXISTS serve.page_stats (
  page_id     int  PRIMARY KEY,
  uv          int  NOT NULL,
  dv          int  NOT NULL,
  wilson95    real NOT NULL,
  controversy real NOT NULL,
  like_ratio  real NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ps_wilson95    ON serve.page_stats (wilson95 DESC);
CREATE INDEX IF NOT EXISTS ps_controversy ON serve.page_stats (controversy DESC);

COMMENT ON TABLE serve.page_stats IS
  'rebuild_from=serve.vote_current';


-- 3.2 serve.vote_daily --------------------------------------------------
-- 切日口径全库唯一:exact/observed 按 Asia/Shanghai;
-- day/clamped/bootstrap 精度按 (occurred_at AT TIME ZONE 'UTC')::date(该值本身就是日历日)。
CREATE TABLE IF NOT EXISTS serve.vote_daily (
  page_id    int  NOT NULL,
  day        date NOT NULL,
  up         int  NOT NULL DEFAULT 0,
  down       int  NOT NULL DEFAULT 0,
  revoked    int  NOT NULL DEFAULT 0,
  cum_rating int  NOT NULL,
  PRIMARY KEY (page_id, day)
);

CREATE INDEX IF NOT EXISTS vd_day ON serve.vote_daily (day);

COMMENT ON TABLE serve.vote_daily IS
  'rebuild_from=ingest.vote_event';
COMMENT ON COLUMN serve.vote_daily.day IS
  '切日口径:time_precision ∈ (exact,observed) 按 Asia/Shanghai;∈ (day,clamped,bootstrap) 按 (occurred_at AT TIME ZONE ''UTC'')::date。';


-- 3.3 serve.user_attr_daily ---------------------------------------------
CREATE TABLE IF NOT EXISTS serve.user_attr_daily (
  user_id      int  NOT NULL,
  day          date NOT NULL,
  up           int  NOT NULL DEFAULT 0,
  down         int  NOT NULL DEFAULT 0,
  rating_delta int  NOT NULL,
  cum_rating   int  NOT NULL,
  PRIMARY KEY (user_id, day)
);

COMMENT ON TABLE serve.user_attr_daily IS
  'rebuild_from=ingest.vote_event ⋈ serve.attribution_current';
COMMENT ON COLUMN serve.user_attr_daily.up IS
  'up/down 分解支撑 rating-history 红绿柱响应形状。';


-- 3.4 serve.user_page ---------------------------------------------------
CREATE TABLE IF NOT EXISTS serve.user_page (
  user_id              int  NOT NULL,
  page_id              int  NOT NULL,
  roles                text[] NOT NULL,
  effective_created_at timestamptz,     -- 4 层 COALESCE 链在投影时算一次
  group_key            text,
  PRIMARY KEY (user_id, page_id)
);

CREATE INDEX IF NOT EXISTS up_page ON serve.user_page (page_id);
CREATE INDEX IF NOT EXISTS up_user_created
  ON serve.user_page (user_id, effective_created_at DESC NULLS LAST);

COMMENT ON TABLE serve.user_page IS
  'rebuild_from=serve.attribution_current ⋈ ingest.revision ⋈ serve.page_current';


-- 3.5 serve.user_stats --------------------------------------------------
CREATE TABLE IF NOT EXISTS serve.user_stats (
  user_id              int PRIMARY KEY,
  total_rating         int  NOT NULL DEFAULT 0,
  overall_rating       real,
  page_count           int  NOT NULL DEFAULT 0,
  votes_cast_up        int  NOT NULL DEFAULT 0,
  votes_cast_down      int  NOT NULL DEFAULT 0,
  votes_received_up    int  NOT NULL DEFAULT 0,
  votes_received_down  int  NOT NULL DEFAULT 0,
  rating_scp           int,
  rating_translation   int,
  rating_goi           int,
  rating_story         int,
  rating_wanderers     int,
  rating_art           int,
  count_scp            int,
  count_translation    int,
  count_goi            int,
  count_story          int,
  count_wanderers      int,
  count_art            int,
  rank_total           int,
  rank_scp             int,
  rank_translation     int,
  rank_goi             int,
  rank_story           int,
  rank_wanderers       int,
  rank_art             int,
  first_activity_at    timestamptz,
  first_activity_type  text,
  first_activity_detail jsonb,
  last_activity_at     timestamptz,
  last_activity_type   text,
  last_activity_detail jsonb,
  forum_post_count     int  NOT NULL DEFAULT 0,
  computed_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS us_overall_rating ON serve.user_stats (overall_rating DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS us_rank_total     ON serve.user_stats (rank_total);
CREATE INDEX IF NOT EXISTS us_rating_scp     ON serve.user_stats (rating_scp DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS us_rank_scp       ON serve.user_stats (rank_scp);
CREATE INDEX IF NOT EXISTS us_rating_translation ON serve.user_stats (rating_translation DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS us_rank_translation   ON serve.user_stats (rank_translation);
CREATE INDEX IF NOT EXISTS us_rating_goi     ON serve.user_stats (rating_goi DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS us_rank_goi       ON serve.user_stats (rank_goi);
CREATE INDEX IF NOT EXISTS us_rating_story   ON serve.user_stats (rating_story DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS us_rank_story     ON serve.user_stats (rank_story);
CREATE INDEX IF NOT EXISTS us_rating_wanderers ON serve.user_stats (rating_wanderers DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS us_rank_wanderers   ON serve.user_stats (rank_wanderers);
CREATE INDEX IF NOT EXISTS us_rating_art     ON serve.user_stats (rating_art DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS us_rank_art       ON serve.user_stats (rank_art);

COMMENT ON TABLE serve.user_stats IS
  'rebuild_from=serve.vote_current ⋈ serve.attribution_current(is_display) ⋈ serve.user_page ⋈ ingest.forum_post';
COMMENT ON COLUMN serve.user_stats.first_activity_at IS
  'first/last activity 派生自 vote_event ∪ revision ∪ attribution_event ∪ forum_post(评审附录评委1-高)。';


-- 3.6 serve.user_vote_interaction ---------------------------------------
CREATE TABLE IF NOT EXISTS serve.user_vote_interaction (
  from_user_id int NOT NULL,
  to_user_id   int NOT NULL,
  up_count     int NOT NULL DEFAULT 0,
  down_count   int NOT NULL DEFAULT 0,
  total        int NOT NULL DEFAULT 0,
  last_vote_at timestamptz,
  PRIMARY KEY (from_user_id, to_user_id)
);

CREATE INDEX IF NOT EXISTS uvi_to
  ON serve.user_vote_interaction (to_user_id, down_count DESC);

COMMENT ON TABLE serve.user_vote_interaction IS
  'rebuild_from=serve.vote_current ⋈ serve.attribution_current(is_display);L2 增量:事件窗口 → 受影响 (voter,author) 对重算';


-- 3.7 serve.user_tag_preference -----------------------------------------
CREATE TABLE IF NOT EXISTS serve.user_tag_preference (
  user_id      int  NOT NULL,
  tag          text NOT NULL,
  up_count     int  NOT NULL DEFAULT 0,
  down_count   int  NOT NULL DEFAULT 0,
  total        int  NOT NULL DEFAULT 0,
  last_vote_at timestamptz,
  PRIMARY KEY (user_id, tag)
);

CREATE INDEX IF NOT EXISTS utp_tag
  ON serve.user_tag_preference (tag, up_count DESC);

COMMENT ON TABLE serve.user_tag_preference IS
  'rebuild_from=serve.vote_current ⋈ serve.page_current.tags;L2 增量:受影响 (voter,tag) 对重算';


-- 3.8 serve.page_daily_stats --------------------------------------------
-- 列集沿用 V1。views 列原样搬运 + 只读守卫触发器 —— 全库唯一不可重建数据(审计红线)。
CREATE TABLE IF NOT EXISTS serve.page_daily_stats (
  page_id       int  NOT NULL,
  date          date NOT NULL,
  views         int  NOT NULL DEFAULT 0,
  votes_up      int  NOT NULL DEFAULT 0,
  votes_down    int  NOT NULL DEFAULT 0,
  total_votes   int  GENERATED ALWAYS AS (votes_up + votes_down) STORED,
  unique_voters int  NOT NULL DEFAULT 0,
  revisions     int  NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, date)
);

CREATE INDEX IF NOT EXISTS pds_date ON serve.page_daily_stats (date);

COMMENT ON TABLE serve.page_daily_stats IS
  'rebuild_from=ingest.vote_event + ingest.revision(仅 votes_*/unique_voters/revisions 列);views 列 rebuild_from=NONE —— 来自 app.page_view_event 的一次性计数,历史事件被裁剪后不可再生,受 serve.trg_pds_views_guard 只读守卫保护';
COMMENT ON COLUMN serve.page_daily_stats.views IS
  '不可重建数据(审计红线)。只允许单调不减的增量 UPDATE;任何降值/清零/DELETE/TRUNCATE 被守卫拒绝,除非 serve.write_bypass_enabled()。';
COMMENT ON COLUMN serve.page_daily_stats.total_votes IS
  'V1 列集保真:生成列 = votes_up + votes_down,不接受独立写入(消除口径分叉)。';


-- ---- views 只读守卫 ---------------------------------------------------
CREATE OR REPLACE FUNCTION serve.guard_page_daily_stats_views()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- 注意:DELETE 触发中 NEW 未赋值,不能在同一表达式里同时引用 OLD/NEW
  IF serve.write_bypass_enabled() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- 允许 views 保持不变(projector 重算 votes_*/revisions 的常规路径),
    -- 允许单调递增(view 聚合 job 的增量路径),拒绝任何降值/清零。
    IF NEW.views < OLD.views THEN
      RAISE EXCEPTION
        'serve.page_daily_stats.views 是不可重建数据,禁止降值(page_id=%, date=%, % -> %)',
        OLD.page_id, OLD.date, OLD.views, NEW.views
        USING HINT = '若确为迁移/修复,请 SET LOCAL scpper.bypass_guard = ''on''';
    END IF;
    -- 主键不可漂移:否则等价于把某天的 views 搬到另一天
    IF NEW.page_id <> OLD.page_id OR NEW.date <> OLD.date THEN
      RAISE EXCEPTION
        'serve.page_daily_stats 主键不可变更(page_id/date),这会搬移不可重建的 views'
        USING HINT = '若确为迁移/修复,请 SET LOCAL scpper.bypass_guard = ''on''';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.views > 0 THEN
      RAISE EXCEPTION
        'serve.page_daily_stats 行含不可重建的 views=%,禁止 DELETE(page_id=%, date=%)',
        OLD.views, OLD.page_id, OLD.date
        USING HINT = '若确为迁移/修复,请 SET LOCAL scpper.bypass_guard = ''on''';
    END IF;
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION serve.guard_page_daily_stats_views() IS
  'views 只读守卫(行级):拒绝降值/清零/主键漂移/含 views 行的 DELETE。';

CREATE OR REPLACE FUNCTION serve.guard_page_daily_stats_truncate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF serve.write_bypass_enabled() THEN
    RETURN NULL;
  END IF;
  RAISE EXCEPTION
    'serve.page_daily_stats 含不可重建的 views 列,禁止 TRUNCATE(投影重建请逐列 UPSERT,不要清表)'
    USING HINT = '若确为迁移/修复,请 SET LOCAL scpper.bypass_guard = ''on''';
  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION serve.guard_page_daily_stats_truncate() IS
  'views 只读守卫(语句级):拦截 TRUNCATE —— Tier-2 常规重建手法会连带抹掉唯一不可重建数据。';

DROP TRIGGER IF EXISTS trg_pds_views_guard ON serve.page_daily_stats;
CREATE TRIGGER trg_pds_views_guard
  BEFORE UPDATE OR DELETE ON serve.page_daily_stats
  FOR EACH ROW EXECUTE FUNCTION serve.guard_page_daily_stats_views();

DROP TRIGGER IF EXISTS trg_pds_truncate_guard ON serve.page_daily_stats;
CREATE TRIGGER trg_pds_truncate_guard
  BEFORE TRUNCATE ON serve.page_daily_stats
  FOR EACH STATEMENT EXECUTE FUNCTION serve.guard_page_daily_stats_truncate();


-- 3.9 serve.page_version_display ----------------------------------------
-- /versions 端点的新载体(V1 PageVersion 的展示替身)
CREATE TABLE IF NOT EXISTS serve.page_version_display (
  page_id         int  NOT NULL,
  version_no      int  NOT NULL,          -- 每页从 1 递增的展示序号
  valid_from      timestamptz NOT NULL,
  valid_to        timestamptz,
  title           text,
  alternate_title text,
  tags            text[],
  category        text,
  life_kind       text,                   -- 区间起点对应的 life 事件(created/renamed/restored/...)
  PRIMARY KEY (page_id, version_no)
);

CREATE INDEX IF NOT EXISTS pvd_page_time
  ON serve.page_version_display (page_id, valid_from DESC);
CREATE UNIQUE INDEX IF NOT EXISTS pvd_current
  ON serve.page_version_display (page_id) WHERE valid_to IS NULL;

COMMENT ON TABLE serve.page_version_display IS
  'rebuild_from=ingest.page_attr_history + ingest.page_life_event';


-- =====================================================================
-- 4. Tier-2「保留换输入」批(§4.5 末尾)
--    列集沿用 V1(prisma/schema.prisma),锚点 pageVersionId → page_id,
--    cuid/autoincrement 代理主键 → 自然键或 identity,命名统一 snake_case。
-- =====================================================================

-- 4.1 serve.site_stats(单行) --------------------------------------------
CREATE TABLE IF NOT EXISTS serve.site_stats (
  id                 smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  total_users        int NOT NULL DEFAULT 0,
  active_users       int NOT NULL DEFAULT 0,
  total_pages        int NOT NULL DEFAULT 0,
  total_votes_state  bigint NOT NULL DEFAULT 0,   -- vote_current 中 direction<>0 的行数(当前态口径)
  total_votes_events bigint NOT NULL DEFAULT 0,   -- vote_event 总事件数(事件口径)
  new_users_today    int NOT NULL DEFAULT 0,
  new_pages_today    int NOT NULL DEFAULT 0,
  new_votes_today    int NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE serve.site_stats IS
  'rebuild_from=serve.page_current + serve.vote_current + ingest.vote_event + ingest."user"';
COMMENT ON COLUMN serve.site_stats.total_votes_state IS
  '当前态口径,与事件口径 total_votes_events 分列,终结 V1 单列 totalVotes 的二义性。';


-- 4.2 serve.site_overview_daily ------------------------------------------
CREATE TABLE IF NOT EXISTS serve.site_overview_daily (
  date               date PRIMARY KEY,
  users_total        int NOT NULL DEFAULT 0,
  users_contributors int NOT NULL DEFAULT 0,
  users_authors      int NOT NULL DEFAULT 0,
  users_active       int NOT NULL DEFAULT 0,
  pages_total        int NOT NULL DEFAULT 0,
  pages_originals    int NOT NULL DEFAULT 0,
  pages_translations int NOT NULL DEFAULT 0,
  votes_up           int NOT NULL DEFAULT 0,
  votes_down         int NOT NULL DEFAULT 0,
  revisions_total    int NOT NULL DEFAULT 0,
  computed_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE serve.site_overview_daily IS
  'rebuild_from=ingest.vote_event + ingest.revision + serve.page_current + serve.user_page';


-- 4.3 serve.leaderboard_cache --------------------------------------------
CREATE TABLE IF NOT EXISTS serve.leaderboard_cache (
  key         text  NOT NULL,
  period      text  NOT NULL,
  payload     jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz,
  PRIMARY KEY (key, period)
);

CREATE INDEX IF NOT EXISTS lc_expires ON serve.leaderboard_cache (expires_at);

COMMENT ON TABLE serve.leaderboard_cache IS
  'rebuild_from=serve.user_stats + serve.page_stats + serve.page_current(纯缓存,可整表丢弃后重算)';


-- 4.4 serve.trending_stats ------------------------------------------------
CREATE TABLE IF NOT EXISTS serve.trending_stats (
  entity_type text    NOT NULL,   -- 命名空间已吸收 V1 statType,例:'page:rating_delta'
  entity_id   int     NOT NULL,
  period      text    NOT NULL,
  score       numeric NOT NULL,
  label       text,               -- V1 name,展示用冗余快照,由 projector 统一回填
  metadata    jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, entity_id, period)
);

CREATE INDEX IF NOT EXISTS ts_type_period_score
  ON serve.trending_stats (entity_type, period, score DESC);

COMMENT ON TABLE serve.trending_stats IS
  'rebuild_from=serve.vote_daily + serve.user_attr_daily + serve.page_current';
COMMENT ON COLUMN serve.trending_stats.entity_type IS
  'V1 (stat_type, entity_type) 二元组折叠为单一命名空间字符串,使主键三列全部 NOT NULL(§3 原则 3:唯一键中无 nullable 列)。';


-- 4.5 interesting_facts 族 ------------------------------------------------
-- 冗余快照列(page_title 等)保留,但由 projector 统一回填,不再由 BFF 侧写入。

CREATE TABLE IF NOT EXISTS serve.interesting_facts (
  category     text NOT NULL,
  type         text NOT NULL,
  date_context date NOT NULL DEFAULT '-infinity',  -- 无日期上下文 = -infinity(避免 nullable 进唯一键)
  tag_context  text NOT NULL DEFAULT '',           -- 无标签上下文 = 空串
  rank         int  NOT NULL DEFAULT 1,
  title        text NOT NULL,
  description  text,
  value        text,
  metadata     jsonb,
  page_id      int,
  user_id      int,
  is_active    boolean NOT NULL DEFAULT true,
  computed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category, type, date_context, tag_context, rank)
);

CREATE INDEX IF NOT EXISTS if_active
  ON serve.interesting_facts (category, type, rank) WHERE is_active;
CREATE INDEX IF NOT EXISTS if_computed_at ON serve.interesting_facts (computed_at);

COMMENT ON TABLE serve.interesting_facts IS
  'rebuild_from=serve.page_current + serve.page_stats + serve.user_stats + serve.vote_daily';
COMMENT ON COLUMN serve.interesting_facts.date_context IS
  'V1 nullable dateContext 归一为 NOT NULL,无上下文用 ''-infinity'' 哨兵(§3 原则 3)。';


CREATE TABLE IF NOT EXISTS serve.time_milestones (
  period          text NOT NULL,
  period_value    text NOT NULL,
  milestone_type  text NOT NULL,
  page_id         int  NOT NULL,
  page_title      text,
  page_rating     int,
  page_created_at timestamptz,
  computed_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (period, period_value, milestone_type)
);

CREATE INDEX IF NOT EXISTS tm_page ON serve.time_milestones (page_id);
CREATE INDEX IF NOT EXISTS tm_type ON serve.time_milestones (milestone_type);

COMMENT ON TABLE serve.time_milestones IS
  'rebuild_from=serve.page_current + serve.user_page.effective_created_at';


CREATE TABLE IF NOT EXISTS serve.tag_records (
  tag         text NOT NULL,
  record_type text NOT NULL,
  page_id     int,
  user_id     int,
  value       numeric,
  metadata    jsonb,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tag, record_type)
);

CREATE INDEX IF NOT EXISTS tr_record_type ON serve.tag_records (record_type);

COMMENT ON TABLE serve.tag_records IS
  'rebuild_from=serve.page_current.tags + serve.page_stats + serve.user_tag_preference';


CREATE TABLE IF NOT EXISTS serve.content_records (
  record_type    text NOT NULL,
  page_id        int  NOT NULL,
  page_title     text,
  source_length  int,
  content_length int,
  complexity     jsonb,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (record_type, page_id)
);

CREATE INDEX IF NOT EXISTS cr_source_length ON serve.content_records (record_type, source_length DESC);

COMMENT ON TABLE serve.content_records IS
  'rebuild_from=ingest.content_blob(byte_len/text_len) ⋈ ingest.page_source ⋈ serve.page_current';


CREATE TABLE IF NOT EXISTS serve.rating_records (
  record_type text NOT NULL,
  timeframe   text NOT NULL DEFAULT '',   -- V1 nullable timeframe → 空串哨兵
  page_id     int  NOT NULL,
  page_title  text,
  rating      int,
  vote_count  int,
  controversy real,
  wilson95    real,
  value       numeric,
  achieved_at timestamptz,
  computed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (record_type, timeframe, page_id)
);

CREATE INDEX IF NOT EXISTS rr_type_rating
  ON serve.rating_records (record_type, timeframe, rating DESC);

COMMENT ON TABLE serve.rating_records IS
  'rebuild_from=serve.page_current + serve.page_stats + serve.vote_daily';


CREATE TABLE IF NOT EXISTS serve.user_activity_records (
  record_type       text NOT NULL,
  user_id           int  NOT NULL,
  user_display_name text,
  value             numeric,
  achieved_at       timestamptz,
  context           jsonb,
  computed_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (record_type, user_id)
);

CREATE INDEX IF NOT EXISTS uar_type_achieved
  ON serve.user_activity_records (record_type, achieved_at DESC NULLS LAST);

COMMENT ON TABLE serve.user_activity_records IS
  'rebuild_from=serve.user_stats + serve.user_attr_daily + serve.user_page + ingest.forum_post';


-- 4.6 serve.series_stats --------------------------------------------------
CREATE TABLE IF NOT EXISTS serve.series_stats (
  series            int  PRIMARY KEY,               -- V1 seriesNumber
  total             int  NOT NULL,                  -- V1 totalSlots
  used              int  NOT NULL DEFAULT 0,        -- V1 usedSlots
  free_numbers      int[] NOT NULL DEFAULT '{}',    -- 空缺编号(V2 新增,支撑"下一个可用编号")
  is_open           boolean NOT NULL DEFAULT false,
  usage_percentage  real GENERATED ALWAYS AS (
                      CASE WHEN total > 0 THEN used::real / total::real ELSE 0::real END
                    ) STORED,
  milestone_page_id int,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ss_open  ON serve.series_stats (is_open);
CREATE INDEX IF NOT EXISTS ss_usage ON serve.series_stats (usage_percentage DESC);

COMMENT ON TABLE serve.series_stats IS
  'rebuild_from=serve.page_current(slug 匹配 scp-cn-\d+ 系列号)';


-- 4.7 serve.tag_validation_cache ------------------------------------------
CREATE TABLE IF NOT EXISTS serve.tag_validation_cache (
  tag              text PRIMARY KEY,
  status           text NOT NULL,        -- 'valid'|'invalid'|'untranslated'|...(V1 validationType 的分类结果化)
  page_count       int  NOT NULL DEFAULT 0,
  latest_page_date timestamptz,
  detail           jsonb NOT NULL DEFAULT '{}',  -- {sample_pages: text[], ...}
  checked_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tvc_status  ON serve.tag_validation_cache (status);
CREATE INDEX IF NOT EXISTS tvc_latest  ON serve.tag_validation_cache (latest_page_date DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS tvc_checked ON serve.tag_validation_cache (checked_at);

COMMENT ON TABLE serve.tag_validation_cache IS
  'rebuild_from=serve.page_current.tags + app.tag_definition';
COMMENT ON COLUMN serve.tag_validation_cache.status IS
  'V1 每标签多行(validationType)折叠为每标签一行的分类结果;样本页列表移入 detail.sample_pages。';


-- 4.8 category_index_tick / category_index_forecast_tick -------------------
-- append-only 不重算:时点 tags 切 page_attr_history。带不可变守卫。
CREATE TABLE IF NOT EXISTS serve.category_index_tick (
  category           text NOT NULL,
  as_of_ts           timestamptz NOT NULL,
  watermark_ts       timestamptz,
  vote_cutoff_date   date    NOT NULL,
  vote_rule_version  text    NOT NULL DEFAULT 'utc8-t+1-v1',
  score_signal_raw   numeric NOT NULL DEFAULT 0,
  score_ref          numeric NOT NULL DEFAULT 0,
  score_provisional  numeric NOT NULL DEFAULT 0,
  index_mark         numeric NOT NULL,
  crowd_drag         numeric NOT NULL DEFAULT 0,
  noise              numeric NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category, as_of_ts)
);

CREATE INDEX IF NOT EXISTS cit_watermark ON serve.category_index_tick (watermark_ts);

COMMENT ON TABLE serve.category_index_tick IS
  'rebuild_from=NONE(append-only 时点快照,不重算;时点 tags 由 ingest.page_attr_history 切片决定,历史 tick 永不回改)';


CREATE TABLE IF NOT EXISTS serve.category_index_forecast_tick (
  category             text NOT NULL,
  as_of_ts             timestamptz NOT NULL,
  settle_day           date    NOT NULL,
  hour_offset          int     NOT NULL,
  forecast_score       numeric NOT NULL,
  forecast_index       numeric NOT NULL,
  day_close_score      numeric NOT NULL,
  day_close_index      numeric NOT NULL,
  prev_day_close_index numeric NOT NULL,
  is_stale             boolean NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (category, as_of_ts)
);

CREATE UNIQUE INDEX IF NOT EXISTS cift_day_hour
  ON serve.category_index_forecast_tick (category, settle_day, hour_offset);
CREATE INDEX IF NOT EXISTS cift_category_settle_day
  ON serve.category_index_forecast_tick (category, settle_day);

COMMENT ON TABLE serve.category_index_forecast_tick IS
  'rebuild_from=NONE(append-only 时点预测快照,不重算;唯一例外是 is_stale 标记,见守卫白名单)';


CREATE OR REPLACE FUNCTION serve.guard_append_only_tick()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- 注意:DELETE 触发中 NEW 未赋值,不能在同一表达式里同时引用 OLD/NEW
  IF TG_OP = 'DELETE' THEN
    IF serve.write_bypass_enabled() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% 是 append-only 时点表,禁止 DELETE', TG_TABLE_NAME
      USING HINT = '若确为迁移/修复,请 SET LOCAL scpper.bypass_guard = ''on''';
  END IF;

  IF serve.write_bypass_enabled() THEN
    RETURN NEW;
  END IF;

  -- 唯一受控 UPDATE 白名单:forecast tick 的 is_stale 标记(NULL/false → true 单向)
  IF TG_TABLE_NAME = 'category_index_forecast_tick' THEN
    IF to_jsonb(NEW) - 'is_stale' = to_jsonb(OLD) - 'is_stale' AND NEW.is_stale THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION '% 是 append-only 时点表,禁止 UPDATE(仅 forecast tick 的 is_stale 置真受控放行)', TG_TABLE_NAME
    USING HINT = '若确为迁移/修复,请 SET LOCAL scpper.bypass_guard = ''on''';
  RETURN NULL;  -- 不可达
END;
$$;

COMMENT ON FUNCTION serve.guard_append_only_tick() IS
  'category_index_* 时点表不可变守卫:禁止 DELETE / UPDATE,仅放行 forecast tick 的 is_stale 单向置真。';

DROP TRIGGER IF EXISTS trg_cit_append_only ON serve.category_index_tick;
CREATE TRIGGER trg_cit_append_only
  BEFORE UPDATE OR DELETE ON serve.category_index_tick
  FOR EACH ROW EXECUTE FUNCTION serve.guard_append_only_tick();

DROP TRIGGER IF EXISTS trg_cift_append_only ON serve.category_index_forecast_tick;
CREATE TRIGGER trg_cift_append_only
  BEFORE UPDATE OR DELETE ON serve.category_index_forecast_tick
  FOR EACH ROW EXECUTE FUNCTION serve.guard_append_only_tick();


-- 4.9 serve.page_reference / page_reference_graph_snapshot ----------------
CREATE TABLE IF NOT EXISTS serve.page_reference (
  from_page_id   int  NOT NULL,
  to_page_id     int  NOT NULL,
  kind           text NOT NULL,          -- V1 linkType
  target_path    text NOT NULL,          -- 归一化后、解析到 to_page_id 的原始路径
  target_fragment text,
  display_texts  text[] NOT NULL DEFAULT '{}',
  occurrence     int  NOT NULL DEFAULT 1,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (from_page_id, to_page_id, kind)
);

CREATE INDEX IF NOT EXISTS pr_to   ON serve.page_reference (to_page_id, kind);
CREATE INDEX IF NOT EXISTS pr_path ON serve.page_reference (target_path);

COMMENT ON TABLE serve.page_reference IS
  'rebuild_from=ingest.content_blob 解析 ⋈ serve.page_current(slug→page_id 解析)';
COMMENT ON COLUMN serve.page_reference.target_path IS
  '同一 (from,to,kind) 若有多条不同原始路径(重定向/别名),occurrence 累加、target_path 取首个;未解析到 page 的红链不入本表(见迁移待办)。';


CREATE TABLE IF NOT EXISTS serve.page_reference_graph_snapshot (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label        text NOT NULL UNIQUE,
  description  text,
  stats        jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS prgs_generated_at
  ON serve.page_reference_graph_snapshot (generated_at DESC);

COMMENT ON TABLE serve.page_reference_graph_snapshot IS
  'rebuild_from=serve.page_reference(图指标快照,可按 label 重跑覆盖)';


-- 4.10 serve.image_asset / serve.page_image --------------------------------
CREATE TABLE IF NOT EXISTS serve.image_asset (
  hash_sha256     bytea PRIMARY KEY,
  perceptual_hash text,
  mime            text,
  bytes           int,
  width           int,
  height          int,
  storage_path    text,
  canonical_url   text,
  source_hosts    text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'ready'
                    CHECK (status IN ('pending', 'fetching', 'ready', 'failed')),
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_fetched_at timestamptz,
  error_message   text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ia_status     ON serve.image_asset (status);
CREATE INDEX IF NOT EXISTS ia_perceptual ON serve.image_asset (perceptual_hash)
  WHERE perceptual_hash IS NOT NULL;

COMMENT ON TABLE serve.image_asset IS
  'rebuild_from=NONE-ON-METADATA(内容寻址资产元数据;可由 storage_path 下的字节重新计算,但抓取产物本身不可重建)。写入者:avatar_worker_role。';
COMMENT ON COLUMN serve.image_asset.hash_sha256 IS
  '内容寻址主键。V1 的 hashSha256 可空(未抓取态)在 V2 不再建行——未抓取态只存在于 serve.page_image.status 与 meta.image_ingest_job。';


CREATE TABLE IF NOT EXISTS serve.page_image (
  page_id        int  NOT NULL,
  normalized_url text NOT NULL,
  origin_url     text NOT NULL,
  display_url    text,
  status         text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'queued', 'fetching', 'resolved', 'failed')),
  asset_sha      bytea REFERENCES serve.image_asset(hash_sha256),
  extracted_at   timestamptz NOT NULL DEFAULT now(),
  last_queued_at timestamptz,
  last_fetched_at timestamptz,
  failure_count  int  NOT NULL DEFAULT 0,
  last_error     text,
  metadata       jsonb,
  PRIMARY KEY (page_id, normalized_url)
);

CREATE INDEX IF NOT EXISTS pi_status ON serve.page_image (status);
CREATE INDEX IF NOT EXISTS pi_asset  ON serve.page_image (asset_sha) WHERE asset_sha IS NOT NULL;

COMMENT ON TABLE serve.page_image IS
  'rebuild_from=ingest.content_blob 解析(图片 URL 抽取);抓取态列(status/asset_sha/failure_count)由 avatar_worker_role 维护,重建时只重放 URL 集合、保留抓取态。';


COMMIT;

-- =====================================================================
-- 交付后置事项(不在本文件执行):
--   * 0005_indexes_pgroonga.sql:page_current.search_text / title / alternate_title
--   * 9000_roles_grants.sql.ADMIN(需 DBA):
--       REVOKE 所有写权限 on serve.* FROM bff_role;GRANT SELECT ON ALL TABLES IN SCHEMA serve TO bff_role;
--       GRANT INSERT/UPDATE/DELETE on Tier-2 表 TO projector_role;
--       serve.page_image / serve.image_asset 的 SELECT/UPDATE TO avatar_worker_role;
--       Tier-1 三表对 ingestor_role/projector_role 一律无直接 DML(只经 apply_* SECURITY DEFINER)。
--   * meta.projection_cursor 的初始行(每张 Tier-2 表一行,rebuild_from 与本文件 COMMENT 逐字一致)
--     随 0003_meta.sql 落地(表已建,初始登记清单尚未写 —— 见 README 的 TODO)。
-- =====================================================================
