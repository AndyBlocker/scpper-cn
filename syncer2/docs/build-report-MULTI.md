# MULTI：WhoRated 页级多重集与 snapshot replace 交付报告

日期：2026-08-03（Asia/Shanghai）  
目标库：`scpper-v2`  
收敛 run：`meta.ingest_run.id = 10802`

## 1. 结论

本任务已落地并在活库收敛。`serve.vote_current` 现在表达的是 WhoRated 单次成功观测的
**页级多重集**：同一自然账号的同向重复和正负相反行都按源响应逐行保留；页面主评分
`rating` 是全部行的 `Σsign`，另行发布 `unique_voter_rating` / `unique_voter_count`。

替换旧 `(page_id, voter_id)` 唯一防线的新结构性不变量是：

> 一次完整观测成功后，该页 `vote_current` 恰等于本次源快照；DELETE、INSERT、
> `page_current` 发布和 snapshot 事实写入都在同一数据库事务、同一页 advisory lock 内完成。

相同快照按规范化 hash 短路；后一个较小快照整体覆盖前一个快照。因此多重性只能来自
单次 WhoRated 响应，不能由跨轮累计产生。

## 2. 迁移方案

迁移文件：`migrations/0033_vote_snapshot_multiplicity.sql`。

### 2.1 当前态键与逐行追溯

- `serve.vote_current` 主键改为
  `(page_id, voter_id, source_row_ordinal)`；另有
  `(page_id, source_row_ordinal) WHERE source_row_ordinal > 0` 唯一索引。
- `source_row_ordinal > 0` 是 WhoRated 响应中的 1-based 行序号；配套保存
  `source_identity_key`、`snapshot_hash`、`snapshot_observed_at`、`snapshot_source`。
- 新快照的每一行都能回到源响应中的具体行，页内序号连续且唯一。活库 509 个本轮成功页
  的追溯不变量坏页数为 0。
- 迁移前存量无法恢复已经被旧主键折叠掉的源行，故不伪造序号：原 1,337,848 行平滑保留为
  `source_row_ordinal=0`，仍由 `last_seq`/时间/来源追溯；后续任一成功页快照会自然升级为
  逐源行记录。迁移不要求全站重抓。

### 2.2 原子 snapshot replace

`ingest.apply_vote_snapshot` 在拿到页锁且四项门控通过后执行：

1. 校验原始行数、逐行序号、完整性和全部行 `Σsign = claimed_rating`；
2. 写自然账号折叠后的 canonical `vote_event`，再以不可变
   `ingest.vote_snapshot_event` 保存行多重性补差；
3. 在同一事务内 `DELETE page` + `INSERT snapshot rows`；
4. 在同一事务内绝对赋值 `page_current` 的行评分、票型、去重评分和去重人数；
5. 写 `page_scan=ok`。任一门控失败不替换当前态。

不存在先删后插的可见空窗；事务回滚也不会留下半页。相同 hash 不分配新事实序号，
只补充本轮成功扫描证据。

### 2.3 双口径与下游

- 页面：`rating/vote_up/vote_down` 按源行；`unique_voter_rating` 先按 voter 求净方向并
  `sign`，`unique_voter_count` 按不同 voter。
- 用户：`votes_cast_up/down` 按当前源行；新增 `voted_page_count` 按
  `COUNT(DISTINCT page_id)`。
- 作者评分、排行、逐日曲线和站点聚合跟随页面行评分；snapshot 多重性补差进入逐日投影。
- 同一作者/页面可能同时有 `REWRITE`、`REWRITER` 等多个展示署名行。作者曲线和用户互动
  现按 `(page_id, actor_id)` 去重后再归属投票，避免新 snapshot 补差被署名行重复放大。
  全量重建前恰有 2 位作者不闭合（差 740、39），重建后 4,409/4,409 闭合。
- Prisma 映射、S3 历史回填兼容入口、L1 重建检查和权限矩阵均同步到三列主键/新事实表。

## 3. 采集语义

- 已完全移除“矛盾身份整体作废/守恒会计”隔离分支；没有并存的第二套路径。
- `+1,+1` 和 `+1,-1` 都按响应顺序进入 prepared rows，不再折叠，也不再令整页 failed。
- `claimed_total` 对比原始响应行数；评分门控对全部行求 `Σsign`。
- 非 WhoRated 的单 voter CAS 仍为兼容入口；若触及已有来源多行，只收敛该 voter 为一条
  `source_row_ordinal=0` CAS 状态，不能用于页快照采集。

## 4. 回归证据

