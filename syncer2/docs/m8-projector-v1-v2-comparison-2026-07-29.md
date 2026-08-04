# M8 projector 接线、全量构建与 v1 UserStats 对账报告

验收时间：2026-07-29 12:38（Asia/Shanghai）

数据快照：v1 `scpper-cn` 与 v2 `scpper-v2` 均使用 `REPEATABLE READ READ ONLY` 对账事务

结论：projector 已完成首次全量并追平安全水位；B2/B4 全量自洽；v1 隐含分类规则已复刻。逐字段数值并非完全相等，剩余差异均可归到事实/署名源差异、v1 已确认的均值 URL 缺陷、精度或排名下游传播。

## 1. 运行与调度

- 新增 `deploy/systemd/syncer2-project.timer`：每 10 分钟的 `:04/:14/...` 启动，与 L0/L1/L2/maintenance 错峰。
- 复用 `syncer2-job@.service` 的 `Type=oneshot`，实例 drop-in 把 `TimeoutStartSec` 设为 8 分钟；没有 `Restart`，也没有 `restart_delay`。
- `schedule:project` 显式传 `--exclude-deleted-pages`，因此 B2 固定为作者排行不纳入已删作品，不受环境变量误配影响。
- 首次全量使用 `project:catch-up`：启动时固定安全水位，按每段 250,000 seq、段间 3 秒、`nice=15`、idle I/O 调度运行；每段提交即形成断点，不使用破坏性重建。
- 初次目标水位 `3,148,719`，共 82 个事务批次，耗时 667.6 秒；后续增量最终追到 `3,225,772`。十个 M8 游标均等于该安全水位。
- 最终主要行数：`user_stats=42,437`、`user_page=38,502`、`page_stats=42,716`、`vote_daily=672,323`。

本工作机没有生产部署使用的 `/srv/scpper`、`/etc/scpper` 和已安装的 syncer2 systemd units，因此只提交了可部署 unit，未在错误路径上执行 `systemctl enable`。生产部署安装 units 后应执行 daemon-reload 与 `enable --now syncer2-project.timer`。

## 2. 对账范围与白名单

| 项目 | 数量 |
|---|---:|
| v1 / v2 UserStats | 37,502 / 42,437 |
| 共同用户 | 37,482 |
| v1-only / v2-only 用户 | 20 / 4,955 |
| 共同页面 | 47,880 |
| v1-only / v2-only 页面 | 17 / 15 |
| 当前删除状态白名单 | 2 页：`102423`、`105452`；影响 2 位用户 |

历史验收材料记录过 45 个 `Page.isDeleted` 与当前版本 `isDeleted` 发散页；本次快照中 v1 内部发散已为 0，v1/v2 当前状态只剩上述 2 页。因此本报告不把已经不存在的 45 页继续当宽泛白名单。

## 3. v1 SQL 业务规则复刻

在 36,064 个共同、当前有效且不在状态白名单的页面上：

- 「段落」页 2,662 个，均被排除出 `overall_rating` 均值分母。
- 无标签前缀例外 1,574 个；按 URL 归一为 slug 后，v2 与 v1 的**预期规则**差异为 0。
- v1 存量 SQL 直接对完整 `currentUrl` 使用 `LIKE 'prefix:%'`，实际漏掉上述 1,574 页；这是 v1 已存数据的缺陷，不应让 v2 复刻。
- `原创+scp`、翻译、`原创+goi格式`、`原创+故事`、`原创+wanderers`、`原创+艺术作品` 六类判定逐页差异均为 0。
- `total_rating` 是所有 B2 现存作品总分；`overall_rating` 是经过「段落」和无标签例外过滤后的均值。下表始终分列比较，没有混用两套口径。

## 4. UserStats 逐字段结果

共同用户数均为 37,482；“差异数”使用整数严格相等、`overall_rating` 容差 0.0001。

