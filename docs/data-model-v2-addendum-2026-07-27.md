# v2 数据模型与采集层设计 —— 修订附录（2026-07-27）

> **本文是 `docs/data-model-v2-redesign-2026-07-03.md` 的修订附录，不是替代品。**
>
> 为什么用附录而不是改原文：
> 1. `/home/andyblocker/scpper-cn/docs/` 是受保护的生产 checkout，只读；
> 2. 即便在 worktree 里能改，原文档也是 2026-07-03 的**决策快照**，被后续实测推翻的
>    结论本身有追溯价值 —— 直接改掉会让"当时为什么那么想"永久丢失。
>
> **阅读规则：本附录与原文档冲突时，以本附录为准。** 原文档未被本附录点名的部分继续有效。

- 证据基础：
  - `/home/andyblocker/qqbot/analysis/wikidot-vs-crom-2026-07-27/synthesis.md`（R1–R15 修订清单、D1–D10 决策、P0/P1/P2 排序）
  - `syncer2/experiments/sitemap-probe.md`（sitemap 通道 2 小时实测，约 90 个请求）
  - `syncer2/migrations/` + `smoke_test.sql`（249 断言，已在真实 `scpper-v2` 跑通）
- 所有标 **【实测】** 的都是本轮或前轮亲自跑通的验证，不是推断。

---

## 目录

- §1 被实测直接推翻的结论（sitemap 三条 —— 最高优先，影响架构分工）
- §2 R1–R15 修订清单里与采集层相关的条目（逐条 + 在 syncer2 里的落地状态）
- §3 六个 blocker（原文档 §5.6 前置条件）与 Phase 0 增补六项
- §4「wikidot 直连作为唯一常驻源」：这个决策的理由、代价与本附录的立场
- §5 分域权威表与触发矩阵（对原文档 §5.8 / §9.6 的修订）
- §6 仍然悬空的决策（点名清单）

---

## §1 被实测直接推翻的结论

这三条都出自 `sitemap.xml` 全族的实测。它们的共同后果是：**sitemap 在架构里的位置要从
"发现层主通道"改成"枚举完整性 / absence 基准 / 第二独立源"**。

### 1.1 sitemap 不是快通道 —— TTL ≈ 60 分钟，且压不下去

| 原表述（synthesis §2.1 / §5 L0-A） | 修订后 |
|---|---|
| "刷新周期未测（只证明了 stale ≤ 8h）"；L0-A `sitemap_page_1` **每 10 分钟**轮询 | **sitemap 是整文件、惰性、按 TTL 重生成，不是 per-page 增量。TTL ∈ [59.6, 73.8] 分钟，几乎确定是 60 分钟整。轮询周期改 20 分钟。** |

**【实测】证据链（三段互补）**：

1. **字节级同一性**：同一份 `sitemap_page_1` 在 **18 次抓取、跨 57.2 分钟**内 md5
   **完全相同**（`440ca5b44700fe9d753ba302b3415f72`，08:38:08Z – 09:35:19Z）。
   ⇒ 10 分钟轮询里 **≥5/6 次拿到的是同一份字节**，纯浪费。
2. **抓到了换版瞬间**：`regen` 每 240 秒探一次 md5，09:37:41 仍是旧版、**09:41:43 换新版**。
   新版最大 `lastmod` = 09:41:27，**只比我发出请求早 16 秒**
   ⇒ **重算本身是实时的，整个滞后 100% 来自 TTL**（缓存过期后由第一个请求触发重算）。
3. **11 个编辑探针，14 轮 42 分钟内 sitemap 反映了 0 个**。对照 `ListPages
   order=updated_at desc` 的滞后是 **48 秒 – >13 分钟**（同样有缓存、同样不稳定，
   观测到 18.3 分钟的陈旧平台期，且**换 `perPage` 参数做 nonce 无法绕过缓存**）。

**压不下去的证据**：`cache-control: no-cache, must-revalidate`、**无 ETag、无 Last-Modified**、
`x-wikidot-static-cache` **连续 3 次 GET 恒为 MISS**（说明每次都真打到后端，滞后来自
wikidot 自己的物化层）⇒ 条件 GET 与缓存旁路都不可用。

**滞后不累积**：跨 56 分钟的两份快照，`lastmod` 变化的页**恰好 3 个**，与同期 ListPages
报告的编辑**逐条相同（零漏零多）**。所以 sitemap 是**最终一致**的，只是"最终"要等下一次重生成。

**落地约束（syncer2 已实现或已记 TODO）**：
- 轮询 `sitemap_page_1` 周期 **20 min**（不是 10 min）；全量 4 文件 **6 h**。
- **必须用 md5 短路解析**：与上轮相同直接跳过 XML 解析与 diff（省 CPU，不省带宽），
  且**不要因为"这一轮没变化"就触发任何 absence 逻辑**。
- absence 判删要求"连续 ≥2 轮全量 sitemap 缺席"，则**两轮的间隔必须 > 1 个 TTL
  （建议 ≥2 h）** —— 否则两轮读到的是同一份文件，等于只看了一轮。这是个很容易写错、
  且错了之后表现为"幻影删除"的坑。

### 1.2 sitemap 不按 `lastmod` 降序 ⇒ **禁止 lastmod 阈值早停**

| 原表述（synthesis §2.1） | 修订后 |
|---|---|
| "近似按 `lastmod` 降序全局排列 → `sitemap_page_1` ≈ 最近 3.7 个月内被修改的全部页面" | **排序键不是 `lastmod`，是"最后一次活动 = 编辑 ∨ 投票 ∨ 评论"。`page_1` 内 39.1% 降序违例，`lastmod` 最老到 2014-02-24。** |

**【实测】**：`sitemap_page_1`（10,000 条）有 **3,907 / 9,999 = 39.1%** 处降序违例；
与"严格 lastmod 降序"的名次位移 |Δ| **中位数 2,666**、p90 5,395、max 9,381，
位移 ≤10 的只占 **0.4%**。第 2/3/4 名就已经是 2023-06 / 2023-09 / 2024-08 的老页。
**在 09:41:43 重生成后的新版本上完全复现**（违例 3,908/9,999，|Δ| 中位数 2,658）
⇒ 这是稳定的结构特征，不是一次抓取的偶然。

