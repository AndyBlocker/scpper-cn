# M8 · projector L2 实现与验收报告

> 模块：`SPEC-projector.md` §1  
> 工作树：`/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation`  
> 目标运行时：TypeScript ESM / Node 22 / PostgreSQL  
> 验收日期：2026-07-27（Asia/Shanghai）  
> 状态：**实现完成；M8 专项测试、全量 TypeScript 测试、真实 v2 重建与生产站网络小样本均已执行**

## 1. 结论先行

本次完成了规格 §1.3 的全部八张 L2 投影：

1. `serve.page_stats`
2. `serve.vote_daily`
3. `serve.user_attr_daily`
4. `serve.user_page`
5. `serve.user_stats`
6. `serve.user_vote_interaction`
7. `serve.user_tag_preference`
8. `serve.page_daily_stats`

游标统一读取 `meta.safe_seq_watermark()`，游标推进统一调用
`meta.advance_projection_cursor()`；运行代码没有读取
`fact_seq.last_value` / `pg_sequence_last_value()` 充当水位。每张投影独立事务、独立
advisory lock，写入前先调用 `meta.assert_writes_allowed('projection')`。

四条高风险口径已通过真实数据库回归：

- `user_stats.votes_cast_up/down` 只从 `serve.vote_current` 计算，是“一人一页一张当前票”的
  **状态计数**，没有把历史事件条数冒充当前投票数。
- `vote_daily`、`user_attr_daily`、`page_daily_stats` 全部排除
  `time_precision='bootstrap'`；`page_stats`、`user_stats.votes_cast_*` 等总量口径仍计入
  bootstrap 真票。
- `page_daily_stats` 重建没有 `TRUNCATE`、`DELETE` 或 `views = ...`；测试先把
  `views=77`，再执行显式重建，结果仍为 77。
- `user_page` / `user_stats` 的已删页作品口径做成显式配置开关，默认 `false` 与 v1 一致；
  `false` / `true` 两条路径都在真实 PostgreSQL 事务夹具中跑通。

实现过程中还发现并补上了一个原 schema/写路径缺口：`page_attr_history` 没有 `fact_seq`，
而纯 tags/category 更新原先也不会改变 `page_current.cursor_seq`，导致
`user_tag_preference` 的增量窗口永远看不到纯标签变化。现在
`ingest.apply_page_meta()` 会在真实元数据发生变化时分配受 ingest gate 保护的全局 seq，
并推进 `page_current.cursor_seq`。新增回归用例已证明纯 tags + hidden_tags 变化会触发三名
受影响 voter 的六条 `(voter, tag)` 重算。

## 2. 权威输入与边界

实现前按用户要求依次完整阅读：

1. `SPEC-collector.md`
2. `SPEC-projector.md`
3. `syncer2/README.md`
4. `syncer2/src/` 中现有 HTTP、DB、sitemap、CLI 范式
5. `syncer2/migrations/` 的 DDL、登记和函数

数据库签名没有凭代码猜测，而是在实际 `scpper-v2` 用 `pg_proc` / `pg_get_function_*`
查询。验收连接身份如下：

```text
 current_database | current_user | current_setting
------------------+--------------+-----------------
 scpper-v2        | user_dxzbdi  | Asia/Shanghai
```

实际函数签名：

```text
ingest.apply_page_meta(
  p_page integer,
  p_attrs jsonb,
  p_observed timestamp with time zone,
  p_source text,
  p_run bigint,
  p_wikidot_id integer
) -> jsonb

meta.safe_seq_watermark(p_retry integer, p_wait_ms integer) -> bigint
meta.advance_projection_cursor(p_projection text, p_to_seq bigint) -> bigint
meta.assert_writes_allowed(p_domain text) -> void
```

本次只向 `scpper-v2` 写入/重建。对生产站的请求是 `--dry-run`，不连接数据库。
没有对 `scpper-cn`、`scpper-syncer` 或 `scpper_user` 做任何写操作，也没有修改受保护的
`/home/andyblocker/scpper-cn` checkout。

## 3. 文件清单

### 3.1 新增

- `src/project/types.ts`
  - 八张投影的封闭词表、投影名归一化、窗口和结果类型。
- `src/project/sql.ts`
  - 复用 `store/db.ts` 的轻量查询门面；唯一切日 SQL 和 rating delta 表达式。
- `src/project/pageStats.ts`
  - `page_stats` 当前态聚合。
