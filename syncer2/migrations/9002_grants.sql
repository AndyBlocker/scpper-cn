-- =====================================================================================
-- 9002_grants.sql —— v2 授权矩阵（**不需要 CREATEROLE，应用账号自己就能跑**）
-- =====================================================================================
--
-- 【本文件与 9000 / 9001 的关系】
--   9000_roles_grants.sql.ADMIN  = 历史上的一份大而全脚本（456 行，建角色 + 全部授权）。
--                                  保留作对照与"DBA 手上有 superuser 时一把梭"的备选，
--                                  但**推荐路径已改为 9001 + 9002**。
--   9001_create_roles.sql.ADMIN  = 只有 5 条 CREATE ROLE + 5 条 COMMENT ON ROLE。需 DBA。
--   9002_grants.sql（本文件）    = 其余全部 GRANT / REVOKE / ALTER DEFAULT PRIVILEGES。
--
--   拆分依据是 2026-07-27 的逐语句权限实测：GRANT/REVOKE 只要求**对象属主**身份，
--   而 ingest/serve/meta/app 四个 schema 与全部 78 张表、38 个函数的属主都是 user_dxzbdi；
--   数据库 scpper-v2 的 datdba 也是它；schema public 属 pg_database_owner，
--   user_dxzbdi 是其成员（`pg_has_role(current_user,'pg_database_owner','member')` = t）。
--   ⇒ 只有 CREATE ROLE / COMMENT ON ROLE 需要特权，其余一律不需要。
--
-- 【角色不存在时的行为 —— 刻意设计成"跳过而不是失败"】
--   本文件进 apply.sh 的常规序列（文件名匹配 `[0-9]*.sql`），会在角色尚未创建时就被执行。
--   因此每一段授权都用 `to_regrole('<role>') IS NULL` 守卫：角色缺失只 RAISE NOTICE 跳过，
--   不报错、不中断迁移。DBA 执行完 9001 之后**重跑本文件一次**，权限即补齐。
--   —— 这与 0006 第 8 节的做法一致（那一段的 GRANT 在角色不存在时同样只 NOTICE）。
--
--   ⚠ 所以"apply.sh 跑完没报错"**不等于**授权已生效。判据只有一个：文件末尾第 12 节的
--     自检查询。全部符合期望才算完成。
--
-- 【与 0006 第 8 节的分工】0006 第 8 节做的是 `REVOKE EXECUTE ... FROM PUBLIC`
--   （不依赖角色，已生效）+ 给 ingestor_role 的 GRANT EXECUTE（依赖角色，此前一直被跳过）。
--   本文件第 3/5 节把后者重做一遍，所以**建好角色后重跑 0006 或重跑本文件二选一即可**，
--   两者对 apply_* 的 EXECUTE 授权是同一结果（本文件覆盖面更全：还包括 bff/projector 的
--   ensure_user 与 migration_role 的全量 EXECUTE）。
--
-- 【幂等】全部 GRANT/REVOKE 天然幂等；ALTER DEFAULT PRIVILEGES 幂等。可反复重跑。
-- 【依赖】0001~0004 已执行（四 schema + 全部表），0006 已执行（apply_* 函数族）。
-- =====================================================================================

BEGIN;

-- 受保护库黑名单：与 0001~0006 同一道闸
DO $$
BEGIN
  IF current_database() IN ('scpper-cn', 'scpper_cn') THEN
    RAISE EXCEPTION '拒绝执行：当前库是 %，v2 授权脚本只能作用于 scpper-v2。', current_database();
  END IF;
END $$;

-- 对象属主：ALTER DEFAULT PRIVILEGES 必须按属主声明，否则后续新建的表不会自动继承授权。
-- 默认取当前用户 —— 因为本文件就是由属主执行的，这比写死字符串更不容易失配。
DO $$
BEGIN
  PERFORM set_config('scpper.v2_owner', current_user, true);
END $$;


-- =====================================================================================
-- 0. 前置检查：四个 schema 必须已存在（避免半套授权）
-- =====================================================================================
DO $$
DECLARE missing text[];
BEGIN
  SELECT array_agg(s) INTO missing
  FROM unnest(ARRAY['ingest','serve','app','meta']) AS s
  WHERE NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = s);

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION '缺少 schema: %。请先执行 0001~0004 的迁移。', array_to_string(missing, ', ');
  END IF;
