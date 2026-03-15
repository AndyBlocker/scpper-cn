# Unfixed Bugs & Deferred Optimizations

本文档记录了在 2026-03-15 综合代码审查中发现但因风险较高而暂缓修复的问题。

---

## 1. Backend N+1 查询问题

### 1.1 DirtyQueueStore — markDirty 逐条 upsert

**位置**: `backend/src/core/store/DirtyQueueStore.ts`

**问题**: `markDirty(pageIds)` 对每个 pageId 逐一执行 `prisma.dirtyQueue.upsert()`，当 pageIds 数组较大时（如完整同步后的分析阶段），会产生大量独立数据库往返。

**影响**: Phase A/B 完成后标记脏页时性能下降，尤其在完整同步场景下。

**建议修复**: 使用 `prisma.$executeRaw` 配合 `INSERT ... ON CONFLICT DO UPDATE` 批量操作，或使用 `createMany` + `skipDuplicates` 配合后续批量更新。

---

### 1.2 PhaseAProcessor — 逐页 upsert

**位置**: `backend/src/core/processors/PhaseAProcessor.ts`

**问题**: 在处理 GraphQL 返回的页面数据时，对每个页面执行独立的 `prisma.page.upsert()`，未使用批量操作。

**影响**: 完整同步时，数千个页面会产生数千次独立数据库调用。

**建议修复**: 收集一批页面数据后使用 `prisma.$transaction` 批量提交，或使用原生 SQL 的 `INSERT ... ON CONFLICT` 批量 upsert。

---

### 1.3 VoteRevisionStore — 逐条 upsert 投票修订

**位置**: `backend/src/core/store/VoteRevisionStore.ts`

**问题**: `saveRevisions()` 对每条投票修订记录执行独立的 `prisma.voteRevision.upsert()`。

**影响**: 投票数据量大时（单页可能有数百条投票），逐条操作造成显著延迟。

**建议修复**: 使用批量 `INSERT ... ON CONFLICT` 或 Prisma 的 `createMany` + 分离更新逻辑。

---

### 1.4 AttributionService — 逐条 upsert 归属数据

**位置**: `backend/src/core/services/AttributionService.ts`

**问题**: 类似于上述模式，对每条归属记录执行独立的数据库操作。

**影响**: 增量分析时如果涉及大量页面的归属重算，会产生 N+1 查询。

**建议修复**: 批量收集后统一写入。

---

## 2. Phase B 事务逃逸

**位置**: `backend/src/core/processors/PhaseBProcessor.ts` — `_flush()` 方法

**问题**: `_flush()` 在 Prisma interactive transaction 内部调用了多个 store 方法，但部分 store 方法内部使用了独立的 `prisma` 客户端而非传入的事务上下文 `tx`。这意味着事务的原子性被打破 —— 如果事务回滚，通过独立 `prisma` 客户端写入的数据不会被回滚。

**影响**: 在极端情况下（如数据库超时或进程被终止），可能导致部分数据写入而另一部分丢失，产生数据不一致。

**建议修复**:
1. 所有被 `_flush()` 调用的 store 方法需要接受可选的 `tx` 参数
2. 在事务内部传递 `tx` 而非使用模块级 `prisma` 实例
3. 这是一个较大的重构，需要逐步验证每个 store 方法的事务兼容性

---

## 3. 主题 TOKEN_TO_VAR 同步问题

**位置**:
- `frontend/composables/useThemeSettings.ts` — `TOKEN_TO_VAR` 映射表
- `frontend/nuxt.config.ts` — CSS 变量定义

**问题**: `TOKEN_TO_VAR` 定义了 token 名称到 CSS 变量的映射（如 `'primary' → '--color-primary'`），但这个映射需要与 `nuxt.config.ts` 中定义的 CSS 变量以及 `assets/css/` 中的主题样式表保持同步。当前没有自动校验机制，如果新增 CSS 变量但忘记更新 `TOKEN_TO_VAR`，用户自定义主题将无法覆盖该变量。

**影响**: 新增主题 token 时容易遗漏同步，导致部分 CSS 变量无法被用户自定义主题覆盖。

**建议修复**:
1. 将 token 列表提取为单一数据源（如 `themeTokens.ts`）
2. `TOKEN_TO_VAR` 和 CSS 变量定义都从该数据源生成
3. 添加构建时校验脚本，确保 token 列表与实际 CSS 变量一致

---

## 4. useGachaDraw handleActivate 重复执行路径

**位置**: `frontend/composables/useGachaDraw.ts`

**问题**: `handleActivate` 函数在 `useGachaDraw` 和 `useGachaPageLifecycle` 中都可能被调用。当用户在抽卡页面点击激活时，存在两条执行路径：
1. 直接通过 `useGachaDraw` 的 `handleActivate`
2. 通过 `useGachaPageLifecycle` 的 `onActivate` → `handleActivate`

两条路径都会在激活成功后触发数据重新加载，可能导致重复的 API 调用。

**影响**: 激活成功后可能触发两次 `loadInitial`，造成不必要的网络请求和短暂的 UI 闪烁。

**建议修复**:
1. 统一激活入口，确保只通过 `useGachaPageLifecycle.onActivate` 触发
2. 或在 `useGachaDraw` 中移除激活后的自动重载逻辑，交由生命周期管理
