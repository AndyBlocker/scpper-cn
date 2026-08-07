# FORUMIMG：论坛增量、讨论串关联、图片摄取与收敛修复

日期：2026-08-07（Asia/Shanghai）  
范围：v2 采集层、`scpper-v2` 的兼容迁移与只读核查。未修改 `/home/andyblocker/qqbot`，未发送 QQ 消息；v1 目录只作只读实现参考。

## 结论先行

- 论坛发现由“每天全量枚举 87k thread”拆成两层：每 5 分钟 1 次 `ForumStartModule` 全局信号；只有五元信号变化的分类才分页，并且只把 `post_count` 变化的 thread 投到 steady 深扫。首轮建水位实测只发 17 请求，没有全量枚举。
- 讨论串关联是 thread 消费的前置：先对 28,389 个冷启动缺口逐页取 `CommentsList` 的 verified thread id，再连接既有 551,942 条论坛帖并投 thread 深扫；消费器按 60% 关联、40% forum 配额，避免关联和稳态更新互相饿死。
- 当前 86,903 个 thread catchup 加 28,389 个关联缺口，按历史 2.26 attempts/thread、有效约 437.5 attempts/h 估算共 21.4 天，留 10% 重试余量约 **24 天**；约第 6.8 天先完成页—thread 关联。
- 图片链路已补 CLI、每分钟 timer、SKIP LOCKED worker、内容寻址资产与失败分类。79,088 引用中只有 66,236 个唯一 URL，预计首次下载约 21 小时，留 10% 约 **23 小时**。
- attributions 的 212 小时挂起已在活库完成：根因是 3,262 行源表中的 2 个手工坏行劫持整轮；现跳过零星坏行并留 warning，系统性坏行仍有阈值与终态路径。
- 原 36 个 `revisions_full` drift 分成 17 个已删页残留、13 个 L1 水位竞争、6 个不可改写事实冲突；17 个已在活库 resolved，其余由本次新的稳定终态路径收敛。

## 1. 迁移顺序与安全边界

涉及的结构先于代码在 `scpper-v2` 生效：

1. `0044_forum_incremental_and_image_worker.sql`：论坛 category 水位、catchup/steady lane、图片 worker 状态与待处理视图。
2. 并行 GATE 任务的 `0045`–`0050_finalize_adaptive_egress_policy.sql`：负责共享 gate 的恢复、分账和最终策略；本任务只复用该 gate，不另起或覆盖策略。
3. `0051_forum_pending_view_all_page_kinds.sql`：避开并行迁移编号，并让 `forum`/`discussion` 两种页任务都进入 catchup/steady 观测。

上述迁移均拒绝 v1 受保护库名。最终策略以并行任务的 `build-report-GATE.md` 和 `0050_finalize_adaptive_egress_policy.sql` 为准；新论坛的站内请求和站内图片请求都实例化同一个 `PostgresAdaptiveEgressGate`，没有旁路限速器。

## 2. 论坛增量发现

### 2.1 可用信号与选择

