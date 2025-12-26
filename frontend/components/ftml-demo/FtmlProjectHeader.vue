<template>
  <header class="app-header">
    <div class="header-left">
      <button type="button" class="icon-btn" @click="$emit('back')" title="返回项目列表">←</button>
      <input
        type="text"
        :value="title"
        @input="$emit('update:title', ($event.target as HTMLInputElement).value)"
        @blur="$emit('update:title', ($event.target as HTMLInputElement).value.trim() || '未命名')"
        class="title-input"
        placeholder="标题"
      />
      <span v-if="hasUnsaved" class="unsaved-dot" title="未保存">●</span>
    </div>

    <div class="header-center">
      <select :value="uiLayout" @change="$emit('update:uiLayout', ($event.target as HTMLSelectElement).value)" class="mini-select" title="视图">
        <option value="both">双栏</option>
        <option value="editor-only">编辑</option>
        <option value="preview-only">预览</option>
      </select>
      <select :value="previewDevice" @change="$emit('update:previewDevice', ($event.target as HTMLSelectElement).value)" class="mini-select" title="预览宽度">
        <option value="desktop">桌面</option>
        <option value="tablet">平板</option>
        <option value="mobile">手机</option>
      </select>
    </div>

    <div class="header-right">
      <span class="status-dot" :data-status="workerStatus" :title="statusText" />

      <label class="auto-toggle" title="自动渲染">
        <input type="checkbox" :checked="autoRender" @change="$emit('update:autoRender', ($event.target as HTMLInputElement).checked)" />
        <span>自动</span>
      </label>

      <button type="button" class="icon-btn" @click="$emit('toggleTheme')" :title="theme === 'dark' ? '切换到浅色' : '切换到深色'">
        {{ theme === 'dark' ? '☀' : '☾' }}
      </button>

      <button type="button" class="btn" @click="$emit('save')" :disabled="isSaving">
        {{ isSaving ? '...' : '保存' }}
      </button>

      <button type="button" class="btn btn-primary" @click="$emit('render')" :disabled="!canRender">
        {{ isRendering ? '...' : '渲染' }}
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { WorkerStatus, UiLayout, PreviewDevice } from '~/composables/useFtmlDemo'

const props = defineProps<{
  title: string
  isSaving: boolean
  hasUnsaved: boolean
  workerStatus: WorkerStatus
  workerVersion: string | null
  autoRender: boolean
  isRendering: boolean
  canRender: boolean
  uiLayout: UiLayout
  previewDevice: PreviewDevice
  theme: 'light' | 'dark'
}>()

defineEmits<{
  (e: 'update:title', value: string): void
  (e: 'update:autoRender', value: boolean): void
  (e: 'update:uiLayout', value: UiLayout): void
  (e: 'update:previewDevice', value: PreviewDevice): void
  (e: 'save'): void
  (e: 'render'): void
  (e: 'back'): void
  (e: 'toggleTheme'): void
}>()

const statusText = computed(() => {
  const v = props.workerVersion ? ` v${props.workerVersion}` : ''
  switch (props.workerStatus) {
    case 'idle': return '初始化' + v
    case 'initializing': return '启动中' + v
    case 'ready': return '就绪' + v
    case 'busy': return '渲染中' + v
    case 'error': return '错误' + v
    default: return '未知' + v
  }
})
</script>

<style scoped>
.app-header {
  @apply h-9 flex items-center justify-between px-2 gap-3;
  @apply bg-neutral-50 dark:bg-neutral-900;
  @apply border-b border-neutral-200 dark:border-neutral-800;
}

.header-left {
  @apply flex items-center gap-1.5 flex-1 min-w-0;
}

.header-center {
  @apply hidden sm:flex items-center gap-1.5;
}

.header-right {
  @apply flex items-center gap-1.5;
}

.icon-btn {
  @apply w-7 h-7 flex items-center justify-center rounded text-sm;
  @apply text-neutral-500 hover:text-neutral-700 dark:hover:text-neutral-300;
  @apply hover:bg-neutral-200 dark:hover:bg-neutral-800;
  @apply transition-colors;
}

.title-input {
  @apply flex-1 min-w-0 max-w-[200px] px-2 py-1 text-sm rounded;
  @apply bg-transparent hover:bg-neutral-100 dark:hover:bg-neutral-800;
  @apply focus:bg-white dark:focus:bg-neutral-800;
  @apply border border-transparent focus:border-sky-500;
  @apply text-neutral-800 dark:text-neutral-100;
  @apply outline-none transition-colors;
}

.unsaved-dot {
  @apply text-amber-500 text-[10px];
}

.mini-select {
  @apply px-1.5 py-1 text-xs rounded;
  @apply bg-white dark:bg-neutral-800;
  @apply border border-neutral-200 dark:border-neutral-700;
  @apply text-neutral-700 dark:text-neutral-300;
  @apply cursor-pointer;
}

.status-dot {
  @apply w-2 h-2 rounded-full flex-shrink-0;
  @apply bg-neutral-400;
}
.status-dot[data-status="ready"] { @apply bg-green-500; }
.status-dot[data-status="busy"] { @apply bg-yellow-500 animate-pulse; }
.status-dot[data-status="error"] { @apply bg-red-500; }

.auto-toggle {
  @apply hidden sm:flex items-center gap-1 cursor-pointer;
  @apply text-[11px] text-neutral-500 dark:text-neutral-400;
}
.auto-toggle input {
  @apply w-5 h-2.5 rounded-full appearance-none cursor-pointer relative;
  @apply bg-neutral-300 dark:bg-neutral-600 transition-colors;
}
.auto-toggle input::before {
  content: "";
  @apply absolute top-0.5 left-0.5 w-1.5 h-1.5 rounded-full bg-white shadow transition-transform;
}
.auto-toggle input:checked { @apply bg-sky-500; }
.auto-toggle input:checked::before { transform: translateX(10px); }

.btn {
  @apply px-2 py-1 text-xs font-medium rounded;
  @apply bg-white dark:bg-neutral-800;
  @apply border border-neutral-200 dark:border-neutral-700;
  @apply text-neutral-700 dark:text-neutral-300;
  @apply hover:border-sky-500 transition-colors;
}
.btn:disabled { @apply opacity-50 cursor-not-allowed; }
.btn-primary {
  @apply bg-sky-500 hover:bg-sky-600 border-transparent text-white;
}
</style>
