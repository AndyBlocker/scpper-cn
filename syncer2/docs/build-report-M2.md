# M2 · 投票 Tier2 交付报告

日期：2026-07-27  
工作树：`/home/andyblocker/scpper-cn-worktrees/feat__syncer2-foundation`  
运行时：TypeScript ESM / Node 22  
目标数据库：`scpper-v2`

## 1. 完成度

M2 已完成并接入 work-queue 消费入口，覆盖：

- `pagerate/WhoRatedPageModule` 请求与 HTML 解析；
- Wikidot / Deleted / Guest / Anonymous 四类身份保留；
- 四重门控，含独立 Tier1 `rating_votes` 与 `rating` 证据；
- `Σsign(direction) == p_claimed_rating` 校验；
- `status=ok ∧ entries=0 ∧ claimed_total>0` 强制失败；
- absence 只写候选、跨 run 两次确认后才调用数据库函数转正；
- 近 90 天有投票活动页面的受限 sweep；
- 发布未满 7 天页面的 3 小时高频 `votes_full + content` 触发；
- `last_complete_vote_snapshot_at` 仅在完整票快照成功时推进，删除后冻结；
- 分档超时、超大页独立串行 lane；
- 单次最多 50 条、`FOR UPDATE SKIP LOCKED`、连续 5 页失败熔断的短进程入口；
- 解析负向用例、身份落库形状回归用例、真实生产站小样本。

无阻塞项。

## 2. 权威材料与核对顺序

按任务要求依次完整阅读并以其为唯一权威：

1. `SPEC-collector.md`
2. `SPEC-projector.md`
3. `syncer2/README.md`
4. `syncer2/src/` 现有 HTTP、DB、sitemap、CLI 范式
5. `syncer2/migrations/`

没有从 TypeScript 调用方式猜数据库函数签名。对 `scpper-v2` 用 `pg_proc` / `psql`
实际确认：

```text
ingest.apply_vote_snapshot(
  p_page integer,
  p_entries jsonb,
  p_is_complete boolean,
  p_claimed_total integer,
  p_claimed_rating integer,
  p_visible_kinds text[],
  p_observed timestamp with time zone,
  p_source text,
  p_run bigint,
  p_wikidot_id integer,
  p_absence_policy text,
  p_max_absence integer,
  p_max_absence_ratio real
)

ingest.ensure_user(
  p_kind text,
  p_wikidot_id integer,
  p_anon_key text,
  p_display_name text,
  p_username text,
  p_unix_name text,
  p_user_id integer
)

ingest.promote_revoke_candidates(
  p_min_confirmations integer,
  p_max_promote integer,
  p_max_age interval,
  p_max_page_ratio real,
  p_run bigint,
  p_source text
)
```

目标库推导严格使用任务指定方法：读取 `backend/.env` 的 `DATABASE_URL`，只把
`/scpper-cn` 替换成 `/scpper-v2`。迁移前后都查询了 `current_database()`，结果为
`scpper-v2`。

## 3. 文件清单

### 新增

- `src/collect/votes.ts`
- `src/store/workQueue.ts`
- `src/cli/work-queue.ts`
- `tests/votes.test.ts`
- `tests/fixtures/votes/mixed.html`
- `tests/fixtures/votes/empty.html`
- `tests/fixtures/votes/mismatched.html`
- `migrations/0013_vote_tier2.sql`
- `docs/build-report-M2.md`

### 修改

- `migrations/0006_functions.sql`
- `package.json`
- `.env.example`
- `src/config.ts`
- `README.md`

`cheerio` 被加入直接依赖，用于 WhoRated HTML 解析。HTTP 与 DB 没有另起一层：

- 所有站点请求继续复用 `src/http/client.ts` 和 `src/http/amc.ts`；
- 所有数据库访问继续复用 `src/store/db.ts` 的 `query()`、`withTransaction()`、
  `toPgTimestamptz()` 和时区回环自检。

## 4. WhoRated 请求与结果契约

每页请求固定为：

```text
moduleName = pagerate/WhoRatedPageModule
pageId     = ingest.page.wikidot_id
```

内部 `page_id` 从不传给远端；落库时同时把内部 `page_id` 和远端 `wikidot_id` 交给
`apply_vote_snapshot` 的身份守卫。

响应按规格用下标配对：

```text
span.printuser
span[style^='color']
```

