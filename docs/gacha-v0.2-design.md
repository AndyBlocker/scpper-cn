# Gacha v0.2.1 实施规格（Oracle Index + Locked Position 重写版）

> 文档状态：可进入实现拆分  
> 重写时间：2026-02-08（UTC+8）  
> 适用服务：`backend` / `bff` / `user-backend` / `frontend`

## 1. 已锁定决策（本版不再反复）

1. 只保留一种 Token，且只保留一个常驻抽卡池。  
2. 市场价格由 `backend` 数据驱动的 Oracle Index Tick 生成，不受用户交易行为影响。  
3. 市场不做订单簿撮合，不做 LMSR，不做 `spot buy/sell`。  
4. 市场交易统一为“锁仓仓位开仓”（`LONG/SHORT`），至少锁仓 1 天。  
5. 收益与指数涨跌幅大小相关（非二元兑付）。  
6. 倍率合约支持中途爆仓即时清零，不等待锁仓结束。  
7. 对手盘数据只做展示（人数/资金/最近开仓），不参与定价。  
8. 每日/每周任务按累计 Token 消耗计数，口径含抽卡与市场开仓。  
9. `indexMark` 只允许由 `backend` 计算并写入 tick；其他服务只透传与消费，不复算 `exp()`。
10. v0.2 上线切换采用“gacha 用户态硬重置”：旧 `gacha` 库存/钱包/抽卡记录/放置状态/幂等记录可直接删除，不做迁移兼容；必须仅清理 gacha 域表，禁止触碰非 gacha 业务数据。  

## 2. 数据基线（本版用于定参数）

## 2.1 `scpper-cn`（score 使用的主数据）

### 2.1.1 数据覆盖

- `PageDailyStats` 覆盖：`2012-10-18` ~ `2026-02-08`，`700,414` 行。  
- `Revision` 覆盖：`2012-05-25` ~ `2026-02-07`，`2,848,567` 行。  
- `commentCount` 时间口径不稳定，本版已从 score 指标中移除，不参与任何价格计算。  

### 2.1.2 六大类页面规模（按最新标签，仅静态展示）

规则：

- `OVERALL`：全部页面  
- `TRANSLATION`：不含 `原创`  
- `SCP`：含 `原创` + `scp`  
- `TALE`：含 `原创` + `故事`  
- `GOI`：含 `原创` + `goi格式`  
- `WANDERERS`：含 `原创` + `wanderers`

| 品类 | 页面数 |
|---|---:|
| OVERALL | 43,598 |
| TRANSLATION | 24,392 |
| SCP | 5,653 |
| TALE | 4,916 |
| GOI | 523 |
| WANDERERS | 1,742 |

### 2.1.3 近 53 周周均指标（用于初始权重验证）

说明：本表沿用历史可稳定复算字段（含 `unique_voters`），用于量级感知；v0.2.1 生产口径的投票参与度指标以 `votesTotal=votesUp+votesDown` 为准。  

| 品类 | revisions/w | unique_voters/w | new_pages/w |
|---|---:|---:|---:|
| OVERALL | 1018.42 | 4181.15 | 95.40 |
| TRANSLATION | 426.53 | 865.28 | 54.94 |
| SCP | 164.08 | 1516.06 | 15.36 |
| TALE | 94.92 | 953.00 | 12.06 |
| GOI | 22.62 | 153.64 | 2.47 |
| WANDERERS | 26.92 | 186.64 | 4.79 |

## 2.2 `scpper_user`（用于任务门槛与仓位标定）

- 活跃样本（日，`user-day`，180 天内有抽卡消耗）：`1,763`。  
- 活跃样本（周，`user-week`，180 天内有抽卡消耗）：`641`。  
- 去重活跃用户（180 天内有抽卡消耗）：`133`。  
- 活跃用户日消耗分位：`p50=300`、`p90=1520`。  
- 活跃用户周消耗分位：`p50=1110`、`p75=2000`、`p90=5400`。  
- 阈值命中率（抽卡口径历史回放）：`DAILY_SPEND_300 = 50.88%`，`WEEKLY_SPEND_1000 = 57.10%`。

## 2.3 关键参数判定参考（审议用）

| 模块 | 参数/规则 | 初始值 | 数据参考 | 说明 |
|---|---|---:|---|---|
| 卡池结构 | 常驻池数量 | 1 | 近 180 天抽数：主池 `258,200`，其余两池合计 `3,996` | 降低复杂度 |
| 抽卡成本 | 主池单抽/十连 | `10 / 100` | 历史现网配置 | 与用户习惯连续 |
| 拆卡回收 | 稀有度固定表 | `1/4/12/30/100` | `E(拆卡返还)≈5.553/抽` | 保持抽卡净消耗 |
| 指数开盘基点 | `INDEX_BASE` | `100` | 游戏化展示习惯 | 便于理解涨跌幅 |
| 指数波动强度 | `INDEX_K` | `0.20` | `p=0.5696 => index≈105.76` | 先保守上线，后续可调 |
| score 截断 | `SCORE_CLAMP` | `±3.476099` | 对应 `p` clamp 到 `[0.03,0.97]` | 防止价格爆炸 |
| 通胀折扣系数 | `INFLATION_ALPHA` | `0.50` | 名义与相对口径折中 | `x=d(c)-α*d(overall)` |
| Tick 粒度 | Oracle Index Tick | `1` 小时心跳 | 上游 sync 当前约 `2` 小时推进一次 | 同一 `watermarkTs` 常见连续 `2~3` 条 tick |
| Vote 可用延迟 | `VOTE_LAG_DAYS` | `1` | 上游 API 日结（D 日数据 D+1 可同步） | `votes/sentiment` 必须滞后口径 |
| 价格正式起算日 | `CALC_START_DATE` | `2023-01-01` | 避开 2022 异常尾部，提升上线初期稳定性 | 交易/展示从该日后周线开始 |
| 价格 warmup 起点 | `WARMUP_START_DATE` | `2022-10-01` | 为 expanding z、权重滚动提供预热样本 | warmup 仅用于统计预热不对外展示 |
| 最小 warmup 天数 | `MIN_WARMUP_DAYS` | `92` | 约 13 周，可覆盖 `MIN_Z_HISTORY=8` 的 offset 冷启动 | 若不足则自动后移 `CALC_START_DATE` |
| 漂移中和窗口 | `DRIFT_WINDOW_WEEKS` | `26` | 约半年滚动中位数 | 用于去除长期单边漂移 |
| 漂移中和最小样本 | `DRIFT_MIN_HISTORY_WEEKS` | `8` | 与 `MIN_Z_HISTORY` 对齐 | 样本不足时不做中和 |
| 漂移中和系数（OVERALL） | `DRIFT_BETA_OVERALL` | `0.95` | 目标：周收盘 score 长期均值接近 0 | 避免指数长期塌陷 |
| 漂移中和系数（TRANSLATION） | `DRIFT_BETA_TRANSLATION` | `0.70` | 抑制翻译类目长期单边漂移 | 避免展示长期“只跌不涨” |
| 漂移中和系数（其他类） | `DRIFT_BETA_OTHERS` | `0.20` | 保留品类趋势表达 | 防止过度拉平品类差异 |
| 日内 forecast 粒度 | `HOURLY_TICKS_PER_DAY` | `24` | 每小时更新一次 | 跨日/跨周锚定一致 |
| 补量回摊模式 | `VOTE_BACKFILL_MODE` | `bootstrap` | 仅历史回填阶段启用 | 增量阶段必须 `off` |
| 补量回摊起点 | `BACKFILL_REDIS_START` | `2021-01-01` | 锁定本轮已确认异常阶段 | 起点前不做回摊 |
| 补量回摊截止 | `BACKFILL_REDIS_END` | `2022-12-31` | 2021-2022 周级缺口审查 | 截止后新数据不做回摊 |
| 参与度样本折扣 | `VOTE_K` | `300` | GOI/WANDERERS 周票分位（17.1） | `z_votes` 小样本降噪 |
| 口碑平滑先验 | `SENTIMENT_ALPHA/BETA` | `2 / 2` | 小样本稳健 | `approval=(up+α)/(up+down+α+β)` |
| 口碑样本折扣 | `SENTIMENT_K` | `100` | 避免小类口碑抖动放大 | `shrink=sqrt(n/(n+K))` |
| 组件级 z 截断 | `Z_CLAMP` | `6.0` | 防止单点异常打满总分 clamp | `z=clamp(z,±Z_CLAMP)` |
| z 冷启动样本门槛 | `MIN_Z_HISTORY` | `8` | 防止早期样本不足导致极值误触发 | 历史不足时 `z=0` |
| 最小交易单位 | `LOT_TOKEN` | `10` | 与单抽成本一致 | 便于整数结算 |
| 锁仓档位 | `T+1/T+7/T+15/T+30` | `24h/168h/360h/720h` | 匹配活跃用户消耗分位 | 长锁给高杠杆 |
| 开仓费基准 | `OPEN_FEE_BASE_BY_TIER` | `0.8/0.7/0.6/0.5%` | 日级回放体感验算 | 对应 `T1/T7/T15/T30` |
| 杠杆附加费 | `OPEN_FEE_LEV_SURCHARGE` | `0/0.2/0.8/1.8/4/10/22%` | 抑制高杠杆无成本扩张 | 对应 `1x/2x/5x/10x/20x/50x/100x` |
| 盈利结算费 | `SETTLE_FEE_RATE` | `8%` | 同上 | 仅对 `profit` 收费 |
| 任务阈值（日） | `DAILY_SPEND_300` | `>=300` | 历史命中约 50% | 中位完成门槛 |
| 任务阈值（周） | `WEEKLY_SPEND_1000` | `>=1000` | 历史命中约 57% | 可达但不白送 |
| 任务时区 | `MISSION_TIMEZONE` | `UTC+8` | 与市场周线边界一致 | `day/week periodKey` 均按 `UTC+8` |
| 放置槽位数 | `PLACEMENT_SLOT_COUNT` | `5` | 轻量放置，避免界面拥挤 | 默认即 5 槽位 |
| 放置累计上限 | `PLACEMENT_BUFFER_CAP_MAX` | `3000 token` | 控制离线堆积体感 | 手动领取前最多累积到该值 |
| 放置基础上限 | `PLACEMENT_BUFFER_CAP_BASE` | `2760 token` | 与词条上限联动 | `+OFFLINE_BUFFER` 后最高不超过 `3000` |
| 放置基础产出 | `PLACEMENT_BASE_YIELD_BY_RARITY` | `0.5/0.7/1.0/1.5/2.0` token/h | 按库存结构与消耗分位回放 | 对应 `WHITE/GREEN/BLUE/PURPLE/GOLD` |
| 删帖压力惩罚 | `DEL_RATE_PENALTY` | `0.05` | 以规模归一避免大类天然吃亏 | `score -= 0.05*z_delRate` |

