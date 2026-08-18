# v2 票出身与页面存在性收敛构建报告

> 工作树：`feat__syncer2-foundation`（仅此工作树有改动）  
> 分支基线：`scpper-backend-v2` / `89ea7a5`  
> 实施与验收：2026-08-17（Asia/Shanghai）  
> 运行时：TypeScript ESM / Node.js 22  
> 数据库：`scpper-v2`；v1 连接继续保留服务端 `default_transaction_read_only=on`  
> Git：未 commit、未 push

## 1. 结论

本轮已经完成迁移、代码、定向补扫和活库验收：

- 成功 WhoRated 快照在票多重集不变时，也会用本次直接证据给有效票建立行级出身；
  不增加行、不签发新 vote fact seq，也不写伪 snapshot marker。
- parity 的 v1、v2、完整快照验证三处统一使用 Wikidot `rating_votes` 口径，即只计
  `direction <> 0`；撤销事实继续保留，但不冒充 WhoRated 当前行。
- 题面 48,042 行 / 957 个 live 页缺出身，最终变为 146 行 / 102 页；这 146 行全部是
  `direction=0`。有效票缺出身为 **0 行 / 0 页**，因此原 957 页的验证阻塞为 0。
- reconcile 从报告 #37 到 #39：未解释 `vote_state` **127 → 1**、`existence`
  **10 → 0**、总未解释页 **167 → 32**。题面更早的 `vote_state=153` 同样已收敛；
  最后 1 页是新出现且尚无 v2 快照的 `scp-081-de`，不属于原 957 页。
- 9 个连续缺席候选均经最终 HTTP 404 收敛为 deleted；题目点名的四页全部不再 live。
- 原 22 个 live 无 L1 状态页中，20 个隐藏系统页被显式归为 `listpages_hidden`；另外
  2 个是 `scp-cn-4156` / `scp-cn-4698`，已经由 404 证据确认 deleted。22/22 均不再
  落入“疑似删除”或未解释存在性差异。
- 最终 `npm test` 为 **578/578**，`npx tsc --noEmit` 通过，无阻塞。

## 2. 迁移与文件

迁移 `migrations/0072_provenance_and_existence_convergence.sql` 已先应用到 `scpper-v2`，
随后才启用依赖新 schema 的运行时代码，满足生产工作树的保存顺序要求。迁移包含：

1. `serve.page_current.enumeration_scope` 与自动分类触发器；
2. `meta.l1_absence_observation`，只保存完整现代 L1 的缺席小集合；
3. `ingest.apply_vote_snapshot` 的出身建立包装层，原 0033 状态替换函数保留为后端；
4. 受保护库 guard、约束、索引、注释、最小授权与迁移后不变量检查。

本轮文件：

- `migrations/0072_provenance_and_existence_convergence.sql`
- `src/cli/incremental-scan.ts`
- `src/collect/deletion.ts`
- `src/reconcile/parity.ts`
- `tests/t5-vote-batch.test.ts`
- `tests/m7-deletion-health.test.ts`
- `tests/reconcile.test.ts`
- `docs/build-report-PROV.md`

## 3. 票出身：实现与幂等语义

### 3.1 状态不变时如何建立出身

包装层只在下列门全部通过时走“同状态补出身”：

- 输入是完整快照；
- 行数等于 `claimed_total`；
- `sum(direction)` 等于 `claimed_rating`；
- 输入只含 `direction=±1` 且 source ordinal 合法；
- 输入与当前有效票按 `(voter_id, direction, occurrence)` 的多重集完全相等。

通过后，对当前有效票按相同自然键和 occurrence 稳定配对，将本次证据的
`source_row_ordinal`、`source_identity_key`、`snapshot_hash`、
`snapshot_observed_at`、`snapshot_source` 写入当前行。配对时完整保留：

- `first_voted_at`
- `last_voted_at`
- `last_precision`
- `last_seq`

`direction=0` 行不在当前 WhoRated 快照中，故不伪造出身，也不删除。

### 3.2 为什么重放仍幂等

第一次补出身只重写 N 个当前有效行；它不调用 seq 分配器，不写
`ingest.vote_event`，也不写 `ingest.vote_snapshot_event`。完全相同的后续快照会命中
hash/ordinal/source 已一致检查，`provenance_rows_written=0`。

专项回归构造 2 个 legacy 有效票和 1 个撤销票：

| 断言 | 第一次 | 同快照重放 |
|---|---:|---:|
| 当前总行数 | 3 | 3 |
| 有效行补出身 | 2 | 0 |
| snapshot marker | 0 | 0 |
| 保留 fact seq | `70001,70002` | `70001,70002` |
| verified | true | true |

