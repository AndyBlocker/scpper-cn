-- 图片失败分类新增两个主机级状态。
--
-- 事故：代码里加了 host_unresolvable 与 host_deferred，却没同步 CHECK 约束，
-- 于是 image-ingest 每轮在写失败记录时违反约束、整个进程 1 秒内崩溃退出，
-- 而队列里有两万多个可做任务。日志表现为「跳过逻辑正常 + 立刻 exit 1」，
-- 极易被误读为限速问题。
--
-- host_unresolvable：DNS 解析不了，域名已消失（实测 acsurlexample.com 返回 HTTP 000，
--   那是文章里的示例占位 URL）。与 http_permanent 同级，确定性、不驱动退让。
-- host_deferred：主机放行时间过远（按主机限速降档所致），本轮主动跳过留给下轮。
--   它是限速层的**正常输出**而非压力来源；当作压力会自我放大。

BEGIN;

ALTER TABLE meta.image_ingest_job
  DROP CONSTRAINT IF EXISTS image_ingest_job_failure_class_ck;

ALTER TABLE meta.image_ingest_job
  ADD CONSTRAINT image_ingest_job_failure_class_ck
  CHECK (
    failure_class IS NULL
    OR failure_class = ANY (ARRAY[
      'http_transient', 'http_permanent', 'timeout', 'network',
      'too_large', 'invalid_content_type', 'invalid_url', 'blocked_host',
      'storage', 'unknown',
      'host_unresolvable', 'host_deferred'
    ])
  );

COMMIT;
