# RECON3：冻结成员集、fold 滚动判据与状态对齐归因

日期：2026-08-12（Asia/Shanghai）

## 结论

本轮没有放宽 `0.1%` 状态阈值，也没有用数值容差把差异调绿。两条误报分别改为：

1. 已删页冻结只比较**上轮已经进入已删集合且本轮仍为 deleted** 的成员；本轮新删页只写入
   下一轮全量基线。全量 checksum 仍每天更新，旧成员 count/checksum 任一变化仍然失败。
2. `v1_latestvote_fold_delta` 保留 RECON2 的 `25×` 红线，但把单日分子/分母改为至少七个
   完整上海日的同窗累计值。低投票日不再独自缩小分母，持续或突发的折叠异常仍会越界。

状态轨增加了一条严格来源判据：只有 v2 当前行全部来自同一个可追溯 WhoRated 原始多重集
快照，且 snapshot hash 与最新 `page_scan=ok` 一致、原始行数与 signed sum 分别严格等于
L1 `rating_votes/rating`，才解释 v1/v2 票态差。这一判据解释 906 个票态字段；其中 898 页
被完整解释，8 页仍因 title/tags 残余继续告警。

`meta.reconcile_report.id=23` 的 3,453 个状态未解释页，在同库只读重算中按新判据变为
2,552 页；同一输入关闭新解释器时为 3,450 页，净移出 898 页。剩余 2,552 页已在下文逐行
列出互斥类别，没有“其他”桶，状态轨仍为 `failed`。

本轮不涉及 schema 变更，因此没有迁移。v1 所有查询仍同时受连接串服务端只读与代码
`BEGIN READ ONLY` 保护；没有访问 qqbot，没有发送 QQ 消息。

## 一、已删页冻结误报

### 原因

旧实现把“当前全部已删页”拼成一个 checksum，并直接与上轮“当时全部已删页”比较。
集合里加入一个刚删除的页面时，即使所有旧页面一行未变，count/checksum 也必然变化。
`deleted_page_vote_pairs` 又把同一个成员新增按“稳定不增长”报一次，造成重复误报。

### 新判据

每轮同时计算两份值：

- `count/checksum`：本轮全部 deleted 页，写入报告，成为下一轮基线；
- `protectedCount/protectedChecksum`：最后一次 `page_life_event(kind='deleted')` 的
  `observed_at <= 上轮报告 observed_at` 的当前 deleted 页，只用这份与上轮全量基线比较；
- `newMemberVoteCount = count - protectedCount`：本轮新成员的投票行，只记录，不告警；
- `deleted_page_vote_pairs` 保留为成员规模观测值，不再单独设“不得增长”门。旧成员内容变化
  由 protected checksum 完整覆盖，count 变化与同 count 内容替换都会失败。

使用 `observed_at` 而不是 `deleted_at/occurred_at` 很重要：遗留删除的 occurred time 可能是
从末票/末修订推断出的旧时刻，不能拿它判断“本地何时把该页纳入冻结集合”。

### id=22 → id=23 活库回放

对当前库使用 id=22 的 `observed_at` 作为成员 cutoff，只读回放得到：

| 项目 | 结果 |
|---|---:|
| 本轮全部 deleted 投票行 | 155,752 |
| id=22 已有成员的投票行 | 155,645 |
| 新成员投票行 | 107 |
| 已有成员 checksum | `a25bcf3c120b05088ef76a2bf82985aa` |
| id=22 基线 checksum | `a25bcf3c120b05088ef76a2bf82985aa` |
| 新判据结果 | `ok / changed=false` |

这证明 `155645/a25bcf3c… → 155752/454dff61…` 的变化全部来自成员扩张；旧成员内容没有变。
再以 id=23 时刻为 cutoff，`155752/454dff61…` 与 id=23 基线也精确闭合，说明新成员已经
进入下一轮保护集。纯逻辑回归另构造“新页删除并带一票”和“旧成员 checksum 被改”两例：
前者 `ok`，后者 `failed`；保护没有拆掉。