## 2.4 本次复算快照（回填依据）

- 复算时间：`2026-02-08 02:20~03:02 CST`。  
- 复算库：`scpper-cn`、`scpper_user`（本地 PostgreSQL `localhost:5434`）。  
- 覆盖范围：2.1~2.3 参数表、4.3 拆卡期望、8 章指数幅度分位。  
- 8 章仿真补充口径：`scoreFinal` 空值按 `0` 处理；周内线性过渡目标为 `clamp(scoreFinal, -SCORE_CLAMP, +SCORE_CLAMP)`。  
- 回填规则：以实时 SQL/仿真输出覆盖旧值，保持小数精度与表格口径一致。

## 2.5 上游时效约束（生产硬前提）

- `backend sync` 当前运行态是批处理，不是分钟级流式；现网有效数据推进约每 2 小时一次。  
- `vote` 数据源是日结 API：自然日 `D` 的投票数据，最早在 `D+1` 才能同步入库。  
- 因此 `votes_up/votes_down/sentiment` 在 `score_provisional(asOfTs)` 中必须使用“昨日及以前已结算数据”，不得读取当日票。  
- 若票数口径改为更细粒度，需先更新本节与第 7.3 节公式，再允许放宽滞后规则。

## 2.6 回填与放置常量冻结（v1）

经 `2026-02-09` 回放验证后，以下常量冻结为 `ruleVersion=v1`：

周回摊（bootstrap-only）：

- `BACKFILL_HISTORY_WEEKS=12`  
- `BACKFILL_MIN_NONZERO_HISTORY=4`  
- `BACKFILL_SPIKE_FACTOR=2.5`  
- `BACKFILL_SPIKE_ABS_MIN=500`  
- `BACKFILL_PREV_ZERO_MAX=1e-9`

日回摊（bootstrap-only）：

- `DAILY_BACKFILL_HISTORY_DAYS=36`  
- `DAILY_BACKFILL_MIN_NONZERO_HISTORY=10`  
- `DAILY_BACKFILL_PREV_RATIO_MAX=0.22`  
- `DAILY_BACKFILL_MIN_GAP_DAYS=3`  
- `DAILY_BACKFILL_FACTOR_REV=1.25`  
- `DAILY_BACKFILL_ABS_MIN_REV=60`  
- `DAILY_BACKFILL_FACTOR_VOTES=2.5`  
- `DAILY_BACKFILL_ABS_MIN_VOTES=500`

放置产出（实时与离线统一）：

- `PLACEMENT_BASE_YIELD_BY_RARITY`（token/h）  
  `WHITE=0.5, GREEN=0.7, BLUE=1.0, PURPLE=1.5, GOLD=2.0`

验证结论（摘要）：

1. 相比 `VOTE_BACKFILL_MODE=off`，`OVERALL/TRANSLATION` 的周级 `p95(|Δln(1+votes_w)|)` 下降约 `13%/15%`。  
2. `DAILY_BACKFILL_HISTORY_DAYS=36` 能捕获 `2021-06-25` 大规模补量（30 天窗口会漏检）。  
3. 周回摊在“日回摊开启”场景下通常不触发；在“日回摊关闭”降级场景可兜底命中 `2021-06-21`、`2022-02-07` 异常周。  
4. 放置基础产出结合现有库存分布下，5 槽日收益（不含词条）中位约 `216 token/day`、`p90≈240`；叠满 `YIELD_BOOST +10%` 后中位约 `238 token/day`，低于 `DAILY_SPEND_300` 门槛，避免被动产出覆盖主动消耗。

## 3. 玩法闭环（v0.2.1）

1. 用户用 Token 在单常驻池抽卡。  
2. 卡可用于放置产出（默认 5 槽，手动领取，累计上限 3000 Token）。  
3. 卡按“页面 -> 变体（词条/异画）”进入库存与图鉴进度。  
4. 市场用同一钱包开 `LONG/SHORT` 锁仓仓位（Oracle 指数定价）。  
5. 仓位到期自动结算，盈亏按指数涨跌幅计算。  
6. 任务/里程碑/成就产出抽卡券与重 roll 券，构成循环。

## 4. 抽卡、放置与拆卡（单常驻池）

## 4.1 卡池

- 保留唯一池：`permanent-main-pool`。  
- 单抽 `tokenCost=10`，十连 `tenDrawCost=100`。  
- 关闭其他长期池（原创池/非原创池下线）。

## 4.2 抽卡返还

- 抽卡即时返还移除：未来抽卡不再写 `DRAW_REWARD` 正向 Token。  
- `GachaDraw.tokensReward` 保留历史字段，新记录固定为 `0`。

## 4.3 拆卡回收

固定稀有度回收（可叠加词条加成）：

| 稀有度 | WHITE | GREEN | BLUE | PURPLE | GOLD |
|---|---:|---:|---:|---:|---:|
| 回收 Token | 1 | 4 | 12 | 30 | 100 |

按当前历史掉落分布估算：`E(拆卡返还)=5.553/抽`，低于 `10/抽` 成本。

## 4.4 放置玩法（本版锁定）

核心规则：

1. 默认槽位：`PLACEMENT_SLOT_COUNT=5`。  
2. 每个槽位同一时刻只能放置 1 个库存实例（实例维度，不是基础卡维度）。  
3. 放置收益累计上限：`3000 Token`（账户维度）。  
4. 领取方式：仅手动领取（`claim`），不做自动发放。  
5. 累计达到上限后停止继续增长，直到用户领取后恢复累计。

累计口径：

```txt
placementBufferCap(user) =
  min(PLACEMENT_BUFFER_CAP_MAX, PLACEMENT_BUFFER_CAP_BASE + offlineBufferBonus(user))

placementPendingToken(user, t) =
  min(
    placementBufferCap(user),
    placementPendingToken(user, lastAccrualAt)
      + Σ(slotYieldPerHour(slot) * elapsedHours(lastAccrualAt, t))
  )

slotYieldPerHour(slot) =
  baseYieldByRarity(slot.card.rarity)
  * (1 + yieldBoostPercent(user))
```

其中：

- `PLACEMENT_BUFFER_CAP_MAX=3000`。  
- `PLACEMENT_BUFFER_CAP_BASE=2760`。  
- `baseYieldByRarity` 使用 2.6 节冻结值（`0.5/0.7/1.0/1.5/2.0` token/h）。  
- `offlineBufferBonus(user)` 的账号上限见 10.2，且最终上限仍不超过 `3000`。
- `yieldBoostPercent(user)` 的账号上限见 10.2（`<=10%`）。

领取与精度：

1. `pendingToken` 可按小数累积（建议 `numeric(20,6)`）。  
2. 用户领取时实际发放 `claimToken = floor(pendingToken)`，剩余小数继续保留在 `pendingToken`。  

页面布局约束（前端）：

1. 放置面板默认位于“卡池”与“抽卡记录”之间。  
2. 若移动端空间不足，可改为独立 `Tab`，但信息层级必须与卡池同级（非二级弹窗）。

## 5. 任务、里程碑、成就（按 Token 消耗）

## 5.1 任务计数口径（硬规则）

```txt
drawSpendToken(day/week)   = Σ draw.tokensSpent where paymentMethod == TOKEN
marketSpendToken(day/week) = Σ (positionOpen.margin + positionOpen.openFee)
missionSpendToken          = drawSpendToken + marketSpendToken
```

- 券抽卡（`DRAW_TICKET` / `DRAW10_TICKET`）不计入任务进度。  
- 市场仅统计“开仓事件”的消耗，平仓/结算回款不冲减已记进度。  
- 任务奖励默认“达成后手动领取一次”。

## 5.2 每日/每周任务

| 任务 | 条件 | 周期 | 奖励 |
|---|---|---|---|
| `DAILY_SPEND_300` | 当日 `missionSpendToken >= 300` | 每日 1 次 | `DrawTicket x3` |
| `WEEKLY_SPEND_1000` | 当周 `missionSpendToken >= 1000` | 每周 1 次 | `DrawTicket x10 + AffixReforgeTicket x1` |

## 5.3 收集里程碑（绝对数量，按解锁）

```txt
collectionUnlockedCount = unlockedVariantsEver
```

- `unlockedVariantsEver`：历史曾获得过的变体去重计数，去重键为 `(pageId, artVariantId, affixFingerprint)`。  
- 同一页面下，不同词条或不同异画都视为不同卡片变体。  
- 拆卡/交易不回退进度。  
- 奖励按“历史最高解锁数”触发，不可重复领取。

奖励规则：

1. 每新增 `200` 张解锁卡：`Draw10Ticket x1`。  
2. 每达到 `1000` 张解锁卡整数里程碑：额外 `Draw10Ticket x1 + AffixReforgeTicket x3`。

## 5.4 成就（一次性）

| 成就 | 条件 | 奖励 |
|---|---|---|
| `UR_COLLECT_5` | 解锁 UR `>=5` | `Draw10Ticket x1 + AffixReforgeTicket x1` |
| `UR_COLLECT_10` | 解锁 UR `>=10` | `Draw10Ticket x2 + AffixReforgeTicket x2` |
| `UR_COLLECT_50` | 解锁 UR `>=50` | `Draw10Ticket x6 + AffixReforgeTicket x6` |
| `UR_COLLECT_100` | 解锁 UR `>=100` | `Draw10Ticket x12 + AffixReforgeTicket x12` |
| `CARD_VARIANT_5` | 同一基础卡解锁 `>=5` 种异画 | `Draw10Ticket x2 + AffixReforgeTicket x3` |
| `SLOT_SAME_AUTHOR_5` | 5 主槽同作者 | `Draw10Ticket x1 + AffixReforgeTicket x1` |
| `SLOT_SAME_RARITY_5` | 5 主槽同稀有度 | `Draw10Ticket x1 + AffixReforgeTicket x1` |
| `SLOT_ALL_GOLD_5` | 5 主槽全 GOLD | `Draw10Ticket x2 + AffixReforgeTicket x2` |
| `SLOT_ALL_AFFIX_GOLD_5` | 5 主槽全金词条 | `Draw10Ticket x3 + AffixReforgeTicket x5` |

