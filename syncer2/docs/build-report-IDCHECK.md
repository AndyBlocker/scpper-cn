# IDCHECK：失败签名驱动的通用身份复核

日期：2026-08-05（Asia/Shanghai）  
分支：`scpper-backend-v2`  
目标库：`scpper-v2`（v1 `SYNCER2_V1_DATABASE_URL` 未改、未写；未访问 qqbot、未发送 QQ）

## 结论

已把身份复核从 `revision_count` 倒退的特例提升到 work queue 的统一失败出口。
判据不再使用不分原因的 `attempts`：每个错误先归一成稳定失败签名，再决定身份复核、退避或
`meta.irreconcilable`。page-bound AMC 的空实体/空体 HTTP 500/`no_page` 是旧 pageId
不存在的直接证据，阈值为 **1**；503、超时、reset、带错误正文的瞬时 500 不触发 slug GET；
解析结构/权限/本地不变量错误首次即隔离，不再指数退避。

## 实现

### 1. 失败策略

`src/work/failurePolicy.ts` 是唯一分类入口：

| 失败签名 | 是否可能自行恢复 | 身份复核阈值 | 队列结局 | 依据 |
|---|---:|---:|---|---|
| page-bound AMC `status=ok` 但 body null/空、空 body HTTP 500、`status=no_page/not_found` | 否；旧 ID 无实体 | **1** | 立即按 slug 复核 | 本事故的 500 空响应与 revisions `no_page` 均只随 pageId 改变，不随重试改变 |
| 已直接回显 `pageId 身份不一致` | 否 | **1** | 立即按 slug 复核 | 响应已经给出不同身份 |
| HTTP 503/429、502/504、timeout/reset/其它 transport、`try_again` | 是 | 永不触发 | 保留退避/断路器 | 出口、WAF、限流或链路抖动；额外 slug 请求只会放大故障 |
| HTTP 500 且有错误正文 | 是（按服务端瞬时 500） | 永不触发 | 保留退避 | 与“旧 pageId 的空 500”形状不同，不能混判 |
| 缺成功 L1 claim / 暂缺前置证据 | 后续完整轮可补 | 永不触发 | 保留退避 | 不是远端身份结论 |
| 解析结构缺锚、行错位/重复、权限 `no_permission/not_ok`、本地不变量拒绝 | 相同代码重试无效 | 不复核 | 首次进 `meta.irreconcilable` | 等代码/契约修复后由终态复查验证；不制造指数退避噪声 |

`workFailureHash()` 只对同一 family/signature 计连续次数；换签名从 1 重新计，不能拿统一
`attempts` 拼阈值。瞬时失败强制不给稳定 hash，防止第三次相同超时被旧状态机误收敛成永久矛盾。

### 2. 三种身份结局

`src/work/identityCheck.ts` 复用 REGRESS 的 `apply_slug_reuse_identity`、lineage 与任务迁移：

1. slug 200 且 wikidotId 不同：旧页 deleted，新 ID `register_page`，写
   `ingest.page_lineage(kind='recreate', confidence=0.5)`，迁移包括当前失败任务在内的全部数据待办，
   清除旧 attempts/hash/backoff，并补 `new_page_highfreq/content/revisions_full`。
2. slug 404：只有在前一步失败签名已是“旧 ID 无实体”的前提下才进入；迁移
   `0036_identity_failure_recheck.sql` 的 SECURITY DEFINER 函数再次锁定并核对
   `page_id + wikidotId + slug`，随后写 `source='wikidot_identity_missing'` 的 deleted 事件，
   清空旧页任务并收口旧 irreconcilable。它是定向双直接证据，不依赖慢速的两轮全站 absence；
   原 M7 双源 absence 流程仍作为没有定向失败信号时的兜底。
3. slug 200 且 wikidotId 相同：只写成功 identity page_scan；原任务仍 failed、正常退避，
   不写 life/lineage、不迁移任务。

统一入口位于 `src/cli/work-queue.ts` 的 handler 后、`finishWorkTask` 前，因此 `votes_full`、
`content`、`revisions_full`、`files` 等 page-bound kind 使用同一判据；不是 votes 专补丁。
REGRESS 的 meta 路径也改为调用同一个 `applyConfirmedSlugReuse()`。

### 3. 数据库与权限

- 新迁移：`migrations/0036_identity_failure_recheck.sql`，已只应用到 `scpper-v2`。
- 函数对 PUBLIC 撤销 EXECUTE，只授权 `ingestor_role` / `migration_role`；完整权限测试通过。
- `reassignSlugReuseTasks(..., currentTaskId=null)` 会迁移当前失败任务；REGRESS meta 任务仍传自身
  id 并按原方式成功收尾。
- 身份替换/删除会 resolve 旧 page 的未结 irreconcilable；直接删除会清除包括
  `confirm_deleted` 在内的全部已完成使命的待办。

## 存量处理

### 指定页前后

| slug | 处理前 | 站上复核 | 处理后 |
|---|---|---|---|
| `scp-cn-4860` | live page `1500001170` / **1469079365**；`votes_full attempts=83`、`revisions_full attempts=92`，另有 meta/highfreq；content 终态未解 | 200 / **1469095518** | 旧页 deleted；新 live page `1500001550` / **1469095518**；新增 lineage；4 个原待办迁移并补齐标准任务，旧退避清零 |
| `scp-cn-4885` | live page `1500000744` / 1469072718；votes/highfreq 均 attempts=4；已有空 500 与整页 404 | **404** | page `1500000744` deleted；2 个待办清零；旧 content/revision-source irreconcilable 收口；不注册 successor |
| `scp-cn-2801` | 同 slug 共 4 身份；当前 live **1331831089** | 200 / **1331831089** | 身份正确，零改动；3 个旧 deleted 身份与现有历史完整保留 |

### 全部直接信号候选

按保留的 failed `page_scan`（空体 500 / `no_page` / 空实体）扫描所有仍标 live 的候选，
以 2 秒最小请求间隔执行两轮审计：

| run | 处理数 | slug 复用 | 删除 | 同 ID | 失败 |
|---:|---:|---:|---:|---:|---:|
| 13194 | 20 | 2 | 18 | 0 | 0 |
| 13195 | 18 | 0 | 18 | 0 | 0 |
| 合计 | **38** | **2** | **36** | **0** | **0** |

另一条复用是 `scp-9311`：1469066350 → 1469066352，复用既有 live successor 并迁移 2 个待办。
处理后直接信号 live 候选为 **0**，deleted 页上的 scan_task 为 **0**。审计结果完整保存在两轮
`wikidot_page_identity / identity_failure_stock_recheck` ingest run 的 stats 中。

## 回归证据

新增 `tests/identity-failure-check.test.ts` 6 项：

- 空体 500 + ID 改变：首次复核、注册 lineage、迁移当前与其它 kind 待办；
- 空实体 + slug 404：写删除生命事件，不注册 successor；
- 503、timeout、有正文 500：零身份复核调用，继续退避；
- 复核同 ID：不改身份，原 kind 有 `not_before`；
- `files` 证明判据不依赖 `votes_full`；
- 结构拒绝首次即进入 irreconcilable、没有退避时间。

验证结果：

```text
npx tsc --noEmit   PASS
定向回归            61/61 PASS
npm test           375/375 PASS（原基线 369 + 新增 6）
git diff --check   PASS
```

无阻塞；未 commit、未 push。
