# ADULT2：源码、讨论与修订内容构建报告

日期：2026-08-07（Asia/Shanghai）  
工作树：`feat__syncer2-foundation`，未 commit、未 push

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

回归用真实结构 fixture 断言解析到 thread `991` 和三条实际评论正文，并遍历全部 AMC
请求确认没有 Authorization、用户名/密码或 `WIKIDOT_SESSION_ID`。

### 是否为全站性问题

不是“主站也调用了折叠模块”的全站代码错误；主站增量触发同样使用 CommentsList。
但存在全站性**冷启动覆盖缺口**：首轮 ListPages 为避免 3.6 万页请求洪峰只建快照，
`forum` 任务只在后续 comments/commented_at 变化时触发。因此当前非 adult 活页 36,268，
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
没有凭证时同样显式失败。普通 AMC 默认仍只有 token7 cookie，登录 cookie 不扩散到其它模块。

活库最终收敛数据将在本报告末次核验后填写：`[SOURCE_FINAL]`。

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
- 作者：2,870 条为 240 个 Wikidot actor；96 条为 9 个 deleted actor。两类 actor 都保留
  正整数 Wikidot id，没有按显示名伪造身份。
- 来源构成是 `wikidot=764`、`v1_backfill=2,202`；v2 直抓会按自然键补齐 v1 行的类型/ID，
  append-only 事实没有为“全 v2 来源”而复制。样本 `adult:man-in-a-bottle-0` 逐行与实时
  RevisionList 对比，类型集合、作者、UTC 时间和 comment 均为 0 差异。

`rev_no` 没有被当完整性主键：Wikidot 明示它可重复，且 v1 回填行不提供该展示序号；
闭合依据是唯一的 `wikidot_revision_id`、完整抓取证据和 N→N+1 计数。

## 活库最终结果

`[DISCUSSION_FINAL]`

`[SOURCE_COUNTS_FINAL]`

## 回归

- 讨论：断言 CommentsList 解析正确 thread id 和实际评论正文；五个 forum 模块全部匿名。
- 源码：断言登录 ViewSource 成功；`no_permission` 只重登一次；再次失败显式
  `emptyResult=false`，failure policy 为 retry。
- 出口：session 构造、work task 路由和受限源码扫描均拒绝 7891，只接受 7890/TLS 1.2。
- 来源：迁移词表、`run_id`、新写函数与 v1 backfill 显式来源均有回归。
- `npx tsc --noEmit`：通过。
- `npm test`：423/423 通过（基线 420 + 新增 3）；活库慢用例原断言未修改。
- `git diff --check`：通过。

## 阻塞与边界

`[BLOCKER_FINAL]`

没有使用 7891 采集 adult 源码/讨论，没有移除 v1 数据库服务端只读约束；没有修改
`/home/andyblocker/qqbot`，也没有发送 QQ 消息。
