# SCPper CN 全仓库审查报告

> **审查日期**：2026-03-16
> **审查方法**：Codex 整体扫描 + 4 个专项 Agent（前端、BFF+后端、安全、用户/邮件服务）并行深度审查
> **覆盖范围**：frontend / bff / backend / user-backend / mail-agent / avatar-agent / scripts
> **状态**：交叉验证中

---

## 问题清单

每个问题包含：编号、严重性、描述、位置、验证状态（待验证/确认bug/设计意图/误报）、修复状态。

---

### Critical（严重）

#### C-1: 验证码/重置码未批量失效
- **严重性**：Critical
- **描述**：发新验证码时旧 token 不作废；注册/改密完成后旧验证码仍可生效，可再次覆盖 passwordHash。密码重置流程同样只消费命中的一条 reset token，旧邮件中的 token 仍可再次重置密码。
- **位置**：
  - `user-backend/src/services/registration.ts:33,102`
  - `user-backend/src/services/passwordReset.ts:33,78`
- **发现来源**：Codex + 用户/邮件服务 Agent
- **验证状态**：待验证
- **修复状态**：未修复

#### C-2: 内部 API 暴露于公网
- **严重性**：Critical
- **描述**：前端 `/api/**` 全量代理到 BFF，BFF 把 loopback socket 视为"内部来源"；公网用户经 Nuxt/Nginx 访问 `/api/internal/*` 时可直接打到内部接口。
- **位置**：
  - `frontend/nuxt.config.ts:104`
  - `bff/src/web/router.ts:40`
  - `bff/src/web/routes/internal.ts:133`
- **发现来源**：Codex + 安全 Agent
- **验证状态**：待验证
- **修复状态**：未修复

#### C-3: useAuth SSR 跨请求状态泄漏
- **严重性**：Critical
- **描述**：`fetchInflight` 是模块级闭包变量，在 SSR 多请求并发环境中，Node.js 模块缓存复用同一模块实例，可能导致一个请求的 auth 状态泄漏给另一个请求。对比 `gachaCore.ts` 已通过 `nuxtApp[INFLIGHT_KEY]` 做了正确的 per-request 隔离。
- **位置**：`frontend/composables/useAuth.ts:42-43`
- **发现来源**：前端 Agent
- **验证状态**：待验证
- **修复状态**：未修复

---

### High（高）

#### H-1: 登录接口无暴力破解防护
- **严重性**：High
- **描述**：`POST /auth/login` 无 IP/邮箱维度限流或退避机制，密码爆破成本过低。bcrypt cost=12 提供约 300ms/次延迟，但不足以防御分布式攻击。
- **位置**：`user-backend/src/routes/auth.ts:129`
- **发现来源**：Codex + 安全 Agent + 用户服务 Agent
- **验证状态**：待验证
- **修复状态**：未修复

#### H-2: CORS fail-open
- **严重性**：High
- **描述**：BFF 和 user-backend 的 `CORS_ALLOWED_ORIGINS` 未配置时退化为 `origin: true + credentials: true`。`ecosystem.config.cjs` 中也未设置该变量。
- **位置**：
  - `bff/src/start.ts:16`
  - `user-backend/src/app.ts:16`
  - `bff/ecosystem.config.cjs`
  - `user-backend/ecosystem.config.cjs`
- **发现来源**：Codex + BFF Agent + 安全 Agent
- **验证状态**：待验证
- **修复状态**：未修复

#### H-3: 鉴权缓存泄露旧权限
- **严重性**：High
- **描述**：鉴权缓存把 status、linkedWikidotId、passwordHash 缓存 30 秒，封禁/解绑/改密后旧 session 在缓存窗口内仍可能通过权限检查。
- **位置**：
  - `user-backend/src/middleware/requireAuth.ts:20,109`
  - `user-backend/src/routes/auth.ts:249`
  - `user-backend/src/services/passwordReset.ts:109`
- **发现来源**：Codex
- **验证状态**：待验证
- **修复状态**：未修复

#### H-4: Mail Agent 无鉴权
- **严重性**：High
- **描述**：`MAIL_AGENT_API_KEY` 为空时 `/send` 完全不鉴权，PM2 配置也不强制该变量。
- **位置**：
  - `mail-agent/src/server.mjs:188`
  - `mail-agent/ecosystem.config.cjs:11`