## 5.5 任务周期时区（锁定）

统一使用 `UTC+8`：

1. `daily` 周期键：`date(now at UTC+8)`。  
2. `weekly` 周期键：`weekStart(now at UTC+8, Monday 00:00)`。  
3. 跨服务（backend / user-backend / bff / frontend）显示与计算必须同口径，禁止本地时区漂移。

## 6. 市场机制（Oracle Index + Locked Position）

## 6.1 合约对象

- 每周每品类 1 个“类别指数合约”。  
- 周期：半开区间 `[周一 00:00, 下周一 00:00)`（UTC+8）。  
- 每周合约只定义该周 `indexOpen`、`indexClose`、结算状态，不承载 AMM 状态。  
- 对外方向统一：`LONG/SHORT`。
- 周收盘价强约束：`indexClose(week) = IndexPriceAtOrBefore(nextWeekStart)`（边界 tick 可与下周开盘同一时刻）。  
- 周开盘价强约束：`indexOpen(nextWeek) = indexClose(prevWeek)`，缺失时回退 `INDEX_BASE`。  
- `weeklyFinalize` 可写 `scoreFinal` 报表字段，但不得覆盖已发布的交易价序列。

## 6.2 价格源（账务唯一真价）

常量：

```txt
INDEX_BASE  = 100
INDEX_K     = 0.20
SCORE_CLAMP = ln(0.97 / 0.03) = 3.476099
```

价格公式（直接用 score，不走交易驱动）：

```txt
score_t     = clamp(score_provisional_t, -SCORE_CLAMP, +SCORE_CLAMP)
indexMark_t = indexOpen_week * exp(INDEX_K * score_t)
```

说明：

- `indexMark_t` 是可交易、可结算、可爆仓检查的唯一价格。  
- 价格由 backend 数据更新驱动，不受用户开仓量影响。  
- 不再使用 `markPrice=LMSR_price(q)` 做账务。
- `indexMark_t` 的账务精度以 backend 持久化值为准；bff/frontend/user-backend 不复算 `exp()`，仅透传。

## 6.3 Tick 与时间语义

新增 `CategoryIndexTick`（阶梯函数价格）：

```txt
I(t) = last indexMark from tick(asOfTs <= t)
```

规则：

1. `backend` 的 `CategoryIndexTickJob` 按固定间隔（`1` 小时）生成心跳 tick，`asOfTs` 对齐到整点边界。  
2. `watermarkTs` 语义是“本次 tick 所基于的数据完整性游标”，可落后于 `asOfTs`。  
3. 即便 `watermarkTs` 未前进，也要允许生成“心跳 tick”（`scoreProvisional/indexMark` 可与上一条相同）以保证引擎活性。  
4. 结算与爆仓均按“到该时刻最近一个 tick”取价，禁止插值重算。  
5. 约束：`asOfTs` 在 `(category)` 维度必须单调递增，且 `unique(category, asOfTs)`。
6. `asOfTs` 是交易时钟，不等于全部指标都“新鲜到该时刻”；各指标计算必须先做可用性裁剪。  
7. `votes_up/votes_down/sentiment` 统一按 `UTC+8` 的 `date(asOfTs)-1` 截断（T+1 票据可用规则），禁止混入当日票。  
8. 上游 sync 当前约每 `2` 小时推进一次，因此同一 `watermarkTs` 常见连续 `2~3` 条小时 tick（价格可相同）。  
9. 当 `watermarkTs` 停滞或票据日结未到账时，允许连续心跳 tick（价格可不变）；引擎仍按 wall-clock 做到期兜底。

## 6.4 交易模型（仅开仓，无现货）

- 删除 `spot buy/sell`。  
- 市场交易统一为：`POST /positions/open`。  
- 所有仓位均锁仓到期自动结算（可爆仓）。  
- 不支持中途手动平仓（v0.2.1 简化规则）。

## 6.5 对手盘展示（只展示，不定价）

可展示：

- 各品类/档位 `LONG` 与 `SHORT` 的人数、总手数、总保证金。  
- 最近开仓流（匿名名/方向/手数/杠杆/开仓指数）。

硬约束：

- 这些数据不得进入价格计算、爆仓判定与结算公式。

## 6.6 费用模型（游戏化口径）

- `openFee`：按保证金收取，采用“锁仓档位基准费率 + 杠杆附加费率”。  
- `settleFee`：仅对盈利部分收取（亏损/爆仓不收）。

锁定费率（经历史回放验算后定版）：

| 锁仓档位 | `openFeeBaseRate` | `settleFeeRate` |
|---|---:|---:|
| T1 | 0.8% | 8.0% of profit |
| T7 | 0.7% | 8.0% of profit |
| T15 | 0.6% | 8.0% of profit |
| T30 | 0.5% | 8.0% of profit |

杠杆附加费率（`openFeeLeverageSurcharge`）：

| 杠杆 | 1x | 2x | 5x | 10x | 20x | 50x | 100x |
|---|---:|---:|---:|---:|---:|---:|---:|
| 附加费率 | 0.0% | 0.2% | 0.8% | 1.8% | 4.0% | 10.0% | 22.0% |

开仓费公式：

```txt
openFeeRate(lockTier, leverage) =
  openFeeBaseRate(lockTier) + openFeeLeverageSurcharge(leverage)
```

验算说明（2026-02-09）：

- 验算样本使用 `docs/plots/v0.2.1-kline/daily_score_index.csv` 的 `1/7/15/30` 天持仓回放分布。  
- 目标是让低杠杆体感成本可接受、高杠杆维持高风险高波动，并保留后续经济调参空间。  

## 7. Score 设计（全历史 + 跨年份归一化）

## 7.1 指标定义（周级）

对品类 `c`、周 `w`：

- `rev(c,w)`：`PageDailyStats.revisions` 周和  
- `new(c,w)`：`publishedAtCanonical(page)` 落在周内的数量  
- `votesUp(c,w)` / `votesDown(c,w)`：投票方向计数（按 T+1 可用，默认指 sanitized 后 `*_adj`）  
- `votesTotal(c,w) = votesUp(c,w) + votesDown(c,w)`：投票参与度（默认 `*_adj`）  
- `approval(c,w) = (votesUp + SENTIMENT_ALPHA) / (votesUp + votesDown + SENTIMENT_ALPHA + SENTIMENT_BETA)`  
- `sentiment(c,w) = logit(clamp(approval(c,w), 0.01, 0.99))`：口碑方向信号（默认 `*_adj`）  
- `deleted(c,w)`：`PageVersion.isDeleted` 的 `false->true` 周新增事件数  
- `netContent(c,w) = new(c,w) - deleted(c,w)`：内容净增长  
- `pageCountStart(c,w)`：`weekStart(w)` 时刻的 live 页面数（与 2.1.2 分类口径一致）  
- `pageCountEnd(c,w)`：`weekEnd(w)` 时刻的 live 页面数（审计对照）  
- `delRate(c,w) = deleted(c,w) / max(1, pageCountStart(c,w))`：按规模归一的删帖压力

类目归属硬规则（防未来信息污染）：

- 任意事件在时刻 `τ` 的 category，必须由 `<=τ` 的页面版本标签快照决定。  
- 禁止使用“当前最新标签”回刷历史周/历史 tick（否则同一 `asOfTs` 无法稳定复算）。
- `*_raw` 仅用于审计/对照，生产 score 入分必须使用 `*_adj`（sanitized）口径。

`OVERALL` 使用全站同口径指标。

其中：

```txt
firstRevisionTs(page) = MIN(Revision.timestamp) for page
firstCreatedRevTs(page) = MIN(Revision.timestamp where type='PAGE_CREATED')

publishedAtCanonical(page) =
  if firstPublishedAt and (firstCreatedRevTs or firstRevisionTs):
    LEAST(firstPublishedAt, COALESCE(firstCreatedRevTs, firstRevisionTs))
  else:
    COALESCE(firstPublishedAt, firstCreatedRevTs, firstRevisionTs)
```

要求：`publishedAtCanonical` 禁止使用 `Page.createdAt`（入库时间）作为候选时间源。

## 7.2 归一化流程

### Step A：同阶段变化与水平信号

```txt
// 非负增长指标
d_m(c,w) = ln(1 + m(c,w)) - ln(1 + m(c,w-1))
d_m(g,w) = ln(1 + m(OVERALL,w)) - ln(1 + m(OVERALL,w-1))
  where m ∈ { rev, votesTotal }

// signed 指标（允许负值）
signedLog(x) = sign(x) * ln(1 + abs(x))
d_net(c,w) = signedLog(netContent(c,w)) - signedLog(netContent(c,w-1))
d_net(g,w) = signedLog(netContent(OVERALL,w)) - signedLog(netContent(OVERALL,w-1))

// 水平项采用“同阶段水平差分”
d_sent(c,w)    = sentiment(c,w) - sentiment(c,w-1)
d_sent(g,w)    = sentiment(OVERALL,w) - sentiment(OVERALL,w-1)

d_delRate(c,w) = ln(1 + delRate(c,w)) - ln(1 + delRate(c,w-1))
d_delRate(g,w) = ln(1 + delRate(OVERALL,w)) - ln(1 + delRate(OVERALL,w-1))
```

### Step B：通胀折扣（名义 vs 相对）

```txt
INFLATION_ALPHA ∈ [0,1]

x_m(c,w) = d_m(g,w)                                       , if c == OVERALL
x_m(c,w) = d_m(c,w) - INFLATION_ALPHA * d_m(g,w)         , otherwise
  where m ∈ { rev, votesTotal }

x_net(c,w) = d_net(g,w)                                   , if c == OVERALL
x_net(c,w) = d_net(c,w) - INFLATION_ALPHA * d_net(g,w)   , otherwise

x_sent(c,w) = d_sent(g,w)                                 , if c == OVERALL
x_sent(c,w) = d_sent(c,w) - INFLATION_ALPHA * d_sent(g,w), otherwise

x_delRate(c,w) = d_delRate(g,w)                                  , if c == OVERALL
x_delRate(c,w) = d_delRate(c,w) - INFLATION_ALPHA * d_delRate(g,w), otherwise
```

说明：

- `INFLATION_ALPHA=1` 等价“纯相对强弱”；`0` 等价“纯名义增长”。  
- 本版默认 `INFLATION_ALPHA=0.5`，兼顾“社区整体发展/萎缩”与“品类相对表现”。  
- `INFLATION_ALPHA` 仅用于 score 去量纲，不得引入指数外生漂移。
- v0.2.2 预留拆分位：`INFLATION_ALPHA_GROWTH` 与 `INFLATION_ALPHA_LEVEL`；v0.2.1 先统一等于 `INFLATION_ALPHA`。

