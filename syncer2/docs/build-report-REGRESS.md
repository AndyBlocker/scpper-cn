# 修订倒退收敛修复报告（REGRESS）

日期：2026-08-14（Asia/Shanghai）  
工作树：`feat__syncer2-foundation` / `scpper-backend-v2`  
目标库：`scpper-v2`（PostgreSQL 5434）

## 1. 结论

`meta.revision_regression_identity_state` 原有的“远端 meta 身份确认”出口本身有效，
但缺了三段连接：已由其它生命周期路径确认的本地 successor/deleted 证据没有消费者；
未绑定 `page_id` 的 slug 水位无法通过同身份 CAS；同一 pending episode 又被每轮 L1
重新派生成 meta/revisions 扫描。这三点叠加后形成了无限自旋。

修复后，pending 有四条有界出口：

1. 同 slug 已存在不同 wikidotId 的 live 后继：`slug_reused`；
2. predecessor 已 deleted 且无 live 后继：`deleted`；
3. 真实 GET 证明仍是同一 wikidotId：`accepted_same_identity`；
4. 一小时仍没有可靠身份结论：`manual_review`，并退役 regression 专用任务。

活库原 6 条 pending 已全部终结；`critter-profile-neil` 已补齐 revision 0/1 两条事实，
其余五条都是已由既有 lineage 证明的旧身份 slug 复用。没有阻塞。

## 2. 六条未分类记录的根因与终态

| page_id / layer | 倒退 | 根因证据 | 终态 |
|---|---:|---|---|
| 104127 / L1 `scp-cn-4958` | 1→0 | 旧身份 1468426791 已 deleted；lineage 指向 live 后继 1500006339 / 1469135185。revision=0 是旧身份消失时的声明，不可单独解释为“同身份修订被删”。 | `slug_reused` |
| 1500006317 / L1 `critter-profile-neil` | 6→1 | 远端 GET 返回原 wikidotId 1469104455；但 `incremental_page_state` 的 slug 行 `page_id=NULL`，旧 CAS 用 `ips.page_id=p.id` 内连接，恒得到 `current=missing`。 | `accepted_same_identity` |
| 1500001226 / L1 `scp-cn-4197` | 8→0 | 第一代 1469087657 已 deleted；lineage 为 1500001226→1500006720→当前 live 1500007414 / 1469149627。 | `slug_reused` |
| 1500006720 / L1 `scp-cn-4197` | 3→1 | 第二代 1469146034 已 deleted；已有第三代 live 后继 1500007414 / 1469149627。 | `slug_reused` |
| 1500006720 / L0 `scp-cn-4197` | 3→1 | 与上一行是同一 episode 的另一采集层证据，不是重复状态行。 | `slug_reused` |
| 1500001341 / L1 `goi-balls-07` | 6→1 | 旧身份 1469091242 已 deleted；lineage 指向 live 后继 1500007479 / 1469151169。 | `slug_reused` |

`observed_revision=0` 不是充分删除条件：若旧页已 deleted 但同 slug 存在不同 live 身份，
正确终态是 `slug_reused`；只有“旧页 deleted 且无 live successor”才是 `deleted`。

## 3. 实现

### 3.1 同身份 CAS 修复

`acceptSameIdentityRevisionRegression` 现在按 slug 锁定水位，允许
`incremental_page_state.page_id IS NULL`，真实 GET 确认同一 wikidotId 后在同一事务中：

- 把水位行绑定到当前 `page_id`；
- CAS 接受该页较低的 L0/L1 revision；
- 状态改为 `accepted_same_identity`；
- 派生一次 `revisions_full`。

`critter-profile-neil` 因而从 `revision_count=0` 收敛为 2；`ingest.revision` 已有
rev_no 0（PAGE_CREATED）和 rev_no 1（TAGS_CHANGED），与远端零基 claim=1 一致。

### 3.2 自动分类与一小时升级

迁移 `0069_revision_regression_convergence.sql` 已先应用到 `scpper-v2`，为状态约束加入
`manual_review`。每轮成功 L0/L1 持久化前先扫 pending：

- 优先消费 `serve.page_current` + `ingest.page` 的 live successor / deleted 证据；
- 无确定证据且 `first_seen_at <= now()-1 hour` 时转 `manual_review`；
- 同时剥离 regression/drift 专用 task reasons，空任务直接删除。

