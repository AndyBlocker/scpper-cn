# syncer2 大规模简化与死代码清理报告

日期：2026-08-27（Asia/Shanghai）  
基线：`ec0ff93`  
工作目录：`/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation`

## 结论

本轮退役了已经完成且没有安全重放路径的 S1 全量、S2、S3、S4–S6 一次性历史回填，
删除 16 个文件、10 个 package script 和 1 个生产依赖。整个 diff 删除 8,749 行；新增行
主要是 tests 类型修复、活库并发下的测试快照隔离、RUNBOOK 更新和本报告。没有新增迁移，
没有运行 deploy、commit、push，也没有触碰 qqbot 或发送 QQ 消息。

最终 `./deploy/run-gates.sh` 全绿：主源码 tsc、tests tsc、582/582 tests、全部 numbered
SQL checks 和 shell checks 均通过。

## 前后规模

统计口径是 git 跟踪的 `*.ts` 物理行；因此 tests 包含 `tests/helpers`，与任务描述中只数
测试入口的 63 文件口径不同。基线按 `git show ec0ff93:<path>` 重算，当前按工作树重算。

| 项目 | 基线 | 当前 | 变化 |
|---|---:|---:|---:|
| `src/**/*.ts` 文件 | 129 | 120 | -9 |
| `src/**/*.ts` 行 | 65,778 | 58,538 | -7,240 |
| `tests/**/*.ts` 文件 | 66 | 64 | -2 |
| `tests/**/*.ts` 行 | 20,597 | 20,315 | -282 |
| tests 用例 | 595 | 582 | -13 |
| package scripts | 82 | 72 | -10 |
| 生产依赖 | 7 | 6 | -1 |
| devDependencies | 5 | 5 | 0 |

少掉的 13 个用例逐一来自退役文件：`backfill-s2.test.ts` 3 项，
`backfill-s456.test.ts` 10 项；没有删除活路径测试。

## 分析方法与人工复核

1. 运行 `knip 6.32.3` 全仓扫描；初扫为 6 个未使用文件、1 个未使用生产依赖、
   2 个 devDependency 候选、114 个 unused exports 和 81 个 unused exported types。
2. 运行 `ts-prune 0.10.3` 交叉检查；它把大量“仅模块内使用”的导出也列出，逐项与
   `rg`、package scripts、tests、shell、systemd、文档化手工入口复核，不直接按工具输出删除。
3. 额外运行 `tsc --noUnusedLocals --noUnusedParameters`。剩余 5 项全部位于用户指定红线：
   deletion 的常量/claim/release、ListPages partial 扫描入口、forum 公平调度参数；按红线
   要求保持零 diff，没有为追求工具零输出改动其逻辑。
4. 对 package scripts、systemd units、deploy 脚本、tests 和文档执行文件名/符号反查。
5. 只读查询 `scpper-v2` 的 `meta.ingest_run`、`meta.backfill_progress`、队列/游标，以及
   `scpper-cn` 的当前源水位；时间窗口以本次审计日向前 30 天为准。
6. PostgreSQL 当前 `app/ingest/meta/serve` 共 79 个函数，逐名对照 TS/SQL 调用、函数体
   调用和 trigger 绑定。数据库 `track_functions=none`，未把“不存在统计”伪装成零调用。

最终 Knip 原始输出仍有 5 个“未使用文件”、35 个 exports、27 个 types：其中 32/26
是语义红线文件为保持零 diff 而保留的公共表面；另 3/1 是手工实验
`extract-vs-crom.ts` 的导入。它们的保留证据见下文。两个 Prisma devDependencies 和
`psql` 也是静态工具不解析 shell 导致的假阳性。

## 删除清单与证据

### 一次性回填子系统

