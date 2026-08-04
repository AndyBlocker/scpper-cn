# 解析健康指标 × Population 收口矩阵（2026-07-29）

本表是第五类误报（run 1148）后的完整审计快照，并补入第七类误报（run 2699）的
稀有事件分辨率收口。符号：`G✓n` = 可冻结且已有 n 个合格历史窗口（N=3）；
`G~n` = 可冻结但仍在暖机，只记录不判定；`W` = 只记 warn；
`E` = evidence-only；`—` = 该生产者不产此指标。历史计数截于 2026-07-29 11:04 CST，
只计最近 7 日 `status in (ok,partial)`、同 `(source,mode,population_type)` 且本轮分母
达标的窗口。

| source / mode / population | revision type | avg votes | avg tags | avg source | avg body | HTTP bad | exit IP | transport | parse drop | selector empty | fetched/claimed | checksum | 自动冻结域 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| `wikidot/tier1/full_scan` | — | E | E | — | — | W✓3 | W~0 | W✓3 | G~0 | G~0 | — | — | page |
| `wikidot/tier1/l3_full_site_tier1` | — | E | E | — | — | W~1 | W~0 | W~1 | G~0 | G~0 | — | — | page |
| `wikidot_listpages/l0_content/l0_updated_at_window` | — | — | — | — | — | E | E | E | E | — | — | — | 无（每轮 1–3 样本） |
| `wikidot_listpages/l1_votes/l1_full_site_minimal` | — | — | — | — | — | W✓29 | W~0 | W✓29 | G✓23 | — | — | — | vote |
| `wikidot_sitemap/full/full_scan` | — | — | — | — | — | E | E | E | G~0 | — | — | — | page |
| `wikidot_sitemap/full/l2_sitemap_absence` | — | — | — | — | — | E | E | E | G✓11 | — | — | — | page |
| `wikidot_sitemap/threads/forum_scoped_scan` | — | — | — | — | — | E | E | E | G~1 | — | — | — | forum |
| `wikidot_forum/forum/targeted_queue` | — | — | — | — | E | W~0 | W~0 | W~0 | E | — | — | — | 无 |
| `wikidot_tier2/tier2/targeted_queue` | — | E | — | E | E | W✓125 | W~0 | W✓125 | — | — | W✓6 | W✓6 | 无；完整性仍逐页拒绝采用 |
| `wikidot_tier2/tier2_replay/acceptance_replay` | — | — | — | — | — | W~0 | W~0 | W~0 | — | — | W~0 | W~0 | 无 |
| `wikidot_tier2/revision_source_backfill/revision_source_full` | — | — | — | E | — | W✓ | — | W✓ | E | — | — | — | 无 |
| `wikidot_page_identity/resolve_pages/targeted_queue` | — | — | — | — | — | W~0 | E | W~0 | — | — | — | — | 无 |

## 指标定义与最低样本

| 指标 | 统计类型 | 当前值分母 | 相对判定条件 | population 属性 | 默认用途 |
|---|---|---:|---|---|---|
| `revision_type_dist` | 分布漂移 | 20 revisions | TVD，不做原始率除法 | sensitive | 仅严格固定 cohort；当前无生产 gate |
| `avg_votes_per_page` | 稳定均值 | 20 pages | 同总体下相对偏离有意义 | sensitive | evidence-only |
| `avg_tags_len` | 稳定均值 | 20 pages | 同总体下相对偏离有意义 | sensitive | evidence-only |
| `avg_source_len` | 稳定均值 | 20 pages | 同总体下相对偏离有意义 | sensitive | evidence-only |
| `avg_body_len` | 稳定均值 | 20 pages/posts | 同总体下相对偏离有意义 | sensitive | evidence-only |
| `http_status_dist` | 稀有事件率 | 20 business requests | 非 2xx 至少 5 次 | invariant | 上界 10%；只告警 |
| `exit_ip_dist` | 集中度 | 5 IP probes | 最大桶占比相对偏移 75% | invariant | 只告警 |
| `transport_failure_rate` | 稀有事件率 | 20 business requests | 传输失败至少 5 次 | invariant | 上界 10%；只告警 |
| `parse_drop_rate` | 稀有事件率 | 200 输入行/目标 | 丢行至少 5 次 | invariant | 上界 0.5%；sitemap 固有根节点时 10% |
| `selector_empty_rate` | 稀有事件率 | 20 rows | 最坏 selector 空值至少 5 次 | invariant within stratum | 上界 15% |
| `fetched_claimed_ratio` | 有界完整性比 | 20 vote pages | 基线约 1，数值稳定 | invariant；targeted 有选择偏差 | targeted 仅 warn |
| `checksum_ok_rate` | 有界完整性比 | 20 vote pages | 基线约 1，数值稳定 | invariant；targeted 有选择偏差 | targeted 仅 warn |

绝对上下界必须按完整 `(source,mode,population_type,metric)` 四元组显式配置；未配置
组合只有相对偏离判据，绝不继承同 metric 的全局红线。所有绝对上下界与相对阈值共用
`min_history_windows>=3`。没有有限
`baseline_value`，或历史/当前任一分母不足时，`decisionEligible=false`，不产生
breach、warn 或 freeze。`unspecified` 与 `probe` 分层永远只留证。