- `src/project/daily.ts`
  - `vote_daily`、`user_attr_daily`、`page_daily_stats`。
- `src/project/userPage.ts`
  - `user_page` 和四层 `effective_created_at`。
- `src/project/userStats.ts`
  - `user_stats` 两种投票口径、作品分类、排名、活动、论坛计数。
- `src/project/social.ts`
  - `user_vote_interaction`、`user_tag_preference` 的受影响键增量重算。
- `src/project/runner.ts`
  - 锁、冻结、水位、登记校验、事务、游标推进和依赖编排。
- `src/cli/project.ts`
  - 单次/常驻 CLI、心跳自杀、lag 告警、单行 JSON 摘要。
- `tests/projector.test.ts`
  - M8 专项数据库测试。
- `docs/build-report-M8.md`
  - 本报告。

### 3.2 修改

- `src/config.ts`
  - 增加严格布尔配置 `projectIncludeDeletedPages`。
- `.env.example`
  - 增加 `SYNCER2_PROJECT_INCLUDE_DELETED_PAGES=false` 与待决策说明。
- `package.json`
  - 增加 `project` / `project:rebuild` 命令。
- `README.md`
  - 增加 M8 模块、运行方式、环境变量和待产品裁决项。
- `migrations/0006_functions.sql`
  - `apply_page_meta()` 给真实页面元数据变化提供 `page_current.cursor_seq` 信号。

没有另建 HTTP 层或 DB 层。投影全部复用 `src/store/db.ts` 的 pool、事务、查询、时区守卫。

## 4. 游标、锁与事务

`runProjection()` 对每张表执行下列顺序，所有步骤处于同一个数据库事务：

1. `pg_advisory_xact_lock(hashtextextended(projection, ...))`
2. `meta.assert_writes_allowed('projection')`
3. `SELECT ... FROM meta.projection_cursor ... FOR UPDATE`
4. 校验 `rebuild_from = obj_description(table, 'pg_class')`
5. `SELECT meta.safe_seq_watermark()`
6. 折叠 `(last_seq, watermark]`
7. `SELECT meta.advance_projection_cursor(projection, watermark)`
8. 提交

这有三层防漏：

- 每投影 advisory lock 防止两个 projector 重叠消费同一窗口。
- 安全水位函数用 ingest gate 屏障处理“先取 seq、后提交”和乱序提交。
- `advance_projection_cursor()` 内部再次读取安全水位并钳制，不信任调用方给出的数字。

`safe_seq_watermark()` 返回 `NULL` 时，本轮返回 `status='busy'`，不猜水位、不写投影、
不推进游标。游标高于当前水位时也拒绝继续运行。

实际八行登记全部存在，且 `rebuild_from` 与表注释逐字一致：

```text
serve.page_daily_stats       comment_matches=t
serve.page_stats             comment_matches=t
serve.user_attr_daily        comment_matches=t
serve.user_page              comment_matches=t
serve.user_stats             comment_matches=t
serve.user_tag_preference    comment_matches=t
serve.user_vote_interaction  comment_matches=t
serve.vote_daily             comment_matches=t
```

显式 `--rebuild` 时，runner 先把该投影 cursor 归零，再从 seq 1 重放。普通表由 handler
`TRUNCATE`；`page_daily_stats` 是唯一例外，见 §6.8。

实际角色权限也做了目录级复核：

```text
projector_role 对八张 L2 表的 INSERT/UPDATE/DELETE/TRUNCATE：全部 true
projector_role EXECUTE meta.safe_seq_watermark(...)：true
projector_role EXECUTE meta.advance_projection_cursor(...)：true
projector_role EXECUTE meta.assert_writes_allowed(...)：true
```

## 5. 时间与 bootstrap

所有投票逐日表复用同一个 `VOTE_DAY_SQL`，没有各写一套：

```sql
CASE
  WHEN ve.time_precision IN ('exact', 'observed')
    THEN (ve.occurred_at AT TIME ZONE 'Asia/Shanghai')::date
  WHEN ve.time_precision IN ('day', 'clamped')
    THEN (ve.occurred_at AT TIME ZONE 'UTC')::date
END
```

调用方必须同时写：

```sql
AND ve.time_precision <> 'bootstrap'
```

因此：

- `exact` / `observed` 在上海时间 00:00 切日；
- `day` / `clamped` 把 UTC timestamp 内承载的日历日原样取回；
- `bootstrap` 没有 CASE 分支且被 WHERE 双重挡住。

