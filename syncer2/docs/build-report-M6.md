# M6 · 站点约定页构建报告

日期：2026-07-27

工作树：`/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation`

交付文件：`src/collect/conventions.ts`

## 1. 结论

M6 采集模块已实现，覆盖：

- 两张署名约定页的强制重抓、source 解码、SHA-256、结构化解析和逐页显式状态；
- 从当前站点顶栏动态发现系列列表页，不维护系列页数组；
- 系列 source 的备用标题解析，支持生产页现存的多种写法；
- 合法空结果、解析失败和部分成功三者的严格区分；
- 存量署名与新署名的两条隔离路径；
- 新署名在复用 slug 下按日精度日期和页面生命周期唯一裁决；
- `ingest.apply_attribution_snapshot` 和 `ingest.apply_page_meta` 的调用封装；
- 拒绝行留在 `meta.fact_quarantine`；
- 生产站真实小样本和完整仓库回归。

没有修改、提交或推送受保护的生产 checkout。没有对 `scpper-cn`、`scpper-syncer`
或 `scpper_user` 做写操作。生产站采样期间也没有执行任何数据库写入。

## 2. 权威资料与核对顺序

实现前按要求依次完整阅读：

1. `SPEC-collector.md`；
2. `SPEC-projector.md`；
3. `syncer2/README.md`；
4. `syncer2/src/` 中现有 HTTP、DB、采集状态和 sitemap 范式；
5. `syncer2/migrations/`。

另只读参考了：

- `/home/andyblocker/scpper-cn/syncer/src/scanner/AttributionScanner.ts`
- `/home/andyblocker/scpper-cn/syncer/src/scanner/AlternateTitleScanner.ts`

没有照搬 v1 的两个危险行为：

- v1 的 source cache 会让日频约定页不再强制重抓；
- v1 的备用标题页是硬编码数组，且已跟不上站点当前结构。

## 3. 实际数据库签名

按要求从 `backend/.env` 的 `DATABASE_URL` 派生 v2 URL：

```text
/scpper-cn  →  /scpper-v2
```

使用 `psql` 查询 v2 实际 catalog，而不是根据迁移文件猜签名。与本模块有关的结果是：

```text
ingest.apply_attribution_snapshot(
  p_page integer,
  p_entries jsonb,
  p_is_complete boolean,
  p_observed timestamp with time zone,
  p_source text,
  p_run bigint,
  p_wikidot_id integer
) returns jsonb

ingest.apply_page_meta(
  p_page integer,
  p_attrs jsonb,
  p_observed timestamp with time zone,
  p_source text,
  p_run bigint,
  p_wikidot_id integer
) returns jsonb

ingest.ensure_user(
  p_kind text,
  p_wikidot_id integer,
  p_display_name text,
  p_username text,
  p_unix_name text,
  p_ip text,
  p_deleted_discriminator integer
) returns integer
```

`apply_attribution_snapshot` 的 JSON 输入实际键是：

```json
{"actor_id": 42, "role": "AUTHOR", "ord": 0, "at_date": "2020-01-01"}
```

代码使用命名参数调用，并显式给所有时间参数加 `::timestamptz`；时间字符串统一先经过
`toPgTimestamptz()`。没有把 JavaScript `Date` 直接交给 `pg`。

## 4. 实现文件

新增：

- `syncer2/src/collect/conventions.ts`
- `syncer2/tests/conventions.test.ts`
- `syncer2/tests/fixtures/m6-attributions.synthetic.txt`
- `syncer2/tests/fixtures/m6-series.synthetic.txt`
- `syncer2/tests/fixtures/m6-discovery.synthetic.html`
- `syncer2/docs/build-report-M6.md`

没有修改本工作树中其他人已有的文件或未提交改动。

## 5. HTTP 与 source 获取

所有 Wikidot 请求都复用现有的：

- `HttpClient`
- `amcRequest`
- `parseSourceBody`
- `parseWikidotPageId`

请求过程：

1. 如果调用方已有可信 `wikidotId`，直接请求 `viewsource/ViewSourceModule`；
2. 否则先抓普通页面，从 `WIKIREQUEST.info.pageId` 得到真实身份；
3. page ID 缺失时该页直接 `failed`，不拿 `0` 或 slug 猜身份；
4. ViewSource 的状态、body 和 `.page-source` 结构任一不满足即 `failed`；
5. source 成功后返回 SHA-256；
6. 模块内没有 cache-hit 短路，每次调用均强制重抓、重解析。