END $$;

-- 角色缺失清单：提前打一次总账，避免下面刷一屏 NOTICE 却没人看懂整体状态
DO $$
DECLARE missing text[];
BEGIN
  SELECT array_agg(r) INTO missing
  FROM unnest(ARRAY['bff_role','ingestor_role','projector_role',
                    'avatar_worker_role','migration_role']) AS r
  WHERE to_regrole(r) IS NULL;

  IF missing IS NULL THEN
    RAISE NOTICE '[9002] 五个组角色全部存在，本次将完整应用授权矩阵。';
  ELSE
    RAISE WARNING '[9002] 以下角色不存在，相关授权段将被跳过：%。'
                  '请让 DBA 执行 9001_create_roles.sql.ADMIN 后**重跑本文件**。',
                  array_to_string(missing, ', ');
  END IF;
END $$;


-- =====================================================================================
-- 1. 不依赖角色的收口（现在就能生效，且必须生效）
-- =====================================================================================
-- PUBLIC 对本库的默认 CONNECT / TEMPORARY 收回。属主自己不受影响。
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM PUBLIC', current_database());
END $$;

-- v2 的对象一个都不放在 public schema，PUBLIC 也不该能在里面建东西
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- 【关键】把函数从 PUBLIC 手里收回来。
-- PG 默认 PUBLIC 对新建函数有 EXECUTE。apply_* 是 SECURITY DEFINER（以属主身份运行、
-- 拥有事实表全权），若不收回，任何能连库的角色都能调用它写事实 —— 整个"权限即边界"
-- 会从这里漏光。这一条是最容易被漏掉、后果最严重的一条（0006 第 8 节已做，此处复述兜底）。
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA ingest FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA serve  FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA app    FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA meta   FROM PUBLIC;


-- =====================================================================================
-- 2. 数据库与 schema 级（依赖角色）
-- =====================================================================================
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['bff_role','ingestor_role','projector_role',
                           'avatar_worker_role','migration_role'] LOOP
    IF to_regrole(r) IS NULL THEN
      RAISE NOTICE '[9002 §2] 角色 % 不存在，跳过 CONNECT/USAGE 授权', r;
      CONTINUE;
    END IF;
    EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), r);
  END LOOP;

  -- TEMPORARY 必须还回去：apply_vote_history 用"临时集合 ⋈ vote_current"做集合化 CAS，
  -- 批量投影重建同理。只 REVOKE 不还，批量路径会在 CREATE TEMP TABLE 上炸。
  FOREACH r IN ARRAY ARRAY['ingestor_role','projector_role','migration_role'] LOOP
    CONTINUE WHEN to_regrole(r) IS NULL;
    EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO %I', current_database(), r);
  END LOOP;

  -- USAGE（仅"能看见 schema 里的对象名"，不含任何对象权限）
  FOREACH r IN ARRAY ARRAY['bff_role','ingestor_role','projector_role','migration_role'] LOOP
    CONTINUE WHEN to_regrole(r) IS NULL;
    EXECUTE format('GRANT USAGE ON SCHEMA ingest, serve, app, meta TO %I', r);
  END LOOP;
  IF to_regrole('avatar_worker_role') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA serve, meta TO avatar_worker_role;
  END IF;
END $$;


-- =====================================================================================
-- 3. bff_role —— 唯一读面 + app 自有域写
-- =====================================================================================
DO $$
BEGIN
IF to_regrole('bff_role') IS NULL THEN
  RAISE NOTICE '[9002 §3] bff_role 不存在，整段跳过';