方向词表严格为 `+ => 1`、`- => -1`。未知方向、用户/方向数量不等、空 body、
selector 字面量残留、WAF/错误页结构、缺 h2 或 column-count 锚点都返回
`status='failed'`，不会退化成空数组。

采集批量返回 `Map<pageId, VoteScanOutcome>`。成功、partial、失败目标均必须有 Map 行；
收尾还有一次缺项自检，未来重构漏掉 `set()` 时会补成显式 failed。

## 5. 四类身份保留

解析层使用判别联合：

| 远端类型 | 保留材料 | 解析去重键 | DB kind |
|---|---|---|---|
| WikidotUser | 数字 id、name、unixName | `wikidot:<id>` | `wikidot` |
| DeletedUser | 尝试读取 `data-id`、name | `deleted:<id>`；无 id 时带 ordinal 保留原行 | `deleted` |
| GuestUser | name、可见 avatar URL | `guest:<name>` | `guest` |
| AnonymousUser | 原始 IP、name | `anonymous:<ip>` | `anon` |

关键约束：

- 从未按库抽象对象的 `user.id` 去重；
- 类型是去重键的一部分；
- 多个 `id=0` 的匿名/已删行在解析层不会塌缩；
- Anonymous 没有响应原始 IP 时进 `meta.vote_quarantine`，不从显示名派生 anon key；
- Deleted 没有真实 `data-id` 时也进 quarantine，不铸造伪 actor；
- quarantine 或解析后 actor 碰撞会把 `p_is_complete` 降为 false，禁止 absence；
- Guest 沿用现有 `ensure_user` 明确记录的已知限制：无其它原始 key 时以 guest name
  形成稳定 key。它与 Anonymous 的“禁止派生键”不是同一规则。

### 为什么新增 `deleted` kind

原 schema 只有 `wikidot|guest|anon|synthetic`，无法同时做到：

1. 保留 DeletedUser 类型；
2. 复用真实 `data-id` 的稳定 actor；
3. 让 `p_visible_kinds=['wikidot']` 真正排除已删账号的 absence。

因此 `0013_vote_tier2.sql` 把当前身份类型扩为
`wikidot|deleted|guest|anon|synthetic`。同一个真实 `wikidot_id` 在
`wikidot <-> deleted` 间原地切换，不复制 actor。已用事务回滚测试确认：

```text
stable_actor |  kind   | wikidot_id
-------------+---------+------------
t            | wikidot | 2147000001
```

也就是先 `ensure_user('deleted', 2147000001, ...)` 再
`ensure_user('wikidot', 2147000001, ...)` 返回同一内部 actor。

## 6. 四重门控与空列表红线

### 6.1 调用参数

实际调用：

```sql
SELECT ingest.apply_vote_snapshot(
  p_page              => $1,
  p_entries           => $2::jsonb,
  p_is_complete       => $3,
  p_claimed_total     => $4,
  p_claimed_rating    => $5,
  p_visible_kinds     => ARRAY['wikidot']::text[],
  p_observed          => $6::timestamptz,
  p_source            => 'wikidot',
  p_run               => $7,
  p_wikidot_id        => $8,
  p_absence_policy    => 'candidate',
  p_max_absence       => 500,
  p_max_absence_ratio => 0.20::real
);
```

### 6.2 门控来源

1. `p_is_complete`
   - 请求必须成功；
   - AMC status 必须为 ok；
   - HTML 结构必须通过；
   - 不得有 selector 残留、错位、重复身份、未解析身份或 actor 碰撞。
2. `p_claimed_total`
   - 只取最近一个已完成、`status='ok'` 的 Tier1 ListPages run 中
     `page_scan.claimed_total`；
   - 不拿 `serve.page_current` 当前聚合冒充远端证据。
3. `p_claimed_rating`
   - 来自同一 Tier1 page_scan 的 `checksum_expected`；
   - TypeScript 先算一次 `Σsign` 分类；
   - 数据库 `apply_vote_snapshot` 再对准备落库的唯一 actor 集合算一次。
4. `p_visible_kinds`
   - 固定为 `ARRAY['wikidot']`；
   - Guest、Anonymous、Deleted 不参与周期性 absence diff。

partial 快照仍允许单调安全的当前票 upsert，但 `absence_allowed=false`。

### 6.3 唯一尾部坑

