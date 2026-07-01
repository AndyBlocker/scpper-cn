# Oracle v4 回测验证与生产参数定稿（2026-06-30）

> 承接 `docs/gacha-market-oracle-v4-proposals-2026-06-30.md`（v4 多方案综合推荐）。
> 本文记录对该方案的**离线回测**结论：一处关键架构修正 + 钉死的生产参数 + 达标证据。
> 回测全程**只读、不写库、不改任何历史 tick**；v4 上线只作用于之后的 tick（向后兼容设计）。
> 回测脚本：`scratchpad/backtest2.mjs`（增量驱动版）。数据：`CategoryIndexTick` 全史 20142 行（02-08~06-30）。

---

## 0. TL;DR

1. **关键架构修正**：原 v4 方案把基本面当「价格水平的乘子」(`price=open·exp(K·score)`)——回测证明这条**结构性达不到目标1**（corr 仅 0.20，比 v3 还低）。改成「基本面**增量驱动**」(`Δln price = K·score + 随机增量`)后，corr 飙到 0.6~0.75。**这是 v4 能否反映基本面的命门。**
2. **三目标同时达成（长窗口 13 周验证）**：corr7d 0.64（目标>0.5）、周振幅中位 13.3%（中等档 8~15%）、acf168≈0（周周期消除）、小时收益近白噪声（日内不可预测）。
3. **双尺度分离**：小时级方差 ~100% 是随机（日内不可预测、有惊喜）；7 日尺度由基本面单向累积主导（多日方向反映品类景气）。像真实股市：日内噪声、长期看基本面。
4. **不再是单边市**：各品类按自己基本面分化（后半段 GOI +25%/SCP +8% 涨、TALE −57% 跌、OVERALL 走平），做多做空都有依据。相对 v3「全线下跌→做空全赢」是根本改善。
5. **防漂成立**：弱公允值锚（λ=0.25）把各品类稳态价格钉在 59~130 合理区间，无品类漂向 0。

---

## 1. 为什么必须从「水平乘子」改成「增量驱动」

基本面信号 `score_signal_raw` 是**去 12 周基线的 z-score**：长期均值≈0、均值回复、无累积。

- **水平乘子** `price = open·exp(0.13·scoreCorrected)`：z-score 在 0 附近抖 → 价格只能在 open 附近抖，**永远走不出由基本面驱动的多日趋势**。回测 corr 最高 0.22，调参无效（这是架构问题不是参数问题）。
- **增量驱动** `ln price[t] = ln price[t-1] + K·scoreCorrected[t] + 随机增量`：score 持续为正→价格持续涨，品类景气趋势直接**累积**成价格趋势。回测对照（纯基本面增量驱动）corr=0.96。

附带好处：链式增量**天然连续**（无重置点），「下周开盘=本周收盘」自动满足，连 v3 的「周开盘 + 周内 anchor ramp」结构都不再需要。

---

## 2. 定稿的 v4 公式（增量驱动）

每小时、每品类，逐时链式：

```
# 基本面层（drift 季节/趋势分解 + early-week blend）
levelRef    = median(该品类近 26 周 raw)                        # 品类基本面水平，保留
seasonalRef = median(本 offset 桶 raw) − levelRef               # 纯周内季节形态
rawEff      = blend(rawNow, 上周收盘 raw, clamp(o/72,0,1))       # early-week，消周一空窗
scoreCorrected = clamp(rawEff − β_seas·seasonalRef − β_level·levelRef, ±3.6)
  β_seas = 0.9(OVERALL)/0.8(其它)，β_level = 0.05

# 随机层（连续 OU + GARCH + 泊松，seed 确定性可复现）
σ_t²   = ω + 0.18·incr_{t-1}² + 0.78·σ_{t-1}²    (ω = (σ_target·volWeek)²·0.04，平稳化)
incr_t = σ_t·N(seed)  [+ 泊松跳跃 λ=0.006/h, ±3~7%]
S_t    = clamp((1−κ)·S_{t-1} + incr_t, ±0.5),  κ=0.06
stochIncr = S_t − S_{t-1}

# 弱公允值锚（防长期漂移；F 随基本面浮动，非固定 100）
F          = ln(100) + 0.18·levelRef
anchorIncr = (λ/168)·(F − ln price_{t-1}),  λ=0.25

# 价格（增量驱动，链式连续）
ln price_t = ln price_{t-1} + K_FUND·scoreCorrected + stochIncr + anchorIncr
```

PRNG：`Irwin-Hall(12·mulberry32(hash32(ORACLE_SEED_SALT, category, weekStartMs, offset)))`，纯整数+加法、逐位可复现、含部署期私盐防逆向外推。