| 要求 | 可执行证明 | 结果 |
|---|---|---:|
| 同向重复 `+1,+1` | 2 行；`rating=2`；`unique_voter_rating=1`；人数 1 | PASS |
| 方向矛盾 `+1,-1` | 2 行；`rating=0`；去重评分 0；扫描 `ok` | PASS |
| 同快照重放 3 次 | 行数/评分不变，只产生 1 个 snapshot marker | PASS |
| 不跨轮累积 | 先 5 行、后 3 行，终态恰为 3 行 | PASS |
| 普通无重复页 | 行评分与去重评分相同，行为不变 | PASS |
| 大页/属性回归 | 5,575 行重放 3 次；随机 60 轮逐轮整体替换 | PASS |
| B2/B4 新口径 | 重复投票 + 重复展示署名回归；活库 4,409/4,409 闭合 | PASS |
| 当前态聚合 | 行口径坏页 0；去重口径坏页 0；用户口径坏用户 0 | PASS |
| 类型/Prisma | `npx tsc --noEmit`；103 models = 103 非分区表 | PASS |
| 全套测试 | `npm test`: 346 tests，346 pass，0 fail | PASS |

核心测试文件为 `tests/vote-multiplicity.test.ts`、`tests/t5-vote-batch.test.ts`、
`tests/votes.test.ts`、`tests/projector.test.ts` 和 `tests/t6-role-permission.test.ts`。

## 5. 存量收敛

### 5.1 本轮执行

- 定向页 518；成功 509、partial 1、failed 8。
- 业务页请求 518，含重试共 535 attempts；200=510、500=24、transport=1，重试 25；
  breaker 未开启。请求量远低于约 8,600/日预算。
- 509 个成功快照共 128,465 行、127,944 个不同投票人，即保留 521 条源多重性行；
  当前有多重性的页 465，其中含正负相反行 26，仅同方向重复 439。

### 5.2 评分/L1 前后对照

下表的“即时前/后”均固定为 run 10802 的 live 页面口径：

| 指标 | 即时前 | 即时后 |
|---|---:|---:|
| `page_current.rating != last_l1_rating` | 512 | 9 |
| `abs(delta)=1` | 468 | 6 |
| L1 票数多于 v2 行数的评分分歧页 | 338 | 6 |
| v2 行数多于 L1 的评分分歧页 | 100 | 3 |
| 票数相同但评分不同 | 74 | 0 |
| 最新扫描仍为旧“身份正负冲突”失败 | 26 | 0 |

最初审计的未过滤 status 口径是 524 个评分分歧，最终为 28；最终 live 口径为 9。
未过滤口径包含已删页的历史 L1 值，故运维主指标使用 live 口径。

### 5.3 26 个旧冲突页

| 指标 | 改造前 | 改造后 |
|---|---:|---:|
| 页数 | 26 个整页 failed | 26/26 `page_scan=ok` |
| 被阻断/入库源行 | 9,187 行无法发布 | 9,187 行发布 |
| 不同投票人 | 未发布 | 9,150 |
| 与 L1 评分一致 | 0/26 可证明 | 26/26 |

这 37 条额外源行正是页内多重性。正负一对的行评分净值为 0，但保留行后票数和来源事实也
完整，不再牺牲整页其余 9,000 余票。

### 5.4 历史 442 个 `±1` 页

`build-report-DRIFT2.md` 在 2026-07-30 固定过 442 个 `abs(delta)=1` 的历史总数，但当时没有
持久化 442 个 page_id 清单。因此不能伪造“同一 442 页逐页 before/after”。可审计的对照是：

- 历史锚点：442；
- 本轮开始时同一 live 指标：468；
- 本轮结束：6。

也就是说该问题类别已从数百页收敛到 6 页；严格逐页的历史 442 成员回放因旧报告未保存
manifest 而不可做。以后定向收敛 run 会以 `page_scan/run_id` 保留实际目标与结果。

### 5.5 剩余 9 页

- 8 页的 WhoRated 请求连续三次返回 HTTP 500，门控未写入；
- `scp-761-fr` 的 L1 `claimed_total=0`，WhoRated 返回 1 行，故为守恒 partial；
- 9 页恰等于最终 9 个 live 评分分歧，均有页级失败证据。没有为了把数字清零而越过门控。

## 6. 74 个“票数相同但评分不同”页的独立归因

这 74 页在本轮开始时满足“本地行数 = L1 票数、但评分不同”，因此**不能由行数多重性
本身解释**。页级 snapshot replace 后 74→0，说明旧 `vote_current` 的方向/成员组合相对
当前 WhoRated/L1 已陈旧；这是基数不变的快照内容漂移，可能是改票、成员替换，或 L1 与
WhoRated 非同瞬时观测造成的窗口差。

旧分析只保留聚合值，没有保留这 74 页改造前的逐 voter 快照，所以现有证据不能再可靠地
把三种子因拆分。结论保持独立：它们由“刷新陈旧快照内容”收敛，不计入“放开多重性”成效，
也不与 442 个同方向重复类强行合并。

## 7. 最终状态与边界

- 10 个生产 L2 投影游标均为安全水位 3,724,537。
- B2/B4 全量检查 4,409 位有已删作品作者，0 不一致。
- 无代码/迁移阻塞；仅余 9 页外部 HTTP/跨模块声明不一致，均保持安全门控。
- 未修改 v1 只读连接设置，未写 v1；未触碰 `qqbot`，未发送任何 QQ 消息。
- 未创建 git commit，未 push。
