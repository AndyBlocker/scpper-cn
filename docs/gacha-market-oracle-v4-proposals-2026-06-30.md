# Gacha「股市」Oracle 指数 v4 综合推荐方案

> 日期：2026-06-30　|　目标：在保留「跨周连续 / 可回填 / 确定性可复现 / 向后兼容」四项硬约束下，重设计每小时 tick 的品类指数，使其 (1) 多日方向由品类真实基本面驱动、(2) 大幅去规律化、(3) 更有惊喜与事件戏剧性。
>
> 输入：4 个 v4 设计方案（A 基本面强化派 / B 随机过程注入派 / C 事件驱动派 / D 最小手术派）+ 3 个评审 lens（基本面深度 / 减规律趣味 / 工程约束安全）的打分与嫁接建议。
>
> 源码基准：`backend/src/jobs/CategoryIndexTickJob.ts`（1191 行，已逐行核对，下文行号以现版本为准）。

---

## 0. 结论速览（TL;DR）

**推荐 v4 = A 的「基本面拥有方向」骨架 + B 的「OU 均值回复随机引擎」+ D 的「逐项灰度治理」外壳 +（P1/P2 可选）C 的「具名事件层」。**

打分矩阵（5 分制）：

| 方案 | Lens1 基本面深度 | Lens2 减规律趣味 | Lens3 工程安全 | 合计 |
|------|:---:|:---:|:---:|:---:|
| A 基本面强化派 | **5** | 4 | 3 | 12 |
| B 随机过程注入派 | 4 | **5** | 4 | **13** |
| C 事件驱动派 | **5** | 4 | 3 | 12 |
| D 最小手术派 | 3 | 3 | **5** | 11 |

**为什么不是简单取合计最高的 B 作骨架**：用户已明确把「价格反映基本面 / 多日方向」列为第一优先级（即 Lens1）。A 与 C 在该轴并列最高（5），且评审三个 lens **一致点名**要把 A 的「公允值 OU 锚」嫁接到所有方案——它是四案中唯一让「锚点也服务基本面」的设计，从根上解决「锚与基本面对赌、对冲掉玩家 edge」。因此方向层的骨架取 A；而 B 的 OU 随机层是三 lens 一致认可的「噪声引擎底座」（方差有界、零均值，结构上杜绝随机层累出假趋势淹没基本面），作为波动层底座并入。A 与 B 的核心其实互补而非竞争：A 负责「方向归还基本面」，B 负责「纹理/惊喜但不偷方向」，C 负责「可讲述的事件 edge」，D 负责「可灰度可回滚的工程治理」。

**一句话**：方向用 A，波动用 B，治理用 D，事件用 C（可选、分期）。

---

## 1. 综合逻辑：四案共识 + 各自最佳点子

评审给出的嫁接建议高度收敛，下列为「无论最终骨架是谁都应纳入」的共识件：

