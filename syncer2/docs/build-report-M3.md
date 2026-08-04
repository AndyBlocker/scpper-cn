# M3 内容 / 修订 / 附件 Tier2 构建报告

日期：2026-07-27  
工作树：`/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation`  
模块：M3（`source.ts` / `revisions.ts` / `files.ts` / `pageid.ts` / `content/extractText.ts`）  
结论：**本次要求的采集、严格解析、证据写入与当前内容应用入口已完成。**

## 1. 权威输入与核验顺序

严格按任务给出的顺序读取并以其为准：

1. `SPEC-collector.md`（442 行，完整读取）
2. `SPEC-projector.md`（214 行，完整读取）
3. `syncer2/README.md`（1,242 行，完整读取）
4. `syncer2/src/` 现有 HTTP / DB / sitemap / page identity / extractText 范式
5. `syncer2/migrations/`，随后连接实际 `scpper-v2` 查询 `pg_proc` / `pg_tables` /
   `information_schema.columns`

没有向受保护生产 checkout `/home/andyblocker/scpper-cn` 写入。

生产主库 `scpper-cn` 只执行了两组只读 `SELECT`：

- 找带 `/local--files/` 的 live 页，选择附件正向样本；
- 找存量 `FILES_CHANGED` revision，定位本站真实附件修订标记。

没有对 `scpper-cn` / `scpper-syncer` / `scpper_user` 发出任何 DML/DDL。

## 2. 实际数据库目录核验

按任务要求，没有从 SQL 文件猜函数签名，而是用 `backend/.env` 的 `DATABASE_URL`
把库名从 `/scpper-cn` 替换为 `/scpper-v2` 后查询实际目录。

实际目标确认：

```text
db=scpper-v2
role=user_dxzbdi
```

M3 相关实际函数：

```text
ingest.apply_page_meta(
  p_page integer,
  p_attrs jsonb,
  p_observed timestamp with time zone,
  p_source text,
  p_run bigint,
  p_wikidot_id integer
) -> jsonb

ingest.apply_revision_batch(
  p_page integer,
  p_revisions jsonb,
  p_claimed_total integer,
  p_observed timestamp with time zone,
  p_source text,
  p_run bigint,
  p_wikidot_id integer
) -> jsonb

ingest.put_content_blob(p_source_text text, p_text_content text) -> bytea
ingest.put_content_blob_sha(p_sha bytea, p_source_text text, p_text_content text) -> bytea

ingest.ensure_user(
  p_kind text,
  p_wikidot_id integer,
  p_anon_key text,
  p_display_name text,
  p_username text,
  p_unix_name text,
  p_user_id integer
) -> integer

meta.record_page_scan(
  p_run bigint,
  p_page integer,
  p_kind text,
  p_status text,
  p_claimed integer,
  p_fetched integer,
  p_checksum_ok boolean,
  p_checksum_expected integer,
  p_checksum_actual integer,
  p_result_hash bytea,
  p_error text
) -> void
```

相关实际表只有：

```text
ingest.content_blob
ingest.page_source
ingest.revision
meta.ingest_run
meta.page_scan
```

实际库中**没有附件事实表，也没有 `apply_files` / `apply_attachment_*` 函数**。
因此 `files.ts` 不绕过 apply 层臆造直写，只实现严格采集/解析与
`meta.page_scan(kind='files')` 证据入口。详见 §8。

## 3. 文件变更

### 3.1 新增 `src/collect/result.ts`

统一 M3 返回协议：

```ts
Map<key, {
  status: 'ok' | 'partial' | 'failed',
  data?: T,
  error?: string,
  diagnostics: {
    claimedTotal: number | null,
    fetchedTotal: number | null,
    warnings: string[]
  }
}>
```

关键点：

- 每个输入目标在 Map 中恰有一行；
- 单页失败不会从 Map 消失；
- `partial` 可以携带解析数据供留证，但应用入口明确拒绝写事实/投影；
- 重复 Map key 在发请求前直接报错，避免 `new Map()` 静默覆盖一页。

### 3.2 新增 `src/collect/source.ts`

实现：