两张署名源 slug 是规格明确指定的数据源，故固定为：

```text
attribution-metadata
attribution-metadata-translation
```

这不是系列页前缀数组。系列页集合完全来自实时顶栏发现。

`collectAttributions()` 和 `collectAlternateTitles()` 都为每个目标建立
`Map<string, CollectResult<...>>`。失败页不会因 `continue` 从结果中消失。

## 6. 署名解析

### 6.1 表格状态机

解析器不是“所有四列行都算署名”，而是由表头切换状态：

- 只接受精确的 `标题/用户/类型/时间` 或 `title/user/type/date` 四列表头；
- 只有该表头之后的行才按署名解释；
- 碰到其他表头立即退出署名表状态；
- translation 页末尾真实存在的 20 行“旧论坛 ID / Wiki ID”两列表因此被正确忽略；
- 活跃署名表中的畸形行不会静默跳过，而是进入 `rejectedRows` 并使结果为 `partial`。

### 6.2 type 与日期

type 使用显式白名单归一到大写角色：

```text
AUTHOR / REWRITER / MAINTAINER / CREATOR / TRANSLATOR / CONTRIBUTOR
```

未知 type 不再采用 v1 的 `rawType.toLowerCase()` 猜测，而是拒绝并留证。

日期策略：

- `YYYY-MM-DD` 且为真实日历日期：保留为日精度；
- `YYYY-MM`：保留原始证据，但 `atDate=null`，绝不伪造为当月 1 日；
- 其他非空形态：标记 `unknown`、保留原值并告警；
- `*YYYY-MM-DD` 额外保留 `isForumOrigin=true`；
- 无日期：精度为 `none`。

只有日精度日期能参与复用 slug 的生命周期裁决。

### 6.3 ord

`ord` 按同一 source 中的 `(pageSlug, role)` 从 0 递增。行指纹包含：

```text
pageSlug + 规范化用户名 + role + rawDate + ord
```

因此同页、同角色、同名的重复行不会仅因用户名相同而塌缩。

## 7. 存量署名安全边界

这是本模块刻意拆开的两个 API：

### 7.1 存量 / 已有映射

`applyMappedAttributionSnapshots()` 只接受：

- v2 `pageId`
- `wikidotId`
- `actorId`
- `role`
- `ord`
- `atDate`
- 可选审计字段 `v1PageVersionId`

运行时输入一旦带 `slug` 或 `pageSlug`，在触库前立即抛错。这样不会因 TypeScript 的
结构类型、`as any` 或 JSON 输入绕过“存量禁止 by-slug”的铁律。

调用方必须先用 v1 的：

```text
Attribution.pageVerId → PageVersion.id → PageVersion.pageId
```

完成映射，再把结果交给此入口。本模块没有创建第二条 v1 DB 连接，也没有按 slug
重新解释那批历史数据。

完整快照可设置 `isComplete=true`，并通过 `emptyTargets` 明确表示“这个已知 page
当前确实为 0 条”。没有显式 page 身份时，空数组不会猜测应清空哪个页面。

### 7.2 明确新增的源行

`resolveNewAttributionEntriesBySlug()` / `applyNewAttributionEntriesBySlug()` 仅供调用方
已经判定为新增的行使用：

- slug 只映射到一个 Page：可以接受无日期行；
- slug 映射到两个或更多 Page：必须有日精度日期；
- 日期必须只落入一个候选 Page 的生命周期；
- 0 个匹配或多个匹配都拒绝；
- 同一天发生旧页删除和新页创建时，两边按 UTC 日都可能命中，故明确拒绝，不猜先后；
- 用户名必须在 `display_name` / `username` / `wikidot_unix_name` 中唯一命中已有用户；
- 用户 0 命中或多命中都拒绝，不铸造派生身份。

拒绝结果写入 `meta.fact_quarantine`，包含源行、候选 Page ID 和候选 actor ID。

新行入口把 `p_is_complete` 固定为 `false`。局部新增只证明“存在”，不能证明该页完整集合，
因此绝不会借局部输入产生 `removed`。

## 8. 备用标题与系列页动态发现