ELSE
  -- 3.1 serve.*：全部只读（设计文档 §6"BFF 唯一读面 = serve.*"）
  GRANT SELECT ON ALL TABLES IN SCHEMA serve TO bff_role;

  -- 3.2 ingest 身份表
  GRANT SELECT ON ingest.page, ingest.page_lineage, ingest.page_slug_history, ingest."user"
    TO bff_role;

  -- 3.3 ingest 事件表（显式事件语义端点用：改票历史 tab / revisions / 版本时间线）
  GRANT SELECT ON ingest.vote_event, ingest.revision, ingest.page_life_event,
                  ingest.page_attr_history, ingest.attribution_event
    TO bff_role;

  -- 3.4 ingest 论坛三表（BFF 第二大读域，38+ 处引用）
  GRANT SELECT ON ingest.forum_category, ingest.forum_thread, ingest.forum_post TO bff_role;

  -- 3.5 【相对设计文档 §4.1 的补充】内容表两张。
  --     §4.1 的 bff 清单没列它们，但 §6.7 明写"修订源码经 page_source→content_blob"、
  --     §6.16 明写 "/versions/:key/source 映射 page_source(page_id, rev_no)"。
  --     不授权则这两个端点在读切换当天直接 500。只读，不含任何 DML。
  GRANT SELECT ON ingest.page_source, ingest.content_blob TO bff_role;

  -- 3.6 app 自有域：完全可写
  GRANT SELECT, INSERT, UPDATE, DELETE ON
    app.user_collection, app.user_collection_item, app.collection_account_owner,
    app.user_follow, app.user_metric_preference, app.page_metric_watch
  TO bff_role;

  -- 3.7 告警实例三表：BFF 只读 + 只能改已读态（列级授权，设计文档 §4.6）
  GRANT SELECT ON app.page_metric_alert, app.user_activity_alert, app.forum_interaction_alert
    TO bff_role;
  GRANT UPDATE (acknowledged_at) ON app.page_metric_alert       TO bff_role;
  GRANT UPDATE (acknowledged_at) ON app.user_activity_alert     TO bff_role;
  GRANT UPDATE (acknowledged_at) ON app.forum_interaction_alert TO bff_role;

  -- 3.8 追踪三表：只 INSERT + SELECT。
  --     这就是"只 additive、不 UPDATE 旧事件行"红线的强制手段（见 0004 设计约定 5）。
  --     刻意不给 DELETE：保留期清理由运维/属主执行，不走 BFF。
  GRANT SELECT, INSERT ON app.page_view_event, app.user_pixel_event, app.tracking_debug_event
    TO bff_role;

  -- 3.9 标签域：BFF 只读（写入者是 projector 的同步 job）
  GRANT SELECT ON app.tag_definition, app.tag_guide_sync TO bff_role;
END IF;
END $$;

-- 3.10 铸造用户的唯一入口：ensure_user 三方共用
DO $$
DECLARE fn text; r text;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure::text
            FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'ingest' AND p.proname = 'ensure_user'
  LOOP
    FOREACH r IN ARRAY ARRAY['bff_role','ingestor_role','projector_role'] LOOP
      CONTINUE WHEN to_regrole(r) IS NULL;
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, r);
    END LOOP;
  END LOOP;
END $$;

-- 3.11 页面层级读面：角色若晚于 0026 创建，仍补齐显式 EXECUTE。
DO $$
DECLARE fn text; r text;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure::text
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'serve'
       AND p.proname IN ('page_children', 'page_subtree')
  LOOP
    FOREACH r IN ARRAY ARRAY['bff_role','ingestor_role','projector_role','migration_role'] LOOP
      CONTINUE WHEN to_regrole(r) IS NULL;
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, r);
    END LOOP;
  END LOOP;
END $$;


