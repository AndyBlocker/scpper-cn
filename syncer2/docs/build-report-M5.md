# M5 · 论坛采集构建报告

日期：2026-07-27（Asia/Shanghai）  
工作树：`/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation`  
目标库：`scpper-v2`  
实现状态：完成；有 1 个代理环境告警、1 个既有 schema 表达能力缺口，均见「剩余问题」。

## 1. 本次交付

### 1.1 代码

- `src/collect/forum.ts`
  - 五个匿名 AMC 读取模块：
    - `forum/ForumStartModule`
    - `forum/ForumViewCategoryModule`
    - `forum/ForumViewThreadModule`
    - `forum/ForumViewThreadPostsModule`
    - `forum/ForumCommentsListModule`
  - 五组严格解析器，全部返回 `CollectResult<T>`，批量入口返回含失败项的 `Map`。
  - `ensure_user(wid > 0)`、`apply_forum_batch`、页级 discussion 证据与 `apply_page_meta` 串联。
  - 完整 thread 快照的帖子集合差生成 `is_deleted=true` tombstone；partial/failed 永不生成软删。
- `src/cli/forum-scan.ts`
  - 单次短进程；每次最多认领 50 个目标；连续 5 个失败后非零退出。
  - 页级 `forum` / `discussion` 任务优先，再消费 `meta.forum_scan_task` 的 category/thread 差集。
  - `FOR UPDATE SKIP LOCKED`、成功即删、失败退避、异常释放锁。
  - 启动前执行 UA/Referer、DB 时区回环、真实 AMC/代理自检。
  - 事实写入前执行 R10 解析健康检查。
  - stdout 仅最后一行 JSON，过程日志只写 stderr。
- `src/store/queues.ts`
  - 新增论坛目标与页级 discussion 的认领、完成、退避、收敛、释放锁接口。
- `migrations/9002_grants.sql`
  - 给 `ingestor_role` 增加 `ingest.forum_category/thread/post` 的 `SELECT`。
  - 理由：完整 thread 快照要读当前 post id 集合才能生成软删 tombstone。
  - 仍无 INSERT/UPDATE/DELETE；事实写入只能走 `apply_forum_batch`。
  - 同步更新历史备用脚本 `9000_roles_grants.sql.ADMIN`。
- `tests/forum.test.ts` + 4 个固定 HTML fixture
  - 覆盖五个模块、作者/父帖/编辑时间、空分类、空评论、空帖、坏结构、WAF 形态、Map 缺项红线、匿名请求契约、软删 tombstone。
- `package.json`
  - 新增 `forum:scan`、`forum:probe`。
- `README.md`
  - 补 M5 完成度、命令、测试基线及消费者状态。

### 1.2 没有做的事

- 没有修改、提交或 push 任何 git 历史。
- 没有对 `scpper-cn` / `scpper-syncer` / `scpper_user` 做写操作。
- 没有创建或复用任何 Wikidot 登录会话，没有发送账号、密码、Authorization 或 session cookie。
- 没有用 category 分页做全站 thread 枚举。
- 没有用 thread title 猜 slug/page；代码中不存在 title-as-slug 分支。
- 没有因响应缺席直接删除 thread/category；帖子也只有完整快照通过后才允许集合差软删。

## 2. 权威规格与数据库签名核验

严格按任务给出的顺序读完：

1. `SPEC-collector.md`
2. `SPEC-projector.md`
3. `syncer2/README.md`
4. 既有 `src/` 范式
5. `migrations/`，并以 `psql` 查询实际函数签名

实际库中确认的签名：

```text
ingest.apply_forum_batch(jsonb,jsonb,jsonb,timestamptz,text,bigint)
ingest.ensure_user(text,integer,text,text,text,text,integer)
ingest.resolve_thread_page(bigint)
ingest.apply_page_meta(integer,jsonb,timestamptz,text,bigint,integer)
meta.record_page_scan(bigint,integer,text,text,integer,integer,boolean,integer,integer,bytea,text)
```