### 8.1 动态发现

`discoverSeriesPages()` 从当前首页 `#top-bar .top-bar` 读取导航：

- 顶级组标题必须含 `SCP`；
- 只接收站内相对链接；
- 链接或显示文本必须表明是 SCP 系列列表；
- tales/故事子列表被排除；
- source page slug 从真实 `href` 取得；
- page-family prefix 从发现到的 slug 去掉数字尾缀后归纳；
- 没有 SCP 组或没有列表页时为 `failed`，不回退到硬编码数组。

因此站点新增 `scp-series-10`、`scp-series-11` 或新的 CN 系列页时，下一次日频扫描会自动进入。

系列 source 内用于识别文章链接的前缀也不是数组。解析器统计该页真实数字 slug 的
“首个数字前部分”，同前缀至少出现 3 次才视为该页的文章族。这会过滤页面顶部的
artwork、安保等级和其他导航链接。

### 8.2 生产源现存写法

实际 source 不只包含 v1 正则支持的 `[[[slug]]] - title`，还存在：

```text
[[[slug]]] - title
[[[slug]]] – title
[[[slug]]] — title
[[[slug|display title]]]
[[[slug|display title]]]：附注
[[span ...]][[[slug|display title]]][[/span]]
[[[slug]]]：plain title
```

当前解析器均支持。横线后的 title 优先；没有横线时链接显示标题优先于冒号后的附注。
这条优先级专门由 `SCP-CN-3204` 形态和自动化用例钉住，避免把 `：//老天爷//`
当成标题并丢掉真正的链接显示标题。

以下形态是合法“无备用标题”，不会算解析失败：

- `[ACCESS DENIED]`
- 整段斜体占位文字
- 链接显示文本只是 slug/编号本身
- 结构完整的系列候选全部为占位符

以下形态是解析失败或部分成功：

- source 为空；
- WAF / 普通 HTML 中没有列表候选；
- `[[[` 系列条目链接没有闭合；
- 顶栏模板结构不存在；
- 页面只有普通 wiki 链接，但无法证明有系列条目族。

### 8.3 落库

备用标题先在 `serve.page_current` 中解析当前 page：

- 优先唯一 `status='live'` 的候选；
- 没有 live 时，只接受全体候选恰好一个；
- slug 复用且无法唯一确定时拒绝。

正观测先调用 `meta.record_page_scan` 留证，再调用：

```text
ingest.apply_page_meta(
  p_attrs => {"alternate_title": "..."}
)
```

任一系列页 `failed/partial` 时只应用明确存在的正观测，不根据缺席清空旧标题。

## 9. 空结果与解析失败

专项测试明确覆盖：

| 解析器 | 合法空结果 | 解析失败 |
|---|---|---|
| 署名 | 结构正确的四列表头，数据行 0 条 | 空 source、WAF/普通 HTML、缺表头 |
| 备用标题 | 结构正确且候选全是占位符 | 空 source、无候选、结构坏链 |
| 系列发现 | 不适用；当前导航必须至少发现 1 页 | 无 top-bar、无 SCP 分组/列表 |

不会使用 `data ?? []`、`try/catch → []` 或“失败页从 Map 消失”的退化路径。

## 10. 生产站真实小样本

### 10.1 请求约束

全部请求满足：

```text
proxy    = http://127.0.0.1:7891
UA       = scpper-cn-syncer2/0.1 (+https://scpper.cn)
Referer  = https://scp-wiki-cn.wikidot.com/
HTTP     = 复用 src/http/client.ts
AMC POST = 复用 src/http/amc.ts
```

`HttpClient` 在构造和每次发送前都会检查 UA/Referer 非空；503/429 熔断逻辑没有绕过。

本次整个实现过程中累计只对生产 Wikidot 发出 **48 次请求**：

| 阶段 | 请求数 | 目的 |
|---|---:|---|
| 页面身份 / source 协议确认 | 5 | 首页与两张署名源 |
| 源数据形态统计 | 6 | 两张署名源及第 10 系列 |
| translation 尾部表格上下文确认 | 4 | 确认 20 行两列表不是署名 |
| 当前模块完整发现与抓取 | 23 | 1 次顶栏 + 2 张署名 + 20 张系列 source |
| 备用标题拒绝形态诊断 | 5 | 找出合法的多种 source 变体 |
| 修正后代表页复测 | 5 | 5 张高变异页面 |
| **合计** | **48** | **不超过 50** |

