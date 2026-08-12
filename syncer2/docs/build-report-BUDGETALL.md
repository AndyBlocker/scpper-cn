# BUDGETALL：v2 调度链路协作式时间预算

日期：2026-08-13  
分支：`scpper-backend-v2`  
范围：`syncer2`；没有 schema 变更，不涉及迁移。

## 结论

15 条 `schedule:*` 现在都显式传入 `--max-runtime-sec`，且 CLI 全部复用
`src/util/runtimeBudget.ts` 的 `addRuntimeBudgetOption()`、`RuntimeBudget.checkpoint()`
和统一摘要。预算是 systemd `TimeoutStartSec` 之前的协作式软闸：只在任务、批次、
游标或事务边界停下，允许正在进行的原子工作正常提交；预算命中锁存为
`stoppedByRuntimeBudget: true`，剩余工作计入 `deferred`，退出码为 0。

`work-queue` 原有 `RUN_BUDGET_MS` 保留为兼容导出并成为共享 CLI 参数的默认值；
为满足“预算不超过硬超时 60%”，从原来的 7 分钟收紧为 6 分钟。其原有“完成项结账、
未完成项释放锁、预算停机不算失败”的语义保持不变。

## 预算及实测依据

实测取数口径：优先使用 v2 `ingest_run.finished_at - started_at` 最近 30 天完成轮次；
没有对应 ingest run 的链路使用同周期 systemd journal 的进程墙钟时间。分位数只用于
确定正常轮次的量级；极端长尾由软预算截断，不能反过来把预算推近硬超时。

| 链路 | 实测墙钟依据 | 预算 | `TimeoutStartSec` | 占硬超时 | 取值说明 |
|---|---:|---:|---:|---:|---|
| l0 | p50 2.2s / p95 4.0s / max 87.1s（n=743） | 120s | 300s | 40.0% | 覆盖观测长尾，仍留 180s 收尾 |
| l1 | 已知约 57s/145 请求；近期 p50 85.9s / p95 103.3s（n=992） | 180s | 2700s | 6.7% | 约为近期 p95 的 1.7 倍；2195s 异常尾不再任其自然结束 |
| l2 | p50 13.4s / p95 24.1s / max 185.8s（n=367） | 240s | 600s | 40.0% | 覆盖已见最长正常轮，留 360s |
| l3 | p50 1052.3s / p95 1054.3s / max 1054.5s（n=3） | 1500s | 2700s | 55.6% | 周级全字段扫描按约 17.6min 实测放至 25min，留 20min 收尾 |
| resolve-pages | p50 0.9s / p95 2.4s / max 93.8s（n=4235） | 120s | 300s | 40.0% | 覆盖已见长尾，未处理 pending claim 批量归还 |
| work-queue | p50 4.1s / p95 7.9s / max 92.2s（n=4215） | 360s | 600s | 60.0% | 保留慢任务与限速余量，同时确保 4min 收尾窗口 |
| forum-discovery | p50 9.6s / p95 119.5s / max 316.8s（n=120） | 330s | 600s | 55.0% | 略高于观测最长轮，留 270s |
| forum-audit | p50 20.6s / p95 23.9s / max 24.6s（n=10） | 300s | 1800s | 16.7% | 保留整站线程清单增长空间，远离 30min 硬闸 |
| forum-consume | p50 435.2s / p95 516.2s（n=88，含超时前长轮） | 300s | 600s | 50.0% | 不再追随不可控长轮；约 5min 处理部分任务后释放余锁，留 5min |
| image-ingest | 既有已验证预算 | 300s | 600s | 50.0% | 保留既有值；单图原子完成后再停，留 5min |
| revision-source-backfill | p50 3.2s / p95 156.8s / max 358.1s（n=3741） | 200s | 360s | 55.6% | 覆盖 p95；异常长尾截断并由 `finally` 归还 source claim |
| reconcile | all p50 575.0s / p95 618.5s / max 620.8s（n=21）；CROM 540.8s | 720s | 1200s | 60.0% | 覆盖含 CROM 往返的正常轮，留 8min 持久化和收尾 |
| page-scan-maintenance | p50 2.2s / p95 2.5s / max 3.2s（n=366） | 60s | 300s | 20.0% | SQL 事务边界和可选 vacuum 之间停，留 4min |
| oldest-pending | p50 1.9s / p95 2.2s / max 2.3s（n=122） | 30s | 120s | 25.0% | 轻量快照链路，留 90s |
| project | p50 14.2s / p95 15.3s / max 26.2s（n=277） | 120s | 480s | 25.0% | 在 projection 事务之间停，留 6min |

## 优雅收尾与锁语义

- `resolve-pages` 新增批量 `releasePendingPageClaims()`：只释放本 worker 的未完成 claim，
  清空 `locked_by/locked_at`，并归还 claim 时增加的 `attempts`，任务可立即被下轮认领。
- `work-queue`、forum consumer 与 revision source 延续各自已有的释放函数；预算检查加入
  worker/批次边界，未开始项统一释放。L0/L1/L2/L3、project、reconcile 在事务或游标边界
  停止，已经提交的部分不回滚，快照只在完整完成时推进。
- `evaluateRunHealth()` 把“全部是主动 deferred、尚无 processed”的预算轮次视为 partial，
  不再误判 zero-progress failure；真实处理失败和 breaker 仍保持非零退出。

## 检查与回归

- `checks/0005_runtime_budget_vs_timeout.sh` 已从“CLI 不支持则 TODO”升级为缺显式预算、
  CLI 未接共享实现、缺 `TimeoutStartSec` 或预算超过 60% 任一情况即失败；对仓库内
  `deploy/systemd` 配置执行通过，15/15 均有至少 40% 硬超时余量。
- 新回归构造可控时钟：完成首个任务后跨过预算，断言预算锁存、剩余任务释放、
  `status=partial`、`exitCode=0`、摘要 `stoppedByRuntimeBudget=true`。
- 活库回归插入 pending fixture 后认领，再调用批量释放，断言锁立即清空且 attempts 归还；
  原有 work-queue 预算/锁释放测试继续通过。
- `npx tsc --noEmit`：通过。
- `npm test`：首轮 497/498（单个活库偶发项）；未改断言直接完整复跑 498/498 通过，
  82 suites、0 failed，总耗时 153.7s。
- `git diff --check`：通过。

## `TimeoutStartSec` 核对

无需调整现有硬超时。l1/l3 的 45min 为大扫描和原子尾部提供安全网，新预算分别只占
6.7%/55.6%；work-queue 10min 对 6min 预算留 4min；reconcile 20min 对 12min 预算
留 8min，足以完成报告持久化及连接/锁收尾。其余链路同样满足预算不超过硬超时 60%。

阻塞：无。
