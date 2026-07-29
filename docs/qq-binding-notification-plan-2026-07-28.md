# SCPper CN × QQ 绑定与通知中枢 — 最终实施计划

> 版本：2026-07-28 定稿（技术负责人合成稿）
> 三套架构方案（minimal / agent-service / notification-hub）的合成结果
> 涉及仓库：`/home/andyblocker/scpper-cn`（受保护 main + worktree 流程）、`/home/andyblocker/qqbot`（独立仓库）

---

## 1. 结论与取舍

### 1.1 骨架：采用 **minimal**

三套方案的核心分歧在两点：**要不要新建 qq-agent 微服务**、**要不要改三个告警 producer**。我的判断：

**不新建 qq-agent。** agent-service 的论证（隔离 qqbot 的 208646 次重启、收敛失败面、凭据爆炸半径）全部成立，但它的解法代价不成比例：qq-agent 不可能持有 NapCat 登录态，它必然退化为纯转发层，换来一个新 PM2 进程、新端口、新 `.env`、`scripts/dev-worktree.sh` + `scripts/service-runner.mjs` 三处登记、一份 SQLite 本地状态（破坏 mail-agent 的无状态范式且不可扩实例）、以及一跳网络。它想解决的问题（重试、死信、限流、降级）**全部可以在 dispatcher 内部用一张主库投递表解决**，而且离数据更近、离决策更近。

**不改 producer。** agent-service 与 notification-hub 都要求三个 Job 在插 alert 的同事务里写 outbox，这意味着改 `PageMetricMonitorJob` 的三处 `createMany`、`UserFollowActivityJob` 的三处 `$executeRaw`、`ForumInteractionAlertJob` 的 `RETURNING`。这些代码跑在 `scpper-sync` 的关键路径上（有全局租约锁 + 15 分钟无进展看门狗），且与「未读折叠」这个非平凡去重语义纠缠。minimal 的**旁路扫描 + 投递去重表**用 24 小时回看窗口 + `dedupeKey` 反连接达到同等效果，producer 一行不改，可随时回滚（停一个 PM2 app）。这是本次风险收益比最高的单条决策。

### 1.2 嫁接自 agent-service

| 嫁接项 | 落点 |
|---|---|
| **投递状态机 + 错误分类** | `NotificationDelivery.state ∈ {PENDING,SCHEDULED,SENDING,SENT,FAILED,SUPPRESSED,CANCELLED}`；`not_friend`/`blocked` 为永久错误直接 FAILED，`bot_offline`/`timeout` 指数退避 |
| **渠道健康态与自动暂停** | `NotificationChannelBinding.failureCount / suspendedUntil / lastFailureCode`，连续失败 3 次自动 PAUSED + 邮件告知 |
| **邮件降级** | 仅对 `ACCOUNT_SECURITY` 与 `FORUM_DIRECT_REPLY` 白名单，复用 mail-agent `generic` 模板 |
| **五把独立密钥矩阵 + `timingSafeEqual`** | 见 §10.2 |
| **契约版本号** | qqbot `/scpper/qq/health` 返回 `contract: "1.0.0"`，调用方启动时校验 |
| **qqbot 侧 dedup_key + 批量推送** | `POST /scpper/qq/push/batch` |
| **Phase 0 前置修复清单** | `UserTagPreference` 序列耗尽、缺失索引、schema drift |

### 1.3 嫁接自 notification-hub

| 嫁接项 | 落点 |
|---|---|
| **QQ 是「渠道绑定」而非「账号字段」** | 用户库建 `NotificationChannelBinding(channel, address, ...)`，**不在 `UserAccount` 上加 `linkedQqNumber` 列**。加第二个外部渠道时零 schema 改动 |
| **偏好三级继承（GLOBAL / CATEGORY / EVENT_TYPE）** | `NotificationPreference(scope, scopeKey, channel)` 只存显式覆盖，默认值是代码常量 |
| **解析后的矩阵物化到 binding 行** | `NotificationChannelBinding.resolvedMatrix Json` —— 这是我对 notification-hub「跨库投影表」的简化：dispatcher 反正要读 binding 拿 QQ 号，顺手读矩阵，**彻底消灭投影表与 profileVersion 乱序问题**，默认值定义权唯一属于 user-backend |
| **站内已读 → 取消未投递的 Delivery** | `POST /notifications/read` 同事务把该 alert 的 `PENDING/SCHEDULED` Delivery 置 `CANCELLED`。用户已经在站内看到了就不该再收 QQ 私信 —— 这是中枢模型才做得到的体验 |
| **单一时间线 + 投递状态徽章 + 「此处以上全部已读」** | 前端通知中心 |
| **独立路由而非 tab** | `/account/notifications`、`/account/notifications/settings`、`/account/following` |
| **完整的 34 条前端 bug 清单** | §9 |

### 1.4 明确放弃的（诚实披露）

1. **放弃统一 Notification 物理表。** 三张告警表继续存在，feed 用 `UNION ALL` 在读侧统一。代价：跨表 keyset 分页 SQL 复杂、深翻页性能不如单表、未读总数要跑三个 `COUNT`。收益：零数据迁移、零 producer 改动、任一阶段可回滚。当前量级（未读 14626+16210+2019）完全够用。notification-hub 的三层模型（Event/Notification/Delivery）是正确的终局，但不该和 QQ 绑定这个需求捆在一起做——留作 §12 的未决项。
2. **放弃降低事件产生延迟。** 端到端最坏仍接近 **90 分钟**（`sync-hourly` 整点触发 + 单轮 19-27 分钟）。本方案只把**投递**延迟压到 ≤60 秒。产品文案必须体现这一点。
3. **放弃「每次变化精确推送」。** 未读折叠下用 `contentSig = newValue` 近似；票数 120→141→141 的回落再涨回同值会被吞掉。
4. **放弃 QQ 号加密列。** 用明文 + `@unique` + API 全掩码 + DB 权限收口。加密需要 HMAC 索引列 + 密文列 + 密钥管理三件套，对本项目规模是负收益（详见 §10.4）。
5. **放弃多账号双活。** 仅 1248393597 在线，`get_bot_for_send()` 是单点。用「队列重试 + 邮件降级 + 站内永远可靠」兜底。

---

## 2. 系统拓扑

### 2.1 拓扑图

```
                       ┌─────────────────────────────────────────────┐
   浏览器 ──/api/**──▶ │ frontend  Nuxt 4   :9876 (dev 19876)        │
                       │  /account/notifications          ★重做      │
                       │  /account/notifications/settings ★新        │
                       │  /account/following              ★新        │
                       │  /account (资料 → 账号绑定分组含 QQ 卡) ★改 │
                       └───────────────────┬─────────────────────────┘
                                           │ nitro proxy /api/** → 4396
                       ┌───────────────────▼─────────────────────────┐
                       │ BFF  :4396 (dev 14396)                      │
                       │  routes/notifications.ts     ★新 统一 feed   │
                       │  routes/alerts.ts     改（去 30s 缓存/修 bug）│
                       │  routes/follows.ts    改（修注入/加分页）     │
                       │  router.ts  ★新增反代 /qq-binding            │
                       │             ★新增反代 /notification-settings │
                       └──┬──────────────────────────┬───────────────┘
              主库 pg     │                          │ http proxy (cookie 透传)
                          │                          │
   ┌──────────────────────▼───────────┐   ┌──────────▼──────────────────────────┐
   │ PostgreSQL 127.0.0.1:5434        │   │ user-backend  :4455 (dev 14455)     │
   │ ┌──────────────────────────────┐ │   │  routes/qqBinding.ts          ★新   │
   │ │ scpper-cn  (主库)            │ │   │  routes/notificationSettings.ts ★新 │
   │ │  PageMetricAlert    (不动)   │ │   │  routes/internalNotifications.ts★新 │
   │ │  UserActivityAlert  (不动)   │ │   │  services/qqBinding.ts        ★新   │
   │ │  ForumInteractionAlert(不动) │ │   │  services/notificationPrefs.ts★新   │
   │ │  UserMetricPreference(产生层)│ │   │  services/qqPush.ts           ★新   │
   │ │  NotificationDelivery   ★新  │ │   │  routes/auth.ts   改（透出 QQ 掩码）│
   │ │  NotificationDispatchState★新│ │   │  middleware/requireAuth.ts 改       │
   │ └──────────────────────────────┘ │   └──┬────────────────┬─────────────────┘
   │ ┌──────────────────────────────┐ │      │ Prisma(写)     │ HTTP Bearer
   │ │ scpper_user (用户库)         │◀┼──────┘                │
   │ │  UserAccount                 │ │  ┌───────────────────┐│
   │ │  NotificationChannelBinding★ │ │  │ mail-agent :3110  ││
   │ │  ChannelBindingChallenge   ★ │ │  │ (降级通道，不改)   ││
   │ │  NotificationPreference    ★ │ │  └───────────────────┘│
   │ └──────────────────────────────┘ │                       │
   └────▲──────────────▲──────────────┘                       │
        │ 主库读写      │ 用户库【只读】                        │
   ┌────┴──────────────┴────────────────────────┐              │
   │ backend  (PM2, tsx 直跑 src/)              │              │
   │  scpper-sync           不动                │              │
   │  scpper-binding-verify 不动                │              │
   │  scpper-notify         ★新 (60s 轮询)      │              │
   │    jobs/NotificationDispatchJob.ts         │              │
   │    services/qqPush.ts                      │              │
   │    services/userDirectory.ts (只读第二 PC) │              │
   └────┬───────────────────────────────────────┘              │
        │ POST /scpper/qq/push[/batch]  Authorization: Bearer   │
        │ POST /internal/notifications/report-delivery ─────────┤
        │                                                      │
   ┌────▼──────────────────────────────────────────────────────┴──┐
   │ qqbot  NoneBot2 + FastAPI driver  127.0.0.1:8080             │
   │   src/plugins/scpper/external_api.py   ★新 health/friend/push│
   │   src/plugins/scpper/qq_verify.py      ★新 私聊收码 + 指令   │
   │   src/plugins/scpper/friend_request.py ★新 好友申请自动同意  │
   │   src/plugins/scpper/monitor/notify.py 改 +send_private_text │
   │   __init__.py / config.py / .env       改                    │
   │        │ POST /internal/qq-binding/verify   x-internal-key ──┘
   └────────┼─────────────────────────────────────────────────────┘
            │ 反向 WebSocket ws://127.0.0.1:8080/onebot/v11/ws（已建立，本次补 token）
   ┌────────▼─────────────┐
   │ NapCat (docker,host) │──── QQ 私信 ───▶ 用户
   └──────────────────────┘

★ = 本次新增    改 = 本次修改    不动 = 零改动
新增 PM2 app 数量：1（scpper-notify）。新增端口：0。
```

### 2.2 数据流 A：绑定流

```
① 用户在 /account 的「账号绑定」分组点【绑定 QQ】
     → POST /api/qq-binding/start  (BFF 反代 → user-backend, requireAuth)
② user-backend.startQqBinding(userId)
     · 限流：userId 5 次/15min + IP 20 次/15min
     · 无锁 fail-fast：已有 ACTIVE 的 QQ binding → 400「已绑定，请先解绑」
     · Serializable 事务：lockAccount(FOR UPDATE) → 作废旧 PENDING challenge
       → 生成 12 位码 → 存 codeHash=sha256(code) + codeHint=code[7:11]
       → create challenge，expiresAt = now + 15min
     · P2002 码碰撞 → 整事务换码重试，最多 10 次
③ 响应返回【明文码，一生仅此一次】+ 机器人 QQ 号 + 加好友深链
④ 用户加机器人好友 → friend_request.py 自动同意 → 机器人主动私聊发引导语
⑤ 用户把码私聊发给机器人
⑥ qq_verify.py（on_message priority=1 block=False，形参 PrivateMessageEvent）
     · 正则抓 SCPPER-XXXXXXXXXXXX
     · sub_type != 'friend' → 本地回复「请先加好友」，不回调
     · 进程内节流：同 user_id 3 次/60s
     · 查好友缓存拿 is_friend
     · POST http://127.0.0.1:4455/internal/qq-binding/verify
       header x-internal-key: SCPPER_INTERNAL_TOKEN
⑦ user-backend.verifyQqBinding()
     · 按 codeHash findUnique（O(1)）
     · Serializable：lockAccount → lockChallenge（顺序固定，防死锁）
     · 校验 status/expiresAt/是否本人最新 challenge/isFriend
     · 条件插入 binding：INSERT ... WHERE NOT EXISTS(channel='QQ' AND address=?)
     · challenge 置 VERIFIED；计算并写入 resolvedMatrix
     · P2002 兜底；count!==1 必须 throw 而非 return
     · 事务外：invalidateAuthCache(userId)
⑧ 返回 {ok, matched, reply}，reply 是中文文案（唯一权威在 user-backend）
⑨ qqbot 把 reply 原样私聊回给用户
⑩ 事务外：user-backend 调 services/qqPush.ts 发一条绑定成功回执
     （失败只记日志，绝不回滚绑定；这条回执同时是推送通道的端到端冒烟）
⑪ 前端 5 秒轮询 GET /api/qq-binding/status 看到 ACTIVE，卡片转绿并提示「去设置通知偏好」
```

### 2.3 数据流 B：推送流

```
scpper-notify 每 60 秒一轮（NotificationDispatchJob.runCycle）：

① 拉活跃收件人（先收窄再扫描，这是性能关键）
     用户库【只读】：SELECT ... FROM "NotificationChannelBinding"
       WHERE channel='QQ' AND status='ACTIVE'
         AND ("suspendedUntil" IS NULL OR "suspendedUntil" < now())
     → 得到 {userId(cuid), address, quietHours, digestMode, dailyLimit, resolvedMatrix}
     → 用同一 client 取 UserAccount.linkedWikidotId（status='ACTIVE'）
     → 主库 SELECT id, "wikidotId" FROM "User" WHERE "wikidotId" = ANY($1)
     → 得到 mainUserId 集合（通常 < 200），60 秒内存缓存

② 三条扫描 SQL（仅在上述 mainUserId 集合内），窗口
     detectedAt > GREATEST(now() - INTERVAL '24 hours', $NOTIFY_DISPATCH_START_AT)
     LEFT JOIN "NotificationDelivery" ON dedupeKey 反连接排除已投递

③ 逐条裁决（纯函数 decideDelivery()，可单测）
     resolvedMatrix[eventType].QQ !== true      → 跳过（不落 Delivery 行，省表）
     命中免打扰 且 mode=DEFER                    → SCHEDULED + scheduledAt
     命中免打扰 且 mode=DROP                     → SUPPRESSED(quiet_hours)
     日配额超限                                  → SUPPRESSED(daily_limit)
     单用户单轮 > NOTIFY_CIRCUIT_USER_MAX(20)     → 只留 20 条 + 摘要，其余 SUPPRESSED(circuit_user)
     全局单轮 > NOTIFY_CIRCUIT_GLOBAL_MAX(2000)   → 整轮只写 SUPPRESSED + logger.error，不发任何消息
     否则                                        → PENDING

④ 取 PENDING + 到期 SCHEDULED，按 (userId) 聚合为一条摘要消息
     同 batchId(uuid)；最多列 8 条明细 + 「另有 N 条」+ 站内深链 + 退订提示

⑤ POST /scpper/qq/push/batch（≤50 条/请求，dedup_key = batchId）
     成功 → SENT + sentAt + providerMessageId
     not_friend / blocked → FAILED + 立刻 POST /internal/notifications/report-delivery
     bot_offline / timeout / 5xx → attempts+1，退避 1m/5m/30m/2h/6h，≥5 次 FAILED

⑥ 【绝不写 acknowledgedAt】——站内红点保持"用户主动点击"语义

延迟：alert 落库 → QQ 送达 ≤ 60 秒 + 一次批量发送耗时。
      事件发生 → alert 落库 仍受 sync-hourly 约束（最坏 ~90 分钟，本次不解决）。
```