双层实现：

```text
AMC status=ok
∧ parsed entries=0
∧ claimed_total>0
=> 强制 failed
```

`claimed_total=NULL` 的空列表也失败，因为它没有“确实为 0 票”的独立证据。
只有 `claimed_total=0` 且 `claimed_rating=0` 才能成为完整合法空快照。

该规则在解析/门控测试和数据库现有 smoke 的 T4.6 中都有覆盖。

## 7. 撤票两次确认

WhoRated absence 不直接产生 revoke 事件：

- `p_absence_policy='candidate'`；
- 第一次完整且 checksum 通过的缺席只更新 `meta.revoke_candidate`；
- 每轮 work-queue 完成后调用
  `ingest.promote_revoke_candidates(2, 500, interval '30 days', 0.20, run_id, ...)`；
- 函数内部再检查两次确认、候选时效、当前票仍有效、单页 20% 比例熔断；
- 转正仍走 `apply_vote_observation`，不绕过 CAS/事实事件协议。

真实样本没有缺席候选，输出为：

```json
{"held":0,"skipped":0,"promoted":0,"dismissed":0,"min_confirmations":2}
```

## 8. work-queue 入口

### 8.1 消费范围和锁

当前 M2 入口只认领：

```text
votes_full
new_page_highfreq
```

不会误认领 content/revisions/forum 等其它 handler 的任务。SQL 使用：

```text
FOR UPDATE OF st SKIP LOCKED
```

并在同一条 CTE 中更新 `locked_by/locked_at/attempts`。硬上限为 50，CLI 传更大值也会
截为 50。

### 8.2 成功、失败和收敛

- ok：成功即删；
- partial/failed：保留任务并按既有 `1h -> 4h -> 24h -> 7d` 阶梯退避；
- 相同稳定结果 hash 连续 3 次仍不收敛：写 `meta.irreconcilable`；
- 发现侧重复入队只合并 reasons/提高 priority，不覆盖 attempts、stable_count、
  result_hash、锁和退避；
- HTTP breaker 打开或连续 5 页 failed：释放未处理锁并非零退出；
- 单页失败不足 5 次时进程可以正常结束，供后续调度重试，但该
  `meta.ingest_run.status` 仍记 failed，保证 `status=ok => batches_failed=0`。

### 8.3 新 client/session

每次 CLI 启动都创建新的 `HttpClient` 和连接池：

- proxy 固定由配置取得，真实运行是 `http://127.0.0.1:7891`；
- 非空 UA/Referer 在构造期和每请求前各检查一次；
- 503/429 零重试；
- 503 与连续传输重置阈值均为 5；
- 正式入口默认跑 DB 时区回环和 AMC POST 启动探针；
- 单次完成后关闭 HTTP dispatcher 与 pg pool，进程退出。

## 9. 请求预算、sweep 与短命页

### 9.1 Tier1 事件触发

并行落地的 Tier1 模块已经接通：

```text
rating 或 rating_votes 变化
=> votes_full
=> reason=listpages_rating_or_votes_changed
```

首轮无基线时不会把全站误判为变化。

### 9.2 受限 sweep

普通 sweep 必须同时满足：

- 页面仍 live；
- `vote_current.last_voted_at` 在近 90 天内；
- 页面发布至少 7 天；
- 上次完整票快照为空或已过 7 天。

因此没有全站无差别轮转。7 天是本实现为周期 sweep 选定的区间端点；规格只硬规定
“近 90 天活动页”，未给普通 sweep 的精确周期。

### 9.3 短命页高频队列

`first_published_at > now()-7 days`：

- 不进入普通 sweep；
- 进入最高优先级 `new_page_highfreq`；
- 3 小时一次，位于规格 2–4 小时区间；
- 认领本任务时同时幂等入队 content；
- 投票成功仍按队列铁律删除，下一次由 seed 在 3 小时后重新建立任务；
- `first_published_at` 尚未补齐时只用页面/任务创建时间兜底，避免任务永久常驻。

### 9.4 超时分档

| Tier1 `rating_votes` | timeout |
|---:|---:|
| NULL / 0–500 | 20 s |
| 501–2,000 | 30 s |
| 2,001–4,000 | 45 s |
| >4,000 | 60 s |

