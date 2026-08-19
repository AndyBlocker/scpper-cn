# REF：v2 页面引用解析校准与 INCLUDE 结构依赖报告

## 技术结论

- 题面所见 `SHORT 175,479 → 46,569` 与 `DIRECT 19,071 → 100,772` **不是约 12.9 万条 SHORT 被重分类为 DIRECT**。v1 的 SHORT 正则会从 `[[div]]`、`[[module]]`、`[[include]]` 乃至带空格的 `[[[target | text]]]` 第 2/3 个 `[` 开始匹配；v2 原 DIRECT 又额外保存 v1 不采的站外裸 URL。两项相减才形成题面的约 47,209 条“净缺失”。
- 用同一个最终解析器重放两侧当前源码，v1 的 36,503 份源码得到 **351,690** 条，v2 的 36,643 份源码得到 **352,625** 条（+935）；故不存在一组约 4.7 万条未识别的真实链接。
- 查到两个独立的真实缺陷并已修复：一是通用 URI 判据把合法的 Wikidot `category:page` 当 URI scheme 丢弃；二是 `*https://...` 新窗口修饰符在协议判定后才剥离，导致站外 SHORT 被伪造为本站 slug。`INCLUDE` 过去则完全没有模型入口。
- `[[include page]]` 是源码结构依赖，必须采集。迁移 `0075` 已先应用到 `scpper-v2`，随后代码才开始写 `INCLUDE`；本站、显式本站与跨站 include 分别规范为 internal/internal/external。行首空格按 Wikidot 语义视为转义，不采集。
- 2026-08-18 16:09 CST 的最终全量原子重建写入 385,059 行（含有源码的已删身份），69.739 秒、`status=ok`。16:09:15 的 live 源页口径为 **352,625**，达到旧 364,626 基线的 **96.71%**，缺 12,001（−3.29%）。剩余差额来自旧基线仍含双括号指令误报，以及最终解析器不把 include 参数区的图片/CSS URL 和单括号文本当页面引用；不是未识别链接。

## 改造后逐类结果

口径：源页为 `serve.page_current.status='live'`；一行即 `(from_page_id, kind, reference_key)` 唯一键，`reference_key` 包含目标 scope、规范目标和 fragment。生产页状态仍在自然变化，以下为 2026-08-18 16:09:15 CST 快照。表格使用精确数而非图，因为验收重点是可审计的分类总数。

| 类型 | v1 当前记录 | v2 改造后 | v2 internal | v2 external | 与 v1 差异 | 解释 |
|---|---:|---:|---:|---:|---:|---|
| TRIPLE | 171,502 | 176,662 | 171,328 | 5,334 | +5,160 | 修复 `category:page`，并保留站外三括号 URL |
| SHORT | 175,479 | 45,494 | 26,951 | 18,543 | −129,985 | 排除 v1 的双/三括号重叠误报；`*https` 正确归站外 |
| DIRECT | 19,071 | 67,078 | 3,077 | 64,001 | +48,007 | v2 保留站外裸 URL；include 参数内 URL 不再冒充裸链接 |
| INCLUDE | 228 | 63,391 | 51,532 | 11,859 | +63,163 | 完整采集本站/跨站结构依赖；v1 的 228 条只是残缺旧存量 |
| **合计** | **364,626（题面去重基线）** | **352,625** | **252,888** | **99,737** | **−12,001** | **96.71%；剩余差额为 v1 误报与参数区排除口径** |

数据库复核 `count(*) = count(DISTINCT (from_page_id, kind, reference_key)) = 352,625`，没有重复行。题面逐类 v1 数字是当前原始行，合计与题面另给的 364,626 去重基线并不严格相加，因此逐类差异只作分类诊断，总行用题面去重基线验收。

63,391 条 INCLUDE 中，51,474 条解析到唯一 live 本站页，58 条本站目标当前缺页，11,859 条为跨站目标；有效源码出现次数合计 108,838。这个分布证明 INCLUDE 不是为了补总数而造的稀疏类型，而是站点大规模使用的结构依赖。

## SHORT / DIRECT 反向偏差的证据

### 同源复算排除了“真实漏 4.7 万”

在 v1 只读事务中按 `PageVersion.validTo IS NULL AND Page.isDeleted=false` 分批读取源码，再在进程内调用同一纯解析函数；v2 用相同方法读取 effective blob。全程未向 v1 发出写语句，session `transaction_read_only=on`。