---

## 3. 数据模型

### 3.1 库归属决策

| 数据 | 落库 | 硬理由 |
|---|---|---|
| QQ 号 / 绑定挑战 / 渠道设置 / 事件偏好 | **用户库 `scpper_user`** | 与 `UserAccount` 同生命周期需 `onDelete: Cascade`；主库 `User` 行可被 `ensureUserByWikidotId` 凭空 INSERT，不能挂身份数据；qqbot 直连主库 |
| 解析后的路由矩阵 `resolvedMatrix` | **用户库（binding 行内）** | dispatcher 反正要读 binding 拿地址，顺手拿矩阵，零额外查询、零投影表、默认值定义权唯一 |
| 投递账本 `NotificationDelivery` | **主库 `scpper-cn`** | `alertId` 指向主库三张表；dispatcher 的反连接必须在同库内做 |
| 告警产生层阈值（voteThreshold / revisionFilter / muted） | **主库 `UserMetricPreference`（不动）** | `PageMetricMonitorJob` 在同库读它，本次不迁移 |

**跨库关联链（唯一路径）：**
```
UserAccount.id (cuid)
  → UserAccount.linkedWikidotId (Int @unique)
  → 主库 User.wikidotId → 主库 User.id (Int)
  → PageMetricAlert / UserActivityAlert / ForumInteractionAlert / NotificationDelivery
```
**写入方向严格单一**：用户库只有 user-backend 能写；backend 的 dispatcher 只读直连（先例：`backend/src/cli/alerts.ts` L58-125 已用 `createRequire` 加载 user-backend 的 Prisma client）。qqbot **完全不接触用户库**。

---

### 3.2 用户库迁移

文件：`user-backend/prisma/schema.prisma`

```prisma
enum NotificationChannelKind { WEB EMAIL QQ }

enum ChannelBindingStatus {
  ACTIVE
  PAUSED     // 连续投递失败 / 用户临时暂停 / 被对端拉黑
  REVOKED    // 用户主动解绑，保留行占位 7 天防抢绑
}

enum ChannelBindingChallengeStatus { PENDING VERIFIED EXPIRED CANCELLED FAILED }

enum NotificationDigestMode { INSTANT HOURLY DAILY OFF }

enum NotificationQuietMode { DEFER DROP }

enum NotificationPreferenceScope { GLOBAL CATEGORY EVENT_TYPE }

model NotificationChannelBinding {
  id              String                  @id @default(cuid())
  userId          String
  user            UserAccount             @relation(fields: [userId], references: [id], onDelete: Cascade)
  channel         NotificationChannelKind

  // QQ 号明文（需要等值查询 + 唯一约束）。API 一律只返回 addressMask，见 §10.4
  address         String
  addressMask     String                  @db.VarChar(64)   // "1234****9"
  displayLabel    String?                 @db.VarChar(64)   // QQ 昵称快照，仅展示

  status          ChannelBindingStatus    @default(ACTIVE)
  verifiedAt      DateTime?

  // ── 传输策略（渠道级）──
  quietStartMin   Int?                    // 0..1439，本地分钟；start > end 表示跨零点
  quietEndMin     Int?
  quietMode       NotificationQuietMode   @default(DEFER)
  timezone        String                  @default("Asia/Shanghai")
  digestMode      NotificationDigestMode  @default(INSTANT)
  dailyLimit      Int                     @default(40)      // 0 = 不限

  // ── 解析后的事件矩阵（由 user-backend 在每次偏好写入时重算物化）──
  // { "FORUM_MENTION": true, "PAGE_VOTE": false, ... }  只含本 channel 的布尔
  resolvedMatrix  Json
  matrixVersion   Int                     @default(1)       // 默认值表版本，用于批量重算

  // ── 健康态 ──
  failureCount    Int                     @default(0)
  lastFailureAt   DateTime?
  lastFailureCode String?                 @db.VarChar(32)
  suspendedUntil  DateTime?
  healthNotifiedAt DateTime?                                // 降级邮件去重
  lastDeliveryAt  DateTime?
  sentToday       Int                     @default(0)
  sentDayKey      String?                 @db.VarChar(10)   // 'YYYY-MM-DD' 本地日，跨天重置

  unsubscribeToken String                 @unique           // 32 字节 base64url
  createdAt       DateTime                @default(now())
  updatedAt       DateTime                @updatedAt

  @@unique([channel, address], map: "uniq_channel_binding_address")
  @@unique([userId, channel],  map: "uniq_channel_binding_user_channel")
  @@index([channel, status], map: "idx_channel_binding_channel_status")
}

model ChannelBindingChallenge {
  id              String                        @id @default(cuid())
  userId          String
  user            UserAccount                   @relation(fields: [userId], references: [id], onDelete: Cascade)
  channel         NotificationChannelKind

  // 明文码只在 POST /qq-binding/start 的响应里出现一次；DB 只存 sha256。
  // 回调是按精确码反查，hash 查找同样 O(1)。对齐 services/AGENTS.md「验证码不得明文落库」
  codeHash        String                        @unique
  codeHint        String                        @db.VarChar(4)   // 明文码前 4 位，仅供 /status 的 UI 提示

  observedAddress String?                                        // 回调时机器人观测到的 QQ 号
  status          ChannelBindingChallengeStatus @default(PENDING)
  expiresAt       DateTime
  verifiedAt      DateTime?
  attemptCount    Int                           @default(0)      // ★ WikidotBindingTask 缺失的爆破防护
  lastNonce       String?                       @db.VarChar(64)  // 机器人 message_id，回调幂等
  failureReason   String?                       @db.VarChar(200)
  createdAt       DateTime                      @default(now())
  updatedAt       DateTime                      @updatedAt

  @@index([userId, status])
  @@index([status, expiresAt])
}

model NotificationPreference {
  id         String                      @id @default(cuid())
  userId     String
  user       UserAccount                 @relation(fields: [userId], references: [id], onDelete: Cascade)
  scope      NotificationPreferenceScope
  scopeKey   String                      @db.VarChar(64)  // '*' | 'FORUM' | 'FORUM_MENTION'
  channel    NotificationChannelKind
  enabled    Boolean
  createdAt  DateTime                    @default(now())
  updatedAt  DateTime                    @updatedAt

  @@unique([userId, scope, scopeKey, channel], map: "uniq_notification_pref")
  @@index([userId])
}
```

`model UserAccount` 追加三条关系（**不加任何 QQ 标量列**）：
```prisma
  channelBindings         NotificationChannelBinding[]
  channelChallenges       ChannelBindingChallenge[]
  notificationPreferences NotificationPreference[]
```

迁移文件 `user-backend/prisma/migrations/20260801100000_notification_channels/migration.sql`，严格模仿 `20260103120000_add_wikidot_binding_task` 的风格（`-- CreateEnum` / `-- CreateTable` / `-- CreateIndex` / `-- AddForeignKey`，标识符双引号 camelCase，时间列 `TIMESTAMP(3)`，FK `ON DELETE CASCADE ON UPDATE CASCADE`）。

---

### 3.3 主库迁移

文件：`backend/prisma/schema.prisma`

```prisma
enum NotificationChannel { WEB EMAIL QQ }

enum NotificationEventType {
  PAGE_COMMENT                // ← PageMetricAlert.metric = COMMENT_COUNT
  PAGE_VOTE                   // ← VOTE_COUNT
  PAGE_REVISION               // ← REVISION_COUNT
  FOLLOW_REVISION             // ← UserActivityAlert.type = 'REVISION'
  FOLLOW_ATTRIBUTION          // ← 'ATTRIBUTION'
  FOLLOW_ATTRIBUTION_REMOVED  // ← 'ATTRIBUTION_REMOVED'
  FORUM_PAGE_REPLY            // ← ForumInteractionAlert.type = PAGE_REPLY
  FORUM_DIRECT_REPLY          // ← DIRECT_REPLY
  FORUM_MENTION               // ← MENTION
  ACCOUNT_SECURITY            // ← user-backend 直发（绑定/解绑/渠道暂停）
}

enum NotificationDeliveryState {
  PENDING SCHEDULED SENDING SENT FAILED SUPPRESSED CANCELLED
}

/// 投递账本。与 acknowledgedAt（用户已读）完全正交，绝不互相写。
model NotificationDelivery {
  id         BigInt                    @id @default(autoincrement())
  userId     Int                       // 主库 User.id
  user       User                      @relation(fields: [userId], references: [id], onDelete: Cascade)
  channel    NotificationChannel
  eventType  NotificationEventType
  alertKind  String                    @db.VarChar(24)  // PAGE_METRIC | FOLLOW_ACTIVITY | FORUM_INTERACTION
  alertId    Int

  /// sha1('<channel>|<alertKind>|<alertId>|<contentSig>')
  /// contentSig：PAGE_METRIC 取 String(newValue)；FOLLOW_ACTIVITY 取 String(pageVersionId ?? 0)；
  /// FORUM_INTERACTION 取 ''。
  /// 把 contentSig 纳入唯一键是刚需：PageMetricAlert/UserActivityAlert 采用「未读折叠」，
  /// 同一行的 newValue 会被反复就地更新，仅用 alertId 去重会永久漏掉后续变化。
  dedupeKey  String                    @unique(map: "uniq_notification_delivery_dedupe")

  detectedAt DateTime                                   // = alert.detectedAt
  state      NotificationDeliveryState @default(PENDING)
  scheduledAt DateTime?                                 // 免打扰 DEFER / digest 模式
  attempts   Int                       @default(0)
  lastError  String?                   @db.VarChar(512)
  failureCode String?                  @db.VarChar(32)  // not_friend|blocked|bot_offline|timeout|unknown
  suppressReason String?               @db.VarChar(32)  // preference_off|quiet_hours|daily_limit|circuit_user|circuit_global
  batchId    String?                   @db.VarChar(36)
  providerMessageId String?            @db.VarChar(64)
  sentAt     DateTime?
  createdAt  DateTime                  @default(now())
  updatedAt  DateTime                  @updatedAt

  @@index([state, scheduledAt],  map: "idx_notification_delivery_state_sched")
  @@index([userId, createdAt],   map: "idx_notification_delivery_user_created")
  @@index([alertKind, alertId],  map: "idx_notification_delivery_alert")
  @@index([detectedAt],          map: "idx_notification_delivery_detected")
}

/// 单行状态表：熔断标记与巡检游标
model NotificationDispatchState {
  id              Int       @id @default(1)
  circuitTrippedAt DateTime?
  circuitReason   String?   @db.VarChar(200)
  lastCycleAt     DateTime?
  lastCycleStats  Json?
  updatedAt       DateTime  @updatedAt
}
```

`model User` 追加：
```prisma
  notificationDeliveries NotificationDelivery[]
```

### 3.4 Phase 0 修复性迁移（独立上线，不含任何 QQ 代码）

`backend/prisma/migrations/20260801090000_notification_prereq/migration.sql`：

```sql
-- 1) 生产事故止血：UserTagPreference 序列已达 int32 上限，
--    导致每轮 analyze 的 user_social_analysis 失败（被 analysisFatal:false 吞掉）
ALTER TABLE "UserTagPreference" ALTER COLUMN "id" TYPE BIGINT;
ALTER SEQUENCE "UserTagPreference_id_seq" AS BIGINT MAXVALUE 9223372036854775807;

-- 2) 20251018 脚本声明了但生产库缺失；BFF 的列表查询正是
--    WHERE "followerId"=$1 ORDER BY "detectedAt" DESC
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_user_activity_follower_detected"
  ON "UserActivityAlert" ("followerId", "detectedAt" DESC);

-- 3) /alerts 未读路径缺索引（实测最重用户 6894 条 watch，读 19k buffer 只为返回 20 行）
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_page_metric_alert_watch_unread"
  ON "PageMetricAlert" ("watchId", "detectedAt" DESC)
  WHERE "acknowledgedAt" IS NULL;

-- 4) feed 端点的跨表游标分页需要
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_page_metric_alert_detected"
  ON "PageMetricAlert" ("detectedAt" DESC);
```

> `CREATE INDEX CONCURRENTLY` 不能在事务里跑，Prisma 迁移默认包事务。实现时需拆成独立迁移目录并在文件头加 `-- prisma:no-transaction`（Prisma 5.x 支持），或先手工在生产执行再 `migrate resolve --applied`。**这一点需在实施时实测确认（未确认：本仓库 Prisma 版本对 `no-transaction` 指令的支持情况）。**

**同批收编 schema drift（不改结构，只打基线）：**
`UserFollow` / `UserActivityAlert` 只存在于 `backend/sql/20251018_user_follow_alerts*.sql`，且生产结构与脚本已不一致（`type` 是 `text` 不是 enum、时间戳 `timestamp(3)` 无时区、缺 FK 与两个部分唯一索引）。任何 `prisma migrate diff` / `db push` 都可能生成 DROP。步骤：
1. `npx prisma db pull --schema backend/prisma/schema.prisma` 到临时文件
2. **手工**按真实结构把两个 model 贴进 `schema.prisma`（`type String`，`@db.Timestamp(3)`，无 relation）
3. `npx prisma migrate diff --from-schema-datasource --to-schema-datamodel --script` 确认输出为空
4. `npx prisma migrate resolve --applied 20260801090000_notification_prereq`

---

## 4. 接口契约

### 4.1 user-backend 用户侧 `/qq-binding`（requireAuth + `Cache-Control: no-store`）

文件：`user-backend/src/routes/qqBinding.ts`，`src/app.ts` L61 后加两行挂载。

顶部限流器（**补上 `wikidotBinding.ts` 完全缺失的限流**）：
```ts
const startLimiter   = new SlidingWindowRateLimiter({ windowMs: 15*60*1000, maxHits: 5  }); // by userId
const startIpLimiter = new SlidingWindowRateLimiter({ windowMs: 15*60*1000, maxHits: 20 }); // by ip
const testLimiter    = new SlidingWindowRateLimiter({ windowMs: 60*60*1000, maxHits: 3  }); // by userId
```

