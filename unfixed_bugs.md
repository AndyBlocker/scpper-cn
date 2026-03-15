# Unfixed Bugs & Deferred Optimizations

本文档记录了在 2026-03-15 综合代码审查中发现的问题及其修复状态。

**全部修复于 2026-03-16。**

---

## 1. Backend N+1 查询问题 — ✅ 已修复

### 1.1 DirtyQueueStore — markDirty 逐条查询 ✅

**修复**: 新增 `preloadLookups()` 方法，一次性加载所有 pages 和当前 versions 到 Map 中。`buildDirtyQueue()` 和 `buildDirtyQueueTestMode()` 使用 Map 的 O(1) 查找替代了 N 次独立数据库查询。`processStagingPage()` 改为纯同步方法。

### 1.2 PhaseAProcessor — 逐页 upsert

**状态**: 此项为 Phase A 内部的 per-page `loadCurrentVersion` 调用。每次调用内已有 `currentVersionLoaded` 缓存，不会对同一页面重复查询。跨页面的 N 查询是 Phase A 的设计特性（逐页从 GraphQL 获取后立即处理），不适合批量预加载。**保留现状**。

### 1.3 VoteRevisionStore — 逐条 upsert 投票修订 ✅

**修复**: 新增 `batchUpsertUsers()` 方法，使用 `INSERT ... ON CONFLICT ... RETURNING` 批量 upsert 所有用户（1 次查询替代 N 次）。`importVotes()` 和 `importRevisions()` 从预建的 `userMap` 中查找 userId。

### 1.4 AttributionService — 逐条 upsert 归属数据 ✅

**修复**: 同样新增 `batchUpsertUsers()` 方法批量处理用户，含 fallback 到逐条 upsert 的降级逻辑。`importAttributions()` 使用 `userMap` 替代 per-attribution 的 `upsertUser()` 调用。

---

## 2. Phase B 事务逃逸 — ✅ 已修复

**修复**: 为所有被 `PhaseBProcessor._flush()` 调用的 store 方法添加了可选的 `tx?: DbClient` 参数：
- `DatabaseStore.markDeletedByWikidotId(wikidotId, tx?)`
- `DatabaseStore.clearDirtyFlag(wikidotId, phase, tx?)`
- `DatabaseStore.upsertPageContent(data, tx?)`
- `DatabaseStore.markForPhaseC(wikidotId, pageId, reasons, tx?)`
- `PageStore.markPageDeleted(pageId, outerTx?)` — 当有外层事务时跳过内部 `$transaction`
- `PageVersionStore.upsertPageContent(data, outerTx?)` — 所有内部操作使用 `db = outerTx ?? this.prisma`
- `PageVersionStore.createNewVersion(...)` — 同上模式
- `DirtyQueueStore.clearDirtyFlag(wikidotId, phase, tx?)`

`_flush()` 的事务块现在正确传递 `tx` 给所有 store 调用，确保事务原子性。

---

## 3. 主题 TOKEN_TO_VAR 同步问题 — ✅ 已修复

**修复**: `nuxt.config.ts` 中的 inline `TOKEN_TO_VAR` 补齐了缺失的 12 个 token（`navBg`, `navBorder`, `sidebarBg`, `sidebarBorder`, `inputBg`, `inputBorder`, `tagBg`, `tagBorder`, `tagText`, `heroGlow`），与 `useThemeSettings.ts` 中的 30 个 token 保持完全一致。

---

## 4. useGachaDraw handleActivate 重复执行路径 — ✅ 已修复

**修复**: `useGachaDraw.handleActivate()` 简化为直接委托给 `page.handleActivate()`（来自 `useGachaPage`），移除了冗余的 `refreshConfig/getWallet/refreshHistory/refreshTicketsPanel` 调用。数据重载统一由 `useGachaPageLifecycle.onActivate()` → `runLoad('after-activate')` 管理。