专项夹具使用同一个 UTC 时刻 `2026-01-01T16:30:00Z`：

- `precision='day'` 被投到 `2026-01-01`；
- `precision='exact'` 被投到上海日 `2026-01-02`；
- `2022-05-25` 的 bootstrap 票没有出现在任何逐日投影。

## 6. 八张投影逐项实现

### 6.1 `serve.page_stats`

增量窗口先找受影响 `page_id`，然后从 `serve.vote_current` 重算该页：

- `uv = count(direction > 0)`
- `dv = count(direction < 0)`
- `like_ratio = uv / (uv + dv)`
- `controversy = 4 * uv * dv / (uv + dv)^2`
- `wilson95` 使用 `z=1.96` 的 Wilson 下界

零票页的三个浮点指标均为 0。bootstrap 票作为真实当前票参与总量，这是规格要求。

### 6.2 `serve.vote_daily`

受影响 page 按全历史重放，而不是只对窗口当天做加法；原因是回填过去某日的事实会改变其后每一天
的 `cum_rating`。

- `up`：事件 `new_direction > 0`
- `down`：事件 `new_direction < 0`
- `revoked`：`kind='revoke'`
- `rating_delta = COALESCE(new_direction,0)-COALESCE(old_direction,0)`
- `cum_rating`：按 page/day 的窗口累计和

增量时只删除并重写受影响 page；重建时清表重放。

### 6.3 `serve.user_attr_daily`

只使用 `serve.attribution_current.is_display=true`。受影响 user 来自两路：

- 窗口内 vote event 当前对应的 display actor；
- 窗口内 attribution event 的 actor（保证被移除的旧作者也能删掉旧折叠）。

按 user/day 写 `up`、`down`、`rating_delta`、`cum_rating`。bootstrap 整体排除。

### 6.4 `serve.user_page`

从当前 display attribution 聚合每个 `(user,page)` 的 roles，投影时一次性物化：

1. AUTHOR/SUBMITTER 优先 `page_current.first_published_at`，再用 PAGE_CREATED revision；
2. attribution `at_date` 按上海日历转换；
3. 该 actor 在该页的首次 revision；
4. 页面首次发布时间 / PAGE_CREATED revision 兜底。

`group_key` 沿用 v1 当前分类规则，值为 `short_stories` / `anomalous_log` / `other` /
`author` / `translator`。

该表每轮在事务内完整刷新。理由：

- “是否纳入已删页”是运行时开关，切换后必须立即改变全表口径；
- `page_attr_history` 没有原生 fact seq，虽然新写入已补 `page_current.cursor_seq` 信号，
  完整刷新仍能兼容既有历史数据。

### 6.5 `serve.user_stats`

每轮事务内完整刷新，因为：

- 含全局排名，一个用户变化会影响其他用户 rank；
- `ingest.forum_post` 当前没有 fact seq；
- 它依赖同轮先完成的 `serve.user_page`。

关键口径：

- `votes_cast_up/down`：只读 `serve.vote_current`，是状态计数；
- `votes_received_up/down`：按 `serve.user_page` 当前作品集合折叠当前票；
- `page_count`、`total_rating`、作品分组 rating/count：按 `serve.user_page`；
- `forum_post_count`：当前未删论坛帖；
- `first_activity_*` / `last_activity_*`：
  `vote_event ∪ revision ∪ attribution_event ∪ forum_post`，不按页面 live/deleted 过滤；
- bootstrap 票不参与首末活动时间，但仍参与当前投票总量；
- 总榜与六类作品榜在完整刷新后统一计算，分数相同用 `user_id` 稳定打破并列。

运行单张 `user_stats` 时，CLI 会自动把 `user_page` 加为前置依赖。

### 6.6 `serve.user_vote_interaction`

普通轮绝不做全表重算。窗口只构造受影响 `(voter, author)`：

- vote event × 当前 display attribution；
- attribution event × 当前非零 vote。

然后仅删除并重算这些 pair。显式运维 `--rebuild` 才清表并扫描全体当前 pair。
计数全部来自 `vote_current`，不会复现 v1 因历史版本重复而虚高 17.6% 的问题。

### 6.7 `serve.user_tag_preference`

普通轮先找受影响 voter：

- 窗口内 vote event 的 voter；
- `page_current.cursor_seq` 在窗口内的页面上的所有当前 voter。

