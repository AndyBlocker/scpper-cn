# ADULT 采集层构建报告

日期：2026-08-06（Asia/Shanghai）  
工作树：`feat__syncer2-foundation`，未 commit、未 push

## 结论

- 已验证关键假设：登录态从 `adult:man-in-a-bottle-0/norender/true/noredirect/true`
  得到真实 `pageId=1448285468` 后，匿名 `WhoRatedPageModule(pageId=1448285468)` 成功返回
  150 行，`Σsign=140`，与匿名 ListPages 的 `rating_votes=150/rating=140` 精确闭合。
  因此账号只用于真实 pageId 发现；投票明细、修订、ListPages 均不携带登录 cookie。
- adult 完整集合以 ListPages fullname 为集合与页面数据权威源；绝不采用匿名页面 URL
  返回的 `1306434388` 建身份。
- 登录身份发现和所有 adult 页级任务均 fail-closed 到
  `http://127.0.0.1:7890`。没有 7890 客户端时直接失败，不回落到 7891。该出口对
  Wikidot 的默认 TLS 协商会 reset，实测固定 TLS 1.2 后恢复 200，因此版本限制只放在
  专用稳定客户端，不影响通用链路。

## 迁移顺序

`migrations/0043_adult_listpages_content.sql` 已在启用依赖它的代码之前先应用到
`scpper-v2`。迁移新增 append-only `ingest.rendered_content_blob` 与
`serve.page_current.rendered_content_sha`，把 ListPages 渲染 HTML 与真正 Wikidot
wikitext 的 `content_blob/source_sha` 分开；写入口是撤销 PUBLIC EXECUTE 的
`SECURITY DEFINER ingest.apply_listpages_rendered_content`。

本次没有新增 pending 表：session/出口不可用复用已登记的 `meta.pending_page`，写成
`waiting_evidence + restricted_session_unavailable`，证据固定带
`skipped=true, emptyResult=false`。因此 oldest-pending 覆盖没有未分类新集合。

## 实现

- `restrictedListPages.ts`：先完整枚举元数据，再以每页隔离的匿名 ListPages
  `%%content%%` 请求取正文。线上存在会吞 DOM 容器的畸形正文，隔离请求保证一页不能
  污染后续行；任一元数据批或正文失败则整轮 `failed`，不会形成空集合。
- `restrictedSession.ts`：7890 常量硬约束；登录、20 分钟主动复核、失效检测、一次重登、
  重登失败显式报错和 best-effort logout。真实身份 URL 固定带
  `/norender/true/noredirect/true`，避免登录后的 canonical redirect 丢掉分类前缀。
- `resolve-pages --adult-bootstrap`：ListPages 133 行是目标集合；串行发现全部真实 ID，
  批级守卫通过后才允许 register/apply。页面级事务写标题、标签、父级、创建时间声明、
  评分/票数声明、修订声明、归属、渲染正文，并投递 WhoRated/修订任务。
- `work-queue --adult-only`：整个进程（含启动探针）固定 7890，只认领 `adult:`；常规
  work queue 即使在 7891 进程中也为 restricted task 单独选择 7890 客户端。
  定向运行单独记录 source=`wikidot_tier2_adult_stable`，便于出口审计。
- 定向补采支持 `adult-stable-egress-hold` 保留锁接管：旧版通用 worker 看见未来锁会
  跳过，只有新 `--adult-only` 能原子接管，避免滚动部署窗口内 7891 抢任务。
- 通用共享身份守卫位于 `page/identity.ts`，并接入 `scanPageIds` 和 pending 批处理：
  同一批多个不同 slug 得到相同 pageId 时，冲突组在任何写入前整体失败并告警。

## 活库结果

ListPages 完整轮为 133 页；认证身份发现得到 133 个不同真实 wikidot pageId，
`1306434388` 为 0 页。`serve.page_current` 已有 133 页、133 个唯一 pageId、全部 live，
标题与渲染正文均已写入。120 页有 ListPages `created_by_id`，入库 SUBMITTER 与声明
120/120 一致（这里核对 SUBMITTER 事实；`is_display` 的既有展示抑制不改变归属事实）；
另外 13 页的 ListPages 创建者本来就是空值，库中也没有伪造 SUBMITTER。
`meta.pending_page` 133/133 为 `adult_listpages_authenticated_identity`，证据均记 7890，
没有 `emptyResult=true`。

投票和修订已全部用固定 7890 复采并签收：133/133 页 WhoRated 的原始行数与
ListPages `rating_votes` 相等，`Σsign` 与 ListPages `rating` 相等；当前共 18,341 条
非零投票行、总评分 16,183，库内聚合逐项相等。9 页存在同一 voter 多行，共多 11 行，
均按既有多重集主键/ordinal 保留。修订 133/133 满足 ListPages 零基 N → 实际 N+1。
一次页面在 ListPages 与 WhoRated 之间新增 1 票，被门控正确判 partial；刷新声明后重试
闭合，未使用容差。

滚动窗口中旧版常驻 Tier2 确实曾从 7891 抢到 adult 任务；这批没有被当作最终证据，
随后通过保留锁让 3 个 `--adult-only` worker 原子认领 50+50+33，并把全部 133 页从
`103.188.235.3` 重新采集。最终 adult 投票/修订队列与保留锁均为 0。

## 回归

- 多 slug → 同 pageId：冲突组全部拒绝写入并记录错误日志。
- session 失效：重登一次；仍失败则 `waiting_evidence`，`emptyResult=false`，不进入删除推断。
- adult 出口：构造/handler/定向 worker 均断言 7890；传入 7891 或缺客户端 fail closed。
- `npx tsc --noEmit`：通过。
- `npm test`：420/420 通过（原基线 414 + 新增 6）。
- 活库并发曾让投影水位短暂落后 1 票；按要求未改断言，追平投影后全量重跑通过。
- `npm run check:sql-tuning`：通过；`git diff --check`：通过。

## 阻塞

无阻塞。7890 的 TLS reset 已通过专用客户端固定 TLS 1.2 解决；没有用 7891 绕过。
期间没有发送 QQ 消息，也没有修改 qqbot。
