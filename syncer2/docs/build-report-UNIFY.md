# UNIFY：采集整轮健康判据与 v1 图片复用核算

## 技术摘要

本次把“对象级局部失败不直接决定整轮”收敛为 `src/work/runHealth.ts` 的单一判据，并接入全部现有采集 CLI。对象级失败仍保留 `failed`/终态证据；只有可重试失败进入比例分子。HTTP breaker、连续失败上限、零进展、失败比例过高、同签名跨轮重复失败以及解析/数据红线仍会让进程非零退出。

`thread breadcrumbs 缺 category id/title` 经既有 `classifyWorkFailure('forum', ...)` 归为 `structural / irreconcilable`。迁移 `0052_forum_target_terminal_state.sql` 已先于依赖代码应用到 `scpper-v2`，该对象会写入 `meta.forum_scan_task.terminal_*`，释放锁、停止退避，并从后续认领与 pending 口径排除。

图片核算在零 HTTP、v1 服务端只读、两库各自 `REPEATABLE READ READ ONLY` 快照下完成。按 v2 当前 URL 口径和 v1 实际 READY 文件校验，安全可直接复用率为 **43,403 / 66,371 = 65.3945%**；若只问“存在至少一个候选文件”，毛命中为 43,557 / 66,371 = 65.6266%，其中 154 个 URL 对应多个 SHA，不能自动选取。

## 1. 统一 run health

### 1.1 判据

`evaluateRunHealth` 的输入统一为 claimed、processed、partial、failed、deterministicFailures、deferred、repeatedFailures 以及系统性红线。当前规则如下：

| 信号 | 整轮结果 |
| --- | --- |
| breaker 打开 | `aborted`, exit 1 |
| claimed > 0 且 processed = 0 | `failed`, exit 1 |
| 可重试失败至少 2 个，且 `retryableFailures / processed >= 25%` | `failed`, exit 1 |
| 同一可重试失败跨轮达到第 3 次 | `failed`, exit 1 |
| 连续失败上限或 CLI 提供的 fatal reason | `failed`, exit 1 |
| 仅有少量失败、partial、时间预算收尾或写冻结延后 | `partial`, exit 0 |
| 无上述信号 | `ok`, exit 0 |

失败率分子严格为 `failed - deterministicFailures`，分母仍为全部 processed。确定性口径不维护第二份错误词表：对象先经 `classifyWorkFailure`，`action !== retry` 才是确定性失败；CLI 只负责把已终结计数交给共享判据。

自适应出口降档沿用同一个决策对象：预期恢复窗口内、且唯一问题只是降档造成的零进展时允许 `partial / exit 0`；恢复期限已过仍为 `failed / exit 1`。原 work-queue 导出名只作为兼容别名，新代码直接调用通用函数。

### 1.2 接入范围

| CLI | 调度/职责 |
| --- | --- |
| `incremental-scan.ts` | L0 / L1 增量 |
| `sitemap-scan.ts` | L2 全站、论坛 sitemap audit |
| `tier1-scan.ts` | L3 / Tier1 |
| `work-queue.ts` | 页级深扫队列 |
| `forum-incremental.ts` | forum-discovery |
| `forum-scan.ts` | forum-consume |
| `image-ingest.ts` | 图片 worker |
| `resolve-pages.ts` | pending page 身份解析 |
| `revision-source-backfill.ts` | 修订源码回填 |
| `reconcile.ts` | 对账采集工具健康 |
| `vote-multiplicity-converge.ts` | 投票多重集收敛 |
| `vote-replay.ts` | 投票重放 |

`tests/run-health.test.ts` 会枚举两类入口：所有调用 `startIngestRun` 的 CLI，以及 `package.json` 中除明确非采集任务外的全部 `schedule:*`。每个入口必须直接 import 并调用 `evaluateRunHealth`；新增采集调度而未接入会自动失败。`oldest-pending`、`page-scan-maintenance`、`project` 是明确列出的非采集任务，不在此判据范围。

## 2. forum-consume 确定性终态

### 2.1 breadcrumbs 结构异常

实测错误 `ForumViewThreadModule ... thread breadcrumbs 缺 category id/title` 不是链路、限流或共享前置失败；同一响应在相同解析代码下重试不会恢复。因此定性为：

- family：`structural`
- action：`irreconcilable`
- task state：保留任务行并写 `terminal_at`、`terminal_family='structural'`、`terminal_reason`
- retry：无；`not_before=NULL`，不再认领，也不计 pending
- run accounting：计入对象级 failed 和 deterministicFailures，不进入失败率分子

`no_thread` / `invalid_thread` 同样保留对象级 `failed` 语义，但错误包含 `ForumViewThreadModule status=...`，经同一个分类器直接进入确定性终态。这样不会把“对象不存在”伪装成成功快照，也不会恢复成过去的无限重试或整轮非零退出。

### 2.2 目标场景

`claimed=46, processed=46, succeeded=45, failed=1, deterministicFailures=1` 的共享裁决为：

- retryableFailures = 0
- failureRate = 0
- status = `partial`
- exitCode = 0

与此相对，5/20 可重试失败、claimed=10 但 processed=0、或任一对象同签名达到第 3 次，测试均断言 exit 1。

## 3. 图片资产真实复用率

### 3.1 数据范围与方法

统计脚本为 `experiments/analyze-v1-image-reuse.ts`。最终快照开始于北京时间 **2026-08-09 06:34:50**：