然后仅删除并重算这些 voter 的全部 tag。tag 直接 `unnest(page_current.tags)`，所以包含
采集层已合并进去的隐藏标签。

这里是本次额外修补 `apply_page_meta()` seq 信号的直接消费者。没有该信号时，第二条增量路径
虽然代码存在，纯标签变化却永远无法命中。

### 6.8 `serve.page_daily_stats`

可再生列：

- `votes_up`
- `votes_down`
- `unique_voters`
- `revisions`

不可再生列：

- `views`

重建不是清表，而是：

1. 只把四个可再生列归零；
2. 保留所有已有行和 `views`；
3. 从 vote/revision 事实重算；
4. `INSERT ... ON CONFLICT DO UPDATE` 只列出四个可再生列和 `updated_at`。

源代码中没有以下任何形态：

```text
TRUNCATE serve.page_daily_stats
DELETE FROM serve.page_daily_stats
views = ...
```

测试把某日预置为：

```text
views=77, votes_up=9, votes_down=8, unique_voters=7, revisions=6
```

显式重建后：

```text
date=2026-01-01, views=77, votes_up=0, votes_down=1,
unique_voters=1, revisions=1
```

这同时验证了 views 保留和四列可重建。

## 7. 页面元数据 seq 信号修补

### 7.1 根因

`user_tag_preference` 的设计是用 `page_current.cursor_seq` 找“标签变化影响到的 voter”。
但原 `apply_page_meta()` 只有 slug rename 会写带 seq 的 `page_life_event`；单纯
tags/category/first_published_at 更新只写无 seq 的 SCD2/current 表。

后果是：

1. 页面标签真实改变；
2. `page_current.tags` 已是新值；
3. 没有任何 fact seq 表示这次变化；
4. projector cursor 正常前进；
5. 该页 voter 的 tag 偏好永久保持旧值。

这是静默漏投影，不能靠“定期 rebuild”掩盖。

### 7.2 修复

`apply_page_meta()` 现在：

- rename 时复用 `page_life_event INSERT ... RETURNING seq`；
- 其他真实 SCD2 变化，或首次补入 `first_published_at` 时，调用
  `nextval('ingest.fact_seq')`；
- 把该 seq 以 `GREATEST` 写入 `page_current.cursor_seq`；
- 状态未变化时仍是零 seq、零额外信号；
- 函数在分配 seq 之前已经调用 `meta.ingest_gate_open()`，所以仍受
  `safe_seq_watermark()` 屏障保护。

该 seq 可能是“没有单独事实行的序列空洞”，但它不是业务事实 ID，而是全局提交顺序信号；
PostgreSQL sequence 本来就允许回滚空洞。投影只依赖顺序和 gate，不依赖序列连续。

### 7.3 回归

事务夹具执行：

1. 页面已有三名当前 voter；
2. 只调用 `apply_page_meta(tags=['projector-signal'],
   hidden_tags=['_projector-hidden'])`；
3. 断言 `page_current.cursor_seq` 大于之前值和已插入事实最大 seq；
4. 只给 `projectUserTagPreference()` 传这个单 seq 窗口；
5. 断言 `affectedKeys=3`、`rowsWritten=6`；
6. 断言 downvoter 得到两条：

```text
_projector-hidden  up=0 down=1
projector-signal   up=0 down=1
```

`0006_functions.sql` 已通过 `apply.sh --only 0006_functions.sql` 应用到明确校验过的
`scpper-v2`。迁移执行器输出的受保护数据库闸、对象计数和 PUBLIC 权限负向自检均通过：

```text
[apply.sh] 目标库: scpper-v2
[apply.sh] ✓ 0006_functions.sql
public_executable = 0
[apply.sh] 全部迁移已应用到 scpper-v2
```

## 8. 已删页作品待决开关

配置：

```text
SYNCER2_PROJECT_INCLUDE_DELETED_PAGES=false
```

CLI 可临时覆盖：

```bash
npm run project -- --include-deleted-pages
npm run project -- --exclude-deleted-pages
```

两个 CLI 参数互斥，同时传入会失败。环境变量使用严格布尔解析：
`true/false`、`1/0`、`yes/no`、`on/off`；其他值抛 `ConfigError`。

开关影响：

- `user_page` 是否包含 `page_current.status='deleted'` 的作品；
- `user_stats` 的作品数、作品评分、分类评分、收票数和对应排名。

开关不影响：

