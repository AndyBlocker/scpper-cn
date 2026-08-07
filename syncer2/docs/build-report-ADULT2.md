# ADULT2：源码、讨论与修订内容构建报告

日期：2026-08-07（Asia/Shanghai）  
工作树：`feat__syncer2-foundation`。任务开始时 HEAD=`7a394bf`；执行期间外部流程于
12:21 将当时工作树连同另一项署名修复提交为 `2277dee`。本任务没有执行 commit/push，
也没有 reset/amend 外部提交；此后的收尾改动保持未提交，远端未推进。

## 结论

- adult 讨论区读取不需要账号。页面入口固定使用匿名
  `forum/ForumCommentsListModule(pageId=<wikidot pageId>)` 发现并校验 thread id 和第一页，
  随后用 `ForumViewThreadModule(t=<threadId>)` / `ForumViewThreadPostsModule` 完整翻页。
  `ForumCommentsModule` 的 305 字节折叠 UI 不进入采集路径。
- adult 当前源码需要账号。只有 `ViewSourceModule` 注入 `WIKIDOT_SESSION_ID`；ListPages
  渲染正文、讨论、投票和修订继续匿名。受限客户端在构造、任务路由和采集函数三层
  fail-closed 到 `http://127.0.0.1:7890`（出口 `103.188.235.3`），不会回落 7891。
- `page_source` 不再用“有行”冒充“v2 已抓”。迁移前无法反推的旧行明确标
  `legacy_unattributed`，已核实的 adult 102 页/104 行标 `v1_backfill`；迁移后 v2 每次观测
  都写 `wikidot_anonymous` 或 `wikidot_authenticated`，并关联 `run_id`。
- adult 修订不只做行数闭合：133 页最近一次完整 RevisionList 抓取均为 `ok`，总计
  2,966 条；上游 revision id、时间、类型集合、作者均完整，逐页声明 N → N+1 闭合。

## 迁移先行

`migrations/0206_page_source_provenance.sql` 已在启用新写入口的代码运行前应用到
`scpper-v2`，并以最终文件名再次幂等执行通过。迁移新增：

- `ingest.page_source.observation_source`，允许
  `legacy_unattributed / v1_backfill / wikidot_anonymous / wikidot_authenticated`；
- `ingest.page_source.run_id`；
- 当前源码按 `(page_id, blob_sha, observation_source)` 幂等的唯一索引；
- `SECURITY DEFINER ingest.apply_current_page_source()`，只接受两种 v2 直抓来源，并撤销
  PUBLIC EXECUTE。

S2 后续回填插入也显式写 `v1_backfill`。无法无损恢复来源的迁移前普通页旧行没有被
武断改成 v1 或 v2，而是保留 `legacy_unattributed`；从这次迁移起的新证据可精确追踪。

## 讨论区

### 路径与语义

仓库内论坛解析器本来已经使用正确的 `ForumCommentsListModule`；adult 的实际断点是
bootstrap 只投递投票/修订任务，从未投递 `discussion`，所以 133 页的
`discussion_thread_id` 全空。本轮给 adult 身份 bootstrap 增加 `discussion` 任务，并保留
既有的完整链路：

1. 匿名 CommentsList 解析 `WIKIDOT.forumThreadId`，若已有 id 则必须精确回显；
2. 按 thread id 完整抓取 thread 和所有 posts；
3. 同一事务写 `discussion_thread_id` 和 `ingest.forum_thread/forum_post` 当前态；
4. 只有完整翻页且计数校验成功才允许把本地缺席帖写 `is_deleted=true`；partial/failed
   永不由缺席推断删除。

计数校验按快照时间单向处理：完整 thread 的实际帖子数少于 Tier1/thread 自报仍为
`partial`；实际更多是声明之后新增的完整超集，允许落库并用实际数更新当前态。活库最终
有 4 页在任务声明后各新增 1 帖：8→9、21→22、121→122、125→126；全部按完整超集写入，
最终 thread/page 当前计数均闭合且 `soft_deleted=0`。没有出现实际少于声明的页，缺帖方向
的断言也没有放宽。