### Step C：全历史标准化（expanding）

```txt
mu_m(c,w)    = mean( x_m(c, <=w-1) )
sigma_m(c,w) = stddev( x_m(c, <=w-1) )
z_m_raw(c,w) = (x_m(c,w) - mu_m(c,w)) / max(sigma_m(c,w), 0.10)
z_m(c,w)     = clamp(z_m_raw(c,w), -Z_CLAMP, +Z_CLAMP)

z_net_raw(c,w)     = (x_net(c,w) - mu_net(c,w)) / max(sigma_net(c,w), 0.10)
z_sent_raw(c,w)    = (x_sent(c,w) - mu_sent(c,w)) / max(sigma_sent(c,w), 0.10)
z_delRate_raw(c,w) = (x_delRate(c,w) - mu_delRate(c,w)) / max(sigma_delRate(c,w), 0.05)

z_net(c,w)     = clamp(z_net_raw(c,w), -Z_CLAMP, +Z_CLAMP)
z_sent(c,w)    = clamp(z_sent_raw(c,w), -Z_CLAMP, +Z_CLAMP)
z_delRate(c,w) = clamp(z_delRate_raw(c,w), -Z_CLAMP, +Z_CLAMP)
```

冷启动保护（必须实现）：

- 对任意 `z_*`，若同 `(category, offset)` 可用历史样本数 `< MIN_Z_HISTORY`，则该项 `z=0`。  
- 推荐 `MIN_Z_HISTORY=8`（按同 offset 至少 8 周历史），防止冷启动周被极值直接打满 `SCORE_CLAMP`。  
- 该规则同样适用于 7.3 的周内 provisional 标准化。

### Step D：稀疏降权 + 口碑样本折扣（按品类）

```txt
baseGrowthWeight = { rev:0.22, votesTotal:0.25, netContent:0.20 }
sentimentWeight  = 0.15

nonZeroRatio_k(c,w) = ratio(abs(raw_k(c,·)) > 0) over last 52 weeks
weight'_k(c,w)      = baseGrowthWeight_k * sqrt(nonZeroRatio_k(c,w))
weight_k(c,w)       = normalize(weight'_k(c,w)) * (1 - sentimentWeight)
weight_sentiment(c,w)= sentimentWeight

n_vote(c,w)         = votesTotal(c,w)
shrink_vote(c,w)    = sqrt(n_vote(c,w) / (n_vote(c,w) + VOTE_K))
z_votes_eff(c,w)    = z_votesTotal(c,w) * shrink_vote(c,w)

shrink_sent(c,w)    = sqrt(n_vote(c,w) / (n_vote(c,w) + SENTIMENT_K))
z_sent_eff(c,w)     = z_sent(c,w) * shrink_sent(c,w)
```

### Step E：组合得分

```txt
scoreBase(c,w) =
  weight_rev(c,w)         * z_rev(c,w)
  + weight_votesTotal(c,w)* z_votes_eff(c,w)
  + weight_netContent(c,w)* z_net(c,w)
  + weight_sentiment(c,w) * z_sent_eff(c,w)
```

最终得分：

```txt
score(c,w) = scoreBase(c,w) - DEL_RATE_PENALTY * z_delRate(c,w)
```

## 7.3 周内 `score_provisional(asOfTs)`（Tick 定价真源）

目标：周一开盘可回到 `0`、周内可随数据变化、且可离线复算。

设 `t = asOfTs`，`weekStart(t)` 为该周周一 00:00（UTC+8），`offsetBucket(t) = floor((t-weekStart)/1h)`。

先定义“指标可用时间”：

```txt
t_eff_non_vote(t) = min(t, watermarkTs_metric)
voteCutoffDate(t) = date(t at UTC+8) - 1 day
t_eff_vote(t)     = min(endOfDay(voteCutoffDate(t), UTC+8), watermarkTs_vote)
```

其中：

- `rev/new/deleted` 使用 `t_eff_non_vote`。  
- `votesUp/votesDown/votesTotal/sentiment` 强制使用 `t_eff_vote`（日结 T+1）。
- 事件归属 category 使用“事件时刻标签快照”，不得使用未来标签回刷历史。

周内累计（WTD）：

```txt
rev_wtd(c,t)      = Σ rev(c,τ),      τ ∈ [weekStart(t), t_eff_non_vote(t)]
new_wtd(c,t)      = Σ new(c,τ),      τ ∈ [weekStart(t), t_eff_non_vote(t)]
deleted_wtd(c,t)  = Σ deleted(c,τ),  τ ∈ [weekStart(t), t_eff_non_vote(t)]

rev_wtd_prev(c,t)      = Σ rev(c,τ),      τ ∈ [weekStart(t)-7d, t_eff_non_vote(t)-7d]
new_wtd_prev(c,t)      = Σ new(c,τ),      τ ∈ [weekStart(t)-7d, t_eff_non_vote(t)-7d]
deleted_wtd_prev(c,t)  = Σ deleted(c,τ),  τ ∈ [weekStart(t)-7d, t_eff_non_vote(t)-7d]

votesUp_wtd(c,t)   = Σ votesUp(c,τ),   τ ∈ [weekStart(t), t_eff_vote(t)]
votesDown_wtd(c,t) = Σ votesDown(c,τ), τ ∈ [weekStart(t), t_eff_vote(t)]
votesTotal_wtd(c,t)= votesUp_wtd(c,t) + votesDown_wtd(c,t)

votesUp_wtd_prev(c,t)   = Σ votesUp(c,τ),   τ ∈ [weekStart(t)-7d, t_eff_vote(t)-7d]
votesDown_wtd_prev(c,t) = Σ votesDown(c,τ), τ ∈ [weekStart(t)-7d, t_eff_vote(t)-7d]
votesTotal_wtd_prev(c,t)= votesUp_wtd_prev(c,t) + votesDown_wtd_prev(c,t)

// 离线按日回放时，与上式等价的实现方式：
votes*_wtd_eff(day)      = shift(votes*_wtd_raw(day), 1) within (category, week_start), monday=0
votes*_wtd_prev_eff(day) = shift(votes*_wtd_prev_raw(day), 1) within (category, week_start), monday=0

approval_wtd(c,t) =
  (votesUp_wtd(c,t) + SENTIMENT_ALPHA) /
  (votesUp_wtd(c,t) + votesDown_wtd(c,t) + SENTIMENT_ALPHA + SENTIMENT_BETA)

approval_wtd_prev(c,t) =
  (votesUp_wtd_prev(c,t) + SENTIMENT_ALPHA) /
  (votesUp_wtd_prev(c,t) + votesDown_wtd_prev(c,t) + SENTIMENT_ALPHA + SENTIMENT_BETA)

sentiment_wtd(c,t) = logit(clamp(approval_wtd(c,t), 0.01, 0.99))
sentiment_wtd_prev(c,t) = logit(clamp(approval_wtd_prev(c,t), 0.01, 0.99))

netContent_wtd(c,t)      = new_wtd(c,t) - deleted_wtd(c,t)
netContent_wtd_prev(c,t) = new_wtd_prev(c,t) - deleted_wtd_prev(c,t)

delRate_wtd(c,t)   = deleted_wtd(c,t) / max(1, pageCountStart(c, weekStart(t)))
delRate_wtd_prev(c,t)= deleted_wtd_prev(c,t) / max(1, pageCountStart(c, weekStart(t)-7d))
```

同阶段周环比（对数）：

```txt
d_rev(c,t)        = ln(1 + rev_wtd(c,t))        - ln(1 + rev_wtd_prev(c,t))
d_votesTotal(c,t) = ln(1 + votesTotal_wtd(c,t)) - ln(1 + votesTotal_wtd_prev(c,t))

signedLog(x)      = sign(x) * ln(1 + abs(x))
d_net(c,t)        = signedLog(netContent_wtd(c,t)) - signedLog(netContent_wtd_prev(c,t))

d_sent(c,t)       = sentiment_wtd(c,t) - sentiment_wtd_prev(c,t)
d_delRate(c,t)    = ln(1 + delRate_wtd(c,t)) - ln(1 + delRate_wtd_prev(c,t))
```

通胀折扣（同第 7.2，`INFLATION_ALPHA=α`）：

```txt
x_k(c,t) = d_k(OVERALL,t)                                      , if c == OVERALL
x_k(c,t) = d_k(c,t) - α * d_k(OVERALL,t)                      , otherwise
  where k ∈ { rev, votesTotal, net }

x_sent(c,t) = d_sent(OVERALL,t)                               , if c == OVERALL
x_sent(c,t) = d_sent(c,t) - α * d_sent(OVERALL,t)            , otherwise

x_delRate(c,t) = d_delRate(OVERALL,t)                         , if c == OVERALL
x_delRate(c,t) = d_delRate(c,t) - α * d_delRate(OVERALL,t)    , otherwise
```

标准化（推荐：按小时桶 expanding）：

```txt
z_k_raw(c,t) =
  (x_k(c,t) - mu_k(c,offsetBucket(t))) / max(sigma_k(c,offsetBucket(t)), 0.10)
  where k ∈ { rev, votesTotal, net }

z_sent_raw(c,t) =
  (x_sent(c,t) - mu_sent(c,offsetBucket(t))) / max(sigma_sent(c,offsetBucket(t)), 0.10)

z_delRate_raw(c,t) =
  (x_delRate(c,t) - mu_delRate(c,offsetBucket(t))) / max(sigma_delRate(c,offsetBucket(t)), 0.05)

z_k(c,t)       = clamp(z_k_raw(c,t), -Z_CLAMP, +Z_CLAMP)
z_sent(c,t)    = clamp(z_sent_raw(c,t), -Z_CLAMP, +Z_CLAMP)
z_delRate(c,t) = clamp(z_delRate_raw(c,t), -Z_CLAMP, +Z_CLAMP)

n_vote(c,t)      = votesTotal_wtd(c,t)
shrink_vote(c,t) = sqrt(n_vote(c,t) / (n_vote(c,t) + VOTE_K))
z_votes_eff(c,t) = z_votesTotal(c,t) * shrink_vote(c,t)

shrink_sent(c,t) = sqrt(n_vote(c,t) / (n_vote(c,t) + SENTIMENT_K))
z_sent_eff(c,t)  = z_sent(c,t) * shrink_sent(c,t)
```

