# RECON2：对账判据与每日 L1 枚举快照

日期：2026-08-04（Asia/Shanghai）

## 结论

B、C、D 均已完成并经过离线回归与活库实跑。修复后的全量 reconcile 为
`meta.reconcile_report.id=15`：`compared=413,131 / difference=12,426 /
unexplained=4,502`，未解释率 `1.0897%`，低于上一轮 id=14 的 `1.1241%`，
`unexplainedRegressed=false`。

本任务没有处理状态对齐页；该轨未解释页从 3,461 变为 3,509，仍按后续独立任务处理。
没有调用 qqbot、没有发送 QQ 消息，也没有修改 v1 的服务端只读连接约束。

## B. `v1_latestvote_fold_delta` 改为日相对增量

### 数据分布

数据来自两处只读证据：

1. v2 `meta.reconcile_report` 中相邻上海日的 `v1_latestvote_fold_delta`；
2. v1 `Vote` 在对应完整上海日的新增行数。

v1 最近的 `Vote.timestamp` 是日精度，抽样日内 `min(time)=max(time)=00:00:00`，因此不能拿
两个报告的精确时分秒做区间；实现使用 `[上一基线的上海日, 本轮上海日)`。同日手工重跑不
会重置日基线，避免把几分钟的分母与一天累积的折叠量错配。

| 报告日区间 | fold 日增量 | v1 当日新增 Vote | fold / Vote |
|---|---:|---:|---:|
| 2026-07-30 → 07-31 | 7,771 | 1,497 | 5.191× |
| 2026-07-31 → 08-01 | 9,372 | 1,383 | 6.777× |
| 2026-08-01 → 08-02 | 25,148 | 1,463 | 17.189× |
| 2026-08-02 → 08-03 | 2,301 | 1,171 | 1.965× |
| 2026-08-03 → 08-04 | 22,755 | 1,488 | 15.292× |

五个完整日的 min/P50/max 是 `1.965× / 6.777× / 17.189×`。据此取
`fold_growth <= new_vote_rows × 25`：25× 比实测最大值高 45.4%，容纳 v1 活库批处理的
日间抖动，同时能把至少比历史最大形状恶化约 45% 的折叠爆炸判红。没有设置“永远放行”的
绝对下限；若当日零新增票，则 fold 也必须零增长。

实现位于 `src/reconcile/parity.ts`：

- 白名单基线改取最近一个更早上海日、且包含完整 whitelist metrics 的报告；
- v1 查询仍在 `BEGIN READ ONLY` 内，同时读取完整日新增 `Vote` 行数；
- `growth` 继续如实保留自然增长，但只有超过 25× 才形成 difference/alert；
- 其他白名单指标仍执行“稳定不增长”，没有删温度计；
- 报告新增 `v1LatestVoteFoldDaily`，持久化基线日、分母、倍数、允许量与是否越界。

id=15 实测：`foldGrowth=23,871`、`newVoteRows=1,488`、`16.042×`，允许值 37,200，
`status=ok / differences=0 / alerts=[]`。id=14 的
`v1_latestvote_fold_delta 增长 +22755` 告警消失。

## D. 冻结 checksum 口径版本

当前版本定义为 `v2`：

```text
material = page_id:voter_id:source_row_ordinal:sign(direction)
order    = page_id,voter_id,source_row_ordinal
join     = LF
hash     = MD5
```

`fetchDeletedVoteChecksum` 现在同时返回 `version=2` 和完整算法描述；报告持久化
`checksumVersion/checksumAlgorithm/previousChecksumVersion/baselineRebuilt`。

比较规则：

- 没有旧基线：首次建基线，`partial`；
- 旧报告没有版本或版本不同：明确报告“口径升级、基线重建、非数据变化告警”，
  `differences=0 / unexplained=0 / changed=false / baselineRebuilt=true`；
- 只有版本相同才比较 count/checksum，变化仍为 `failed` 真告警。

旧 JSON 报告无需迁移或重算全站。读取时把缺失版本视为 `legacy-unversioned`，本轮当前值直接
成为 v2 基线；下一轮即可同版本比较。

id=15 实测为 159,460 行，checksum 仍是 `dba5aa03...`，原先的“数据变化”告警替换为：