- `parseSourceBody()`：严格解析 `div.page-source`；
- `scanSources()`：当前源码批量入口；
- `scanCurrentContents()`：当前源码 + 正常整页 HTML 正文；
- `scanRevisionSourcesOnDemand()`：逐 revision 的按需源码入口；
- `applyCurrentContent()`：当前内容的证据与应用入口。

当前态写入流程：

1. 独立调用 `meta.record_page_scan(kind='content')` 留抓取/解析证据；
2. 只有 `status='ok'` 才调用实际的 `ingest.apply_page_meta(...)`；
3. `p_attrs` 传：
   - `source_wikitext`
   - `text_content`
   - 可选 `rev_no`
4. `apply_page_meta` 内部完成：
   - `put_content_blob`
   - `page_source`
   - `serve.page_current.source_sha`
   - `serve.page_current.search_text`
5. `p_wikidot_id` 始终回显任务中的远端 id，由 DB 再做身份一致性断言。

R10 冻结下，`apply_page_meta` 可能抛 `PGF01`。因为 `page_scan` 在事实应用前独立写入，
采集证据不会随事实事务回滚，符合“冻结写入、不冻结采集”。

源码文本处理：

- `&nbsp;` / U+00A0 → 普通空格；
- 在实体解码前先移除包装 HTML，避免把源码里的 `&lt;div&gt;` 当标签删掉；
- 使用站点库既有的 `.text().trim()` 口径去掉模块包装空白；
- 去掉源码开头的 `\t`；
- SHA-256 对最终 UTF-8 wikitext 计算，与 DB `put_content_blob` 口径一致。

实测发现 `ViewSourceModule` 的包装是：

```text
"\n\t<source>\n"
```

而 `PageSourceModule` 的包装是：

```text
"\n<source>\n"
```

如果不剥包装，同一个当前 revision 会得到相差 1 字符的两个 SHA。修正后当前源码与
最新 revision 按需源码 SHA 完全相等（见 §7）。

### 3.3 新增 `src/collect/revisions.ts`

请求严格固定为：

```text
moduleName = history/PageRevisionListModule
page_id    = <wikidotId>
perpage    = 99999999
options    = {"all":true}
```

`REVISION_PERPAGE = 99_999_999` 单独导出并有线路级测试，防止后续“简化参数”。

两道硬断言：

1. `parsed_rows < claimed_total`
   - 返回 `partial`
   - 写 `meta.page_scan`
   - **不调用** `apply_revision_batch`
2. 任意 class token 等于 `pager`
   - 直接 `failed`
   - 即使已经解析出若干行也不应用

其它结构断言：

- 必须存在 `table.page-history`；
- 所有 `revision-row-*` 都必须成功解析，任一行坏掉整页 `failed`，不静默 `continue`；
- 每行至少 7 个 td；
- revision id / revNo / `time_<epoch>` 必须合法；
- 必须存在 `span.spantip[title]` 修订标记；
- 同一响应内 `wikidot_revision_id` 不得重复。

#### 本站真实修订标记

通过生产响应实测得到以下中文词表：

| 真实 title | 规范 type |
|---|---|
| `页面源代码已变更` | `SOURCE_CHANGED` |
| `标签已变更` | `TAGS_CHANGED` |
| `标题已变更` | `TITLE_CHANGED` |
| `页面已重命名/移动` | `PAGE_RENAMED` |
| `元信息已变更` | `META_CHANGED` |
| `创建新页面` | `PAGE_CREATED` |
| `文件/附件操作` | `FILES_CHANGED` |

未知的新中文标记不会被压成 `SOURCE_CHANGED`，而是保留成 `UNKNOWN:<原始 title>`，
以便解析健康分布直接暴露站点变化。

#### 集合而非单值

解析结果同时保留：

```ts
types: RevisionType[]
rawMarkers: string[]
```

生产页 `scp-8120` 实测存在同一行：

```text
["页面源代码已变更", "标题已变更"]
```

不会再像 v1 那样“找到第一个已知 flag 就 return 单值”。

实际 schema 的 `ingest.revision.type` 是 `text` 而不是 `text[]`。为不改既有签名/DDL，
落库时使用规范 JSON 数组文本：

