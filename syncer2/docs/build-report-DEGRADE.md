# L1 降档正向覆盖交付报告

日期：2026-08-14（Asia/Shanghai）  
基线：`scpper-backend-v2` / `6873399`  
结论：**验收通过，无阻塞。**

## 结论先行

采用“**部分枚举正向可用 + 五分钟批次轮转**”，没有提高 L1 优先级、放宽全站门或延长
180 秒预算。预算截止时，已完整返回的批次不再全部丢弃；只比较这些页明确返回的
`rating/rating_votes`，发现变化后沿既有 `votes_full` 链路入队。未覆盖范围被显式记录，
但不能参与缺席、删除、修订覆盖、漂移连续性或每日完整枚举快照。

因此三个原机制仍成立：站点门继续减压，单轮仍按时退出，只有完整全站轮次才授权
absence；变化是把“降档时完全失明”收敛为“安全的轮转抽样覆盖”。

## 方案与实现

1. `scanIncrementalListPages` 捕获墙钟预算终止，保留已完成批次，输出 `partial`、完成/缺失
   批次区间和覆盖率；结构损坏、异常重复等 hard failure 仍不可持久化。
2. L1 每五分钟按与批次数互质的步长轮转起始批次。完整轮的集合仍严格是 `1..N`；部分轮
   不会长期只盯站点头部。
3. 先在 `scpper-v2` 应用迁移 `0070_l1_partial_vote_state.sql`，再修改运行时代码。新表只含
   slug/page_id/投票聚合值/观测时间/run/scope，物理上没有 revision、full-site seen、
   absence streak 或删除字段。部署时从最近完整 L1 水位引导，当前有 36,689 行。
4. 部分轮只写独立投票水位、`vote_changed` 信号、`votes_full` 任务和明确标为 partial 的页级
   证据；不调用完整 L1 状态推进、修订覆盖、漂移对账或每日枚举快照。完整 L1 同步独立投票
   水位，恢复后无需特殊切换。
5. 部分正向轮不进入完整轮 parse-health 比较，避免低样本覆盖反过来拖长恢复期。

关键实现：`src/collect/incrementalListPages.ts`、`src/work/l1PartialCoverage.ts`、
`src/store/l1PartialVotes.ts`、`src/cli/incremental-scan.ts`。

## 生产实测

以下均为真实 systemd L1 轮次，时间为北京时间：

| 门档 | run | 结果 | 枚举页 | 完成批次 | 批覆盖 | 投票变化/任务 | 时长 |
|---|---:|---|---:|---:|---:|---:|---:|
| 2（2,000 ms） | 29334 | partial | 11,250 | 45/147 | 30.612% | 13/13 | 179 s |
| 3（8,000 ms） | 29339 | partial | 2,750 | 11/147 | 7.483% | 1/1 | 178 s |
| 0（333 ms） | 29448 | ok | 36,569 | 147/147 | 100% | 0/0 | **100 s** |

- 2 档 run 29334 完成区间为 `1, 79–122`，缺失区间为 `2–78, 123–147`；13 个变化页全部
  在 07:08:38–07:08:51 得到 `votes/status=ok` 完整快照。按五分钟观测窗折算为
  **156 个/小时**，是事故口径 21 个/小时的 **7.4 倍**；从 L1 结束到快照完成约 11 分 39 秒。
- 3 档 run 29339 完成区间为 `1, 79–88`，非零覆盖且检出 1 个变化；该页随后完成投票快照。
- 最终代码自然 2 档轮次 run 29494 仍产出 14,069 页、57/147 批（38.776%），证明最终保存
  版本仍在生产路径非零落盘。
- 强制 0 档的首轮为 113 秒；把独立状态同步从 37 次小批写优化为 8 次后，run 29448 降到
  100 秒，满足 36,5xx 页 / 86–110 秒 / `status=ok`。

### 站点总压力

取相同三分钟墙钟窗口，来源为 `meta.egress_request_bucket` 的全站真实 attempts：

| 窗口 | 全站请求 | L1 | forum | work-queue | revision-source | 相对正常档 |
|---|---:|---:|---:|---:|---:|---:|
| 0 档 05:24–05:27 | 258 | 147 | 45 | 65 | 1 | 100% |
| 2 档 06:54–06:57 | 90 | 46 | 33 | 7 | 4 | 34.9%（下降 65.1%） |
| 3 档 06:59–07:02 | 23 | 11 | 8 | 4 | 0 | 8.9%（下降 91.1%） |