1. **drift 季节/趋势分解（四案共识，低风险）**：`scoreRef = median(本 offset) − median(跨 offset 池化)`，只减「周内季节形状」，**保留品类自身水平/趋势（trendLevel）**；并大幅下调 β。这是病灶③的根治、也是把「多日方向」还给基本面的根本动作。务必保持 `INFLATION_ALPHA=1.0` 以免历史样本需换算（详见 §6 取舍 1）。
2. **A 的公允值 OU 锚（keystone graft）**：锚的目标从固定 `ln(100/open)` 改为 `F = ln(INDEX_BASE) + γ·trendLevel`，锚从「与基本面对赌」变为「轻轻把价格拉向基本面应在的位置」。B/C/D 都残留拉向 100，统一替换为拉向 F。
3. **B 的 OU 均值回复随机层作噪声底座**：长期望 0、方差有界（静态 std ~3.5%），既加惊喜纹理又结构性防止假趋势。A/C/D 的 GARCH/AR(1) 并入其中。
4. **B 的 PRNG 决定论硬化**：`hash32 + Irwin-Hall`（纯整数+加法），规避 Box-Muller（log/cos）的跨平台 ULP 漂移，保证 168 步递归路径逐位可复现可对账（D 的 Box-Muller 应改采此法）。
5. **B 的 early-week blend 修周一空窗**：用上周收盘 raw 做 3 天 ramp-in，零新查询、确定可复现（A 把病灶④推迟到二期是失分项，应在 P0 补上）。
6. **C 的具名 7 类事件层 + `event_impulse` 列 + carry 复利 + 去趋势基线**：是「盯站即 edge」「每次跳价能讲新闻」的最佳载体（Lens1 策略深度上限最高）。但带 schema 迁移与查询成本，降级为可选分期（详见 §5、§6）。
7. **A 的 6~12h 衰减核**：事件/尖峰展开成数小时「行情」而非单 tick 针，避免单根离群 tick 触发杠杆批量误清算（诊断已有物证）。凡含跳跃者必带。
8. **C 的午夜批量回填伪 surge 守卫**：实测午夜多页同净值=数据伪迹兼刷量面，任何吃事件/尖峰/microShock 的项都必须守卫，否则制造新规律性 + 误清算。
9. **D 的逐项布尔开关 + weekStartMs 作 seed 输入**：灰度对比与即时回滚的工程治理；weekStartMs 比派生 weekIndex 少一类边界算术 bug。
10. **seed 私有盐（Lens2 红线）**：`seed = hash(salt, category, week/offset)`，salt 为部署期固定、不入库、不外泄。否则玩家逆向公式即可外推整周路径，goal2「不可外推」全盘崩。

---

## 2. 推荐的 v4 完整公式（逐项）

记号：`o = offsetBucket ∈ [0,167]`（周一 00:00 = 0，周日 23:00 = 167）；`weekStartMs` = 本周一 00:00 毫秒；`L = ln(indexOpen)`；所有伪随机量 `U(·)/N(·) = mulberry32/Irwin-Hall(seed)`，`seed = hash32(ORACLE_SEED_SALT, category, weekStartMs[, o])`。

### 2.1 基本面层（方向归还基本面）

**(a) drift 季节/趋势分解（替换 L450-471 的 scoreRef 计算）**

```
levelRef    = median(∪ 该品类所有 offset 桶的 raw 历史)        ← 品类当前基本面水平，保留不减
seasonalRef = median(本 offset 桶 raw 历史) − levelRef           ← 纯周内重复形态
scoreCorrected = clamp(rawEff − β_seas·seasonalRef − β_level·levelRef, ±SCORE_CLAMP)
  β_seas:  OVERALL 0.9 / 其它 0.8        （只去季节）
  β_level: 0.05（≈0，几乎不动品类水平/趋势）
存列 scoreRef = β_seas·seasonalRef + β_level·levelRef   （可审计：实际扣减总量）
```

样本不足回退：本 offset 桶 < `DRIFT_MIN_HISTORY_WEEKS` 时 `seasonalRef=0`；池化 < `DRIFT_FALLBACK_MIN_SAMPLES` 时 `levelRef=0`（退化回近 v3，渐进生效）。

> 原理：旧 `scoreRef=median(本offset raw)` 同时含「周内季节性」和「品类持续水平/趋势」，`−β·scoreRef` 把后者一起滤掉 → 方向 SNR<1。拆分后只减季节、几乎不动水平，品类持续景气直通 carry，TALE 那种「真有趋势就跌到 64」从特例变常态；并杀掉 acf168 周锯齿。

**(b) early-week blend（修病灶④周一空窗，新增于 raw 计算后）**

```
prevCloseRaw = (categoryHistory[167]).last ?? 0     ← 上周收盘 raw（取自内存历史，零新查询）
weekProgress = clamp(o / 72, 0, 1)                  ← 周一 00:00→周四 ramp-in
rawEff = weekProgress·scoreSignalRaw + (1−weekProgress)·prevCloseRaw
（存入历史的仍是 genuine scoreSignalRaw；rawEff 仅本 tick 用于 drift+价格）
```

