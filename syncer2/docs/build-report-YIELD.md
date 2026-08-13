# YIELD — revision-source 让路活锁、长期停滞与测试写入门

> 执行日期：2026-08-13（Asia/Shanghai）  
> 工作树：`feat__syncer2-foundation` / 基线 `d942d18`  
> 数据库：`localhost:5434/scpper-v2`  
> 未 commit，未 push；未写 `/home/andyblocker/scpper-cn`，未碰 qqbot，未发 QQ。

## 1. 交付结论

`revision-source-backfill` 不再以“看到 L0/L1 running”为整轮退出条件。它仍观测并
记录实时链路活跃情况，但带宽让路交给既有 `background` 连续令牌桶（800/h、
capacity 400）和全局 FIFO。这个选择不依赖 timer 相位，且不再叠加一个会变成
永久阻塞的二次保护层。

生产四轮实测为 **0/4 跳过**，`pending attempts=0` 从 **1,741 降到 1,343**。
回填与 L1 在 10:24、10:29 发生真实重叠；L1 仍连续 `ok`，全站 36,538 页。

## 2. 让路机制与上界

### 2.1 生产逻辑

- `realtimeCollectionActive()` 保留为观测；`active.length > 0` 时记录
  `action=execute, coordination=background_token_bucket`，然后继续 probe / seed / claim。
- 删除 `stats.skipped=l0_l1_active` 的终止分支。管理员显式写冻结仍保留 fail-safe
  跳过；近 7 天实测该情况为 0 轮。
- 队列仍按 `not_before,page_id,ordinal` FIFO。未形成上游结果的预算中断/写冻结会
  归还 attempt 并把 `not_before` 更新到当时，因而不会让同一慢队头下轮原地自旋。
- 首轮还暴露出所有 `no_permission` 被错算为链路失败；现在按失败分类累计
  `deterministicFailures`，不再用“已满三次的 irreconcilable 数”代替。后三轮均 exit 0。

### 2.2 可推导、可断言的界

对一条持续 `due/live` 的任务，设它在当时有限 FIFO 中为 1-based 位置 `p`。在
timer 启用、写闸开放、Wikidot/网络可用且配额合同不漂移的前提下，每轮只取硬保守的
**1 次执行机会**，则：

```text
dispatch_upper_bound(p) = p × 30 minutes
```

不把 `--limit 300` 这个上限偷换为最低吞吐。对本轮基线 2,315 条队尾，绝对保守界是
2,315 轮 = **1,157.5 h = 48.23 d**。这个界是“获得执行机会”的调度界，不是在持续
网络故障、人工写冻结或 timer 被停用时伪造的完成界。

回归同时断言：

1. 10,000 个连续 `active=[l1/unknown]` 周期的决策全是 `execute`；
2. 生产入口不再包含 `l0_l1_active`；
3. timer 仍是 `:25/:55`，因此测试覆盖的是“相位仍对齐”而不是偷换为错峰；
4. 预算中断必须更新 FIFO 时钟并归还 attempt。

## 3. 四轮回填实测

| run | CST | status / exit | selected | processed | stored | deterministic | skipped | elapsed |
|---:|---|---|---:|---:|---:|---:|---:|---:|
| 26625 | 10:12:20 | failed / 1（口径修复前） | 244 | 244 | 0 | 244 | 0 | 198.606s |
| 26638 | 10:19:21 | partial / 0 | 291 | 291 | 0 | 291 | 0 | 198.695s |
| 26642 | 10:23:12 | partial / 0 | 51 | 51 | 0 | 51 | 0 | 198.602s |
| 26649 | 10:26:59 | partial / 0 | 45 | 45 | 0 | 45 | 0 | 198.593s |

四轮合计真正处理 631 条、整轮跳过 0。这一段队头均是 Wikidot 明确返回的
`no_permission`；所以没有伪造空源码，而是按确定性目标失败进入有界三试。第三、四轮是紧接
手工压测，background 突发 token 已耗尽，因此分别只处理 51/45；日志显示它们在令牌上
等待 145.9/149.6s，这是配额生效，不是整轮让路。

队列基线与四轮后对比：

| 状态 | 基线 | 四轮后 |
|---|---:|---:|
| pending / attempts=0 | 1,741 | **1,343** |
| retry | 574 | 1,205 |
| irreconcilable | 1,011 | 1,011 |
| done | 348,120 | 348,120 |

pending 净降 398；retry 上升是这 631 条 `no_permission` 的正常三试中间态。

### 排空估算

- 正常配置需求是 300/轮 × 2 轮/h = 600/h；background 补充率 800/h。近 7 天同组其他
  链路的实测小时峰值求和为 50/h，因此容量不需要靠躲 L1 成立。