- **发现来源**：Codex + 安全 Agent + 用户服务 Agent
- **验证状态**：待验证
- **修复状态**：未修复

#### H-5: BFF 全层无速率限制
- **严重性**：High
- **描述**：除 `css-proxy.ts` 有独立限速（60 req/min/IP）外，BFF 所有 API 端点均无速率限制。搜索、分析等重查询可被无限并发调用压垮 PostgreSQL 连接池。
- **位置**：`bff/src/start.ts`（全局缺失）
- **发现来源**：Codex + BFF Agent + 安全 Agent
- **验证状态**：待验证
- **修复状态**：未修复

#### H-6: 搜索无 limit 上限
- **严重性**：High
- **描述**：`/search/pages` 没有硬性 limit 上限，`candidateLimit = limit * 4` 会直接放大最重查询路径。
- **位置**：`bff/src/web/routes/search.ts:1346,1394`
- **发现来源**：Codex
- **验证状态**：待验证
- **修复状态**：未修复

#### H-7: Tracking IP 伪造 + 非原子计数
- **严重性**：High
- **描述**：tracking 直接信任 `x-forwarded-for`，且去重采用"先查再插再累加"的非原子三段式；可被伪造 IP，也会在并发下重复计数。
- **位置**：`bff/src/web/routes/tracking.ts:69,278,367`
- **发现来源**：Codex
- **验证状态**：待验证
- **修复状态**：未修复

#### H-8: Tracking debug 全量落库隐私数据
- **严重性**：High
- **描述**：生产 PM2 配置默认开启 `ENABLE_TRACKING_DEBUG=true` + `TRACKING_DEBUG_SAMPLE_RATE=1`，每个跟踪请求都将原始 IP、UA、Headers、查询参数写入数据库。隐私合规和容量风险。
- **位置**：
  - `bff/ecosystem.config.cjs:17`
  - `bff/src/web/routes/tracking.ts:165`
- **发现来源**：Codex + 安全 Agent
- **验证状态**：待验证
- **修复状态**：未修复

#### H-9: v-html XSS 风险（搜索 snippet）
- **严重性**：High
- **描述**：搜索下拉框 `entry.item.snippet` 和 `PageCard.vue` 的 `snippetHtml` 来自 BFF API 响应，未经 DOMPurify 净化直接用 `v-html` 渲染。项目已有 `sanitizeForumHtml.ts` 但未统一应用。
- **位置**：
  - `frontend/layouts/default.vue:109,380`
  - `frontend/components/PageCard.vue:191`
- **发现来源**：前端 Agent + 安全 Agent
- **验证状态**：待验证
- **修复状态**：未修复

#### H-10: stripHtml 后仍用 v-html
- **严重性**：High
- **描述**：`user/[wikidotId].vue` 用正则 `/<[^>]*>/g` 剥离 HTML 标签后仍用 `v-html` 渲染。正则 strip 不可靠，`<img src=x onerror=alert(1)>` 可绕过。
- **位置**：`frontend/pages/user/[wikidotId].vue:584,1121-1123`
- **发现来源**：安全 Agent
- **验证状态**：待验证
- **修复状态**：未修复

#### H-11: Session secret 硬编码弱默认值
- **严重性**：High
- **描述**：`'scpper-dev-secret'` 在 NODE_ENV 非 production 时被使用。若运维误以非 production 模式部署，所有 session token 可被伪造。
- **位置**：`user-backend/src/config.ts:27-33`
- **发现来源**：用户服务 Agent + 安全 Agent
- **验证状态**：待验证
- **修复状态**：未修复

#### H-12: 注册接口邮箱枚举
- **严重性**：High
- **描述**：注册接口对已注册邮箱返回"该邮箱已注册"，可被用于枚举。对比密码重置已正确处理。
- **位置**：`user-backend/src/services/registration.ts:47-56`
- **发现来源**：用户服务 Agent
- **验证状态**：待验证
- **修复状态**：未修复

#### H-13: Phase C 无限循环风险
- **严重性**：High
- **描述**：Phase C 分页拉取循环无最大迭代次数或超时限制。外部 GraphQL API 持续返回 hasNextPage 时会无限运行。
- **位置**：`backend/src/core/processors/PhaseCProcessor.ts:206-249`
- **发现来源**：BFF+后端 Agent
- **验证状态**：待验证
- **修复状态**：未修复