Wikidot 官方手册说明论坛以分类承载 thread，并通过 Forum 模块呈现分类和帖子；分类页天然按最近活动提供 thread 列表：[Wikidot Handbook — Forum Step By Step](https://handbook.wikidot.com/en%3Aforum-step-by-step)。实站匿名模块探测得到：

| 信号 | 单轮成本 | 能判断什么 | 本实现用途 |
|---|---:|---|---|
| `ForumStartModule` | **1 请求/全站** | 16 个分类各自的 thread 数、post 数、最后回复时间、最后 thread id、最后 post id | 五元组变化检测；不变分类零分页 |
| `ForumViewCategoryModule` | 1 请求/20 个 thread | 最近 thread 的 post 数、最后回复时间和置顶状态 | 只翻变化分类；到旧水位即停 |
| thread 深扫 | 历史约 2.26 attempts/thread | 完整帖子和缺席 tombstone | 只消费 `post_count` 变化的 thread |
| thread sitemap 全审计 | 每日一次 | 发现计数信号漏掉的新/删除 thread | 只作 05:23 安全网，不再承担 5 分钟增量 |

判据是分类五元组 `(thread_count, post_count, last_post_at, last_thread_id, last_post_id)` 任一变化才扫该分类；分类页上数据库 `ingest.forum_thread.post_count` 不同的 thread 才进 steady 深扫。普通 thread 的活动时间达到旧 `last_post_at` 即停止翻页；置顶行不参与停止判断，避免一个很老的置顶 thread 让扫描过早停止。`ForumStart` 与分类页计数若在抓取期间漂移，保留旧水位并下轮重试，不把不完整窗口推进成新水位。

### 2.2 成本和实测

冷启动实跑观察 16 个分类：`1 ForumStart + 16 个分类第一页 = 17` 请求，入 steady 136 个 thread；没有展开任一分类的全部历史页，也没有枚举 87k thread。该轮因 ForumStart 与一个分类页在 117 秒窗口内发生计数漂移而记 partial，旧水位被正确保留，HTTP 零失败。此后稳态典型成本是：

```text
每 5 分钟请求 = 1 + 变化分类所需的少量 20-row 页
深扫请求       = 只对 post_count 变化 thread，进入独立消费预算
```

调度改为：增量发现每 5 分钟、consumer 每轮结束 1 分钟后再起、每日 05:23 全量 sitemap 审计。增量发现单轮限制 40 个分类页/420 秒；consumer 限 50 目标/420 秒，站内相邻 attempt 至少 7.2 秒，即活跃时最高约 500 attempts/h。

### 2.3 一次性追平和稳态分开

`meta.forum_scan_task.lane` 明确存 `catchup`/`steady`：

- catchup：观察 pending 数量下降趋势；短窗内 oldest 不动不误报，但跨严重窗口头部仍不动会告警。
- steady：观察最老到期项年龄；新活动 thread 不应等待 catchup 清空。
- 页级讨论关联同样以 reason `forum_link_initial_catchup` 单独进入 catchup family；普通 `forum`/`discussion` 进入 steady family。

`checks/0003_oldest_pending.sql` 的 family 和 TypeScript 策略都已覆盖上述区别，回归包含“追平持续下降不误报”和“steady 超龄仍告警”。

## 3. 全站讨论串关联

### 3.1 依赖顺序

```text
live page 且 comment_count>0、thread id 缺失
    → CommentsList link-only（1 请求，验证 WIKIDOT.forumThreadId）
    → 写 page_current.discussion_thread_id
    → 将已有 ingest.forum_thread/forum_post 连接到页面
    → 投 thread 深扫，补齐关联后的新帖子
```

不能反过来：thread 队列即使把论坛帖子抓全，没有 verified thread id 仍无法回答“某页的评论”。因此 60% 的每轮名额先给页关联/评论，40% 留给 forum thread/category；任一侧不足时另一侧回填余量。

冷启动播种实测为 28,389 项。抽样 page 302 成功得到 thread 2152522，并立刻连接 12 条已有帖。交付核查时 36,405 个 live 页已有 380 个 thread id；28,765 个有评论页中仍有 28,388 个缺口，队列剩 28,387（本轮已完成一项）。数据库已有 551,942 条非删除 forum post、84,695 个 thread，关联不会复制这些帖子。

### 3.2 清空估算与共享预算

历史 50-thread 轮次给出约 2.26 HTTP attempts/thread。于是：

```text
关联：28,389 × 1                  =  28,389 attempts
thread：87,003 × 2.26             = 196,627 attempts
合计                              = 225,016 attempts
活跃限速                          = 500 attempts/h
420 秒运行 + 60 秒 inactive 有效率 = 7/8
运行有效吞吐                      = 437.5 attempts/h
225,016 / 437.5                  = 514.3 h = 21.4 天
加 10% 重试/漂移余量              ≈ 23.6 天（取整 24 天）
```

按 30 个关联 + 20 个 forum 的每 50 项配额，关联阶段约 946 轮、6.8 天；期间也会消费约 18.9k thread，之后继续 thread catchup。当前约 2,561 attempts/h 加 consumer 有效 437.5/h 约 2,999/h，即使按任务给定的 3,200/h 保守水位也有余量；真实全站总量仍由同一个 PostgreSQL gate 决定，不能靠该估算绕过降档。

## 4. 图片链路

### 4.1 引用、任务和资产是三层，不重复提取

- `serve.page_image` 是正文/源码提取出的“某页引用某 URL”，采集时零额外图片请求；它是引用事实。
- `meta.image_ingest_job` 是该引用尚未解析到资产时的工作状态；不是第二份引用模型。
- `serve.image_asset` 是下载后以 SHA-256 内容寻址的物理资产；不同 URL 内容相同会合并，同一 normalized URL 被多页引用时首个下载成功后其余引用直接复用、零出站。

交付时两张 pending 口径均为 79,088。它们包含 66,236 个唯一 normalized URL，12,852 个重复引用可直接复用；头部为 `scp-wiki.wdfiles.com` 21,308 refs/16,158 URL、`scpsandboxcn.wdfiles.com` 19,868/17,557、`scp-wiki-cn.wdfiles.com` 7,230/6,429。精确站点 host `scp-wiki-cn.wikidot.com` 只有 1 个 URL，其余包括所有 `wdfiles.com` 都按外站处理。

### 4.2 v1 复用与重写边界

只读参考了 v1 `PageVersionImageService.ts` 和实际 image-cache worker。复用的算法/运行约束：

- `FOR UPDATE SKIP LOCKED` 认领、陈旧锁回收、有限 attempts 和指数退避；
- host allow/block、私网 literal 拒绝、HTTP/content-type/大小校验；
- SHA-256、尺寸探测、内容寻址目录、临时文件原子 rename；
- permanent/transient/storage 等失败分类与引用状态回写。

重写的部分：

- v1 的 `PageVersionImage` 键改为 v2 `(page_id, normalized_url)`，hash 用 v2 `bytea`；
- 不再运行 v1 的正文图片提取，因为 v2 已有 `serve.page_image`；
- 增加跨页 normalized URL 资产复用与 hash 去重；
- 增加站内/外站两个 HTTP 统计面；本 foundation 不生成 v1 sharp 低清变体，那属于后续 serving 优化，不是建立原始资产的前置。

### 4.3 调度、流量和预计消化时间

新增 `image:ingest` CLI 与 `syncer2-image-ingest.timer`：每轮最多 500 项/420 秒，结束 1 分钟后再起，systemd 10 分钟硬超时。

- 精确站内 host：7.2 秒间隔，并接 `PostgresAdaptiveEgressGate(..., 'image')`；计入当前 Wikidot 全局滚动合同。
- wdfiles/其它图床：独立 1 req/s client，不接 Wikidot gate；外站 failure class、HTTP/health 摘要独立，失败不会抬高 Wikidot failure rate。
- 66,236 个唯一外站 URL 按 `1 req/s × 7/8 = 3,150/h`，首轮约 21.0 小时；加 10% redirect/retry 余量约 23 小时。重复引用在首个 URL 完成后只走数据库。

本次没有从开发 worktree 向生产库写入不可持久的磁盘路径，因此 79,088 队列仍待部署后消费。上线前必须把 `SYNCER2_IMAGE_ASSET_ROOT` 指到 worker 服务可写、可持久备份的生产卷；否则数据库会引用随 worktree 消失的文件。这是实际清积压的部署前置，不是代码/迁移缺口。

## 5. 自适应护栏退出语义

`evaluateAdaptiveSelfProtection()` 由持久 gate 快照和当前 policy 计算档位、原因、`recover_not_before` 和逐档完整恢复截止；阈值及健康窗是否在保持期内累计由并行 GATE 策略统一定义。work-queue 的规则是：

- 只有“零进展源于仍在预期恢复窗内的主动降档”时，正常 `exit 0`；摘要写 level/name/reason/recoverNotBefore/expectedRecoveryAt。
- 真 breaker、高失败、重复任务失败仍按原判据非零，不被护栏理由遮住。
- 当前时间超过预计完整恢复截止仍未升档，判 `downshift_overdue` 并 `exit 1`，说明恢复逻辑本身可能失效。

这给“局部异常拒绝整体”补上了收敛路径，也避免正确自保被 systemd 报成单元失败。回归覆盖预期窗口 exit 0、摘要字段和超期 exit 1。

## 6. attributions 212 小时挂起

根因不是出口：3,262 个社区手工表行中，`scp-cn-4022` 缺类型/时间，`pedialpha-super-crush-personnels` 缺时间。旧逻辑只要一行 rejected 就把整轮标 partial，虽声称防止 removal，但实际 `applyNewAttributionEntriesBySlug` 只新增、从不删除；任务每 24 小时重试，坏行永远存在，因此 212 小时无收敛。

现规则：`<=20` 个且 `<=1%` 的零星坏行跳过并写 warning，其余新增照常应用；超过任一阈值才是解析器系统性失效，仍 partial，并通过既有稳定 result hash 三次观测进入 irreconcilable，避免无限挂起。

活库验证：page 31549 的 run 16852 于 19:17:56 完成 `status=ok`、`fetched_total=24,144`、error null，`scan_task:attributions` 已为 0。此前四轮均是“1 条拒绝行” partial，证据与根因一致。

## 7. `revisions_full` 原 36 项逐项归因

### 7.1 17 个非 live 残留

旧 `resolveMissingDriftStates()` 只处理仍为 live 且已对齐的页；页面删除后 drift 既不再入深扫，也不会 resolved。新增 `resolveNonLiveDriftStates()` 对非 live 状态显式清零并写 resolved_at。以下 17 项均已于 `2026-08-07 19:14:09+08` 在活库收敛：

| page_id | slug | 旧 local → remote expected | 归因/状态 |
|---:|---|---:|---|
| 24,477 | `scp-cn-3732` | 7 → 2 | deleted 残留；已 resolved |
| 106,287 | `scp-l007` | 8 → 3 | deleted 残留；已 resolved |
| 106,785 | `experiment-log-914-cn:00066` | 8 → 4 | deleted 残留；已 resolved |
| 1,500,000,553 | `scp-cn-4905` | 0 → 6 | deleted 残留；已 resolved |
| 1,500,000,677 | `fragment:scp-cn-4885-1` | 3 → 4 | deleted 残留；已 resolved |
| 1,500,001,170 | `scp-cn-4860` | 1 → 10 | deleted 残留；已 resolved |
| 1,500,001,359 | `scp-cn-4295` | 0 → 4 | deleted 残留；已 resolved |
| 1,500,001,364 | `scp-cn-4946` | 0 → 7 | deleted 残留；已 resolved |
| 1,500,001,367 | `scp-l119` | 0 → 2 | deleted 残留；已 resolved |
| 1,500,001,509 | `scp-7268` | 0 → 3 | deleted 残留；已 resolved |
| 1,500,001,511 | `icelynelar` | 0 → 6 | deleted 残留；已 resolved |
| 1,500,001,539 | `critter-profile-neil-neverdecadent` | 0 → 3 | deleted 残留；已 resolved |
| 1,500,001,700 | `wanderers:luniubandechuntian` | 3 → 4 | deleted 残留；已 resolved |
| 1,500,002,102 | `scp-cn-4893` | 0 → 1 | deleted 旧身份；已 resolved |
| 1,500,002,105 | `scp-cn-4893` | 6 → 9 | deleted successor/slug 复用残留；已 resolved |
| 1,500,002,208 | `wanderers:beyonder` | 0 → 2 | deleted 旧身份；已 resolved |
| 1,500,002,356 | `wanderers:beyonder` | 11 → 1 | deleted successor/slug 复用残留；已 resolved |

### 7.2 13 个 L1 水位竞争

旧 claim SQL 从任意旧 `meta.page_scan` 取 `claimed_total`，而不是取 `incremental_page_state.last_l1_revision/last_l1_run_id`；L1 已前进时，深扫仍拿旧值 0，抓到 2/3/10 行便永远 partial。新 claim 使用当前 L1 水位；handler 响应后再次检查 L1 是否前进，若前进则不写稳定 hash、用新水位重试。若水位稳定但 apply 仍 partial/quarantine/count mismatch，则保留稳定 hash，三次进入 irreconcilable，而不是成功删除后由 L1 无限重建。

| page_id | slug | 最近证据 | 归因/收敛路径 |
|---:|---|---|---|
| 1,500,001,220 | `scp-9910` | 旧 claimed 0，抓 2 | L1 竞争；新水位重试 |
| 1,500,001,227 | `nobody-came-to-the-funeral` | 0 → 3 | L1 竞争；新水位重试 |
| 1,500,001,235 | `fragment:c14-loupiote-1` | 0 → 3 | L1 竞争；新水位重试 |
| 1,500,001,236 | `fragment:c14-loupiote-0` | 0 → 3 | L1 竞争；新水位重试 |
| 1,500,001,237 | `scp-818-fr` | 0 → 2 | L1 竞争；新水位重试 |
| 1,500,001,242 | `scp-2174-jp` | 0 → 2 | L1 竞争；新水位重试 |
| 1,500,001,340 | `scp-1955-jp` | 0 → 2 | L1 竞争；新水位重试 |
| 1,500,001,345 | `kisoutengoku-2025-vol07` | 0 → 2 | L1 竞争；新水位重试 |
| 1,500,001,356 | `scp-pl-207` | 0 → 2 | L1 竞争；新水位重试 |
| 1,500,001,360 | `scp-7217` | 0 → 3 | L1 竞争；新水位重试 |
| 1,500,001,361 | `log-of-anomalous-items-cn:01877` | 0 → 2 | L1 竞争；新水位重试 |
| 1,500,001,696 | `the-slap-from-death-to-llife` | 0 → 10 | L1 竞争；新水位重试 |
| 1,500,001,893 | `pissweed` | 0 → 3 | L1 竞争；新水位重试 |

### 7.3 6 个不可改写事实冲突

这些页深扫本身成功，但 `apply_revision_batch` 发现 `wikidot_revision_id` 已绑定其它 page，或同一修订在来源间 type 冲突。事实表不可变，不能为了让计数相等覆盖历史；旧 worker 却把 apply partial 当成功，删任务后 L1 再入队，形成循环。新 worker 把 apply 结果纳入 outcome 并以稳定 hash 收敛到 irreconcilable。

| page_id | slug | local → remote expected | quarantine 证据 | 终态 |
|---:|---|---:|---|---|
| 25,849 | `search:crom` | 14 → 1 | 189 条 `type_conflict_across_sources` | 稳定冲突进 irreconcilable |
| 25,851 | `search:site` | 0 → 13 | 8,138 `wid_bound_to_other_page` + 3,320 type conflict | 同上 |
| 33,249 | `alt:scp9000contesthub` | 6 → 9 | 1,332 wid bound + 584 type conflict | 同上 |
| 104,074 | `ankv` | 313 → 320 | 4,242 wid bound + 56,970 type conflict | 同上 |
| 104,093 | `free-bird` | 2 → 5 | 1,290 wid bound + 718 type conflict | 同上 |
| 104,142 | `in-the-land-of-dread-alagadda` | 1 → 4 | 1,245 wid bound + 216 type conflict | 同上 |

当前按“未 resolved 且首次发现超过 7 天”查询仍有上述 6 项，符合代码尚未部署消费其新终态路径的现状；不是未归因的未知 drift。

## 8. `irreconcilable:files`

按用户“附件延后”决定未改任何 files 处理逻辑。交付只读核查显示当前 open 43（用户给定 cohort 为 28，期间旧证据重新显现），近 24 小时新增仍为 0，最早 `2026-07-27 20:34:56+08`；趋势稳定，没有本轮处理需求。

## 9. 回归与交付状态

| 验证 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过 |
| 新增专项：论坛少数变化、28,389 关联、图片 gate/外站隔离、drift、观测、调度、护栏退出 | 65/65 通过 |
| T7 安全水位首跑并发失败后的独立重跑 | 32/32 断言通过，测试进程 5/5 通过 |
| attributions 坏行策略 | 生产形态 2/3262 通过；系统性阈值回归通过；活库任务已完成 |
| 全量 `npm test` 首跑 | 441/446；T7 被并行摄取持锁，独立重跑已绿；projector 命中活库既有一票差 |
| projector 独立重跑 | 第一次 10/11，user 37715 恰逢事实 1348/上一轮曲线 1347；19:41 正常生产 projector 追平后再次重跑 **11/11**，确认是活库时窗，未改断言 |

首轮全量的全部失败套件均已独立重跑全绿，符合活库偶发依赖的既定处理方式。图片实际清积压另有生产持久卷 `SYNCER2_IMAGE_ASSET_ROOT` 的部署前置；除此之外无代码、schema 或测试阻塞。未 commit、未 push。