**排序键的真实身份已交叉证明**：用 v1 库补上每页末次投票/末次评论，令
`K = max(lastmod, 末次投票, 末次评论)`，则 `page_1` 按名次十分位的 **K 中位数完全单调下降**
（`2026-07-24 → 2026-04-09`）。另外 3,907 处违例中 **3,836 处（98.2%）** 可由
"前一条页面有更新的投票/评论活动"解释；56 分钟内新进入 `page_1` 的 3 个 slug
（`aiad`/`jhor-and-ash`/`scp-4485`）全部落在第 2/3/4 名，而它们的 `lastmod` 是 2023–2024 年
—— 只有"被投票/评论触发重编译"能解释。

**操作后果（硬约束）**：

1. **禁止"读到某个 `lastmod` 阈值就停止翻页"的增量策略。** 排序不可信，早停必漏。
   必须**整文件解析**。
2. **"`page_1` 最后一条的 `lastmod` 是覆盖下界"这个说法是错的**（实测最后一条是
   2026-04-04，但同文件内存在 2014-02-24 的条目，`page_2` 里又存在 2026-04-05 的条目）。
   正确的覆盖下界是 **`B = max(lastmod over page_2..4)`**，实测 `B = 2026-04-05 04:18:29`。
3. `B` 的可信度**已被独立交叉验证为零漏**：`lastmod > B` 的 4,347 条 **100%** 落在 `page_1`；
   且 ListPages `updated_at="last 113 days"` 的 `%%total%%` = **4,269**，与 sitemap 同一切点的
   计数 **4,269 逐个吻合**。
4. `B` 必须靠**周期性抓全量 4 文件重算**来监控 —— `page_1` 的 10,000 槽位里只有 4,347（43%）
   是"近 113 天有编辑"的，另外 5,653（57%）是被投票/评论顶上来的老页。余量充足，
   但一旦 `B` 向今天逼近就说明窗口在收缩。
5. **副产品是个礼物**：`page_1` 的成员变动本身就是一个弱的"有人投票/评论了这个页"信号，
   可作 `LatestVote` / 论坛哨兵的零成本补充触发器。

### 1.3 sitemap 不能做十分钟级新页发现 ⇒ 发现层归 ListPages

| 原表述（synthesis §D2 选项 C / §5 L0） | 修订后 |
|---|---|
| "sitemap 主 + ListPages 供票据信号 + SiteChanges 可选"，sitemap 承担**内容/存在性变更发现** | **分工按"延迟"重切：发现层（编辑 + 新页）交给 `ListPages order=updated_at desc` 与 `order=created_at desc`（各 1 请求）；sitemap 降为枚举完整性 / absence 基准 / 第二独立源。** |

**【实测】决定性反例** —— `scp-743-jp`：

| 事实 | 时刻 |
|---|---|
| 创建 / 首版 | **08:57:12** / 08:57:22 |
| 创建后 **2.4 分钟**抓的**全量 4 个** sitemap | **4 个文件里都不存在** |
| 创建后 **38.1 分钟**的 `sitemap_page_1` | **仍不存在** |
| 首次出现 | **09:41:43 那次重生成**，即创建后 **≥ 44.5 分钟** |
| 而 ListPages 报出它 | **13.5 分钟内**（r5 @09:10:54，窗口 10.5–13.5 min） |

第二例 `scp-cn-4960`（09:30:30 创建）同样只在同一次重生成里出现 ⇒ **新页与编辑走完全相同的
整文件重生成路径，没有新页快通道**。

> 顺带修正前一轮的乐观结论：那批"最近创建 50 页在 sitemap 里 50/50 命中"的样本，
> **最年轻者已有 73.9 分钟页龄**。它只能证明"最终一定进得去"，不能用来论证发现延迟。
> `life1` 给出的 ≤17.7 分钟是"恰好赶上一次重生成"的幸运上界，**不是典型值**。

**sitemap 的固有盲点（无法靠调周期解决）**：
- sitemap 只有 `lastmod`、**没有 `created_at`** ⇒ 只能回答"这个 slug 我没见过"，
  **无法区分"新建"与"改名后的旧页"**。改名在 sitemap 视角下 = "一个 slug 消失 + 一个 slug 出现"，
  与"删除 + 新建"**不可区分**。必须由 `ListPages %%page_id%% / %%created_by_id%%` 在
  pageId 层面复核收口。
- `%%rating%%` / `%%rating_votes%%` / `%%tags%%` / `%%_tags%%` **完全不在 sitemap 里**
  ⇒ 评分与投票信号仍必须由 ListPages 全量承担。**本附录不改变这一点。**

**sitemap 保留下来的四项价值（都仍然成立）**：
1. **枚举完整性**：35,983 slug / 4 请求 / gzip 620 KB / ~5 s，且**枚举域在 78 分钟内逐条完全一致**
   （两次全量快照唯一 slug 数 35,983 = 35,983，新增 0、消失 0）⇒ 可放心作 absence 基准。
2. **对修订洪水结构性免疫**：一个页面刷 5,000 次版，在 sitemap 里永远只占 1 个 entry
   （近 180 天单小时峰值 6,966 条修订仅涉及 15 个页面 —— 这正是"SiteChanges 不能作唯一
   发现通道"的原因，而 sitemap 天然不受影响）。
3. **第二独立枚举源**：让 absence / 删除推断第一次有了交叉证据（此前只能自己和自己的上一轮比）。
4. **无分页竞态**：一次性快照，不存在 ListPages 145 批跨 430 秒的翻页竞态。

### 1.4 枚举域差异已精确算平（关闭一个未决项，同时新增一条 absence 硬排除）

```
ListPages category=*                            %%total%% = 36173
  − deleted:            66
  − forum:               6
  − adult:             133      ┐ 新发现
  − wanderers-adult:     5      ┘
  = 35963   ← 实测 category="* -deleted -forum -adult -wanderers-adult" 的 %%total%% 正是 35963 ✅
  + 「页名以 _ 开头」的隐藏页 20（ListPages 默认不返回，sitemap 会列）
  = 35983   ← 实测 sitemap 4 文件唯一 slug 数 10000+10000+10000+5983 = 35983 ✅
```

**误差为 0。** 对原表述的两处修正：
- 原 "库有 sitemap 无 = 74（`deleted:` 65 + `forum:` 6 + test 3）→ 100% 可解释"
  → **排除项还有 `adult:`(133) + `wanderers-adult:`(5)**；