四项稀有事件率另有统一分辨率门槛：本轮坏事件少于 5 时，只跳过**相对偏离**；
显式绝对红线仍独立生效。选择坏事件计数下限而不是为四个指标分别加例外，是因为它
直接回答“这个比率是否由足够多的离散事件支撑”，也让 42 请求/1 次 500 不判、500
请求/75 次非 2xx 仍同时命中 10% 绝对红线与相对偏离。

轻微越界要求连续两轮才冻结；超过阈值 1.5 倍的整体坍缩立即冻结。HTTP 状态、出口
拓扑和传输失败即使达到 breach 也只告警：它们是跨域上游链路信号，失败请求已由逐请求
门控拒绝采用，不能把本轮碰巧选中的 content/vote/revision 当成故障归属。PGF01/write_frozen
属于我方写闸状态，必须从失败类指标的分子、分母和任务重试预算同时排除。

## 生产者本地指标

| 指标 | 生产者 | 结论 |
|---|---|---|
| `selector_literal_rate` / `duplicate_fullname_rate` | ListPages | evidence；已有批次完整性门控，不复用通用基线 |
| `identity_parse_drop_rate` | resolve-pages | evidence；当前混合“解析不到 id”和其它失败，拆净前不 gate |
| `sitemap_missing_lastmod_rate` / `sitemap_dedupe_rate` | sitemap | evidence；缺 lastmod/重复不等于解析丢行 |
| `forum_id_drop_rate` | forum sitemap | evidence；与通用 sitemap drop 分开归因 |
| `forum_category_count` / `avg_posts_per_thread` / `forum_author_kind_dist` | forum | population-sensitive evidence |
| `avg_posts_per_thread` / `avg_body_len` | forum | population-sensitive evidence |
| `revision_source_failure_rate`（兼容落 `parse_drop_rate`） | revision source backfill | 含 no_permission/远端状态/任务失败，不是解析丢行；evidence-only |

## 本次发现并关闭的空洞

1. 绝对红线曾绕过基线暖机；现与相对阈值统一要求 N 个历史窗口。
2. L0 的 1–3 样本和论坛的最多 50 目标无法分辨 0.5% drop；现明确 evidence-only。
3. `exit_ip_stats.byIp` 的值已是 `{probes,...}`，旧代码把整项归一成 null；现兼容嵌套计数。
4. forum early-health 曾落到 `unspecified/unspecified` 并在 finish 时重复判定；现显式传分层。
5. 默认策略曾盲目注册到 backfill/probe/生产者不产的指标；迁移已禁用，新增只按矩阵登记。
6. 单项异常不再自动冻结 `all`；按上表域冻结，`all` 仅保留人工/未来多域相关性判据。
7. `meta.write_freeze_alert_state` 在 30 分钟后显式标 `overdue`，不包含任何消息推送。
8. L1 覆盖窗口与 `all/page/content/revision` 冻结重叠时标为 baseline init；保留 apparent
   miss 取证，但不进入 rolling/告警。迁移会回算缓存，冻结级联不会污染覆盖率 7 天。
9. PGF01 证据行从完整性聚合中硬排除；各消费者遇写闸释放任务且不计 failed/attempt。
10. 绝对阈值改为四元组白名单；`revision_source_full.parse_drop_rate` 因语义不成立退役。
11. 稀有事件率相对判定增加统一的 5 个坏事件分辨率门槛；HTTP/出口拓扑/传输层降为告警，
    `freezeDomainsForMetric()` 对两者返回空集，部署迁移前后的旧策略也不能再误冻数据域。

代码中的策略注册与 `checks/0003_parse_health_policy_matrix.sql` 都按上表的精确
`(source,mode,population_type,metric)` 白名单工作；新增 mode/population 在补充审计表
前只能留证。check 会阻止隐式分层、N<3、未审计组合或告警视图漏域进入 enabled 策略。

## run 1148 的 2% 单独归因

`2%` 是 50 个目标中 1 个目标（thread `18147645`）的完整性失败，不是 2% 帖子静默
丢行：该主题共 22 页，page 21 连续返回未替换的 `%%selector%%`，采集器保留了已解析
帖子但因分页不完整拒绝应用事实，并把任务留在重试队列。11:15 CST 定点复验仍得到同一
page 21 错误，证明它是可复现的单目标上游模板/响应异常；相邻普通批次 run 1612 为
50/50 成功。论坛批次上限 50，无法用它分辨 0.5% 阈值，因此该 population 的
`parse_drop_rate` 固定为 evidence-only，异常由目标级 partial/重试单独归因。

## 七类误报的统一判据

前七类分别是 population-sensitive 指标、基线初始化窗口、最小样本量、L1 分页时窗
漂移、无基线却使用绝对阈值、PGF01 自我放大级联、极小基线上的相对比值放大。

**可执行判据：只有当样本与基线同 source/mode/population、均未受初始化/冻结反馈污染、
历史窗口和本轮真实分母达标、稀有事件的坏事件数达到 5，并且指标对拟冻结域有直接因果
归属时，才允许自动冻结；任一条件不满足就只留证或告警。**

run 2699 的 `41×200 + 1×500` 因坏事件数为 1，不再产生 `relative_up`；即使未来同类
HTTP breach 由 500 请求中的 75 个非 2xx 触发，也只进入全局链路告警，不再冻结
content、vote、revision。数据域解析熔断仍由 `parse_drop_rate`、`selector_empty_rate`
等有直接归属的指标承担。