- `user_stats.votes_cast_*`（用户当前投出的票，与作品归属无关）；
- `first_activity_*` / `last_activity_*`（规格要求始终包含已删页活动）。

默认 `false` 与 v1 一致。**产品尚未决定最终口径，代码没有替产品做决定。**

## 9. CLI 与运行模型

命令：

```bash
npm run project
npm run project -- --projection page_stats
npm run project -- --projection user_stats
npm run project:rebuild
npm run project -- --watch --interval-seconds 30 --stale-minutes 10
```

默认单次运行、完成即退出，适合 cron/PM2 cron。`--watch` 是可选常驻模式：

- 每轮输出 stderr 心跳；
- `projection lag > 60s` 立即 warn；
- 连续指定分钟没有成功轮次则主动抛错退出，让 PM2/systemd 重启；
- `--rebuild` 禁止与 `--watch` 同时使用；
- stdout 只保留最终单行 JSON，日志全部走 stderr。

每张投影独立事务。因此一张表失败不会把已成功提交的另一张表“假装回滚”；失败表自身的
数据写入和游标则一起回滚。

## 10. 自动化测试

### 10.1 M8 专项

命令：

```bash
node --import tsx/esm --test --test-concurrency=1 \
  --test-reporter=spec tests/projector.test.ts
```

实际结果：

```text
tests 7
suites 3
pass 7
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 634.656124
```

覆盖：

1. 八张投影清单和非法投影名负向；
2. `user_stats` 自动补 `user_page` 依赖；
3. 八行登记与 COMMENT 逐字一致、安全水位不越过 sequence；
4. projection freeze 以 SQLSTATE `PGF01` 在写入前拒绝；
5. 纯页面元数据变化获得 seq 并触发 tag 增量；
6. 精度切日、bootstrap 排除、Wilson/争议度、当前交互、隐藏 tag；
7. `page_daily_stats.views=77` 经显式重建保持；
8. deleted-page 开关 false / true 两种口径。

M8 不新增解析器，所以“合法空解析结果与解析失败可区分”的解析类负向用例在本模块不适用。
本模块仍对非法投影名、冻结、登记漂移和配置冲突提供负向路径。仓库已有解析器的空/失败区分
由各采集模块测试继续覆盖。

### 10.2 类型检查

实际执行：

```text
npx tsc --noEmit                  PASS
npx tsc -p tsconfig.tests.json    PASS
```

### 10.3 全量仓库测试

命令：

```bash
npm test
```

最终实际结果：

```text
tests 205
suites 44
pass 205
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 31342.309272
```

### 10.4 数据库 smoke 的当前环境结果

修改 `apply_page_meta()` 后额外运行了完整 `migrations/smoke_test.sql`。结果是：

```text
用例总数 296
通过 295
失败 1

失败：
S7 / I8: revision_count = count(ingest.revision)
```

只读复核显示当前 `scpper-v2` 有 103 页的 `page_current.revision_count` 与已摄入
`ingest.revision` 行数不同。M8 不写这两个字段/事实，该失败不在 M8 写集内；测试文件因异常
断开连接而回滚，没有留下 smoke 夹具。不能把本次 smoke 记成全绿，因此在此明确列出。

专项 `apply_page_meta` 回归、M8 全重建、M8 不变式和全量 TS 测试均为绿色。后续若要求当前
共享 v2 的全局 smoke 也必须 296/296，需要由修订采集/回填任务先收敛这 103 页，不能在
projector 中篡改 L1 `revision_count` 来“修测试”。

## 11. 生产站真实小样本（≤50 请求）

命令：

```bash
npm run -s tier1:sample
```

这是生产 wikidot 的真实 ListPages/AMC 小样本，使用现有 `http/client.ts`，不连数据库、
不写任何表。最终一轮实际只发 **3 请求**；本任务中两次验证累计 6 请求，仍远低于 50。

启动输出：

```text
2026-07-27T14:07:07.632Z [info] [tier1-scan:http] client 就绪 {"proxy":"http://127.0.0.1:7891","userAgent":"scpper-cn-syncer2/0.1 (+https://scpper.cn; contact: me@mer.dev)","referer":"https://scp-wiki-cn.wikidot.com/","timeoutMs":30000,"maxAttempts":3,"breaker503":5,"breakerReset":5}
2026-07-27T14:07:07.633Z [info] [tier1-scan:http] assertHeaders 通过 {"userAgent":"scpper-cn-syncer2/0.1 (+https://scpper.cn; contact: me@mer.dev)","referer":"https://scp-wiki-cn.wikidot.com/"}
2026-07-27T14:07:07.633Z [warn] [tier1-scan] --dry-run：不连库、不写 meta/ingest/serve，只跑生产网络与解析校验
2026-07-27T14:07:09.799Z [info] [tier1-scan:probe] AMC POST 探针通过 {"attempts":1,"categories":42,"ms":773}
```