- 原 "15 个 forum category" → **14 个**（原计数把站点根 URL 数进去了）；库内 16，
  差的是 `882986 翻译预定区（归档）` 与 `2020429 垃圾桶`（两者都被站方隐藏，
  thread sitemap 对它们**100% 失明**，只能靠论坛分页爬）。

**⇒ absence 规则的硬约束**：`deleted:` / `forum:` / `adult:` / `wanderers-adult:`
**四个分类必须硬排除在 sitemap-absence 之外**（否则那 138 个 adult 页会被连续判"不存在"
进而误判删除），它们的存在性只能由 ListPages 负责。另外**建议在枚举归一层过滤
`^(?:[^:]+:)?_` 的 slug**，否则每轮对账都会报 20 条假差异。

**注意一个反直觉点**：`old:`（554 个归档页）**在 sitemap 里**，只有 `deleted:` 不在
⇒ "移入 `old:` 归档"这种软删除**不能**靠 sitemap absence 检测，只有"移入 `deleted:`"可以。

---

## §2 R1–R15 修订清单 —— 与采集层相关的条目

下表把 synthesis §4.2 的 R1–R15 逐条落到 syncer2，并标注当前状态。
**状态口径**：✅ 已在代码/DDL 里落地并有断言；🔶 已落地但未验证；⛔ 未开始。

| # | 修订 | 替代的原方案 | 采集层影响 | 状态 |
|---|---|---|---|---|
| **R1** | 建立**逐字段权威表**：每字段声明 `authority ∈ {crom, wikidot, both(先到先得), derived}`，写进 `meta.v2_baseline`；对账只在 `authority=both` 的字段上做 | "CROM 降为抽样 oracle" | 采集层写入前要能查到"这个字段我有没有权威"，否则会用低权威源覆盖高权威值 | ⛔ `meta.v2_baseline` 表已建，**权威表内容未填** |
| **R2** | **撤票**：仅 `source='crom'` 的 `direction=0` 产生 `kind='revoke'`；wikidot absence 只写 `meta.revoke_candidate` 待确认 | 四重门控直接产 revoke | 直接决定 `apply_vote_snapshot` 的门控出口 | ✅ 四门全过也**只写候选不写事实**；`promote_revoke_candidates` 单独转正；smoke S3/S3★ 共 40 断言 |
| **R3** | **发现层换通道**：sitemap 为主，SiteChanges 降为可选 | SiteChanges 为"秒级发现唯一通道" | —— | ⚠️ **本附录 §1.3 进一步修订 R3**：sitemap 也不做发现层，**发现层归 ListPages**，sitemap 只做枚举/absence/第二源 |
| **R4** | Tier1 ListPages **收窄职责**为"评分/投票信号采集"，并发 4–5 路（430 s→78 s）；不再承担内容变更发现与 absence 基准 | Tier1 承担全部三项职责 | —— | ⚠️ **本附录 §1.3 部分推翻**：ListPages **要重新承担发现层**（`order=updated_at/created_at desc` 各 1 请求 @3 min，与"全站 145 批"是两个不同的任务，不冲突）；absence 基准仍交 sitemap |
| **R5** | **Phase 0 增补 6 项**（见 §3.2） | 原 Phase 0 只有 4 项 | 见 §3.2 | 部分 ✅ |
| **R6** | **已删页策略**：`status='deleted'` 且从未有过完整快照的页，`scan_task` **直接终止**（不重试、不进 irreconcilable，避免 9.8k 级永久 partial 噪声）；新增 `serve.page_current.last_complete_vote_snapshot_at`，删除时冻结 | 无 | 队列语义 | 🔶 DDL 已有该列；`scan_task` 终止分支未接 |
| **R7** | **新页高频队列**：`first_published_at > now()-7d` 的页不进 sweep，改 2–4 h 一次 `votes_full` + `content`，最高优先级（实测 ~7.4 页/天删除、队列常驻 ≈50 页，成本可忽略）；"新页发布→首次完整快照延迟"做成 SLI，目标 <6 h | sweep 7–14 天轮转兜底 | 调度 | ⛔ |
| **R8** | **sweep 重定向**：从"全站 34,069 页 14 天轮转"改为"近 90 天有过投票活动的页（≈20k）优先 + 其余低频"。【实测】30 天内只有 **7,263 页**有投票变化（全站 20%），每天 **485** 页；全站无差别轮转把 78% 预算花在结构上不可能有变化的页面上 | 全站无差别轮转 | 调度 | ⛔ |
| **R9** | **门控算术修正**：run 级失败判据从"任一批失败"改为"批级重试 ≥3 次耗尽"+ `pages_enumerated / remote_total ≥ 0.98`；断路器 N 按 **2.3% 实测传输失败率**标定（N=5）。原判据代入 145 批 ⇒ **96.6% 的 Tier1 轮次会自判死亡**，删除推断永远拿不到授权 | "任一批失败即整轮 failed" | run 级门控 | 🔶 `remote_total` 双源（`%%total%%` + sitemap 计数）与 run 级 gate 已在 DDL/函数里；批级重试计数未接 |
| **R10** | **新增全局解析健康熔断**：每轮记录分布指纹（revision type 分布、tags 平均长度、attribution 行数、每页平均票数、source 平均长度、HTTP 状态码分桶、出口 IP 分布、传输失败率），与前 7 日基线比，任一偏移超阈即**冻结写入**（不冻结采集）。逐页校验和抓不住相关性漂移，这个能。上线 gate：必须在一次**人为注入的解析故障演练**中成功阻断写入 | 只有逐页 `is_complete` | 全局熔断 | 🔶 `meta.parse_health_baseline`（基线 + 阈值 + 越界留痕）已建，**"冻结写入"的物理开关仍缺位**（见 §6） |
| **R11** | **存量 attribution 不重解析**：用 v1 的 `pageVerId → PageVersion.pageId` 映射结转，绕开 by-slug；只有新解析行走 by-slug，且目标 slug 有 ≥2 个 Page 行时要求 `date` 落在候选页生命周期内，多候选即拒绝。理由：3,334 个 slug 被 10,062 个 Page 行接力占用（最深 21 层） | by-slug 裁决无差别应用 | Phase 2 回填 | ⛔（Phase 2） |
| **R12** | **`username` 不覆盖**：直连真实 unixName 写新列 `wikidot_unix_name`，v1 的伪造 `username` 原样迁移并标 legacy。理由：35,722 非空 username 里 **32,808（91.8%）** 是 `UserDataCompletenessJob` 凭空捏造的 `lower(replace(displayName,' ','_'))`，下游正在依赖其格式 | "直连补齐 username 是净增益" | 身份层 | ✅ `ensure_user` 只补不覆盖 + 真实 unixName 另存 `wikidot_unix_name`；smoke S1 有专项断言 |
| **R13** | **逐版本源码**从 Phase 2 移出，改按需 + `PageDiffModule`。理由：347,686 个可回填 revision × 实测均值 88.6 KB = **30.8 GB**，是整个冷启动的 **7 倍**，且 18.5% 属已删页远端永远补不回 | 批量回填 | 流量预算 | ⛔（决策已定，未实现） |
| **R14** | **取消**对 content/revisions 类 Tier2 的强制整页 GET 交叉校验（这些模块对错误 page_id 返 `no_page`，是干净失败）；把 page_id 校验收窄到投票域（`WhoRatedPageModule` 对错误 id 返 `ok`+空列表，是唯一需要防的） | 全 Tier2 强制整页 GET | 省每页 258–430 ms | ⛔（未接 Tier2） |
| **R15** | **排期现实化**：拆"必做三项 + 观察 + 其余"，parity 报表**必须推 QQ 群** | 10–14 周连续推进 | 流程 | ⛔ |