**`POST /qq-binding/start`**
```jsonc
req: {}          // 不接受用户填 QQ 号——由机器人在收到私聊时观测，杜绝绑错/冒名
200 {
  "ok": true,
  "challenge": { "id":"c...", "codeHint":"AB3D", "status":"PENDING",
                 "expiresAt":"2026-07-28T14:47:00.000Z", "ttlSeconds": 900 },
  "verificationCode": "SCPPER-AB3DKM7PQR2X",     // ★ 明文，一生只此一次
  "bot": { "qq":"1248393597", "nickname":"SCPper 助手", "online": true,
           "addFriendUrl":"https://qm.qq.com/q/xxxx" }
}
400 { "error": "你已绑定 QQ 号，如需更换请先解绑" }
429 { "error": "操作过于频繁，请稍后再试" }
503 { "error": "QQ 机器人当前不可用，请稍后再试" }   // qqbot /health 探测失败
```
`bot.*` 全部从 `config.qqBot.{selfId,nickname,addFriendUrl}` 读，**不硬编码在路由文案里**（现有 `wikidotBinding.ts` L119-126 把 `instructions` 与目标页 URL 硬编码在后端，是职责错位，不复制）。

**`GET /qq-binding/status`**
```jsonc
200 {
  "ok": true,
  "binding": null | { "status":"ACTIVE"|"PAUSED", "addressMask":"1234***9",
                      "displayLabel":"某人", "verifiedAt":"...", "lastDeliveryAt":"...",
                      "failureCount":0, "suspendedUntil":null,
                      "lastFailureCode":null, "sentToday": 7, "dailyLimit": 40 },
  "challenge": null | { "id":"c...", "codeHint":"AB3D", "status":"PENDING",
                        "expiresAt":"...", "attemptCount":0, "remainingSeconds": 612,
                        "failureReason": null },
  "bot": { "qq":"1248393597", "nickname":"...", "online": true }
}
```
PENDING 且已过期时**原子置 EXPIRED 再返回**（复刻 `getBindingTaskStatus`）。**不返回明文码**。

**`DELETE /qq-binding/challenge`** → `{ ok:true }` / 404 `{ error:'没有可取消的绑定任务' }`

**`DELETE /qq-binding`（解绑，需二次凭据）**
```jsonc
req: { "password": "..." }  |  { "emailCode": "123456" }   // 二者必居其一
200 { "ok": true }
400 { "error":"请输入登录密码以确认解绑" } | { "error":"密码错误" } | { "error":"验证码无效或已过期" }
```
成功后：binding 置 `REVOKED`（保留行 7 天占用 `uniq_channel_binding_address`，防抢绑）→ `invalidateAuthCache(userId)` → 事务外向原 QQ 推「已解除绑定」告别私聊（失败只记日志）。
新增 `VerificationPurpose.CHANNEL_UNBIND` 枚举值。

**`POST /qq-binding/pause` / `POST /qq-binding/resume`** → `{ ok:true, status }`

**`POST /qq-binding/test`**（限流 3 次/小时）→ `{ ok:true, state:"SENT" }` / 503 `{ error:"QQ 推送服务暂时不可用" }`

**`GET /auth/me` 响应扩展**（`routes/auth.ts::formatUser` L111-119）
```jsonc
"user": { ..., "qqBinding": { "status":"ACTIVE", "addressMask":"1234***9", "verifiedAt":"..." } | null }
```
> **四处必须同步改，漏一处就是「绑定成功但页面不刷新」**：
> `user-backend/src/middleware/requireAuth.ts`（L22-31 `CachedUser`、L55-63 prisma select 加 `channelBindings` 窄 include、L126-132 `req.authUser`、L9-15 Request 声明）→ `routes/auth.ts` L111-119 `formatUser` → `bff/src/web/utils/auth.ts` L4-10 `AuthUserPayload` + L31-37 映射 → `frontend/composables/useAuth.ts` L7-13 + L28-36。

### 4.2 user-backend 用户侧 `/notification-settings`（requireAuth）

文件：`user-backend/src/routes/notificationSettings.ts`

**`GET /notification-settings`**
```jsonc
200 {
  "ok": true,
  "channels": [
    { "channel":"WEB",   "status":"ACTIVE", "locked": true },
    { "channel":"QQ",    "status":"ACTIVE", "addressMask":"1234***9",
      "quietStartMin":1380, "quietEndMin":480, "quietMode":"DEFER",
      "timezone":"Asia/Shanghai", "digestMode":"INSTANT", "dailyLimit":40,
      "failureCount":0, "suspendedUntil":null, "sentToday":7 }
  ],
  "matrix": {                                   // 已展开继承 + 来源标注
    "FORUM_MENTION": { "WEB":{"enabled":true,"from":"DEFAULT","locked":true},
                       "QQ": {"enabled":true,"from":"EVENT_TYPE","locked":false} },
    ...
  },
  "catalog": {                                  // 前端渲染矩阵所需元数据，前端不硬编码
    "categories":[
      { "key":"PAGE",   "label":"我的作品",
        "eventTypes":[{ "key":"PAGE_COMMENT", "label":"有人评论我的页面",
                        "hint":null, "channels":["WEB","QQ"] },
                      { "key":"PAGE_VOTE", "label":"我的页面票数累计变化达到阈值",
                        "hint":"阈值在下方「告警产生设置」里配置", "channels":["WEB","QQ"] }, ...] },
      { "key":"FOLLOW", "label":"关注动态", "eventTypes":[...] },
      { "key":"FORUM",  "label":"论坛互动", "eventTypes":[...] },
      { "key":"ACCOUNT","label":"账号与安全","eventTypes":[...] }
    ]
  },
  "generation": {                               // 产生层，来自主库（经 BFF 内部端点）
    "voteCountThreshold": 20, "revisionFilter":"NON_OWNER",
    "ignoreLinkedWikidotSelfRevision": true,
    "mutedMetrics": { "COMMENT_COUNT":false, "VOTE_COUNT":false, "REVISION_COUNT":false }
  }
}
```

**`PATCH /notification-settings/matrix`**
```jsonc
req { "updates": [ { "scope":"EVENT_TYPE", "scopeKey":"FORUM_MENTION", "channel":"QQ", "enabled":true },
                   { "scope":"CATEGORY",   "scopeKey":"PAGE",          "channel":"QQ", "enabled":false },
                   { "scope":"EVENT_TYPE", "scopeKey":"FORUM_MENTION", "channel":"QQ", "reset":true } ] }
                   // updates ≤ 100
200 同 GET 的完整体（含重算后的 matrix）
400 { "error":"不支持的事件类型" | "不支持的渠道" | "该通知类型的站内渠道不可关闭" }
```
全部在**单事务**内 `INSERT ... ON CONFLICT (userId,scope,scopeKey,channel) DO UPDATE`，随后重算并写回所有 binding 的 `resolvedMatrix`。**不复制现有 `/alerts/preferences` 的「先 UPDATE，rowCount===0 再 INSERT」竞态 500。**

**`PATCH /notification-settings/channel/QQ`**
```jsonc
req { "quietStartMin":1380, "quietEndMin":480, "quietMode":"DEFER",
      "timezone":"Asia/Shanghai", "digestMode":"HOURLY", "dailyLimit":30 }
200 { "ok":true, "channel": {...} }
400 { "error":"免打扰时段格式不正确" }    // 0..1439；start === end 视为未启用
```

**`PATCH /notification-settings/generation`** —— 转发到 BFF `POST /internal/alert-preferences` 写主库。

### 4.3 user-backend 内部端点

**`POST /internal/qq-binding/verify`**（`x-internal-key: QQ_BOT_INTERNAL_KEY`，`timingSafeEqual`）
```jsonc
req { "code":"SCPPER-AB3DKM7PQR2X", "qqNumber":"123456789", "isFriend": true,
      "nickname":"某人", "botSelfId":"1248393597",
      "receivedAt":"2026-07-28T14:32:00+08:00", "nonce":"998877" }
200 { "ok": true, "matched": true|false, "reply": "<中文文案>" }
429 { "ok": true, "matched": false, "reply": "操作过于频繁，请 10 分钟后再试。" }
403 / 503                                     // 鉴权失败 / 未配置密钥
```
**无论成功失败都返回 200 + reply**，qqbot 只负责原样转发，不做任何判断。`nonce` 用于幂等（机器人重发同一条消息不重复计 `attemptCount`）。文案表见 §5.2。

**`POST /internal/qq-binding/command`**（同密钥）
```jsonc
req { "qqNumber":"123456789", "command":"status"|"mute"|"unbind", "arg":"24h"|null }
200 { "ok":true, "reply":"已暂停向本 QQ 推送 24 小时（至 07-29 14:32）。" }
```
`unbind` **只置 `status=PAUSED`，绝不清 binding**（QQ 侧无法证明是账号主人；见 §10.5）。

**`POST /internal/notifications/report-delivery`**（`x-internal-key: NOTIFY_INTERNAL_KEY`）
```jsonc
req { "reports":[{ "bindingId":"c...", "outcome":"SENT"|"FAILED",
                   "failureCode":"not_friend"|null, "sentAt":"...", "count": 1 }] }   // ≤200
200 { "ok":true, "updated":12, "suspended":["c..."] }
```
回写 `lastDeliveryAt` / `sentToday` / `sentDayKey` / `failureCount` / `suspendedUntil` / `lastFailureCode`；`not_friend`/`blocked` 立即 PAUSED，其余累计 5 次 PAUSED；置 PAUSED 时发一封（`healthNotifiedAt` 去重）邮件 + 产生一条站内 `ACCOUNT_SECURITY` 提示。

**`GET /internal/notifications/qq-targets`**（同密钥，**仅供分机部署时替代直连**，本方案默认不用）
```jsonc
200 { "ok":true, "targets":[{ "bindingId","userId","linkedWikidotId","address",
                              "quietStartMin","quietEndMin","quietMode","timezone",
                              "digestMode","dailyLimit","resolvedMatrix","sentToday","sentDayKey" }] }
```

### 4.4 BFF 新增

**反代**（`bff/src/web/router.ts` L143 的 `/wikidot-binding` 块之后**原样复制两段**，保留 `forwardJsonBody` 与 `proxyRes` 的 `no-store` + 删 etag/last-modified）：
```ts
router.use('/qq-binding',            createProxyMiddleware({ ...userBackendProxy, pathRewrite: rewrite('/qq-binding') }));
router.use('/notification-settings', createProxyMiddleware({ ...userBackendProxy, pathRewrite: rewrite('/notification-settings') }));
// ★ 绝不代理 /internal/**
```

**新路由文件 `bff/src/web/routes/notifications.ts`**（`router.use('/notifications', ...)`，独立前缀，与 `/alerts` 无路径冲突）：

**`GET /api/notifications`**
```
query: category?=page|follow|forum（可重复）、status?=unread|all（默认 all）、
       cursor?=base64({t,k,i})、limit?=1..50 默认 25
```
```jsonc
200 {
  "ok": true,
  "items": [{
    "uid": "forum:28055",                 // '<pm|fa|fi>:<id>'，前端唯一 key
    "kind": "FORUM_INTERACTION",
    "eventType": "FORUM_DIRECT_REPLY",
    "id": 28055,
    "title": "Aelanna 回复了你",
    "body": "「这个收容措施写得很有意思……」",
    "actor": { "name":"Aelanna", "wikidotId": 12345 } | null,
    "page":  { "id":1,"wikidotId":999,"url":"scp-cn-1000","title":"…","alternateTitle":"…" } | null,
    "link": "https://scp-wiki-cn.wikidot.com/forum/t-123456/#post-28055",
    "prevValue": null, "newValue": null, "diffValue": null,   // 仅 PAGE_METRIC
    "detectedAt": "2026-07-28T06:30:00.000Z",
    "acknowledgedAt": null,
    "delivery": { "QQ": "SENT"|"SCHEDULED"|"FAILED"|"SUPPRESSED"|null }
  }],
  "nextCursor": "eyJ0IjoiMjAyNi0wNy0yOFQ...", "hasMore": true,
  "unread": { "total": 37, "byCategory": { "page":12, "follow":5, "forum":20 } }
}
401 { "ok": false, "error": "unauthenticated" }
400 { "ok": false, "error": "invalid_cursor" | "invalid_category" | "invalid_status" }
```
实现要点：
- `UNION ALL` 三条子查询投影成统一列；每条子查询各自带 cursor 谓词 + `LIMIT limit+1`（限制单表扫描量），外层 `ORDER BY "detectedAt" DESC, "kindRank", "id" DESC` 再取 `limit+1`
- 游标 = base64 of `{t: detectedAt ISO, k: kindRank, i: id}`，keyset 比较 `("detectedAt", kindRank, id) < ($1,$2,$3)`
- **补齐关注告警的 `actor`**：`JOIN "User" tu ON tu.id = uaa."targetUserId"`（现有 `/alerts/follow` 只返回 `targetUserId`，导致 QQ 推送只能说「某人」）
- `delivery` 通过 `LEFT JOIN LATERAL` 取 `NotificationDelivery` 最新一行的 state
- **无 Redis 缓存**（`Cache-Control: no-store`）——现有 `/alerts` 的 30 秒缓存 + mark-read 不失效是「未读数横跳」的根因

**`GET /api/notifications/summary`**
```jsonc
200 { "ok":true, "unread":{ "total":37, "byCategory":{...},
                            "byEventType":{ "FORUM_MENTION":3, ... } },
      "latestAt":"...", "channels":{ "QQ":"ACTIVE"|"PAUSED"|null } }
```
铃铛与所有 tab 徽标**只调这一个端点**，彻底消灭 `Math.max` / 手工相加导致的不一致。

**`POST /api/notifications/read`**
```jsonc
req { "uids": ["forum:28055","pm:34871"] }                    // ≤500
   | { "scope":"all" }
   | { "scope":"category", "category":"forum" }
   | { "upToCursor":"eyJ0...", "category":"forum" }           // 「此处以上全部已读」
200 { "ok":true, "updated":12, "unread":{...同 summary...} }  // ★ 响应直接带回新汇总
400 { "ok":false, "error":"invalid_uids"|"empty_uids"|"too_many_uids"|"invalid_scope"|"mutually_exclusive" }
```
语义 `acknowledgedAt = COALESCE(acknowledgedAt, NOW())`，幂等。**同事务把对应的 `NotificationDelivery` 中 `state IN ('PENDING','SCHEDULED')` 的行置 `CANCELLED`**（用户已在站内看到，不再推 QQ）。

**`POST /api/notifications/unread`** → `{ ok, updated, note:"push_not_resent" }`（置未读不重建 Delivery）

**`GET|POST /api/internal/alert-preferences`**（`x-internal-key: BFF_INTERNAL_API_KEY`，供 user-backend 读写主库产生层配置）；实现改用 `ON CONFLICT ("userId", metric) DO UPDATE`，顺带修掉现有 upsert 竞态 500。

