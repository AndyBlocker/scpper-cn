-- 「最老的待处理项等了多久」——统一巡检。
--
-- 为什么需要这张表以外的东西：常规健康指标衡量的是「做了多少」——吞吐、完成数、
-- 失败率、队列深度。而 2026-08 这一周暴露的五个问题全是「什么一直没被做」：
--
--   · work-queue 排队饥饿：votes_full 饿 6.8 天，而配额轮轮打满、任务全部成功、失败率 0
--   · 身份过期：同一任务重试 82 次，退避机制「正常工作」
--   · 已删页僵尸任务：184 个，不产生日志、不触发失败，却污染每一项队列观测
--   · 惊群：33,191 页同刻到期，到期前完全不可见
--   · 装饰品常量：改了没反应，而改的人以为生效了
--
-- 五个问题没有一个是被监控发现的，全部是排查别的事时偶然撞见。
-- 共同点：它们与「做了多少」正交，只有「最老的那个等了多久」能看见。
--
-- 该指标的性质：系统健康时恒定很小；任何形式的饥饿、卡死、遗漏都会让它单调上升；
-- 且**不会被平均值掩盖**——均值会把正常快速通过的多数与卡死的少数混在一起
-- （实测教训：「realtime 任务平均等待 130 小时」的真相是 65 个僵尸拉高了均值，
-- 真实值 2.5 分钟）。因此这里一律取 max/min 极值，不取平均。

\set ON_ERROR_STOP on

WITH pending AS (
  -- 1) 扫描任务：按 kind 分开。合并会让小 kind 被大 kind 淹没。
  SELECT 'scan_task:' || kind AS 集合,
         count(*) AS 待处理,
         max(extract(epoch FROM now() - created_at) / 3600) AS 最老小时
    FROM meta.scan_task
   GROUP BY kind

  UNION ALL
  -- 2) 源码回填作业：done 之外的都算待处理。
  SELECT 'revision_source_backfill:' || status,
         count(*),
         max(extract(epoch FROM now() - updated_at) / 3600)
    FROM meta.revision_source_backfill_job
   WHERE status <> 'done'
   GROUP BY status

  UNION ALL
  -- 3) 未决的不可调和项：它们按定义是「已知无法自动解决」，但不该无限期积压。
  -- kind 当前混入了实例 id（`revision_source:833863`，1,108 个不同取值中 1,101 个带冒号），
  -- 直接 GROUP BY 会炸成上千行。这里按冒号前的类型归并——
  -- 但这是**巡检侧的补偿**，真正该修的是那一列本身（类型与实例应当分开）。
  SELECT 'irreconcilable:' || split_part(kind, ':', 1),
         count(*),
         max(extract(epoch FROM now() - first_seen) / 3600)
    FROM meta.irreconcilable
   WHERE resolved_at IS NULL
   GROUP BY split_part(kind, ':', 1)

  UNION ALL
  -- 4) 投影游标滞后：projection_cursor 长期不推进 = 投影静默停摆。
  --    只看已启用的投影（last_seq > 0）；恒为 0 的是明确延后的功能，不是停摆。
  SELECT 'projection_cursor:' || projection,
         1,
         extract(epoch FROM now() - updated_at) / 3600
    FROM meta.projection_cursor
   WHERE last_seq > 0

  UNION ALL
  -- 5) 悬挂 run：进程被杀/数据库重启时写终态那步没机会执行，行会永远停在 running。
  SELECT 'ingest_run:running',
         count(*),
         max(extract(epoch FROM now() - started_at) / 3600)
    FROM meta.ingest_run
   WHERE status = 'running'

  UNION ALL
  -- 6) 持续漂移：v2 投影与 L1 观测长期对不上的页面。
  --    这一项的「年龄」用最后观测时刻，不用 consecutive_observations——
  --    后者是次数不是时长，混进同一列会得出「524 小时」这种荒谬读数（本文件初版的错误）。
  SELECT 'drift_state:' || kind,
         count(*),
         max(extract(epoch FROM now() - first_detected_at) / 3600)
    FROM meta.incremental_drift_state
   WHERE resolved_at IS NULL
   GROUP BY kind

  UNION ALL
  -- 7) 最久未取得完整投票快照的 live 页。这是新鲜度的下界证据：
  --    L1 只看计数器，明细要靠 votes_full 落地。
  SELECT 'page:oldest_vote_snapshot',
         count(*) FILTER (WHERE last_complete_vote_snapshot_at IS NULL),
         max(extract(epoch FROM now() - last_complete_vote_snapshot_at) / 3600)
    FROM serve.page_current
   WHERE status = 'live'
)
SELECT 集合,
       待处理,
       round(最老小时::numeric, 1) AS 最老小时,
       CASE
         WHEN 最老小时 IS NULL THEN '—'
         WHEN 最老小时 > 168 THEN 'CRIT 超一周'
         WHEN 最老小时 > 24  THEN 'WARN 超一天'
         ELSE 'ok'
       END AS 判定
  FROM pending
 WHERE 待处理 > 0 OR 最老小时 IS NOT NULL
 ORDER BY 最老小时 DESC NULLS LAST;