周内 provisional 分数：

```txt
score_signal_raw(c,t) =
    weight_rev(c,t)          * z_rev(c,t)
  + weight_votesTotal(c,t)   * z_votes_eff(c,t)
  + weight_netContent(c,t)   * z_net(c,t)
  + weight_sentiment(c,t)    * z_sent_eff(c,t)
  - DEL_RATE_PENALTY * z_delRate(c,t)

score_ref(c,t) =
  median(score_signal_raw(c,τ))
  where τ in same offsetBucket as t,
        τ within previous DRIFT_WINDOW_WEEKS,
        and τ < t

beta(c) = DRIFT_BETA_OVERALL , if c == OVERALL
beta(c) = DRIFT_BETA_TRANSLATION , if c == TRANSLATION
beta(c) = DRIFT_BETA_OTHERS  , otherwise

score_provisional_raw(c,t) = score_signal_raw(c,t) - beta(c) * score_ref(c,t)
score_provisional(c,t)     = clamp(score_provisional_raw(c,t), -SCORE_CLAMP, +SCORE_CLAMP)
```

说明：`weight_* (c,t)` 取 `weekStart(t)` 对应周的 Step D 权重（周内固定，跨周重算）。

实现保底规则：

1. 若某 bucket 历史样本不足（`mu/sigma` 不稳定），该 bucket 的 `z` 取 `0`（或回退周级基线）。  
2. 周开盘第一条 tick 强制 `score_provisional=0`，保证 `indexMark=indexOpen`。  
3. 全端审计只认 `CategoryIndexTick` 存储值；复算用于审计告警，不用于改写历史 tick。
4. `votes/sentiment` 每日只在“新结算票据可用后”更新；同日内不随新投票实时波动。  
5. 若 `vote` 可用日期滞后超过 48 小时，触发告警并允许暂时冻结 `votes/sentiment` 分量（其余分量照常更新）。  
6. 漂移中和只允许使用“历史窗口统计量”（`score_ref`），禁止引入固定正/负常数漂移。
7. 若某类目早期样本不足导致权重不可用，临时回退 `baseGrowthWeight + sentimentWeight`，并在样本稳定后切回动态权重。
8. 所有组件 z 值在入分前先做 `Z_CLAMP` 截断，避免单点事件触发总分极值。
9. 所有同阶段环比必须使用 `t_eff_*` 对齐的 `prev-window`，禁止直接用 `t-7d`。

## 7.4 小时 Forecast 锚定（跨日/跨周严格一致）

目标：每小时都有可交易价格更新，同时满足：

1. 日内小时 forecast 在跨日时刻恰好等于当日收盘价。  
2. 每周最后一个小时 tick 恰好等于当周收盘价。  

定义（以日收盘为锚）：

```txt
dayCloseTs(d) = (d+1) 00:00:00 at UTC+8

S_d = scoreProvisionalAtOrBefore(dayCloseTs(d))
I_d = indexPriceAtOrBefore(dayCloseTs(d))

S_d      = 当日收盘 score（day-close score）
I_d      = 当日收盘 index（day-close index）
S_{d-1}  = 前一日收盘 score
I_{d-1}  = 前一日收盘 index
h        = 1..HOURLY_TICKS_PER_DAY
u        = h / HOURLY_TICKS_PER_DAY
```

小时 forecast：

```txt
S_fcst(d,h) = S_{d-1} + u * (S_d - S_{d-1})

I_fcst(d,h) = I_{d-1} * exp(INDEX_K * (S_fcst(d,h) - S_{d-1}))
            = I_{d-1} * (I_d / I_{d-1})^u
```

锚定性质（必须成立）：

```txt
h = HOURLY_TICKS_PER_DAY => I_fcst(d,h) = I_d
day = weekEndDay and h = HOURLY_TICKS_PER_DAY => I_fcst = indexClose(week)
```

实现约束：

1. `CategoryIndexTick` 仅存 Oracle 真价，不写入 forecast。  
2. forecast 单独落 `CategoryIndexForecastTick`（或独立查询端点）供前端绘图；`asOfTs` 在该序列内保持唯一。  
3. 引擎爆仓/结算只能读取 `CategoryIndexTick`，禁止读取 forecast。  
4. 历史 Oracle tick 一经发布不得回写；forecast 仅允许覆盖“未来 asOfTs”。  
5. 若某自然日没有新 tick，`dayClose` 取 `dayCloseTs(d)` 之前最近一条 tick；并标记 `isStale=true` 供监控与前端提示。  

## 8. 指数变化幅度验证（Oracle 口径）

仿真口径：

1. 使用周级回放序列（2017 起，warmup 后）作为 `scoreFinal`。  
2. 日收盘使用第 7.3 节 `score_provisional`；小时 tick 使用第 7.4 节锚定公式（`h=24` 精确等于当日收盘）。  
3. 周末最后小时 tick 强约束等于该周 `indexClose`。  
4. 价格用第 6 章公式（`INDEX_BASE=100`、`INDEX_K=0.20`、`SCORE_CLAMP=±3.476099`）。  
5. 不加交易驱动修正（与 Oracle 阶梯源一致）。
6. 本表需按当前参数（含 drift neutralization）定期重跑回填。

全品类合并结果：

| 指标 | `p50` | `p90` | `p95` | `p99` | `max` |
|---|---:|---:|---:|---:|---:|
| 周收盘相对开盘 `|Δindex|/index` | `8.13%` | `25.19%` | `33.72%` | `64.24%` | `100.41%` |
| 小时 `|Δindex|/index` | `0.05%` | `0.15%` | `0.19%` | `0.34%` | `0.41%` |
| 小时 `|Δindex|`（点） | `0.05` | `0.15` | `0.20` | `0.38` | `0.83` |
| 日内 `|Δindex|/index` | `1.17%` | `3.52%` | `4.64%` | `8.28%` | `10.44%` |
| 日内 `|Δindex|`（点） | `1.16` | `3.60` | `4.84` | `9.15` | `18.95` |

按品类（`|Δindex|/index`）：

| 品类 | 周 `p90` | 小时 `p90` | 小时 `p99` | 日内 `p90` | 日内 `p99` |
|---|---:|---:|---:|---:|---:|
| OVERALL | `14.34%` | `0.09%` | `0.41%` | `2.16%` | `10.44%` |
| TRANSLATION | `23.08%` | `0.14%` | `0.26%` | `3.24%` | `6.32%` |
| SCP | `25.39%` | `0.15%` | `0.40%` | `3.63%` | `9.41%` |
| TALE | `28.58%` | `0.16%` | `0.34%` | `3.81%` | `8.46%` |
| GOI | `30.67%` | `0.17%` | `0.30%` | `4.17%` | `7.35%` |
| WANDERERS | `26.67%` | `0.15%` | `0.30%` | `3.59%` | `7.36%` |

结论：Oracle 口径下小时波动显著更平滑，日内与周级仍有可感知趋势。

## 9. 锁仓仓位（结算随涨跌幅）

## 9.1 锁仓档位与杠杆

| 档位 | 时长 | 可用杠杆 | `minLots` |
|---|---:|---|---:|
| T1 | 24h | `1x/2x/5x/10x` | 10 |
| T7 | 168h | `1x/2x/5x/10x/20x` | 20 |
| T15 | 360h | `1x/2x/5x/10x/20x/50x` | 30 |
| T30 | 720h | `1x/2x/5x/10x/20x/50x/100x` | 50 |

最小交易单位：

```txt
LOT_TOKEN = 10
margin    = lots * LOT_TOKEN
lots      = integer and lots >= minLots(lockTier)
```

## 9.2 开仓

```txt
entryIndex = current indexMark
expireAt   = now + duration(lockTier)
openFee    = floor(margin * openFeeRate(lockTier, leverage))
walletDelta= -(margin + openFee)
```

## 9.3 仓位权益（非二元）

设：

- `I0`：开仓指数  
- `It`：当前指数（tick 阶梯）  
- `M`：保证金  
- `L`：杠杆  
- `r = (It - I0) / I0`

权益：

```txt
equity_long(t)  = M * (1 + L * r)
equity_short(t) = M * (1 - L * r)
```

## 9.4 爆仓规则（即时清零）

```txt
if equity_t <= 0:
  status = LIQUIDATED
  payout = 0
  liquidatedAt = now
```

触发时机：

1. 每次收到新 `CategoryIndexTick` 后。  
2. 每分钟兜底巡检一次。

## 9.5 到期冻结与自动结算

状态机：`OPEN -> EXPIRED -> SETTLED`，或 `OPEN -> LIQUIDATED`。

顺序要求（避免竞态）：

1. 对 `expireAt <= tick.asOfTs` 的 `OPEN` 仓位先标记 `EXPIRED`。  
2. 仅对仍 `OPEN` 的仓位做爆仓检查。  
3. 对 `EXPIRED` 仓位按 `IndexPriceAtOrBefore(expireAt)` 自动结算。
4. 活性兜底：即使 tick 同步异常，也必须每分钟按 `expireAt <= now` 扫描过期并结算。

## 9.6 结算与舍入

```txt
equity_exp = equity(position, settleIndex)
profit     = max(0, equity_exp - M)
settleFee  = floor(profit * settleFeeRate)
payout     = max(0, floor(equity_exp - settleFee))
realizedRoi= (payout - M) / M
```

- 所有 Token 发放最终向下取整（`floor`）。  
- 亏损仓位不收 `settleFee`。

## 9.7 结算引擎伪代码（实现对齐）

```txt
// open position
entryIndex = categoryState.lastIndex
entryTickTs = categoryState.lastTickTs
expireAt   = now + duration(lockTier)
margin     = lots * LOT_TOKEN
openFee    = floor(margin * openFeeRate(lockTier, leverage))

wallet -= (margin + openFee)
position = OPEN(entryIndex, margin, leverage, side, expireAt)

// on each new tick
categoryState.lastIndex = tick.indexMark

for p in OPEN where p.category == tick.category:
  if p.expireAt <= tick.asOfTs:
    p.status = EXPIRED

for p in OPEN where p.category == tick.category:
  equity = calcEquity(p, tick.indexMark)
  if equity <= 0:
    p.status = LIQUIDATED
    p.payout = 0
    p.liquidatedAt = now

for p in EXPIRED where p.category == tick.category:
  settleIndex = IndexPriceAtOrBefore(p.expireAt)
  settleTickTs = TickTsAtOrBefore(p.expireAt)
  equityExp   = calcEquity(p, settleIndex)
  profit      = max(0, equityExp - p.margin)
  settleFee   = floor(profit * settleFeeRate(p.lockTier))
  payout      = max(0, floor(equityExp - settleFee))
  p.status    = SETTLED
  p.settleIndex = settleIndex
  p.settleTickTs = settleTickTs
  p.settleFee = settleFee
  p.payout    = payout
```