三个窗口的 pressure failure 均为 0。实现没有改门档 interval、令牌额度、L1 priority 或
全局 FIFO；部分持久化本身不产生 Wikidot 请求。因此恢复期没有额外抢占，且实测总压力随
档位显著下降。健康保持期/六窗口恢复逻辑保持原样。

### work-queue / forum-consume

06:50–07:08（覆盖 2/3 档）完成的运行：

| 链路 | 完成轮次 | failed | ok / partial | 有效页 | exit code |
|---|---:|---:|---:|---:|---|
| `wikidot_tier2`（work-queue） | 4 | 0 | 2 / 2 | 91 | 全部 0 |
| `wikidot_forum`（forum-consume） | 4 | 0 | 3 / 1 | 151 | 全部 0 |

partial 均是既有墙钟预算下的正常收尾；两条链路继续取得进展，没有回归为失败或零产出。

## 幻影删除安全论证

部分覆盖同时有三层阻断：

1. **数据结构阻断**：独立 `meta.l1_partial_vote_state` 不含任何 absence/删除授权字段。
2. **调用路径阻断**：部分轮不写 `meta.incremental_page_state`、revision coverage、drift 或完整
   枚举快照；仅对响应中实际出现的页做单调正向操作。
3. **数据库最终阻断**：`ingest.apply_page_life` 只接受 `status=ok` 且覆盖成立的 run；测试用
   `status=partial` run 对未覆盖页推断删除时，数据库明确拒绝。

回归夹具同时放入“已覆盖且投票改变的页”和“未覆盖页”：前者得到 1 个任务/1 个信号并只
推进独立投票水位；后者任务=0、信号=0、完整 L1 水位不变、revision coverage=0、删除事件=0、
`serve.page_current.status=live`。这直接覆盖已知幻影删除入口。

## 验证与回归

- `npx tsc --noEmit`：通过。
- 降档、L1、work-queue、forum 定向回归：62/62 通过。
- `npm test`：**568/568 通过**（90 suites，0 fail，156.4 秒）。
- 较早一次全量回归曾与活库 project 定时器撞锁，出现既有 `user_page_pkey` 并发冲突；原断言
  未修改，projector 单跑 13/13 通过，随后两个错峰全量运行均为 568/568。
- `git diff --check`：通过；没有 commit，没有 push。

新增核心测试位于 `tests/l1-degraded-coverage.test.ts` 和
`tests/incremental-listpages.test.ts`：覆盖 2/3 档 permit 仍非零但低于 0 档、预算截止保留完成
批次、五分钟轮转、未覆盖页不得删除，以及 0 档完整枚举既有契约。

## 生产库变更与还原

- 永久且预期的 schema 变更：`0070_l1_partial_vote_state.sql` 已先应用到端口 5434 的
  `scpper-v2`，随后才启用依赖它的源码。
- 2 档验证使用当时自然恢复态；3 档和 0 档为临时强制。两次都先保存完整控制行，并用 shell
  EXIT/INT/TERM trap 还原 `level/reason/changed_at/recover_not_before`、pressure 对应字段和
  `next_permit_at`。
- 每次验证后均查库确认恢复为原始 2 档：reason
  `recovered_after_6_nonempty_5m_windows_lte_3.0pct`，`changed_at=06:40:05.911+08`，
  `recover_not_before=07:25:05.911+08`。**没有临时门值残留**；此后仅允许控制器自行演进。
- 测试合成页由 fixture 清理；未触碰只读主工作区或 QQ 目录，未发送任何 QQ 消息。
- 最终 systemd 只读审计仍看见 `syncer2-job@reconcile.service` 的 failed 状态：它是本实现前、
  今日 06:13–06:33 在原降档事故期间发生的既有 20 分钟 timeout；L1/work-queue/forum 没有新增
  failed 单元。本次未越权重跑或清除该无关告警，它不阻塞本交付。

## 边界与后续观察

部分轮提供的是抽样变化检测，不宣称全站完整：3 档实测每轮约 7.5% 批覆盖，页面最坏检测
延迟取决于五分钟轮转和当时站点规模。`votes_full` 的实际完成仍受 work-queue 队列影响；本次
13 个变化的端到端延迟约 12 分钟。建议后续观察 24 小时的 `batchCoverageRatio`、变化任务
完成延迟和轮转去重率，但这些不构成本次交付阻塞。