**(c) INFLATION_ALPHA（决策）**：P0 保持 `1.0`（drift 历史零换算）；P1 再降到 `0.6`（让品类绝对景气也驱动指数，增加方向与惊喜），但**必须**在 `loadScoreHistoryByOffset` 同步补换算 `raw_v3 = raw_v2 + (1.0−0.6)·overall_raw(同时刻)`（类比现有 L736 的 v1→v2 换算），否则 26 周 drift 中位混入两种 α 口径 = 静默单位错配。详见 §6。

### 2.2 趋势/锚点层（公允值 OU 锚 + seed 随机相位）

**跨周递推（把固定 100 锚换成基本面公允值 OU 锚 + 随机周冲击）**

```
F_n        = ln(INDEX_BASE) + γ·trendLevel_c        γ = 0.18   ← 公允值随基本面浮动
J_n        = SHOCK_SIGMA · Ψ(seed(c,n))             SHOCK_SIGMA = 0.02，Ψ 零均值（可肥尾）
anchorFull = λ·(F_n − L) + J_n                      λ = 0.025（半衰期≈27 周，弱到压不过 carry）
```

**周内逐时锚（seed 随机相位 + 随机强度，端点固定保连续）**

```
sched_n(o) = (o / 167)^{p_n}        p_n ∈ [0.6, 1.8] = seed(c,n,'phase')
anchorTerm = sched_n(o) · anchorFull
  端点恒等：sched(0)=0, sched(1)=1（对任意 p_n>0 成立）→ 周一 anchorTerm=0、收盘满额
```

> 原理：固定线性锚 = 确定可外推的 +2.9~4%/周斜坡（病灶②，且霸占方向）。改为：① 目标随基本面浮动（不再与景气对赌）；② λ 砍到 0.025（仅在价格远离公允值时温和回拉）；③ 每周 seed 随机相位 p_n 让周内形态周周不同、跨周不可外推；④ 随机周冲击 J_n。注意——真「相位平移」会破坏 offset0=0 连续性，故用 `(o/167)^{p_n}` 的**随机曲率**作连续安全的等价替身（D 的清醒细节）。

### 2.3 随机/波动层（OU+GARCH+Poisson 真波动过程）

**替换 L533-536 的弱 `deterministicNoise`（±0.3% iid hash）为 seed 驱动、周内连续、均值回复的随机过程，作为价格 exp 项内的 `stochTerm`：**

```
weekSeed = hash32(ORACLE_SEED_SALT, category, weekStartMs)
volWeek  = 1 + 0.6·(U(weekSeed,0,'vol')−0.5)·2         ← 周级波动 regime（平静/风暴）
activityDev = |microScore| / 0.15                       ← 真实日内活动耦合（B 的二级 edge）
σ_base   = 0.011 · volWeek · (1 + 0.5·tanh(activityDev))

S_0 = 0
for t = 1..o:
  σ²_t   = (σ_base)²·GARCH_OMEGA(0.4) + GARCH_ALPHA(0.18)·incr²_{t−1} + GARCH_BETA(0.78)·σ²_{t−1}  ← 波动聚集
  incr_t = σ_t · N(weekSeed,t,'ou')
  if U(weekSeed,t,'jump') < JUMP_LAMBDA(0.012):          ← 低频泊松跳跃 ~2/周
     incr_t += sign · (0.03 + 0.09·U(weekSeed,t,'mag'))   ← ±3%~12% 对数脉冲
  S_t = (1 − OU_KAPPA(0.06))·S_{t−1} + incr_t             ← OU 均值回复到 0 位移
  S_t = clamp(S_t, ±0.35)
stochTerm = (o==0 ? 0 : S_o)                              ← 周一 00:00 强制 0
```