目标连接也做了脱敏确认：

```text
syncer2 DB: host=localhost:5434 database=/scpper-v2 user=set
backend DATABASE_URL 替换后: host=localhost:5434 database=/scpper-v2 user=set
proxy: http://127.0.0.1:7891
```

## 3. 关键实现语义

### 3.1 匿名链路

`forum.ts` 只复用既有 `amcRequest()` + `HttpClient`，没有 import `@ukwhatn/wikidot`，因此不会从环境变量建立 AuthClient，也不会把登录 session 带到轮换出口。

本地拦截测试逐请求确认：

```text
Authorization: absent
username form field: absent
password form field: absent
session form/cookie: absent
Cookie: wikidot_token7=<16 hex> only
User-Agent: non-empty
Referer: non-empty
```

### 3.2 枚举与队列

- 正常入口只认领 sitemap 已产出的 `(kind,target_id)` 差集。
- category 目标由一次 `ForumStartModule` 当前态列表确认并落库。
- thread 目标直接按 sitemap thread id 定向抓 `ViewThread`，再按 pager 补 `ThreadPosts`。
- `ForumViewCategoryModule` 保留为指定 category/指定 page 的诊断入口，CLI 不暴露“自动翻完整分类”的 API。
- 页级 `forum` / `discussion` 来自 Tier1 评论计数/时间变化队列，优先于 8.6 万条冷启动 thread backlog。

这样避免了实测 category `675245` 的 2,128 页全量遍历。

### 3.3 空结果与失败分流

- `ForumStart`：唯一 `.forum-start-box` 内 0 行是合法空分类；缺锚点/WAF 是 failed。
- `ViewCategory`：完整 box + stats + table 且 0 数据行是合法空页；非空坏行是 failed。
- `ThreadPosts`：实站 0 帖 thread 返回 5 个换行符。只有 `claimed_total=0 && page=1` 时才接受为空；其它空白全部 failed。
- `CommentsList`：必须同时有 `WIKIDOT.forumThreadId` 和唯一 `#thread-container-posts`。
- 任一候选行解析失败不会静默 `continue` 成少一行的成功结果。
- 批量 thread/discussion 的每个输入 id 都显式存在于返回 Map 中。

### 3.4 身份与 page_id

- `wid > 0` 先调用 `ingest.ensure_user`。
- guest / anonymous / deleted 且没有正 wid 的作者只写 `author_name` 快照。
- 页面讨论写入顺序：
  1. 记录页级 `page_scan`；
  2. 同一事实事务先 `apply_page_meta(discussion_thread_id, comment_count)`；
  3. 再 `apply_forum_batch`；
  4. SQL 内 `resolve_thread_page(thread_id)` 通过 `page_current.discussion_thread_id` 反解。
- 实站结果验证 `forum_thread.page_id=25`；没有经过 title、slug 或 URL 猜测。

### 3.5 当前态 upsert 与软删

- 编辑后的 title/text/edited_at 交给 `apply_forum_batch` 原位 upsert。
- 只对 `status='ok'`、所有帖子分页成功且 `posts.length===thread.post_count` 的 thread 读取本地存活 post id。
- 本地存在、远端完整快照缺席的 id 作为最小 tombstone：

```json
{"id":7002,"thread_id":991,"is_deleted":true}
```

- partial/failed 不传 `completeThreadIds`，因此绝不会产生 tombstone。
- `ingestor_role` 只有上述 diff 所需的 SELECT；实测：

```text
forum_post SELECT = true
forum_thread SELECT = true
forum_post UPDATE = false
```

### 3.6 证据与熔断

- 页级 `discussion` 与 `forum` 是两种独立 `page_scan.kind`，不会互相顶替。
- `apply_forum_batch` 现签名没有完整性参数，会按既有 SQL 保守写 `kind=forum,status=partial`。
- 对 `scan_task(kind=forum)`，采集器完整翻页成功后会再写一条有 hash 的 `forum/ok` 证据；对 `discussion` 则保留独立 `discussion/ok`，同时允许函数产生保守的 `forum/partial`。
- R10 指纹含 category 数、平均帖子数、平均正文长度、作者类型分布、解析失败率、HTTP 分桶、传输失败率；事实应用前先评估。
- 捕获 `PGF01` 后在新事务调用 `meta.note_freeze_skip`，冻结期间不形成观测盲区。

