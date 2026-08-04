# syncer2/src —— 设计约束备忘

这份文件解释**架构选择的理由**，而不是 API。每一条都对应一个已经发生过的故障或一次实测。

---

## 1. 为什么是短进程，而不是常驻 loop

**v1 的三个常驻 loop（SyncerLoop / VoteSentinelLoop / FastVoteLoop）出现过 2388 次连续失败而没有任何自愈。**
根因不是某个 bug，而是常驻 loop 这个形态本身：

- **失败没有出口**。`while(true) { try { work() } catch { log(); await sleep() } }` 的语义是
  "永远不放弃"。一旦进入坏状态（代理池全挂、cookie 过期、DB 连接被 kill、内存里某个缓存被写脏），
  循环体每次都以同样的方式失败，而进程始终"活着"——PM2 看到的是绿色，监控看到的是有心跳。
  2388 次失败被压缩成 2388 行日志，没有任何一层会把它升级成"该重启了"。
- **状态在内存里累积**。常驻进程的 cookie、dispatcher 连接池、已解析的 slug 映射、
  断路器计数器全都跨轮次存活。坏状态没有被清除的时刻。
- **一个 loop 卡住会拖垮同进程的其它 loop**。三个 loop 共享事件循环与全局 dispatcher
  （v1 用了 `setGlobalDispatcher`），任一路径的长阻塞会静默拉长其它两路的实际周期。

短进程模型把这三条同时解掉：

| | 常驻 loop | 短进程 |
|---|---|---|
| 失败处理 | 内部 catch + sleep，永不退出 | **非零退出码**，交调度器 |
| 自愈 | 需要自己实现（v1 没有） | 调度器重启即全新进程，内存态天然清零 |
| 卡死检测 | 需要额外心跳/看门狗 | 超时未退出 = 调度器直接杀 |
| 周期变更 | 改代码重启 | 改 crontab / systemd timer |
| 并发隔离 | 共享事件循环 | 各自独立进程 |
| 可观测 | 长日志流里捞 | 每次执行一行 JSON 摘要 + 一行 `meta.ingest_run` |

代价是每次执行要重新建连接、重新读快照。实测这个代价可以忽略：
delta 轮总耗时约 1.2 秒，其中 sitemap 请求本身就占 1.16 秒。

**调度建议**（与设计定稿的 L0 分层一致）：

```
*/10 * * * *   sitemap-scan --mode delta     # 10 分钟，1 请求 / 180 KB
17 */4 * * *   sitemap-scan --mode full      # 4 小时，4 请求 / 620 KB，absence 基准
23 5 * * *     sitemap-scan --mode threads   # 1 天，9 请求
```

调度器负责重启，进程负责**如实退出**。所以本项目里没有任何 `while (true)`，
也没有任何"失败了就 sleep 一下再试"的顶层循环——重试只存在于**单个 HTTP 请求**这一层，
且有明确的次数上限与断路器。

---

## 2. 为什么 503 不重试

实测：**空 / 缺失 User-Agent → WAF 直接返回 HTTP 503 空体**（UA 填任意值即 200）。
而 `@ukwhatn/wikidot` 的 fetchWithRetry 是「4xx 立即抛、5xx 重试」，AMC 层 `retryLimit=5`、
指数退避 base 1s ×2 上限 60s。

把这两条放一起：一次配置失误（或猴补丁 `globalThis.fetch` 时把 headers 弄丢）会让
**每个请求变成 5 次带退避的重试**，在共享 IP 池上表现为持续数十分钟的高频 503 洪水——
这正是最容易招来真封禁的行为模式，而且它是由"我们的重试逻辑"制造的，不是站点的问题。

所以 `src/http/client.ts` 里 503（以及 429）**零重试**，直接计入连续计数器，
连续 N 次即打开断路器、抛 `CircuitOpenError`、进程带非零码退出。
**503 的正确响应是停手，不是重发。**

同理，"连续传输重置"也从 5xx 重试里摘了出来：单次重置是正常的（实测基线传输失败率 1–3%，
轮换 IP 池下每次请求可能落到一个当时状态不好的节点），但**连续**重置说明出口链路坏了，
继续发只是在浪费节点信誉。

---

## 3. 为什么不用 `setGlobalDispatcher`

v1 的 `syncer/src/utils/proxy.ts` 调 `setGlobalDispatcher(new ProxyAgent(...))`，
副作用是同进程里**所有** undici 出站（包括与 wikidot 无关的健康探针、遥测上报）
都被拖到 wikidot 的代理池上走。syncer2 把 dispatcher 绑在 `HttpClient` 实例上、
按请求传入——谁要走代理谁自己声明。

---

## 4. 为什么时区守卫写成"拒绝启动"级别