> 原理：① 注入以 i.i.d. 创新为主的小时增量（σ≈1.1% ≫ 旧斜坡 0.04%/h）→ acf1≈0.97 砸向 ~0（病灶①⑤）；② **关键安全件**：用 OU 均值回复而非随机游走 → 长期望 0、静态方差有上界（~3.5%），随机层绝不累积假趋势淹没基本面，多日 SNR>1 仍由基本面拥有方向；③ GARCH 给「冷热周」、Poisson 给「±5~15% 偶发脉冲」；④ 波动幅度本身由真实日内活动调制 → 「有多湍流」也携带景气信息。整周路径由 weekSeed 整周确定性重放，O(≤168) 纯算术，绝不依赖 DB 中上一 tick 的 noise。

### 2.4 事件层（P1 lite + P2 full，均带衰减核 + 守卫）

**P1-lite（无 schema，复用已算 z，零新查询）—— A 的 eventJump：**

```
z_event   = 取 zDelRate / zRev / microScore 的真实尖峰
eventJump = Σ sign · EVENT_JUMP_K · softplus(|z_event| − 2.5) · decay(o − o*)
  decay：6~12h 指数衰减核（非单 tick 尖峰）
进 score（周内）：score += eventJump；收盘剔除或按 retain 留存
```

**P2-full（可选，需 user 拍板）—— C 的具名 7 类事件层：**

- 7 类真实内容事件：破评分里程碑 / 单页爆火 / 热门新页 / 批量删 / 批量改 tag / 论坛热帖 / 作者高产；各有 `τ_type / w_type / 阈值`。
- `S_c(t) = Σ 本周事件 a_e·exp(−(t−t_e)/τ)`；`Ev = clamp(EVENT_GAIN·(S_c − λ·B_c(o)), ±EVENT_CLAMP)`。
- 去趋势基线 `B_c(o)`（近 12 周周内衰减和的 offset 中位）保证稳态 `Ev→0`、无系统漂移。
- **收盘 carry**：`EVENT_CARRY_RETAIN = 0.4`（**不是 C 原议的 0.6**）+ 对负向事件加权，修正「正向事件远多于负向 → 指数系统性上行、做空恒亏」这一新规律（Lens1+Lens2 红旗）。
- 新增可空列 `event_impulse Decimal? @default(0)`，喂前端「新闻化」展示。

**两版共有的强制守卫（C 的洞察，全员适用）**：
- 午夜批量回填伪 surge：同一小时 ≥K 个页面近乎相同净值 → 合并降权；VIRAL 要求去重 userId ≥ 10；单页单类型冷却 48h。
- 衰减核而非单 tick 尖峰：避免单根离群 tick 落地即回撤、在杠杆下批量打穿止损触发清算级联。

### 2.5 价格组装与连续性单点不变量

```
scoreProvisional =
   (o==0)        ? 0
 : isWeekClose   ? clamp(scoreCorrected_close [+ retain·Ev_close], ±CARRY_CLAMP=2.5)   ← 剔 micro/drag
 :                 clamp(scoreCorrected + microScore − crowdDrag* + eventJump, ±SCORE_CLAMP=3.6)

indexMark = indexOpen · exp(INDEX_K·scoreProvisional + anchorTerm + stochTerm)
  INDEX_K = 0.13~0.15（增强基本面传导）
  * crowdDrag 是否进价格见 §6 取舍 3（推荐移出，仅记录）
```

**连续性单点不变量（与波动幅度完全解耦）**：`o==0`（周一 00:00）时 `scoreProvisional=0 ∧ anchorTerm=0 ∧ stochTerm=0 ∧ noise=0` ⇒ `indexMark = indexOpen = 上周收盘 indexMark`（DB 读取）。价格是「水平式」`indexOpen·exp(...)·(1+noise)` 而非链式，故 open 取自 DB、与本周波动无关，**无论加多大波动都「下周开盘=本周收盘」，无周一跳价**。所有 seed 随机项端点恒为 0，不破坏此恒等式。

### 2.6 完整逐时算法（伪码总览）