| 退役项 | 删除文件 | 静态证据 | 运行时证据 |
|---|---|---|---|
| S1 全量身份回填 | `src/backfill/s1.ts`, `id-policy.ts` | 唯一入口是已删 package scripts；无 systemd/deploy 调用 | `meta.backfill_progress`: page 47,880/47,880、user 37,894/37,894，2026-07-28 完成 |
| S2 内容/修订回填 | `s2.ts`, `s2-model.ts`, `tests/backfill-s2.test.ts` | 除自身、3 项专属测试和历史迁移注释外无引用 | run 78=`ok/completed=true`；content 69,577/69,577、source 77,248/77,248、revision 518,385/518,385，2026-07-28 完成 |
| S3 投票回填/补救/签核 | `s3.ts`, `s3-live-remediate.ts`, `s3-deleted-signoff.ts` 及 4 个 `checks/backfill_s3_*.sql` | 入口只来自已删 scripts；阶段 checks 不在 numbered checks 运行面 | run 88=`ok/completed=true`；history 1,339,436/1,339,436，2026-07-28 完成 |
| S4–S6 署名/生命周期/版本映射 | `s456.ts`, `s456-model.ts`, `tests/backfill-s456.test.ts` | 除自身、10 项专属测试和历史迁移注释外无引用 | run 113=`ok`；attribution 47,848/47,848、created 47,880/47,880、deleted 11,815/11,815，2026-07-28 完成 |

历史迁移文件没有改动；旧文件名只在 migrations 的历史说明中保留。两份 2026-07-28
S3 报告已明确标成历史快照，移除对已退役 check 文件的失效链接。RUNBOOK 不再给出不可执行
的 S1–S6 命令。

### 其它死文件、符号和配置

| 项目 | 证据与处理 |
|---|---|
| `experiments/dump-extract.ts` | Knip 命中；7 行临时文件，文件名拼写用途不明，repo 零引用，删除 |
| `@ukwhatn/wikidot` | package 中存在但源码、tests、scripts 零 import；README 自认未使用，删除依赖并修正文档 |
| 129 个无外部消费者的 export modifier | Knip/ts-prune 命中；逐项确认仍在模块内使用后仅收窄可见性，不删实现 |
| 论坛增量 | 删除零调用的 `changedForumCategoryIds`；保留活用的 `forumCategorySignalChanged` |
| 修订源码 | 删除匿名旧入口 `scanRevisionSourcesOnDemand`；authenticated worker 路径保留 |
| revision diff | 删除未调用的网络包装 `fetchRevisionDiff`；解析/patch 及取证实验保留 |
| sitemap | 删除零调用的排除前缀/判断、activity-head 和相关死包装；现役 fetch family 保留 |
| 内容提取 | 删除只被 S2 使用的 `extractTextFromWikidotSource`；HTML 正文提取和 v1 分块复现实验保留 |
| 观测/存储 | 删除零调用的 `businessHttpStatusDistribution`、`fetchLiveSlugs` 和装饰性窗口常量 |
| run health | 删除旧 `WorkQueue*` 类型/常量/函数别名；所有生产 CLI 继续直接使用统一 `evaluateRunHealth` |
| 配置/导入 | 删除零绑定的 `REVISION_SOURCE_PAGE_SCAN_KIND` 等装饰性常量及随之无用的 imports |

这些符号删除后，主源码与 tests tsc 都为零错误；因此不存在仍由 TypeScript 活路径引用的
已删符号。没有用 `any`、可选链或放宽断言掩盖错误。

### 删除的 10 个 scripts 及调用方消失证据

| scripts | 原入口 | 处理 |
|---|---|---|
| `backfill:s1:dry`, `backfill:s1` | `src/backfill/s1.ts` | S1 全量入口及实现一起退役 |
| `backfill:s2:dry`, `backfill:s2` | `src/backfill/s2.ts` | S2 入口及实现一起退役 |
| `backfill:s3:dry`, `backfill:s3` | `src/backfill/s3.ts` | S3 入口及实现一起退役 |
| `backfill:s3:live-dry` | `src/backfill/s3-live-remediate.ts` | 专属补救入口及实现一起退役 |
| `backfill:s3:deleted-signoff` | `src/backfill/s3-deleted-signoff.ts` | 专属签核入口及实现一起退役 |
| `backfill:s456:dry`, `backfill:s456` | `src/backfill/s456.ts` | S4–S6 入口及实现一起退役 |