- 1,741 + 574 = 2,315 条如一次即终结，纯吞吐估算是 **3.86 h**，加上下一个
  timer 相位最多约 **4.36 h**。
- 按当前队头全为确定性三试的最坏容量估算：`1741×3 + 574×2 = 6371`
  次剩余尝试，`6371/600 = 10.62 h`，计入 5/10min 退避和 timer 相位约 **11 h**。
  持续 transient 故障没有伪造的“排空完成界”，但不影响上述 FIFO 执行机会界。

## 4. L1 / forum / work-queue 验收

### L1

| run | started CST | status | pages_enumerated | elapsed |
|---:|---|---|---:|---:|
| 26644 | 10:24:00 | ok | 36,538 | 98.125s |
| 26652 | 10:29:00 | ok | 36,538 | 96.647s |
| 26658 | 10:34:00 | ok | 36,538 | 97.734s |
| 26705 | 10:39:00 | ok | 36,538 | 95.455s |

26644/26652 分别与回填 26642/26649 实际重叠；枚举量、状态和 86–100s 验收量级均成立。

- forum-consume 最新连续三轮（26651/26659/26703）均为
  `claimed=50 processed=50 succeeded=50 unprocessedReleased=0 status=ok`。
- work-queue 最新 run 26704 为
  `claimed=50 processed=50 ok=50 failed=0 status=ok`。

## 5. 其它“繁忙就整轮跳过”审计

源码检索了 `skipped` / `active` / `realtimeCollectionActive`，并用 `meta.ingest_run.stats`
做实测核对：

- 开始快照中 revision-source 近 7 天 1,701 轮有 1,697 轮 `l0_l1_active`，
  **99.765%**。
- 近 7 天所有带 `stats.skipped` 字段的运行都是这一个原因；其它 source/reason 为
  **0 轮（0%）**，未发现第二条高跳过率链路。
- revision-source 还有管理员显式 `write_freeze_active:*` 整轮保护；同期实测
  **0 轮（0%）**，它是可解除的强一致写闸，不是常态繁忙判据。
- `incremental-scan` 的 `skippedPersistence` 是单项“不得持久化”结果，轮次仍继续；
  work-queue 的 `skipped_write_freeze` 也是单任务强一致写闸，两者都不是“繁忙整轮退出”。

## 6. 长期停滞项结论

### 6.1 `serve.image_asset:failed` 2

两条都是 0055 v1 导入证据，时间为 2026-06-26，错误是
`v1_import:file_missing:ENOENT`。共享目录中的两个文件现在仍不存在；两个 hash 都有 URL alias，
但 `serve.page_image.asset_sha` 引用数都是 0。它们不是 worker 的 asset job，所以留在
`failed` 时不可能被认领。

已先应用 `0066_image_asset_unavailable_terminal.sql`，再做最终验证：

- 两条精确迁移到 `status=unavailable`，保留 v1 URL/SHA/错误证据；
- `serve.image_asset:failed=0`，pending 视图不再报这两条；
- 其中第二个 URL 另有一条普通 `jingyiling` pending job。若未来重下载的字节得到同一
  SHA，现有成功 UPSERT 仍可把 `unavailable` 恢复为 `ready`。

这是明确且可恢复的语义终态，不再是“报 failed 却无任何消费者”。

### 6.2 `incremental_page_state:l1_stale` 34

最终仍为 34，精确分类为：

- **22 no_state**：20 个是 `_template/_404/_theme/workbench/_utich` 等内部/特殊页，另两个是
  身份异常的 `scp-cn-4156` 页 1500000206 与 `scp-cn-4698` 页 1500002362。
- **2 never_seen**：`scp-cn-4156` 页 1500001184 和 `scp-sb` 页 1500001245。其中
  `scp-cn-4156` 当前同时有两个 live 身份，不是单纯漏刷时钟。
- **10 stale**：`6747-c`、`drtoylat`、`log-of-anomalous-items-cn:01227`、
  `scp-761-fr`、`scp-cn-4074`、`scp-cn-4155`、`scp-l119`、
  `the-slap-from-death-to-llife`、`wanderers:yinshi`、`xinglai`。

34 条全部经 `meta.is_synthetic_test_page_id(page_id)` 判定为 false，没有以 slug 前缀猜测。
最新 L1 连续枚举 36,538 页且更新了 36,525 条 state 关系；这 34 条不是 L1 轮次失败，
而是当前公开 ListPages 不再返回的内部页/旧页以及身份异常。现有告警视图将所有
`serve.page_current.status=live` 一律要求 30 分钟 L1 新鲜度，因此这是口径/身份治理项，不会靠多跑
几轮 L1 消失。本轮只完成归因，没有冒险自动删页或改身份。