```
for each hour asOfTs, for each category c:
  o = weeklyOffsetBucket(asOfTs)
  # 1. 基本面
  scoreSignalRaw = WEIGHT_REV·zRev + WEIGHT_VOTES·zVotesEff + WEIGHT_NET·zNet
                 + SENTIMENT_WEIGHT·zSentEff − DEL_RATE_PENALTY·zDelRate   （权重不变）
  rawEff = blend(scoreSignalRaw, prevCloseRaw, weekProgress)               # early-week
  levelRef, seasonalRef = decompose(categoryHistory)                       # 季节/趋势
  scoreCorrected = clamp(rawEff − β_seas·seasonalRef − β_level·levelRef, ±3.6)
  # 2. 锚（公允值 OU + seed 随机相位）
  trendLevel = levelRef;  F = ln(100) + 0.18·trendLevel
  anchorFull = 0.025·(F − ln(indexOpen)) + SHOCK_SIGMA·Ψ(seed(c,week))
  anchorTerm = (o/167)^{p_n} · anchorFull
  # 3. 事件（lite/full，带衰减核+守卫）
  eventJump = ΣeventPulses(c, asOfTs)
  # 4. 价格层 score
  scoreProvisional = (o==0?0 : isClose? clamp(carry,±2.5) : clamp(scoreCorrected+micro−drag*+eventJump,±3.6))
  # 5. 随机波动层（OU+GARCH+Poisson, Irwin-Hall, seed salt）
  stochTerm = stochasticDisplacement(c, weekStartMs, o, volWeek, activityDev)
  # 6. 组装
  indexMark = indexOpen · exp(INDEX_K·scoreProvisional + anchorTerm + stochTerm)
  写 CategoryIndexTick(voteRuleVersion='utc8-t+1-v3', scoreSignalRaw, scoreRef=扣减量,
                       scoreProvisional, indexMark, crowdDrag, noise=stochTerm/瞬态, [event_impulse])
```

---

## 3. 落地清单（对 `CategoryIndexTickJob.ts` 的具体改动）

标注：**P0** = 立即可做、低风险、零迁移；**P1** = 中等、需观察窗口；**P2** = 大改/需迁移/需拍板。每项尽量带独立布尔开关。

### P0（核心方向 + 波动底座 + 治理；零 schema 迁移，保持 INFLATION_ALPHA=1.0）

| # | 改动点（行号） | 从 → 到 | effort | 灰度开关 |
|---|---|---|---|---|
| P0-1 | `TICK_RULE_VERSION` (L85) | `'utc8-t+1-v2'` → `'utc8-t+1-v3'` | XS | — |
| P0-2 | PRNG 工具新增（helper 区） | 无 → `hash32 / mulberry32 / seededUniform / seededNormal(Irwin-Hall) / weekStartMsOf`，混入 `ORACLE_SEED_SALT`（env，不入库） | S | — |
| P0-3 | drift 季节残差化 (L450-471) | `scoreRef=median(offsetHistory)` → `seasonalRef=median(本offset)−levelRef`，`scoreCorrected=clamp(rawEff−β_seas·seasonalRef−β_level·levelRef,±3.6)`；复用现成 pooled 数组 | M | `V4_DRIFT_SEASONAL` |
| P0-4 | β 常量 (L89-91) + 新增 `BETA_SEASONAL/BETA_LEVEL` | `0.95/0.70/0.65` 弃用；新增 `β_seas`=0.9(OVERALL)/0.8(其它)、`β_level`=0.05 | XS | 同上 |
| P0-5 | early-week blend（L443 后新增） | 无 → `rawEff=blend(raw,prevCloseRaw,clamp(o/72,0,1))`；存历史仍用 genuine raw | S | `V4_EARLY_WEEK_BLEND` |
| P0-6 | 公允值 OU 锚 (L101,526-528) | `anchorTerm=(o/167)·0.06·ln(100/open)` → `F=ln(100)+0.18·trendLevel; anchorFull=0.025·(F−L)+J; anchorTerm=(o/167)^{p_n}·anchorFull`；新增 `ANCHOR_LAMBDA/FAIR_VALUE_GAMMA/SHOCK_SIGMA` | M | `V4_ANCHOR_FAIRVALUE` |
| P0-7 | 随机波动层 (L133,533-536,649-657) | `deterministicNoise ±0.003` → `stochasticDisplacement()`：OU+GARCH(1,1)+Poisson，seed 派生、周一重置、整周确定性重放、`|S|≤0.35`，活动耦合 vol；进 exp 作 `stochTerm` | L | `V4_STOCH_LAYER` |
| P0-8 | 传导/clamp 常量 (L75,76,104) | `INDEX_K 0.1→0.13`、`SCORE_CLAMP 3.2→3.6`、`CARRY_CLAMP 2.0→2.5` | XS | 裸常量 |
| P0-9 | `scoreRef` 列语义（写入 L548） | 记 `median(offset)` → 记实际扣减量 `β_seas·seasonalRef+β_level·levelRef`（审计可追溯；已核 ForecastJob/internal.ts 不依赖其语义，需通知监控） | XS | — |
| P0-10 | `loadScoreHistoryByOffset` (L687-744) | 仅改 `TICK_RULE_VERSION` 比对；**保持 raw 定义不变（α=1.0）→ v2 行零换算**；新增按品类池化 levelRef 所需的全桶聚合 | S | — |