反查 package、systemd、deploy 和现役 RUNBOOK 后无剩余调用方；`operations.test.ts` 中两个
仅用于枚举已删 S2/S3 出站入口的文件名也同步删除。保留 `backfill:s1:top-up:*`、
`backfill:forum:*`、`gate:load-v1` 和 `gate:backfill:*`，因为它们仍有下述活用途。

## 评估后保留的回填/迁移路径

| 保留项 | 为什么仍可能使用（只读证据） |
|---|---|
| S1 identity top-up + `s1-model.ts` | dry-run：v1 page/user=48,906/38,120，v2=48,954/43,399；仍缺 35 page、29 user，且有 1,603 冲突，故保留但在冲突解决前不得 execute |
| forum v1 backfill | 上次完整水位 90,303 threads/551,612 posts（run 1881 `ok`, 2026-07-29）；v1 当前已增至 92,009/562,493，且 2026-08-27 仍更新，需可追增量 |
| view migration | v2 游标 2026-08-06 停在 PageView 1,249,270、Pixel 299,896；v1 当前 max 已到 1,348,439/318,994，明显仍增长；UserPageView 74,613 已齐 |
| `image/v1Import.ts` | v1 当前 READY 48,132，最后更新 2026-08-27 22:10；v2 v1 aliases 47,385 canonical +49,238 page-version，最后导入 2026-08-11，仍需追增量 |
| revision-source backfill | 当前 354,872 done +147 skipped_deleted，最后更新 2026-08-27 21:55；半小时 timer 仍启用，不能退役 |
| vote multiplicity converge CLI | 2026-08-03 手工 run 处理 518 页（509 ok/8 failed/1 partial）；该差异可由后续采集重现，且 operations test 明确把它列为生产出站入口 |

### Knip “未使用文件”保留裁决

| 文件 | 保留证据 |
|---|---|
| `experiments/analyze-v1-image-reuse.ts` | `build-report-UNIFY.md` 指定的可复算统计脚本 |
| `experiments/extract-vs-crom.ts` | README、embedding 迁移文档和 `extract-fetch.sh` 的离线复现实验入口；使用 3 个函数+1 个类型导出 |
| `experiments/revision-diff-forensics.ts` | `docs/revision-diff-27409-870095552/analysis.md` 指定的事故取证复现入口 |
| `prisma/schema.header.prisma` | `prisma/pull.sh` 第 30 行直接读取并拼回 schema；`prisma`/`@prisma/client` 也由该 shell 工作流调用 |
| `src/cli/vote-multiplicity-converge.ts` | 手工 CLI，无 package script；30 天内有 run 10802，见上表 |

## SQL 函数审计

79 个现存函数中，除以下 3 个外，均能找到 TS/checks/smoke 的调用、另一函数的调用或
trigger 绑定。没有扩大 `checks/0006` 的失败面。

| 零生产源码调用候选 | 实际引用/权限 | 裁决 |
|---|---|---|
| `ingest.apply_vote_history(...)` | migration smoke 有多次行为调用；授予 `ingestor_role`/`migration_role`；投票语义红线 | 保留，不能仅按 TS 零引用删除 |
| `ingest.put_content_blob_sha(...)` | `0002_write_freeze_wiring.sql` 做结构接线检查；授予 `ingestor_role`/`migration_role` | 外部 SQL API 且无函数统计，无法证明 30 天零调用，保留 |
| `serve.normalize_target_slug(text)` | 0009 数据回填与 smoke 调用；授予 `migration_role` | 迁移兼容 API；删除需要新 schema migration，当前证据不足，保留 |

这三项不是“已证明死但遗漏删除”：数据库未启用调用统计，且都存在 repo 外可执行授权。
在没有先启用函数统计并观察完整窗口、确认外部调用方之前，DROP 会违反证据驱动要求。

