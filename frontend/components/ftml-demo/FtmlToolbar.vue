<template>
  <div class="toolbar">
    <!-- Left group -->
    <div class="toolbar-group flex-1">
      <label class="toolbar-field flex-1 min-w-[160px]">
        <span class="toolbar-label">页面标题</span>
        <input
          type="text"
          :value="pageTitle"
          @input="$emit('update:pageTitle', ($event.target as HTMLInputElement).value)"
          placeholder="例如：SCP-CN-001 示例页面"
          class="toolbar-input"
        />
      </label>
    </div>

    <!-- Right group -->
    <div class="toolbar-group justify-end">
      <label class="toolbar-field">
        <span class="toolbar-label">视图</span>
        <select :value="uiLayout" @change="$emit('update:uiLayout', ($event.target as HTMLSelectElement).value)" class="toolbar-select">
          <option value="both">编辑 + 预览</option>
          <option value="editor-only">仅编辑</option>
          <option value="preview-only">仅预览</option>
        </select>
      </label>

      <label class="toolbar-field">
        <span class="toolbar-label">预览宽度</span>
        <select :value="previewDevice" @change="$emit('update:previewDevice', ($event.target as HTMLSelectElement).value)" class="toolbar-select">
          <option value="desktop">桌面</option>
          <option value="tablet">平板</option>
          <option value="mobile">手机</option>
        </select>
      </label>

    </div>
  </div>
</template>

<script setup lang="ts">
import type { UiLayout, PreviewDevice } from '~/composables/useFtmlDemo'

defineProps<{
  pageTitle: string
  uiLayout: UiLayout
  previewDevice: PreviewDevice
}>()

defineEmits<{
  (e: 'update:pageTitle', value: string): void
  (e: 'update:uiLayout', value: UiLayout): void
  (e: 'update:previewDevice', value: PreviewDevice): void
}>()
</script>

<style scoped>
.toolbar {
  @apply flex flex-wrap items-center gap-3 px-4 py-3;
  @apply bg-neutral-50 dark:bg-neutral-900/50;
  @apply border-b border-neutral-200 dark:border-neutral-800;
}

.toolbar-group {
  @apply flex flex-wrap items-center gap-3;
}

.toolbar-field {
  @apply flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap;
}

.toolbar-label {
  @apply hidden sm:inline;
}

.toolbar-input,
.toolbar-select {
  @apply px-2.5 py-1.5 text-sm rounded-lg;
  @apply bg-white dark:bg-neutral-800;
  @apply border border-neutral-200 dark:border-neutral-700;
  @apply text-neutral-800 dark:text-neutral-200;
  @apply focus:outline-none focus:ring-2 focus:ring-sky-500/30 focus:border-sky-500;
  @apply transition-colors;
}

.toolbar-input {
  @apply min-w-[120px];
}

.toolbar-select {
  @apply min-w-[80px] cursor-pointer;
}
</style>