**与采集层强相关的还有三条不在 R 编号里的实测结论，一并记在这里：**

- **P0-8 `PageRevisionListModule` 确实分页**：不传 `perpage` 只返回 **1 行**（不是全部、也不是 20）。
  `perpage=3/20/1e8 → 3/20/153 行`。revision 是本次迁移里唯一号称"完全不降级"的时间轴，
  重写时把这个参数"简化掉" = 静默截断成 1 条。
  ⇒ 页级门控必须**显式传 `perpage`，并检测响应里 `class="pager"` 的存在，出现即判 `failed`**。
  **状态 ✅**：`apply_revision_batch` 有"漏传 perpage 判 failed"的断言。
- **P1-6 ListPages selector 契约**：**无效 selector 静默保留字面量**（`%%%%rating_percent%%%%`、
  `%%page_id%%` 原样返回），字段数与分隔符数不变 ⇒ `parts.length` 校验发现不了，
  一个拼写错就得到一列恒定垃圾且全链路静默。
  ⇒ 批级门控：**任一字段仍匹配 `^%%%%.+%%%%$` ⇒ 该批 `failed`，不做任何 diff**。
  **状态 ✅**：`apply_page_meta` 有"selector 字面量残留整批拒绝"的断言。
  同时发现三个此前未用的**有效** selector：`%%created_by_id%%`（数字 id，比解析 printuser HTML 干净）、
  `%%created_by_unix%%`（真实 unixName）、`%%total%%`（**36,173，精确总数**，关闭 remote_total 未决项）、
  `%%index%%`（跨批连续性校验）。
- **`parts.length` 不匹配的丢行必须计数**（现状是静默 `continue`，而丢行 ≡ `deleted_page`
  ≡ 主库 `isDeleted=true`），丢行率 >0.5% ⇒ 整轮 `failed`。

---

## §3 六个 blocker 与 Phase 0 增补六项

### 3.1 六个 blocker（原文档 §5.6「前置条件」—— 不满足则以上全部空转）

这六条是**真正的 blocker**：不是"做了更好"，而是"不做则整个采集层设计是空转的"。

| # | blocker | 为什么是 blocker | 状态 |
|---|---|---|---|
| **B1** | `WikidotDirectClient.connect` 加指数退避重试（`monitor-bridge.ts:77-93` 已有现成实现），`index.ts` 不再直接抛出退出 | 【实测】`scpper-syncer-v2` / `scpper-vote-sentinel` / `scpper-fast-vote` 三个进程 **stopped、↺2388 次重启**，从未成功完成过一次 `[tier1] Complete`。connect 一失败就退出正是重启风暴的直接成因 | ⛔（v1 侧代码，syncer2 不复用） |
| **B2** | `https-fix.ts` 猴补丁**必须先于 Client 创建**，且加不变量断言（改写后仍带非空 UA **且** 带 Referer） | 【实测】空 UA → WAF 返 **HTTP 503 空体**；AMC POST 缺 `Referer` → **TCP 连接重置（0/15 成功）**，带任意值即 200（值任意，只校验存在性）。而库的 `fetchWithRetry` 把传输重置当可重试网络错 ⇒ **5 次指数退避（最高 60 s）** ⇒ 在 49 节点 IP 池上表现为持续数十分钟的高频重连洪水 | ✅ syncer2：`src/http/client.ts` 的 `assertHeaders()` 启动自检；`SYNCER2_USER_AGENT` / `SYNCER2_REFERER` **设成空串直接拒绝启动**（不静默回落默认值——静默回落会让断言永远无法触发，而它保护的恰恰是"头被弄丢"这个场景） |
| **B3** | undici dispatcher 改 **per-client**，不用 `setGlobalDispatcher` | 进程级全局会污染同进程其他出站 | ✅ syncer2：per-client dispatcher |
| **B4** | 代理健康探针 + 至少一条 fallback；修复 mihomo 规则让 `DOMAIN-SUFFIX,wikidot.com` 指向已配置但**从未被任何规则引用**的 `🪨 Wikidot 通道` fallback group | 全部 wikidot 流量强制走 mihomo 49 节点轮换池，**无 fallback、无健康检查、无配额可见性**。把唯一常驻源架在最脆弱的链路上 = 把两个独立故障源串联 | ⛔ 探针未实现（README TODO #13）；`meta.ingest_run.exit_ip_stats` 未填充 ⇒ "某几个节点坏了"目前不可归因 |
| **B5** | 全部改**单次短进程**（`cron_restart` / systemd timer，不用 `restart_delay`——正常退出也计 restart 会被打成 errored） | 07-24 备忘已验证的模式；常驻模式下 ↺2388 就是这么来的 | ✅ syncer2 CLI 是单次短进程：stdout 只有最后一行 JSON、日志全走 stderr、失败非零退出、**进程内不做顶层重试** |
| **B6** | 三个 stopped 进程先复活并**稳定跑通一次完整 Tier1** | **在此之前，以上所有设计都还没有过一次真实验证。** 这是六条里最硬的一条 | ⛔ **仍未跑通**。syncer2 只跑通了 sitemap 通道（纯 GET，不经 AMC），ListPages / WhoRated 尚未接 |