同一 episode 后续重放保留终态、`first_seen_at`、`resolved_at` 和 resolution；只有
slug/expected identity/previous/observed tuple 改变才开启新 episode。

### 3.3 自旋与全局副作用

新 episode 才写一次 claim-only partial 并派生一次 meta 身份任务；重复观测只更新
`last_seen_at`。regression slug 不进入 L1 projection drift 输入，因此不会每轮再生
`revisions_full`；状态终结后专用任务被退役。

水位与 drift 隔离共用同一个页级过滤边界：只排除 regression slug；其它 36k+ 页面照常
写入 `incremental_page_state`，其 `previousL1RunId` 仍连续，streak 不被重置。异常页完成
身份确认后从下一轮恢复普通水位与 drift 对账。

### 3.4 `1500006720` 的“两行”

两行分别为 L1 21:59 与 L0 22:02；表的自然粒度本来就是 `(page_id, layer)`。
现有主键 `PRIMARY KEY(page_id, layer)` 已阻止同层重复，因此不是缺唯一约束，无需新增
会错误合并 L0/L1 独立证据的约束。

## 4. 回归

新增/加强的回归覆盖：

- 同 slug 连续三代身份、前两代同时有 regression ⇒ 两条均 `slug_reused`；
- `observed_revision=0` + predecessor deleted + 无 successor ⇒ `deleted`；
- revision=0 但同一 live 身份 ⇒ 保持 pending，不误删；
- pending 满一小时 ⇒ `manual_review`，任务退役，重复 episode 不重开；
- 同身份 slug 水位 `page_id=NULL` ⇒ GET 后绑定并 CAS 接受；
- 单页 regression ⇒ 只排除自身，其它页水位继续写、drift streak 4→5；
- 同一 episode 重放 ⇒ `newEpisodeKeys=0`，不重复派生 claim/partial。

最终验证：

- `npx tsc --noEmit`：通过；
- `npm test`：565/565 通过，90 suites，0 failed，0 skipped（基线 559，新增 6）；
- 定向回归：39/39 通过；
- `git diff --check`：通过。

## 5. 生产实测

### 5.1 regression 与修订事实

- `status='pending' AND first_seen_at < now()-interval '1 hour'`：0；
- 全部 `status='pending'`：0；
- 原 6 条：5 `slug_reused` + 1 `accepted_same_identity`；
- `critter-profile-neil`：`last_l1_revision=1`、`revision_count=2`、事实 2 行；
- 该页 regression/meta/revisions 专用 `scan_task`：0（仅剩无关 discussion catch-up）。

### 5.2 L1

05:16 最终复核的最近六轮全站 L1（29130–29157）连续为 `status=ok`；前五轮
`pages_enumerated=statesAdvanced=36,567`，最新轮随站点新增页同步为 36,568；六轮均
`persistenceSkipped=0`，耗时 90.275–106.976 秒。对比修复前 regression 自身隔离时
`statesAdvanced` 比全站少 1。其它长期 revisions drift 的 streak 未被重置。

### 5.3 队列

最终复核的完整 work-queue 轮次 29155 为
`claimed=50 processed=50 unprocessedReleased=0`；完整 forum-consume 轮次 29154 为
`claimed=50 processed=50 succeeded=50 unprocessedReleased=0`。

### 5.4 自旋窗口

修复后没有再生成 `critter-profile-neil` 的 regression claim-only/meta/revisions 扫描；
2026-08-14 05:16:43+08 最终一小时窗口内，五个不同 page_id 的 revisions 扫描次数均为
0（验收上限 `<=3`），regression 专用任务数也为 0。

## 6. 变更清单与阻塞

- `migrations/0069_revision_regression_convergence.sql`：加入 `manual_review` 终态；
- `src/collect/revisionRegression.ts`：纯分类、1h 阈值、页级隔离选择器；
- `src/store/incremental.ts`：episode 幂等、生命周期收口、超时升级、NULL page_id CAS；
- `src/cli/incremental-scan.ts`：首次派生、L1 drift 局部隔离、收口计数；
- `tests/identity-failure-check.test.ts`、`tests/incremental-listpages.test.ts`：指定回归；
- `tests/helpers/fixture.ts`：清理新增状态，避免活库测试残留。

无阻塞；未 commit、未 push、未触碰 `/home/andyblocker/scpper-cn`、`qqbot`，未发送 QQ。