## tests 类型检查与门禁稳定性

`tsconfig.tests.json` 已存在但此前未挂进发布门禁。本轮把 `npm run typecheck:tests` 接到
`deploy/run-gates.sh` 的主 tsc 之后、tests 之前，并修复原有 16 个错误（5 个文件）：

- union error 分支显式收窄；
- projector projection row 使用实际结果类型；
- restricted-session stub 补齐结构，不伪造窄接口；
- nullable fingerprint/marker 显式处理；
- assertions 保持原强度。

首次全量复验遇到两次活库并发噪声：revision-source 在迁移指纹两次读取之间补写（定向
复验 3/3 通过），以及 B1 全站投影在约 24 秒重建和断言之间收到新的 vote_current 写入。
后者不弱化断言，只把测试 fixture 事务改成 `REPEATABLE READ`，让跨语句比较共享同一数据库
快照；定向复验和随后完整门禁均通过。

最终门禁：

- `npx tsc --noEmit`：PASS；
- `npm run typecheck:tests`：PASS，0 errors；
- `npm test`：582 pass / 0 fail / 90 suites；
- numbered SQL checks：全部 PASS；
- numbered shell checks：全部 PASS；
- `./deploy/run-gates.sh`：`PASS start=2026-08-27T14:05:41Z finish=2026-08-27T14:09:20Z`。

## 语义红线与两个大文件

对下列文件逐个执行 `git diff --name-only`，结果为 **0 个文件有 diff**：

- 出口令牌桶：`http/adaptiveEgress.ts`, `http/egressCapacity.ts`；
- 调度公平性：`store/workQueue.ts`, `work/forumOrder.ts`；
- 删除证据/部分覆盖：`collect/deletion.ts`, `collect/listpages.ts`,
  `work/l1PartialCoverage.ts`；
- 幂等快照：`collect/votes.ts`, `store/snapshot.ts`；
- 写冻结：`health/parseHealth.ts`。

因此公平性分带老化/保底、出口令牌桶、写冻结、幂等快照、删除证据链和 partial coverage
没有逻辑字符变化。`http/adaptiveEgress.ts` 与 `store/workQueue.ts` 两个大文件均未拆分、
最终零 diff；收益不足以抵消事故语义风险。

## 最终 git diff --stat

以下为命令原样输出；新建且未暂存的本报告按 git 语义不出现在 `git diff --stat` 中。

