<template>
  <header class="app-header">
    <div class="brand">
      <img src="/icons/favicon-light.svg" alt="SCPper" class="brand-icon dark:hidden" />
      <img src="/icons/favicon-dark.svg" alt="SCPper" class="brand-icon hidden dark:block" />
      <span class="brand-title">FTML Demo</span>
    </div>

    <div class="header-actions">
      <div class="status-chip" :data-status="workerStatus">
        <span class="status-dot" />
        <span class="status-text">{{ statusText }}</span>
      </div>

      <label class="auto-render-toggle">
        <input
          type="checkbox"
          :checked="autoRender"
          @change="$emit('update:autoRender', ($event.target as HTMLInputElement).checked)"
        />
        <span>自动</span>
      </label>

      <button type="button" class="btn btn-icon" @click="$emit('reset')" title="重置预览">
        🔄
      </button>

      <button type="button" class="btn btn-icon" @click="$emit('toggleTheme')" :title="theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'">
        {{ theme === 'dark' ? '🌙' : '☀️' }}
      </button>

      <button type="button" class="btn btn-primary" @click="$emit('render')" :disabled="!canRender">
        <span v-if="isRendering" class="btn-spinner" />
        <template v-else>渲染</template>
      </button>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { WorkerStatus } from '~/composables/useFtmlDemo'

const props = defineProps<{
  workerStatus: WorkerStatus
  workerVersion: string | null
  autoRender: boolean
  theme: 'light' | 'dark'
  isRendering: boolean
  canRender: boolean
}>()

defineEmits<{
  (e: 'update:autoRender', value: boolean): void
  (e: 'render'): void
  (e: 'reset'): void
  (e: 'toggleTheme'): void
}>()

const statusText = computed(() => {
  const suffix = props.workerVersion ? ` · v${props.workerVersion}` : ''
  switch (props.workerStatus) {
    case 'idle':
      return '初始化中…' + suffix
    case 'initializing':
      return '启动 Worker…' + suffix
    case 'ready':
      return 'Worker 就绪' + suffix
    case 'busy':
      return '渲染中' + suffix
    case 'error':
      return 'Worker 错误' + suffix
    default:
      return '未知状态' + suffix
  }
})
</script>

<style scoped>
.app-header {
  @apply h-10 flex items-center justify-between px-3;
  @apply bg-neutral-50 dark:bg-neutral-900/80;
  @apply border-b border-neutral-200 dark:border-neutral-800;
  @apply backdrop-blur-lg;
  @apply sticky top-0 z-50;
}

.brand {
  @apply flex items-center gap-2;
}

.brand-icon {
  @apply w-5 h-5 flex-shrink-0;
}

.brand-title {
  @apply text-sm font-semibold text-neutral-700 dark:text-neutral-200;
}

.header-actions {
  @apply flex items-center gap-1.5;
}

.status-chip {
  @apply flex items-center gap-1;
  @apply text-[11px] font-medium;
  @apply px-2 py-0.5 rounded-full;
  @apply border;
}

.status-chip[data-status="idle"],
.status-chip[data-status="initializing"] {
  @apply border-neutral-300 dark:border-neutral-600;
  @apply text-neutral-500 dark:text-neutral-400;
}

.status-chip[data-status="ready"] {
  @apply border-green-500 dark:border-green-400;
  @apply bg-green-50 dark:bg-green-900/20;
  @apply text-green-600 dark:text-green-400;
}

.status-chip[data-status="busy"] {
  @apply border-yellow-500 dark:border-yellow-400;
  @apply bg-yellow-50 dark:bg-yellow-900/20;
  @apply text-yellow-600 dark:text-yellow-400;
}

.status-chip[data-status="busy"] .status-dot {
  animation: pulse 1s ease-in-out infinite;
}

.status-chip[data-status="error"] {
  @apply border-red-500 dark:border-red-400;
  @apply bg-red-50 dark:bg-red-900/20;
  @apply text-red-600 dark:text-red-400;
}

.status-dot {
  @apply w-1.5 h-1.5 rounded-full bg-current;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.5; transform: scale(0.8); }
}

.status-text {
  @apply hidden sm:inline;
}

.auto-render-toggle {
  @apply hidden sm:flex items-center gap-1.5 cursor-pointer;
  @apply text-[11px] text-neutral-600 dark:text-neutral-400;
  @apply px-1.5 py-0.5 rounded;
  @apply hover:bg-neutral-100 dark:hover:bg-neutral-800;
  @apply transition-colors;
}

.auto-render-toggle input {
  @apply w-6 h-3 rounded-full appearance-none cursor-pointer;
  @apply bg-neutral-300 dark:bg-neutral-600;
  @apply relative;
  @apply transition-colors;
}

.auto-render-toggle input::before {
  content: "";
  @apply absolute top-0.5 left-0.5 w-2 h-2 rounded-full bg-white;
  @apply shadow transition-transform;
}

.auto-render-toggle input:checked {
  @apply bg-sky-500;
}

.auto-render-toggle input:checked::before {
  transform: translateX(12px);
}

.btn {
  @apply px-2 py-1 text-xs font-medium rounded;
  @apply bg-white dark:bg-neutral-800;
  @apply border border-neutral-200 dark:border-neutral-700;
  @apply text-neutral-700 dark:text-neutral-300;
  @apply hover:border-sky-500;
  @apply transition-colors whitespace-nowrap;
  @apply flex items-center gap-1;
}

.btn:disabled {
  @apply opacity-50 cursor-not-allowed;
}

.btn-icon {
  @apply w-7 h-7 p-0 justify-center text-sm;
}

.btn-primary {
  @apply bg-sky-500 hover:bg-sky-600;
  @apply border-transparent text-white font-medium;
}

.btn-spinner {
  @apply w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin;
}
</style>