### 4.5 qqbot 对外 HTTP（`127.0.0.1:8080`，`Authorization: Bearer <EXTERNAL_API_TOKEN>`）

```
GET  /scpper/qq/health
     200 { "ok":true, "online_self_ids":[1248393597], "preferred":[1248393597],
           "nickname":"SCPper 助手", "contract":"1.0.0" }
     503 { "detail":"no_online_bot" }

GET  /scpper/qq/friend?qq=<int>&no_cache=0
     200 { "ok":true, "qq":"123456789", "is_friend":true, "nickname":"某人",
           "cached":true, "bot_qq":1248393597 }
     503 { "detail":"bot_offline" }

POST /scpper/qq/push
     req  { "qq":123456789, "message":"...", "dedup_key":"<batchId>", "require_friend":true }
     200  { "ok":true,  "message_ids":[123], "chunks":1 }
     200  { "ok":false, "error":"not_friend"|"blocked"|"duplicate"|"send_failed" }
     429  { "detail":"rate_limited", "retry_after_ms": 4200 }
     403 / 503

POST /scpper/qq/push/batch
     req  { "items":[{ "qq","message","dedup_key" }] }   // ≤50，条目间 700ms 节流
     200  { "ok":true, "results":[{ "qq","ok","message_ids"?,"error"? }] }
```
所有业务失败均返回 HTTP 200 + body `ok:false` + `error`，便于调用方统一按 `error` 分类而非解析 HTTP 码；仅鉴权（403）、参数（400/422）、无在线 Bot（503）、限流（429）用状态码。

---

## 5. 绑定流程时序

> **2026-07-28 修订（阶段 1 实施时定稿）**：验证码改为填在**好友申请的验证消息**里，
> 而不是「先无条件加好友、再让用户私聊发码」。
>
> 变更理由：
> 1. 用户从两个动作（加好友 → 再发消息）压缩为一个动作；
> 2. 好友列表里只会出现真正在绑定的人。这不只是整洁问题——**每次推送前都要用
>    `get_friend_list` 校验好友关系**，列表被无关加好友请求撑大会直接拖慢推送链路，
>    而无条件自动同意必然招来这类请求。
>
> 对应的三种结局（`friend_request.py` 已按此实现）：
> - 码有效 → 同意好友 + 私聊回执（绑定此时已在 user-backend 侧完成）
> - 码无效/缺失 → **拒绝**。用户能看到「对方拒绝了好友请求」，可拿正确的码重来；
>   留着不处理的话用户只会一直等，不知道错在哪
> - 校验服务不可用 → **不处理**，留在待处理列表。这是我们的故障不该让用户背，
>   服务恢复后用户或管理员仍有补救余地
>
> 私聊发码的路径（`qq_verify.py`）**保留但降级为次要路径**：已经是好友的用户
> （历史遗留、或因其他原因先加了好友）发不出好友申请，只能走私聊。
>
> ⚠️ **前置条件**：机器人 QQ 账号的加好友设置必须是「需要验证信息」。
> 若设为「允许任何人添加」，QQ 不会收集验证消息，`event.comment` 为空 →
> 所有申请都会被拒。上线前需在 NapCat WebUI 或手机端确认该设置。
>
> 下表第 5–8 步据此调整；其余步骤不变。

### 5.1 主时序（Happy Path）

| # | 参与方 | 动作 | 用户可见 |
|---|---|---|---|
| 1 | 前端 | `/account` → 「账号绑定」→ QQ 卡 → 【开始绑定】 | 按钮转 loading |
| 2 | BFF→user-backend | `POST /qq-binding/start` | — |
| 3 | user-backend | 限流 → fail-fast 已绑检查 → Serializable(lockAccount → 作废旧 PENDING → 生成码 → 存 codeHash/codeHint → create challenge, TTL 15min) | — |
| 4 | 前端 | 渲染两步向导 | 「① 添加机器人好友 QQ **1248393597**，**把下面的验证码填进好友验证消息** ② 本页会自动确认」+ 大号等宽验证码 `SCPPER-AB3DKM7PQR2X` + 【复制】+ 倒计时 `14:32` + ⚠️「验证码只显示一次，刷新页面后需重新生成」 |
| 5 | 用户 | 加好友，验证消息里粘贴验证码 | — |
| 6 | qqbot `friend_request.py` | `extract_code(event.comment)`（兼容「回答问题」式的 `问题：…\n回答：…`、大小写、用户顺手打的空格/连字符）→ `POST /internal/qq-binding/verify` | — |
| 7 | qqbot | 码有效 → `event.approve(bot)` → 失效好友缓存 → sleep 2s → 私聊回执<br>码无效 → `event.reject(bot)`（注意：适配器的 `approve()` 签名是 `(bot, remark="")`，**没有 approve 参数**，拒绝必须走 `reject()`）<br>校验不可用 → 不处理，留待重试 | 成功：QQ 收到成功文案<br>失败：用户看到「对方拒绝了好友请求」 |
| 8 | *(次要路径)* qqbot `qq_verify.py` | 已是好友的用户改走私聊发码：`sub_type=='friend'` 检查 → 节流 → `POST /internal/qq-binding/verify` | — |
| 9 | user-backend | Serializable(lockAccount → lockChallenge → 校验链 → 条件插 binding → challenge=VERIFIED → 计算 resolvedMatrix) → 事务外 `invalidateAuthCache` | — |
| 10 | qqbot | 把 `reply` 原样私聊回给用户 | QQ 收到成功文案 |
| 11 | user-backend | 事务外调 `services/qqPush.ts` 发绑定成功回执（失败只记日志） | QQ 收到「通知渠道已就绪」 |
| 12 | 前端 | 5 秒轮询 `GET /qq-binding/status` 命中 ACTIVE | 卡片转绿 + 「已绑定 1234***9」+ 【去设置通知偏好 →】 |

### 5.2 失败分支与文案（**中文文案的单一权威在 user-backend**）

| 分支 | 判定位置 | `matched` | `reply`（QQ 私聊回复） |
|---|---|---|---|
| 成功 | verify | true | `✅ 绑定成功！你的 SCPPER-CN 账号（a***@example.com）已与本 QQ 关联。\n默认只推送「有人直接回复我」「有人 @ 我」「关注的作者有新动态」，其余请到网页「账号 → 通知设置」开启。\n发送 .通知 查看设置，.静音 暂停 24 小时，.退订 停止推送。` |
| 码不存在 / 已过期 / 已消费 / 非最新任务 | verify | false | `❌ 验证码无效或已过期，请回到网页重新生成（有效期 15 分钟）。` ← **四种情况同一句，不泄露任务存在性** |
| 账号已绑其他 QQ | verify | false | `ℹ️ 该 SCPPER-CN 账号已绑定其他 QQ，如需换绑请先在网页解绑。` |
| 该 QQ 已绑其他账号 | verify | false | `❌ 该 QQ 号已绑定其他 SCPPER-CN 账号，请先在原账号解绑。` |
| `attemptCount ≥ 5` | verify | false | `⚠️ 该验证码错误尝试次数过多已作废，请回到网页重新生成。` |
| `isFriend == false` | verify | false | `请先添加我为好友再发送验证码。` ← **不消耗 attemptCount**（不是错误尝试） |
| `sub_type != 'friend'`（临时会话） | qqbot 本地 | — | `请先添加我为好友后再发送验证码（临时会话无法完成绑定）。` |
| qqbot 节流（3 次/60s） | qqbot 本地 | — | `⚠️ 操作过于频繁，请 1 分钟后再试。` |
| user-backend 频控（10 次/10min per QQ） | verify | false（429） | `⚠️ 操作过于频繁，请 10 分钟后再试。` |
| user-backend 不可达 | qqbot 本地（重试 1 次后） | — | `⚠️ 绑定服务暂时不可用，请稍后重新发送验证码。` **且本地不消费该码** |
| 无在线 Bot | `/qq-binding/start` | — | 网页：503「QQ 机器人当前不可用，请稍后再试」 |

**网页侧失败提示**：
- 已绑定 → 「你已绑定 QQ 号 1234***9，如需更换请先解绑」
- 限流 → 「操作过于频繁，请 15 分钟后再试」
- 任务过期（轮询发现 `status=EXPIRED`）→ 「验证码已过期，请重新生成」+ 自动把按钮变回【重新生成】
- 页面刷新后码丢失 → 显示 `SCPPER-AB3D········` + 「验证码只显示一次，若已丢失请点『重新生成』」

### 5.3 解绑 / 暂停 / 换绑

| 路径 | 触发 | 效果 | 需要凭据 |
|---|---|---|---|
| 网页逐项关 | 设置页 | `NotificationPreference.enabled=false` + 重算 matrix | session |
| 网页暂停 | 设置页【暂停】 | `status=PAUSED` | session |
| QQ `.静音 24h` | 私聊 | `suspendedUntil = now+24h` | 拥有该 QQ |
| QQ `.退订` / `.解绑` | 私聊 | **仅** `status=PAUSED`，**不清 binding** | 拥有该 QQ |
| 网页解绑 | 设置页/绑定卡 | `status=REVOKED`（保留行 7 天）+ 告别私聊 | session **且** 密码或邮箱码 |
| 删除机器人好友 | QQ 客户端 | 投递 `not_friend` → 立即 PAUSED + 邮件 + 站内提示 | — |
| 换绑 | 解绑 → 重新绑定 | 不做原地换绑 | 同解绑 |
| 管理端解绑 | `POST /admin/accounts/:id/unbind-channel` | REVOKED + **必须 `invalidateAuthCache`** | 管理员 |

---

## 6. 通知偏好模型

### 6.1 三层语义（严格不重叠）

| 层 | 存储 | 回答的问题 | 读取方 | 关掉后 |
|---|---|---|---|---|
| **产生层** | 主库 `UserMetricPreference.config` + `PageMetricWatch.mutedAt`（**不动**） | 要不要**产生**告警行 | `PageMetricMonitorJob`（SQL 里 `AND w."mutedAt" IS NULL`） | 站内也看不到，永久丢失 |
| **路由层** | 用户库 `NotificationPreference` → 物化到 `binding.resolvedMatrix` | 已产生的告警投递到**哪些渠道** | dispatcher（读 binding） | 站内仍可见，只是不推 |
| **传输层** | 用户库 `NotificationChannelBinding` 的 quietHours / digestMode / dailyLimit + qqbot 令牌桶 | 这一刻**能不能发** | dispatcher + qqbot | 延后或合并，不丢 |

这个切分是「静音语义冲突」的根本解法：现有 `mutedAt` 是「不产生」，拿它当 QQ 开关会让站内红点一起消失。UI 上把两块**物理隔开**并加警示文案（§8.4）。

### 6.2 事件类型 × 渠道矩阵与默认值

默认值是代码常量 `user-backend/src/services/notificationDefaults.ts`（**唯一权威**，dispatcher 完全不需要知道它）：

| eventType | 分组 | 来源 | WEB | QQ |
|---|---|---|---|---|
| `PAGE_COMMENT` | 我的作品 | `PageMetricAlert.metric=COMMENT_COUNT` | ✅🔒 | ❌ |
| `PAGE_VOTE` | 我的作品 | `=VOTE_COUNT` | ✅🔒 | ❌ |
| `PAGE_REVISION` | 我的作品 | `=REVISION_COUNT` | ✅🔒 | ❌ |
| `FOLLOW_REVISION` | 关注动态 | `UserActivityAlert.type='REVISION'` | ✅🔒 | ✅ |
| `FOLLOW_ATTRIBUTION` | 关注动态 | `='ATTRIBUTION'` | ✅🔒 | ✅ |
| `FOLLOW_ATTRIBUTION_REMOVED` | 关注动态 | `='ATTRIBUTION_REMOVED'` | ✅🔒 | ❌ |
| `FORUM_PAGE_REPLY` | 论坛互动 | `ForumInteractionAlert.type=PAGE_REPLY` | ✅🔒 | ❌ |
| `FORUM_DIRECT_REPLY` | 论坛互动 | `=DIRECT_REPLY` | ✅🔒 | ✅ |
| `FORUM_MENTION` | 论坛互动 | `=MENTION` | ✅🔒 | ✅ |
| `ACCOUNT_SECURITY` | 账号与安全 | user-backend 直发 | ✅🔒 | ✅ |

🔒 = `locked`，`PATCH` 拒绝修改。**WEB 全部强制开启**是关键设计：它保证「关掉 QQ ≠ 站内也看不到」，用户才敢关推送。

**QQ 默认只推「有人直接找我 / 我关注的人有动作」四类**，把「数字变化」类默认关。理由：绑定第一天被轰炸的用户会直接删好友，而**一旦被拉黑，这个 QQ 号对该用户永久失去推送能力**。

**`PageMetricType` 的 `RATING` / `SCORE` 不进枚举**——生产库 0 行、`PageMetricMonitorJob` 从不产生、后端 `MUTABLE_METRICS` 也只有 3 个，但前端现在还在为它们各发一次必空请求（各带一次 `/auth/me` 往返）。本次清掉前端引用，DB 枚举保留不动。

⚠️ 文案警示：`PAGE_VOTE` 的 UI 标签必须写「我的页面票数**累计**变化达到 20 票」而不是「评分变化」——真正的 rating 涨跌 1 分不会触发，攒够阈值才发一条。这是用户预期与实际行为最容易对不上的地方。

### 6.3 偏好继承（三级 + 默认）

存储只有一张 `NotificationPreference(userId, scope, scopeKey, channel, enabled)`，**只存显式覆盖**（不铺满 10×2×788 行）。解析顺序：

```
EVENT_TYPE(scopeKey=eventType) > CATEGORY(scopeKey=分组) > GLOBAL(scopeKey='*') > DEFAULTS
```

纯函数 `user-backend/src/services/notificationPrefsRules.ts::resolveMatrix(prefs, channel)`，配 `tests/notificationPrefsRules.test.ts`（node:test + tsx）覆盖：三级覆盖、reset 回落、locked 拒绝、未知 eventType。

每次 `PATCH /matrix` 或 `/channel/QQ` 后，在同事务里重算并写 `binding.resolvedMatrix`。**dispatcher 只读 `resolvedMatrix[eventType] === true`，不做任何解析**——默认值定义权因此唯一。默认值表版本变更时用 CLI `notify-rebuild-matrix` 批量重算（按 `matrixVersion` 筛）。

### 6.4 传输策略