## 10. 异画、词条、库存口径

## 10.1 异画

- 多图页优先多图异画。  
- 单图/无图页使用样式异画模板（NOIR/HALFTONE/BLUEPRINT/GRAIN）。  
- 异画进入库存实例层，不再只依赖卡定义图。

## 10.2 词条

保留：`LOCKED`、`FREE_SLOT`、`YIELD_BOOST`、`OFFLINE_BUFFER`、`DISMANTLE_BONUS`。  
账号上限：`YIELD_BOOST<=+10%`、`OFFLINE_BUFFER<=+240`。

词条视觉效果（前端强约束）：

1. 同一页面的不同词条版本必须在卡面上可直观看出差异（非仅文字标签）。  
2. 至少提供“黑白/彩色/镀层”三类差异化效果；推荐用 `filter + overlay + border` 组合实现。  
3. 词条视觉样式必须由后端返回 `affixVisualStyle`（枚举）驱动，前端不得硬编码词条名做样式映射。

建议样式映射：

| 词条 | `affixVisualStyle` | 视觉效果建议 |
|---|---|---|
| `LOCKED` | `mono` | 黑白、低饱和、暗边框 |
| `FREE_SLOT` | `silver` | 银色描边、轻微高光 |
| `YIELD_BOOST` | `gold` | 金色外发光、暖色镀层 |
| `OFFLINE_BUFFER` | `cyan` | 青色描边、像素网格纹理 |
| `DISMANTLE_BONUS` | `prism` | 多彩渐变描边、棱镜高光 |

## 10.3 库存模型

新增：

- `GachaInventoryStack`（同页面不同异画/词条/绑定态可并存）  
- `GachaCardUnlock`（页面级图鉴解锁）  
- `GachaCardVariantUnlock`（变体级图鉴解锁）  
- `GachaCardArtVariant`（异画定义）

库存唯一键（必须）：

```txt
stackKey = (userId, pageId, artVariantId, affixFingerprint, bindState)
```

说明：

1. 不同词条版本、不同异画版本都不是同一张卡片。  
2. 页面浏览层按 `pageId` 聚合为一个入口；进入详情后展示该页面下所有已拥有变体（按 `artVariantId + affixFingerprint` 分组）。

## 11. 数据模型（服务拆分）

## 11.1 `user-backend`（`scpper_user`）

### 库存与图鉴

- `GachaInventoryStack(id, userId, pageId, cardId, artVariantId, affixFingerprint, affixVisualStyle, bindState, quantity, updatedAt)`  
- `GachaCardUnlock(userId, pageId, firstUnlockedAt, updatedAt)`  
- `GachaCardVariantUnlock(userId, pageId, artVariantId, affixFingerprint, firstUnlockedAt, updatedAt)`

### 抽卡与券

- `GachaTicketWallet(userId, drawTicket, draw10Ticket, affixReforgeTicket, updatedAt)`  
- `GachaTicketLedger(id, userId, ticketType, amount, reason, rewardRef, refId, createdAt)`  
- `GachaMissionProgress(userId, missionKey, periodKey, spendToken, isCompleted, claimedAt, updatedAt)`  
- `GachaAchievementProgress(userId, achievementKey, progress, unlockedAt, claimedAt, updatedAt)`  
- `GachaPlacementSlot(userId, slotIndex, inventoryStackId, assignedAt, updatedAt)`  
- `GachaPlacementState(userId, lastAccrualAt, pendingToken, bufferCap, effectiveYieldPerHour, updatedAt)`  
- `GachaPlacementLedger(id, userId, amount, reason, refId, createdAt)`  
- `ApiIdempotencyRecord(id, userId, method, path, idemKey, requestHash, responseJson, statusCode, createdAt, expireAt)`

### 市场

- `MarketContract(id, category, weekStart, weekEnd, status, settleScore, indexOpen, indexClose, indexK, closeTickTs, settledAt)`  
- `MarketCategoryState(category, lastTickTs, lastIndexMark, lastWatermarkTs, updatedAt)`  
- `MarketPosition(id, userId, contractId, category, side, lockTier, lots, margin, openFee, leverage, entryIndex, entryTickTs, expireAt, status, liquidatedAt, settledAt, settleIndex, settleTickTs, settleFee, payout, openRequestKey)`  
- `MarketPositionEvent(id, positionId, eventType, payload, createdAt)`  
- `MarketOpponentSnapshot(category, lockTier, asOfTs, longUsers, shortUsers, longLots, shortLots, longMargin, shortMargin)`

## 11.2 `backend`（`scpper-cn`）

- `CategoryMarketWeeklyMetric(category, weekStart, weekEnd, revW, votesUpW, votesDownW, votesTotalW, approvalW, sentimentW, newW, deletedW, netContentW, delRateW, zRev, zVotesTotal, zNet, zSentiment, zDelRate, scoreBase, scoreFinal, inflationAlpha, indexOpen, indexClose, finalizedAt, watermarkTs)`  
- `CategoryMarketHourlyMetric(category, asOfHour, revPart, votesUpPart, votesDownPart, votesTotalPart, sentimentPart, newPart, deletedPart, netContentPart, delRatePart, zRev, zVotesTotal, zNet, zSentiment, zDelRate, scoreSignalRaw, scoreRef, scoreProvisional, inflationAlpha, voteCutoffDate, voteRuleVersion, voteScale, watermarkTs)`  
- `CategoryIndexTick(category, asOfTs, watermarkTs, voteCutoffDate, voteRuleVersion, voteScale, scoreSignalRaw, scoreRef, scoreProvisional, indexMark, createdAt)`
- `CategoryIndexForecastTick(category, asOfTs, settleDay, hourOffset, forecastScore, forecastIndex, dayCloseScore, dayCloseIndex, prevDayCloseIndex, createdAt)`（仅展示，不入账）
- 约束：`CategoryIndexTick` 需 `unique(category, asOfTs)`，并保证 `(category, asOfTs)` 单调。

## 11.3 删除的 legacy 方向

- 删除 `MarketAmmState`、`MarketSpotPosition`、`MarketTrade`（spot 语义）。  
- 删除订单簿/深度驱动定价路径。  
- 不再使用 `markPrice=LMSR_price(q)` 参与账务。

## 12. 任务调度与同步

## 12.1 `backend`

1. `CategoryMarketAccumulatorJob`：随每轮 sync 增量刷新 WTD 原子累计（当前运行态约 2 小时一轮）。  
2. `CategoryVoteOutlierAdjustJob`：按第 17.2 节计算 `rz_local/scale`，仅对配置窗口内异常日做票据截断修正（含 `ruleVersion`）。  
3. `CategoryVoteDailySettleJob`：每日固化 `voteCutoffDate=D-1` 的票据快照（`votesUp/votesDown/approval/sentiment`）及修正字段。  
4. `CategoryMarketHourlyMetricJob`：每小时固化快照（无新可用数据时允许沿用前值并标记心跳）。  
5. `CategoryIndexTickJob`：每小时整点生成 Oracle tick（真价序列）；在上游约 2 小时一轮 sync 场景下，同 `watermarkTs` 常见连续 2~3 条小时 tick。  
6. `CategoryIndexForecastJob`：按第 7.4 节生成小时 forecast 序列，写入 `CategoryIndexForecastTick`（仅展示）。  
7. `CategoryMarketWeeklyFinalizeJob`：周结算窗口写入 `scoreFinal` 报表字段，不回写交易价。  
8. 记录 `watermarkTs` 与 `voteCutoffDate` 并持续产 tick；任一滞后由监控告警，不阻断 tick 产线。

## 12.2 `user-backend`

1. `MarketTickSyncJob`：每 5 分钟拉取（或订阅）新 tick，兼容小时 tick 粒度与网络重试。  
2. `MarketContractOpenJob`：周一 00:00 开新合约，`indexOpen` 取上一周 `indexClose`，缺失则 `INDEX_BASE`。  
3. `MarketPositionEngineJob`：收到新 tick 后按“先过期、再爆仓、后结算”执行；并每分钟按 `now` 做到期兜底扫描。  
4. `MarketEngineRepairJob`：每日低频幂等补偿。  
5. `MissionProgressJob`：抽卡与开仓事件驱动更新，不做全表扫描。  
6. `PlacementAccrualJob`：每小时刷新放置 `pendingToken`（无变动可跳过写入），并在 `GET/claim` 读写路径做惰性补算兜底。  
7. `PlacementClaimJob`：无自动发放；仅处理用户触发的手动领取请求（含幂等保护）。

## 13. API 方案（增量）

## 13.1 抽卡、券、放置与图鉴

- `POST /gacha/draw`（`paymentMethod: TOKEN|DRAW_TICKET|DRAW10_TICKET`）  
- `GET /gacha/tickets`  
- `POST /gacha/tickets/draw/use`  
- `POST /gacha/tickets/draw10/use`  
- `POST /gacha/tickets/affix-reforge/use`  

- `GET /gacha/placement`（槽位、当前累计、上限、预计每小时产出）  
- `POST /gacha/placement/slots/:slotIndex/set`（放入/替换库存实例）  
- `POST /gacha/placement/slots/:slotIndex/clear`  
- `POST /gacha/placement/claim`（手动领取）  
- `GET /gacha/album/pages`（页面级列表，每页面一个入口）  
- `GET /gacha/album/pages/:pageId/variants`（该页面下已拥有变体明细）

## 13.2 任务与成就

- `GET /gacha/missions`  
- `POST /gacha/missions/:missionKey/claim`  
- `POST /gacha/missions/claim-all`  
- `GET /gacha/achievements`  
- `POST /gacha/achievements/:achievementKey/claim`  
- `POST /gacha/achievements/claim-all`

## 13.3 市场（重写后）

- `GET /gacha/market/contracts`（含 `indexOpen/indexNow/indexClose?`）  
- `GET /gacha/market/ticks?category=&limit=`  
- `GET /gacha/market/opponents?category=&lockTier=`  
- `POST /gacha/market/positions/open`  
- `GET /gacha/market/positions`（OPEN/EXPIRED）  
- `GET /gacha/market/positions/history`（SETTLED/LIQUIDATED）  
- `GET /gacha/market/settlements`