```text
["SOURCE_CHANGED","TITLE_CHANGED"]
```

这是显式的兼容编码，不是压成单值。详见 §8 的 schema 偏离说明。

#### 修订 HTML 的真实坑

旧 `ContentScanner` 的注释/代码假定 flag 在 `td[1]`，但 2026-07-27 的真实响应是：

```text
td[0] revNo
td[1] diff radio inputs
td[2] spantip flags
td[3] actions
td[4] printuser
td[5] odate
td[6] comment
```

此外真实 HTML 在日期/评论单元格交界处存在不规范闭合。用
`/<td>(.*?)<\/td>/` 会只得到 6 个逻辑单元格。实现改为按每个 `<td ...>` 的起始位置切片，
与浏览器修复后的 `td[0..6]` 对齐。

#### 作者身份

- 正常用户：从 `userInfo(<id>)` 取 wikidot id，从 `/user:info/<unix>` 取 username；
- 已注销用户：从 `span.printuser.deleted[data-id]` 尽量保留真实 id；
- guest：保留解析快照，但现有 `revision.author_id` 没有 author_name 快照列，无法铸造时留 NULL；
- 已注销占位文本 `(account deleted)` 不传给 `ensure_user` 覆盖已有 display_name。

#### 应用门控

`applyRevisionResult()`：

1. 对 ok / partial / failed 都先写 `meta.page_scan`；
2. 只有 ok 进入 `ingest.apply_revision_batch`；
3. 所有时间使用 ISO UTC 字符串，SQL 显式 `::timestamptz`；
4. 始终传 `p_wikidot_id`；
5. 不直接写任何 `ingest.*` / `serve.*` 表。

### 3.4 新增 `src/collect/files.ts`

实现：

- `scanFiles()`
- `parseFilesBody()`
- `parseFileSize()`
- `revisionNeedsFilesScan()`
- `recordFileResult()`

正向行解析：

```text
table.page-files tbody tr[id^=file-row-]
td[0] name / href
td[1] MIME 描述（span title）
td[2] Bytes / kB / MB / GB
```

身份守卫：

- 正向和空结果都必须包含 `div#files-page-id`；
- 回显 id 必须与任务的 `wikidotId` 相等；
- 不一致/缺失直接 failed。

合法空结果的真实响应**没有 `table.page-files`**，而是：

```html
<p>本页没有附件</p>
<div id="files-page-id">24203721</div>
```

实现要求中文空提示与正确 page id 回显同时成立才返回 `ok + files=[]`。
WAF/空 HTML/只有“没有附件”几个字不会被解释为空集合。

附件触发使用：

```ts
revision.types.includes('FILES_CHANGED')
```

不会使用 `revision.type === 'FILES_CHANGED'` 的单值假设。

### 3.5 新增 `src/collect/pageid.ts`

严格请求：

```text
GET <pageUrl>/norender/true/noredirect/true
```

严格正则：

```regex
WIKIREQUEST\.info\.pageId\s*=\s*(\d+);
```

行为：

- 每个 slug 独立请求；
- 每个 slug 在结果 Map 中都有 ok/failed；
- 一页匹配失败不会 throw 掉其它页；
- `pageId=0`、缺分号、缺赋值都失败；
- category fullname 中的 `:` 通过现有 `slugToUrl()` 保持不编码。

### 3.6 修改 `src/content/extractText.ts`

原文件已有完整零依赖正文提取器，本次没有重写，而是增加严格写入入口：

```ts
extractSearchText(html):
  | { status: 'ok', data: ExtractResult }
  | { status: 'failed', error, diagnostics }
```

区分：

- `<div id="page-content"></div>` → 合法空正文，`ok + text=''`
- 缺 `#page-content` → failed
- `#page-content` 截断/未闭合 → failed
- WAF/导航页 → failed

`scanCurrentContents()` 只使用这个严格入口，并验证整页 HTML 回显的
`WIKIREQUEST.info.pageId` 与任务 `wikidotId` 一致。通过后才把 `textContent`
交给 `apply_page_meta`，最终进入 `serve.page_current.search_text`。