> P0 落地后即可验证三目标的主干（方向归还基本面 + acf1/acf168 下降 + 周一不再死平），且全部可逐项灰度回滚。

### P1（事件 lite + 经济/活动微调；仍零迁移）

| # | 改动点 | 内容 | effort | 开关 |
|---|---|---|---|---|
| P1-1 | eventJump-lite（L478-486 后） | 由 `zDelRate/zRev/micro` 真实尖峰触发 `sign·EVENT_JUMP_K·softplus(|z|−2.5)`，经 6~12h 衰减核；**带午夜批量回填守卫**；周内进 score、收盘按 retain | M | `V4_EVENT_LITE` |
| P1-2 | crowd_drag 移出价格（L474-475,486） | 仍记录 `crowd_drag` 列（审计），但不进 score/价格（fun>house edge；详见 §6 取舍 3） | XS | `V4_DROP_CROWD_DRAG` |
| P1-3 | `INFLATION_ALPHA` (L79) | `1.0→0.6` + 在 `loadScoreHistoryByOffset` 补换算 `raw_v3=raw_v2+0.4·overall_raw`（类比 L736）| S | `V4_INFLATION_ALPHA` |
| P1-4 | micro 增益（L142-144） | `REV/FORUM_MICRO_WEIGHT 0.10/0.05→0.16/0.09`、`VOTE_AMP_K 0.4→0.6`（周一由真实时活动驱动，强化日内 edge） | XS | 裸常量 |

### P2（事件 full + 滚动窗；需迁移/压测/拍板）

| # | 改动点 | 内容 | effort | 开关 |
|---|---|---|---|---|
| P2-1 | C 具名 7 类事件层 | 新增 `loadEventImpulses()`（一次性近 12 周 7 类聚合）+ `computeEventImpulse()`；`EVENT_CARRY_RETAIN=0.4`+负向加权；去趋势基线 `B_c(o)`；前端新闻化 | XL | `V4_EVENT_FULL` |
| P2-2 | `prisma schema` + create (L540-554) | 新增可空 `event_impulse Decimal? @default(0)`（+ 可选事件日志表）；热表迁移需压测、Prisma client 重生成 | M | 同上 |
| P2-3 | 滚动 7 日 stats 窗（L746-799,343-406） | 周内累计窗 → 滚动 7 日窗（消周一薄数据 floor、弱化信号周锯齿）；**与公式改动拆分发布**，独立验证 T+1 截止与同 offset baseline 口径 | XL | `V4_ROLLING_WINDOW` |

---

## 4. 验证方案（上线后用哪些指标确认三目标）

回测窗：复用诊断口径，post-v3 06-11~06-30 真实数据先离线回测，再灰度。所有指标对 v3 baseline 做前后对比。

### 目标 1：价格反映基本面（多日方向）