> **B6 值得单独强调**：R1–R15 与本附录全部结论都建立在"直连能稳定跑"这个前提上，
> 而这个前提**至今没有被一次成功的 Tier1 验证过**。【实测】同期 `scpper-sync`（v1 CROM 管线）
> online 6 天、数据新鲜到当天 05:25。这个不对称是 §4 立场的事实基础。

### 3.2 Phase 0 增补六项（R5）

原 Phase 0 只有四项（删 `lightweightBridge` / 冻 CLI / AltAccount 权重置 0 / legacy 偏移审计），
增补：

| # | 增补项 | 理由 | 状态 |
|---|---|---|---|
| **P0a** | `Referer` / UA 契约启动自检 + **503 熔断** | 503 的正确响应是**停手**，不是重发。必须把 HTTP 503 与"连续传输重置"从"5xx 一律重试"里摘出来单独熔断 | ✅ syncer2：503/重置独立熔断，`status:"aborted"` 语义 = 断路器主动停手、重启也不会好、需人看 |
| **P0b** | `MainDbBridge` node-pg 时区修复 + **写读回环自检** | 【实测】Vote 时刻分布 `00:00:00` 5,693,556 / `08:00:00` **49,028** / 其他 592,655；40,778 对相隔整 8 小时的重复票**产生源仍活到 2026-04**；`MainDbBridge:496-501` 走裸 node-pg 写 `Date`，比 Prisma 晚 8 小时 | ✅ syncer2 侧：`src/store/db.ts` 时区硬守卫（**裸 `Date` 拒收** + 已知 epoch 回环自检 `assertTimezoneRoundTrip`）。v1 侧 `MainDbBridge` 未改（受保护 checkout） |
| **P0c** | `%%_tags%%` 双取 | 【实测】Tier1 只取 `%%tags%%` 不含 `_` 前缀隐藏标签，而 CROM/主库**确实含**（2,167 个当前版本）⇒ 直接切换会抹掉标签并触发 2,167 次无谓开版 → 放大跨版本重复票 | ✅ DDL 侧：`apply_page_meta` 的 `hidden_tags` 并入触发区间切换（smoke S5 有断言）。采集侧待接 ListPages |
| **P0d** | 8h 重复票 **R0 清洗必须在 `fact_seq` 分配之前** | seq 一旦分配即固化伪事件，而事实表是 **append-only 不可撤**。顺序错了就没有第二次机会 | ⛔ Phase 2 回填任务，未开始。**这是一条时序红线，不是清洗质量问题** |
| **P0e** | `vote_milestone_*` **冻结不再重算** | 【实测】1,668,520 票（**全表 26.3%**）时间戳全是 `2022-05-25`（CROM 冷启动快照）。按现规则会被标 `precision='day'`，等于宣称它们真的发生在那天；里程碑每次重算都会漂移 | 🔶 `precision` 词表**已新增 `'bootstrap'`**（rank=0，抢不走任何精度，smoke S2 有断言）；"排除出所有逐日投影"与"冻结既有里程碑"未做 |
| **P0f** | selector 字面量残留检测 | 见 §2 P1-6 | ✅ |

---

## §4「wikidot 直连作为唯一常驻源」：理由、代价与本附录的立场

### 4.1 这个决策是什么，以及它反转了什么

本轮任务的前提是 **"v2 = wikidot 直连，CROM 仅在并行期作为免费金丝雀"**（syncer2/README 开头
的原话）。这**反转了两份已定稿文件**，且反转时没有留下书面理由：

- `data-model-v2-redesign-2026-07-03.md` **§5.8**：
  *"CromAdapter（改造 Phase A/B/C）：权威全量……WikidotAdapter（syncer 复活，**可选不阻塞**）"*
- 同文档 **§7**：*"syncer 复活是可选项而非依赖……不满足则纯 Crom 单源完整成立，
  仅损失分钟级新鲜度"*
- 同文档 **§9.6**：*"CROM 路径完全不做 absence 推断，风险面减半"*
- **2026-07-24 双轨同步备忘**：*"票史时间戳永久 CROM 权威"*、*"CROM 保持唯一写者"*

**六份前序调研没有一份指出这个反转。** 混淆点在于：
"直连能从 history HTML 解析出 `wikidotRevisionId`"是把 CROM 从**必需**降为**非必需**的理由，
但**绝不构成把它从"权威"降为"抽样 oracle"的理由** —— 这两件事被当成一件了。

### 4.2 支持"唯一常驻源"的理由（尽可能强地陈述）

1. **七个域 CROM 零覆盖**，只有直连拿得到：论坛全域 · 站点成员与角色 · 附件 · backlinks ·
   逐版本源码 · `discussion_thread_id` · 真实 `unixName` · `created_by_id` ·
   隐藏标签 `_tags` · `size` · revision flags **集合**（CROM 的 type 是单值枚举）。
   既然已经要为这些域维护一套直连采集，再维护第二套 CROM 管线是双倍成本。
2. **新鲜度**：直连是分钟级（ListPages 滞后 48 s – 13 min），CROM 是它自己的爬取周期（天级）。
3. **口径自主**：CROM 的渲染文本、type 枚举、`isHidden` 等字段的口径由第三方决定，
   出问题只能等对方修。
4. **单一真相来源**在工程上更简单：不需要 R1 的逐字段权威表、不需要双源对账、
   不需要处理"两个源打架时谁赢"。

### 4.3 代价（七条，按强度排序，全部有实测支撑）