返回字段约定：

1. 对外方向枚举统一 `LONG|SHORT`。  
2. 价格字段统一为指数点位：`entryIndex/currentIndex/settleIndex`。  
3. 不对普通用户返回概率价；高级面板可选附加 `score_t` 诊断字段。
4. `ticks` 返回必须含 `asOfTs/watermarkTs/voteCutoffDate/voteRuleVersion`；诊断字段可附加 `inflationAlpha/voteScale`。

## 13.4 幂等与重试（强制）

适用接口：所有会扣款、发奖、开仓、领取的 `POST` 接口（含 `draw`、`claim`、`claim-all`、`positions/open`、`placement/claim`）。

规则：

1. 客户端必须带 `X-Idempotency-Key`（1~64 字符）。  
2. 服务端以 `(userId, method, path, idemKey)` 去重，并校验 `requestHash`。  
3. 相同 key + 相同请求体：返回首次响应（`statusCode + responseJson`）。  
4. 相同 key + 不同请求体：返回 `409 { error: 'idempotency_key_conflict' }`。  
5. 幂等记录默认保留 24 小时，可异步清理，不影响在线链路。

## 14. 发布拆分（可直接排期）

### Phase 0（1 周）

- 单常驻池切换。  
- 抽卡即时返还下线。  
- 拆卡固定回收上线。  
- `paymentMethod` 落库。

### Phase 1（1~2 周）

- 实例库存（异画/词条）与 `GachaCardUnlock`。  
- 放置系统（5 槽、3000 上限、手动领取）与前端入口（卡池与记录之间或独立 Tab）。  
- 任务、里程碑、成就与券钱包。  
- `claim-all` 接口。

### Phase 2（2 周）

- `backend` 侧 `CategoryIndexTick` 产线。  
- `user-backend` 仓位引擎（过期/爆仓/结算）。  
- 新市场 API（open + positions + history）与 LONG/SHORT 前端。

### Phase 3（1~2 周）

- 对手盘展示与审计面板。  
- 费率与杠杆档位调优。  
- 经济监控与参数回调。

## 15. 监控与验收

## 15.1 Score 与价格源

1. 各品类近 13 周“周收盘高于周开盘”占比在 `[0.35, 0.65]`。  
2. `watermarkTs` 滞后 >4 小时告警（现网 sync 约 2 小时一轮）。  
3. 同一 `tick` 的 `indexMark` 以 backend 写入值为准，bff/frontend/user-backend 仅透传与消费。  
4. 抽样审计时允许“复算值 vs 存储值”存在微小浮点差；审计失败阈值按精度配置，而非强制 0 误差。
5. `voteCutoffDate` 必须满足 `voteCutoffDate <= date(asOfTs)-1`（UTC+8）；违反即审计失败。
6. `INFLATION_ALPHA` 必须落在 `[0,1]`，且写入指标快照以支持历史复算。  
7. `sentiment` 必须使用 Beta 平滑与 `SENTIMENT_K` 折扣，禁止直接用未平滑 `up/(up+down)` 入分。

## 15.2 价格更新时效

1. `tick` 生成延迟（`asOfTs -> createdAt`）`p95 <= 10 分钟`（小时 tick 口径）。  
2. `tick` 同步延迟（backend -> user-backend）`p95 <= 15 分钟`。  
3. 价格停滞告警：同一类目连续 `>=3` 小时无新 tick。  
4. 票据新鲜度延迟（`now - endOfDay(voteCutoffDate, UTC+8)`）`p95`，超过 48 小时告警。

## 15.3 风险行为

1. 爆仓率（分杠杆、分锁仓档）。  
2. 爆仓后次日留存。  
3. `OPEN->EXPIRED->SETTLED` 及时性与积压数。  
4. 大额仓位集中度（top1/top5 margin 占比）。

## 15.4 经济体感

1. 任务领取率（DAILY/WEEKLY）。  
2. 活跃用户日净变动（Token + 券折算）。  
3. 抽卡、市场开仓、结算回款路径转化。

## 15.5 市场净排放

定义：

```txt
marketInflow  = Σ(margin + openFee)
marketOutflow = Σ(payout)
marketFees    = Σ(openFee) + Σ(settleFee)
netEmission   = marketOutflow - Σ(margin)
netPnlSystem  = (Σ(margin) + Σ(openFee) + Σ(settleFee)) - Σ(payout)
```

判读：

- `netPnlSystem > 0`：系统净回收（偏收缩）。  
- `netPnlSystem < 0`：系统净投放（偏通胀）。  
- 监控要求：7 日 / 30 日滚动 `netPnlSystem` 必须持续可见，持续为负触发调参流程（优先杠杆与费率）。

## 16. P0 必改清单（上线门槛）

1. 价格真源必须是 `CategoryIndexTick.indexMark`，不得用用户交易结果反推价格。  
2. 市场必须移除 `spot buy/sell` 路径，仅保留锁仓开仓。  
3. 结算必须按涨跌幅权益公式，不得使用二元 `win=1/lose=0` 兑付。  
4. 爆仓必须在 tick 到来后即时执行，`equity<=0` 立即清零。  
5. 到期处理顺序必须固定为“先过期、再爆仓、后结算”。  
6. 结算价必须取 `IndexPriceAtOrBefore(expireAt)`，禁止回看未来 tick。  
7. 所有发放金额必须 `floor` 到整数 Token，禁止隐式四舍五入增发。  
8. `indexOpen` 来源必须可追溯（上一周 `indexClose` 或 `INDEX_BASE`）。  
9. `INDEX_K`、`SCORE_CLAMP`、公式实现必须在 backend 固化；其他端不得私自复算定价。  
10. 任务进度只统计抽卡与开仓消耗，平仓/结算回款不得冲减历史进度。  
11. 抽卡即时返还必须移除（未来 `tokensReward=0`）。  
12. 拆卡必须走固定稀有度回收表（词条加成为额外项）。  
13. 图鉴进度必须按 `ever unlocked`，且变体去重键为 `(pageId, artVariantId, affixFingerprint)`，不能按当前持有。  
14. `commentCount` 指标已从 v0.2.1 的价格链路移除，禁止以任意形式参与 score 与 index 定价。  
15. `mu/sigma/MA` 必须按 `category` 独立计算，禁止跨品类共用基线。  
16. `score_provisional(asOfTs)` 的生产公式必须按第 7.3 节固化，且可离线复算审计。  
17. tick 产线必须保证活性：按小时固定心跳 tick 与引擎 wall-clock 兜底至少满足其一（本版两者都要求）。  
18. 周切换不得跳价：`indexClose=IndexPriceAtOrBefore(nextWeekStart)`，`indexOpen(next)=indexClose(prev)`，`weeklyFinalize` 不得覆盖已发布价格。  
19. `votes/sentiment` 必须采用 T+1 结算口径：`asOfTs` 当日票不得进入当日 `score_provisional`。  
20. `CategoryIndexTick` 必须落库 `voteCutoffDate` 以支持“价格可审计复算”。  
21. 所有 daily/week/hour 聚合的类目归属必须按事件时刻 `<=τ` 的 `PageVersion` 标签快照计算，禁止 join 最新标签回刷历史。  
22. `isDeleted` 事件转换必须先在全历史上做 `LAG`，再按窗口过滤日期，禁止“窗口内首条记录默认前值为 false”。  
23. 第 7.4 节 forecast 序列不得写入 `CategoryIndexTick` 真价表，必须与交易真价序列分离。  
24. 离线回放中 `votes/sentiment` 的 WTD 必须执行周内 `shift(1)`（周一强制 0），确保与 T+1 日结口径一致。  
25. `sentiment` 必须用 Beta 平滑（`SENTIMENT_ALPHA/BETA`）+ 小样本折扣（`SENTIMENT_K`），禁止直接裸用赞踩比。  
26. `INFLATION_ALPHA` 必须配置化且限定 `[0,1]`；仅用于 Step B 去量纲，不得引入价格外生漂移。  
27. `netContent` 与 `delRate` 必须同时入分：前者表达发展/萎缩，后者表达治理压力。  
28. vote 异常处理必须可审计：保留 `raw/cap/adj/scale/rz_local` 与命中规则版本，允许离线复算；`tick/hourly` 必须携带 `voteRuleVersion`。  
29. `pageCountStart/pageCountEnd` 口径必须写死；`delRate` 分母统一使用 `pageCountStart`（live）。  
30. category 归属必须按 `<=t_eff` 标签快照，禁止未来标签回刷历史。  
31. `votesTotal` 必须做小样本折扣（`VOTE_K` 或等价连续折扣），避免 GOI/WANDERERS 噪声主导。  
32. 所有组件 `z_*` 入分前必须执行 `Z_CLAMP` 截断，避免单点事件把总分打满 `SCORE_CLAMP`。  
33. 所有同阶段环比必须使用 `t_eff_*` 对齐的 `prev-window`（`*_wtd_prev`），禁止直接用 `t-7d`。  
34. 生产 score 入分默认使用 sanitized 的 `votesUp/votesDown/votesTotal/approval/sentiment`（`*_adj`）；`*_raw` 仅审计。  
35. `z_*` 必须实现冷启动保护：同 `(category, offset)` 历史样本不足 `MIN_Z_HISTORY` 时强制置 0。  
36. 补量周/日回摊仅允许在 `VOTE_BACKFILL_MODE=bootstrap` 的历史回填阶段执行；增量读新数据时必须关闭。  
37. 补量周/日回摊必须保留审计轨迹（周级 `backfill_week/...`、日级 `backfill_day/.../gap_fill_amount`），支持离线复算。  
38. 生产/回放默认窗口固定为 `CALC_START_DATE=2023-01-01`、`WARMUP_START_DATE=2022-10-01`；若 warmup 不足 `MIN_WARMUP_DAYS` 必须自动后移正式起算日。  
39. 周 K 线输出必须从 `CALC_START_DATE` 之后第一个完整周（周一）开始，禁止将 warmup 周写入正式输出文件。  
40. `score_provisional` 必须执行 drift neutralization（`score_ref + DRIFT_BETA_*`），禁止直接用未中和 `score_signal_raw` 入价。  
41. 小时 forecast 必须满足锚定等式：`h=24` 时等于当日收盘、周末最后小时等于周收盘；一致性校验 `max_abs_diff` 必须接近 0（数值误差量级）。  
42. 每日/每周任务周期边界必须统一按 `UTC+8` 计算，禁止使用宿主机本地时区。  
43. 所有扣款/发奖/开仓/领取类 `POST` 接口必须支持 `X-Idempotency-Key` 幂等去重。  
44. v0.2 切换前必须执行一次 gacha 用户态数据清理（仅 gacha 域表），旧库存与旧 Token 不做迁移兼容。  