## 4. 自动化验证

### 4.1 类型检查

```text
$ npx tsc --noEmit
exit 0, no output

$ npx tsc -p tsconfig.tests.json --noEmit
exit 0, no output
```

### 4.2 M5 定向测试

```text
$ node --import tsx/esm --test --test-reporter=spec tests/forum.test.ts
tests 9
pass 9
fail 0
duration_ms 680.098182
```

覆盖项目：

1. ForumStart 正常/合法空/WAF/坏行
2. Category 单页正常/合法空/坏行
3. Thread 作者、嵌套 parent、编辑时间
4. Posts 空白与 claimed_total 双重判据
5. Comments 实站 thread id 变量与合法空评论
6. 完整快照软删 tombstone
7. 五模块匿名请求与失败 Map 保留

### 4.3 全量回归

```text
$ npm test
tests 185
suites 41
pass 185
fail 0
cancelled 0
skipped 0
duration_ms 29471.784963
```

`git diff --check` 通过。

## 5. 生产站真实小样本

### 5.1 请求预算

本次开发全过程共发出 **18 个 Wikidot 请求**，低于任务硬上限 50：

- 结构侦察：9
  - ForumStart 1
  - ViewThread / ThreadPosts / ViewCategory / Comments 等定向结构探针 8
- 第一次页级端到端：4
- 一次因工作目录写错、未认领到任务的启动探针：1
- 最终代码页级端到端：4

无 503、无重试、无凭证。最后一次端到端本身是 4 请求：

```text
1 × list/WikiCategoriesModule 启动 AMC 探针
1 × forum/ForumStartModule
1 × forum/ForumCommentsListModule
1 × forum/ForumViewThreadModule
```

目标：v2 `page_id=25 / wikidot_id=1452770417 / slug=scp-2823`。

为了让页级完整性校验使用独立 claimed_total，先在**主库只读事务**查询当前 v1 观测：

```text
Page.id=16141
wikidotId=1452770417
currentUrl=http://scp-wiki-cn.wikidot.com/scp-2823
PageVersion.commentCount=2
```

随后只在 v2 用 `apply_page_meta` 把该 claimed count 置为 2，并投递一条 `discussion` 测试任务。没有直接 UPDATE `serve`/`ingest`。

### 5.2 最终运行命令

```bash
node --import tsx/esm src/cli/forum-scan.ts \
  --page-id 25 --limit 1 --concurrency 1
```

### 5.3 最终实际 stdout

```json
{"ok":true,"status":"ok","runId":239,"durationMs":2384,"claimed":1,"discussionClaimed":1,"forumClaimed":0,"processed":1,"succeeded":1,"partial":0,"failed":0,"categoriesApplied":16,"threadsApplied":1,"postsApplied":2,"irreconcilable":0,"consecutiveFailuresPeak":0,"stoppedByFailureLimit":false,"unprocessedReleased":0,"parseHealth":{"runId":239,"source":"wikidot_forum","fingerprint":{"forum_category_count":16,"avg_posts_per_thread":2,"forum_author_kind_dist":{"wikidot":2},"avg_body_len":20.5,"parse_drop_rate":0,"selector_empty_rate":null,"http_status_dist":{"200":4},"transport_failure_rate":0,"targets_claimed":1,"revision_type_dist":null,"avg_votes_per_page":null,"avg_tags_len":null,"avg_source_len":null,"exit_ip_dist":null},"policies":10,"measured":4,"insufficientBaseline":4,"breaches":[],"warnings":[],"frozen":false,"freezeReason":null},"http":{"requests":4,"attempts":4,"wireBytes":10103,"decodedBytes":58509,"totalDurationMs":1409.971506,"statusBuckets":{"200":4},"retries":0,"consecutive503":0,"consecutiveResets":0,"breakerOpen":false,"breakerReason":null},"samples":[{"kind":"discussion","pageId":25,"wikidotId":1452770417,"slug":"scp-2823","status":"ok","threadId":16737556,"posts":2,"action":"deleted","apply":{"posts":2,"threads":1,"categories":0,"quarantined":0,"threads_linked":1,"soft_deleted":0},"error":null}]}
```