### 3.7 断路器与批级重试

M3 的 AMC / GET 请求都显式 `maxAttempts=3`：

- 500/502/504/普通传输失败：最多 3 次尝试后才把该页判 failed；
- 503/429：仍由既有 `HttpClient` 零重试、立即计数；
- Map 中保留最终 failed 页，不会因重试耗尽而省略。

按采集规格铁律，把以下默认值统一到 N=5：

```text
SYNCER2_HTTP_503_BREAKER=5
SYNCER2_HTTP_RESET_BREAKER=5
```

同步修改：

- `src/config.ts`
- `src/http/client.ts` 的直接构造默认值
- `.env.example`
- 本工作树本地 `.env`（未输出/泄露连接串）

## 4. 自动化测试

新增：

```text
tests/m3-collect.test.ts
tests/fixtures/m3-revisions.reconstructed.html
tests/fixtures/m3-files.reconstructed.html
```

M3 专项：

```text
tests 16
pass 16
fail 0
```

覆盖：

- source 正向实体/NBSP/包装空白；
- source 合法空与缺容器 failed；
- `perpage=99999999` 参数值；
- 修订真实中文 marker；
- 多 marker 集合；
- deleted `data-id`；
- `parsed < claimed` partial；
- `class=pager` failed；
- 空历史表 ok 与缺表 failed；
- 任一坏 revision row 整页 failed；
- 附件正向行、大小单位、URL；
- 真实空附件结构与失败结构；
- FILES_CHANGED 集合触发；
- extractText 合法空 / 缺容器 / 截断；
- pageId 严格分号/正整数；
- 本地 HTTP/AMC 线路验证：
  - 请求 body 实际带 `perpage=99999999`
  - ok/failed 两页都留在 Map
  - source 合法空与 no_page 可区分
  - pageId 两页逐页独立容错

全量测试：

```text
npm test
tests 150
pass 150
fail 0
skipped 0
duration 29.2s
```

类型检查：

```text
npx tsc --noEmit
exit 0

npx tsc -p tsconfig.tests.json --noEmit
exit 0
```

其它静态检查：

```text
git diff --check -- <M3 files>
exit 0
```

并检查 M3 实现中没有 `?? []` / `|| []` / `?? {}` / `|| {}` 后拿去做 diff 的代码路径。

## 5. 生产站真实标记调查

所有 wikidot 请求：

- 代理：`http://127.0.0.1:7891`
- 非空 User-Agent
- 非空 Referer
- AMC double-submit `wikidot_token7`
- 并发最多 2（最终样本）
- 断路器阈值 5

调查样本确认：

- `scp-cn-2000`：13 条 revision；
- `ankv`：306 条 revision；
- `scp-series-cn-5`：1,392 条 revision；
- `scp-8120`：存在 `源码 + 标题` 多 marker 同行；
- `cole-13-s-art-page`：
  - 12 个附件；
  - revision marker 为真实中文 `文件/附件操作`；
- `scp-173`：合法空附件响应；
- deleted revision author 的 `data-id=10356112` 可恢复真实 wikidot id。

本次实现期间全部生产 wikidot 请求合计 **42**（含结构调查与最终样本），低于 50。
最终交付样本自身是 7 请求。

## 6. 最终生产小样本实际输出

运行新实现的：

- `scanPageIds()` × 2 页
- `scanCurrentContents()` × 1 页
- `scanRevisions(claimedTotal=13)` × 1 页
- `scanFiles()` × 1 页
- `scanRevisionSourcesOnDemand()` × 1 revision

实际 HTTP：

```json
{
  "requests": 7,
  "attempts": 7,
  "wireBytes": 50062,
  "decodedBytes": 242793,
  "totalDurationMs": 5202.032905,
  "statusBuckets": {
    "200": 7
  },
  "retries": 0,
  "consecutive503": 0,
  "consecutiveResets": 0,
  "breakerOpen": false,
  "breakerReason": null
}
```

实际采集摘要：