| 指标 | v3 现状 | v4 目标阈值 |
|---|---|---|
| corr(滚动 7 日价格收益, 滚动品类基本面净信号) | 常被锚反号对冲（≈0 或负） | **> +0.5**（方向同号、基本面主导） |
| 多日方向信噪比 = \|基本面驱动位移\| / std(同窗噪声) | <1（仅 TALE −1.58 例外） | **> 1.0**（理想 >1.5） |
| anchor 对每周漂移的贡献 ~ 周序号回归斜率 | +2.9~4%/周确定斜坡，可外推 | **斜率≈0、R²<0.1**（无固定周斜坡） |
| 强趋势品类单边可达性（TALE 式 90→64） | 仅极端 SNR 可挣脱 | SNR≈0.5 的品类也能走出多周趋势 |

### 目标 2：减规律性 / 不可外推

| 指标 | v3 现状 | v4 目标阈值 |
|---|---|---|
| acf1（小时收益自相关） | 0.95~0.98（过度平滑） | **< 0.6**（理想 0.2~0.5） |
| acf168（周周期） | OVERALL 0.48 / TALE 0.69 | **< 0.2** |
| 次周形态可外推性（用历史 offset-shape 预测下周，OOS R²） | 高（确定斜坡） | **OOS R² < 0.2** |
| 周一信号空窗占比 | 15.9% | **< 3%**；Monday/其它日方差比 **> 0.5** |

### 目标 3：趣味 / 波动预算（「刺激而非劝退」）

| 指标 | v4 目标区间 |
|---|---|
| 小时 \|收益\| 中位 / p95 | ~0.5~1% / ~2~3% |
| 多小时摆动 / 周内振幅 p50 | 3~6% / 8~15% |
| 多日趋势（基本面驱动）| 10~30% |
| 事件/风暴周 / 泊松跳跃（罕见）| ±15~30% / ±5~15% |
| 单 tick gap 打穿止损的清算级联事件 | **0 起**（衰减核生效的硬指标） |
| 爆仓率较 v3 | 上升但有界（≤25x 杠杆 **< 2~3x** baseline；需先核 user-backend 强平阈值） |
| 玩家盲测：v4 vs v3「有趣度」偏好 / 「可预测性」自评 | 偏好 **>60%** 选 v4；可预测性自评 ↓；「能从内容读出策略」↑ |

> 强制守卫验证：① 离线对 06 月午夜批量回填片段确认伪 surge 守卫把假事件合并降权；② 确认任意 (category,week,salt) 可 O(168) 重算 indexMark 逐位一致（跨机回填对账）。

---

## 5. 被否决 / 降级的设计与原因

1. **D 作独立骨架 → 降级为「治理外壳 + 共识件来源」**：工程最稳（Lens3=5）但基本面深度最薄（Lens1=3，唯一事件钩子 microShock 单一/瞬态/不 carry）、趣味最保守（无 OU 可交易回归、无事件层）。其精华（逐项布尔开关、weekStartMs seed、季节残差化）已全部嫁接；但 **D 的 Box-Muller PRNG 被否**（替换为 Irwin-Hall，避免 168 步递归的跨平台 ULP 漂移）、**D 的拉向 100 锚被否**（替换为 A 的公允值锚）。
2. **C 作独立骨架 → 降级为可选分期事件层（P1-lite / P2-full）**：故事性最强但 effort XL、热表 schema 迁移 + 7 类新聚合（含 milestone 窗口函数，性能面需压测）。**核心否决点**：`EVENT_CARRY_RETAIN=0.6 × 正向事件远多于负向` → 指数系统性上行、做空恒亏 = 亲手制造一个新的可预测规律，与 goal2 自相矛盾。采纳时必须 `RETAIN→0.4` + 负向加权 + 去趋势基线，且默认 OFF、先证明核心层再开。
3. **A 的 `INFLATION_ALPHA 1.0→0.6` 不带换算 → 否**：改动了 scoreSignalRaw 存储定义却未在 loader 加换算，26 周 drift 中位会混入两种 α 口径 = 静默单位错配，恰好污染 A 赖以提取的趋势。仅在 P1 **补换算后**采纳。
4. **A 的滚动 7 日窗重写 → 降为 P2、且与公式改动拆分发布**：对核心 stats 查询路径的大改，T+1 截止与同 offset baseline 对齐有独立正确性面；A 自己也降为二期。P0 用 B 的 early-week blend（更便宜、零新查询）先解病灶④。
5. **A 把病灶④（周一空窗）推迟到二期 → 否**：若先行上线则该 lens 核心目标之一未交付。改在 P0 用 early-week blend 解决。
6. **任何单 tick 事件尖峰 → 否**：必须用 6~12h 衰减核，否则单根离群 tick 落地即回撤、杠杆下批量打穿止损触发清算级联（诊断有物证）。
7. **seed 不含私有盐 → 否**：可被逆向外推，goal2 崩。强制混入部署期固定私盐。