v1 的 `MainDbBridge` 有一个已实测确认的 BLOCKER：裸 node-pg 把 JS `Date` 当参数传，
node-pg 序列化成**带本地偏移**的字符串（进程 TZ=Asia/Shanghai），
落到 `timestamp without time zone` 列时偏移被丢弃、上海墙钟被保留 → 比 Prisma 路径**晚 8 小时**。
下游 analytics 又做 `(ts AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Shanghai'`，再叠一次 → 16 小时。

这类 bug 的恶劣之处在于**它能跑**：没有异常、没有告警，只在每日对账里表现为
"页面元数据不一致"，没人会往时区上想。所以防线必须是结构性的，三道：

1. `toPgTimestamptz()` 是唯一的时间入口，产出 ISO UTC 字符串；
2. `query()` 里的 `assertNoRawDates()` —— 传裸 `Date` 直接抛，**让错误写法跑不起来**；
3. `assertTimezoneRoundTrip()` 启动自检 —— 把一个已知 epoch 真写进临时表再读回，
   并在 `UTC` 与 `Asia/Shanghai` 两种会话时区下各跑一遍，三个数不全相等就拒绝启动。

外加所有 SQL 的时间参数都写显式 `::timestamptz`，不让类型推断参与决策。

---

## 5. 为什么"解析出 0 条"要抛异常

v1 syncer 产生过 **54 万条幻影 removed**，机制是：扫描失败返回空数组 → 与上一轮 diff →
"所有票都不见了" → 全判撤票。**扫描失败与"确实没有数据"必须是两个不同的返回值。**

`src/sitemap/parse.ts` 因此有三道结构断言（根元素、条目数 > 0、每条必须有 `<loc>`），
任何一条不满足就抛 `SitemapParseError`，让整轮 run 判 `failed`，而不是返回 `[]`。
WAF 拦截页、HTML 错误页、被截断的响应全都会在这里被识破。

同样的原则贯穿 absence 推断：

- delta 轮**结构上无权**推断删除（它只看到 sitemap_page_1 这一个切片，
  一个页面从 page_1 掉到 page_2 是完全正常的）；
- full 轮要过三重门控（非 fallback / 枚举比 ≥ 0.98 / absent ≤ 500）；
- 即使全过，产出的也只是 `kind='confirm_deleted'` 的**待确认任务**，不是删除事件；
- 快照文件丢失 → 退化成 bootstrap 轮（不产出任何 diff），
  即**丢状态只会少报，永远不会误报**。

---

## 6. sitemap 通道的边界

sitemap 给的是**存在性 + 精确到秒的 lastmod**，仅此而已：没有 rating、没有 rating_votes、
没有 tags、没有 comments。**投票与评分信号仍然必须靠 ListPages。**
本项目只负责发现层；发现的结果落成 `meta.scan_task`，由后续的定向抓取消费。

已知的枚举域缺口（缺席**不**构成删除证据，见 `SITEMAP_EXCLUDED_PREFIXES`）：
`deleted:` 分类与 `forum:` 分类都不在 sitemap 里。

---

## 7. 出口归因：为什么有两个信源，而且必须分开写可信度

全部 wikidot 流量走 mihomo 的 **49 节点轮换池，无 fallback、无健康检查**。
不记出口有两个不可归因的场景，第二个比第一个严重得多：

1. 「某几个节点坏了」只表现为整体失败率上浮，看不出是哪几个；
2. mihomo 规则一改，wikidot 流量静默落到 `DIRECT` —— 我们用**家宽 IP** 高频抓站而毫不知情。
   这类故障**不报错**，所以不会有人去查。

`http/egress.ts` 用两个信源，可信度**不同**，落库时显式标出来（`exit_ip_stats.attribution`）：

| 信源 | 语义 | 可信度 | 成本 |
|---|---|---|---|
| IP 回显探针（`api.ipify.org`，经同一个 dispatcher） | 这条**探针连接**的真实出口 IP | 实测每次探针都换 IP（连续三次三个不同 IP）⇒ 只能当**池构成采样**，**不能**当相邻请求的出口 | 启动 1 次 + 每 N 请求 1 次（默认 25）+ 失败补探，单轮封顶 8 次 |
| mihomo `/connections` 的 `chains[0]` | 承载该连接的**节点名** | **按连接的真值**（实测 `["🇺🇸 美國 CN2 20260727","🔀 负载均衡(爬虫IP池)"]`） | 本机 HTTP，**零 wikidot 成本**，节流 250 ms |

**为什么这条区分值得写进代码而不是只记在脑子里：** 把探针 IP 当成相邻请求的出口 IP，
会产出一张"看起来精确、实际错位"的归因表 —— 那比没有归因更坏，因为它会被当成证据用。
所以 `byIp`（采样）与 `byNode`（真值）是两个字段，且"哪几个节点坏了"只看
`transportFailureByNode`（失败时刻**必采**，成功时按 N 节流）。

探针走独立的 `undici.request`、单次尝试、5 s 超时，**永不进入 wikidot 的断路器计数** ——
监控崩了不能把采集带走；反之监控也不该给采集制造假信号。

---

## 8. 三道启动自检，与它们各自能证明什么