---

## 3. 生产参数（钉死）

| 参数 | 值 | 作用 |
|---|---|---|
| `K_FUND` | **0.0013** | 基本面增量驱动系数（标定：score≈1 的品类一周约涨 ~22%，实际 score 多在 ±0.5） |
| `SIGMA_TARGET` | **0.0045** | OU 随机增量目标小时 std（中等波动档） |
| `OU_KAPPA` | 0.06 | 随机位移均值回复（半衰期≈11h，方差有界、不累出假趋势） |
| `GARCH_ALPHA/BETA` | 0.18 / 0.78 | 波动聚集（冷热周） |
| `JUMP_LAMBDA` / 幅 | 0.006/h / ±3~7% | 低频泊松跳跃（~1/周）|
| `ANCHOR_LAMBDA` | **0.25** | 弱公允值锚（防漂；λ↑→corr↓，0.25 是平衡点） |
| `FAIR_GAMMA` | 0.18 | 公允值随基本面浮动幅度 |
| `EARLY_WEEK_HOURS` | 72 | 周初 blend，消 15.9% 周一空窗 |

> 波动档调节：`SIGMA_TARGET` 控日内波动，`JUMP` 控偶发脉冲。要更刺激（±15~25%/周）调高两者；要更温和（±5~8%）调低。本参数对应用户选定的**中等档 ±8~15%/周**。

---

## 4. 达标证据

### 短窗口（06-08~06-30，19 天）

| 指标 | v3 | v4 | 目标 |
|---|---|---|---|
| corr7d（价格 vs 基本面） | 0.28 | **0.59** | >0.5 ✓ |
| 深跌指数 corr（SCP/GOI/WAND） | −0.21/0.46/−0.07 | **0.60/0.91/0.88** | 转正 ✓ |
| 周振幅中位 | — | 14.7% | 8~15% ✓ |
| acf168（周周期） | 0.22 | −0.01 | <0.2 ✓ |
| 小时\|收益\|中位 / p95 | 0.46% | 0.36% / 2.3% | 有惊喜 ✓ |
| momentum acf1 | −0.05 | ≈0 | 不可外推 ✓ |

### 长窗口（04-01~06-30，13 周，λ=0.25）

| 品类 | corr7d v4/v3 | 周振幅% | acf168 | 全期/后半漂移% | 稳态值 |
|---|---|---|---|---|---|
| OVERALL | 0.52/0.28 | 9.6 | −0.00 | −22/−2 | 74.6 |
| TRANSLATION | 0.36/0.30 | 16.1 | 0.02 | 11/7 | 129.5 |
| SCP | 0.87/0.41 | 9.7 | −0.01 | −2/8 | 66.0 |
| TALE | 0.45/0.23 | 13.9 | −0.01 | −102/−57 | 59.0 |
| GOI | 0.77/0.63 | 15.7 | −0.01 | −57/25 | 63.1 |
| WANDERERS | 0.90/0.46 | 14.8 | −0.01 | −16/−5 | 78.1 |
| **汇总** | **0.64**/0.39 | 13.3 | ~0 | — | 59~130 |

后半段漂移有正有负 → 不再单边、按基本面分化。

---

## 5. 两个 outlier（均为「真实基本面」，非 bug）

1. **TALE 持续跌（corr 0.45、后半 −57%）**：故事类内容产出/活跃度在该窗口真实衰落，价格忠实反映。属期望行为（看对衰落的玩家做空获利=策略深度）。如担心无限下探，可加**非线性地板锚**（价格越低于某阈值、回拉越强），把极端区间软约束在如 20~500；不影响中段动态。
2. **TRANSLATION corr 偏低（0.36）+ 振幅偏大**：译文是全站主体，`raw=译文−OVERALL≈0`，信号弱、噪声大（「大盘股」特征）。短窗一度反号（−0.29）是小样本噪声，长窗转正。可接受，或对其单独提高 `K_FUND` 补偿信号弱。

---

## 6. 落代码 P0 清单（增量架构版，更新自 v4 提案 §3）

对 `backend/src/jobs/CategoryIndexTickJob.ts`，全部带灰度开关、零 schema 迁移、保持 `INFLATION_ALPHA=1.0`：