`>4,000` 的任务从普通并发集合分出，普通页完成后独占串行请求，不与其它页面争抢
dispatcher。这里是同一个短进程中的独立 lane，没有新增数据库 task kind，见偏离说明。

## 10. 数据库变更

### 10.1 `0013_vote_tier2.sql`

- 放宽 `ingest.user.kind`，加入 `deleted`；
- 调整 wikidot_id 范围约束；
- 新增 `serve.page_current.last_complete_vote_snapshot_at timestamptz`；
- 新增 live 页到期扫描索引；
- 文件自身拒绝在 `scpper-cn`、`scpper_cn`、`scpper-syncer`、`scpper_user` 执行。

### 10.2 `0006_functions.sql`

- `ensure_user` 接受带正 `wikidot_id` 的 deleted；
- 同一个稳定 wid 允许 `wikidot <-> deleted` 原地切换；
- `apply_vote_snapshot` 仅在完整/条数/空列表/Σsign 门控全过且页面仍 live 时推进
  `last_complete_vote_snapshot_at`；
- 页面一旦是 deleted，WHERE 条件不再推进该列，形成删除时冻结。

由于函数权威定义仍集中在 `0006_functions.sql`，部署必须跑完整 `apply.sh`，不能只跑
`0013`。本次已按完整序列实际执行。

### 10.3 实际迁移与冒烟

执行：

```text
./migrations/apply.sh --database-url <scpper-v2> --smoke --quiet
```

结果：

```text
✓ 0001_ingest.sql
✓ 0002_serve.sql
✓ 0003_meta.sql
✓ 0004_app.sql
✓ 0005_indexes_pgroonga.sql
✓ 0006_functions.sql
✓ 0007_meta_gaps.sql
✓ 0008_serve_embedding.sql
✓ 0009_serve_modeling_decisions.sql
✓ 0012_collector_queues.sql
✓ 0013_vote_tier2.sql
✓ 0100_backfill_gate.sql
✓ 9002_grants.sql
```

冒烟汇总：

```text
用例总数 | 通过 | 失败
---------+------+-----
296      | 296  | 0

public_executable = 0
```

函数和新增列实库复核：

```text
db        | apply_signature_ok | promote_signature_ok
----------+--------------------+---------------------
scpper-v2 | t                  | t

column_name                         | data_type
------------------------------------+-------------------------
last_complete_vote_snapshot_at      | timestamp with time zone
```

## 11. 测试

### 11.1 类型检查

```text
npm run typecheck
npm run typecheck:tests
```

均为 exit 0。等价硬要求 `npx tsc --noEmit` 已通过。

### 11.2 最终全套

```text
npm test
```

最终输出：

```text
1..42
# tests 153
# suites 39
# pass 153
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 28991.436879
```

### 11.3 M2 专项覆盖

`tests/votes.test.ts` 覆盖：

- 四类身份和类型化去重键；
- 两个无 id Deleted、两个 Anonymous 不塌缩；
- 合法空结果与空 body/WAF/结构失败可区分；
- selector 残留、方向未知、用户/方向错位；
- claimed_total 不符；
- `Σsign` 不符；
- 强制空列表 failed；
- 真 0 票的双 Tier1 背书；
- Map 每个目标必有结果；
- 超时分档与 >4,000 独立 lane；
- 7 天短命窗口和 3 小时间隔；
- `jsonb_to_recordset` 的 snake_case 落库字段形状。

`tests/work-queue.test.ts` 还覆盖：

- 50/5/SKIP LOCKED/PM2 cron 契约；
- ok 成功即删；
- 相同 hash 第 3 次进 irreconcilable；
- 发现侧重复入队不覆盖执行状态。

### 11.4 测试过程中遇到的并发假失败

第一次全套运行时测试进程并发，既有 T5/T7 同时操作全局摄入屏障，T7 的
`safe_seq_watermark()` 取得 NULL，报 7 条断言失败。M2/M4 测试当轮全部通过。

随后：

1. 单独重跑 T7：32/32 断言通过；
2. 最终以仓库测试脚本的 `--test-concurrency=1` 全套重跑：153/153。

因此它是数据库全局 advisory-lock 用例并发污染，不是 M2 回归。最终测试脚本已固定串行。

## 12. 真实生产站小样本

### 12.1 请求预算

本次明确发出的 Wikidot/AMC 请求共 **10 次**，低于要求的 50：