- v2：79,234 个 `meta.image_ingest_job`，66,371 个唯一 `normalized_url`；
- v1：47,281 个 READY `ImageAsset`，200,775 个已解析 `PageVersionImage` 引用；
- 文件系统：47,279 个 READY 主文件存在，2 个缺失；47,281 个 `storagePath` 全部符合 SHA256 三级分片与文件名；
- v1 连接继续使用 `SYNCER2_V1_DATABASE_URL` 的服务端只读强制，脚本另加可重复读只读事务；
- 只执行数据库 SELECT 与本地 `stat`，没有图片请求、Wikidot 请求、目录写入或文件搬运。

匹配按以下互斥首次命中阶段统计，并在最终按所有候选 SHA 合并去歧义：

| 阶段 | 新增命中 URL | 累计说明 |
| --- | ---: | --- |
| v1 `ImageAsset.canonicalUrl` 精确匹配 | 17,703 | 26.6728%，对应原先约 26.6% 的口径 |
| canonical URL 套用 v2 归一化 | 23,990 | 最大低估来源 |
| v1 `PageVersionImage.normalizedUrl` 精确匹配 | 1,280 | 原始引用键，不是下载后的 final URL |
| reference URL 套用 v2 归一化 | 584 | 补齐两侧口径差 |
| 至少一个可用 SHA | 43,557 | 65.6266% 毛命中 |
| 唯一 SHA，可安全自动复用 | **43,403** | **65.3945%** |
| 多 SHA 歧义 | 154 | 0.2320%，必须重抓或另行裁决 |
| 无 v1 候选 | 22,814 | 34.3734% |

用户先前的 17,656 / 66,257 与本快照的 17,703 / 66,371 差异来自 v1/v2 仍在运行产生的自然增长；同一“canonical URL 精确匹配”口径仍是 26.6%。

### 3.2 低估来自哪些规则

第一层口径错误是字段语义不同：v2 `normalized_url` 是页面抽取引用的归一键，v1 `ImageAsset.canonicalUrl` 常是下载/重定向后的 canonical URL。加入 v1 `PageVersionImage.normalizedUrl` 后，额外找回 1,864 个 URL。

第二层是归一化差异。下列计数允许重叠，表示“仅在归一化阶段首次命中的 URL”涉及的规则，不可相加：

| 规则 | 涉及 URL |
| --- | ---: |
| 主机或路径大小写折叠 | 23,942 |
| `*.wikidot.com/local--files` 变换为 `*.wdfiles.com` | 12,149 |
| wdfiles 路径中的 `%3A` / `%2F` 解码 | 6,212 |
| 去掉 query / fragment | 392 |
| 合并路径重复斜杠 | 20 |
| 其他 URL 序列化差异 | 6 |

当前数据中，http→https、协议相对 URL 和默认端口归一化没有产生独占新增命中；它们仍由 v2 正常化函数处理，但不是本次 26.6%→65.4% 的实际主因。

“安全可复用”表示同一 v2 归一键在本地只解析到一个现存 READY SHA；它不声称远端内容今天仍与历史下载完全相同。154 个多 SHA URL 正是 URL 内容随时间变化或旧口径冲突的可见证据，因此没有把它们算入自动复用。

## 4. 方案建议

建议选择 **v2 独立目录 + 读取时按 SHA 回退 v1 目录**，本任务不实施，等待用户拍板。

理由：

1. 65.3945% 的安全命中足够高，独立重抓会重复下载约 43,403 个已有对象；不应因剩余 34.4% 放弃复用。
2. v1 仍在运行，共享同一可写目录会把锁、权限、清理与部署生命周期耦合；独立 v2 写目录保持故障域清晰。
3. 两侧都是 SHA256 内容寻址，读路径可按 `v2_root/<sha path>` → `v1_root/<sha path>` 回退，不需要复制 22 GB，也不向 v1 写入。
4. 仅导入“归一 URL → 唯一 READY SHA”的只读映射；154 个歧义 URL、2 个缺失文件及 22,814 个未命中 URL继续走 v2 当前下载流程。

实施时应把 v1 根目录以只读方式挂载给 v2，并保持 v2 的状态机、写入、校验和清理只作用于 v2 根目录。共享可写目录与全量独立重抓均不推荐。

## 5. 验证、限制与遗留

- `0052_forum_target_terminal_state.sql` 已应用到 `scpper-v2` 后才启用代码字段；迁移后 terminal 行持锁数为 0。
- `npx tsc --noEmit`：通过。
- 专项回归：统一健康、CLI 覆盖、论坛终态、forum/work-queue 路径均通过。
- `npm test`：455/455 通过，exit 0。此前唯一稳定失败为旧 `no_thread` 对象状态契约，已通过实现对齐为“对象 failed、整轮排除”修复，未改测试断言。
- 既有 `checks/0005_pending_collection_coverage.sql` 当前会被 0044 新增但未登记的 `meta.forum_incremental_category_state` 拦截；这是本次迁移前已存在的 registry 缺口，本次没有越权猜测它应归为 covered 还是 not_pending。新增采集 CLI 的 run-health 机制检查本身已通过。
- 没有移动 22 GB、没有修改 v1 目录、没有外站图片请求、没有 QQ 操作、没有 commit 或 push。

请求范围内无代码或数据阻塞。待用户决策项只有图片目录方案是否按上述第二项实施。