## 17. 审查补充数据（含 2022 vote 异常去影响试算）

## 17.1 数据快照（2026-02-08，`scpper-cn@localhost:5434`）

补充目的：给审查者一组“可复算、可落库”的数据证据，用于确认 v0.2.1 的 score 与风控边界。  

页面规模（当前版本口径）：

| category | `page_count_live` | `page_count_all` |
|---|---:|---:|
| OVERALL | 33,093 | 43,605 |
| TRANSLATION | 20,946 | 23,615 |
| SCP | 4,485 | 5,656 |
| TALE | 4,088 | 4,916 |
| GOI | 480 | 523 |
| WANDERERS | 1,330 | 1,743 |

补充说明（样本稀疏性，2019-01 至今周级）：

| category | 周样本数 | `votesTotal_w` p50 | `votesTotal_w` p90 | `<100` 票周占比 |
|---|---:|---:|---:|---:|
| OVERALL | 370 | 2,226.0 | 4,333.0 | 1.35% |
| TRANSLATION | 370 | 424.0 | 871.8 | 1.35% |
| SCP | 370 | 732.5 | 1,567.6 | 1.35% |
| TALE | 370 | 540.0 | 1,142.6 | 1.35% |
| GOI | 370 | 59.0 | 149.5 | 78.65% |
| WANDERERS | 366 | 96.0 | 286.0 | 50.82% |

结论：`GOI/WANDERERS` 的票据小样本显著，`SENTIMENT_K` 折扣不是可选项，而是必要项。

## 17.2 2022 年中 vote 异常识别（局部鲁棒）

识别口径（按全站日总票 `OVERALL`）：

```txt
lv_d      = ln(1 + votes_d)
med_d     = median(lv) over [d-30d, d+30d], excluding d
mad_d     = median(|lv-med_d|) over [d-30d, d+30d], excluding d
rz_local  = 0.6745 * (lv_d - med_d) / mad_d

cap_d     = exp(med_d + (4/0.6745) * mad_d) - 1
```

命中规则（本次试算）：仅在 `2022-04-01 ~ 2022-07-31` 且 `rz_local >= 4` 时进行截断。  

识别结果：

| day | votes_raw | cap_votes | votes_adj | scale | `rz_local` |
|---|---:|---:|---:|---:|---:|
| 2022-05-15 | 10,459 | 2,384 | 2,384 | 0.2279 | 7.14 |
| 2022-05-17 | 3,068 | 2,197 | 2,197 | 0.7161 | 4.73 |
| 2022-05-18 | 2,196 | 1,873 | 1,873 | 0.8529 | 4.38 |
| 2022-05-25 | 16,497 | 1,616 | 1,616 | 0.0980 | 9.83 |

## 17.3 初步模型（去影响但不破坏结构）

日级修正：

```txt
scale_d      = votes_adj_overall_d / votes_raw_overall_d
votesUp_adj  = votesUp_raw  * scale_d
votesDown_adj= votesDown_raw* scale_d
votesTotal_adj = votesUp_adj + votesDown_adj
```

性质：

1. 同日各品类按同一 `scale_d` 缩放，保留相对结构。  
2. 同日 `approval` 水平基本保持（仅受平滑先验影响）。  
3. 只改异常窗口，不误伤其余年份波动。  

建议落库（审计必需）：

- `CategoryVoteDailySanitized(day, rawVotes, capVotes, adjVotes, scale, rzLocal, ruleVersion, isAnomaly, createdAt)`  
- `CategoryMarketHourlyMetric` 持久化 `voteRawPart/voteAdjPart`（或等价字段）  
- `CategoryIndexTick` 保留 `voteCutoffDate/voteRuleVersion/voteScale`

## 17.4 试算结果（raw vs adjusted）

年度影响（2017+，仅启用 2022 年中窗口规则）：

| year | capped_days | raw_sum | adj_sum | reduced_pct |
|---|---:|---:|---:|---:|
| 2021 | 0 | 130,070 | 130,070 | 0.00% |
| 2022 | 4 | 167,306 | 143,157 | 14.43% |
| 2023 | 0 | 97,007 | 97,007 | 0.00% |
| 2024 | 0 | 127,143 | 127,143 | 0.00% |

2022 月度影响（只列有变化月份）：

| month | raw_sum | adj_sum | reduced_pct |
|---|---:|---:|---:|
| 2022-05 | 41,787 | 17,638 | 57.79% |

周级示例（异常最明显区间）：

| week_start | category | votes_raw_w | votes_adj_w | reduced_pct |
|---|---|---:|---:|---:|
| 2022-05-09 | OVERALL | 13,295 | 5,202 | 60.00% |
| 2022-05-09 | TRANSLATION | 7,563 | 2,220 | 70.00% |
| 2022-05-23 | OVERALL | 17,936 | 3,057 | 82.00% |
| 2022-05-23 | SCP | 5,080 | 800 | 84.00% |
| 2022-05-23 | TRANSLATION | 3,678 | 672 | 81.00% |

波动性试算（2021-2023，按第 7 章结构中的 vote/sentiment 相关项）：

| category | `p95(|Δln(1+votes_w)|)` raw | adjusted | `p95(|Δvote_component|)` raw | adjusted |
|---|---:|---:|---:|---:|
| OVERALL | 1.0620 | 0.9058 | 0.6098 | 0.5308 |
| TRANSLATION | 1.5430 | 0.9673 | 1.0721 | 0.9972 |
| TALE | 1.0707 | 0.9220 | 0.8269 | 0.7524 |
| SCP | 0.9997 | 0.9997 | 0.8553 | 0.8544 |
| GOI | 1.5882 | 1.5467 | 0.7344 | 0.7349 |
| WANDERERS | 3.2189 | 3.2189 | 0.9745 | 0.8876 |

结论：2022 年中异常修正可显著压制 `OVERALL/TRANSLATION` 的异常尖峰，并改善 vote 组件稳定性；对小样本类目（GOI/WANDERERS）影响有限，符合“保守修正”预期。

## 17.5 审查建议（直接用于评审清单）

1. 先冻结 `ruleVersion=v1`（窗口+阈值+cap 公式），上线后每季度复核一次。  
2. 将第 17.2 识别结果做成可查询 API（至少内部）以支撑争议排查。  
3. 在回放脚本中同时输出 `raw/adj` 两套指数，评审时并排查看收益曲线差异。  
4. 若后续确认 2024 某些尖峰也属脏数据，再扩展窗口；未确认前不跨年启用自动修正。

## 17.6 补量周回摊（仅历史回填阶段）

目标：针对“上一周票据几乎为 0、下一周集中补量”的场景，避免 `d_votes` 在单周被放大成跳点。

识别口径（按 category 周级 `votesTotal_adj_w`）：

```txt
isBackfillWeek(w) if all true:
  BACKFILL_REDIS_START <= w <= BACKFILL_REDIS_END
  votes_w(w-1) <= BACKFILL_PREV_ZERO_MAX
  nonzero_count(votes_w over last BACKFILL_HISTORY_WEEKS before w) >= BACKFILL_MIN_NONZERO_HISTORY
  votes_w(w) >= max(BACKFILL_SPIKE_ABS_MIN, BACKFILL_SPIKE_FACTOR * median_nonzero_history)
  votes_w(w+1) > BACKFILL_PREV_ZERO_MAX
```

处理规则：

```txt
baseline_w = min(votes_w, median_nonzero_history)
excess_w   = votes_w - baseline_w

for all previous weeks j < w:
  votes_w(j) += excess_w / count(previous_weeks)

votes_w(w) = baseline_w
```

方向票拆分：

- 回摊与削减都按该补量周 `up/down` 比例执行，保持 `approval/sentiment` 口径一致。

执行边界（必须写死）：

1. 仅 `VOTE_BACKFILL_MODE=bootstrap` 时启用。  
2. 增量阶段（读新数据）必须 `VOTE_BACKFILL_MODE=off`，不再做回摊。  
3. 回摊日志必须落地（建议 `vote_backfill_redistribution.csv` / 对应数据库审计表），字段至少包含：`category/backfill_week/original_votes_week/baseline_votes_week/redistributed_votes`。

## 17.7 补量日回摊（仅历史回填阶段）

目标：针对“连续多日近零 + 某日恢复并集中补量”的场景，避免周内 `score` 先极端下探再剧烈反弹。

识别口径（按 category 日级）：

```txt
isBackfillDay(d, metric) if all true:
  BACKFILL_REDIS_START <= d <= BACKFILL_REDIS_END
  hist_nonzero_count(last DAILY_BACKFILL_HISTORY_DAYS) >= DAILY_BACKFILL_MIN_NONZERO_HISTORY
  prev_day <= max(BACKFILL_PREV_ZERO_MAX, hist_median * DAILY_BACKFILL_PREV_RATIO_MAX)
  gap_len(prev consecutive <= prev_limit) >= DAILY_BACKFILL_MIN_GAP_DAYS
  value_d >= max(abs_min_metric, hist_median * factor_metric)
  value_(d+1) > prev_limit
```

处理规则（`rev_raw`、`votes_total_adj_raw`）：

```txt
baseline_d = min(value_d, max(hist_median, prev_limit))
excess_d   = value_d - baseline_d

// 先补 gap：把 d 之前连续低值日优先回填到 prev_limit
gap_fill = min(excess_d, total_gap_deficit_to_prev_limit)
apply gap_fill to gap days
excess_d -= gap_fill

// 剩余再平摊到全部历史日（j < d）
for all previous days j < d:
  value_j += excess_d / count(previous_days)

value_d = baseline_d
```

方向票拆分：

- `votes_total_adj_raw` 的回摊与削减按当日 `up/down` 比例执行，保证 `approval/sentiment` 口径连续。

执行边界（必须写死）：

1. 仅 `VOTE_BACKFILL_MODE=bootstrap` 时启用。  
2. 增量阶段（读新数据）必须 `VOTE_BACKFILL_MODE=off`，不再做回摊。  
3. 日级回摊日志必须落地（建议 `daily_backfill_redistribution.csv`），字段至少包含：`category/metric/backfill_day/original_value/baseline_value/redistributed_value/gap_days_count/gap_fill_amount`。
