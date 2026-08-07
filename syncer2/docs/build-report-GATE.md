# GATE：v2 出站自适应护栏修复报告

日期：2026-08-07（Asia/Shanghai）  
范围：`meta.egress_control`、`PostgresAdaptiveEgressGate`、既有 work failure 分类桥接、L1 新鲜度信号。未修改 forum/image/conventions 采集层，也未触碰或投递 QQ。

## 技术结论

旧护栏确实是“易降难升”的单向棘轮：它把 work-queue 的确定性业务失败混入站点压力，并要求连续六个 `<=1%` 窗口；而同一时段 work-queue 原始失败率为 2.50%，所以恢复证据会反复清零。修复后：

- 反馈分子只包含无 HTTP 响应、429 和未被既有业务分类排除的 5xx；确定性失败另记 `deterministic_failures`，仍保留在请求分母和审计中。
- 阈值改为连续两窗 `>=5%` 降一档、单窗 `>=10%` 立即降一档、连续六窗 `<=3%` 恢复一档；健康窗可在最低保持期内累计，但变档仍必须等保持期结束。
- 档位和滚动预算继续全站共享；只把通道的请求、压力失败和确定性失败分账，不做可绕过共享 IP/站点保护的独立通道档位。
- L1 不再用“零失败”代替新鲜度：直接检查相邻 L1 `started_at`，5 分钟目标加 1 分钟调度宽限，落持久 SLO 告警并进入运行摘要。
- schema 迁移 `0045` 已先执行；并行迁移 `0047`/`0049` 两次回写旧策略，最终前向迁移 `0050` 在部署序列末尾幂等重放 `0048`，把 5%/10%/3%/3,500 合同确认为 policy version 4。没有改写已执行迁移历史。

## 1. 确定性失败如何分类

没有新建第二套错误词表。唯一分类来源仍是 `classifyWorkFailure()` 产出的既有 `WorkFailurePolicy.family/signature/action`；`deterministicEgressFailureClass()` 只是把既有结论桥接给 gate。

| 既有证据/分类 | 对出口护栏的含义 | 计入压力分子 | 实现理由 |
|---|---|---:|---|
| transport 无响应、429、普通 5xx，既有分类为 `transient` | 站点/链路容量信号 | 是 | 重试可能成功，也正是站点拒绝或出口不健康的可操作信号 |
| `identity_absent / page_bound_amc_http_500_empty` | page-bound AMC 对已不存在身份的确定性空 500 | 否；改记 deterministic | 复用已有空体 500 身份判据；只有这个精确签名和 HTTP 500 会改账，不会抹掉同任务更早的 transport/429/其他 5xx |
| `identity_absent` 的 `no_page`、空实体、slug 身份不一致 | 确定性身份结论 | 否 | 通常来自成功 HTTP 的业务内容，本来就没有进入压力分子 |
| `structural`，含 `no_permission`、`not_ok`、解析结构/契约拒绝 | 确定性结构或权限结论，既有 action 为 `irreconcilable` | 否 | 通常是 2xx 内容或非 429 的 4xx；HTTP 层已视为站点有正常响应，无需再造分类 |
| `prerequisite` | 本地/L1 前置证据不足 | 否 | 不是一次站点拒绝；没有对应压力 attempt 时不产生分子 |
| 预期 3xx/4xx（429 除外），包括 404 | URL/业务结果 | 否 | 站点已正常响应；把删除页混入会再次造成通道连坐 |

`HttpClient` 在 work task 既有分类完成前暂存 attempt 结果。分类完成后只把精确匹配的空体 500 改记为 deterministic；其余真实压力逐 attempt 原样结算。分钟桶和当前 100-request 窗口都同时保存 pressure 与 deterministic 两个计数，便于以后直接复核。

## 2. 阈值与数据依据

### 2.1 实测噪声重算

用户给定的三小时通道表合计 1,716 requests、22 个原始失败，按总量重算为 1.28%；控制器的独立 100-request 混合窗口曾观测到约 4%。对 work-queue 的 17 个失败进一步复用既有分类：9 个是 page-bound AMC 空体 HTTP 500（`identity_absent`），8 个是 transport。由此得到站点压力估计：

| 通道 | requests | 原始失败 | 确定性排除 | 压力失败 | 压力率 |
|---|---:|---:|---:|---:|---:|
| L1 | 1,011 | 5 | 0 | 5 | 0.49% |
| work-queue | 679 | 17 | 9 | 8 | 1.18% |
| 其余 | 26 | 0 | 0 | 0 | 0% |
| 合计 | 1,716 | 22 | 9 | 13 | **0.76%** |