实际单行摘要：

```json
{"ok":false,"status":"partial","runId":null,"durationMs":7992,"pagesEnumerated":500,"remoteTotal":36173,"expectedBatches":145,"requestedBatches":2,"batchesFailed":0,"validation":{"selectorLiteralFree":true,"parseDropWithinLimit":true,"indexContinuous":true,"fiveStarAbsent":true,"totalStable":true,"pagerMatchesRemoteTotal":true,"duplicateFullnames":0,"duplicateIndexes":0,"expectedLastIndex":36173,"observedLastIndex":500,"firstTotal":36173,"lastTotal":36173,"reasons":["小样本主动省略 143 批"]},"diff":{"bootstrap":true,"newFullnames":500,"changed":0,"votesChanged":0,"revisionsChanged":0,"forumChanged":0,"tagsChanged":0,"unchanged":0,"sampleNew":["scp-cn-4710","scp-cn-4813","scp-743-jp","scp-l749","37-site-rules","ayers-array","scp-114-ko","scp-l037","a-dove-in-a-chicken-pen","scp-l079","wikidot-data-form-tech","scp-l426","log-of-anomalous-items-cn:01874","scp-8273","fragment:scp-8273-2","we-all-fall-down","scp-cn-4835","anna-speech","experiment-log-914-cn:00066","wanderers:flamesa-lost"]},"persistence":{"ok":true,"bootstrap":true,"resolvedPages":0,"unresolvedPages":500,"pendingEnqueued":0,"pendingTruncated":0,"pageScansWritten":0,"creatorsEnsured":0,"creatorsFailed":0,"deletedCreatorPages":0,"metadataApplied":0,"metadataFailed":0,"tagChangesApplied":0,"tasksEnqueued":0,"taskSignals":{},"slugResolution":"dry-run","errors":[]},"parseHealth":null,"snapshotAdvanced":false,"http":{"requests":3,"attempts":3,"retries":0,"wireBytes":59104,"decodedBytes":266254,"statusBuckets":{"200":3},"breakerOpen":false},"egress":{"exitIps":["155.254.126.141"],"nodes":["🇭🇰 香港 | 9929 CMIN2"],"probes":1,"probeFailed":0,"failureByNode":{}}}
```

`ok=false/status=partial` 是小样本主动只取 2/145 批的预期退出语义，不是网络或解析失败：

- 500 页，远端声明总数 36,173；
- 2 批请求全部成功，0 failed batch；
- selector、drop rate、连续索引、总数稳定、pager 对账全部通过；
- HTTP 3 requests / 3 attempts / 0 retry / 3×200；
- 503 breaker 未打开；
- proxy、非空 UA、非空 Referer 均在启动日志中可见。

## 12. 真实 `scpper-v2` projector 重建

最终验收命令：

```bash
npm run -s project:rebuild
```

实际结果 `ok=true`，八张表在 253ms 内完成；水位 595361：

```text
projection                    affected  written  deleted  advanced
serve.page_stats                   104      104        -    595361
serve.vote_daily                   104      104        -    595361
serve.user_attr_daily                0        0        -    595361
serve.user_vote_interaction          0        0        -    595361
serve.user_tag_preference          478     5010        0    595361
serve.page_daily_stats             104      104        -    595361
serve.user_page                      0        0        -    595361
serve.user_stats                   501      501        -    595361
```

实际 JSON 摘要：