| # | 改动 | 开关 |
|---|---|---|
| 1 | `TICK_RULE_VERSION` → `'utc8-t+1-v3'` | — |
| 2 | 新增 PRNG 工具（hash32/mulberry32/Irwin-Hall + `ORACLE_SEED_SALT`） | — |
| 3 | **价格模型改链式增量**（弃「水平式+周开盘」；`indexMark[t]=indexMark[t-1]·exp(dlog)`，天然跨周连续） | `V4_INCREMENT_PRICE` |
| 4 | 基本面 drift 项 `K_FUND·scoreCorrected` | 同上 |
| 5 | drift 季节/趋势分解（β_seas/β_level） | `V4_DRIFT_SEASONAL` |
| 6 | OU+GARCH+泊松 连续随机增量（替换 ±0.3% deterministicNoise） | `V4_STOCH_LAYER` |
| 7 | 弱公允值锚增量（λ=0.25, F 随基本面） | `V4_ANCHOR_FAIRVALUE` |
| 8 | early-week blend（消周一空窗） | `V4_EARLY_WEEK_BLEND` |
| 9 | `scoreRef` 列改记实际扣减量（审计） | — |

落代码后验证：① 用本回测脚本对更长全史回测复跑达标；② 灰度时对比 v3/v4 的 corr7d/acf168/振幅；③ 确认任意 (category,week,salt) 可 O(168) 逐位重算（跨机对账）。

事件层（P1-lite / P2-full）**首版不做**，留待核心上线验证后。注意调研结论：投票数据是日粒度、正负事件 155:1 偏置，事件层须配去趋势+负向对冲（见 v4 提案 §6 与事件层调研）。

---

## 7. 历史 tick 零变更保证（头号硬约束）

用户铁律：**绝不变动任何已经产生的 tick。** v4 的增量架构天然契合此约束（链式衔接只读上一价格、不重写历史）。代码审计（`CategoryIndexTick` 的全部写入路径）：

| 路径 | 行为 | 风险 |
|---|---|---|
| `CategoryIndexTickJob.ts:540` `create()` + P2002-skip(573) | 只 append 新小时；该小时已存在则抛 P2002 被跳过 | **永不覆盖** ✓ |
| `fixCategoryIndexVoteCutoffDate.ts:63` `UPDATE` | 一次性历史字段修复 CLI，不在正常流程 | v4 不调用 ✓ |
| `IncrementalAnalyzeJob.ts:227` `deleteMany({})` | **唯一能清空历史的路径**，被 `--rebuild-index-ticks`（须配 `--full`）严格门控；默认 PRESERVED（commit 514d35c） | 仅显式手动触发 |

落代码与运维铁律：

1. **只换公式生成未来 tick**（`voteRuleVersion='utc8-t+1-v3'`）；v1/v2/v3 历史 tick 一个都不动、也无需动。
2. **绝不跑 `--rebuild-index-ticks`**——它会用 v4 公式重算整段历史、冲掉存续合约的 `entryIndex` 参考价（既违反约束又使结算错乱）。
3. **增量衔接**：v4 首个 tick 的 `price[t-1]` = DB 中最后一个 v3 tick 的 `index_mark`（只读），平滑接续、不重写历史。
4. **新增护栏**（落代码时实现）：`cleanAnalysisData` 的 rebuild 分支在检测到表内存在 ≠ 当前 `TICK_RULE_VERSION` 的历史版本时**拒绝执行 / 要求二次确认**，防止 v4 公式静默重写 v1/v2/v3 历史。
5. **回测纯内存离线、零写库**（已遵守）。
6. **backfill 边角**：`forceFullBackfill`（14h 回填）用 create+P2002-skip，只补「从未生成过」的缺失小时洞、不覆盖已有；上线时确保近端无 tick 洞，避免 v4 补洞夹在 v3 tick 间造成轻微公式不一致。

> 验收：v4 上线前后，对任一 `as_of_ts ≤ 上线时刻` 的历史 tick 做行级 diff（id/index_mark/score_*），必须**逐行零变化**。

## 8. 数据口径与局限

1. 回测用真实 `score_signal_raw` 作基本面输入，按 v4 公式在内存自洽重放，起点衔接 v3 实际开盘值。**未写库、未改历史 tick。**
2. 长窗口 13 周（04-01~06-30）；更早期 drift 历史不足 8 周时 `seasonalRef=0`（渐进生效）。落代码前建议用更长全史 + 灰度再确认。
3. 逐品类 corr 在短窗口（<3 个独立 7 日窗）统计噪声大，应以长窗口与汇总为准。
4. 回测中 `activityDev`（随机波动随真实日内活动调制）暂用常数 volWeek，未接入 micro 信号；落代码可接入以让「湍流也携带景气」。
5. 参数甜点对该数据窗口标定；上线需灰度微调（尤其 `K_FUND` 对信号弱品类、`λ` 对强趋势品类）。