历史对照是 2026-08-02 的最低安全水位 3,663 requests/h（观测范围约 3,663–3,847/h）且失败率 `<1%`，危险区为 22.6%，随后事故达到 78.5%。这三组数据分别给出常态噪声、容量边界和必须保留的快速保护边界。

### 2.2 新旧策略

| 判据 | 旧策略 | 新策略 | 数据理由 |
|---|---:|---:|---|
| 趋势降档 | 连续两窗 `>=2%` | 连续两窗 `>=5%` | 5% 是修正后 0.76% 噪声的约 6.6 倍，仍远早于 22.6% 危险区 |
| 严重单窗 | `>=5%` | `>=10%` | 10% 是噪声的约 13 倍、仍不到已确认危险区的一半；22% 合成窗口仍会逐窗立即降档 |
| 健康恢复 | 六窗 `<=1%` | 六窗 `<=3%` | 3% 是修正后噪声约 4 倍，也高于 work-queue 2.50% 的未修正原始常态；门槛可达但仍显著低于拒绝区 |
| 健康证据时机 | 保持期内全部丢弃 | 保持期内累计，保持期结束才能变档 | 保留“恢复慢于降档”，消除反复丢证据造成的棘轮 |
| 60 分钟硬预算 | `>3,200` | `>3,500` | 比最低实测安全水位 3,663/h 仍低 163（4.45%），又不再由 3,201 的正常流量直接打进 cooldown |

档位间隔和最低保持期没有放松：L1=667 ms/30 min、L2=2,000 ms/45 min、L3=8,000 ms/60 min；恢复一次仍只升一档。连续健康且流量足够时，L3 的 600-request 证据约需 80 分钟，随后 L2 最低保持 45 分钟、L1 最低保持 30 分钟，最坏正常恢复预算约 155 分钟。任一 `>3%` 坏窗口都会清零健康证据并从最后坏窗口延长当前档保持期。

## 3. 通道隔离方案与风险

完全独立的通道 gate 不可取：L1、work-queue、sitemap/forum 等共享出口 IP 池和同一 Wikidot 容量；任一通道看到的真实 429/5xx 可能是全站正在接近封禁，其他通道不能自行保持 normal。

采用的折中是“全局执行、通道归因”：

1. `meta.egress_control` 仍只有一个全局 level、permit 时钟、100-request 反馈窗和 60 分钟预算。
2. `meta.egress_request_bucket` 按 channel 分别保存 requests、pressure failures、deterministic failures。
3. 确定性业务失败不会再由 work-queue 拖慢 L1；但任一通道的真实压力仍触发全局保护，这是共享基础设施下有意保留的连坐。
4. 改账只接受既有分类的精确签名。误分类风险被限制在一个已验证形状，并可由新 deterministic 桶审计；不会把整个 `structural` 家族拿来覆盖同任务真实的传输故障。

截至 19:20 的活库最近 30 分钟分账为：L1 469/0 pressure/0 deterministic，work-queue 175/0 pressure/3 deterministic，forum 19/0/0，其他 3/0/0。近期三个空体 500 已按设计进入 deterministic，且没有造成降档。

## 4. L1 SLO 退化信号与退出语义

新增状态：`l1_last_started_at`、`l1_slo_degraded_since`、`l1_slo_expected_recovery_at`、`l1_slo_last_gap_seconds`、`l1_slo_overdue`。每个真实 L1 run 启动时比较相邻轮次：

- gap `<=6 min`：`met`，清除退化状态，exit 0。
- gap `>6 min` 且全局 gate 正在降档、尚未超过逐档恢复预算：`degraded_expected`，持久写 `slo_degradation`，摘要包含 level/reason/recover-not-before/expected-recovery-at，exit 0。
- 超过预计恢复窗口：`degraded_overdue`，再写 `slo_degradation_overdue`，exit 1。
- level 0 仍丢失频率：`degraded_unattributed`，不能把非护栏故障藏进宽限，直接 exit 1。

调度单元的通用降档语义复用了 FORUMIMG 已加入的 `evaluateAdaptiveSelfProtection()`：预期降档 exit 0，摘要标档位和恢复时间；只有超期才 exit 1，没有重复实现另一套恢复时钟。