#### H-14: Avatar Agent 启动路径错误
- **严重性**：High
- **描述**：PM2 配置入口写 `dist/index.js`，实际构建产物在 `dist/src/index.js`。
- **位置**：`avatar-agent/ecosystem.config.cjs:5`
- **发现来源**：Codex
- **验证状态**：待验证
- **修复状态**：未修复

#### H-15: HTML Snippet 路由无认证
- **严重性**：High
- **描述**：`POST /html-snippet` 接受任意 HTML 并以 `text/html` 提供，无认证保护。任何人可向生产域名提交并托管 HTML。
- **位置**：`bff/src/web/routes/html-snippets.ts:198-268`
- **发现来源**：安全 Agent
- **验证状态**：待验证
- **修复状态**：未修复

---

### Medium（中）

#### M-1: fetchAuthUser 静默吞异常
- **描述**：`fetchAuthUser` 对任何错误一律返回 null，无法区分"未登录"和"认证服务不可用"。
- **位置**：`bff/src/web/utils/auth.ts:33`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-2: Collections 并发缺事务
- **描述**：默认收藏夹切换、条目追加排序、重排缺完整事务/校验，并发下出现多默认项/重复顺序。
- **位置**：`bff/src/web/routes/collections.ts:529,681,748,853`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-3: collections.ts reorder 连接泄漏风险
- **描述**：使用"提前 return + 手动 release"模式，异常路径可能泄漏连接。应改用 try/finally。
- **位置**：`bff/src/web/routes/collections.ts:833-888`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-4: 列表接口 limit/offset 无硬上限
- **描述**：多处列表接口把原始 limit/offset 直接传给 SQL，坏参数变 500 而非 400。
- **位置**：`pages.ts:713` / `users.ts:18` / `search.ts:1496`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-5: 搜索正则 JS 侧 ReDoS
- **描述**：用户正则在 `highlightRegexSnippet` 中直接 `new RegExp` 执行，无 Node.js 端超时保护。
- **位置**：`bff/src/web/routes/search.ts:261`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-6: Phase A 缺复合索引
- **描述**：Phase A 对每个页面单独查当前版本，`PageVersion` 缺 `pageId,validTo` 复合/部分索引。
- **位置**：`backend/src/core/processors/PhaseAProcessor.ts:230,251`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-7: Phase C 串行入队
- **描述**：Phase C 在入队时逐项 `await this.queue.add()`，把并发任务串行化。
- **位置**：`backend/src/core/processors/PhaseCProcessor.ts:171`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-8: DirtyQueue 全表 preload
- **描述**：DirtyQueue 整表 preload 再逐条 `dirtyPage.create()`，增量场景下效率低。
- **位置**：`backend/src/core/store/DirtyQueueStore.ts:87,137,154`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-9: 缓存 thundering herd
- **描述**：Redis 和内存缓存 `remember` 实现中，并发 miss 都触发 loader，产生重复 DB 查询。
- **位置**：`bff/src/web/utils/cache.ts:54-65`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-10: stats.ts 日期参数未验证
- **描述**：`startDate`/`endDate` 未经格式验证直接传入 SQL `::date`。
- **位置**：`bff/src/web/routes/stats.ts:156-162`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-11: Generic 邮件模板接收原始 HTML
- **描述**：`generic` 类型模板直接接受 html 字段原样写入邮件正文，无净化。
- **位置**：`mail-agent/src/lib/templates.mjs:64-75`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-12: 验证码速率限制可绕过
- **描述**：消费后立即可重新请求；密码重置与注册共享速率窗口配置。
- **位置**：`user-backend/src/services/registration.ts:33-45`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-13: Mail Agent 速率限制纯内存
- **描述**：`SlidingWindowRateLimiter` 用 Map 存储，重启即失效，不支持水平扩展。
- **位置**：`mail-agent/src/lib/rateLimiter.mjs`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-14: Token 查询未过滤 expiresAt
- **描述**：查询 where 条件未加 `expiresAt > now`，表膨胀后索引扫描范围膨胀。
- **位置**：`user-backend/src/services/registration.ts:111-118`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-15: createErrorResponse 泄露内部信息
- **描述**：auth 路由的 `createErrorResponse` 对所有 Error 直接返回 message，绕过全局 error handler。
- **位置**：`user-backend/src/routes/auth.ts:64-72`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-16: 管理员权限仅靠邮箱环境变量
- **描述**：管理员邮箱列表从环境变量读取并缓存，需重启服务才能撤销权限。
- **位置**：`user-backend/src/middleware/requireAdmin.ts:5-9`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-17: useFavorites.ts 模块顶层 isClient 常量
- **描述**：`const isClient = typeof window !== 'undefined'` 在 SSR 时求值为 false，客户端 hydration 不会重新执行模块顶层代码，导致 ensureLoaded 在客户端也跳过 localStorage。
- **位置**：`frontend/composables/useFavorites.ts:23`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-18: follows.ts 未传 pool 参数
- **描述**：`getReadPoolSync()` 未传 fallback pool 参数，与其他路由不一致。
- **位置**：`bff/src/web/routes/follows.ts:11`
- **验证状态**：待验证
- **修复状态**：未修复