| # | 自检 | 发不发请求 | 能证明 | **不能**证明 |
|---|---|---|---|---|
| 1 | `assertHeaders()` | 否 | 我们**带了** UA / Referer | 站点还认这两个头 |
| 2 | `assertTimezoneRoundTrip()` | 否（只连库） | 时间写进去读回来是同一个瞬间（UTC 与 Asia/Shanghai 两种会话时区下都成立） | — |
| 3 | `assertEgressContract()` | **是**（1 个 AMC POST + IP 探针） | 站点**仍然**接受这套头与 token7 双提交；响应结构没变；流量确实走在代理池上 | — |

第三道之所以必要：实测 `POST /ajax-module-connector.php` 缺 `Referer` 是 **0/15 成功**
（传输层 reset），而这条契约**未文档化、值任意、只校验存在性** —— 典型的粗糙
bot-mitigation 规则，说明该边缘的规则集**正在被主动调整**。第 1 道自检对"契约本身变了"
完全失明，只有真打一个 POST 才能在**启动时**知道，而不是在半轮采集后从熔断日志里反推。

三条实现纪律：

- **结构断言**，不只看状态码：`status='ok'` 且 body 能解析出 category 映射（实测 42 个）。
  "200 + status ok + body 变形"必须同样被识破 —— 与 `parse.ts` 的"解析出 0 条要抛异常"同一原则。
- **指数退避重试**（3 次，2s→4s，cap 20 s，jitter），重试耗尽才非零退出；
  但 **503 / 429 与断路器打开时立刻停手**。"503 的正确响应是停手"这条纪律优先于
  "探针要重试"，否则自检自己变成 503 洪水的发动机。
- **按通道自动判定策略**（`amcProbePolicyFor()`）：sitemap 与整页 GET 都是纯 GET ⇒ `skip`
  （每 10 分钟白打一个 POST 不划算）；走 AMC 的通道 ⇒ `require`。
  **接 ListPages 那天只改这一处常量。**

---

## 9. 两条「未消化数据」队列：为什么不塞进 `meta.scan_task`

`meta.scan_task` 的 `page_id` 是 `NOT NULL`，唯一键是 `(page_id, kind)`。这决定了两件事：

- **真·新页**（sitemap 见到、库里没有身份行）**装不进去** —— 它的定义就是"page_id 还不存在"。
  伪造一个 `-1` / `0` 塞进去，等于在队列里放一个假身份，正是 v1「URL 猜测 + 删除重建误判」
  那条歧路的入口。→ `meta.pending_page`（slug 主键）。
- **thread / category** 的主键是 wikidot 原始 id，且实测大量 thread **不挂任何页面**，
  `(page_id, kind)` 对它们没有意义；也不能直接写 `ingest.forum_thread`
  —— 那张表 `category_id / title / created_at` 全是 `NOT NULL`，而 thread sitemap **只给 id**。
  → `meta.forum_scan_task`（`UNIQUE(kind, target_id)`）。

两张表都遵守同一条**幂等契约**：发现侧 UPSERT 只允许改 `last_seen_at / seen_count /
reasons / priority(取大)`，**绝不覆盖** `attempts / not_before / stable_count / status /
locked_*`。理由不是洁癖：一个持续出现在 sitemap 里的坏 slug（例如私有页，永远解析不出
pageId）如果每轮发现都把退避清零，就变成**每 10 分钟重试一次、永不退避**的死循环 ——
v1 DirtyPage 整表 `deleteMany + createMany` 重建冲掉退避与收敛状态，就是这个病根。

消化侧（`cli/resolve-pages.ts`）的三条纪律：

1. **逐页独立容错。** 库里的 `acquirePageIds` 是"批量"接口但物理上每页一个 GET，
   且**任一页正则匹配不到就 throw 整批失败**。sitemap 的 TTL≈60 min 意味着我们看到的
   slug 里必然混着已被删掉的页 —— 那种语义在这里等于每轮都白跑。
   所以 `page/identity.ts` 用**返回值**而不是异常表达单页失败。
2. **404 不是错误**，是 sitemap TTL 与抓取之间的正常竞态 ⇒ `status='gone'`；
   `pageUnixName ≠ 请求 slug`（重定向/别名）⇒ `status='mismatch'` 且**拒绝注册**。
3. **冷启动闸。** pending > 2000 时拒绝自动跑：空库有 3.6 万条待解析，一页一个整页 GET
   = 3.6 万请求，与 field-matrix 的"绝不为全站 36k 页各打一次 GET"直接冲突。
   冷启动该走 Phase 2 批量回填；要强行跑得显式 `--force-cold-start`。

**调度建议补充**（接在 §1 的 crontab 之后）：

```
*/5 * * * *    resolve-pages --limit 50        # 消化 pending_page（实测新页+改名 30–80/天）
41 5 * * *     sitemap-scan --mode category    # 1 天，2 请求（极便宜，顺手做）
```