| 数据集 | 当前源码页 | TRIPLE | SHORT | DIRECT | INCLUDE | 总数 |
|---|---:|---:|---:|---:|---:|---:|
| v1 源码交给最终解析器（16:16 复算） | 36,503 | 176,176 | 45,414 | 66,918 | 63,182 | 351,690 |
| v2 源码交给最终解析器（16:16 复算） | 36,643 | 176,662 | 45,494 | 67,078 | 63,391 | 352,625 |
| v2 − v1 | +140 | +486 | +80 | +160 | +209 | +935 |

修复前再用原 v2 解析器重放同一批 v1 源码，SHORT 为 46,489、DIRECT 为 100,578；相对 v1 记录的 SHORT 175,479、DIRECT 19,071，分别是 **−128,990** 与 **+81,507**，净值 **−47,483**，与题面约 47,209 的数量级和方向完全一致：前者是 v1 误报，后者是 v2 新增站外裸 URL，不是相互重分类。

v1 SHORT 的高频“目标”也直接暴露了重叠正则：`include` 21,497、`div` 20,666、`module` 18,227、`collapsible` 10,685、`span` 7,480、`size` 6,916、`image` 5,093。它们都是 Wikidot 双括号指令名而非页面目标，数量足以解释 SHORT 的反向偏差。

### 哪个判据符合 Wikidot

保留 v2 的语法分类：`[[[page]]]` 为 TRIPLE，`[URL label]` 为 SHORT，裸 `http(s)://...` 为 DIRECT，`[[include page]]` 为 INCLUDE。Wikidot 官方文档分别给出这些语法，并明确页面 unix-name 允许 `category:page`、include 可写 `:site:page`，且 include 行首空格用于阻止执行：