#### M-19: API 响应格式不统一
- **描述**：成功格式混用 `{ok:true,...}` 和直接数据；错误格式混用 `{error}` 和 `{ok:false,error}`。
- **位置**：多处路由
- **验证状态**：待验证
- **修复状态**：未修复

#### M-20: Wikidot 绑定吞掉上游错误
- **描述**：BFF 网络错误和 5xx 被伪装成"未找到用户/空结果"。
- **位置**：`user-backend/src/services/wikidotBinding.ts:46,88`
- **验证状态**：待验证
- **修复状态**：未修复

---

### Low（低）

#### L-1: series-availability.vue NUMERIC 字段 toFixed
- **描述**：直接对 API 返回的 NUMERIC 字段（可能是字符串）调用 `.toFixed()` 可能 throw TypeError。
- **位置**：`frontend/pages/series-availability.vue:40,43`
- **验证状态**：待验证
- **修复状态**：未修复

#### L-2: page/[wikidotId].vue 全局 SVG 选择器
- **描述**：`document.querySelector('svg')` 选中页面第一个 SVG（可能是导航图标），且 onMove 函数体为空（遗留代码）。
- **位置**：`frontend/pages/page/[wikidotId].vue:2131-2138`
- **验证状态**：待验证
- **修复状态**：未修复

#### L-3: sortedPools computed 中 Date.now() 非响应式
- **描述**：`Date.now()` 不是响应式依赖，过期卡池排序不会自动更新。
- **位置**：`frontend/composables/useGachaDraw.ts:111`
- **验证状态**：待验证
- **修复状态**：未修复

#### L-4: ranking.vue / user/[wikidotId].vue 缺 definePageMeta
- **描述**：缺少 page key 设置，路由复用时可能导致状态残留。
- **位置**：`frontend/pages/ranking.vue`、`frontend/pages/user/[wikidotId].vue`
- **验证状态**：待验证
- **修复状态**：未修复

#### L-5: Frontend 隐式依赖 consola
- **描述**：前端直接 `import 'consola'` 但未在 package.json 声明，依赖 Nuxt 传递依赖。
- **位置**：`frontend/plugins/bff.ts:2`
- **验证状态**：待验证
- **修复状态**：未修复

#### L-6: Backend PrismaClient __internal 私有 API
- **描述**：通过 `__internal` 私有 API 配连接池，升级 Prisma 时行为不可预期。
- **位置**：`backend/src/utils/db-connection.ts:28`
- **验证状态**：待验证
- **修复状态**：未修复

#### L-7: Backend 未使用的 uuid 依赖
- **描述**：`uuid` / `@types/uuid` 已声明但源码实际用 `crypto.randomUUID()`。
- **位置**：`backend/package.json:72`
- **验证状态**：待验证
- **修复状态**：未修复

#### L-8: /pages 接受无效参数
- **描述**：`isHidden`、`isUserPage` 参数被读取但 SQL 完全没使用。
- **位置**：`bff/src/web/routes/pages.ts:709`
- **验证状态**：待验证
- **修复状态**：未修复

#### L-9: live-db 测试结构不匹配
- **描述**：测试把 `/users/by-rank` 当数组读，实际接口返回 `{total,items}`，后半段测试无效。
- **位置**：`bff/tests/integration/live-db.test.ts:74`
- **验证状态**：待验证
- **修复状态**：未修复

#### L-10: CalendarTool markdown-it 渲染无 DOMPurify
- **描述**：markdown-it `html:false` 但无 DOMPurify 二次防护。
- **位置**：`frontend/components/tools/CalendarTool.vue:188,589`
- **验证状态**：待验证
- **修复状态**：未修复