## 二、`v1_latestvote_fold_delta` 七日滚动判据

### 定义

当前报告日为 `D`，从历史报告中取最新且上海日不晚于 `D-7` 的完整 whitelist 基线 `B`：

```text
interval_days = shanghai_day(D) - shanghai_day(B)       （必须 >= 7）
fold_growth   = fold_delta(D) - fold_delta(B)
vote_rows     = count(v1 Vote.timestamp in [day(B), day(D)))
pass          = fold_growth <= vote_rows * 25
```

这不是提高倍数：仍是 RECON2 的 `25×`。变化只在于 numerator 与 denominator 使用同一个
至少七日窗口，不再让某个低投票日单独决定阈值。窗口不足时返回 `partial` 并积累基线，
不会把缺少历史伪装成通过。报告字段由 `v1LatestVoteFoldDaily` 改为
`v1LatestVoteFoldWindow`，持久化窗口基线、天数、票行、允许量与越界状态。

### 完整可观测历史

fold 绝对量从 2026-07-30 才开始进入 `meta.reconcile_report`；此前没有历史快照，无法诚实
重建过去某日的 fold 总量。因此“完整历史回测”的边界是 07-30 至 08-12 的全部可观测
报告：前七日为必需暖机，此后 7/7 个可形成七日窗的终点全部参与，没有抽样。

v1 `Vote` 当前完整日计数（只读查询）为：

| 日期 | Vote 行 | 日期 | Vote 行 |
|---|---:|---|---:|
| 07-30 | 1,749 | 08-06 | 1,219 |
| 07-31 | 1,493 | 08-07 | 1,222 |
| 08-01 | 1,652 | 08-08 | 1,283 |
| 08-02 | 1,336 | 08-09 | 1,440 |
| 08-03 | 1,838 | 08-10 | 1,479 |
| 08-04 | 1,603 | 08-11 | 1,078 |
| 08-05 | 1,227 | — | — |

回测结果：

| 终点 | fold 七日增长 | 同窗 Vote | 比率 | 25×允许量 | 结果 |
|---|---:|---:|---:|---:|---|
| 08-06 | 100,493 | 10,898 | 9.221× | 272,450 | PASS |
| 08-07 | 111,368 | 10,368 | 10.742× | 259,200 | PASS |
| 08-08 | 114,522 | 10,097 | 11.342× | 252,425 | PASS |
| 08-09 | 114,771 | 9,728 | 11.798× | 243,200 | PASS |
| 08-10 | 135,774 | 9,832 | 13.809× | 245,800 | PASS |
| 08-11 | 126,793 | 9,473 | 13.385× | 236,825 | PASS |
| 08-12 | 138,979 | 8,948 | 15.532× | 223,700 | PASS |

min/P50/max 为 `9.221× / 11.798× / 15.532×`。最大值距离 25× 仍有 60.95% 相对余量。
id=23 的单日 `28,021 > 1,069×25` 在七日窗中为
`138,979 < 8,948×25=223,700`，不再误报。

部署代码后的只读 `runParity` 实测（活库继续增长，故数值略晚于 id=23）：
`foldGrowth=142,621 / windowVoteRows=8,948 = 15.939×`，`allowedGrowth=223,700`，
`exceeded=false`，whitelist `status=ok / alerts=[]`。同一回归把窗口增长构造成 223,701，
严格大于允许量 223,700，结果为 `failed`，因此真折叠爆炸仍会告警。

## 三、状态对齐逐类归因

### 固定时点与总量

以下新判据只读快照固定在 `2026-08-12 06:32:24 +08:00`。后台任务仍在运行，lag 排除数会
缓慢变化；所有表内数字来自同一次内存比较，不能与几分钟后的另一轮混加。