```text
 syncer2/README.md                               |    5 +-
 syncer2/checks/backfill_s3_deleted_targets.sql  |  134 --
 syncer2/checks/backfill_s3_dryrun.sql           |  428 -------
 syncer2/checks/backfill_s3_live_targets.sql     |  122 --
 syncer2/checks/backfill_s3_user_attribution.sql |  289 -----
 syncer2/deploy/run-gates.sh                     |    3 +
 syncer2/docs/RUNBOOK.md                         |   82 +-
 syncer2/docs/embedding-migration.md             |    5 +-
 syncer2/docs/s3-dry-run-2026-07-28.md           |    6 +-
 syncer2/docs/s3-user-attribution-2026-07-28.md  |    5 +-
 syncer2/experiments/dump-extract.ts             |    7 -
 syncer2/package.json                            |   11 -
 syncer2/src/backfill/id-policy.ts               |   52 -
 syncer2/src/backfill/s1-model.ts                |    4 +-
 syncer2/src/backfill/s1.ts                      |  873 -------------
 syncer2/src/backfill/s2-model.ts                |  108 --
 syncer2/src/backfill/s2.ts                      | 1461 ---------------------
 syncer2/src/backfill/s3-deleted-signoff.ts      |  543 --------
 syncer2/src/backfill/s3-live-remediate.ts       |  625 ---------
 syncer2/src/backfill/s3.ts                      | 1458 ---------------------
 syncer2/src/backfill/s456-model.ts              |  338 -----
 syncer2/src/backfill/s456.ts                    | 1568 -----------------------
 syncer2/src/collect/conventions.ts              |   30 +-
 syncer2/src/collect/files.ts                    |    2 +-
 syncer2/src/collect/forum.ts                    |    8 +-
 syncer2/src/collect/forumIncremental.ts         |   15 +-
 syncer2/src/collect/incrementalDiff.ts          |    4 +-
 syncer2/src/collect/l1Drift.ts                  |    8 +-
 syncer2/src/collect/restrictedListPages.ts      |    4 +-
 syncer2/src/collect/revisionDiff.ts             |   31 -
 syncer2/src/collect/revisionRegression.ts       |    2 +-
 syncer2/src/collect/revisions.ts                |    4 +-
 syncer2/src/collect/source.ts                   |   36 -
 syncer2/src/config.ts                           |    2 +-
 syncer2/src/content/extractImages.ts            |    4 +-
 syncer2/src/content/extractPageReferences.ts    |    4 +-
 syncer2/src/content/extractText.ts              |   77 +-
 syncer2/src/http/amc.ts                         |    2 +-
 syncer2/src/http/client.ts                      |    7 +-
 syncer2/src/http/restrictedSession.ts           |    2 +-
 syncer2/src/image/externalEgress.ts             |    2 +-
 syncer2/src/image/unreachableHosts.ts           |    2 +-
 syncer2/src/image/v1Import.ts                   |   10 +-
 syncer2/src/image/worker.ts                     |    4 +-
 syncer2/src/migrate/viewEvents.ts               |   10 +-
 syncer2/src/observability/egressAccounting.ts   |   11 +-
 syncer2/src/observability/oldestPending.ts      |    5 +-
 syncer2/src/project/consistency.ts              |    2 +-
 syncer2/src/project/pageReference.ts            |    1 -
 syncer2/src/project/types.ts                    |    2 +-
 syncer2/src/reconcile/crom.ts                   |    8 +-
 syncer2/src/reconcile/im.ts                     |    4 +-
 syncer2/src/reconcile/parity.ts                 |   24 +-
 syncer2/src/reconcile/triangle.ts               |    4 +-
 syncer2/src/reconcile/types.ts                  |    2 +-
 syncer2/src/sitemap/fetch.ts                    |   37 +-
 syncer2/src/store/db.ts                         |    2 +-
 syncer2/src/store/drift.ts                      |    2 +-
 syncer2/src/store/incremental.ts                |    2 +-
 syncer2/src/store/l1EnumerationSnapshot.ts      |    6 +-
 syncer2/src/store/meta.ts                       |   27 +-
 syncer2/src/store/pgText.ts                     |    2 +-
 syncer2/src/store/revisionSource.ts             |    2 -
 syncer2/src/store/v1RestrictedIdentity.ts       |    2 +-
 syncer2/src/util/log.ts                         |    4 +-
 syncer2/src/work/failurePolicy.ts               |    6 +-
 syncer2/src/work/identityCheck.ts               |    2 +-
 syncer2/src/work/runHealth.ts                   |   19 +-
 syncer2/tests/backfill-s2.test.ts               |   71 -
 syncer2/tests/backfill-s456.test.ts             |  229 ----
 syncer2/tests/forum.test.ts                     |    7 +-
 syncer2/tests/helpers/fixture.ts                |   10 +-
 syncer2/tests/helpers/report.ts                 |    2 +-
 syncer2/tests/operations.test.ts                |    2 -
 syncer2/tests/project-busy-gate.test.ts         |    7 +-
 syncer2/tests/projector.test.ts                 |    5 +-
 syncer2/tests/revision-source-auth.test.ts      |   22 +-
 syncer2/tests/t5-vote-batch.test.ts             |    2 +-
 syncer2/tests/vote-multiplicity.test.ts         |    1 +
 79 files changed, 182 insertions(+), 8749 deletions(-)
```

工作树没有 commit、push 或 deploy；无 schema 迁移待人工先行应用，无阻塞。