#### L-11: formatRecipient 未防御邮件头注入
- **描述**：name 字段未检查换行符 `\r\n`，理论上可构成 MIME header injection。
- **位置**：`mail-agent/src/lib/templates.mjs:90-96`
- **验证状态**：待验证
- **修复状态**：未修复

#### L-12: legacy-vote-import $executeRawUnsafe
- **描述**：手工转义 SQL 而非参数化查询，维护性隐患。
- **位置**：`backend/src/cli/legacy-vote-import.ts:259-284`
- **验证状态**：待验证
- **修复状态**：未修复

#### L-13: DatabaseStore.loadProgress/append 死代码
- **描述**：旧架构遗留方法，已被 Phase A/B/C Processor 替代，不再被调用。
- **位置**：`backend/src/core/store/DatabaseStore.ts:40-88`
- **验证状态**：待验证
- **修复状态**：未修复

#### L-14: IncrementalAnalyzeJob as any 规避类型
- **描述**：`(this.prisma as any).siteOverviewDaily` 表明 Prisma schema/client 不同步。
- **位置**：`backend/src/jobs/IncrementalAnalyzeJob.ts:190-211`
- **验证状态**：待验证
- **修复状态**：未修复

#### L-15: 清库脚本不完整
- **描述**：新表未覆盖，外键失败仍输出"清空完成"。
- **位置**：`backend/scripts/clear-data.ts:201`
- **验证状态**：待验证
- **修复状态**：未修复

---

## 修复优先级计划

### Phase 1: 立即修复（安全关键）
1. C-1 验证码/重置码批量失效
2. C-2 公网拦截 `/api/internal/**`
3. C-3 useAuth SSR inflight 隔离
4. H-1 登录暴力破解防护
5. H-4 Mail Agent 强制 API key
6. H-9 + H-10 v-html XSS 修复
7. H-11 去除 session secret 弱默认值

### Phase 2: 短期修复（配置加固 + 数据安全）
8. H-2 CORS 生产配置
9. H-5 BFF 全局速率限制
10. H-8 Tracking debug 默认关闭
11. H-15 HTML Snippet 路由认证
12. H-12 注册接口邮箱枚举
13. M-17 useFavorites isClient 修复

### Phase 3: 中期改善（性能 + 健壮性）
14. H-6 + M-4 搜索/列表 limit 硬上限
15. H-7 Tracking 去重改 UPSERT
16. H-13 Phase C 迭代上限
17. M-1 fetchAuthUser 错误日志
18. M-3 collections.ts try/finally
19. M-5 搜索正则 JS 侧超时
20. M-6 Phase A 复合索引
21. M-9 缓存 singleflight

### Phase 4: 代码质量（清理 + 一致性）
22. M-2 Collections 事务
23. M-7 Phase C 批量入队
24. M-8 DirtyQueue 分页
25. M-10 stats 日期验证
26. M-14 Token 查询 expiresAt
27. M-15 createErrorResponse 分级
28. M-18 follows.ts pool 参数
29. M-19 API 响应格式统一
30. M-20 Wikidot 绑定错误处理
31. 所有 Low 级别问题

---

## 交叉验证记录（Codex GPT-5.4 xhigh）

### 确认为 Bug — 需要修复（27 项）

