# R10 解析健康熔断误报：定向高票 cohort 被当成解析漂移

日期：2026-07-28  
影响：`meta.write_freeze.domain='all'` 冻结，`freeze_count=4`；work queue 从 488 增至 520，冷启动停止。  
触发：run 201，`wikidot_tier2 / tier2 / targeted_queue`。

## 发生了什么

run 201 定向重放 50 个仍需撤票确认的页面，全部 HTTP 200，50/50
`claimed_total=fetched_total`，50/50 `checksum_ok=true`。该 cohort 天然偏向高票页；
其中抽样页为 708/676/400/341 票，批次 `avg_votes_per_page=131.333`。

R10 却把这个定向批次的绝对均值与混合 Tier2 历史基线 `64.3667` 比较，得到
`+104.04%`，超过 ±50% 阈值后误冻 `all`。数据和解析均正确，错误发生在指标选型：
`avg_votes_per_page` 描述“抓了哪些页”，不描述“是否正确解析这些页”。

## 十项原始指纹复核

| 指标 | population 属性 | 处置 |
|---|---|---|
| `revision_type_dist` | sensitive | 默认 gate 退役；只有固定 cohort 可显式分层比较 |
| `avg_votes_per_page` | sensitive | 默认 gate 退役，仅留证据 |
| `avg_tags_len` | sensitive | 默认 gate 退役，仅留证据 |
| `avg_source_len` | sensitive | 默认 gate 退役，仅留证据 |
| `avg_body_len` | sensitive | 默认 gate 退役，仅留证据 |
| `http_status_dist` | invariant | 保留 |
| `exit_ip_dist` | invariant | 保留 |
| `transport_failure_rate` | invariant | 保留 |
| `parse_drop_rate` | invariant | 保留 |
| `selector_empty_rate` | 同分层内 invariant | 保留 |

新增两项由 `meta.page_scan` 独立证据聚合的默认 gate：

- `fetched_claimed_ratio`：逐页 `fetched_total / claimed_total` 的平均完整性比，正常约 1；
- `checksum_ok_rate`：有校验结论的页面中 `checksum_ok=true` 的比例，正常约 1。

## 修复

1. 默认策略移除五项 population-sensitive 指标，没有放宽原阈值。
2. `meta.parse_health_baseline` 主键改为
   `(source, mode, population_type, metric)`；历史 run 显式回填 `population_type`。
3. 全站、范围样本、变更切片、定向队列和 probe 使用不同总体；历史查询、缓存刷新、
   breach 留痕均使用完整三维分层。
4. 历史 `page_scan` 回填两项完整性指标；run 201 的两项结果均为 1。
5. 回归同时覆盖“全是高票页但完整性为 1 不误报”和
   “`fetched_claimed_ratio=0.5` 仍作 `freeze_write` 判定”。

## 冻结期证据链

“冻结写入、不冻结采集”语义成立。run 202 在总闸冻结后仍写入 5 条
`meta.page_scan(status='failed')`，每条保留 `PGF01` 冻结原因；`ingest_run` 也正常收尾。
冻结阻止的是 ingest/serve 事实与投影写入，不阻止 meta 证据。

## 防复发规则

新增解析健康指标前必须回答：相同解析器面对两个合法但页面构成不同的批次，指标是否仍应
近似不变？若否，它只能作为证据，或必须先定义不会混合总体的 cohort 分层；不能靠放宽阈值
把 population shift 伪装成可接受的 parser drift。