| 指标 | id=23 原报告 | 新判据固定快照 |
|---|---:|---:|
| 可比较 live 页 | 36,308 | 36,309 |
| 原始差异页 | 10,639 | 10,639 |
| 完整解释页 | 7,186（旧判据） | 8,087 |
| 未解释页 | 3,453 | 2,552 |
| 未解释率 | 9.5103% | 7.0278% |

`0.1%` 阈值未改，且仍要求 `unexplainedPages === 0`；2,552 页使本轨继续 `failed`。

### 页级互斥归因表（完整，无“其他”）

下表 16 行合计全部 10,639 个差异页；前四行合计 8,087 个完整合法页，其余 12 行合计
2,552 个未解释页。

| 页级类别 | 页数 | 是否合法 | 判据 |
|---|---:|---|---|
| 仅 v1 `crom:*` 合成标签 | 6,944 | 是 | 双方移除 `crom:*` 后标签集合严格相同 |
| 仅来源标题 Unicode/空白 | 245 | 是 | 只做 Unicode 空白折叠与 trim 后严格相同 |
| 仅 v2 已验证 WhoRated 多重集 | 848 | 是 | 当前 snapshot hash、原始行数、signed sum 与最新成功源证据全部闭合 |
| `crom:*` 标签 + 已验证多重集 | 50 | 是 | 上述两个独立严格判据同时成立 |
| 仅未解释 vote_state | 2,073 | 否 | 不满足完整当前源快照门，见下表三类 |
| `crom:*` 标签合法 + vote_state 未解释 | 123 | 否 | 标签合法不冲销票态残余 |
| 空白标题合法 + vote_state 未解释 | 2 | 否 | 标题合法不冲销票态残余 |
| rating + vote_state 未解释 | 6 | 否 | 两字段均无合法来源证据 |
| title + vote_state 未解释 | 13 | 否 | 两字段均保留 |
| rating + tags + title + vote_state 未解释 | 1 | 否 | 四字段均保留 |
| existence 未解释 | 173 | 否 | live 身份/状态集合不同，见存在性表 |
| title 未解释 | 133 | 否 | 非既有空白判据 |
| tags + title 未解释 | 10 | 否 | 两字段均保留 |
| tags 未解释 | 10 | 否 | 去掉 `crom:*` 后仍不同 |
| 多重集合法 + title 未解释 | 7 | 否 | 票态合法，但 title 仍保留 |
| 多重集合法 + tags 未解释 | 1 | 否 | 票态合法，但 tags 仍保留 |

### 2,218 个未解释 vote_state 页

票态字段原始差异为 3,124：906 个有完整多重集源证据而合法；剩余 2,218 个按证据完备性
互斥拆分如下。它们与 title/rating/tags 可以同页共现，但本表在 vote_state 集合内部不重叠。

| 票态证据类别 | 页数 | 是否合法 | 判据/为何仍未解释 |
|---|---:|---|---|
| v2 当前行数与新鲜 L1 `rating_votes` 不同 | 1,746 | 否 | rating 相同但多重集基数未闭合，不能用“v2 多重集正确”冲销 |
| v2 聚合 rating/count 对齐 L1，但缺当前逐行 snapshot 证明 | 465 | 否 | 只能证明聚合，不能证明 actor/direction 内容；拒绝猜测 |
| 没有 26h 内新鲜 L1 声明 | 7 | 否 | 独立分母/评分证据缺失 |

906 个合法票态不是数值容差：每页必须满足 `page_scan.status='ok'`、
`claimed_total=fetched_total=当前源行数`、`checksum_ok=true`、
`checksum_actual=当前行 signed sum`、全部 `source_row_ordinal>0`、全页只有一个非空
snapshot hash，且 `page_scan.result_hash=snapshot_hash`。任何一条不满足都留在上表。

### 173 个 existence 页