| 编号 | 原始严重性 | Codex 调整后 | Codex 理由摘要 |
|------|-----------|-------------|---------------|
| C-1 | Critical | **High** | Bug 确认。旧 token 不作废，可覆盖 passwordHash。但需要已获取旧邮件，降为 High |
| C-2 | Critical | **High** | Bug 确认。前端代理 → BFF loopback，绕过 IP 检查，内部 API 暴露 |
| H-1 | High | **High** | Bug 确认。登录无限流、无退避、无锁定 |
| H-2 | High | **Medium** | Bug 确认。但 SameSite=lax 降低实际可利用性 |
| H-3 | High | **Medium** | Bug 确认。缓存 30 秒内旧权限可通过，但窗口短 |
| H-4 | High | **High** | Bug 确认。API key 可选，generic 模板可滥用发信 |
| H-6 | High | **High** | Bug 确认。limit 无上限，candidateLimit 放大 4x |
| H-7 | High | **Medium** | Bug 确认。IP 可伪造 + 非原子计数。主要影响统计准确性 |
| H-8 | High | **High** | Bug 确认。生产默认全量落库隐私数据 |
| H-12 | High | **Medium** | Bug 确认。注册返回"已注册"可枚举，对比重置已正确 |
| H-13 | High | **Medium** | Bug 确认。分页循环无最大迭代限制 |
| H-15 | High | **Medium** | Bug 确认。POST 无认证，CSP 禁脚本但可存钓鱼 HTML |
| M-1 | Medium | **Medium** | Bug 确认。认证服务故障被伪装为"未登录" |
| M-2 | Medium | **Medium** | Bug 确认。默认收藏夹切换/追加排序非原子（reorder 已有事务） |
| M-4 | Medium | **Medium** | Bug 确认。pages/search 无硬上限（users.ts 已有 clamp，排除） |
| M-5 | Medium | **Low** | Bug 确认。但 snippet 被截到 ~300 字，影响被压低 |
| M-7 | Medium | **Medium** | Bug 确认。await queue.add() 串行化并发队列 |
| M-9 | Medium | **Medium** | Bug 确认。并发 miss 重复跑 loader，thundering herd |
| M-10 | Medium | **Low** | Bug 确认。坏日期变 500 应尽早 400 |
| M-12 | Medium | **Low** | Bug 确认。消费后可立即重新请求 |
| M-15 | Medium | **Medium** | Bug 确认。mail-agent 失败信息拼入 message 暴露给前端 |
| M-20 | Medium | **Medium** | Bug 确认。上游 5xx/超时伪装为空结果 |
| L-3 | Low | **Low** | Bug 确认。卡池排序不随时间自动更新 |
| L-5 | Low | **Low** | Bug 确认。consola 隐式依赖 |
| L-6 | Low | **Low** | Bug 确认。__internal 私有 API 升级脆弱 |
| L-7 | Low | **Low** | Bug 确认。uuid 未使用依赖 |
| L-8 | Low | **Low** | Bug 确认。参数被读取但 SQL 未使用 |
| L-9 | Low | **Low** | Bug 确认。测试结构不匹配导致后半段无效 |
| L-15 | Low | **Medium** | Bug 确认，升级。新表未覆盖 + FK 错误仍显示"完成" |

### 设计意图 / 技术债（非 Bug，不修复或低优先级）

| 编号 | 原始严重性 | Codex 判定 | 理由 |
|------|-----------|-----------|------|
| H-5 | High | 设计意图 → Low | 架构取舍，真正高风险点体现在 H-1/H-6/H-7 端点级问题 |
| H-9 | High | 设计意图 → Low | snippet 来源 preview.ts 已 escapeHtml，regex 也逐段转义 |
| H-10 | High | 误报 → Low | stripHtml 后已是纯文本，v-html 多余但无当前 XSS |
| H-11 | High | 设计意图 → Low | 弱默认值仅开发回退，生产已强制 secret |
| M-6 | Medium | 设计意图 → Low | 性能优化空间，非正确性 bug |
| M-8 | Medium | 设计意图 → Low | 注释已说明全量 preload 是避免 N+1 的折中 |
| M-11 | Medium | 设计意图 → Low | generic 模板是扩展能力，当前只走 verification |
| M-13 | Medium | 设计意图 → 无 | 单实例部署下内存限流合理 |
| M-14 | Medium | 设计意图 → Low | 性能债，逻辑上已有二次过期判断 |
| M-16 | Medium | 设计意图 → Low | 静态 env 方案的自然结果 |
| M-19 | Medium | 设计意图 → Low | API 契约不统一属设计债 |
| L-2 | Low | 设计意图 → 无 | 遗留占位代码，空函数无运行时影响 |
| L-12 | Low | 设计意图 → Low | CLI 场景受控折中，有约束/转义 |
| L-13 | Low | 设计意图 → 无 | 死代码/维护债 |

### 误报（排除，不修复）