`adult:nirvana-and-the-hysterectomy` 还暴露了一个真实解析边界：某条用户评论把
`%%name%%`、`%%title%%` 当普通文字讨论，旧的全页残留检查把它误判为结构模板未展开。
现在先从 DOM 移除 `div.post` 再检查结构区；结构里的 `%%selector%%` 仍拒绝，帖子正文
里的字面 selector 则保留。该页修复后用匿名 CommentsList/Thread 链路重放成功，thread
`13994856` 共 73 帖，`soft_deleted=0`。

回归用真实结构 fixture 断言解析到 thread `991` 和三条实际评论正文，并遍历全部 AMC
请求确认没有 Authorization、用户名/密码或 `WIKIDOT_SESSION_ID`。

### 是否为全站性问题

不是“主站也调用了折叠模块”的全站代码错误；主站增量触发同样使用 CommentsList。
但存在全站性**冷启动覆盖缺口**：首轮 ListPages 为避免 3.6 万页请求洪峰只建快照，
`forum` 任务只在后续 comments/commented_at 变化时触发。因此终审时非 adult 活页 36,273，
其中 28,635 页 `comment_count>0`；只有 246 页有 CommentsList 验证的
`discussion_thread_id`，28,389 页缺验证 id。v1 标题回填已为其中 27,559 页建立
`page_id_source=inferred` 的 thread 链接，仍有 830 个有评论页面没有任何活 thread 链接。
这是需要独立、限速的全站验证回填，不能在本次 133 页修复中直接制造 2.8 万页流量。

## 当前源码

`content` handler 对受限页先匿名抓目标页的 ListPages `%%content%%`，再由专用登录 session
调用 `viewsource/ViewSourceModule`。源码解析成功后分别保存渲染 HTML、纯文本、真正
wikitext、图片和来源证据；ListPages HTML 继续放在 `rendered_content_blob`，绝不冒充源码。

session 复用 20 分钟；`no_permission`、HTTP 302/401/403 或非 JSON 登录页只触发一次强制
重登。重登后仍失败会抛 `RestrictedSessionUnavailableError`，任务记录
`emptyResult=false` 并按 prerequisite/retry 退避，既不写空源码，也不触发任何删除推断。
没有凭证时同样显式失败。并发 content 任务对首次登录/重登做 session 单飞，四个任务只
建立一个 session，不会互相覆盖。普通 AMC 默认仍只有 token7 cookie，登录 cookie 不扩散
到其它模块。

adult-only worker 的整个 7890 客户端参加 PostgreSQL 全站 adaptive gate；混合 worker 的
专用 7890 客户端也接入同一控制器。固定出口不能成为绕过容量预算的理由。
定向 worker 达到单轮预算时，未执行任务会原子归还 `adult-stable-egress-hold`（同时归还
claim 增加的 attempts），不会在受限 session 注销等待期间短暂暴露给通用 worker。

活库最终收敛：133/133 页都有 `wikidot_authenticated` 当前源码观测，共 133 行，
`run_id` 缺失 0、空源码 0，源码大小 304–136,443 bytes；133/133 的观测 blob 与
`serve.page_current.source_sha` 精确一致。旧的 102 页覆盖没有被算入这个数字。

### 历史版本源码

逐版本源码可得，但 adult 的 `history/PageSourceModule(revision_id=...)` 匿名实测同样返回
`no_permission`，必须复用固定 7890 的登录 session；不能沿用当前匿名历史源码队列。
133 页共有 2,966 条修订，其中会产生源码版本的 `SOURCE_CHANGED=1,471`、
`PAGE_CREATED=133`，所以只抓源码变化点约需 1,604 次请求；若不利用类型过滤则需 2,966 次。
相对当前态 133 次是约 12.1 倍（全修订则 22.3 倍），应放独立低优先、可续跑队列，不能
绑在五分钟 L1 或当前态任务上。本轮目标是 133 页当前版本，未把历史 1,604 次请求混入。

## 修订内容复核

- 最近一次有 `fetched_total` 的完整修订扫描：133/133 `ok`，`fetched=2,966`，
  ListPages 零基声明合计 2,833，逐页均满足 N+1；库内 `revision_count` 与事实行数
  133/133 相等。