| 存在性类别 | 页数 | 是否合法 | 判据/结论 |
|---|---:|---|---|
| v1 live、v2 完全缺身份 | 28 | 否 | 按 WID 查不到 `page_current` |
| v1 live、v2 status=deleted | 1 | 否 | 两侧 live 状态不一致 |
| v1 deleted、v2 status=live | 110 | 否 | v2 保存删除事实是合法的，但这些行仍标 live，不能借该口径解释 |
| v1 deleted、v2 live，且同 slug 有复用 | 2 | 否 | 仍按 WID 比较；slug 复用不掩盖两个 status 错位 |
| v1 没有该 WID 身份、v2 live | 32 | 否 | 多为 adult 分类，但当前没有足够独立证据判成合法覆盖差 |

### 其他未解释字段

字段计数允许同页重叠：title=164、tags=22、rating=7。title 的 id=23 全量 165 字段形状为
单侧 null 90、NFKC 后相同 27、其余不同值 45、一侧包含另一侧 3；这些并非用户已拍板的
“正文 HTML 提取”口径，因为状态轨比较的是 title，不比较正文，所以全部保留。tags 只有
移除 `crom:*` 后严格相等才合法；剩余 22 不放宽。7 个 rating 全部与未解释 vote_state
共现，没有用近似评分或 `±1` 容差处理。

### 用户已确认口径在本轨的实际贡献

| 已确认来源 | 当前状态轨贡献 | 处理 |
|---|---:|---|
| v2 保存已删页、CROM 不保存 | 0 | 正确 deleted 不进入 live parity；112 个 v1-deleted/v2-live 是状态错位，不冒充合法 deleted |
| v1 slug 复用 3,334/10,062 | 0 | 本轨始终按 WID join；2 个 existence 页虽同 slug，仍保留两个 WID 的真实 status 差 |
| v2 匿名 actor 保留段 | 0 | 继续要求共享实名 actor 子集 count/rating/checksum 全相同；当前没有差异页满足，不能按 ID 段直接放行 |
| v2 正文使用 HTML 提取 | 0 | 正文不在 existence/title/rating/tags/vote_state 五字段内 |
| v2 投票多重集、v1 重复计票 | 906 个 vote_state 字段；898 页完整合法 | 仅完整 WhoRated 原始多重集 + L1 双门 + 当前 hash 证据生效；另 8 页仍留 title/tags 残余 |

## 四、CROM 429 降级确认

id=23 第 1 批即 HTTP 429。持久化结果仍严格为：

- `status='inconclusive'`；
- `counts={compared:0,differences:0,unexplained:0}`；
- `differenceCountsAvailable=false`；
- `cromOnly/v2Only=null`；
- title/rating/voteCount/revisionCount 的 `mismatches/nulls/uniqueValues/explained/actionable`
  全为 `null`，不是 0；
- `samples=[]`。

因此 RECON1 的完整性原则仍可靠：截断的 CROM 前缀没有进入存在性或字段 difference，
也没有被误写成“0 差异”。现有回归“CROM 429 截断”继续钉住这一语义，本轮未改 CROM。

## 五、回归与验证

新增/调整的纯逻辑回归覆盖：

1. 新页面删除并带入投票：全量基线增长，但 protected checksum 不变，冻结轨 `ok`；
2. 既有已删页投票内容变化：protected checksum 改变，冻结轨 `failed`；
3. 低投票日：旧单日式会越界，新七日窗不告警；
4. 折叠逻辑真坏：窗口增长 223,701 超过 223,700，严格 `failed`；
5. v2 多重集只有完整逐行源证据与 L1 双门闭合才解释；无证明的 checksum 差继续失败；
6. CROM 首批 429 仍 inconclusive 且不产生差异计数。

最终验证通过，没有为活库偶发性修改任何既有断言。中间一轮全量测试遇到
共享活库 `user_page_pkey` 竞争（SQLSTATE 23505）；原用例定向重跑 13/13，随后
最终全量重跑 468/468：

```text
npx tsc --noEmit                              PASS
node --import tsx/esm --test tests/reconcile.test.ts
                                                26/26 PASS
npm test                                      468/468 PASS, 0 fail
read-only runParity                           whitelist ok, freeze ok
```

没有 git commit，没有 push。