---

## 6. 不确定性与需用户拍板的取舍

1. **波动到多大算「刺激不劝退」（最大不确定）**：§4 给了目标区间（OU 静态 std ~3.5%、跳跃 ±5~15%、风暴周倍数），但最终需 ① 实测回测 + 玩家盲测调参，② **先核对 user-backend 的保证金/最大杠杆/强平阈值**——加大波动后 ≥50x 玩家爆仓率必升，属「放手加波动」的预期代价。建议起步时把 `STOCH_CLAMP=0.35 / JUMP 幅 / 风暴周倍数`取保守值灰度上调。**需用户拍板风险偏好上限。**
2. **事件层 C 是否纳入（P2）**：故事性 vs 热表迁移 + 7 类查询性能 + 正负不对称管理。推荐 **P1 先上 lite 版（零迁移、复用 z）验证戏剧性收益**，确认值得再上 P2 full。**是否上 full 由用户拍板。**
3. **crowd_drag 是否移出价格**：移出 → 更戏剧（「众人皆多→价格继续冲」）、贴合用户「fun 优先 / house edge 非约束」；保留 → 抗操纵（协同做多更难推动价格）。推荐移出（仅记录、flag 可逆），但**抗操纵权衡需用户确认**。
4. **INFLATION_ALPHA 1.0 vs 0.6**：0.6 增加「绝对景气也能赚」的 edge 维度，但需历史换算且略升子类与 OVERALL 相关性（分散对冲价值降）。推荐 P1 带换算上 0.6。**可由用户决定是否值得。**
5. **trendLevel 拐点滞后数周**：用近 W 周中位估计 → 景气反转后指数滞后承认（懂内容玩家「看到拐点却要等指数」）。属「慢趋势/方向」的本质取舍，可接受，但**前端叙事必须从「迟早回 100」改为「指数=品类景气」**，否则前瞻型玩家困惑。这是产品文案而非公式问题，但需配套。

---

## 附录：四项硬约束的逐项守住证明

- **跨周连续**：`o==0` 时四项狂野项（score/anchorTerm/stochTerm/noise）seed-端点恒为 0 → `indexMark≡indexOpen≡上周收盘`，价格为水平式非链式，与波动幅度解耦。✔
- **可回填 / 确定性可复现**：全部随机项 = `(salt, category, weekStartMs, o)` 的纯函数，Irwin-Hall 纯整数+加法逐位确定，O(≤168) 从 offset0 重放，绝不依赖 DB 上一 tick noise。✔
- **可审计**：每项（scoreCorrected / seasonalRef 写入 scoreRef 列 / anchorFull / stochTerm / eventJump / event_impulse）均可由输入+seed 反推；已核 ForecastJob/internal.ts 不依赖 scoreRef 语义。✔
- **向后兼容**：新 `voteRuleVersion='utc8-t+1-v3'`，旧 tick 不改写；P0 保持 α=1.0 → loader 读 v2 行零换算；首个 v3 周一开盘严格等于末个 v2 周日收盘，过渡处不跳价。✔