其中模块完整抓取和修正后复测的 HTTP 结果全部为 200，重试为 0，熔断器未打开。

### 10.2 署名实测输出

两张 source 的真实大小和形态：

```text
attribution-metadata
  wikidot_id       = 74443644
  source_bytes     = 148900
  source_lines     = 6529
  table_lines      = 3222
  data_like_lines  = 3220
  four_col_rows    = 3219
  malformed_rows   = 1

attribution-metadata-translation
  wikidot_id       = 1460834467
  source_bytes     = 194992
  source_lines     = 8827
  four_col_rows    = 4330
  old_forum_map    = 20 two-column rows (ignored by header state machine)
```

当前真实畸形行：

```text
||scp-cn-4022||windfull building|| ||
```

当前模块整轮输出：

```text
status          = partial
parsed_entries  = 7547
rejected_rows   = 1
warnings        = 1
source_pages    = 2/2 ok
```

日期形态实测：

```text
empty date      = 3097
YYYY-MM-DD      = 121
YYYY-MM         = 1
```

因此生产当前这一轮不能设置 `p_is_complete=true`，也不能产生任何署名 removal。
这不是解析器误报；是 source 中确实存在一条三列残行。

### 10.3 系列页发现与备用标题实测输出

当前顶栏动态发现结果：

```text
series_pages = 20
prefixes = [
  "joke-scps",
  "joke-scps-cn",
  "scp-ex",
  "scp-ex-cn",
  "scp-international",
  "scp-series",
  "scp-series-cn"
]
```

规格记录的是 19 张；当前站点已增加第 10 系列等入口，实际为 20 张。实现按站点结构走，
没有为了匹配旧数字而删除新页。

首次完整 20 页运行发现旧版解析器还不支持显示文本、en dash、冒号和 span 包装：

```text
status          = partial
parsed_entries  = 16429
listed_slugs    = 16457
rejected_rows   = 206
http_requests   = 23
http_attempts   = 23
http_200        = 23
http_retries    = 0
wire_bytes      = 465180
decoded_bytes   = 1709082
breaker_open    = false
```

没有把这 206 行简单放行；先抽取真实形态，再修正解析规则并补回归用例。修正后的最终代码在
5 张高变异代表页上的实际输出：

```text
scp-series-8       status=ok entries=997  candidates=1007 rejected=0
scp-international  status=ok entries=822  candidates=838  rejected=0
scp-series-cn-4    status=ok entries=999  candidates=1007 rejected=0
scp-series-10      status=ok entries=1004 candidates=1006 rejected=0
joke-scps          status=ok entries=418  candidates=429  rejected=0

http_requests  = 5
http_attempts  = 5
http_200       = 5
http_retries   = 0
wire_bytes     = 95538
decoded_bytes  = 307916
breaker_open   = false
```

为遵守总请求数不超过 50，修正后没有再重抓全部 20 页；上述 5 页特意覆盖条目最多、
国际链接最多和语法变体最多的页面。最终 parser 的其余覆盖由固定 fixture 保证。

## 11. 自动化测试

M6 专项：

```text
command:
  node --import tsx/esm --test tests/conventions.test.ts

tests     = 13
pass      = 13
fail      = 0
duration  ≈ 0.53 s
```

覆盖项：

1. 四列表头状态机和无关两列表；
2. 署名畸形行导致 `partial`；
3. 署名合法空、WAF、空 source 三分；
4. 未知角色拒绝；
5. 备用标题清理与坏候选留证；
6. 备用标题合法占位空、WAF、空 source 三分；
7. 冒号附注不能覆盖链接显示标题；
8. 顶栏动态发现新增第 11 系列；
9. 发现结构失败；
10. 单候选和复用 slug 的生命周期裁决；
11. 同日交接、多生命周期命中时拒绝；
12. 存量映射入口在触库前拒绝 slug；
13. 完整空页只有携带显式 page 身份才会向 `apply_*` 发送 `[]`；
14. 行指纹稳定且包含 ord（与其他断言一起构成上述 13 个 node:test 用例）。

TypeScript：

```text
npx tsc --noEmit
exit = 0

npx tsc -p tsconfig.tests.json --noEmit
exit = 0
```