### 6.3 `revision_regression_identity:L1` 1

唯一一条是 page 104127 / `scp-cn-4958` / wikidotId 1468426791，记录的倒退是 1→0，
首见于 2026-08-11 15:34。该 page 当前已是 `deleted`，增量状态又已由当前 L1 刷到
revision 40；没有 `revision_regression_identity_check` scan task，也没有对应 irreconcilable。
结论是“页删除后遗留的 pending orphan”，语义终态应为 `deleted`，不是当前 L1 真实倒退。
本轮未扩展修改删除生命周期，该 1 条仍需后续把删除终结串到状态收口。

### 6.4 `incremental_drift_state:revisions_full`

观察窗口中数量从用户给出的 8 降到 7，后来因新的 `no-love-hub` 连续两轮不同
又回到 **8**；说明聚合数会自然进出，但不能推导每一条都会自然收敛。

其中 6 条（`search:crom`、`search:site`、`alt:scp9000contesthub`、`ankv`、
`free-bird`、`in-the-land-of-dread-alagadda`）已连续 **1,751** 轮 L1 不同；最后一次
`revisions` 深扫均为“事实未收敛” partial，当前无 scan task。`the-slap-from-death-to-llife`
还有 1 条 task，`no-love-hub` 是新进入。结论：**总量会自然波动/部分收敛，存量 6 条不会
仅靠继续 L1 自然消失**；本轮按要求只确认趋势，未改动对账策略。

## 7. 测试污染与 `meta.ingest_run` 写入门

根因确认：测试对保留 wikidotId/`ts2test:` 页调用 `meta.record_page_scan(run_id=NULL)`
时，函数会自动插入：

```json
{"source":"synthetic","status":"running","stats":{"synthetic":true,"first_page_id":123}}
```

0042 的 PENDCLEAN 写入门只覆盖 `ingest.page_slug_history`、`serve.page_current`、
`ingest.user`，**没有覆盖 `meta.ingest_run`**。

已在修改测试调用前，先将 `0065_synthetic_ingest_run_guard.sql` 应用到 `scpper-v2`：

- 只在 `source=synthetic AND stats.synthetic=true AND first_page_id` 对应保留 wikidotId、
  `ts2test:` 或 0042 生成器特征时拒绝，SQLSTATE `P2T01`；
- 不按库名、不按普通 `test-*` slug，真实页 `test-log-046-de-03` 的无 run 留证仍允许；
- SECURITY DEFINER 辅助函数对 PUBLIC 不可执行，负向自检为 0；
- 定向测试与两次全量 `npm test` 后，`source=synthetic AND id>26553` 仍为 **0**。

迁移前留下的 running 行依既有悬挂 run reaper 转 aborted（快照从 3 条已降到 2 条）；
写入门不会阻塞这个状态终结更新。

## 8. 回归与变更清单

最终代码/迁移状态下重新运行：

- `npx tsc --noEmit`：通过。
- `npm test`：**tests 533 / suites 87 / pass 533 / fail 0 / skipped 0**。
  基线 528，新增 4 个让路/上界回归 + 1 个 `meta.ingest_run` 写入门事务回归。
- `git diff --check`：通过。

主要变更：

- `src/cli/revision-source-backfill.ts`：去整轮 active skip，加 contention 观测，修正确定性失败健康口径。
- `src/store/revisionSource.ts`：纯决策与保守 FIFO 调度界。
- `tests/revision-source-scheduling.test.ts`：持续繁忙、相位对齐、容量合同、FIFO 时钟与生产参数回归。
- `migrations/0065_synthetic_ingest_run_guard.sql`：合成 ingest_run 特征写入门。
- `migrations/0066_image_asset_unavailable_terminal.sql`：v1 缺文件无引用 asset 终态。
- `tests/pending-cleanup.test.ts`、`tests/identity-failure-check.test.ts`：写入门回归与显式测试 run。
- `deploy/systemd/syncer2-revision-source-backfill.timer`、`docs/RUNBOOK.md`：移除过期的“繁忙零请求退出”说明。

## 9. 阻塞与后续边界

本轮验收无阻塞。明确未在本轮扩展修复的两个数据治理项是：

1. 34 条 L1 stale 需要内部页/身份生命周期口径，不应盲目删数据或放宽全局阈值；
2. 已删除 `scp-cn-4958` 的 regression pending 需把删除终结事件接入状态收口。

它们不影响本轮 revision-source、L1、forum、work-queue 的验收结果。