这证明重放 M 次仍是 N 行，且不会重新分配事实 seq。

### 3.3 票数单位

选择 `direction <> 0` 作为 v1、v2 和验证谓词的共同口径，理由是 Wikidot
`rating_votes` 声明的是当前有效票数，不含撤销事实。对应修改为：

- v1 `LatestVote` 查询排除 `direction=0`；
- v2 `serve.vote_current` parity 查询排除 `direction=0`；
- `claimed_total`、`fetched_total`、当前行数、checksum、快照 hash 与
  `all_rows_ordinalled` 都只对同一有效票集合判断。

这不是放宽出身要求：每一个参与验证的当前有效行仍必须 ordinalled，且必须来自同一个
完整快照。撤销事实因远端快照没有对应行，继续作为历史事实保留，但不参与当前票态验证。

## 4. 出身活库收敛

题面基线和本轮实测如下：

| 时点 | `source_row_ordinal=0` 行 | live 页 | 其中有效票行 / 页 |
|---|---:|---:|---:|
| 题面排查 | 48,042 | 957 | 未单列 |
| 本轮开始自然漂移后 | 42,749 | 839 | 未单列 |
| 删除处理后、定向补扫前 | 42,292 | 821 | 42,146 / 819 |
| 定向补扫完成 | **146** | **102** | **0 / 0** |

相对题面，行数下降 47,896（**99.70%**），涉及页下降 855（**89.34%**）。剩余
146 行全部为 `direction=0`，分布在 102 页；它们不再阻塞验证。

改造前的估算是：819 个仍有有效票的页各成功跑一次 WhoRated 即可收敛，按 50 页一轮
约需 17 个 worker 批次；实际由手动定向 worker 与生产 timer 共同完成，专用
`provenance_repair_v0072` 队列最终为 0。因每页补出身不分配事实 seq，收敛成本只与需确认
的页/当前行数有关，不随历史重放次数增长。

## 5. reconcile 验收

同一活库的 parity 报告对比：

| 指标 | #37（改造前） | #38（单侧口径中间检查） | #39（最终两侧口径） |
|---|---:|---:|---:|
| state compared | 36,614 | 36,599 | 36,599 |
| 未解释总页 | 167 | 34 | **32** |
| 未解释 `vote_state` | 127 | 3 | **1** |
| 未解释 `existence` | 10 | 0 | **0** |
| 原始 `vote_state` 差异 | 2,278 | 2,284 | 1,459 |

最终唯一未解释 vote_state 是新页 `scp-081-de`：v1 当前有效票为 2 / rating -2，v2 尚无
快照；它不是原缺出身集合。当前 live 有效票 `source_row_ordinal=0` 为 0，因此原受影响页
在下一次 reconcile 中没有一页再因缺出身落入未解释 vote_state。

`tags/title` 的剩余差异按任务边界未处理。

## 6. confirm_deleted 根因与修复

### 6.1 为什么原来 0 任务 / 0 扫描

车道没有被更好路径替代；入队条件有两处同时失效：

1. 删除代码只承认历史 `source='wikidot', mode='tier1'`，不承认当前每 5 分钟运行的完整
   `source='wikidot_listpages', mode='l1_votes'`，所以现代 L1 永远不能成为证据；
2. 代码选“紧邻上一轮 L2”，但又要求两轮至少相隔 2 小时。L2 实际每小时运行，两个条件
   不能同时成立。

现在选择“当前 L2 之前最近的完整 L1”和“至少早 2 小时的最近完整 L2 + 其前最近完整
L1”。因此跨过 TTL 的证据可达，期间的任意正观测仍能否决删除。

### 6.2 防幻影删除链

写 deleted 前必须依次满足：

1. 两组 L1 均为现代 `l1_votes`、`status=ok`、full scope、validation complete、
   coverage ≥ 0.98、batches_failed=0；
2. 两组 L2 均为完整 sitemap full、逐页证据策略 `all`、无 fallback、coverage ≥ 0.98；
3. 两组 L2 至少相隔 2 小时；
4. 同一 standard live 页在两组 L1 与 L2 都缺席；
5. 两组之间任意 `page_scan`、完整/局部 L1 正观测都会否决；
6. 当前或上一组缺席超过 500 页或 1.5% 时整轮熔断；
7. 以上条件只产生 `confirm_deleted` 任务；消费者最终整页 GET 必须明确为 HTTP 404；
8. 写生命周期前再次验证整条链，并为该 404 签发一个已经结束、`status=ok` 的独立
   `wikidot_page_identity` 证书 run，数据库生命周期门不接受仍 running 的父 worker run。