- [Wikidot Links](https://www.wikidot.com/doc-wiki-syntax%3Alinks)
- [Wikidot Include](https://www.wikidot.com/doc-wiki-syntax%3Ainclude)
- [Wikidot Site Structure](https://www.wikidot.com/doc%3Asite-structure)
- [Wikidot Code Blocks](https://www.wikidot.com/doc-wiki-syntax%3Acode-blocks)

## 活页源码逐条抽样

以下均直接来自 v2 当前 `content_blob.source`，再核对重建后的 `serve.page_reference`；没有为本任务额外抓取页面。

终检脚本对以下 4 页的全部 `(kind, scope, key, fragment, occurrence)` 做了纯解析结果与数据库行的深比较，4 页全部相等；同时断言不存在 `module/div/include/code/iftags/image` 伪目标。表中列出能区分口径的逐条样本。

### `fragment:collective-unconscios-2`

| 源码原文 | v1 当前结果 | v2 最终结果 | 裁决 |
|---|---|---|---|
| `[[module css]]` | SHORT `/module` | 无引用 | Wikidot 指令，不是链接 |
| `[[div class="meta-title"]]` | SHORT `/div` | 无引用 | Wikidot 指令，不是链接 |
| `[[include :scp-wiki-cn:theme:cosmonaut]]` | SHORT `/include` | INCLUDE internal `theme:cosmonaut` | 本站显式结构依赖 |
| `[[include :scpsandboxcn:no-saving-page]]` | 无正确记录 | INCLUDE external `https://scpsandboxcn.wikidot.com/no-saving-page` | 跨站结构依赖 |
| `[*/hub-hub-cn 中心心中分页中]` | SHORT `/hub-hub-cn` | SHORT internal `hub-hub-cn` | 相对命名链接，分类不变 |
| `[*/forum/t-10257021#post-4245637 Simon Arran]` | SHORT path + fragment | SHORT key `forum/t-10257021`, fragment `post-4245637` | 相对路径与锚点均保留 |

### `scp-3181`

| 源码原文 | v1 当前结果 | v2 最终结果 | 裁决 |
|---|---|---|---|
| `[[include component:image-block name=http://.../kfc.png\|caption=...]]` | INCLUDE `/component:image-block` **且误报** SHORT `/include` | 仅 INCLUDE internal `component:image-block` | 参数 URL 不冒充 DIRECT |
| `[[[scp-3250\|任何基督教教派的]]]` | TRIPLE | TRIPLE internal `scp-3250` | 一致 |
| `[[[SCP-3180]]]` | TRIPLE | TRIPLE internal `scp-3180` | 大小写规范化 |
| `[[[SCP-3182]]]` | TRIPLE | TRIPLE internal `scp-3182` | 大小写规范化 |

### `addiction`

源码只有三条页链：`[[[scp-072 |...]]]`、`[[[SCP-CN-994  |...]]]`、`[[[scp-cn-998 |...]]]`。v2 恰落三条 TRIPLE：`scp-072`、`scp-cn-994`、`scp-cn-998`；v1 除三条 TRIPLE 外又误落三条 SHORT，并把 `[[module rate]]` 误落 SHORT `/module`。不间断空格与中文显示文本不改变目标。

### `component:theme-squares`

源码 `[[[theme:laughter-and-knives-theme|欢笑与尖刀主题版式]]]` 现在落 TRIPLE internal `theme:laughter-and-knives-theme`。修复前 `theme:` 会命中通用 URI-scheme 判据而被丢弃；v1 同页另把 `[[code]]`、`[[div]]`、`[[iftags]]`、`[[image]]`、`[[module]]` 等误落 SHORT。

## 实现与顺序

1. 先新增并应用 `migrations/0075_page_reference_include_kind.sql`，把表约束扩为 `TRIPLE/SHORT/DIRECT/INCLUDE`；迁移有受保护库 guard，并已在 `scpper-v2` 验证。
2. 扩充 `PageReferenceKind`，解析独占行 include；支持本地 `page`、显式本站 `:scp-wiki-cn:page`、跨站 `:site:page`，动态模板目标保守排除。
3. 把“任意 `word:` 都是 URI”的判据收紧为无歧义的 `scheme://`，恢复 Wikidot category；把 `*` 新窗口修饰符移到协议/站点判定之前。
4. include span 在 DIRECT 扫描前登记，阻止参数内图片/CSS URL 被当成页面裸链接。
5. 16:16 实站全量审计发现 108,857 个行首 include opener：108,841 个语法闭合，16 个未闭合/无目标。15 个坏块后紧跟另一条合法 include，因此匹配器遇到新行首 opener 会停止，既不把坏目标落库，也不吞下一条；另 1 个是说明文字 `[[include]]`。闭合块中另有 1 个动态目标、2 个中文说明占位符，均保守排除，最终 108,838 次有效 include 出现聚合为 63,391 行。
6. 显式跨站实例 `:shitake-crude-production:javascript:pseudomusicplayer` 证明 include 的 page 位置可合法使用名为 `javascript` 的 category；include 专用归一化保留该页，同时普通链接里的 `javascript:` 仍被安全排除。
7. 执行最终 `serve.page_reference --rebuild`：投影 `status=ok`，69.739 秒，解析 48,477 个有源码身份、写入 385,059 行；live 结果如上。

## 回归与运行健康

- 构造回归覆盖：三括号、单括号、锚点、query、相对路径、大小写、含中文字符的 unixify、本站/跨站 include、跨行参数、未闭合块后接合法块、include 缩进转义、category 名为 `javascript`、`*https`、`ftp://` 排除。
- 数据库集成回归在同一源码窗口重放：第二次 `rowsWritten=0`、`rowsDeleted=0`，且 `computed_at` 不变；轮动源码时旧集合原子删除。唯一键与 live 全量计数再证明无重复。
- `npx tsc --noEmit`：通过。
- `npm test`：**581/581**、91 suites、0 fail；活库投影追平后原样重跑，没有为变绿修改既有断言。
- 15 条 systemd timer 均保持 active/running；未停止定时器，未改 L1、work-queue 或 forum 代码。
- work-queue 终检最近连续 8 轮均 `status=ok`，处理 0–18/轮、`batches_failed=0`、`failed=0`、`unprocessedReleased=0`。
- forum-consume 最新完整轮 run 39899 为 `status=ok`、50/50、`batches_failed=0`、`failed=0`、`unprocessedReleased=0`。
- L1 在共享出口恢复后连续自然轮 run 39878/39900/39945 全部 `status=ok`，36,700/36,700 页、147/147 批、`batches_failed=0`，耗时 **92.340/94.624/96.235 秒**。16 个 live 身份不在 ListPages 枚举中，故运行口径 36,700 与数据库 live 36,716 的差异不是漏扫。

## 边界、后续与未决问题

- 旧 364,626 基线混合了语法误报且 v1/v2 站外收集范围不同，只适合做历史警戒线，不应继续作为“纯内链真值”。建议以后同时发布 `internal`、`external`、`structural include` 三个分母。
- 纯中文目标会被 Wikidot unixify 为空；官方 page unix-name 只允许 ASCII 字母数字、连字符和冒号，因此解析器不伪造拼音 slug。混合目标如 `SCP 中文 Slug` 正确 unixify 为 `scp-slug`。
- 36,716 个 live 身份中仍有 73 个无源码（36,643 份，99.80%）；本任务没有额外抓取，因为对两侧同源复算已足以证明解析结论，且补 73 页不会改变 3.29% 口径结论。需要补齐时应走既有源码采集队列，而不是在 projector 内联网。
- 本任务对 Wikidot 页面新增请求为 **0**；只读了已落库源码和官方语法文档。v1 只读强制参数保持不变，未写 v1；未触碰 qqbot，未发送 QQ 消息。