| v2 字段 | 差异数 | 归因 |
|---|---:|---|
| `votes_received_up` | 2,793 | 当前票事实 + v1/v2 署名集合 + B2 页面集合 |
| `votes_received_down` | 3,343 | 同上 |
| `total_rating` | 426 | 页面当前 rating、署名集合及 2 页状态白名单；不是均值口径 |
| `votes_cast_up` | 1,483 | v1/v2 当前票事实集合差异 |
| `votes_cast_down` | 576 | 同上 |
| `rating_scp` | 194 | 分类规则零差异；来自页面 rating/署名源 |
| `count_scp` | 2 | 页面/署名源，不是分类 SQL |
| `rank_scp` | 600 | `rating_scp` 与候选集合差异的下游传播 |
| `rating_translation` | 68 | 分类规则零差异；来自页面 rating/署名源 |
| `count_translation` | 11 | 页面/署名源 |
| `rank_translation` | 337 | 上述评分与候选集合的下游传播 |
| `rating_goi` | 16 | 分类规则零差异；来自页面 rating 源 |
| `count_goi` | 0 | 完全一致 |
| `rank_goi` | 14 | 评分差异的下游传播 |
| `rating_story` | 137 | 分类规则零差异；来自页面 rating/署名源 |
| `count_story` | 3 | 页面/署名源，其中状态白名单影响 1 位 |
| `rank_story` | 732 | 上述评分与候选集合的下游传播 |
| `rating_wanderers` | 34 | 分类规则零差异；来自页面 rating 源 |
| `count_wanderers` | 0 | 完全一致 |
| `rank_wanderers` | 86 | 评分差异的下游传播 |
| `rating_art` | 13 | 分类规则零差异；来自页面 rating/署名源 |
| `count_art` | 1 | 页面/署名源 |
| `rank_art` | 115 | 评分与候选集合的下游传播 |
| `page_count` | 29 | v1/v2 页面归属集合 + 2 页状态白名单 |
| `rank_total` | 1,855 | `total_rating` 与榜单候选集合的下游传播 |
| `overall_rating` | 1,373 | v1 两位小数精度、1,574 页 URL 前缀缺陷，以及页面 rating/署名源；与 `total_rating` 分开比较 |

支撑归因的源层证据：

- 共同活页中当前 rating 不同 641 页；tags 数组不同 7,187 页，但六类业务判定差异为 0，说明 hidden-tag 合并等结构差异没有改变分类语义。
- v1/v2 作品归属对称差为 v1-only 23 对、v2-only 2,546 对；v2 额外保留了匿名署名 actor，不能映射成 v1 `UserStats.userId`。
- v1 当前票汇总为 up 1,144,240 / down 184,863 / zero 2,832；v2 为 up 1,143,523 / down 184,769 / zero 4,592。投票字段差异来自当前事实层，不是把 event 数误当状态数。
- v1 `overallRating` 为两位小数；将 v2 均值四舍五入到两位后，36,645 位共同用户相等，余下 837 位由无标签例外缺陷及上述源层差异解释。
- 全量后发现匿名 actor 曾进入榜单；现已把 rank 候选限定为 `wikidot_id IS NOT NULL`。最终“无 wikidot_id 但有任一 rank”的行数为 0。

## 5. B2/B4 自洽与验证

- `includeDeletedPages=false` 已在定时入口、首次全量入口和最终运行摘要三处确认。
- `consistency.ts` 的全量核验覆盖 4,407 位有已删作品作者，`cum_rating` 曲线末值不等于 `user_stats.total_rating` 的人数为 0。
- 保留每轮 64 位稳定历史样本，并新增“本轮新删除作者”定向样本，避免全局样本过大时漏过刚发生的删除。
- `npm test`：293/293；projector 专项：10/10；migration smoke：304/304；`checks/run_checks.sh`：全部通过；TypeScript 源码与测试类型检查均通过。
- systemd calendar/units 经 `systemd-analyze calendar` 与 `systemd-analyze verify` 通过；最终 active write freeze 域为 0。

## 6. 可复现入口

- 常规增量：`npm run schedule:project`
- 限速断点全量：`npm run project:catch-up -- --batch-seq 250000 --delay-ms 3000`
- v1/v2 只读逐字段对账：`npm run project:compare-v1`

对账工具不会打印连接串，两个数据库连接均开启只读可重复读事务；本次没有写 `scpper-cn`，没有发送 QQ 消息，也没有接触 qqbot 仓库。
