# 2026-07-28：R10 最小样本误冻与投票 +1 归因

## 结论

- run 617 是空队列：`batches_total=0`，只有 AMC 启动探针；探针一次 reset、重试后
  200。旧口径把逐尝试的 `1/2=50%` 同时写成 HTTP/transport 失败率，触发 `all`
  第 6 次冻结。
- 修复后探针与业务逻辑请求分账；重试后成功的 probe 最终状态是 200，业务分母仍为
  0。空队列且无业务请求时整轮只落 fingerprint，不判定。
- 每个指标在 `parse_fingerprint.sample_counts` 保存真实分母。默认至少 20 个
  请求/页面/记录才判定，`exit_ip_dist` 至少 5 个出口观察；不足样本不触发绝对阈值、
  不与基线比较、也不训练基线。

## 三类同型误报与“第四类”复盘

共同模式都是把不具代表性的样本当成全局总体：

1. population-sensitive 均值把定向高票 cohort 与全站比；
2. 新 stratum 在基线初始化窗口借用了不匹配/不足历史；
3. 本次 n=2 的 probe-only 样本越过全局绝对阈值。

本次同时收口另外两个入口：单页面/短轮次由 per-metric 当前样本门槛挡住；小样本历史
不会进入七日基线；首次运行只有“本轮样本足够且越过预设绝对红线”才可熔断。七日窗
仍要求至少 3 个同 `(source,mode,population_type)` 的合格历史轮。

真实复验还发现第四类同型语义问题：L1 的 145 个 offset 批不是同一事务快照，抓取
期间单页移动会造成相邻批恰好重复 1 条。HTTP 145/145 全 200、解析器正常，但旧逻辑
把 `is_complete=false` 抛成 run `failed`。现在这种分页时窗漂移记 `partial`，整轮不
推进 L1 状态、不写事实、不计算覆盖率；批请求耗尽、pager/结构失效仍是 `failed`。

## `WhoRated` 比 `rating_votes` 恰好多 1 的归因

抽查 run 511–513 的 +1 页并逐身份对照 WhoRated、v2 新事件与 CROM：

| page | claim → WhoRated | rating → Σsign | 多出身份 | 类型/方向 |
|---|---:|---:|---|---|
| `a-personnel-director-in-the-foundation` | 34 → 35 | 32 → 33 | Eeeee_e | wikidot / +1 |
| `captain-date` | 25 → 26 | 19 → 20 | Eeeee_e | wikidot / +1 |
| `yamizushi-file-no488` | 100 → 101 | 94 → 95 | Lynyiee | wikidot / +1 |
| `scp-cn-2513` | 34 → 35 | 2 → 1 | D JIE Wyvern | wikidot / -1 |

这些不是 DeletedUser/AnonymousUser。v2 在同 run 新增的普通账号事件方向逐页精确等于
差值；CROM 随后已把部分页从旧 claim 更新到 WhoRated 值，部分页仍滞后。归因是
ListPages/CROM 计数缓存与 WhoRated 实时列表的观察时窗差。

因此不改身份口径，也不加 `±1` 容差：这类页面继续保持 `partial`，等待下一轮同一
claim 下精确闭合；真实漏抓仍会被条数与 checksum 两道精确门发现。

## run 状态语义

`meta.ingest_run.status` 新增 `partial`。正常的不完整证据不再冒充 `failed`；
`batches_failed` 只统计真 failed。请求耗尽、解析失效、身份冲突仍为 `failed`，
断路器主动停止仍为 `aborted`。

`0021` 只按 run 自身的确定性证据回填旧误分类：39 个 `failed=0 ∧ partial>0`
的 T2 run，以及本次 145/145 请求成功、仅跨批重复 1 条的 L1 run 731；原
`status/batches_failed` 保存在 `stats.statusSemanticsBackfill/legacy*`，真失败未动。