| 编号 | 原始严重性 | 误报理由 |
|------|-----------|---------|
| C-3 | Critical | `fetchInflight` 在函数体内而非模块级，每次 `useAuth()` 调用有独立闭包，不会跨请求共享 |
| H-14 | High | PM2 入口已是 `./dist/src/index.js`，产物实际存在，是已修复或过期问题 |
| M-3 | Medium | 所有早退路径和 catch 都显式 release，没有实际连接泄漏路径 |
| M-17 | Medium | Nuxt 客户端 bundle 会重新求值模块顶层代码，浏览器中 isClient 为 true |
| M-18 | Medium | 正常启动路径先 initPools()，此时 getReadPoolSync() 不需要 fallback |
| L-1 | Low | BFF 返回的是重新计算后的 JS number，非数据库 NUMERIC 字符串 |
| L-4 | Low | ranking 是静态路由不需 page key；user 页已用动态 key + watch |
| L-10 | Low | markdown-it html:false 已阻止原始 HTML，防护足够 |
| L-11 | Low | Nodemailer 内部会重新解析并规范化地址头，不构成 header injection |
| L-14 | Low | schema 已定义 SiteOverviewDaily，as any 只是类型写法粗糙 |

---

## 修复优先级计划（交叉验证后修订版）

### Phase 1: 安全关键（7 项确认 Bug）
| 序号 | 编号 | 调整后严重性 | 描述 | 涉及服务 |
|------|------|-------------|------|---------|
| 1 | C-1 | High | 验证码/重置码批量失效 | user-backend |
| 2 | C-2 | High | 公网拦截 /api/internal/** | frontend + bff |
| 3 | H-1 | High | 登录暴力破解防护 | user-backend |
| 4 | H-4 | High | Mail Agent 强制 API key | mail-agent |
| 5 | H-6 | High | 搜索 limit 硬上限 | bff |
| 6 | H-8 | High | Tracking debug 默认关闭 | bff |
| 7 | M-15 | Medium | createErrorResponse 分级 | user-backend |

### Phase 2: 健壮性（8 项确认 Bug）
| 序号 | 编号 | 调整后严重性 | 描述 | 涉及服务 |
|------|------|-------------|------|---------|
| 8 | H-2 | Medium | CORS 生产配置 | bff + user-backend |
| 9 | H-3 | Medium | 鉴权缓存改密后失效 | user-backend |
| 10 | H-7 | Medium | Tracking 去重改 UPSERT | bff |
| 11 | H-12 | Medium | 注册邮箱枚举修复 | user-backend |
| 12 | H-13 | Medium | Phase C 迭代上限 | backend |
| 13 | H-15 | Medium | HTML Snippet 路由认证 | bff |
| 14 | M-1 | Medium | fetchAuthUser 错误日志 | bff |
| 15 | M-20 | Medium | Wikidot 绑定错误处理 | user-backend |

### Phase 3: 性能 + 代码质量（12 项确认 Bug）
| 序号 | 编号 | 调整后严重性 | 描述 | 涉及服务 |
|------|------|-------------|------|---------|
| 16 | M-2 | Medium | Collections 并发事务 | bff |
| 17 | M-4 | Medium | 列表 limit/offset 硬上限 | bff |
| 18 | M-7 | Medium | Phase C 批量入队 | backend |
| 19 | M-9 | Medium | 缓存 singleflight | bff |
| 20 | L-15 | Medium | 清库脚本补全 | backend |
| 21 | M-5 | Low | 搜索正则超时 | bff |
| 22 | M-10 | Low | stats 日期验证 | bff |
| 23 | M-12 | Low | 验证码速率冷却期 | user-backend |
| 24 | L-3 | Low | sortedPools 时钟源 | frontend |
| 25 | L-5 | Low | consola 显式声明 | frontend |
| 26 | L-6 | Low | PrismaClient 官方配置 | backend |
| 27 | L-7 | Low | 删除 uuid 依赖 | backend |
| 28 | L-8 | Low | 删除无效参数 | bff |
| 29 | L-9 | Low | 修复 live-db 测试 | bff |

---

## PR 记录

| PR | 覆盖问题 | 状态 |
|----|----------|------|
| [#17](https://github.com/AndyBlocker/scpper-cn/pull/17) | C-1, C-2, H-1, H-4, H-6, H-8, M-15 | ✅ Merged & Deployed |
| [#18](https://github.com/AndyBlocker/scpper-cn/pull/18) | H-2, H-3, H-7, H-12, H-13, H-15, M-1, M-20 | ✅ Merged & Deployed |
| [#19](https://github.com/AndyBlocker/scpper-cn/pull/19) | M-2, M-4, M-7, M-9, M-10, L-5, L-7, L-8, L-9 | ✅ Merged & Deployed |