1. `scp-261` WhoRated 正向；
2. 一个故意错误的 pageId（观察错误行为）；
3. 一个真实 0 票页；
4. pageId=1 错误页；
5. 正确 id 相邻的错误页；
6. 定向 ListPages 第一次参数探查；
7. 定向 ListPages `_default/scp-261`，取得独立 Tier1 声称值；
8. work-queue AMC 启动探针；
9. work-queue 首次 WhoRated；
10. 修复后 work-queue WhoRated 重跑。

所有请求均经过 `http://127.0.0.1:7891`，且带非空 UA/Referer。没有对受保护数据库做写操作。

独立 Tier1 响应实际字段：

```text
fullname       = scp-261
rating         = 45
rating_votes   = 45
comments       = 7
size           = 2504
revisions      = 10
HTTP requests  = 1
HTTP attempts  = 1
HTTP status    = 200
```

### 12.2 首轮暴露并修复的真实坑

首轮 work-queue 已正确抓到：

```json
{
  "parsedEntries": 45,
  "checksum": 45,
  "identityKinds": {
    "wikidot": 45,
    "deleted": 0,
    "guest": 0,
    "anonymous": 0
  },
  "claimedTotal": 45,
  "claimedRating": 45
}
```

但落库事务失败：

```text
ensure_user: kind=wikidot 必须带正的 wikidot_id(拿到的是 <NULL>)
```

根因不是远端缺 id，而是批量 JSON 用了 `wikidotId/displayName`，SQL
`jsonb_to_recordset` 声明的是 `wikidot_id/display_name`。PostgreSQL 对缺字段静默给 NULL，
TypeScript 也无法发现这个边界。

保护行为符合预期：

- 整页事务回滚；
- 没有半写 vote_event/vote_current；
- 写入 failed page_scan；
- 任务保留并退避；
- run 89 已标 failed。

修复为 snake_case 后增加了专门回归测试，再用同一任务重跑成功。

### 12.3 最终 work-queue 原始摘要

```json
{
  "claimed": 1,
  "processed": 1,
  "ok": true,
  "partial": 0,
  "failed": 0,
  "missingTier1Claims": 0,
  "quarantined": 0,
  "identityCollisions": 0,
  "highFrequencyContentEnqueued": 0,
  "irreconcilable": 0,
  "consecutiveFailuresPeak": 0,
  "stoppedByFailureLimit": false,
  "status": "ok",
  "runId": 96,
  "durationMs": 1973,
  "seeded": {
    "highFrequencyAffected": 0,
    "sweepAffected": 0
  },
  "unprocessedReleased": 0,
  "http": {
    "requests": 1,
    "attempts": 1,
    "wireBytes": 2382,
    "decodedBytes": 29687,
    "totalDurationMs": 1709.9444120000003,
    "statusBuckets": {
      "200": 1
    },
    "retries": 0,
    "consecutive503": 0,
    "consecutiveResets": 0,
    "breakerOpen": false,
    "breakerReason": null
  },
  "samples": [
    {
      "pageId": 24,
      "wikidotId": 31681429,
      "slug": "scp-261",
      "taskKind": "votes_full",
      "status": "ok",
      "parsedEntries": 45,
      "checksum": 45,
      "identityKinds": {
        "wikidot": 45,
        "deleted": 0,
        "guest": 0,
        "anonymous": 0
      },
      "claimedTotal": 45,
      "claimedRating": 45,
      "action": "deleted",
      "error": null
    }
  ],
  "revokePromotion": {
    "held": 0,
    "skipped": 0,
    "promoted": 0,
    "dismissed": 0,
    "min_confirmations": 2
  }
}
```

### 12.4 最终数据库实测

```text
page_id | wikidot_id | slug    | rating | vote_up | vote_down | vote_revoked
--------+------------+---------+--------+---------+-----------+-------------
24      | 31681429   | scp-261 | 45     | 45      | 0         | 0

active_votes | direction_sum | last_complete_vote_snapshot_at
-------------+---------------+--------------------------------
45           | 45            | 2026-07-27 19:57:07.436+08
```

四门证据：

```text
run_id | kind  | status | claimed_total | fetched_total | checksum_ok
-------+-------+--------+---------------+---------------+------------
88     | meta  | ok     | 45            |               |
96     | votes | ok     | 45            | 45            | t

checksum_expected | checksum_actual
------------------+----------------
45                | 45
```