| 项 | 字段 | 默认 | 语义 |
|---|---|---|---|
| 免打扰 | `quietStartMin/quietEndMin/quietMode/timezone` | 未启用 | 0..1439 本地分钟，`start > end` 表示跨零点（1380→480 = 23:00–08:00）。`DEFER`：置 `SCHEDULED` + `scheduledAt = 时段结束时刻`，到点合并成一条摘要发出；`DROP`：直接 `SUPPRESSED`。**`ACCOUNT_SECURITY` 无视免打扰** |
| 摘要模式 | `digestMode` | `INSTANT` | `INSTANT` = 每轮（60s）聚合一条；`HOURLY` = `scheduledAt` 到下一个整点 :05；`DAILY` = 次日 09:00 本地；`OFF` = 该渠道只发 `ACCOUNT_SECURITY` |
| 日上限 | `dailyLimit` | 40（0=不限） | `sentToday` + `sentDayKey`（本地日，跨天重置）。超限当天剩余全部 `SUPPRESSED(daily_limit)`，首次超限额外推一条封顶提示 |

由于 QQ 固定「每轮一条摘要」（不做 per-item 即时推），实际每天最多约 24 条，`dailyLimit` 主要是熔断兜底。

### 6.5 消息模板（`backend/src/jobs/notification/renderQqDigest.ts`）

```
📬 SCPPER-CN 提醒 · 3 条

· 有人回复了你
  「关于 SCP-CN-1000 的疑问」— Foo：这里的收容措施是不是……
  https://scp-wiki-cn.wikidot.com/forum/t-123456/#post-789

· 你关注的 Bar 有新修订
  SCP-CN-2000 — 分类：CONTENT

· 你的页面票数变化
  SCP-CN-3000  +21 票（120 → 141）

查看全部 → https://scpper.cn/account/notifications
回复 .静音 暂停 24 小时 · .退订 停止推送
```
文案数据充分性：论坛类有 `actorName` + `postExcerpt`（180 字纯文本快照）+ 可点 URL（最全）；关注类的 `actor.displayName` **本次在 feed SQL 与 dispatcher SQL 里同步补齐**；页面指标类只有数值 diff。最多列 8 条，其余显示「另有 N 条」。

### 6.6 退订（合规底线）

每条 QQ 消息尾部固定带 `回复 .静音 暂停 24 小时 · .退订 停止推送`。**用户必须能在收到消息的渠道里直接叫停**，不能强制回网页。`.退订` 只 PAUSE 不解绑，可逆。

---

## 7. qqbot 侧改动

**4 新建 + 4 修改，全部在 `/home/andyblocker/qqbot`。不动 NapCat 的 OneBot 配置结构、不新起进程、不开新端口。**

### 7.1 新建 `src/plugins/scpper/external_api.py`

挂 `nonebot.get_app()` 的 FastAPI 路由：
- `_auth(authorization)` — `hmac.compare_digest(authorization, f"Bearer {config.external_api_token}")`，未配置 token → 503
- `_require_bot()` — **必须复用 `from .monitor.notify import get_bot_for_send`**。该函数已按 `routing.preferred_sender_qqs()` 处理「账号启用 + 在线」优先级，3888397052 被 `bot_kimi_enabled=False` 停用的语义只在这一处维护；自己 `get_bot()` 会绕开它
- `friend_ids(bot, no_cache)` — `bot.call_api("get_friend_list")` + 45 秒进程内缓存（`get_friend_list` 有速率风险），返回 `(set[int], cached: bool)`
- `invalidate_friend_cache(self_id)` — 供 `friend_request.py` 在同意好友后立刻调用，否则 45 秒内 push 仍判非好友
- `_rate_ok(qq)` — 单 QQ 20 条/60s + 全局 200 条/60s 滑动窗口
- `_push_dedup: OrderedDict[str, float]` — `dedup_key` 5 分钟去重
- `@app.get("/scpper/qq/health")` / `@app.get("/scpper/qq/friend")` / `@app.post("/scpper/qq/push")` / `@app.post("/scpper/qq/push/batch")`
- `@scheduler.scheduled_job('interval', minutes=10)` **清理 `_push_dedup` 与 `_push_hits` 的过期 key**（否则是与 mail-agent `rateLimiter.mjs` 同款的慢速内存泄漏——`_prune` 只在 key 被再次访问时才执行）

`health` 返回 `{"ok":true,"online_self_ids":[...],"preferred":[...],"nickname":...,"contract":"1.0.0"}`；调用方（`backend/src/services/qqPush.ts` 与 `user-backend/src/services/qqPush.ts`）在首次调用时校验 `contract` 主版本，不兼容则告警。

### 7.2 修改 `src/plugins/scpper/monitor/notify.py`

- 把 L69-88 的 `_chunk_text` 提升为公开 `chunk_text(message, limit=None)`，文件底部保留 `_chunk_text = chunk_text` 别名（daily_report / stickers / bigcat / monitor.audit / monitor.vote_stats 五处调用方零改动）
- 新增与 `_send`（L60-66）对称的：
```python
async def send_private_text(bot: Bot, user_id: int, message: str) -> tuple[bool, int | None]:
    """私聊发送，按 config.monitor_msg_chunk_size 分片。返回 (是否全部成功, 首条 message_id)。
    与 _send 保持同样的异常吞掉语义与日志格式。"""
```
**放这里而不是 external_api.py**：现存全部主动推送的异常处理、日志格式、分片阈值都收敛在本文件；另起一份会出现两种失败语义，排障要在两处对照。

### 7.3 新建 `src/plugins/scpper/qq_verify.py`

- `verify_matcher = on_message(priority=1, block=False)`，handler 形参写 `PrivateMessageEvent` —— **靠 NoneBot 依赖注入天然排除群聊，不用 isinstance**
- **绝不调 `routing.should_this_bot_handle(event)`，也绝不把 `config.private_replies_enabled` 置 True**。routing.py L126-133 对非群聊事件返回该全局开关；一旦置 True，`commands.py` 那 9 条 `on_command(block=True)` 会同时在私聊放开并抢走验证码事件。这里**只调 `routing.is_routed_bot_enabled(event.self_id)`** 做多账号去重
- `CODE_RE = re.compile(r"SCPPER[-\s]?([ABCDEFGHJKMNPQRSTUVWXYZ23456789]{12})", re.I)`，与 user-backend 的 `VERIFICATION_CODE_CHARS` 对齐
- `CMD_RE` 识别 `.通知|status` / `.静音|mute` / `.退订|.解绑|unbind`
- `event.sub_type != 'friend'` → 本地回复「请先加好友」，不回调
- `_throttle_ok(user_id, limit=3, window=60)` 进程内节流
- `_post(path, body)` — `httpx.AsyncClient(timeout=5.0, **trust_env=False**)`，失败重试 1 次。`trust_env=False` 是必须的：主机配了 HTTP 代理环境变量（`backend/ecosystem.config.cjs` 的 `scpper-binding-verify` 就显式清空了代理），走代理会把 loopback 请求打飞
- 日志只打 `code[:4] + '****'`，绝不打印完整码

### 7.4 新建 `src/plugins/scpper/friend_request.py`

**没有它，「已加好友」这个前置条件永远无法满足**——全仓 grep `FriendRequestEvent` / `on_request` / `set_friend_add_request` / `get_friend_list` 零命中，用户点了加好友后无人应答，绑定流程第一步就死。

- `on_request(priority=5, block=False)` + `FriendRequestEvent` → `event.approve(bot)`
- 日配额 `qq_friend_auto_approve_daily_cap = 200`，超限转忽略并告警（防好友列表被灌水拖慢 `get_friend_list`）
- 同意后 `invalidate_friend_cache(bot.self_id)` + `asyncio.sleep(1.5)` 等关系生效 + 主动私聊引导语
- 提供开关 `qq_friend_require_token`（默认 `False`）：置 True 时只同意 `event.comment` 含合法 `SCPPER-` 码的申请。**默认无条件同意**——要求用户在加好友验证信息里粘码体验较差（部分客户端不显示提示），而 12 位码本身才是凭证，好友关系只是可达性前提，不是安全边界

### 7.5 修改 `src/plugins/scpper/__init__.py`（L4-12 import 块）
```python
from . import external_api   # noqa: F401
from . import qq_verify      # noqa: F401
from . import friend_request # noqa: F401
```
不 import 就不注册——这是本仓库唯一的模块启用方式。

### 7.6 修改 `src/plugins/scpper/config.py`（`ScpperConfig`，L7-104）
```python
    external_api_enabled: bool = False
    external_api_token: str = ""              # 绝不写默认值
    scpper_callback_base: str = "http://127.0.0.1:4455"
    scpper_internal_token: str = ""           # = user-backend 的 QQ_BOT_INTERNAL_KEY
    qq_verify_enabled: bool = False
    qq_friend_auto_approve: bool = True
    qq_friend_require_token: bool = False
    qq_friend_auto_approve_daily_cap: int = 200
    qq_friend_cache_seconds: int = 45
    qq_push_rate_window_seconds: int = 60
    qq_push_rate_max: int = 20                # 单 QQ / 分钟
    qq_push_rate_global_max: int = 200         # 全局 / 分钟
    qq_push_interval_ms: int = 700             # 批量条目间节流
    bot_display_name: str = "SCPper 助手"
```
**同批把 L11-12 硬编码的 `db_user` / `db_pass` 默认值清空**（`config.py` 是 git 跟踪的源码，现已泄漏库密码）。

### 7.7 修改 `/home/andyblocker/qqbot/.env`
```ini
HOST=127.0.0.1                      # ★ 原 0.0.0.0
ONEBOT_ACCESS_TOKEN=<openssl rand -hex 16>   # ★ 同步写进 napcat/config/onebot11_*.json
EXTERNAL_API_ENABLED=true
EXTERNAL_API_TOKEN=<openssl rand -hex 32>
SCPPER_CALLBACK_BASE=http://127.0.0.1:4455
SCPPER_INTERNAL_TOKEN=<openssl rand -hex 32>
QQ_VERIFY_ENABLED=true
QQ_FRIEND_AUTO_APPROVE=true
DB_USER=qqbot_readonly              # ★ Phase 0 新建的只读角色
DB_PASS=<新密码>
```

### 7.8 工程规范最小补救 + 上线
- 新建 `qqbot/AGENTS.md`（记录契约版本 `1.0.0`、`/scpper/qq/*` 稳定性承诺、密钥轮转步骤、改动前须与 scpper-cn 的 `services/qqPush.ts` 对齐）+ `.env.example`；把 `.env` 与 `napcat/config/*.json` 加进 `.gitignore`
- 上线：`pm2 restart qqbot`（`./restart.sh` 检测到 PM2 走同一路径，不碰 NapCat、保留登录态）→ `pm2 logs qqbot` 确认 `Application startup complete` 与 OneBot 重连
- 改 `ONEBOT_ACCESS_TOKEN` 时需同改 `napcat/config/onebot11_1248393597.json` 并 `docker compose restart napcat`（会短暂掉线，安排低峰）
- 自检：`curl -H "Authorization: Bearer $T" http://127.0.0.1:8080/scpper/qq/health`

---

## 8. 前端改动

### 8.1 路由与信息架构

```
frontend/pages/account/
  index.vue                       ← 瘦身：资料 + 收藏夹 + 主题 + 安全（tab 保留），
                                     「账号绑定」分组内 Wikidot 卡 + QQ 卡并列
  notifications/
    index.vue                     ★新 通知中心（取代 ?tab=alerts）
    settings.vue                  ★新 通知设置
  following.vue                   ★新 关注管理（取代 ?tab=follows）
frontend/middleware/
  auth.ts                         ★新（全仓目前无 middleware 目录）
```
- 各页 `definePageMeta({ middleware:'auth', key: r => r.fullPath })` + `useHead({ title })`
- **旧深链兼容**：`index.vue` 的 `onMounted` 读 `?tab=`，`alerts` → `navigateTo('/account/notifications',{replace:true})`，`follows` → `/account/following`
- **限定范围的重构**：只把通知/关注两块抽出为独立路由，资料/收藏夹/主题/安全仍留在 `index.vue`（但 `v-show` → `v-if` + `<KeepAlive>`），避免一次性重写 1610 行

### 8.2 组件树

```
components/notifications/
  NotificationBell.vue          ← 从 layouts/default.vue L132-231 抽出
  NotificationFilterBar.vue     ← 类别 chips + 只看未读 + 批量已读下拉
  NotificationList.vue          ← 列表 + 加载更多 + 状态分支分发
  NotificationItem.vue          ← ★一套模板覆盖三类 kind（取代现在四套各写一遍）
  NotificationEmptyState.vue    ← 按当前筛选参数化文案
  NotificationErrorState.vue    ← ★全新：「加载失败」+【重试】
  ChannelCard.vue               ← 站内 / QQ 两张渠道卡
  QuietHoursEditor.vue
  EventChannelMatrix.vue        ← 事件 × 渠道开关矩阵（含继承三态）
  GenerationSettingsPanel.vue   ← 产生层阈值（独立分区 + 警示）
components/account/
  QqBindingPanel.vue            ★新（以 WikidotBindingPanel.vue 为模板）
  FollowsPanel.vue              ★新（从 index.vue L771-852 抽出）
```

### 8.3 状态管理

**新建 `composables/useNotifications.ts`（单一 store，取代 4 个）**：
```ts
const items       = useState<NotificationItem[]>('notif/items', () => [])
const summary     = useState<NotificationSummary>('notif/summary', () => emptySummary())
const cursor      = useState<string|null>('notif/cursor', () => null)
const hasMore     = useState('notif/hasMore', () => false)
const loading     = useState('notif/loading', () => false)       // 首屏
const loadingMore = useState('notif/loadingMore', () => false)   // 翻页
const refreshing  = useState('notif/refreshing', () => false)    // 手动刷新
const error       = useState<string|null>('notif/error', () => null)   // ★ 现有 4 个全都没有
const filters     = useState('notif/filters', () => ({ categories: [], unreadOnly: false }))
const pendingUids = useState<Set<string>>('notif/pending', () => new Set())
```
契约要点：
- `fetchFeed({ force })`：`force=true` **在 loading 门禁之前判断**并 `AbortController.abort()` 打断在飞请求
- **失败绝不清空**：`catch` 只写 `error`，保留 `items` 与 `summary`
- `markRead(uids)` / `markReadUpTo(cursor)` / `markAllRead(scope)`：乐观更新 + 失败回滚 + **`summary` 一律从响应体取，不本地推算**
- `normalizeCount(v)` 用 `Number(v)` 后 `Number.isFinite` 兜底（现在用 `Number.isFinite(res.unreadCount)` 直判，字符串静默变 0）
- `reset()` 挂进 `layouts/default.vue` 的 auth watch
- 时间统一 `frontend/utils/timezone.ts::formatDateTimeUtc8` 并**带年份**

**删除**：`useAlerts.ts` / `useCombinedAlerts.ts` / `useFollowAlerts.ts` / `useForumInteractionAlerts.ts` / `useAlertSettings.ts`（保留一个版本周期后删除文件）。
**新建**：`useNotificationSettings.ts`、`useQqBinding.ts`（照抄 `useWikidotBinding.ts` 的 `statusEpoch` 竞态防护 L89-144、`start` L146-170、`cancel` 404 容错 L188-215、倒计时 L217-237；差异：轮询 5 秒、最多 3 分钟后转手动、明文码写 `sessionStorage`）。
**修改保留**：`useFollows.ts`（加 `error` / `reset()` / 行级 `pendingIds` / 失败不清空 / 去掉重复请求）。