```json
{
  "ok": true,
  "pageIds": {
    "scp-cn-2000": 1306943399,
    "cole-13-s-art-page": 1306894711
  },
  "currentContent": {
    "sourceChars": 401,
    "searchTextChars": 1564,
    "container": "page-content",
    "warnings": [],
    "sha256": "57c173b684d76d5305e32e4cf4ce68778860d41b4771b368c3ef32be21457b1e"
  },
  "revisions": {
    "claimed": 13,
    "parsed": 13,
    "types": {
      "SOURCE_CHANGED": 5,
      "TAGS_CHANGED": 5,
      "TITLE_CHANGED": 1,
      "PAGE_RENAMED": 1,
      "PAGE_CREATED": 1
    },
    "deletedWithId": 1
  },
  "files": {
    "count": 12,
    "totalBytes": 774720,
    "first": {
      "wikidotFileId": 9509066,
      "name": "096",
      "url": "https://scp-wiki-cn.wikidot.com/local--files/cole-13-s-art-page/096",
      "mimeDescription": "PNG image data, 1713 x 1245, 8-bit/color RGBA, non-interlaced",
      "sizeBytes": 697740
    }
  },
  "onDemand": {
    "revisionId": 1544544087,
    "sourceChars": 401,
    "sha256": "57c173b684d76d5305e32e4cf4ce68778860d41b4771b368c3ef32be21457b1e",
    "matchesCurrent": true
  }
}
```

关键交叉验证：

- `claimed_total=13`
- `parsed_rows=13`
- 无 pager
- 当前源码 SHA = 最新 revision 按需源码 SHA
- `search_text` 提取容器为 `#page-content`
- 正文无结构 warning
- 附件 id 与 page id 均有远端回显

小样本只做网络采集/解析，没有把样本写入 v2 事实表。

## 7. 规格逐条对应

### §1.1 扫描失败 ≠ 数据为空

- 所有批量 scan 返回显式 Map；
- failed 页不省略；
- source / revisions / files / pageid 都有合法空与失败的负向测试；
- partial 不应用。

### §1.3 门控算术

- M3 单请求最多 3 次尝试；
- 503/429 不重试；
- 断路器默认 N=5。

### §1.4 时区

- 新 DB 写入口只传 ISO UTC 字符串；
- SQL 中时间显式 `::timestamptz`；
- 复用 `store/db.ts` 的 `query()` / `toPgTimestamptz()` / `withTransaction()`；
- 不传裸 `Date`。

### §1.5 身份

- 采集 target 同时携带内部 page id 与 wikidotId；
- `apply_*` 一律传 `p_wikidot_id`；
- 正常整页与附件响应在解析层做 id 回显校验；
- pageid 逐页独立。

### §5.1 源码

- `ViewSourceModule`
- `page_id=<wikidotId>`
- `div.page-source`
- NBSP→空格
- 包装 tab/空白处理
- 当前态走 `put_content_blob + page_source`（经 `apply_page_meta`）

### §5.2 修订

- `perpage=99999999`
- `options={"all":true}`
- `parsed >= claimed_total`
- pager → failed
- 中文真实 marker
- 多 marker 集合
- wid 全局自然键

### §5.3 逐版本源码

- 只有显式 `revisionId` 的按需入口；
- 没有“传一页然后自动展开全部 revision”的 API；
- 没有全量回填 CLI / loop / task 生成器。

### §5.4 wikidotId 与正文

- pageid 使用规定 URL 与规定正则；
- 每页独立容错；
- `extractSearchText` 严格区分空正文与失败；
- 当前内容应用时把正文传入 `text_content`，由 `apply_page_meta` 更新
  `serve.page_current.search_text`。

### §5.5 附件

- `PageFilesModule`
- `page_id=<wikidotId>`
- `file-row-*`
- `FILES_CHANGED` 集合触发
- 合法空与失败区分

## 8. 偏离、schema 缺口与理由

### 8.1 附件没有可写事实目标

现状：

- 无附件表；
- 无附件 apply 函数；
- 采集层又被铁律禁止直写 `ingest.*` / `serve.*`。

处置：

- 完整实现远端抓取、严格解析、身份回显、result hash 与 `meta.page_scan`；
- 不新增臆造表，不绕开 apply 层。