| # | 代价 | 实测依据 |
|---|---|---|
| **C1** | **撤票从"已解决"退回"未解决"**。直连只能 absence 推断，CROM 有**显式 `direction=0`**。而原文档 §9.6 自己写过"CROM 路径完全不做 absence 推断，风险面减半" | 四重门控（含 `Σsign = %%rating%%` 校验和，实测 6 页逐页成立）设计精巧，但它**保护不了**：① P0-6 的短命页（**83.2% 的最终被删页活不过 7 天**，37.9% 活不过 24 小时 ⇒ 7–14 天 sweep 对 83% 的删除页 100% 失效）；② "ListPages 与 WhoRated 同时改版一起漂移、校验和互相背书通过"这类**相关性失效** |
| **C2** | **11,804 已删页（24.7%）在直连下结构性不可见**：ListPages 不返、`page.get()` 404、`PageSourceModule` 返 `revision_error`。这些页在直连下永远只有"增"没有"撤"，且会被四重门控**永久钉在 partial** | 【实测】`Page.isDeleted=true` = 11,804；已删页语料 80% 来自 2025-11 的 legacy 一次性回填（9,528 页 https:// 指纹 + 9,483 命中 `legacy_votes_cn.pages`），**无再生路径** |
| **C3** | **出口面变成单点串联**：直连 100% 依赖 49 节点商业订阅池 + 单点 mihomo，**无 fallback、无健康检查、无配额可见性**；而 CROM **本机直连可达（0.87 s）**且有专门的 `DIRECT` 规则 ⇒ CROM 是 IP 池故障时的唯一活路 | 见 B4 |
| **C4** | **边缘契约正在活跃变动**：【实测】AMC POST **新增**强制 `Referer`（缺失即 TCP reset）；此前已知空 UA→503。值任意、只校验存在性 ⇒ 典型的粗糙 bot-mitigation，**说明该边缘的规则集正在被主动调整**。而全部解析是 HTML 选择器/正则。CROM 自己维护解析层，这正是它作为托管服务的价值 | 见 B2 |
| **C5** | **失败模式不对称 —— 这是最危险的一条**。wikidot 宕机是**良性**的（请求失败、门控生效、不写）。真正危险的是**改版/换主题/改本地化**：模块照返 `status=ok`，解析静默变形，v2 带着 `is_complete=true` 把脏数据写进 **append-only** 事实表（写进去就撤不回）。已有**三个实证**：`ContentScanner` 的 td 正则 **153/153 全失配**、`FLAG_TYPE_MAP` 英文键对中文**全不命中**、库 `SiteChangeCollection` 选择器**命中 0**；且【实测】拿到了**数据实锤**——同一 revision 在两条链路被打成不同 type 且时间差恰好 8 小时。**每日 100 页抽样 oracle 在 36,054 页里的检出灵敏度根本不够** | 这条是 R10（全局解析健康熔断）存在的全部理由 |
| **C6** | **运行现实**：【实测】`scpper-sync`（CROM）online 6 天、2.8 GB、当天 05:25 仍在产出；`scpper-syncer-v2` / `scpper-vote-sentinel` / `scpper-fast-vote` 三个直连进程 **stopped、↺2388、从未成功完成一次 Tier1**。任何"CROM 降级"的论证都必须先面对"现在唯一在产出数据的就是它" | 见 B6 |
| **C7** | **决策一致性成本**：反转两份已定稿文件而无书面理由，会让后续每个决策都失去可追溯的基准 | 见 §4.1 |

### 4.4 本附录的立场

**synthesis.md 的推荐是 D1 选项 (B)：CROM 常驻权威 + wikidot 分域独占 + 分钟级加速。**
本附录**采纳这个推荐**，理由是 C1/C2/C5 三条：前两条是"把已解决的问题变回未解决"，
第三条是"错误会被写进不可撤的 append-only 表"。

但要诚实地写下**本附录不能替谁做决定**：

- 这**不是一个技术上唯一正确的答案**。选 (A)（唯一常驻源）是可行的，代价就是 C1–C7，
  其中 C1/C2 可以通过"承认撤票延迟到天级""承认已删页数据永久停留在 v1/legacy 存量"来接受。
- **真正不可接受的是"既选 (A) 又不承认代价"** —— 即把 CROM 降为抽样 oracle，同时仍然期待
  撤票准确、已删页完整、解析健康可自我发现。这三件事在 (A) 下都不成立。
- 因此，若最终仍要走 (A)，**必须同时接受**：R2（absence 只产候选不产事实）、
  R10（全局解析健康熔断 + 人为注入故障的演练 gate）、R6（已删页不进 irreconcilable）、
  D3（历史票 precision 分三档，`bootstrap` 排除出逐日投影）四条**全部落地**，一条不能少。
  syncer2 的 DDL 已经按这个方向建好（R2/R6/D3 ✅，R10 缺物理开关）。

**已经确定的部分**（无论 D1 选 A 还是 B 都不变）：直连被授予它真正独占的领域 ——
论坛全域 · 站点成员与角色 · 附件 · backlinks · 逐版本源码 · `discussion_thread_id` ·
真实 `unixName` · `created_by_id` · 隐藏标签 `_tags` · `size` · revision flags 集合 ·
分钟级新鲜度。这一条 §5.8 原文也是这么写的，没有争议。

---

## §5 分域权威表与触发矩阵（修订 §5.8 / §9.6）

### 5.1 分域权威表（R1 的具体内容，待填进 `meta.v2_baseline`）

| 域 | 权威 | 直连角色 |
|---|---|---|
| 投票事实与时间戳、撤票 | **CROM** | 分钟级新鲜度加速（`precision='observed'`）；absence **只产候选** |
| 已删页全部数据 | **CROM + v1/legacy 存量** | 结构性不可见 |
| 页面元数据（rating/tags/title/…） | both（先到先得） | 主力，且额外提供 `_tags` / `size` / `created_by_id` 三项 CROM 没有的 |
| 修订（wid / 时间 / type / flags） | **直连** | 唯一源（CROM 的 type 是单值枚举，直连是**集合**） |
| 论坛全域 | **直连** | 唯一源（CROM 零覆盖） |
| 站点成员/角色、附件、backlinks、逐版本源码、`discussion_thread_id`、真实 unixName | **直连** | 唯一源 |
| `isHidden` / `isUserPage` / `thumbnailUrl` | **不采集** | v1 取了从未落库，白花配额 |

**每日对账**：全量（非抽样）比对 5 项 —— 存在性 / title / rating / voteCount / revisionCount。
**显式排除**：`isHidden` / `isUserPage`（第三方规则）、已删页元数据（v1/v2 tombstone 语义**相反**）、
`commentCount`、`attribution type`（需先建 `REWRITE ↔ REWRITER` 映射表）、
`direction` 需先 `sign()` 归一（v1 存量有 1,658 行 ±2）。

### 5.2 五层模块划分（修订版 —— L0 与 L1 的职责按 §1.3 重切）