### 5.4 最终实际 stderr 摘要

```text
assertTimezoneRoundTrip 通过
AMC POST 探针通过 attempts=1 categories=42
已认领论坛差集 page=1 forum=0 limit=1
启动自检告警：mihomo /connections 曾显示 chains[0]=DIRECT
```

最后一条是环境告警，详见「剩余问题」。客户端配置与实际连接目标仍是 `http://127.0.0.1:7891`。

### 5.5 落库核验

```text
serve.page_current:
page_id=25 wikidot_id=1452770417 slug=scp-2823
comment_count=2 discussion_thread_id=16737556

ingest.forum_thread:
id=16737556 category_id=675245 page_id=25
title=SCP-2823 post_count=2 is_deleted=false

ingest.forum_post:
thread_id=16737556 rows=2 is_deleted rows=0

meta.page_scan run=239:
discussion  ok       claimed_total=2 fetched_total=2
forum       partial  apply_forum_batch 无完整性声明（既有函数的保守证据）

meta.scan_task:
page_id=25 kind=discussion remaining=0

meta.ingest_run:
id=239 source=wikidot_forum status=ok
```

因此本样本同时证明：

- 页面身份用内部 `page_id`；
- discussion thread id 从 Comments 响应发现；
- `apply_page_meta` 后由 SQL 反解 `forum_thread.page_id`；
- 两帖 upsert 成功；
- queue 成功即删；
- 最终代码的完整快照软删 diff 路径实际执行，`soft_deleted=0`。

## 6. 实测发现

### 6.1 Comments thread id 变量与库实现不同

实站当前返回：

```javascript
WIKIDOT.forumThreadId = 2026993;
```

`@ukwhatn/wikidot` 当前实现只匹配旧形态：

```javascript
WIKIDOT.modules.ForumViewThreadModule.vars.threadId = ...
```

新解析器优先支持实站形态，并兼容旧形态。这是不能直接复用库 parser 的原因之一。

### 6.2 真正空帖响应没有 DOM 锚点

`ForumViewThreadPostsModule(t=18218218,pageNo=1)` 的 body 实测只有 5 个换行符。  
因此不能用“必须有容器”作为空帖判据，只能用独立 `claimed_total=0` 授权空白响应。

### 6.3 category 全遍历不可接受

`category=675245` 实测：

```text
pager: page 1 of 2128
page 1 rows: 20
```

这验证了用 thread/category sitemap 差集，而非 category 全量翻页的必要性。

### 6.4 ForumStart 与 category sitemap 的视野不同

- `ForumStartModule(hidden=true)`：16 个分类
- category sitemap：14 个分类

CLI 每轮 ForumStart 会保存当前看到的 16 个分类父表，但 thread 入队仍严格来自 sitemap 差集；不会把隐藏分类的“sitemap 缺席”当删除。

## 7. 偏离规格及理由

### 7.1 没有用 CategoryModule 枚举全部主题

这是有意遵守而非偏离：规格要求用 sitemap 差集，且实测一个分类就有 2,128 页。  
CategoryModule 仍完整实现为“指定 category + 指定 page”诊断函数，测试也覆盖，但正常 CLI 不做全量翻页。

### 7.2 category 差集任务由 ForumStart 确认

category sitemap 只给 id。ForumStart 一次即可取得全部分类的 title/description/counts；没必要为 14 个 id 再打 14 次 CategoryModule。只有 ForumStart 明确返回该 id 且分类批应用成功，category 任务才删除。