任务完成：

```text
remaining_sample_task = 0
```

当前样本身份分布：

```text
kind     | count
---------+------
wikidot  | 45
```

## 13. 偏离规格与理由

### 13.1 `deleted` 是 schema 扩展，不是原 schema 词表

这是为了忠实实现 §4.2 和 §4.3 visible_kinds，不是把 Deleted 并回 Wikidot 的简化。
迁移和函数修改见第 5、10 节。

### 13.2 普通 sweep 周期选为 7 天

规格硬规定活动范围是近 90 天，但没有给普通 sweep 精确间隔。实现选 7 天：

- 与 §4.6 提到的“7–14 天 sweep”下界一致；
- 仍严格排除发布未满 7 天页面；
- 不会扩大为全站轮转。

如果运维最终选 14 天，只需把常量和 SQL interval 一起调整，并同步测试。

### 13.3 超大页是独立串行 lane，不是新增数据库 kind

规格写“超大页单独队列”。当前实现会把 `rating_votes>4,000` 从普通并发数组完全分开，
在普通页之后逐页串行，保证绝不与其它页并发请求；但数据库层仍使用 `votes_full`，
没有另造 `votes_oversized` kind。

理由：

- 现有 schema 的 task kind 权威词表没有 `votes_oversized`；
- 任务优先级、失败保留、收敛状态仍应是同一条 votes_full；
- 单次短进程最多 50 条，串行 lane 已隔离网络/内存峰值。

若后续实测需要独立 PM2 并发池，应新增正式 task kind/worker selector，而不是在本次私扩一个
数据库词表。当前行为满足“不能和普通页争并发”的核心目的。

### 13.4 真实样本未覆盖生产 Guest/Anonymous/Deleted

本次生产页 `scp-261` 恰好是 45 个 WikidotUser。四类身份由固定 fixture 和
snake_case 批量落库形状测试覆盖，但没有为了凑类型额外扩大生产请求。

## 14. 遇到的坑

1. WhoRated 错 pageId 的响应与真 0 票结构相同；只能由独立 Tier1 拆穿。
2. 定向 ListPages 单页响应没有 pager，不能喂给“完整批次”解析器；小样本仅从原始双百分号
   字段读取 claims，不改变全站 parser 的“缺 pager 必须失败”红线。
3. PostgreSQL `jsonb_to_recordset` 对不存在的 JSON 字段静默给 NULL，导致 camelCase /
   snake_case 边界不报 SQL 结构错误。真实 run 发现后已加纯单测。
4. `ingest_run.status` 和进程退出状态不是同一层：未到 5 连败时进程应正常让调度器退避，
   但只要本轮有 failed 页，run 不能标 ok。
5. 全套 DB 测试不能并发跑全局摄入屏障用例；最终脚本固定 concurrency=1。
6. `last_complete_vote_snapshot_at` 和 `deleted` kind 都是实现时发现的现有 schema 缺口，
   不能只靠 TypeScript 绕开。

## 15. 剩余问题

- 真实生产 Guest/Anonymous/Deleted 身份仍需要后续自然样本观察，但不阻塞上线；
- 没有再次请求 5,575 票的 `scp-cn-2000`，避免为验证已经给定的实测数字制造 3.61 MB
  生产负载；其预算由分档与独立 lane 覆盖；
- 如要把超大页放到完全独立的 OS 进程/PM2 app，需要先扩展权威 task kind 或增加
  不改变 kind 的 worker 选择条件；
- M2 当前消费者有意不认领 M3/M5–M7 task kind；它们应由各自 handler 接入，不能认领后跳过。

以上都不是本次 M2 的阻塞项。

## 16. 安全与交付说明

- 未执行 git commit；
- 未执行 git push；
- 未修改受保护生产 checkout；
- 未向 `scpper-cn`、`scpper-syncer`、`scpper_user` 写入；
- 所有真实写入只发生在 `scpper-v2`；
- 生产站请求共 10 次，低于 50；
- 请求全部经过 `127.0.0.1:7891`；
- 请求全部由复用的 HttpClient 强制非空 User-Agent 与 Referer；
- `scpper-v2` 保留 run 88（Tier1 样本）、89（发现并回滚 snake_case 坑）、96（最终成功）
  及 `scp-261` 的 45 条真实票事实，作为本次交付证据。