-- =====================================================================================
-- 4. ingestor_role —— 仅 EXECUTE apply_* 函数族（设计文档 §4.1）
-- =====================================================================================
DO $$
DECLARE rec record; n int := 0;
BEGIN
  IF to_regrole('ingestor_role') IS NULL THEN
    RAISE NOTICE '[9002 §4] ingestor_role 不存在，整段跳过';
    RETURN;
  END IF;

  FOR rec IN
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'ingest'
      AND (p.proname LIKE 'apply\_%' OR p.proname IN ('register_page','ensure_user'))
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ingestor_role', rec.sig);
    n := n + 1;
  END LOOP;

  IF n = 0 THEN
    RAISE WARNING '[9002 §4] ingest schema 里没有 apply_*/register_page/ensure_user —— '
                  '0006 尚未执行。函数上线后请重跑本文件。';
  ELSE
    RAISE NOTICE '[9002 §4] 已向 ingestor_role 授权 % 个转移函数', n;
  END IF;

  -- meta 里也有 SECURITY DEFINER 函数（游标/水位），采集器要能调
  FOR rec IN
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'meta' AND p.prokind = 'f'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ingestor_role', rec.sig);
  END LOOP;

  -- 【相对设计文档 §4.1 的显式偏离，理由写在这里】
  --   文档原文："ingestor_role：仅 EXECUTE apply_* 函数族；对任何表无直接 DML。"
  --   但 §5.5 的游标安全机制要求**摄入事务自己**在分配 seq 之前 INSERT meta.ingest_gate、
  --   提交前 DELETE；调度段要求采集器自己写 meta.scan_task / page_scan / ingest_run。
  --   这些不是事实，是管道对自己的观测；包成 SECURITY DEFINER 成本高收益低
  --   （它们没有任何"不可构造"的不变量要守）。
  --   因此：**ingest/serve 的任何表仍然零 DML（红线不变）**，但 meta 里采集器职责范围内的
  --   表给完整 DML。不给的：projection_cursor（projector 的）、v2_baseline / v1_version_map /
  --   dedup_audit（迁移的）、image_ingest_job（projector 建、avatar worker 认领）、
  --   fact_quarantine（只由 SECURITY DEFINER 的 apply_* 写）。
  GRANT SELECT, INSERT, UPDATE, DELETE ON
    meta.ingest_run, meta.page_scan, meta.scan_task, meta.observation_queue,
    meta.ingest_gate, meta.vote_quarantine, meta.revoke_candidate,
    meta.irreconcilable, meta.backfill_progress,
    meta.vote_sweep_page_state, meta.vote_seed_budget,
    meta.egress_control, meta.egress_request_bucket, meta.egress_alert,
    meta.pending_collection_sample, meta.pending_collection_alert
  TO ingestor_role;

  -- 熔断比对是只读的：基线由 projector/运维 job 维护，采集器只读它来决定是否冻结写入。
  GRANT SELECT ON
    meta.parse_health_baseline,
    meta.pending_collection_audit_registry,
    meta.pending_collection_current
  TO ingestor_role;
  -- 但越界留痕要写回（last_breach_*/breach_count），列级授权
  GRANT UPDATE (last_breach_at, last_breach_value, last_breach_run, breach_count)
    ON meta.parse_health_baseline TO ingestor_role;

  -- 【整合阶段补齐 2026-07-27】R10 熔断的执行体 meta.write_freeze（0007_meta_gaps.sql 建）。
  --   本文件的清单是显式枚举的，所以它在 0007 落地后**不会**被自动覆盖 —— 这正是并行开发里
  --   「新表建了但授权清单没同步」的典型缺口，实测确认过一次（0007 只授了函数 EXECUTE）。
  --   只给 SELECT：freeze_writes / release_writes 是 SECURITY DEFINER 且带自己的守卫，
  --   采集器有权「查冻结」（write_freeze_status() 之外的直查排查路径），但无权自行跳闸/复位。
  GRANT SELECT ON meta.write_freeze TO ingestor_role;
  -- meta.pending_page / meta.forum_scan_task 的 DML 授权由 0012_collector_queues.sql §3 自己给
  -- （建表文件与授权同处一文件，加表时不会漏），本文件不重复枚举，也不 REVOKE meta 上的任何权限。

  GRANT USAGE ON ALL SEQUENCES IN SCHEMA meta TO ingestor_role;  -- bigserial 主键需要

  -- 采集器需要读身份表来把 fullname/wikidot_id 解析成 page_id（不经函数解析不了）
  GRANT SELECT ON ingest.page, ingest.page_slug_history, ingest."user" TO ingestor_role;
  -- M5 完整 thread 快照要与当前帖 id 做集合差，才能把确认缺席的帖子作为
  -- is_deleted tombstone 交回 apply_forum_batch；只读，不放开任何事实表 DML。
  GRANT SELECT ON ingest.forum_category, ingest.forum_thread, ingest.forum_post TO ingestor_role;
  GRANT SELECT ON serve.page_current, serve.vote_current TO ingestor_role;  -- diff 基准，只读
END $$;


-- =====================================================================================
-- 5. projector_role —— 读事实，写 Tier-2 投影
-- =====================================================================================
DO $$
BEGIN
IF to_regrole('projector_role') IS NULL THEN
  RAISE NOTICE '[9002 §5] projector_role 不存在，整段跳过';