影响：

- 当前能发现/验证附件快照；
- 还不能把附件明细永久投影给 BFF。

如果后续产品需要读附件列表，应单独补：

1. 附件当前态或事实表的生命周期定义；
2. `ingest.apply_file_snapshot(...)`；
3. completeness/absence 语义；
4. 不可变或软删策略；
5. 权限与 smoke test。

这不是本次 parser 的阻塞项，但属于附件域落库的 schema blocker。

### 8.2 历史 revision 源码没有现成的可靠关联写入口

`apply_revision_batch` 目前能：

- 插入新 revision；
- 给 `wikidot_revision_id IS NULL` 的 pending 行补 wid/type/source_sha。

但它不能给**已经具有 wikidot_revision_id 的既有 revision**单独补 `source_sha`。
直接 UPDATE 又会撞不可变触发器，并违反“只能经 apply_*”。

因此本次严格遵守任务措辞“只实现按需抓取入口”：

- 可以按 revision id 抓源码；
- 可以计算稳定 SHA；
- 没有伪装成“已永久关联缓存”的函数；
- 没有全量回填。

后续若 BFF 需要真正永久缓存，应给现有 apply 函数补一个受控的
`existing wid + source_sha NULL -> value` 分支，或新增专门 apply 函数，并加：

- 只允许 NULL→值；
- blob 外键存在性；
- page/wikidotId/revisionId 三重身份校验；
- 不可变触发器白名单窗口；
- 幂等与冲突 quarantine 测试。

这是“永久关联历史源码”的 schema/function blocker，不阻塞本次要求的按需抓取入口。

### 8.3 修订 type 的物理列不是集合

规格要求集合，但实际 `ingest.revision.type` 是 `text`。

本次没有擅自改 DDL，而是存规范 JSON 数组文本。优点：

- 信息无损；
- 顺序规范；
- 多 marker 不丢；
- 可被 parse health 统计。

代价：

- 未来 SQL 按 type 查询要解析 JSON，不能直接 `type='FILES_CHANGED'`；
- 如果长期使用，建议单独迁移为 `text[]` 或增加 `types text[]`，并明确旧 `type` 的兼容期。

### 8.4 没有做的工作

- 没有逐版本源码全量回填；
- 没有全站 pageId GET；
- 没有新增 HTTP/DB 层；
- 没有改生产主库；
- 没有 git commit；
- 没有 push；
- 没有把 M3 接进常驻 loop（采集层仍应由 M4 单次短进程消费）。

## 9. 遇到的坑

1. 旧代码 flag td 下标与生产响应不一致：旧写 `td[1]`，实际 `td[2]`。
2. 修订表原始 HTML 的 td 闭合不规范，普通成对 td 正则会少一列。
3. v1 英文 `FLAG_TYPE_MAP` 与本站中文 title 完全不是一个词表。
4. 一次 revision 确实能同时“源码+标题”，单值模型必丢信息。
5. `ViewSourceModule` 与 `PageSourceModule` 包装空白不同，会导致同内容两个 SHA。
6. 空附件响应没有 table，不能用“找不到 table = failed”一刀切；
   必须用中文空提示 + files-page-id 双证据。
7. 已注销作者的真实 id 在 `data-id`，不能只看 `userInfo()`。
8. 当前 `revision.type text` 与集合要求不一致，需要显式兼容编码。
9. 当前 schema 没有附件表，不能为了“看起来完整”绕开 apply_* 直写。
10. 当前 apply_revision_batch 没有给既有 wid 单补 source_sha 的路径。

## 10. 剩余问题与阻塞判断

本次任务范围内：**无阻塞项。**

后续范围：

- 附件事实/当前态要落库：需要 schema + apply 函数决策；
- 历史源码要永久关联 revision：需要受控 source_sha 回填函数路径；
- 修订 type 长期查询：建议把 JSON 文本兼容形态升级为真实 `text[]`；
- M4 消费器应将 `revisions_full` 的 FILES_CHANGED 结果继续入 `files` 任务，
  并调用本次提供的 scan/apply/record 入口。