### 8.4 通知设置页布局

```
┌ 推送渠道 ────────────────────────────────────────────┐
│ 🌐 站内   永久开启（在通知中心查看）                  │
│ 💬 QQ     ✅ 已绑定 1234***9  机器人 ● 在线           │
│           免打扰 [23:00]–[08:00]  ● 延后合并 ○ 直接丢弃│
│           摘要模式 [即时 ▾]   每日上限 [40] 条        │
│           今日已推送 7 / 40                          │
│           [发送测试] [暂停] [解除绑定]                │
└──────────────────────────────────────────────────┘
┌ 通知类型 ─────────────────────── 站内   QQ ─────────┐
│ ▼ 我的作品                        🔒    [◐]         │
│    有人评论我的页面                🔒    [ ]         │
│    我的页面票数累计变化达到 20 票   🔒    [ ]         │
│    我的页面被他人修订              🔒    [ ]         │
│ ▼ 关注动态                        🔒    [◐]         │
│    关注的作者有新修订              🔒    [✓]         │
│    ...                                              │
│ ▼ 论坛互动 / ▼ 账号与安全                            │
│  （单元格三态：浅色 = 继承自上级，实色+圆点 = 显式覆盖，│
│    长按/右键 =「恢复继承」）                          │
└──────────────────────────────────────────────────┘
┌ ⚠️ 告警产生设置 ────────────────────────────────────┐
│ 这里的开关决定通知【是否产生】。关闭后站内也看不到。   │
│ 如果只是不想收 QQ 推送，请用上面的「通知类型」表格。   │
│  票数提醒阈值 [20] 票                                │
│  修订提醒过滤 [仅非署名者 ▾]  [x] 忽略我自己的修订    │
│  [ ] 停止统计评论数  [ ] 停止统计票数  [ ] 停止统计修订│
└──────────────────────────────────────────────────┘
```
移动端：矩阵降级为按分组折叠的列表，每行两个 toggle。

### 8.5 通知中心布局

```
┌ 通知中心 ────────────────────── [刷新] [⚙ 通知设置] ┐
│ [全部 37] [我的作品 12] [关注动态 5] [论坛互动 20]    │  ← 服务端 byCategory
│ ○ 只看未读            [全部标记已读 ▾]               │
├──────────────────────────────────────────────────┤
│ ▌● 论坛回复  Aelanna 回复了《SCP-CN-1000》           │  ← 未读 = 左侧 3px accent 竖条
│   「这个收容措施写得很有意思……」                      │     + sr-only「未读」+ 圆点
│   2026-07-28 14:32 · 已推送 QQ ✓   [标记已读][查看 ↗]│
│ ─── 以上为新消息 ─── [此处以上全部已读]              │
│ ▌○ 页面评论  《SCP-CN-2000》评论 12 → 15             │
│                    [ 加载更多 ]                      │
└──────────────────────────────────────────────────┘
```
`delivery.QQ` 徽章：`✓ 已推 QQ` / `⏸ 已推迟（免打扰）` / `✕ 推送失败` / `— 未开启`。**这是用户判断「我没收到 QQ 消息是没触发还是推送失败」的唯一手段，现在完全缺失。**

### 8.6 其它全局改动

- `frontend/assets/css/scheme.css` 补 `--warning` 令牌（`design-system.vue` 的 `.notif-icon.warning` 引用了它但从未定义，现在拿到透明背景）
- `frontend/assets/css/tailwind.css` 补全局 `.fade-enter-active` 等过渡类（现在只定义在 `redesign.css`，而后者只被 sample 页 `<style src>` 引入，导致铃铛下拉与移动端侧栏是硬切）
- 账号系页面全部硬编码 `bg-white/80` / `border-neutral-200` / `dark:bg-neutral-900/70` 替换为 `rgb(var(--panel))` / `rgb(var(--panel-border))` / `rgb(var(--fg))` / `rgb(var(--muted))`，并复用 `design-system.vue` 第 08 节已定义但从未使用的 `.notification-item.unread` / `.notif-icon` / `.notif-time` / `.panel-footer` 规范

---

## 9. 通知页 Bug 修复清单

| # | 现象 | 位置 | 修法 |
|---|---|---|---|
| 1 | 铃铛未读数不含关注提醒（关注的作者更新了页面，红点为 0） | `layouts/default.vue:511` `combinedUnreadCount`；L480-505 只 import 两个 composable | 未读数唯一来源 `GET /notifications/summary` 的 `unread.total`，服务端算 |
| 2 | 铃铛「全部已读」清不掉关注提醒 | `layouts/default.vue:672-681` | `POST /notifications/read {scope:'all'}` 一次跨三表 |
| 3 | 任何请求失败清空列表与未读并显示「暂无提醒」，用户以为通知被删了；4 个 composable 都无 error 态 | `useAlerts.ts:127-131`、`useFollowAlerts.ts:64-70`、`useForumInteractionAlerts.ts:79-84`、`useCombinedAlerts.ts:52-56` | `catch` 只写 `error`，保留 `items`；UI 渲染 `NotificationErrorState` |
| 4 | 「刷新」在有请求在飞时静默失效（loading 门禁写在 force 判断之前） | `useAlerts.ts:100-102`、`useCombinedAlerts.ts:34`，调用方 `account/index.vue:1243-1247` | `force` 判断前置 + `AbortController.abort()`；`refreshing` 独立于 `loading` |
| 5 | 标记已读后未读数回弹最多 30 秒 | `alerts.ts:307-368` 有 30s Redis 缓存，L692-749 / L878-918 写路径无失效 | 新 `/notifications` 端点 `no-store`；旧 `/alerts` 三处写路径补 `cache.del('scpcn:bff:alerts:{wikidotId}:*')` |
| 6 | 关注提醒无法单条已读（`markRead` 是死代码） | `account/index.vue:339-402`、`useFollowAlerts.ts:131-147` | 统一 `NotificationItem` 每条都有【标记已读】 |
| 7 | 聚合视图已读后条目不消失、进入「有一堆卡片但没有任何操作」的死状态 | `account/index.vue:744`、L1276-1290、`useCombinedAlerts.ts:62-82` | 已读后按 `unreadOnly` 决定移除或灰化；`summary` 从响应体重取 |
| 8 | tab 徽标用 `Math.max` 少报；关注 tab 徽标显示关注提醒未读但页内只有关注列表（重复计数） | `account/index.vue:982-988`、L19-22 | 徽标一律来自 `summary.byCategory`；**关注管理页不再挂通知徽标** |
| 9 | 切到提醒 tab 不刷新关注提醒 | `account/index.vue:1500-1528` watch 缺 `fetchFollowCombined` | 单 store，路由进入即 `fetchFeed()`，无分支遗漏 |
| 10 | 取消关注无二次确认 / 无行级 loading（一次禁用全部按钮）/ 失败只 `console.warn` / 一次操作 3 个请求 | `account/index.vue:838-843`、L1233-1241；`useFollows.ts:49-58` | 确认弹窗 + 行级 `pendingIds` + 失败 toast + 删掉外层重复的 `ensureFollows(true)` |
| 11 | 关注列表加载失败渲染空白块（三分支全不命中，无重试入口） | `account/index.vue:1218-1227`、L797-850 | 显式 `error` 分支 + 重试按钮 |
| 12 | 未绑 Wikidot 的用户点关注星标必然 401 且零提示 | `user/[wikidotId].vue:231` `canFollow`、L250-264 catch 只 warn | `canFollow` 加 `linkedWikidotId != null`；置灰 + tooltip「绑定 Wikidot 账号后可关注」；失败 toast |
| 13 | 星标 `aria-label` 写「收藏作者」与站内「关注」不一致；无 loading/disabled；连点并发 follow+unfollow；36px 触控目标 | `UserHeader.vue:10-24`、`user/[wikidotId].vue:250-264` | 文案统一「关注作者」；`:disabled="pending"` + spinner；去掉「先 await fetchFollows 再读状态」的读后改；`h-9 w-9` → `h-11 w-11` |
| 14 | 铃铛下拉一次渲染约 120 个 DOM 节点，无截断无虚拟化 | `layouts/default.vue:610-634`、L171-223 | 只渲染前 10 条 + 「查看全部 N 条」 |
| 15 | 下拉键盘不可用：`@keydown.stop.prevent` 吞掉 Tab；容器无 tabindex；打开时不移焦点；全局 Esc 不关它 | `layouts/default.vue:157`、L152-158、L177-184、L952-981 | 容器 `tabindex="0"` + `role="menu"`；只拦 ArrowUp/Down/Home/End/Escape；打开时焦点移入首项；`aria-activedescendant`；全局 Esc 加上本下拉 |
| 16 | 下拉永远不显示加载态（`toggleAlertsDropdown` 强制 `alertsActiveTab='ALL'` 使 `isMetricTab` 恒 false）；`switchAlertsTab` 是死代码 | `layouts/default.vue:169`、L636-649、L683-690 | 删掉强制赋值；加载态直接绑 store 的 `loading`；删死代码 |
| 17 | 下拉底部链接跳 `/account` 落在「资料」tab | `layouts/default.vue:224-228` | 改 `/account/notifications` |
| 18 | 时间未按 UTC+8 格式化且无年份（海外用户差 8 小时；去年 12 月与今年无法区分） | `account/index.vue:1182-1205`、`layouts/default.vue:551-578` | 统一 `utils/timezone.ts::formatDateTimeUtc8`，跨年补年份；相对时间 + `title` 放绝对时间 |
| 19 | 提醒卡片头部窄屏横向溢出（内层 `flex items-center gap-3` 无 `flex-wrap`） | `account/index.vue:178` | 工具条 `flex flex-wrap gap-2`，375px 实测 |
| 20 | 未读计数用 `Number.isFinite(res.unreadCount)` 判断，字符串静默变 0 | `useAlerts.ts:120`、`useFollowAlerts.ts:53`、`useForumInteractionAlerts.ts:72` | `Number(...)` 转换后再 `Number.isFinite` 兜底 |
| 21 | 未绑 Wikidot 的登录用户完全没有通知入口（铃铛 `v-if` 直接消失）；铃铛 hydration 后才插入造成布局抖动 | `layouts/default.vue:132`、L736-768 | 铃铛始终渲染；未绑定时下拉显示引导卡「绑定 Wikidot 账号后即可接收站点提醒 →」；SSR 阶段渲染固定宽高占位 |
| 22 | 账号页无 middleware 无标题：未登录先看到完整骨架再被 `onMounted` 弹走；已登录 SSR 阶段渲染「未绑定」再闪回 | `account/index.vue:1399-1449`；全仓无 `frontend/middleware/` | 新建 `middleware/auth.ts` + `definePageMeta` + `useHead` |
| 23 | 6 个 tab 全 `v-show` 常驻 DOM 各自发请求；tab 按钮是裸 button 无 `role="tablist"/tab/tabpanel` | `account/index.vue:3-24`、L26/158/168/172/771/854 | 通知/关注抽独立路由；剩余 tab 改 `v-if` + `<KeepAlive>` + 完整 ARIA |
| 24 | 进页面并发 5 个提醒请求，其中 4 份当场作废；status/linkedWikidotId 的 watch 还各再打一轮 | `account/index.vue:1399-1490` | 单 store 单请求（`feed` + `summary` 共 2 个） |
| 25 | 无分页：limit 硬编码 20，第 21 条以后永不可达；`GET /follows` 全量无分页无搜索 | `account/index.vue:531`、`useFollowAlerts.ts:40`、`useCombinedAlerts.ts:33`、`follows.ts:13-33` | feed 游标分页 + 【加载更多】；`/follows` 加 `limit/offset/q` |
| 26 | 死接口/死参数：`includeRead` 被 BFF 完全忽略；`GET /alerts/follow/combined` 前端从不调用 | `useCombinedAlerts.ts:33/43` vs `alerts.ts:752-800`；`followAlerts.ts:78-155` | 新端点不带死参数；旧端点在阶段 6 一并下线 |
| 27 | `<transition name="fade">` 无对应 CSS（只在未被全局引入的 `redesign.css` 里） | `layouts/default.vue:149/252`；`redesign.css:823-830` | `.fade-*` 移入 `assets/css/tailwind.css` |
| 28 | 账号页硬编码 `bg-white/80` 等，自定义配色只作用到强调色，面板底色与文字色不跟随 | `account/index.vue:27/172/640/719/804` 等 | 全面改用 `rgb(var(--panel))` / `--panel-border` / `--fg` / `--muted` |
| 29 | 未读仅靠颜色区分且对比度约 3:1；装饰 `span` 上的 `aria-label` 多数辅助技术会忽略 | `account/index.vue:332/373/480/665`、L188-218 | 左侧 3px 实心竖条 + `<span role="status" aria-label="未读">` + 对比度提到 4.5:1 |
| 30 | 登出后 `follows` 不清空：A 登出 B 登录会先看到 A 的关注态；失败清空为 `[]` 让 `isFollowing` 说谎 | `useFollows.ts:14-66`、`layouts/default.vue:1005-1010` | 加 `reset()` 并挂进 auth watch；失败不清空 |
| 31 | 来源/视图不持久化不可深链（只有 metric 存了 localStorage） | `account/index.vue:1027-1028` | `filters` 序列化进 URL query |
| 32 | `useAlerts` 在 setup 期同步读 localStorage 并改写 `useState`，是 hydration 隐患 | `useAlerts.ts:65-74` | 新 store 初值只从 URL query 读，localStorage 迁到 `onMounted` |
| 33 | `design-system.vue` 的 `.notif-icon.warning` 引用未定义的 `--warning` 令牌 | `design-system.vue:2425-2428` vs `scheme.css:38-45` | `scheme.css` 补 `--warning`（light/dark 两套） |
| 34 | 四个视图四种空态口径；页面指标空态写「持续关注也许能带来惊喜」（语义串台） | `account/index.vue:687-689/764-766/405-407/503-505` | 统一 `NotificationEmptyState`，按当前筛选参数化文案 + 行动引导 |
| 35 | `RATING`/`SCORE` 死枚举：前端每次为它们各发一次必空请求（各带一次 `/auth/me` 往返） | `useAlerts.ts:5/31-37/191/199/210`、`useAlertSettings.ts:26-32` | 前端与 BFF 引用全部清掉；DB 枚举保留不动 |
| 36 | BFF `normalizeMetric` 静默回落：`POST /alerts/read-all` 传错 metric 会把评论提醒全部误标已读 | `alerts.ts:280-284`（被 L300/L732 使用） | 返回 `null` + 400 `invalid_metric` |
| 37 | `resolveAppUserId` 把 cuid `parseInt` 当主库 `User.id`（当前靠恒为 NaN 侥幸走对回退分支） | `alerts.ts:264-278`（被 L383/401/608 使用） | 删掉该函数，全部统一走 `wikidotId` 路径 |
| 38 | 任意登录用户可向主库注入 User 行（`POST /follows` 对任意 `targetWikidotId` 调 `ensureUserByWikidotId` 会 INSERT） | `follows.ts:45` + `utils/auth.ts:45-56` | 改为 `SELECT` 校验存在性，不存在 404 `target_not_found`；`/follows` 加限流 30 次/分钟 |
| 39 | 偏好写入 upsert 竞态：快速连点静音开关触发 500 | `alerts.ts:454-473/531-549/656-675` | 改 `INSERT ... ON CONFLICT ("userId", metric) DO UPDATE` |
| 40 | `POST /follows` 重复关注返回 `{ok:true,id:null}`，调用方无法区分新建与已关注 | `follows.ts:49-59`、`useFollows.ts:38-47` | 返回 `{ok:true, created:boolean}` |