ELSE
  GRANT SELECT ON ALL TABLES IN SCHEMA ingest TO projector_role;
  GRANT SELECT ON ALL TABLES IN SCHEMA serve  TO projector_role;

  -- serve：先全给，再把三张 Tier-1 投影收回来。
  -- 这样将来新增的 Tier-2 表自动落在正确的一侧（默认可写），而 Tier-1 的边界是显式声明的。
  -- TRUNCATE 必须给：设计文档 §6"全量重建契约 = TRUNCATE + cursor=0 + 重放"。
  GRANT INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA serve TO projector_role;
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON
    serve.vote_current, serve.attribution_current, serve.page_current
  FROM projector_role;

  GRANT USAGE ON ALL SEQUENCES IN SCHEMA serve TO projector_role;

  -- app：告警实例三表由分析 job INSERT；标签同步 job 全权
  GRANT SELECT, INSERT, UPDATE, DELETE ON
    app.page_metric_alert, app.user_activity_alert, app.forum_interaction_alert,
    app.tag_definition, app.tag_guide_sync
  TO projector_role;
  -- 订阅/关注/收藏是告警的输入，只读
  GRANT SELECT ON
    app.page_metric_watch, app.user_metric_preference, app.user_follow,
    app.user_collection, app.user_collection_item, app.collection_account_owner
  TO projector_role;
  -- 分析域（用户画像/浏览统计）读追踪事件
  GRANT SELECT ON app.page_view_event, app.user_pixel_event TO projector_role;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA app TO projector_role;

  -- meta：推游标 + 维护解析健康基线 + 建图片任务；其余只读
  GRANT SELECT ON ALL TABLES IN SCHEMA meta TO projector_role;
  GRANT INSERT, UPDATE, DELETE ON
    meta.projection_cursor, meta.parse_health_baseline, meta.image_ingest_job
  TO projector_role;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA meta TO projector_role;
END IF;
END $$;