```text
已删页 vote_current 冻结 checksum 口径升级：legacy-unversioned → v2；
按新口径基线重建，非数据变化告警
```

该项 `differences=0`，没有再把良性口径变化计入未解释数。

## C. 每日完整 L1 枚举快照

没有新增独立网络扫描。现有 `schedule:l1` 已经以四字段最小载荷
`fullname/rating/rating_votes/revisions` 完整翻全站 pager；实现直接复用每天第一轮完整成功的
结果，派生 `category`（从 fullname 前缀）与稳定本轮 index，写入：

```text
state/listpages-l1-enum.snapshot.json.gz
```

当天后续 L1 轮继续承担既有增量职责，但不反复改写 parity 的日基线。任何 `partial/failed` 轮
都不推进快照，因此不增加 145 请求的第二轮成本。

`src/store/l1EnumerationSnapshot.ts` 的完整性/原子性约束：

- 只有 `status=ok`、`validation.complete=true`、请求批数等于 pager 批数且零失败才能构造；
- 快照带 `kind/completeness=complete/updatedAt/expectedBatches/rowCount/remoteTotal`；
- 对全部 claims 计算 SHA-256 内容 checksum；读取时复核版本、complete、时间、行形状、
  行数、remoteTotal 与 checksum；
- 同目录写 `.tmp.<pid>.<time>`，文件 `fsync` 后原子 rename，再 `fsync` 目录；崩溃留下的临时
  文件不会被读取；
- 新 L1 目标文件一旦存在，损坏时明确 inconclusive，不回退到周级 L3 掩盖故障；部署初期仅在
  新文件尚不存在时兼容读取旧 L3 快照。

`src/reconcile/triangle.ts` 保留原新鲜度门（正式参数 26h）。页级 claims 抽成 L1/L3 共用最小
类型，L1 缺少 `created_at` 时跳过“新近页”分层，再由其他确定性分层补足样本。

活跑 L1 run 11674：146/146 批、36,340 页、81.195 秒、零失败；日快照 683 KB，
`rowCount=remoteTotal=36,340`，内容 checksum
`d8f4f82278cfc13630ebc508e7a7aa0f3729f3217af94ed142f605444b280316`，原子写后重读通过且
无 `.tmp.*` 残留。

id=15 三角实测：

- 枚举：`compared=36,360 / differences=230 / unexplained=0`；20 个隐藏 sitemap-only 和
  210 个 deleted/forum/adult/wanderers-adult ListPages-only 均被既有规则解释；
- 页级：votes `10/10`、revisions `10/10`，`differences=0`；
- id=14 的“ListPages 快照过旧”和“禁止继续页级比对”两条 inconclusive 告警均消失。

## 回归与验证

`tests/reconcile.test.ts` 新增/拆分以下断言：

1. v1 自然增长 22,755 / 1,488：不告警；异常增长 40,001：超过 37,200，告警；
2. checksum v1→v2：基线重建且零 data difference；v2 内 checksum/count 变化：仍 failed；
3. `completeness=writing` 半截 L1 快照：读取拒绝，枚举保持 inconclusive 且不算 difference；
4. 新鲜完整 L1 快照：枚举恢复 difference，页级三角 mismatch 正常进入 difference。

最终命令：

```text
npx tsc --noEmit  -> PASS
npm test          -> 356 tests / 356 pass / 0 fail
```

主类型检查最初还暴露 `src/store/workQueue.ts` 的 SQL template literal 注释中有两个未转义反引号；
只把注释内的反引号改为普通文本，不改 SQL 或队列逻辑。测试套件一次通过，没有为活库偶发性
修改断言。

## report 14 → 15 alerts 变化

已消失：

- `白名单指标 v1_latestvote_fold_delta 增长 +22755...`
- `已删页 vote_current 冻结 checksum 变化...`（替换为非数据告警的口径升级说明）
- `ListPages 快照过旧...`
- `ListPages claims ... 禁止继续页级比对...`

仍存在且不属于本任务：状态对齐未解释差异、CROM/v2 可行动存在性差异、CROM 五项字段差异。
本轮没有阻塞。