---

## 10. 安全与滥用防护

### 10.1 验证码

- **格式**：`SCPPER-` + 12 位，字符集 `ABCDEFGHJKMNPQRSTUVWXYZ23456789`（31 字符，排除 0/O、1/I/L）→ **59.4 bit** 熵。用 `crypto.randomInt`（复用 `wikidotBinding.ts` L108-116 的生成器，长度参数化）。前缀便于机器人正则识别。
- **TTL 15 分钟**（在用户指定的 10–30 min 区间内）。QQ 私聊是即时动作，不需要 Wikidot 的 48h；窗口小 = 可爆破窗口小。
- **不明文落库**：`codeHash = sha256(明文)` `@unique`（反查 O(1)）+ `codeHint = 明文[7:11]`。这满足 `user-backend/src/services/AGENTS.md` L31 明令的反模式禁令，也与 `VerificationToken.codeHash` 一致。**`WikidotBindingTask.verificationCode` 的明文存储在 QQ 场景没有辩护理由**（Wikidot 的码本来就要公开写进修订注释，QQ 的码是私聊传递的准秘密）。
- **四层限流**：
  1. `POST /qq-binding/start`：userId 5 次/15min **且** IP 20 次/15min ← **补 `wikidotBinding.ts` 完全缺失的限流**
  2. qqbot `qq_verify.py` 进程内：同 `user_id` 3 次/60s
  3. user-backend `/internal/qq-binding/verify`：按 `qqNumber` 10 次/10min + 全局 300 次/10min
  4. 任务级 `attemptCount ≥ 5` → challenge 置 `FAILED`
- **枚举防护**：「码不存在 / 已过期 / 非最新任务」返回**同一句** reply，不泄露任务存在性。
- **并发安全**：`verifyQqBinding` 全程 Serializable + **加锁顺序固定为先 `UserAccount` 后 `ChannelBindingChallenge`**（照 `wikidotBinding.ts` L458-466 的注释，这是防 start/verify 死锁的关键），P2034/40001 重试；条件插入 + `count !== 1` 必须 throw、P2002 兜底。

### 10.2 服务间鉴权

| 调用方 → 被调方 | 密钥 | Header |
|---|---|---|
| backend dispatcher → qqbot `/scpper/qq/*` | `QQ_BOT_API_TOKEN` | `Authorization: Bearer` |
| user-backend → qqbot `/scpper/qq/push` | 同上 | 同上 |
| qqbot → user-backend `/internal/qq-binding/*` | **`QQ_BOT_INTERNAL_KEY`** | `x-internal-key` |
| backend dispatcher → user-backend `/internal/notifications/*` | **`NOTIFY_INTERNAL_KEY`** | `x-internal-key` |
| backend → user-backend `/internal/wikidot-binding/*` | `INTERNAL_API_KEY`（不变） | `x-internal-key` |
| user-backend → BFF `/internal/*` | `BFF_INTERNAL_API_KEY`（不变） | `x-internal-key` |

**为什么 qqbot 必须用独立密钥**：`INTERNAL_API_KEY` 是 user-backend 全部 `/internal/**` 的共用单一密钥。把它发给 qqbot，机器人同时获得了 `POST /internal/wikidot-binding/complete` 的能力——只要 proof 字段拼对，就能把任意 Wikidot 账号绑到任意 userId。而 qqbot 是一个跑 LLM（`.ai` / `.bigcat`）+ MCP DB server、只有一个 commit、`.env` 明文躺在工作区的高攻击面进程。

实现要求：
- 全部密钥 `openssl rand -hex 32`，只写各服务 `.env`；**绝不写进 `ecosystem.config.cjs` 的 env 块**（会进 git）、**绝不写进 `config.py` / `config.ts` 的默认值**
- 比较统一用 `crypto.timingSafeEqual`（长度先判等）/ Python `hmac.compare_digest`。现有 `wikidotBinding.ts:229`、`bff/src/web/router.ts:57`、`mail-agent/src/server.mjs:198` 全是普通 `!==`，而同仓 `utils/auth-token.ts:65` 却正确用了 `timingSafeEqual`。新代码封装为 `user-backend/src/utils/internalAuth.ts::verifyInternalKey(req, envName)`
- 缺 key fail-closed 503，不匹配 403
- 日志 redact 加 `req.headers['x-internal-key']`、`req.headers.authorization`、`req.body.code`、`req.body.qqNumber`
- **轮转**：接收侧同时读 `KEY` 与 `KEY_PREVIOUS`，流程写进两仓 `AGENTS.md`

### 10.3 网络边界（**上线前必须处理，否则前功尽弃**）

1. **qqbot `.env` `HOST=0.0.0.0` → `127.0.0.1`**。NapCat 是 host 网络模式且反连目标本就写 `ws://127.0.0.1:8080/onebot/v11/ws`，改回环不影响。不改则新增的 `/scpper/qq/push` = 给公网一个「以机器人身份私聊任意 QQ」的入口。
2. **补 `ONEBOT_ACCESS_TOKEN`**（三个 `onebot11_*.json` 的 token 当前均为 `""`）。任何能访问 8080 的人都可以伪装成 NapCat 连进来注册 Bot 实例；`get_bot_for_send()` 只按 QQ 号取 Bot，**伪造实例会截获后续全部推送内容（含用户的通知正文）**。
3. **NapCat WebUI 收口**：`[::]:6099`、`accessControlMode:"none"`、token 仅 12 位十六进制 `d90f15849910`、`autoLoginAccount` 已设。改 `docker-compose.yml` 把 6099 映射限制到 `127.0.0.1:6099`，并换 32 字节 token。泄露即可接管 QQ 登录态、改 OneBot 配置、把消息转发到任意地址。
4. **顺手修 `mail-agent/src/server.mjs:219`** 的 `listen` 加 `'127.0.0.1'`（`ss` 确认现在是 `LISTEN *:3110`）。
5. **上线前从外部网络实测** 8080 / 6099 / 3110 / 4396 / 4455 的可达性。⚠️ **未确认**：本机 `curl 公网IP` 只能证明主机 INPUT 链未拦，无法区分云厂商安全组是否生效。

### 10.4 QQ 号隐私

- **主库永不存 QQ 号**（主库有 60 张表，qqbot 自己也直连主库）
- 用户库存明文 + `@unique`（需要等值查询与唯一约束）。**API 一律只返回 `addressMask`（`1234***9`，前 4 后 1）**：`/auth/me`、`/qq-binding/status`、`/notification-settings`、`/admin/accounts` 全部如此。**BFF 全链路拿不到完整号。**
- 完整号只在两处被读：user-backend 的绑定/推送服务、backend dispatcher 的跨库只读查询（内存缓存 60s，不落盘、不进日志）
- **不加密列**（放弃 notification-hub 的 HMAC+AES 方案）：加密会破坏 `@unique` 与等值查询，需要额外的 HMAC 索引列 + 密文列 + 密钥管理三件套。对本项目规模，「掩码 + 最小暴露面 + 库权限收口」性价比更高。⚠️ 若用户认为 QQ 号敏感度高于此判断，可在阶段 6 追加（成本约 1 天 + 一次数据迁移）
- **Phase 0 必做：为 qqbot 新建真正只读的 PG 角色 `qqbot_readonly`**（`GRANT SELECT ON ALL TABLES IN SCHEMA public`、`ALTER ROLE ... NOCREATEDB`、`REVOKE ALL ON DATABASE scpper_user`）。现在的 `user_dxzbdi` 实测在 public schema 的 60 张表上有 INSERT/UPDATE/DELETE/TRUNCATE、`rolcreatedb=true`、且能连 `scpper_user` 库——这是本次改动里风险收益比最高的一项。

### 10.5 解绑与劫持防护

- **网页解绑必须二次凭据**（密码或邮箱验证码）。没有它，会话劫持者可以静默把推送目标改到自己的 QQ，从而持续窃取受害者的站点活动情报。
- **QQ 侧 `.退订` 只 PAUSE 不解绑**：QQ 号被盗时攻击者无法把绑定关系解开去绑到自己账号，只能停掉推送（可逆）。
- 解绑后向原 QQ 推「已解除绑定」——**这条通知本身就是被劫持的告警信号**。
- 管理端解绑**必须调 `invalidateAuthCache`**（现有 `admin.ts:90-96/114` 与 `cli/linkWikidot.ts:69-72/99-102` 的 wikidot link/unlink 都漏了这一步，导致 30 秒陈旧缓存），本次一并补。

### 10.6 频控与熔断汇总

| 面 | 机制 | 参数 |
|---|---|---|
| 绑定发起 | 滑动窗口 userId + IP | 5 次/15min、20 次/15min |
| 验证码提交（qqbot） | 进程内节流 | 3 次/60s/用户 |
| 验证码提交（服务端） | 按 qqNumber + 全局 | 10 次/10min、300 次/10min |
| 验证码尝试 | `attemptCount` | 5 次后作废 |
| 测试推送 | 按 userId | 3 次/小时 |
| QQ 投递（用户级） | `dailyLimit` + 每轮 1 条摘要 | 40 条/天 |
| QQ 投递（单号） | qqbot 滑动窗口 | 20 条/分钟 |
| QQ 投递（全局） | qqbot 滑动窗口 | 200 条/分钟 |
| 好友申请 | 日配额 | 200 次/天，超限转忽略 |
| **冷启动熔断** | `NOTIFY_DISPATCH_START_AT` | dispatcher 永不处理早于该时刻的告警，否则首次上线会把存量一次性推给所有用户 |
| **单用户熔断** | `NOTIFY_CIRCUIT_USER_MAX` | 20，超出合并为摘要 + `SUPPRESSED(circuit_user)` |
| **全局熔断** | `NOTIFY_CIRCUIT_GLOBAL_MAX` | 2000，整轮只写 `SUPPRESSED` + `logger.error` + 写 `NotificationDispatchState.circuitTrippedAt`，需 `notify-dispatch --reset-circuit` 人工复位 |

全局熔断是必须的：`analyze --full` 或 `AnalysisWatermark` 丢失会让 changeSet 退化为全库 30 万 PageVersion，156450 条 watch 整体重算，可能单轮产生上万条告警。

---

## 11. 分阶段实施计划

> 全程遵循仓库规范：`bash scripts/dev-worktree.sh create <type>/<topic>` 建 worktree → 开发 → PR → **Codex review + Claude Code review** → 受保护 main 部署 → `pm2 restart` + 日志核查。
> **user-backend 的 `dist/` 提交进了仓库且 PM2 指向 `./dist/server.js`，改完必须 `npm run build` 再 `pm2 restart scpper-user-backend`**（与 backend 用 tsx 直跑 `src/` 的习惯不同，最容易漏）。

---

### 阶段 0 — 前置修复与安全收口（2-3 天，零功能变化，可独立上线）

**scpper-cn 侧**
- `backend/prisma/migrations/20260801090000_notification_prereq/migration.sql`：`UserTagPreference.id` → BIGINT + 序列改 BIGINT；三条缺失索引
- `backend/prisma/schema.prisma`：按生产实际结构收编 `UserFollow` / `UserActivityAlert`（`type String`、`@db.Timestamp(3)`、无 FK），`migrate resolve --applied` 打基线
- `backend/src/jobs/UserFollowActivityJob.ts` L169-192：修 `-1` 占位符 bug（同批次内同 `(follow, page)` 的第二条及以后 revision 被静默丢弃 —— `UPDATE ... WHERE id = -1` 影响 0 行）；改用 `$queryRaw INSERT ... RETURNING id` 把真实 id 写回 `existingRevMap`；顺带修 L189 无条件 `created += 1` 的假计数
- `bff/src/web/routes/alerts.ts`：`POST /:id/read`、`/read-all`、`/read-batch` 三处补 `cache.del`（先止血未读回弹）
- `mail-agent/src/server.mjs:219` `listen(port, '127.0.0.1')`；L198 改 `timingSafeEqual`

**qqbot / DB 侧**
- 新建 `qqbot_readonly` PG 角色，`REVOKE` 其对 `scpper_user` 的连接权；改 qqbot `.env` 的 `DB_USER/DB_PASS`；清空 `config.py` L11-12 的硬编码默认值
- qqbot `.env` `HOST=127.0.0.1`；补 `ONEBOT_ACCESS_TOKEN` 并同步 `napcat/config/onebot11_*.json`；NapCat WebUI 绑回环 + 换 32 字节 token

**验收**：`pm2 logs scpper-sync` 连续 3 轮无 `user_social_analysis` 失败；`prisma migrate diff` 输出为空；手工制造同页多次修订确认告警不丢；从外部网络 8080/6099/3110 不可达。

---

### 阶段 1 — qqbot 通道打通（1-2 天，纯 qqbot 仓库，scpper-cn 零改动）

- 新建 `src/plugins/scpper/external_api.py`、`friend_request.py`
- 修改 `monitor/notify.py`（`chunk_text` + `send_private_text`）、`__init__.py`（两条 import）、`config.py`、`.env`
- 新建 `qqbot/AGENTS.md` + `.env.example` + `.gitignore`

**验收**：`pm2 restart qqbot` 后 `curl -H "Authorization: Bearer $T" 127.0.0.1:8080/scpper/qq/health` 返回在线账号；对一个测试 QQ 走「加好友 → 自动同意 → 收到引导语 → push 一条测试消息」全链路；分片消息正确。
**可独立上线**：是（无任何用户可见功能，回滚 = 删两行 import）。

---

### 阶段 2 — QQ 绑定闭环（3-4 天，scpper-cn worktree + PR）