-- =====================================================================================
-- 6. avatar_worker_role —— 图片摄入 worker
-- =====================================================================================
-- 设计文档 §4.1 写的是 "SELECT/UPDATE serve.page_image、serve.image_asset、
-- meta.image_ingest_job"。这里对 image_asset 与 image_ingest_job **额外给 INSERT**：
-- worker 下载到一个新资产时必须能落 serve.image_asset 新行（sha256 主键，内容寻址），
-- 只有 UPDATE 它就永远写不进第一份资产。认领模式 FOR UPDATE SKIP LOCKED 需要 SELECT+UPDATE。
DO $$
DECLARE t text; found boolean := false;
BEGIN
  IF to_regrole('avatar_worker_role') IS NULL THEN
    RAISE NOTICE '[9002 §6] avatar_worker_role 不存在，整段跳过';
    RETURN;
  END IF;

  FOREACH t IN ARRAY ARRAY['serve.page_image','serve.image_asset'] LOOP
    IF to_regclass(t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %s TO avatar_worker_role', t);
      found := true;
    ELSE
      RAISE WARNING '[9002 §6] 未找到 % —— avatar_worker_role 对该表未授权。', t;
    END IF;
  END LOOP;
  IF found THEN
    EXECUTE 'GRANT USAGE ON ALL SEQUENCES IN SCHEMA serve TO avatar_worker_role';
  END IF;

  GRANT SELECT, INSERT, UPDATE, DELETE ON meta.image_ingest_job TO avatar_worker_role;
  GRANT USAGE ON ALL SEQUENCES IN SCHEMA meta TO avatar_worker_role;
  -- worker 需要知道图片挂在哪个页面（只读）
  GRANT SELECT ON serve.page_current TO avatar_worker_role;
END $$;


-- =====================================================================================
-- 7. migration_role —— 迁移窗口专用，唯一可绕过不可变触发器
-- =====================================================================================
DO $$
DECLARE rec record;
BEGIN
  IF to_regrole('migration_role') IS NULL THEN
    RAISE NOTICE '[9002 §7] migration_role 不存在，整段跳过';
    RETURN;
  END IF;

  GRANT ALL ON ALL TABLES    IN SCHEMA ingest, serve, app, meta TO migration_role;
  GRANT ALL ON ALL SEQUENCES IN SCHEMA ingest, serve, app, meta TO migration_role;

  FOR rec IN
    SELECT p.oid::regprocedure::text AS sig
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname IN ('ingest','serve','app','meta') AND p.prokind = 'f'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO migration_role', rec.sig);
  END LOOP;
END $$;

-- 【与不可变触发器的契约】触发器的放行判据统一写成：
--     IF pg_has_role(session_user, 'migration_role', 'MEMBER') THEN RETURN NEW; END IF;
--   用 session_user 而不是 current_user：apply_* 是 SECURITY DEFINER，函数体内
--   current_user 永远是属主（它本来就有全权），用 current_user 判会导致
--   "任何经函数的写都被当成迁移写"，例外形同虚设。
--   同时：migration_role 平时**不要**授予任何登录账号，迁移窗口开始时 GRANT、
--   窗口结束后 REVOKE，并把两次操作记进运维日志。


-- =====================================================================================
-- 8. ALTER DEFAULT PRIVILEGES —— 让**将来新建**的对象自动落在正确的一侧
-- =====================================================================================
-- 没有这一段，后续任何一个新表都会以"PUBLIC 可 EXECUTE 函数 / 各角色无权限"的默认态
-- 出生，权限矩阵会随时间静默腐烂。
DO $$
DECLARE o text := current_setting('scpper.v2_owner');
BEGIN
  -- 函数：一律先从 PUBLIC 收回（不依赖任何角色，无条件执行）
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA ingest, serve, app, meta '
                 'REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', o);

  IF to_regrole('bff_role') IS NOT NULL THEN
    -- serve：bff 只读
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA serve GRANT SELECT ON TABLES TO bff_role', o);
    -- app：bff 与 projector 共同域
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bff_role', o);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA app GRANT USAGE ON SEQUENCES TO bff_role', o);
    -- 【刻意不给 bff 任何 ingest 默认权限】新增的 ingest 表默认对 BFF 不可见，
    -- 必须像 §3.2~§3.5 那样逐表显式授权。这是"读只读投影"纪律的执行点。
  END IF;

  IF to_regrole('projector_role') IS NOT NULL THEN
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA serve GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON TABLES TO projector_role', o);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA serve GRANT USAGE ON SEQUENCES TO projector_role', o);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA ingest GRANT SELECT ON TABLES TO projector_role', o);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO projector_role', o);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA app GRANT USAGE ON SEQUENCES TO projector_role', o);
  END IF;

  -- meta：ingestor 与 projector 可写，bff 完全无权（管道状态不对外）
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA meta GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ingestor_role', o);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA meta GRANT USAGE ON SEQUENCES TO ingestor_role', o);
  END IF;
  IF to_regrole('projector_role') IS NOT NULL THEN
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA meta GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO projector_role', o);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA meta GRANT USAGE ON SEQUENCES TO projector_role', o);
  END IF;

  IF to_regrole('migration_role') IS NOT NULL THEN
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA ingest, serve, app, meta GRANT ALL ON TABLES TO migration_role', o);
    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA ingest, serve, app, meta GRANT ALL ON SEQUENCES TO migration_role', o);
  END IF;
END $$;


-- =====================================================================================
-- 9. 负向断言：显式 REVOKE（即使 GRANT 段没给过，写出来也是文档）
-- =====================================================================================
DO $$
BEGIN
  -- Phase 1 的合入 gate 之一是"bff_role 写 vote_event 必须被拒（42501）"，这里把该结论固化。
  IF to_regrole('bff_role') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA ingest FROM bff_role;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA serve  FROM bff_role;
    REVOKE ALL ON ALL TABLES IN SCHEMA meta FROM bff_role;
  END IF;

  -- 采集器对事实表与 Tier-1 投影零直接 DML：只能经 SECURITY DEFINER 函数
  IF to_regrole('ingestor_role') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA ingest FROM ingestor_role;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA serve  FROM ingestor_role;
  END IF;

  -- 投影器不写事实
  IF to_regrole('projector_role') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA ingest FROM projector_role;
  END IF;
END $$;