- 2,966 个 `wikidot_revision_id` 全局唯一；缺时间 0、缺类型集合 0、缺作者 0。
- 类型元素直方图：`SOURCE_CHANGED 1,471`、`FILES_CHANGED 773`、
  `TAGS_CHANGED 442`、`PAGE_CREATED 133`、`PAGE_RENAMED 130`、
  `TITLE_CHANGED 75`、`META_CHANGED 26`。单条修订可有多个类型，所以元素总数可大于行数。
- 作者：2,966 条全部关联 249 个正整数 Wikidot 身份，缺作者 0、非正 ID 0；最终用户快照中
  98 条/10 个 actor 显示 `(account deleted)`，其余为 2,868 条/239 个 actor。删除显示状态
  可被身份刷新更新（本轮终审由 96/9 变成 98/10），revision 的作者 ID 没有随显示名漂移，
  也没有按显示名伪造身份。
- 来源构成是 `wikidot=764`、`v1_backfill=2,202`；v2 直抓会按自然键补齐 v1 行的类型/ID，
  append-only 事实没有为“全 v2 来源”而复制。样本 `adult:man-in-a-bottle-0` 逐行与实时
  RevisionList 对比，类型集合、作者、UTC 时间和 comment 均为 0 差异。

`rev_no` 没有被当完整性主键：Wikidot 明示它可重复，且 v1 回填行不提供该展示序号；
闭合依据是唯一的 `wikidot_revision_id`、完整抓取证据和 N→N+1 计数。

## 活库最终结果

adult 讨论最终 133/133 都有 CommentsList 实抓并标为 `verified` 的 thread id，thread
反向 `page_id` 错配 0；当前态共 4,205 条活帖，`text_plain` 与 `text_html` 非空均为
4,205/4,205，thread 自报与 page 当前计数差异均为 0，软删 0。133 页最新讨论扫描全部
`ok`；`content/discussion` 遗留任务 0、未解决 irreconcilable 0、专用 hold 0。

全库 `page_source` 来源分布：`legacy_unattributed` 78,692 行/47,920 页、`v1_backfill`
104 行/102 页、`wikidot_anonymous` 56 行/56 页、`wikidot_authenticated` 133 行/133 页。
两类 v2 直抓共 189 行且 `run_id` 缺失 0；adult 范围正好是旧 v1 104 行/102 页与本轮
登录直抓 133 行/133 页，两者不会再混为一个“已有源码”覆盖数。

## 回归

- 讨论：断言 CommentsList 解析正确 thread id 和实际评论正文；五个 forum 模块全部匿名；
  评论正文内字面 `%%name%%` 可通过，而评论区外的模板残留仍拒绝。
- 讨论快照竞争：实际超集可推进并更新 thread 计数；实际少于声明仍必须 partial。
- 源码：断言登录 ViewSource 成功；`no_permission` 只重登一次；再次失败显式
  `emptyResult=false`，failure policy 为 retry。
- 出口：session 构造、work task 路由和受限源码扫描均拒绝 7891，只接受 7890/TLS 1.2。
- 并发：四个同时开始的 adult 源码请求只执行一次 Login2Action；混合 worker 的专用
  7890 HttpClient 也接全站共享 adaptive gate。
- 队列隔离：adult 未执行任务直接释放回专用 hold；普通任务仍释放为 NULL。
- 来源：迁移词表、`run_id`、新写函数与 v1 backfill 显式来源均有回归。
- `npx tsc --noEmit`：通过。
- `npm test`：431/431 通过（76 suites，0 failed）；活库慢用例原断言未修改。
- `git diff --check`：通过。

## 阻塞与边界

本轮目标无阻塞：adult 当前源码、讨论和修订内容审计全部闭合。逐版本历史源码的登录采集
和非 adult 约 2.84 万页 thread id 冷启动验证是已量化的后续容量任务，不是本轮残留失败；
不能把它们塞进五分钟 L1 或绕开全站 adaptive gate。

没有使用 7891 采集 adult 源码/讨论，没有移除 v1 数据库服务端只读约束；没有修改
`/home/andyblocker/qqbot`，也没有发送 QQ 消息。