- qqbot：新建 `qq_verify.py`，`__init__.py` 加一条 import
- user-backend：
  - 迁移 `20260801100000_notification_channels`（三张表 + 五个枚举 + `VerificationPurpose.CHANNEL_UNBIND`）
  - `src/services/qqBindingProof.ts`（纯函数 + `tests/qqBindingProof.test.ts`，node:test + tsx，`package.json` 加 `test:qq-binding`）
  - `src/services/qqBinding.ts`（`runQqBindingTransaction` Serializable + `lockAccount → lockChallenge` 固定顺序 + P2002 兜底 + `invalidateAuthCache`）
  - `src/services/qqPush.ts`（1:1 对照 `services/mail.ts`，硬超时 3s + AbortController）
  - `src/services/notificationDefaults.ts` + `notificationPrefsRules.ts`（+ 单测）
  - `src/routes/qqBinding.ts`（用户侧 6 路由 + 内部 verify/command，`timingSafeEqual` 守卫 + 双维度限流）
  - `src/utils/internalAuth.ts`
  - `src/app.ts` 挂载；`src/config.ts` 加 `qqBot.{baseUrl,token,internalKey,selfId,nickname,addFriendUrl}`
  - `routes/auth.ts::formatUser` + `middleware/requireAuth.ts` 四处透出 `qqBinding`
- BFF：`router.ts` 加 `/qq-binding` 反代；`utils/auth.ts` 的 `AuthUserPayload` 加 `qqBinding`
- 前端：`composables/useQqBinding.ts`、`components/account/QqBindingPanel.vue`、挂进 `pages/account/index.vue` 的「账号绑定」分组、`useAuth.ts` 加字段
- `.env.example` 登记新变量（backend/frontend/avatar-agent 目前**没有** `.env.example`，本阶段一并补 backend 的）

**验收**：真实账号完成绑定并在 QQ 收到回执；逐一测试 §5.2 全部 9 个失败分支的文案；解绑需要密码；`ChannelBindingChallenge` 表中查不到任何明文码；`pm2 restart scpper-user-backend` 前先 `npm run build`。
**可独立上线**：是（绑定自成闭环，绑了暂时收不到推送）。

---

### 阶段 3 — QQ 推送 MVP（3-4 天，backend + 主库迁移）

- 主库迁移：`NotificationDelivery` + `NotificationDispatchState` + 三个枚举 + `User` 关系
- `backend/src/services/userDirectory.ts`（只读第二 Prisma client 连 `USER_DATABASE_URL`，沿用 `cli/alerts.ts` L58-125 的 `createRequire` 加载方式，60s 缓存）
- `backend/src/services/qqPush.ts`（与 user-backend 同名同构）
- `backend/src/jobs/NotificationDispatchJob.ts`：
  - `loadActiveTargets()` → `scanCandidates()`（三条 24h 回看 SQL，先按活跃收件人收窄）→ `decideDelivery()`（纯函数，可单测）→ `aggregate()` → `dispatch()` → `report()`
  - `buildDedupeKey()`、`renderQqDigest()`
- `backend/src/cli/notify-dispatch.ts` + `cli/index.ts` 注册 `notify-dispatch --interval-seconds 60 --run-immediately [--reset-circuit] [--dry-run]`（循环骨架照抄 `wikidot-binding-verify-loop`）
- `backend/ecosystem.config.cjs` 加第 4 个 app `scpper-notify`（照 `scpper-binding-verify`：fork、单实例、`autorestart`、**清空 `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` 并设 `NO_PROXY=127.0.0.1,localhost`**）
- user-backend：`/internal/notifications/report-delivery` + 健康熔断 + 降级邮件

**上线策略**：`NOTIFY_QQ_ALLOWLIST` 先只放开 3-5 个内测账号，观察 48 小时（投递量、失败率、QQ 风控迹象），再按 10% → 50% → 100% 放开。**必须设 `NOTIFY_DISPATCH_START_AT`。**

**验收**：论坛回帖后 ≤60s 收到 QQ 摘要；杀掉 qqbot 后 delivery 留 PENDING，重启后自动补发；`analyze --full` 演练触发全局熔断且不发任何消息；`acknowledgedAt` 全程未被写过；`pm2 logs scpper-sync` 显示 sync 耗时无变化。
**可独立上线**：是（偏好用默认值，设置页尚未做）。

---

### 阶段 4 — 通知中心重做（4-5 天，BFF + 前端，不依赖 QQ，可与阶段 3 并行开发）

- BFF `src/web/routes/notifications.ts`（`GET /`、`GET /summary`、`POST /read`、`POST /unread`），`router.ts` 挂载；删除 `GET /alerts` 的 30 秒 Redis 缓存
- BFF `routes/alerts.ts` / `follows.ts` 修 bug #36–#40
- 前端：`composables/useNotifications.ts`、`useFollows.ts` 改造、`middleware/auth.ts`、`pages/account/notifications/index.vue`、`pages/account/following.vue`、7 个 `components/notifications/*`、`components/account/FollowsPanel.vue`
- `layouts/default.vue` 铃铛抽出为 `NotificationBell.vue` 并重做
- `pages/account/index.vue`：删掉 L172-852 的四套重复模板与关注面板、`?tab=` 重定向、`v-if`+KeepAlive、ARIA、设计令牌
- `UserHeader.vue` + `user/[wikidotId].vue` 关注按钮重做
- `scheme.css` 补 `--warning`；`tailwind.css` 补 `.fade-*`

**验收**：逐条核对 §9 的 40 条；断网时列表保留 + 显示重试；连点刷新第二次生效；标记已读后未读数立即正确不回弹；关注告警计入铃铛；第 21 条以后能翻到；键盘可完整操作铃铛下拉；375px 无横向滚动；Lighthouse 无障碍 ≥ 95。
**可独立上线**：是。

---

### 阶段 5 — 细粒度通知偏好与设置页（2-3 天，依赖 3 与 4）

- user-backend `src/routes/notificationSettings.ts`（`GET` / `PATCH /matrix` / `PATCH /channel/QQ` / `PATCH /generation`），全部单事务 `ON CONFLICT DO UPDATE` + 重算 `resolvedMatrix`
- user-backend `src/cli/rebuildMatrix.ts`（默认值表版本变更时批量重算）
- BFF：`/notification-settings` 反代 + `GET|POST /internal/alert-preferences`（顺带修 `/alerts/preferences` 与 `/preferences/mute` 的 upsert 竞态 500）
- 前端：`pages/account/notifications/settings.vue` + `ChannelCard` / `QuietHoursEditor` / `EventChannelMatrix` / `GenerationSettingsPanel`；`useNotificationSettings.ts`；删除 `useAlertSettings.ts` 与全部 `RATING`/`SCORE` 引用
- dispatcher 启用 `digestMode`（HOURLY/DAILY 的 `scheduledAt`）、`quietHours`、`dailyLimit` 四项判定
- qqbot `.通知` / `.静音` / `.退订` 指令 + user-backend `/internal/qq-binding/command`

**验收**：关闭某类型的 QQ 开关后下一轮不再推送但站内红点仍在；免打扰 DEFER 的 delivery 带 `scheduledAt` 且到点补发；`.静音 24h` 生效；「发送测试」可用且限流生效；快速连点开关不再 500。
**可独立上线**：是。

---

### 阶段 6 — 收尾、运维面与技术债（3-4 天，可拆多个独立 PR）

- (a) `NotificationRetentionJob` + CLI `notify-retention` + PM2 cron app（每日 04:00）：`NotificationDelivery` 中 `state IN (SENT,SUPPRESSED,CANCELLED) AND createdAt < now-30d`、终态 `ChannelBindingChallenge < now-90d`、三张 alert 表已读超 180 天归档。**先只做 dry-run 统计输出，实际删除需用户显式确认后启用**
- (b) 运维面：`GET /internal/notifications/stats?window=24h`；CLI `notify-inspect --failed --since`、`notify-replay --delivery-id`
- (c) 管理端：`POST /admin/accounts/:id/unbind-channel` + `invalidateAuthCache`（并补上 wikidot link/unlink 漏掉的那处）；`/admin/accounts` QQ 掩码 + 「显示完整号」审计日志
- (d) 密钥双读轮转支持（`KEY` + `KEY_PREVIOUS`）+ 契约版本校验
- (e) 下线已 deprecated 两个周期的旧 `/alerts*` 端点与 `GET /alerts/follow/combined` 死端点
- (f) 文档：`CLAUDE.md`（架构图加 `scpper-notify`、PM2 段、环境变量段）、`AGENTS.md`、`docs/development-workflow.md`、新建 `docs/qq-notification-2026-08.md`（本计划定稿）

**验收**：retention dry-run 输出合理且未执行删除；全链路端到端演练一遍；文档与实际部署一致。

---

## 12. 风险与未决问题

### 12.1 需要用户拍板的决策点

1. **验证码 TTL 定 15 分钟可以吗？** 用户给的区间是 10–30 分钟，我选 15。若希望更宽松（如 30 分钟）只需改一个环境变量，但爆破窗口相应变大。
2. **验证码只显示一次能接受吗？** 为了不明文落库，`/status` 只能回显前 4 位 + 「重新生成」。跨设备场景（PC 生成、手机绑定）用户从屏幕读码没问题，但 PC 刷新页面就得重来。若不接受，可改为 AES-GCM 加密存储供本人回显（+1 天工作量 + 密钥管理）。
3. **好友申请默认无条件同意，还是必须在验证信息里带码？** 我选默认无条件（+日配额 200）。要求带码更干净但体验差（部分 QQ 客户端不显示提示文字），且好友关系本来就不是安全边界。
4. **QQ 推送固定「每轮一条摘要」可以吗？** 不做 per-item 即时推。用户不会为每条回复单独收到私聊。这是防风控/防封号的主动选择，但会削弱「即时感」。
5. **端到端最坏 ~90 分钟延迟可以接受吗？** 本方案不改 `sync-hourly`。若产品要求 5 分钟内，需为论坛评论单开一条高频轻量扫描（`ForumSyncProcessor` 是爬虫，提频有反爬风险），属于独立项目。
6. **QQ 号明文存储（不加密）可以接受吗？** 见 §10.4 的权衡。若认为敏感度更高，阶段 6 可追加 HMAC+AES 方案。
7. **是否允许 backend dispatcher 只读直连用户库？** 有既有先例（`cli/alerts.ts`），写入方向仍严格单一。若坚持纯 HTTP 边界，改用 `GET /internal/notifications/qq-targets`（已在契约里预留），代价是每轮多一跳。
8. **是否需要邮件降级？** 我只对 `ACCOUNT_SECURITY` 与 `FORUM_DIRECT_REPLY` 白名单降级。全量降级会把 QQ 的高频通知灌进邮箱并触发 SMTP 限流。
9. **未绑 Wikidot 的账号收不到任何站点通知**（所有 alert 表按主库 `User.id` 索引，而 `User` 由 `wikidotId` 定义）。这意味着 QQ 通知的潜在用户上限就是当前 788 个已绑 Wikidot 的账号。符合产品预期吗？
10. **1:1 绑定（一账号一 QQ、一 QQ 一账号）可以吗？** 与 `linkedWikidotId` 对称。换绑必须先解绑（且需二次凭据）。
11. **三张 alert 表是否要在将来统一成 Notification 中枢？** 本方案有意不做（见 §1.4-1）。notification-hub 的 Event/Notification/Delivery 三层是正确终局，但那是一次不可逆的大迁移（含双写、回填、校验、旧表退役），建议作为独立项目在本次上线稳定后评估。
12. **retention 的实际删除动作**：本计划默认只做 dry-run，需用户显式授权后才真删（遵循「不做破坏性数据操作」的仓库规则）。

### 12.2 探查未能确认的信息（实施时必须实测）

| # | 未确认项 | 影响 | 何时验证 |
|---|---|---|---|
| 1 | **QQ 对私聊推送的真实风控阈值**（频率上限、单日上限、触发后的惩罚） | 决定 `qq_push_rate_max` / `dailyLimit` 的取值是否安全；触发风控可能导致账号被限制 | 阶段 3 灰度期观察 48 小时 |
| 2 | **NapCat 对非好友 / 临时会话（`sub_type='group'/'other'`）的发送成功率** | 本计划假设「加好友是硬前置」。若临时会话也能发，可省掉加好友步骤 | 阶段 1 实测 |
| 3 | **8080 / 6099 / 3110 / 4396 / 4455 的真实外网可达性** | 本机 `curl 公网IP` 只证明 INPUT 链未拦，不能区分云厂商安全组 | 阶段 0 从外部网络实测 |
| 4 | **qqbot 累计重启 208646 次的根因** | 决定投递可用性的下限；本方案用「留 PENDING + 24h 窗口重试」兜底，但不解决根因 | 阶段 1 前单独排查 |
| 5 | **本仓库 Prisma 版本对 `-- prisma:no-transaction` 指令的支持** | 影响 `CREATE INDEX CONCURRENTLY` 能否走 migrate | 阶段 0 |
| 6 | **`UserActivityAlert` 生产表的 `type` 列真实取值集合与约束** | 探查报告说是 `text` 且有 `ATTRIBUTION_REMOVED`，但脚本里 enum 只声明两个；收编 schema 时需以 `db pull` 为准 | 阶段 0 |
| 7 | **`PageMetricAlert` 在启用新索引后的实际查询计划** | 探查测得当前最重用户 26.9ms 执行 + 44.2ms 规划；新索引效果需实测 | 阶段 0 |
| 8 | **`backend` 侧 Prisma client 能否跨库加载 user-backend 的 client**（`cli/alerts.ts` 的 `createRequire` 方式在 PM2 环境下是否稳定） | dispatcher 的跨库读方案 | 阶段 3 先用 `--dry-run` 验证 |
| 9 | **qqbot 的 `get_friend_list` 速率限制** | 好友缓存 TTL 45 秒是否足够保守 | 阶段 1 |
| 10 | **`sync-hourly` 单轮耗时的长期分布** | 探查测得 19-27 分钟；决定「最坏 90 分钟」这个对外承诺的准确性 | 持续观察 |

### 12.3 已知会保留的缺陷（诚实披露）

1. **未读折叠导致的近似推送**：票数 120→141→141（回落再涨回同值）的中间变化会被 `contentSig` 去重吞掉。要精确需引入事件明细表并改 Job 合并语义。
2. **跨表深翻页性能**：`UNION ALL` 的 keyset 分页在 offset 很深时线性恶化。当前量级（未读 3.3 万）无碍。
3. **单账号单点**：1248393597 掉线时好友校验、验证码接收、推送三条链路同时失效。用队列重试 + 站内永远可靠兜底，不做双活。
4. **偏好生效延迟**：dispatcher 的 60 秒目标缓存意味着用户改完设置最多 60 秒后才对推送生效。UI 需提示。
5. **qqbot 跨仓协同无强约束**：qqbot 是独立仓库（1 个 commit、无 PR 流程、无分支保护）。两仓的唯一护栏是 `/scpper/qq/health` 的 `contract` 字段。qqbot 侧被随意修改仍可能导致契约漂移。
6. **`NotificationDelivery` 表增速**：日增约 550 条候选 × 渠道数，加上 SUPPRESSED 行。retention job 必须在阶段 6 前上线，否则半年后表会显著膨胀。