```json
{"ok":true,"startedAt":"2026-07-27T14:07:29.846Z","finishedAt":"2026-07-27T14:07:30.099Z","durationMs":253,"rebuild":true,"includeDeletedPages":false,"projections":[{"projection":"serve.page_stats","status":"ok","previousSeq":576109,"fromSeq":1,"watermark":595361,"advancedTo":595361,"rebuild":true,"includeDeletedPages":false,"affectedKeys":104,"rowsWritten":104,"lagBeforeSeconds":118,"durationMs":21},{"projection":"serve.vote_daily","status":"ok","previousSeq":576109,"fromSeq":1,"watermark":595361,"advancedTo":595361,"rebuild":true,"includeDeletedPages":false,"affectedKeys":104,"rowsWritten":104,"notes":["time_precision=bootstrap 已整体排除"],"lagBeforeSeconds":118,"durationMs":15},{"projection":"serve.user_attr_daily","status":"ok","previousSeq":576109,"fromSeq":1,"watermark":595361,"advancedTo":595361,"rebuild":true,"includeDeletedPages":false,"affectedKeys":0,"rowsWritten":0,"lagBeforeSeconds":118,"durationMs":9},{"projection":"serve.user_vote_interaction","status":"ok","previousSeq":576109,"fromSeq":1,"watermark":595361,"advancedTo":595361,"rebuild":true,"includeDeletedPages":false,"affectedKeys":0,"rowsWritten":0,"lagBeforeSeconds":118,"durationMs":10},{"projection":"serve.user_tag_preference","status":"ok","previousSeq":576109,"fromSeq":1,"watermark":595361,"advancedTo":595361,"rebuild":true,"includeDeletedPages":false,"affectedKeys":478,"rowsWritten":5010,"rowsDeleted":0,"notes":["tag 直接读取 page_current.tags（包含隐藏标签）","仅显式 rebuild 做全表重放"],"lagBeforeSeconds":118,"durationMs":115},{"projection":"serve.page_daily_stats","status":"ok","previousSeq":576109,"fromSeq":1,"watermark":595361,"advancedTo":595361,"rebuild":true,"includeDeletedPages":false,"affectedKeys":104,"rowsWritten":104,"notes":["views 未读取、未赋值、未删除；重建未使用 TRUNCATE","bootstrap 票已从 votes_*/unique_voters 整体排除"],"lagBeforeSeconds":118,"durationMs":15},{"projection":"serve.user_page","status":"ok","previousSeq":576109,"fromSeq":1,"watermark":595361,"advancedTo":595361,"rebuild":true,"includeDeletedPages":false,"affectedKeys":0,"rowsWritten":0,"notes":["user_page 排除已删页作品（默认，与 v1 一致）","四层 effective_created_at 已在投影时物化","为保证已删页开关切换立即生效，本投影每轮事务内完整刷新"],"lagBeforeSeconds":118,"durationMs":7},{"projection":"serve.user_stats","status":"ok","previousSeq":576109,"fromSeq":1,"watermark":595361,"advancedTo":595361,"rebuild":true,"includeDeletedPages":false,"affectedKeys":501,"rowsWritten":501,"notes":["votes_cast_up/down 是 vote_current 状态计数，不是 vote_event 事件计数","作品评分/收票排除已删页（默认 v1 口径）；首末活动仍包含已删页","bootstrap 票不参与首末活动时间；总量状态计数仍计入","forum_post 无 fact_seq，因此 user_stats 每轮事务内完整刷新"],"lagBeforeSeconds":118,"durationMs":47}]}
```

lag 118 秒来自全量测试持续分配/回滚 seq 后尚未跑 projector；CLI 按规格对每张表都打印了
`projection lag 超过 60 秒`。重建后游标已追到同一安全水位。

## 13. 最终数据库不变式

重建后立即执行只读对账：

```text
over_watermark             = 0
behind_watermark           = 0
rebuild_drift              = 0
min_cursor                 = 595361
max_cursor                 = 595361
safe_watermark             = 595361
page_stats_symmetric_diff  = 0
user_cast_state_mismatch   = 0
bootstrap_only_vote_days   = 0
```

含义：

- 八张游标没有越过或落后于安全水位；
- 八条 rebuild_from 没有和表注释漂移；
- `page_stats (uv,dv)` 与 `vote_current` 双向集合差为零；
- `user_stats.votes_cast_*` 与 `vote_current` 状态计数不一致用户为零；
- `vote_daily` 中只有 bootstrap 支撑的假日行数为零。

最终行数：

```text
page_daily_stats       104
page_stats             104
user_attr_daily          0
user_page                0
user_stats             501
user_tag_preference   5010
user_vote_interaction    0
vote_daily             104
views_sum                0
```

当前 v2 小样本尚无 attribution，因此 `user_page` / `user_attr_daily` / interaction 的真实样本行数
是 0；这不是跳过。三者的非零路径已由事务夹具覆盖。当前库尚未摄入 page view snapshot，
所以 `views_sum=0`；“非零 views 经 rebuild 保留”由 `views=77` 的数据库回归覆盖。