活库验证捕获了旧事故残留：19:14 L1 启动时相邻 gap=2,637 秒，写入 `slo_degradation` 与 `slo_degradation_overdue`；19:19 下一轮 gap=291 秒，状态恢复 `met` 并清空退化字段。信号写入 `meta.egress_alert`，不做 QQ 投递。

## 5. 迁移与活库激活

1. `0045_adaptive_egress_recovery.sql`：先扩 schema，增加 deterministic 分账、L1 SLO 状态和新 alert kind；只改兼容结构，不激活策略。
2. 19:13:17 的首次 `policy_rebase` 在 rolling 低于新预算、最近窗口低于新严重线时，把旧策略造成的 level 3 安全重置为 level 0。
3. 并行交付随后执行了 `0047_restore_adaptive_egress_contract.sql`，在 19:21 把 policy JSON 回写为旧 2%/5%/1%/3,200。为保持已执行迁移不可改写，新增 `0048_adaptive_egress_policy_v4.sql` 做前向纠偏，而不是删除或伪造历史。
4. `0048` 检查 `0045` schema、取得同一 advisory lock，并把最终合同写为 version 4：5%/10%/3%、健康窗在保持期内累计、budget 3,500。早期幂等验证发现 `real` 比较精度会多写审计，已改用 `numeric`，随后复跑为 `INSERT 0 0 / UPDATE 0`；历史审计没有删除。
5. 并行交付在 19:37 又执行了 `0049_restore_adaptive_egress_contract_v5.sql`。为让全新部署和当前库都以本任务合同收敛，新增末尾迁移 `0050_finalize_adaptive_egress_policy.sql`，只幂等重放已验证的 `0048`，不复制第三套策略 SQL。
6. 迁移均拒绝在受保护的 v1 库名上执行，并实际应用到由 `backend/.env` 派生的 `scpper-v2`。19:46 最终复核：level 0、policy version 4、budget 3,500、rolling hour 1,889、L1 最近 gap 300 秒且 SLO 未超期。

## 6. 回归与验证

| 验证 | 结果 |
|---|---|
| 确定性失败占多数、站点健康 | 70 deterministic + 1 pressure/100：不降档；已降档在六个可达健康窗恢复 |
| 站点真实拒绝 | 22 pressure/100：每窗立即降一档，三窗进入 cooldown |
| 常态噪声 | 1 pressure/100：六个健康窗完成恢复 |
| L1 五分钟 SLO | 30 分钟 gap 在预期窗口内产生信号且 exit 0；156 分钟超期 exit 1 |
| 既有分类桥接 | 本地空体 HTTP 500 在分类前不污染 gate，分类后记 deterministic |
| 相关专项 | `29/29` 通过（adaptive egress、identity failure、work-queue） |
| TypeScript | `npx tsc --noEmit` 通过 |
| 全量 `npm test` | 早期快照 `442/442`；最终并行快照 `442/446`，4 fail 均为同一个非本任务 projector 活库样本 |
| 失败复跑 | `projector.test.ts` 再跑 `7/11`，仍固定为 user 37715 的 `cum_rating=1347`、`total_rating=1348`；未改断言或投影层 |

未为了活库偶发失败修改既有断言。测试数量相对用户给出的 431 基线增加，是当前并行 FORUMIMG 测试加入以及本任务新增回归所致。

## 7. 限制、稳健性与后续观察

- 历史桶当时没有 deterministic 列，0.76% 是按原始通道总量和既有失败样本重建；新 schema 以后可直接查询，不再依赖样本回推。
- 三小时是针对本次故障的有效诊断窗，但不是长期分布。建议连续观察 7 天的通道 pressure/deterministic 分位数；只有当健康 pressure 的 p99 接近 3% 或危险区明显下移时才重新标定，不应仅凭单窗改阈值。
- SLO 信号在下一次 L1 调度单元启动时根据实际 gap 落库，不是独立的分钟级外部 pager。若需要在第 6 分钟立即通知，应由监控系统查询这些持久字段/alerts；本任务按要求没有新增 QQ 通知。
- 全局真压力仍会让通道共同降档，这是共享站点/IP 下的安全设计，不是待消除的副作用。可追加 per-channel 看板，但不建议新增独立解除保护的档位。

## 8. 交付状态

当前活库已恢复 level 0，policy version 4，L1 最近轮次 gap 300 秒并已清除 SLO 退化状态。出站功能与专项无阻塞；交付阻塞为完整 `npm test` 中稳定复现的投影层活库差 1，以及仍在运行的 FORUMIMG 并行进程可能继续竞写共享文件。未创建 commit，未 push。