```
┌─ L0  枚举完整性 / absence 基准 / 第二独立源 ────────────────┐
│  A. sitemap_page_1.xml        20 min  gzip 180 KB / 1.2–6.3 s │
│     ← 周期从 10 min 改 20 min（TTL≈60 min，10 min 有 5/6 重复）│
│     ← 整文件解析、禁止 lastmod 早停、md5 相同则短路解析       │
│  B. sitemap_page_{1..4}.xml    6 h   gzip 620 KB / 5–20 s     │
│     → 35,983 slug 全量快照（absence 基准）+ 重算覆盖下界 B     │
│     ← "连续 ≥2 轮缺席"的轮间隔必须 > 1 个 TTL（≥2 h）         │
│     ← absence 硬排除 deleted:/forum:/adult:/wanderers-adult:  │
│  C. sitemap_thread_{1..9}.xml  1 d   → 86,900 thread id       │
│     ← 对 882986 翻译预定区/2020429 垃圾桶 100% 失明           │
│  D. sitemap_category_1.xml     1 d   → 14 个 forum category    │
└──────────────────────────────────────────────────────────────┘
┌─ L1  发现层（★本附录相对 synthesis §5 的最大改动）───────────┐
│  ListPages order=updated_at desc perPage=250   3 min  1 req   │
│     → 编辑发现，滞后 48 s – >13 min（不稳定，有 18 min 平台期）│
│  ListPages order=created_at desc perPage=50    3 min  1 req   │
│     → 新页发现（sitemap 最坏 44.5 min，顶不住）                │
│  ListPages 全站 145 批 × 250，并发 4–5 路 ≈ 78 s   30–60 min  │
│     → rating / rating_votes / comments / tags 信号（唯一来源） │
│  module_body 18 字段全部 %%%%x%%%% 裸值 + span 包裹：          │
│    fullname category name title tags _tags parent_fullname     │
│    created_at created_by_id created_by_unix created_by         │
│    updated_at commented_at rating rating_votes comments        │
│    size revisions total index                                  │
│  若需硬 SLA 的秒级发现 → 只剩 SiteChangesModule（本轮未测）    │
└──────────────────────────────────────────────────────────────┘
┌─ L2  定向深扫（meta.scan_task 队列消费）─────────────────────┐
│  votes_full   WhoRatedPageModule       1 req/页（~500/天）    │
│  content      ViewSource（+整页 GET 已按 R14 取消）           │
│  revisions    PageRevisionListModule   1 req/页（必传 perpage!）│
│  meta         整页 GET 取 pageId       1 req/新 fullname      │
│  discussion   ForumCommentsListModule  1 req/页（一次性）     │
│  files        PageFilesModule          条件触发               │
│  confirm_del  整页 GET → 404           1 req/候选             │
└──────────────────────────────────────────────────────────────┘
┌─ L3  约定页与低频域 ─────────────────────────────────────────┐
│  attribution-metadata ×2（日频，强制重抓，缓存加 TTL）        │
│  系列页（动态发现前缀，非硬编码数组，日频）                   │
│  MembersList group=''/admins/moderators（周频）               │
│  WikiCategoriesModule（日频，1 req）                          │
│  论坛增量（thread sitemap 差集 + post_count 哨兵水位）        │
└──────────────────────────────────────────────────────────────┘
┌─ L4  CROM 常驻权威源（不变，非降级）────────────────────────┐
│  权威字段：投票事实与时间戳、已删页元数据、撤票 direction=0    │
│  本机直连 0.87 s，不经 IP 池 → IP 池故障时的唯一活路          │
└──────────────────────────────────────────────────────────────┘
```

### 5.3 修订后的日请求预算

| 通道 | 周期 | 请求/天 | 说明 |
|---|---|---|---|
| `sitemap_page_1` | 20 min | 72 | ~15 MB |
| `sitemap_page_{1..4}` | 6 h | 16 | absence 基准 + 重算 `B` |
| thread + category sitemap | 1 d | 10 | |
| ListPages `updated_at desc` | 3 min | 480 | **发现层** |
| ListPages `created_at desc` | 3 min | 480 | **新页发现** |
| ListPages 全站 145 批 | 30–60 min | 3,480–6,960 | 评分/投票信号 |
| L2 事件驱动 | — | ~800 | 实测 485 页/天投票变化、90 页/天编辑 |
| L3 | 日/周 | ~100 | |
| **合计** | | **≈ 5,400–8,900** | 峰值 QPS < 2，比矩阵原方案（24,500 req/天）低 3–5 倍 |

sitemap 部分只占 **98 请求 / 约 15 MB**，是整个预算里最便宜的一块 —— 这也是把它留在
架构里做"第二独立源"的成本理由（贵的是 ListPages 全站，不是 sitemap）。

### 5.4 触发矩阵（修订）

| 信号 | 来源 | 触发 |
|---|---|---|
| ListPages `updated_at` 前进 | **L1（改）** | `content` + `revisions` |
| ListPages `created_at` 出现新页 | **L1（改）** | `meta`（取 pageId）→ 新页高频队列（R7） |
| sitemap `lastmod` 前进 | L0-A | `content` + `revisions` 的**兜底**（不再是主通道） |
| sitemap 出现未知 slug | L0-A | 与 L1 交叉；**必须用 `%%page_id%%` 复核，区分新建 vs 改名** |
| sitemap 连续 ≥2 轮（间隔 >1 TTL）absence + ListPages 交叉确认 + run 完整 | L0-B | `confirm_deleted` |
| `%%rating%%` 或 `%%rating_votes%%` 变化 | L1 | `votes_full` |
| `%%comments%%` 或 `%%commented_at%%` 变化 | L1 | `forum`（**绝不触发页面内容重扫** —— v1 刻意排除是对的） |
| `%%revisions%%` 或 `%%size%%` 变化 | L1 | `revisions_full`（与 sitemap 互为兜底） |
| `%%tags%%` / `%%_tags%%` 集合变化（`a<@b AND b<@a`） | L1 | 属性更新（**不开新版**） |
| 约定页 source sha 变化 | L3 | 全站归属重解析 |
| `first_published_at > now()-7d` | 派生 | 2–4 h 强制 `votes_full` + `content`（R7） |
| CROM 与 v2 差异 | L4 | `reconcile_crom_diff` |

**明确不触发**：`comment_count` 不触发内容重扫；`updated_by` 不落事实。