## 14. 偏离规格之处及理由

### 14.1 `user_page` 普通轮完整刷新

规格允许当前态聚合自行选择增量方式，没有禁止 `user_page` 全刷。本实现每轮完整刷新，而不是
维护受影响 `(user,page)`：

- 已删页开关切换必须立即改变全表；
- 历史 `page_attr_history` 无原生 seq；
- 当前 v2 规模下实际刷新仅数毫秒；
- 用更多扫描换取口径切换和历史兼容的确定性。

### 14.2 `user_stats` 普通轮完整刷新

`user_stats` 含全局 rank，且 `forum_post` 没有 fact seq。若在“水位没有变化”时直接 idle，
论坛新帖会静默漏进统计。故每轮刷新，实际 501 用户约 47–53ms。

这是性能上的保守实现，不是语义降级。若未来数据量要求增量化，应先给 forum 当前态增加可靠
seq，并设计全局 rank 的受影响集合；不能只用当前 fact_seq 窗口假装完整。

### 14.3 默认使用单次进程

规格说 L2 “可以”常驻，不要求只能常驻。本实现默认单次运行，另提供完整 `--watch` 心跳自杀。
这更适合仓库现有短进程调度范式，同时保留规格要求的常驻能力。

### 14.4 额外修改 `0006_functions.sql`

任务文件范围写的是 `src/project/*.ts + src/cli/project.ts`，但不修 `apply_page_meta()` 就无法
满足 tag 偏好增量“页面标签改变后最终必达”的正确性。该修改是 M8 游标信号的必要接线，
已保持零状态变化零 seq，并用真实函数回归证明。

## 15. 遇到的坑

1. **不能从 `fact_seq.last_value` 推水位。** 全量 T7 多连接测试再次证明：
   未提交写者持 seq 时，last_value 已越过它；安全函数会返回 NULL 或下钳。
2. **当前表变化不等于有事件窗口。** tag 在 `page_current` 里已经变了，不代表 projector
   知道“何时变的”；这正是 page meta seq 信号缺口。
3. **逐日回填不能只加当天。** 回填旧日事件会改变之后所有 `cum_rating`，所以受影响 page
   必须重放全历史。
4. **attribution removed 不能只看 current。** 受影响 user 还必须从
   `attribution_event.actor_id` 取，否则旧作者残留日统计。
5. **page_daily 重建不能通过删行表达“事实已无”。** views 守卫会拒绝，而且即使能删也会
   永久丢数据；只能把可再生列归零再逐列 upsert。
6. **共享 v2 的 sequence 会被回滚测试烧号。** 这不是事实丢失；安全游标允许跨过 gap。
   全量测试后出现 >60s lag 是预期可观测状态，最终重建已追平。
7. **完整 smoke 与模块验收不是一回事。** 当前共享 v2 的 103 页 revision_count 脏状态会让
   S7 全局不变式失败；不能为了让 M8 报告好看而由 projector 改 L1 真相。

## 16. 剩余问题与阻塞项

### 产品待决

- `user_page` / `user_stats` 是否纳入已删页作品。当前默认 `false`，两种口径均可运行，
  README 和 `.env.example` 已标明。该决策**不阻塞代码运行**。

### 数据/运维待办

- 当前共享 `scpper-v2` 有 103 页 `revision_count != count(ingest.revision)`，使完整数据库
  smoke 为 295/296。应由 revision 采集/回填或对账任务收敛，不属于 M8。
- 当前小样本没有 attribution 和 page views，真实非零规模性能仍需在 Phase 2 回填后复测。
- `user_stats` 的 `forum_post` 无 seq 由每轮完整刷新兜底；长期若表量变大，应补 schema 信号。

### 阻塞结论

M8 功能、类型检查、专项测试、全量 TS 测试、真实 v2 重建和生产站小样本均无阻塞。
唯一未裁决的是已删页作品产品口径；当前 v1 兼容默认可直接运行。

## 17. 交付约束确认

- 未执行 `git commit`。
- 未执行 `git push`。
- 未写受保护生产 checkout。
- 未写三个 v1/生产主库。
- 生产 wikidot 请求经 `http://127.0.0.1:7891`。
- 请求带非空 User-Agent 与 Referer。
- 单次真实样本 3 请求，本任务累计 6 请求，低于 50。
- `npx tsc --noEmit` 通过。
- 测试位于 `syncer2/tests/`，使用 `node:test + tsx`。