全仓测试：

```text
command:
  npm test

top-level tests = 65
test cases      = 184
pass            = 184
fail            = 0
cancelled       = 0
skipped         = 0
duration        = 30861.710392 ms
```

全仓数据库测试使用 v2 测试库并自行清理；没有写三个 v1/主库。

## 12. 四条铁律对应关系

### 铁律 1：扫描失败不等于数据为空

- `CollectResult` 明确区分 `ok / partial / failed`；
- 两类 parser 都有合法空和解析失败的负向对照；
- 缺表头、缺列表结构、WAF 和空 source 不会返回空数组成功。

### 铁律 2：不完整观测不能产生删除

- 任一署名拒绝行使整轮 `partial`；
- 新署名入口固定 `p_is_complete=false`；
- 完整存量快照必须由调用方显式证明，空页还必须给 `emptyTargets`；
- 系列页任一失败时不从缺席推断清空。

### 铁律 3：身份不能猜

- source 请求前校验真实 Wikidot page ID；
- 存量署名入口拒绝 slug；
- 新署名复用 slug 必须由日精度日期唯一命中生命周期；
- actor 名称多命中或零命中都拒绝；
- 备用标题复用 slug 无唯一 live 候选时拒绝。

### 铁律 4：时间语义必须显式

- 日历日期用 UTC 构造校验；
- 月精度不伪造具体日；
- DB `timestamptz` 参数统一用 UTC ISO 字符串和显式 cast；
- 没有裸 `Date` 传入 DB。

## 13. 遇到的坑

1. translation 页底部的 20 行两列表不是坏署名，而是另一张“旧论坛 ID / Wiki ID”表；
   仅按列数扫全页会错误报警或误摄入，必须使用表头状态机。
2. 生产署名源当前确有一条三列残行；若把“不匹配正则”静默跳过再宣称 complete，
   会打开全站 removal 路径。
3. 备用标题生产格式已经明显超出 v1 正则：显示文本、en/em dash、冒号、span 包装都存在。
4. 冒号后的文本有时是附注而不是标题，必须让链接显示标题优先。
5. 顶栏当前是 20 张系列页，不再是规格实测时的 19 张；硬编码既会漏新系列，也会继续抓
   已从当前导航移除的旧页面。
6. 系列页顶部混有 artwork、安保等级等普通列表链接；仅看 `* [[[...]]]` 会产生大量假标题。
7. 同日 delete/create 用只有“日期”的署名无法判定精确先后，两个生命周期都可能合法；
   多候选即拒绝比随意选新页安全。

## 14. 偏离规格、理由与剩余集成项

### 14.1 生产站页数从 19 变为 20

这是远端数据变化，不是实现偏离。模块严格采用动态发现结果 20，没有硬凑成旧的 19。

### 14.2 当前署名整轮为 partial

规格要求不完整观测不得删除。由于真实 source 的 `scp-cn-4022` 行只有三列，模块输出
7547 条可用正观测和 1 条拒绝行，但不会把该轮标成 complete。修复应发生在站点 source，
不能在采集器中臆造缺失的 type/date。

### 14.3 存量抽取不在本文件内直接连接 v1

本模块提供强制的“已映射输入”入口和运行时 slug 守卫，但没有自行新建 v1 HTTP/DB 层。
实际 Phase 2 搬运程序仍需执行只读：

```text
Attribution.pageVerId → PageVersion.pageId
```

并把映射后的 v2 page/actor 身份传入 `applyMappedAttributionSnapshots()`。这是有意保持
数据源连接边界，避免 M6 运行时扫描器获得主库写权限或重新发明 DB 层。

### 14.4 日频调度

规格本次指定文件只有 `src/collect/conventions.ts`，没有指定 M6 CLI。模块已经做到每次调用
都强制重抓并返回 source hash；日频启动、run 建立以及 hash 变化后的任务编排需由后续调度
入口接线。模块本身不会因为 hash 未变化而跳过抓取。

## 15. 阻塞项

代码、类型检查、测试和生产小样本均无阻塞。

上线前的外部数据项只有一项：站点维护者若不修复 `scp-cn-4022` 的三列残行，署名扫描会持续
保持 `partial`。这不会阻止新增正观测写入，但会按设计阻止全量 removal。