负向回归直接使用生产交集函数：当前轮缺席但上一轮出现时交集为空；现代 L1
`status=partial, coverage=0.4` 时双源门控失败。这分别覆盖“L1 单轮漏页”和“降档期部分
覆盖”，两者都不会入确认队列，更不会写 deleted。

### 6.3 活库证据

本次推断使用：

- 当前 L2 sitemap run `37172`
- 当前 L1 run `37166`
- 上一 L2 sitemap run `36782`
- 上一 L1 run `36767`
- eligible live 36,472
- current absent 10（0.0274%，未触发熔断）
- consecutive absent 9，入队 9

最终 9 页全部 GET 404，并分别签发证书 run `37369..37377`，生命周期事实 seq
`4930774..4930782`。题目点名四页：

| slug | 证书 run | deleted seq | 最终状态 |
|---|---:|---:|---|
| `scp-cn-4156` | 37371 | 4930776 | deleted |
| `scp-sb` | 37373 | 4930778 | deleted |
| `scp-cn-4698` | 37375 | 4930780 | deleted |
| `old:scp-1046` | 37377 | 4930782 | deleted |

另外五页 `short-stories:00399`、`experiment-log-914-cn:00064`、
`creator-chatter-test`、`scp-cn-4893`、`qquaping` 也得到同样的最终 404，故一并正确收敛。

`confirm_deleted` 当前任务为 0，成功确认扫描为 9。该车道没有被替代，修复后已实际工作，
因此保留在 `PINNED_KINDS`；40% 是两个 pinned kind 合计上限，且至少 60% 仍留给其他 kind，
不应因为过去的失效入队条件而删除其低延迟资格。

## 7. 系统/模板页显式归类

`enumeration_scope` 取值为：

- `standard`：完整 ListPages 理应枚举，可参与缺席证据；
- `listpages_hidden`：slug 为 `_foo` 或 `category:_foo` 的 Wikidot 隐藏系统页，L1 缺席是
  产品语义，绝不是疑似删除。

触发器覆盖存量回填、INSERT 和改名。目前 20 个 live 无 L1 状态页全部为
`listpages_hidden`，包括 `_template`、`_theme`、`_404` 及其分类变体。题面 22 个页中另两页
`scp-cn-4156` / `scp-cn-4698` 并非系统页，而是真实 404，现已 deleted。故原 22 页得到
20 个显式非删除分类 + 2 个确认删除终态，reconcile #39 的未解释 existence 为 0。

## 8. 生产与回归健康

### 8.1 L1

定向补扫期间最新连续六轮完整 L1：

| run | status | pages_enumerated | 秒 |
|---:|---|---:|---:|
| 37415 | ok | 36,672 | 95.0 |
| 37420 | ok | 36,672 | 93.4 |
| 37426 | ok | 36,673 | 94.3 |
| 37476 | ok | 36,673 | 94.2 |
| 37484 | ok | 36,673 | 97.6 |
| 37490 | ok | 36,673 | 98.0 |

全部处于题面 36,671 全站量级和 86–110 秒范围，未因补扫退化。

### 8.2 work-queue / forum-consume

- work-queue 最终生产 run `37508`：status=ok，23/23，batches_failed=0；此前定向批次均完成
  已认领页，最终专用任务 0。
- forum-consume 在同一时段持续处理满 50/50；run `37485`、`37499` 为 ok。部分轮标
  partial 是已分类的 deterministic 终态，retryableFailures=0、processed=claimed、
  batches_failed=0，不是本轮改动造成的消费回归。

### 8.3 自动测试

- `npx tsc --noEmit`：通过。
- 专项测试：幂等补出身、含撤销票同口径、隐藏系统页、单轮 L1 漏页、partial L1、404
  解析边界全部通过。
- `npm test`：**578/578 passed，0 failed，0 skipped**。题面基线 575；新增 3 个回归。
- `git diff --check`：通过。

## 9. 边界与阻塞

- 没有修改或移除 v1 服务端只读连接约束；所有 parity v1 查询仍在只读事务中。
- 没有触碰 `/home/andyblocker/qqbot`，没有发送任何 QQ 消息。
- 没有修改只读主 checkout `/home/andyblocker/scpper-cn`。
- 没有 commit、没有 push。
- 无交付阻塞。剩余 146 个无 ordinal 行都是远端当前快照无法为其背书的撤销历史事实；
  它们已从当前 Wikidot 票态验证口径中正确隔离，不构成验证或 reconcile 阻塞。