### 5.5 队列语义（红线，与 §5.4 原文一致，此处复述因为它是事故同型病根）

`meta.scan_task` 是**真队列**（`UNIQUE(page_id,kind)`、失败保留、成功即删、`not_before` 退避、
`attempts`、`stable_count`、`locked_by`）—— **绝不照抄 v1 DirtyPage 的整表
`deleteMany + createMany` 重建**，那会冲掉 attempts / 退避 / 收敛三个状态，
正是论坛 #113 事故（丢 254 帖）的同型病根。

---

## §6 仍然悬空的决策（点名清单）

这些不是"待实现"，是**没人做过决定**。列在这里以免它们继续静默悬空。

1. **R10 熔断的物理开关**：`meta.parse_health_baseline` 只有基线 + 阈值 + 越界留痕，
   **没有任何东西能真的"冻结写入"**。需要一张 `meta.write_freeze`，或让 `apply_*` 入口读一个 GUC。
   ⇒ 目前 R10 是"能发现，不能阻止"。
2. **`PageEmbedding` / `SearchIndex` / `SearchChunk`（678 MB / 124,955 行）在四 schema 里
   没有归属**，原设计文档全文检索不到 `embedding` / `SearchIndex` / `SearchChunk` 任何一处。
   而 chunk 的输入是页面文本 —— `textContent` 从 CROM 渲染文本切到我方
   `extractTextContent(html)` **会改变分块内容**，理论上需要全量重算 124,955 行 embedding
   （含 API 费用与耗时）。**没有人算过这笔账，也没人决定要不要重算。**
   D9 的推荐是先测量（抽 100 页比对分块差异，<10% 则只增量）。
3. **`serve.page_reference` 的红链无处安放**（主键要求 `to_page_id NOT NULL`）；
   **`serve.trending_stats.entity_id NOT NULL` 让标签维度趋势无法落库**。两处都需要产品决策。
4. **`vote_event` 的分区与归档策略**：原文档写"上线即定"，至今未定。
   现有 4 个分区（`p0000` 冷回填 / `p0001` / `p0002` / `pdefault` **必须恒空**）只是占位。
5. **`CategoryIndexTickJob`（唯一有资金/游戏后果）**：D8 推荐并行期**硬绑 v1 `PageDailyStats`**，
   v1 退役前显式把 `vote_rule_version` 升版（`utc8-t+1-v4-observed`）并**回测全部历史 tick**。
   不做的话，换数据源等于隐式换规则却不换版本号 —— 这是当前**最大的静默风险**。
6. **迁移窗口与备份空间无人计算**：主库 24 GB，而原文档估"总账约 10 GB→4.5–5.5 GB"
   只算了它列举的域，**`PageViewEvent`(1.71 GB) / `PageEmbedding`(678 MB) /
   `PageReference`(1.07 GB) 三张共 3.4 GB 不在估算内**。回滚所需的双份存储同样未计。
7. **`export-annual-summary.ts` 从未被审计**：有 10+ 处 `date_trunc(bucket, v.timestamp)` /
   `v.timestamp >= X::timestamptz` 的年度切片，把 `timestamp without time zone` 列与
   `::timestamptz` 比较（PG 按会话时区 Asia/Shanghai 解释），与"legacy 段是 UTC 裸值"叠加
   ⇒ **年界处有 8 小时错位**；切到 `observed_at` 后逐月分桶会整体变形。
8. **回滚演练**：原文档要求"每阶段回滚声明附有效期"，但**无演练计划**。
9. **TTL 是否按文件独立**：只测了 `sitemap_page_1`。`page_2..4` 与 9 个 thread 文件是否同步
   重生成未测。若不同步，跨文件对账会短暂看到重复/缺失条目 ⇒ **全量 absence 基准必须在
   一次 run 内连续抓完 4 个文件**，并把"两文件都缺"作为唯一判据。
10. **`SiteChangesModule` 的时效本轮完全未测**。若最终需要硬 SLA 的秒级发现，它是唯一
    剩下的候选，必须单独实测。
11. **单人业余 vs 10–14 周排期的现实性**（D10）。历史上已被证伪的模式：v2 syncer 停摆一个月
    无人察觉、`repair-forum-page-links` CLI 写了从未被调度。R15 的配套要求
    —— **parity 报表必须推 QQ 群**，"SQL 可查"会变成形式主义。

---

## 附：证据与产物路径

- 本轮 sitemap 实测报告：`syncer2/experiments/sitemap-probe.md`（含复现脚本与原始数据）
- 采集脚本：`syncer2/experiments/sitemap-probe.sh`（`snap`/`full`/`forum`/`cattotal`/`chase`/`regen` 六个子命令）
- 离线分析：`syncer2/experiments/sitemap-analyze.py`（`lag`/`drift`/`order`/`domain`/`threads`）、`chase-analyze.py`
- 原始数据：`syncer2/experiments/data/`
- 迁移与冒烟：`syncer2/migrations/`（0001–0006 + `smoke_test.sql` 249 断言 + `9001`/`9002` 角色与授权）
- DBA 交接：`syncer2/docs/dba-handoff.md`
- 完整批评与综合（R1–R15 / D1–D10 / P0–P3 排序）：`/home/andyblocker/qqbot/analysis/wikidot-vs-crom-2026-07-27/synthesis.md`
- 关键代码位置（供修订定位，均在受保护 checkout `/home/andyblocker/scpper-cn/` 下）：
  - `syncer/src/bridge/MainDbBridge.ts:496-501`（node-pg 时区）、`:537`（裸 `LIMIT 1` displayName 反查）、`:585-595`（tombstone 复制旧值）
  - `syncer/src/scanner/PageScanner.ts:22-33`（module_body 缺 `_tags`/`created_by_id`/`total`/`index`）
  - `syncer/src/scanner/ContentScanner.ts:48`（裸 `fetch` 零 header）、`:241-246`（`perpage=99999999` 是**必需**参数不是冗余）
  - `backend/src/jobs/UserDataCompletenessJob.ts:88-93`（伪造 `username`）
  - `backend/scripts/export-annual-summary.ts`（从未审计的 `Vote.timestamp` 大消费者）
  - `backend/src/services/EmbeddingService.ts`（v2 设计中缺失的语义检索域）
  - `docs/data-model-v2-redesign-2026-07-03.md` §5.8 / §7 / §9.6（与"唯一常驻源"前提冲突的原文）