-- =====================================================================================
-- 10. 自检：角色齐全时**强制**校验负向断言，缺角色时只报告
--     —— 把"权限即边界"从口头约定变成迁移失败条件
-- =====================================================================================
DO $$
DECLARE bad text[] := ARRAY[]::text[];
BEGIN
  IF to_regrole('bff_role') IS NULL OR to_regrole('ingestor_role') IS NULL
     OR to_regrole('projector_role') IS NULL THEN
    RAISE NOTICE '[9002 §10] 角色未齐，跳过强制自检（补齐后重跑本文件即会强校验）';
    RETURN;
  END IF;

  -- (a) bff 不能写事实表
  IF has_table_privilege('bff_role','ingest.vote_event','INSERT')  THEN bad := bad || 'bff→ingest.vote_event INSERT'; END IF;
  IF has_table_privilege('bff_role','serve.vote_current','UPDATE') THEN bad := bad || 'bff→serve.vote_current UPDATE'; END IF;
  IF has_table_privilege('bff_role','serve.page_current','UPDATE') THEN bad := bad || 'bff→serve.page_current UPDATE'; END IF;
  IF has_table_privilege('bff_role','app.page_view_event','DELETE')THEN bad := bad || 'bff→app.page_view_event DELETE'; END IF;
  -- (b) 采集器不能直写事实表
  IF has_table_privilege('ingestor_role','ingest.vote_event','INSERT')  THEN bad := bad || 'ingestor→ingest.vote_event INSERT'; END IF;
  IF has_table_privilege('ingestor_role','serve.vote_current','UPDATE') THEN bad := bad || 'ingestor→serve.vote_current UPDATE'; END IF;
  -- (c) 投影器不能写 Tier-1，但必须能写 Tier-2
  IF has_table_privilege('projector_role','serve.page_current','UPDATE') THEN bad := bad || 'projector→serve.page_current UPDATE'; END IF;
  IF NOT has_table_privilege('projector_role','serve.page_stats','UPDATE') THEN bad := bad || 'projector 缺 serve.page_stats UPDATE'; END IF;
  -- (d) 正向：采集器必须能调 apply_vote_snapshot（否则整条摄入链断）
  IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='ingest' AND p.proname='apply_vote_snapshot'
        AND has_function_privilege('ingestor_role', p.oid, 'EXECUTE'))
  THEN bad := bad || 'ingestor 缺 ingest.apply_vote_snapshot EXECUTE'; END IF;
  -- (e) 列级授权：bff 只能改已读态
  IF NOT has_column_privilege('bff_role','app.page_metric_alert','acknowledged_at','UPDATE')
    THEN bad := bad || 'bff 缺 page_metric_alert.acknowledged_at UPDATE'; END IF;
  IF has_column_privilege('bff_role','app.page_metric_alert','new_value','UPDATE')
    THEN bad := bad || 'bff 能改 page_metric_alert.new_value（应被拒）'; END IF;

  IF array_length(bad,1) > 0 THEN
    RAISE EXCEPTION '[9002 §10] 权限边界自检失败：%', array_to_string(bad, ' | ');
  END IF;
  RAISE NOTICE '[9002 §10] 权限边界自检全部通过（8 条负向 + 2 条正向）';
END $$;

-- (f) PUBLIC 不能执行任何 apply_*（这一条不依赖角色，无条件强校验）
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM pg_proc p JOIN pg_namespace n2 ON n2.oid = p.pronamespace
  WHERE n2.nspname='ingest' AND p.proname LIKE 'apply\_%'
    AND has_function_privilege('public', p.oid, 'EXECUTE');
  IF n > 0 THEN
    RAISE EXCEPTION '[9002] PUBLIC 仍可 EXECUTE % 个 apply_* 函数 —— "权限即边界"从这里漏光', n;
  END IF;
  RAISE NOTICE '[9002] PUBLIC 对 apply_* 的 EXECUTE 已全部收回（0 个）';
END $$;

COMMIT;


-- =====================================================================================
-- 11. 登录账号模板（需 CREATEROLE，故留在事务外并注释掉，由 DBA 按环境填写）
-- =====================================================================================
-- CREATE ROLE scpper_bff       LOGIN INHERIT PASSWORD '***' IN ROLE bff_role;
-- CREATE ROLE scpper_ingestor  LOGIN INHERIT PASSWORD '***' IN ROLE ingestor_role;
-- CREATE ROLE scpper_projector LOGIN INHERIT PASSWORD '***' IN ROLE projector_role;
-- CREATE ROLE scpper_avatar    LOGIN INHERIT PASSWORD '***' IN ROLE avatar_worker_role;
-- -- migration_role 不建常驻登录账号；迁移窗口临时 GRANT 给执行者，窗口结束立刻：
-- --   REVOKE migration_role FROM <执行者>;
--
-- 组角色是 NOINHERIT，但登录账号建成 INHERIT 即可自动获得权限（应用侧不用改连接初始化）。
-- =====================================================================================
