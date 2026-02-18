# Gacha 前端重构 — 逐文件变更清单

> 本文档描述 Gacha 前端全面重构中**每一个文件的每一处修改**。
> 所有变更保持功能不变，仅改进代码质量、设计一致性和移动端体验。

---

## 目录

- [Phase 0: 基础设施](#phase-0-基础设施)
- [Phase 1: UI 组件库](#phase-1-ui-组件库)
- [Phase 2: CSS 去重与颜色统一](#phase-2-css-去重与颜色统一)
- [Phase 3: 小型组件迁移](#phase-3-小型组件迁移)
- [Phase 4: 对话框迁移](#phase-4-对话框迁移)
- [Phase 5: 面板表单迁移](#phase-5-面板表单迁移)
- [Phase 6: 拆分过大组件](#phase-6-拆分过大组件)
- [Phase 7: 页面层迁移](#phase-7-页面层迁移)
- [Phase 8: 保护列表组件适配](#phase-8-保护列表组件适配)
- [Phase 9: 移动端优化](#phase-9-移动端优化)
- [Phase 10: 最终清理](#phase-10-最终清理)

---

## Phase 0: 基础设施

### 0-1. `package.json` — 新增依赖

**操作：** npm install 自动修改

```
新增依赖：
  "radix-vue": "^1.x"
  "class-variance-authority": "^0.7.x"
  "clsx": "^2.x"
  "tailwind-merge": "^2.x"
```

**已完成** ✅

---

### 0-2. `frontend/utils/cn.ts` — 新建

**操作：** 新建文件

```ts
import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
```

**用途：** 所有 UI 组件的 class 合并函数，替代手动拼接 Tailwind 类名。`clsx` 处理条件类名，`twMerge` 智能合并冲突的 Tailwind 类（如同时传入 `px-2` 和 `px-4` 时取后者）。

**已完成** ✅

---

### 0-3. `frontend/tailwind.config.js` — 新增动画

**操作：** 在 `theme.extend` 中追加 4 个 keyframe + 4 个 animation

```diff
 animation: {
   'fade-in': 'fadeIn 0.5s ease-in-out',
   'slide-up': 'slideUp 0.3s ease-out',
+  'accordion-down': 'accordionDown 0.2s ease-out',
+  'accordion-up': 'accordionUp 0.2s ease-out',
+  'collapsible-down': 'collapsibleDown 0.2s ease-out',
+  'collapsible-up': 'collapsibleUp 0.2s ease-out',
 },
 keyframes: {
   // ... 保留已有的 fadeIn, slideUp ...
+  accordionDown: { from: { height: '0' }, to: { height: 'var(--radix-accordion-content-height)' } },
+  accordionUp:   { from: { height: 'var(--radix-accordion-content-height)' }, to: { height: '0' } },
+  collapsibleDown: { from: { height: '0' }, to: { height: 'var(--radix-collapsible-content-height)' } },
+  collapsibleUp:   { from: { height: 'var(--radix-collapsible-content-height)' }, to: { height: '0' } },
 }
```

**用途：** Radix Vue 的 Accordion/Collapsible 组件需要这些 CSS 动画变量来驱动展开/收起动画。

**已完成** ✅

---

## Phase 1: UI 组件库

在 `frontend/components/ui/` 下创建 11 个组件族。所有组件基于 Radix Vue 原语构建，样式匹配项目现有的 CSS 变量体系（`rgb(var(--accent-strong))` 等）。

### 1-1. `components/ui/button/Button.vue` + `index.ts` — 新建

**用途：** 替代全项目 37+ 处相同的手写按钮样式

**当前手写模式（散布在 16 个文件中）：**
```html
<!-- 主按钮 —— 出现 25+ 次 -->
<button class="inline-flex items-center justify-center rounded-xl
  bg-[rgb(var(--accent-strong))] px-4 py-2 text-sm font-semibold text-white
  shadow transition hover:bg-[rgb(var(--accent))]
  disabled:cursor-not-allowed disabled:opacity-60">
  ...
</button>

<!-- 次要按钮 —— 出现 37+ 次 -->
<button class="inline-flex items-center justify-center rounded-xl
  border border-neutral-200 px-3 py-2 text-xs font-medium text-neutral-500
  transition hover:border-neutral-300 hover:text-neutral-900
  disabled:cursor-not-allowed disabled:opacity-60
  dark:border-neutral-700 dark:text-neutral-300
  dark:hover:border-neutral-600 dark:hover:text-neutral-100">
  ...
</button>
```

**替代后：**
```html
<UiButton>主按钮</UiButton>
<UiButton variant="outline" size="sm">次要按钮</UiButton>
```

**组件设计（~80 行）：**
- 使用 `class-variance-authority` (cva) 定义 variants
- Variants: `default`（accent-strong 主色）、`outline`（边框按钮）、`ghost`（透明背景）、`destructive`（危险操作，rose 色系）
- Sizes: `sm`（text-xs px-2.5 py-1）、`default`（text-sm px-4 py-2）、`lg`（px-5 py-2.5）
- 内置 `disabled` 样式：`disabled:cursor-not-allowed disabled:opacity-60`
- 支持 `as-child` prop 用于 NuxtLink 等自定义渲染

---

### 1-2. `components/ui/input/Input.vue` + `index.ts` — 新建

**用途：** 替代 20 处相同的手写 input 样式

**当前手写模式：**
```html
<input class="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2
  text-xs text-neutral-700 outline-none transition
  focus:border-[rgb(var(--accent-strong))]
  dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
```

**替代后：**
```html
<UiInput v-model="value" placeholder="搜索..." />
```

**组件设计（~40 行）：**
- 统一 `rounded-xl` 圆角 + focus 时 accent-strong 边框
- v-model 双向绑定支持
- type 属性透传（search、number、text）
- 支持 `class` prop 覆盖

---

### 1-3. `components/ui/badge/Badge.vue` + `index.ts` — 新建

**用途：** 替代稀有度标签（rarityChipClassMap）和状态标签（tradeStatusChipClassMap）

**当前手写模式：**
```html
<span class="inline-flex rounded-full border px-2 py-0.5 text-[10px]
  font-semibold backdrop-blur-sm"
  :class="rarityChipClassMap[rarity]">
  {{ rarityLabel(rarity) }}
</span>
```

**替代后：**
```html
<UiBadge :variant="rarity">{{ rarityLabel(rarity) }}</UiBadge>
```

**组件设计（~50 行）：**
- cva variants 对应 5 个稀有度：`GOLD`、`PURPLE`、`BLUE`、`GREEN`、`WHITE`
- 额外 variants：`success`、`warning`、`danger`、`info`（用于状态标签）
- 统一 `rounded-full` + `text-[10px]` + `font-semibold`

---

### 1-4. `components/ui/dialog/` — 新建（多文件）

**用途：** 替代 5 个对话框组件中的 `Teleport to="body"` + 手写遮罩 + 手写布局

**当前手写模式（所有 5 个对话框都使用这个模式）：**
```html
<Teleport to="body">
  <transition name="fade">
    <div v-if="open" class="fixed inset-0 z-[66] flex items-start justify-center overflow-y-auto px-4 py-8">
      <div class="absolute inset-0 bg-black/65 backdrop-blur-sm" @click="emit('close')" />
      <div class="relative z-[67] w-full max-w-5xl rounded-3xl border border-neutral-200/70
        bg-white/95 p-6 shadow-2xl dark:border-neutral-700/70 dark:bg-neutral-900/95">
        <!-- 内容 -->
      </div>
    </div>
  </transition>
</Teleport>
```

**替代后：**
```html
<UiDialogRoot :open="open" @update:open="v => !v && emit('close')">
  <UiDialogPortal>
    <UiDialogOverlay />
    <UiDialogContent class="max-w-5xl">
      <UiDialogHeader>
        <UiDialogTitle>标题</UiDialogTitle>
      </UiDialogHeader>
      <!-- 内容 -->
      <UiDialogFooter>...</UiDialogFooter>
    </UiDialogContent>
  </UiDialogPortal>
</UiDialogRoot>
```

**文件列表（~160 行总计）：**
| 文件 | 职责 |
|---|---|
| `DialogRoot.vue` | 基于 `DialogRoot` from radix-vue |
| `DialogPortal.vue` | 传送门 |
| `DialogOverlay.vue` | 遮罩层 — `bg-black/65 backdrop-blur-sm` |
| `DialogContent.vue` | 内容面板 — `rounded-3xl border bg-white/95 dark:bg-neutral-900/95` |
| `DialogHeader.vue` | 头部布局 |
| `DialogTitle.vue` | 标题 |
| `DialogDescription.vue` | 描述文本 |
| `DialogFooter.vue` | 底部按钮行 |
| `DialogClose.vue` | 关闭按钮 |
| `index.ts` | 统一导出 |

**优势：**
- 自动处理焦点管理（radix-vue 内置）
- 自动处理 ESC 关键（radix-vue 内置）
- 自动处理遮罩点击关闭
- 自动处理 aria 属性
- 触摸设备友好

---

### 1-5. `components/ui/tabs/` — 新建（多文件）

**用途：** 替代 `index.vue` 中的 workspace-tab-btn 手写 tab 系统

**当前手写模式（index.vue 第 108-142 行）：**
```html
<div class="workspace-tab-list flex flex-wrap items-center gap-2">
  <button v-for="tab in workspaceTabs" :key="tab.key"
    class="workspace-tab-btn inline-flex min-w-[120px]..."
    :class="activeWorkspaceTab === tab.key ? 'workspace-tab-btn--active' : 'workspace-tab-btn--idle'"
    @click="switchWorkspaceTab(tab.key)">
    ...
  </button>
</div>
```

**替代后：**
```html
<UiTabsRoot :model-value="activeWorkspaceTab" @update:model-value="switchWorkspaceTab">
  <UiTabsList>
    <UiTabsTrigger v-for="tab in workspaceTabs" :value="tab.key">
      {{ tab.label }}
    </UiTabsTrigger>
  </UiTabsList>
</UiTabsRoot>
```

**文件列表（~80 行总计）：**
| 文件 | 职责 |
|---|---|
| `TabsRoot.vue` | Tabs 容器 |
| `TabsList.vue` | Tab 按钮列表 |
| `TabsTrigger.vue` | 单个 Tab 按钮 |
| `TabsContent.vue` | Tab 内容面板（可选） |
| `index.ts` | 统一导出 |

---

### 1-6. `components/ui/select/` — 新建（多文件）

**用途：** 替代 11 个手写 `<select>` 元素

**当前手写模式：**
```html
<select class="rounded-xl border border-neutral-200 bg-white px-2 py-1.5
  text-xs outline-none dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
  <option v-for="opt in options" :value="opt.value">{{ opt.label }}</option>
</select>
```

**替代后：**
```html
<UiSelectRoot v-model="selected">
  <UiSelectTrigger placeholder="请选择..." />
  <UiSelectContent>
    <UiSelectItem v-for="opt in options" :value="opt.value">{{ opt.label }}</UiSelectItem>
  </UiSelectContent>
</UiSelectRoot>
```

**文件列表（~120 行总计）：**
| 文件 | 职责 |
|---|---|
| `SelectRoot.vue` | 选择器容器 |
| `SelectTrigger.vue` | 触发按钮 |
| `SelectContent.vue` | 下拉面板 |
| `SelectItem.vue` | 选项 |
| `SelectSeparator.vue` | 分割线 |
| `index.ts` | 统一导出 |

**优势：** 比原生 `<select>` 支持更好的样式定制、键盘导航、搜索过滤。

---

### 1-7. `components/ui/tooltip/` — 新建（多文件）

**用途：** 替代 GachaAffixChip 中的手写 hover tooltip，修复触摸设备上 tooltip 不可见的问题

**当前问题（GachaAffixChip.vue 第 45-100 行 scoped CSS）：**
```css
.gacha-affix-chip__tip {
  display: none;
  position: absolute;
  /* ... */
}
.gacha-affix-chip:hover .gacha-affix-chip__tip {
  display: block;  /* 仅 hover 触发，触摸设备无法显示 */
}
```

**替代后：**
```html
<UiTooltipProvider>
  <UiTooltip>
    <UiTooltipTrigger as-child>
      <span class="affix-chip">...</span>
    </UiTooltipTrigger>
    <UiTooltipContent>提示文本</UiTooltipContent>
  </UiTooltip>
</UiTooltipProvider>
```

**文件列表（~60 行总计）：**
| 文件 | 职责 |
|---|---|
| `TooltipProvider.vue` | Provider（控制延迟等全局设置） |
| `Tooltip.vue` | 单个 Tooltip 容器 |
| `TooltipTrigger.vue` | 触发元素 |
| `TooltipContent.vue` | 提示内容面板 |
| `index.ts` | 统一导出 |

**优势：** Radix Vue Tooltip 自动支持触摸设备（长按显示）和键盘聚焦。

---

### 1-8. `components/ui/progress/Progress.vue` + `index.ts` — 新建

**用途：** 替代多处手写进度条

**当前手写模式（missions.vue / achievement 中）：**
```html
<div class="h-1.5 w-full rounded-full bg-neutral-100 dark:bg-neutral-800">
  <div class="h-full rounded-full bg-emerald-500 transition-all"
    :style="{ width: `${percent}%` }" />
</div>
```

**替代后：**
```html
<UiProgress :model-value="percent" />
```

**组件设计（~30 行）：**
- 基于 radix-vue Progress 原语
- 默认使用 accent-strong 颜色
- 支持 `color` prop 覆盖（emerald/cyan 等用于特殊场景）

---

### 1-9. `components/ui/card/` — 新建（多文件）

**用途：** 替代 `.surface-card` / `.metric-card` 等手写卡片样式

**当前手写模式（散布在多个文件中）：**
```html
<article class="surface-card rounded-3xl border border-neutral-200/70
  bg-white/90 p-6 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
  ...
</article>
```

**替代后：**
```html
<UiCard>
  <UiCardHeader>
    <UiCardTitle>标题</UiCardTitle>
    <UiCardDescription>描述</UiCardDescription>
  </UiCardHeader>
  <UiCardContent>内容</UiCardContent>
  <UiCardFooter>操作</UiCardFooter>
</UiCard>
```

**文件列表（~70 行总计）：**
| 文件 | 职责 |
|---|---|
| `Card.vue` | 卡片容器（surface-card 等效样式） |
| `CardHeader.vue` | 头部 |
| `CardTitle.vue` | 标题 |
| `CardDescription.vue` | 描述 |
| `CardContent.vue` | 内容区 |
| `CardFooter.vue` | 底部 |
| `index.ts` | 统一导出 |

---

### 1-10. `components/ui/checkbox/Checkbox.vue` + `index.ts` — 新建

**用途：** 替代 GachaAlbumDismantleDialog 中的手写 checkbox

**当前手写模式（GachaAlbumDismantleDialog.vue 第 289 行）：**
```html
<input type="checkbox" class="mr-2 accent-[rgb(var(--accent-strong))]" ... >
```

**替代后：**
```html
<UiCheckbox v-model="checked" />
```

**组件设计（~40 行）：** 基于 radix-vue Checkbox，统一选中色为 accent-strong。

---

### 1-11. `components/ui/separator/Separator.vue` + `index.ts` — 新建

**用途：** 替代多处 `border-b border-dashed border-neutral-200/70` 分割线

**替代后：**
```html
<UiSeparator />          <!-- 实线 -->
<UiSeparator dashed />   <!-- 虚线 -->
```

**组件设计（~20 行）：** 基于 radix-vue Separator，支持 `dashed` 和 `orientation` props。

---

## Phase 2: CSS 去重与颜色统一

### 2-1. `pages/gachas/index.vue` — 迁移到 GachaPageShell + 删除全部 scoped CSS

**当前问题：** index.vue 是唯一不使用 GachaPageShell 的 gacha 页面，导致不加载 gacha-shared.css，因此自行定义了 168 行 scoped CSS。

**模板变更：**
```diff
 <template>
-  <div class="gacha-command-page relative mx-auto flex w-full max-w-6xl flex-col gap-8 py-10">
-    <div class="gacha-command-page__bg gacha-command-page__bg--a" />
-    <div class="gacha-command-page__bg gacha-command-page__bg--b" />
-
-    <div v-if="authPending" class="state-panel ...">
-      正在校验登录状态...
-    </div>
-
-    <div v-else-if="showBindingBlock" class="state-panel state-panel--warn ...">
-      <!-- 绑定提示块 -->
-    </div>
-
-    <div v-else class="relative z-[2] flex flex-col gap-8">
+  <GachaPageShell :auth-pending="authPending" :show-binding-block="showBindingBlock" feature-name="抽卡功能">
       <!-- 以下内容全部保持不变 -->
       <GachaRouteHeader ... />
       <section>...</section>
       <!-- ... -->
-    </div>
-    <!-- 弹窗/对话框保持不变 -->
-  </div>
+  </GachaPageShell>
+  <!-- 弹窗/对话框移到 GachaPageShell 外层 -->
 </template>
```

**script 变更：**
```diff
+import GachaPageShell from '~/components/gacha/GachaPageShell.vue'
 // 删除不再需要的 authPending/showBindingBlock 的 v-if 模板代码（已由 GachaPageShell 处理）
```

**style 变更：** 删除第 352-520 行的全部 `<style scoped>` 块（168 行）

删除的类：`.gacha-command-page`, `.gacha-command-page__bg`, `.gacha-command-page__bg--a`, `.gacha-command-page__bg--b`, `.surface-card`, `.surface-card::before`, `html.dark .surface-card::before`, `.state-panel`, `.state-panel::after`, `.snapshot-row`, `html.dark .snapshot-row`, `.snapshot-row strong`, `html.dark .snapshot-row strong`, `.workspace-tab-shell`, `.workspace-tab-list`, `.workspace-tab-btn`, `.workspace-tab-btn--idle`, `.workspace-tab-btn--idle:hover`, `.workspace-tab-btn--active`, `html.dark .workspace-tab-btn--idle`, `html.dark .workspace-tab-btn--idle:hover`, `html.dark .workspace-tab-btn--active`, `.workspace-tab-caption`, `html.dark .workspace-tab-caption`, `.fade-*` 过渡

**这些类全部已在 `gacha-shared.css` 中定义。**

---

### 2-2. `pages/gachas/album.vue` — 删除全部 scoped CSS

**style 变更：** 删除第 222-321 行的全部 `<style scoped>` 块（98 行）

删除的类：`.surface-card`, `.surface-card::before`, `html.dark .surface-card::before`, `.album-grid-shell::after`, `.metric-card`, `html.dark .metric-card`, `.metric-label`, `html.dark .metric-label`, `.metric-value`, `.album-page-card`, `.album-page-card__foil`, `.album-page-card:hover .album-page-card__foil`, `.album-page-card::after`, `html.dark .album-page-card::after`

**这些类全部已在 `gacha-shared.css` 中定义。**

---

### 2-3. `components/gacha/GachaAlbumVariantDialog.vue` — 删除 scoped 重复

**style 变更：** 删除第 280-326 行的 `<style scoped>` 块（46 行）

删除的类：`.variant-card-grid`, `.album-variant-tile`, `.album-variant-tile:hover`, `html.dark .album-variant-tile`

**已在 `gacha-shared.css` 中定义。**

---

### 2-4. `components/gacha/GachaMissionTicketPanel.vue` — 删除 scoped 重复

**style 变更：** 删除第 93-120 行的 `<style scoped>` 块（27 行）

删除的类：`.ticket-row`, `.ticket-row strong`, `html.dark .ticket-row`, `html.dark .ticket-row strong`

**已在 `gacha-shared.css` 中定义。**

---

### 2-5. `components/gacha/GachaControlSnapshot.vue` — 删除 scoped 重复

**style 变更：** 删除第 36-66 行的 `<style scoped>` 块（30 行）

删除的类：`.gacha-snapshot-panel :deep(.snapshot-row)` 及其深色模式变体

**已在 `gacha-shared.css` 中通过全局 `.snapshot-row` 覆盖。**

---

### 2-6. `components/gacha/GachaPlacementPanel.vue` — zinc → neutral

**替换（10 处）：**

| 行号区域 | 替换前 | 替换后 |
|---|---|---|
| ~187 | `border-zinc-200/75 bg-zinc-50/80` | `border-neutral-200/75 bg-neutral-50/80` |
| ~190 | `text-zinc-900 dark:text-zinc-100` | `text-neutral-900 dark:text-neutral-100` |
| ~193 | `border-zinc-200 ... dark:border-zinc-700` | `border-neutral-200 ... dark:border-neutral-700` |
| ~201 | `text-zinc-500 dark:text-zinc-400` | `text-neutral-500 dark:text-neutral-400` |
| ~208 | `border-zinc-300 dark:border-zinc-700` | `border-neutral-300 dark:border-neutral-700` |
| ~212 | `border-zinc-200/80 bg-white/80` | `border-neutral-200/80 bg-white/80` |
| 其余 | 所有 `zinc-*` | 对应的 `neutral-*` |

**视觉影响：** 几乎无 — Tailwind 的 zinc 和 neutral 色值在 200-800 范围内差异极小（< 3% 亮度差）。

---

### 2-7. `components/gacha/GachaAddonPickerDialog.vue` — zinc → neutral

**替换（19 处）：**

| 行号 | 替换前 | 替换后 |
|---|---|---|
| 80 | `border-zinc-200/70 ... dark:border-zinc-700/70 dark:bg-zinc-900/95` | `border-neutral-200/70 ... dark:border-neutral-700/70 dark:bg-neutral-900/95` |
| 82 | `border-zinc-200/60 dark:border-zinc-800/60` | `border-neutral-200/60 dark:border-neutral-800/60` |
| 110 | `border-zinc-200/60 dark:border-zinc-800/60` | `border-neutral-200/60 dark:border-neutral-800/60` |
| 116 | `border-zinc-200 ... dark:border-zinc-700 ... dark:bg-zinc-800` | `border-neutral-200 ... dark:border-neutral-700 ... dark:bg-neutral-800` |
| 122 | `border-zinc-300/70 ... dark:border-zinc-700/70` | `border-neutral-300/70 ... dark:border-neutral-700/70` |
| 131 | `border-zinc-200/70 ... dark:border-zinc-800/70 ... dark:bg-zinc-900/60` | `border-neutral-200/70 ... dark:border-neutral-800/70 ... dark:bg-neutral-900/60` |
| 137 | `dark:border-zinc-800/70 dark:bg-zinc-900/80` | `dark:border-neutral-800/70 dark:bg-neutral-900/80` |
| 153 | `text-zinc-700 ... dark:text-zinc-100` | `text-neutral-700 ... dark:text-neutral-100` |
| 165-169 | 所有 `zinc-*` | 对应的 `neutral-*` |

---

### 2-8. `gacha-shared.css` — 确认完整性

**操作：** 审查此文件是否已包含所有从 scoped 块中删除的类。

**需要确认的类：**
- ✅ `.gacha-page`, `.gacha-page__bg` — 已定义
- ✅ `.surface-card`, `::before` — 已定义
- ✅ `.snapshot-row` — 已定义
- ✅ `.metric-card`, `.metric-label`, `.metric-value` — 已定义
- ✅ `.workspace-tab-btn`, `--idle`, `--active` — 已定义
- ✅ `.workspace-tab-caption` — 已定义
- ✅ `.album-page-card`, `__foil` — 已定义
- ✅ `.variant-card-grid`, `.album-variant-tile` — 已定义
- ✅ `.ticket-row` — 已定义
- ⚠️ `.state-panel` — 需确认是否已定义（index.vue 的加载/绑定状态面板）
- ⚠️ `.fade-enter-active` 过渡 — 可能需要添加到 gacha-shared.css

**可能需要在 gacha-shared.css 中补充的样式：**
```css
/* 如果缺失，需要从 index.vue scoped 块中移入 */
.state-panel { position: relative; overflow: hidden; }
.state-panel::after { /* ... */ }
.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
```

---

### 2-9. 组件内样式映射去重

以下组件中删除本地定义的常量映射表，改为从 `gachaConstants.ts` 导入：

#### GachaDrawPanel.vue

**删除本地定义（~25 行）：**
```diff
-const poolBadgeClassMap = { ... }
-const poolCardClassMap = { ... }
-const poolTextClassMap = { ... }
-const poolPriorityMap = { ... }
-const poolStatusLabelMap = { ... }
+import { poolBadgeClassMap, poolCardClassMap, poolTextClassMap, poolPriorityMap, poolStatusLabelMap } from '~/utils/gachaConstants'
```

**需要确认：** gachaConstants.ts 中的映射值是否与组件内定义完全一致。如有差异，以组件内的值为准，更新 gachaConstants.ts。

#### GachaTradePanel.vue

**删除本地定义（~18 行）：**
```diff
-const tradeStatusLabelMap = { ... }
-const tradeStatusChipClassMap = { ... }
-const tradeSortLabelMap = { ... }
+import { tradeStatusLabelMap, tradeStatusChipClassMap, tradeSortLabelMap } from '~/utils/gachaConstants'
```

#### GachaMarketPanel.vue

**删除本地定义（~12 行）：**
```diff
-const fallbackTierMeta = { ... }
+import { fallbackMarketLockTierMeta as fallbackTierMeta } from '~/utils/gachaConstants'
```

#### GachaPlacementPanel.vue

**删除本地定义：**
```diff
-const placementSlotCardClassMap = { ... }
+import { placementSlotCardClassMap } from '~/utils/gachaConstants'
```

---

## Phase 3: 小型组件迁移

### 3-1. `GachaErrorBanner.vue` (29 → ~25 行)

**当前代码核心：**
```html
<div v-if="error" class="rounded-2xl border border-rose-200/70 bg-rose-50/70 px-4 py-3 text-sm text-rose-600 ...">
  {{ error }}
</div>
```

**变更：** 无实质改变。此组件足够简单，保持原样即可。保留不改。

---

### 3-2. `GachaRarityBadge.vue` (29 → ~20 行)

**变更：**
```diff
-<span class="inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold backdrop-blur-sm"
-  :class="rarityChipClassMap[props.rarity]">
+<UiBadge :variant="props.rarity">
   <span v-if="showDot" class="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current" />
   {{ rarityLabel(props.rarity) }}
-</span>
+</UiBadge>
```

**import 变更：**
```diff
+import { UiBadge } from '~/components/ui/badge'
-import { rarityChipClassMap } from '~/utils/gachaRarity'
```

---

### 3-3. `GachaActivationBlock.vue` (39 → ~35 行)

**变更 — 按钮替换（第 27-35 行）：**
```diff
-<button type="button"
-  class="inline-flex items-center justify-center rounded-xl bg-[rgb(var(--accent-strong))] px-4 py-2
-    text-sm font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))]
-    disabled:cursor-not-allowed disabled:opacity-60"
-  :disabled="activating"
-  @click="emit('activate')">
+<UiButton :disabled="activating" @click="emit('activate')">
   <span v-if="activating">激活中...</span>
   <span v-else>立即激活</span>
-</button>
+</UiButton>
```

---

### 3-4. `GachaBindingBlock.vue` (48 → ~42 行)

**变更 — 两个 NuxtLink 按钮替换（第 34-45 行）：**
```diff
-<NuxtLink to="/admin"
-  class="inline-flex items-center justify-center rounded-xl bg-[rgb(var(--accent-strong))] px-4 py-2
-    text-sm font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))]">
+<UiButton as-child>
+  <NuxtLink to="/admin">
     前往管理页
-</NuxtLink>
-<NuxtLink to="/tools"
-  class="inline-flex items-center justify-center rounded-xl border border-neutral-200 px-4 py-2
-    text-sm font-medium text-neutral-600 ...">
+  </NuxtLink>
+</UiButton>
+<UiButton variant="outline" as-child>
+  <NuxtLink to="/tools">
     返回工具页
-</NuxtLink>
+  </NuxtLink>
+</UiButton>
```

---

### 3-5. `GachaControlSnapshot.vue` (66 → ~45 行)

**变更：**
1. 删除全部 `<style scoped>` 块（30 行）— 在 Phase 2 已完成
2. 外层容器可选替换为 `<UiCard>`

```diff
-<article class="overview-panel rounded-[26px] border border-white/45 bg-white/80 p-5
-  shadow-[...] backdrop-blur-xl dark:border-neutral-700/65 dark:bg-neutral-950/62">
+<UiCard class="backdrop-blur-xl">
   <header>...</header>
   <div class="mt-4 grid gap-2">
     <slot name="rows" />
   </div>
   <slot name="footer" />
-</article>
+</UiCard>
```

---

### 3-6. `GachaAffixChip.vue` (100 → ~50 行)

**变更：**
1. 将手写 hover tooltip 替换为 `<UiTooltip>`
2. 删除 55 行 scoped CSS（`.gacha-affix-chip__tip` 相关）

```diff
-<span class="gacha-affix-chip" :class="chipClasses">
-  <span class="gacha-affix-chip__label">{{ displayLabel }}</span>
-  <span v-if="tooltip" class="gacha-affix-chip__tip">{{ tooltip }}</span>
-</span>
+<UiTooltipProvider :delay-duration="200">
+  <UiTooltip>
+    <UiTooltipTrigger as-child>
+      <span class="gacha-affix-chip" :class="chipClasses">
+        <span>{{ displayLabel }}</span>
+      </span>
+    </UiTooltipTrigger>
+    <UiTooltipContent v-if="tooltip">{{ tooltip }}</UiTooltipContent>
+  </UiTooltip>
+</UiTooltipProvider>
```

**删除的 scoped CSS：** `.gacha-affix-chip__tip` 及相关的 hover/position/transform/dark 样式
**保留的 scoped CSS：** `.gacha-affix-chip` 基础样式（背景色、边框、圆角）

---

### 3-7. 合并 `GachaMissionListPanel.vue` + `GachaAchievementListPanel.vue` → `GachaGoalListPanel.vue`

**新建 `GachaGoalListPanel.vue` (~120 行)**

**两个组件的差异分析：**

| 维度 | MissionListPanel | AchievementListPanel |
|---|---|---|
| 标题 | "每日任务列表" | "成就里程碑" |
| 空状态文字 | "暂无可显示任务" | "暂无成就数据" |
| 领取按钮颜色 | emerald | cyan |
| 进度条颜色 | emerald-500 | cyan-500 |
| viewMode 切换 | 有（每日/全部） | 无 |
| "全部领取" 按钮 | 有 | 有 |
| items 结构 | 相同 | 相同 |

**新组件 Props：**
```ts
defineProps<{
  items: GoalItem[]
  loading: boolean
  claiming: boolean
  claimableCount: number
  kind: 'mission' | 'achievement'
  viewMode?: 'daily' | 'all'
}>()
```

**被删除的文件：**
- `components/gacha/GachaMissionListPanel.vue` (108 行)
- `components/gacha/GachaAchievementListPanel.vue` (84 行)

**受影响的文件：**
- `pages/gachas/missions.vue` — 更新 import 路径，将两个组件引用改为一个 `<GachaGoalListPanel>`

---

## Phase 4: 对话框迁移

**通用变更模式** — 适用于以下全部 5 个对话框：

```diff
-<Teleport to="body">
-  <transition name="fade">
-    <div v-if="open" class="fixed inset-0 z-[66] flex items-start justify-center overflow-y-auto px-4 py-8">
-      <div class="absolute inset-0 bg-black/65 backdrop-blur-sm" @click="emit('close')" />
-      <div class="relative z-[67] w-full max-w-Xpx rounded-3xl border ...">
-        <!-- 头部 + 关闭按钮 -->
-        <!-- 内容 -->
-      </div>
-    </div>
-  </transition>
-</Teleport>

+<UiDialogRoot :open="open" @update:open="v => !v && emit('close')">
+  <UiDialogPortal>
+    <UiDialogOverlay />
+    <UiDialogContent class="max-w-Xpx">
+      <UiDialogHeader>
+        <UiDialogTitle>标题</UiDialogTitle>
+      </UiDialogHeader>
+      <!-- 内容（保持不变） -->
+      <UiDialogFooter>
+        <!-- 操作按钮 -->
+      </UiDialogFooter>
+    </UiDialogContent>
+  </UiDialogPortal>
+</UiDialogRoot>
```

**额外变更：** 每个对话框中的手写 `<button>` 和 `<input>` 也将替换为 `<UiButton>` 和 `<UiInput>`。

---

### 4-1. `GachaAlbumVariantDismantleDialog.vue` (102 → ~75 行)

**模板变更：**
- 删除 Teleport + transition + 手写遮罩（第 32-40 行，第 97-102 行）
- 替换为 UiDialog 系列组件
- 关闭按钮（第 44-50 行）→ `<UiDialogClose>`
- 数量输入（第 61-67 行）→ `<UiInput type="number">`
- 取消按钮（第 81-86 行）→ `<UiButton variant="outline">`
- 确认按钮（第 88-96 行）→ `<UiButton variant="destructive">`

---

### 4-2. `GachaAddonPickerDialog.vue` (181 → ~140 行)

**模板变更：**
- Teleport + 遮罩（第 69-78 行）→ UiDialog
- 关闭/清空按钮 → `<UiButton>`
- 搜索框（第 111-117 行）→ `<UiInput type="search">`
- zinc → neutral 已在 Phase 2 完成

---

### 4-3. `GachaPlacementPickerDialog.vue` (238 → ~190 行)

**模板变更：**
- Teleport + 遮罩 → UiDialog
- 搜索框（第 127-133 行）→ `<UiInput type="search">`
- 稀有度筛选按钮组（第 135-146 行）→ 使用 `<UiBadge>` 或保持手写 pill buttons
- 清空/关闭按钮 → `<UiButton>`

---

### 4-4. `GachaAlbumVariantDialog.vue` (325 → ~265 行)

**模板变更：**
- Teleport + 遮罩 → UiDialog
- 搜索框（第 162-168 行）→ `<UiInput>`
- 排序下拉（第 169-176 行）→ `<UiSelect>`
- 稀有度筛选按钮组（第 185-196 行）→ pill toggle
- 分解按钮（第 252-259 行）→ `<UiButton variant="destructive" size="sm">`
- 删除 scoped CSS（第 280-326 行）— 在 Phase 2 已完成

---

### 4-5. `GachaAlbumDismantleDialog.vue` (355 → ~290 行)

**模板变更：**
- Teleport + 遮罩 → UiDialog
- 4 个输入框（第 193-205 行）→ `<UiInput>`
- 手写 checkbox（第 289-293 行）→ `<UiCheckbox>`
- 全部操作按钮 → `<UiButton>`
- 稀有度/词条筛选按钮组 → pill toggle

---

## Phase 5: 面板表单迁移

### 5-1. `GachaHistoryPanel.vue` (67 → ~55 行)

**变更：**
- 刷新按钮（第 27-33 行）→ `<UiButton variant="outline" size="sm">`

---

### 5-2. `GachaMissionTicketPanel.vue` (121 → ~100 行)

**变更：**
- 3 个操作按钮（第 50-85 行）→ `<UiButton>`
- 卡片ID输入框（第 70-76 行）→ `<UiInput>`
- 删除 scoped CSS（在 Phase 2 已完成）

---

### 5-3. `GachaDrawPanel.vue` (231 → ~200 行)

**变更：**
- 抽卡按钮（第 166-190 行）→ `<UiButton>`
- 删除本地样式映射（在 Phase 2-9 已完成）

---

### 5-4. `GachaPlacementPanel.vue` (385 → ~320 行)

**变更：**
- 刷新/解锁/领取按钮 → `<UiButton>`
- 选择/清空按钮 → `<UiButton variant="outline" size="sm">`
- zinc→neutral 已在 Phase 2 完成
- 删除本地映射（Phase 2-9）

---

### 5-5. `GachaMarketPanel.vue` (486 → ~400 行)

**变更：**
- 刷新按钮（第 190 行）→ `<UiButton variant="outline" size="sm">`
- 合约选择器按钮（第 221 行）→ 保持自定义样式（复杂交互）
- 时间框架按钮组（第 253 行）→ 可选使用 `<UiTabs>` 样式
- 做多/做空按钮（第 364-383 行）→ `<UiButton>` with custom color
- 锁仓 select（第 388 行）→ `<UiSelect>`
- 保证金 input（第 397 行）→ `<UiInput type="number">`
- 杠杆 select（第 401 行）→ `<UiSelect>`
- 开仓按钮（第 420 行）→ `<UiButton>`
- 删除本地映射（Phase 2-9）

---

### 5-6. `GachaTradePanel.vue` (549 → ~440 行)

**变更：**
- 刷新按钮（第 213 行）→ `<UiButton variant="outline" size="sm">`
- 卡片选择 select（第 240 行）→ `<UiSelect>`
- 数量/单价/有效期 input（第 278-286 行）→ `<UiInput type="number">`
- 快捷有效期按钮（第 297 行）→ `<UiButton variant="ghost" size="sm">`
- 确认上架按钮（第 302 行）→ `<UiButton>`
- 撤销按钮（第 370 行）→ `<UiButton variant="destructive" size="sm">`
- 搜索框（第 395 行）→ `<UiInput type="search">`
- 搜索模式 select（第 401 行）→ `<UiSelect>`
- 排序模式 select（第 409 行）→ `<UiSelect>`
- 重置筛选按钮（第 419 行）→ `<UiButton variant="ghost" size="sm">`
- 买入按钮（第 520 行）→ `<UiButton size="sm">`
- 加载更多按钮（第 538 行）→ `<UiButton variant="outline">`
- 删除本地映射（Phase 2-9）

---

### 5-7. 新建 `GachaRarityFilter.vue` (~45 行)

**用途：** 提取稀有度 pill 筛选器，在 album（第 64-77 行）、trade（第 430-442 行）、variant dialog（第 185-196 行）、dismantle dialog（第 213-224 行）中共用

**当前重复模式（出现 4 次）：**
```html
<button v-for="option in filterOptions" :key="option"
  class="inline-flex items-center rounded-full border px-2.5 py-1 font-semibold transition"
  :class="currentFilter === option
    ? 'border-[rgb(var(--accent-strong))]/45 bg-[rgb(var(--accent-strong))]/10 text-[rgb(var(--accent-strong))]'
    : 'border-neutral-200 bg-white text-neutral-500 ... dark:...'"
  @click="emit('update', option)">
  {{ option === 'ALL' ? '全部' : rarityLabel(option) }}
</button>
```

**新组件：**
```html
<GachaRarityFilter :model-value="currentFilter" :options="filterOptions"
  @update:model-value="val => currentFilter = val" />
```

---

## Phase 6: 拆分过大组件

### 6-1. `GachaTradePanel.vue` (549 行) → 4 个文件

**新建文件：**

| 文件 | 内容来源 | 预估行数 |
|---|---|---|
| `GachaTradeCreateForm.vue` | 原第 225-315 行（发布挂牌表单区） | ~120 |
| `GachaTradeMyListings.vue` | 原第 316-385 行（我的挂牌列表） | ~100 |
| `GachaTradePublicBoard.vue` | 原第 386-548 行（公共挂牌列表+筛选+加载更多） | ~200 |

**修改文件：**
| 文件 | 变更 |
|---|---|
| `GachaTradePanel.vue` | 改为容器 shell（~80 行），引入 3 个子组件，透传 props/emits |

**Props/Events 透传设计：**
- TradePanel 接收所有 props（不变）
- TradePanel 将相关 props 传给子组件
- 子组件的 emit 事件冒泡到 TradePanel 再传出

---

### 6-2. `GachaMarketPanel.vue` (486 行) → 6 个文件

**新建文件：**

| 文件 | 内容来源 | 预估行数 |
|---|---|---|
| `GachaMarketContractBar.vue` | 原第 215-245 行（合约选择器网格） | ~50 |
| `GachaMarketPriceCard.vue` | 原第 246-290 行（价格面板+K线图） | ~100 |
| `GachaMarketDepthCard.vue` | 原第 291-352 行（多空深度面板） | ~70 |
| `GachaMarketOpenForm.vue` | 原第 353-430 行（开仓控制台） | ~80 |
| `GachaMarketPositionList.vue` | 原第 431-486 行（持仓+结算列表） | ~80 |

**修改文件：**
| 文件 | 变更 |
|---|---|
| `GachaMarketPanel.vue` | 改为容器 shell（~80 行） |

---

### 6-3. `GachaPlacementPanel.vue` (385 行) → 4 个文件

**新建文件：**

| 文件 | 内容来源 | 预估行数 |
|---|---|---|
| `GachaPlacementHero.vue` | 原第 ~75-170 行（KPI 面板+组合加成） | ~80 |
| `GachaPlacementSlotCard.vue` | 原第 ~280-380 行（单个槽位卡片） | ~100 |
| `GachaPlacementColorlessSlot.vue` | 原第 ~180-225 行（无色词条槽） | ~65 |

**修改文件：**
| 文件 | 变更 |
|---|---|
| `GachaPlacementPanel.vue` | 改为容器 shell（~80 行） |

---

## Phase 7: 页面层迁移

### 7-1. `pages/gachas/index.vue` — workspace tabs 迁移

**变更（在 Phase 2 已迁移到 GachaPageShell 之后）：**

workspace tabs 区域（第 108-142 行）替换为 `<UiTabs>`：

```diff
-<section class="surface-card rounded-3xl ...">
-  <div class="workspace-tab-shell flex flex-col gap-3">
-    <div class="workspace-tab-list flex flex-wrap items-center gap-2">
-      <button v-for="tab in workspaceTabs" :key="tab.key"
-        class="workspace-tab-btn ..."
-        :class="activeWorkspaceTab === tab.key ? 'workspace-tab-btn--active' : 'workspace-tab-btn--idle'"
-        @click="switchWorkspaceTab(tab.key)">
-        <span>{{ tab.label }}</span>
-        <span v-if="tab.badge" class="...">{{ tab.badge }}</span>
-      </button>
-    </div>
-    <p class="workspace-tab-caption ...">当前分区：...</p>
-  </div>
-</section>

+<UiCard>
+  <UiTabsRoot :model-value="activeWorkspaceTab" @update:model-value="switchWorkspaceTab">
+    <UiTabsList class="flex flex-wrap gap-2">
+      <UiTabsTrigger v-for="tab in workspaceTabs" :key="tab.key" :value="tab.key">
+        <span>{{ tab.label }}</span>
+        <span v-if="tab.badge">{{ tab.badge }}</span>
+      </UiTabsTrigger>
+    </UiTabsList>
+  </UiTabsRoot>
+  <UiSeparator dashed class="my-2" />
+  <p class="text-xs text-neutral-500 ...">当前分区：...</p>
+</UiCard>
```

**其他变更：**
- 错误横幅保持 `<GachaErrorBanner>`（不变）
- 激活块保持 `<GachaActivationBlock>`（Phase 3 已迁移）
- 所有面板组件引用不变（面板自身已在 Phase 5-6 中迁移）

---

### 7-2. `pages/gachas/album.vue` — 表单元素迁移

**变更：**
- 搜索输入框（第 41-45 行）→ `<UiInput type="search">`
- 批量分解按钮（第 47-53 行）→ `<UiButton variant="outline">`
- 刷新按钮（第 54-61 行）→ `<UiButton variant="outline" size="sm">`
- scoped CSS 已在 Phase 2 删除

---

### 7-3. `pages/gachas/progress.vue` — 进度条迁移

**变更：**
- 手写进度条 → `<UiProgress :model-value="percent">`
- 按钮 → `<UiButton>`

---

### 7-4. `pages/gachas/missions.vue` — 组件引用更新

**变更：**
```diff
-import GachaMissionListPanel from '~/components/gacha/GachaMissionListPanel.vue'
-import GachaAchievementListPanel from '~/components/gacha/GachaAchievementListPanel.vue'
+import GachaGoalListPanel from '~/components/gacha/GachaGoalListPanel.vue'
```

模板中：
```diff
-<GachaMissionListPanel ... />
-<GachaAchievementListPanel ... />
+<GachaGoalListPanel kind="mission" ... />
+<GachaGoalListPanel kind="achievement" ... />
```

---

## Phase 8: 保护列表组件适配

### 8-1. `GachaCard.vue` (426 行) — 最小改动

**变更：** 仅将内部稀有度标签替换为 `<UiBadge>`（如果模板中有的话）。

**不动的部分：** 全部 scoped CSS（foil 动画、noise 纹理、scanline 效果）、模板主结构、插槽设计。

---

### 8-2. `GachaDrawResultModal.vue` (570 行) — Dialog 容器替换

**变更：**
- 外层 `Teleport` + 手写遮罩 → `<UiDialog>`
- 内部稀有度筛选按钮组 → 保持或使用 `<GachaRarityFilter>`
- 前往图鉴/再来十连按钮 → `<UiButton>`

**不动的部分：** 全部抽卡结果展示逻辑、动画效果、rarity 分布条、scoped CSS。

---

### 8-3. `GachaRouteHeader.vue` (254 行) — 按钮替换

**变更：**
- 导航 NuxtLink 按钮 → `<UiButton variant="outline" as-child><NuxtLink>...</NuxtLink></UiButton>`

**不动的部分：** 全部 scoped CSS（浮动动画、gradient glow）、指标面板。

---

### 8-4. `TokenBalance.vue` (288 行) — 按钮替换

**变更：**
- 领取签到按钮（第 42-52 行）→ `<UiButton>`
- 刷新余额按钮（第 53-62 行）→ `<UiButton variant="outline" size="sm">`

**不动的部分：** 全部 scoped CSS、余额显示逻辑。

---

### 8-5. `MarketCandlestickChart.vue` (423 行) — 完全不动

无任何变更。

---

## Phase 9: 移动端优化

### 9-1. Workspace Tabs 水平滚动

**文件：** `components/ui/tabs/TabsList.vue` 或 `pages/gachas/index.vue`

**变更：** 在小屏幕上 tabs 列表改为水平滚动：
```html
<div class="flex overflow-x-auto sm:flex-wrap sm:overflow-visible">
  <!-- tabs -->
</div>
```

---

### 9-2. Dialog 移动端高度

**文件：** `components/ui/dialog/DialogContent.vue`

**变更：** 设置移动端最大高度和内容滚动：
```css
max-height: calc(100vh - 2rem);
overflow-y: auto;
```

---

### 9-3. GachaTradePublicBoard 移动端布局

**文件：** `components/gacha/GachaTradePublicBoard.vue`（Phase 6 新建）

**变更：** 搜索/排序行在移动端堆叠：
```html
<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
  <!-- 搜索 + 排序控件 -->
</div>
```

---

### 9-4. GachaMarketPanel 侧边栏堆叠

**文件：** `components/gacha/GachaMarketPanel.vue`（Phase 6 改为 shell）

**变更：** 开仓控制台在移动端堆叠到底部：
```html
<div class="flex flex-col gap-4 xl:grid xl:grid-cols-[minmax(0,1fr),320px]">
  <!-- 图表区 -->
  <!-- 侧边栏（移动端在下方） -->
</div>
```

---

## Phase 10: 最终清理

### 10-1. `gacha-shared.css` 清理

**变更：** 删除被 shadcn-vue 组件完全替代的样式类（如果有的话）。具体删除列表在实施时确定。

### 10-2. `gachaConstants.ts` 检查

**变更：** 确认所有映射表都被正确引用，删除确认无引用的过时映射。

### 10-3. 删除的文件汇总

| 文件 | 原因 |
|---|---|
| `components/gacha/GachaMissionListPanel.vue` | 被 GachaGoalListPanel 替代 |
| `components/gacha/GachaAchievementListPanel.vue` | 被 GachaGoalListPanel 替代 |

### 10-4. 新建的文件汇总

| 文件 | 类型 |
|---|---|
| `utils/cn.ts` | 工具函数 |
| `components/ui/button/Button.vue` + `index.ts` | UI 组件 |
| `components/ui/input/Input.vue` + `index.ts` | UI 组件 |
| `components/ui/badge/Badge.vue` + `index.ts` | UI 组件 |
| `components/ui/dialog/Dialog*.vue` + `index.ts` | UI 组件（~9 文件） |
| `components/ui/tabs/Tabs*.vue` + `index.ts` | UI 组件（~5 文件） |
| `components/ui/select/Select*.vue` + `index.ts` | UI 组件（~5 文件） |
| `components/ui/tooltip/Tooltip*.vue` + `index.ts` | UI 组件（~5 文件） |
| `components/ui/progress/Progress.vue` + `index.ts` | UI 组件 |
| `components/ui/card/Card*.vue` + `index.ts` | UI 组件（~7 文件） |
| `components/ui/checkbox/Checkbox.vue` + `index.ts` | UI 组件 |
| `components/ui/separator/Separator.vue` + `index.ts` | UI 组件 |
| `components/gacha/GachaGoalListPanel.vue` | Gacha 组件 |
| `components/gacha/GachaRarityFilter.vue` | Gacha 共享组件 |
| `components/gacha/GachaTradeCreateForm.vue` | 拆分子组件 |
| `components/gacha/GachaTradeMyListings.vue` | 拆分子组件 |
| `components/gacha/GachaTradePublicBoard.vue` | 拆分子组件 |
| `components/gacha/GachaMarketContractBar.vue` | 拆分子组件 |
| `components/gacha/GachaMarketPriceCard.vue` | 拆分子组件 |
| `components/gacha/GachaMarketDepthCard.vue` | 拆分子组件 |
| `components/gacha/GachaMarketOpenForm.vue` | 拆分子组件 |
| `components/gacha/GachaMarketPositionList.vue` | 拆分子组件 |
| `components/gacha/GachaPlacementHero.vue` | 拆分子组件 |
| `components/gacha/GachaPlacementSlotCard.vue` | 拆分子组件 |
| `components/gacha/GachaPlacementColorlessSlot.vue` | 拆分子组件 |

### 10-5. 修改的文件汇总（非新建）

| 文件 | 主要变更 |
|---|---|
| `tailwind.config.js` | +20 行动画 |
| `package.json` | +4 依赖 |
| `gacha-shared.css` | 可能补充 state-panel/fade 过渡 |
| `gachaConstants.ts` | 确认/同步映射值 |
| `pages/gachas/index.vue` | 迁移 GachaPageShell + 删除 168 行 CSS + UiTabs |
| `pages/gachas/album.vue` | 删除 98 行 CSS + UiInput/UiButton |
| `pages/gachas/progress.vue` | UiProgress + UiButton |
| `pages/gachas/missions.vue` | 组件引用更新 |
| `GachaActivationBlock.vue` | button → UiButton |
| `GachaBindingBlock.vue` | NuxtLink → UiButton as-child |
| `GachaControlSnapshot.vue` | 删除 30 行 CSS + UiCard |
| `GachaAffixChip.vue` | hover tooltip → UiTooltip + 删除 55 行 CSS |
| `GachaErrorBanner.vue` | 保持不变 |
| `GachaRarityBadge.vue` | → UiBadge |
| `GachaHistoryPanel.vue` | button → UiButton |
| `GachaMissionTicketPanel.vue` | 删除 27 行 CSS + UiButton/UiInput |
| `GachaDrawPanel.vue` | 删除映射 + UiButton |
| `GachaPlacementPanel.vue` | zinc→neutral + 删除映射 + UiButton + 拆分 |
| `GachaMarketPanel.vue` | 删除映射 + UiButton/UiSelect/UiInput + 拆分 |
| `GachaTradePanel.vue` | 删除映射 + UiButton/UiSelect/UiInput + 拆分 |
| `GachaPlacementPickerDialog.vue` | Teleport → UiDialog + UiInput/UiButton |
| `GachaAddonPickerDialog.vue` | zinc→neutral + Teleport → UiDialog + UiInput/UiButton |
| `GachaAlbumVariantDialog.vue` | 删除 46 行 CSS + Teleport → UiDialog + UiInput/UiSelect/UiButton |
| `GachaAlbumVariantDismantleDialog.vue` | Teleport → UiDialog + UiInput/UiButton |
| `GachaAlbumDismantleDialog.vue` | Teleport → UiDialog + UiInput/UiCheckbox/UiButton |
| `GachaCard.vue` | badge → UiBadge（最小改动） |
| `GachaDrawResultModal.vue` | Teleport → UiDialog + UiButton（保持动画） |
| `GachaRouteHeader.vue` | NuxtLink → UiButton（保持动画） |
| `TokenBalance.vue` | button → UiButton |

### 10-6. 构建验证

```bash
cd frontend
npm run lint
npm run typecheck
npx nuxi build
pm2 restart scpper-nuxt
```