### 7.3 `meta.irreconcilable` 不能表达非页面 forum 目标

`meta.forum_scan_task` 有 `stable_count`，但现有 `meta.irreconcilable` 主键固定为：

```text
PRIMARY KEY(page_id, kind)
page_id NOT NULL
```

thread/category 目标没有 page_id，不能伪造页面身份写进去。因此：

- 页级 `forum` / `discussion` 已完整实现 stable_count≥3 → `meta.irreconcilable`；
- 非页面 thread/category 任务保留 stable hash 与 1h→4h→24h→7d 退避，但无法写 `meta.irreconcilable` 终态行。

没有伪造 `page_id=0/-1`。若产品需要统一终态，应新增以 `(target_kind,target_id)` 为键的 forum irreconcilable 表，或扩展现表 schema；这超出本次“按已建 schema/实际签名实现”的范围。

### 7.4 discussion 会同时出现 forum/partial 证据

这是现有 `apply_forum_batch` 的有意行为：其签名没有 `is_complete`，所以凡链接到 page 的 thread 都保守记录 `forum/partial`。采集器另写准确的 `discussion/ok`。没有把函数的保守 partial 假装成 ok。

## 8. 遇到的坑

1. 初版只考虑“显式 is_deleted 字段”，但 current-state + 软删还要求完整快照集合差。最终补为只有完整 thread 才生成 tombstone。
2. 生成 tombstone 需要读 `ingest.forum_post`，而 `ingestor_role` 原来没有论坛表 SELECT。最终只补 SELECT，DML 仍为 false，并实际重跑 `9002_grants.sql`，其 8 负向 + 2 正向自检通过。
3. 页级 `forum` 与 `discussion` 是独立任务/证据 kind；合并会让 `UNIQUE(page_id,kind)` 的语义消失。实现中保留两条。
4. `apply_forum_batch` 会把同 run 的 forum page_scan 写成 partial；`scan_task(kind=forum)` 的完整成功路径必须在事务完成后恢复 forum/ok。
5. 一次最终复跑前在 `syncer2/` 下误写成 `source backend/.env`，没有成功投递任务；CLI 仍执行了启动探针并正常报告 `claimed=0`。该请求已计入总预算，没有隐瞒。
6. 第二次真实复跑的 mihomo 连接采样报 `DIRECT`。它可能是控制器对活连接的真实命中，也可能是采样窗口命中另一条目标连接；无论哪种都不应忽略。

## 9. 剩余问题与阻塞判断

### 9.1 代理环境告警（上线前应处理）

最终样本期间：

```text
proxyUrl=http://127.0.0.1:7891
mihomo /connections chains[0]=DIRECT
```

HTTP 客户端没有绕过代理，但 mihomo 的目标连接归因提示代理规则可能把 Wikidot 流量送到了 DIRECT。任务规格明确没有直连降级路径，因此建议正式周期调度前：

1. 检查 `scp-wiki-cn.wikidot.com` 的规则命中；
2. 确认负载均衡组内不存在 DIRECT；
3. 用 `--proxy-check require` 再跑 `npm run forum:probe`；
4. require 通过后再放开日常 M5。

这不阻塞代码构建/测试/端到端落库，但应视为**生产调度环境阻塞项**。

### 9.2 非页面 forum target 的 irreconcilable 终态

见 §7.3。当前不阻塞正常成功任务，只影响连续稳定失败后的终态分流表达。

### 9.3 冷启动积压

`meta.forum_scan_task` 当前约 86,917 条。单次短进程与每日约 150 请求预算意味着不能“一把跑完”。需要运维按预算分时消化；实现本身不会绕过 `--limit≤50` 或 category 全遍历来抢进度。

## 10. 最终结论

M5 代码、队列消费、匿名链路、严格解析、软删、身份归一、page_id 反解、R10、时区与证据链均已实现并通过类型检查、9 个 M5 测试、185 个全量测试及真实小样本。  
代码层无阻塞；正式调度前唯一必须由环境侧确认的是 mihomo `DIRECT` 告警。
