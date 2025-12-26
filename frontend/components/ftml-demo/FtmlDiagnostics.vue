<template>
  <div class="diagnostics-panel" :class="{ collapsed: isCollapsed }">
    <div class="diagnostics-header">
      <div class="header-left">
        <span class="header-title">诊断</span>
        <span class="error-count" :class="{ ok: errorCount === 0 }">
          {{ errorCount }}
        </span>
      </div>
      <button type="button" class="toggle-btn" @click="toggleCollapsed">
        <span class="toggle-icon">{{ isCollapsed ? '▶' : '▼' }}</span>
        <span>{{ isCollapsed ? '展开' : '收起' }}</span>
      </button>
    </div>

    <div v-show="!isCollapsed" class="diagnostics-content">
      <div v-if="noteText" class="note-text">
        {{ noteText }}
      </div>

      <div v-if="errors.length === 0" class="no-errors">
        ✓ 没有解析错误
      </div>

      <div
        v-for="(error, index) in errors"
        :key="index"
        class="error-item"
        @click="$emit('gotoError', error)"
      >
        <div class="error-head">
          <div class="error-title">
            #{{ index + 1 }} [{{ error.kind }}]
            <span v-if="error.rule" class="error-rule">({{ error.rule }})</span>
          </div>
          <div class="error-loc">
            行 {{ error.loc.line }} · 列 {{ error.loc.col }}
          </div>
        </div>
        <div class="error-message">{{ error.message }}</div>
        <div v-if="error.viaInclude" class="error-note">
          提示：该错误来自 include 展开内容，已定位到对应 include 语句附近。
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { DiagnosticError } from '~/composables/useFtmlDemo'

const props = defineProps<{
  errors: DiagnosticError[]
  noteText?: string
}>()

defineEmits<{
  (e: 'gotoError', error: DiagnosticError): void
}>()

const isCollapsed = ref(false)

const errorCount = computed(() => props.errors.length)

function toggleCollapsed() {
  isCollapsed.value = !isCollapsed.value
}
</script>

<style scoped>
.diagnostics-panel {
  @apply border-t border-neutral-200 dark:border-neutral-700;
  @apply bg-neutral-50 dark:bg-neutral-800/50;
}

.diagnostics-header {
  @apply flex items-center justify-between px-4 py-2;
  @apply bg-neutral-100 dark:bg-neutral-800;
}

.header-left {
  @apply flex items-center gap-2;
}

.header-title {
  @apply text-sm font-medium text-neutral-700 dark:text-neutral-300;
}

.error-count {
  @apply text-xs px-2 py-0.5 rounded-full font-semibold;
  @apply bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400;
}

.error-count.ok {
  @apply bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400;
}

.toggle-btn {
  @apply flex items-center gap-1.5 px-2.5 py-1 text-xs;
  @apply rounded-md;
  @apply bg-white dark:bg-neutral-700;
  @apply border border-neutral-200 dark:border-neutral-600;
  @apply text-neutral-600 dark:text-neutral-300;
  @apply hover:border-sky-500 hover:text-sky-600 dark:hover:text-sky-400;
  @apply transition-colors;
}

.toggle-icon {
  @apply text-[10px];
}

.diagnostics-content {
  @apply max-h-[200px] overflow-auto px-4 py-3;
}

.note-text {
  @apply text-xs text-neutral-500 dark:text-neutral-400 mb-2 italic;
}

.no-errors {
  @apply text-sm text-green-600 dark:text-green-400 font-mono;
}

.error-item {
  @apply p-3 mb-2 rounded-lg cursor-pointer;
  @apply bg-white dark:bg-neutral-800;
  @apply border border-neutral-200 dark:border-neutral-700;
  @apply hover:border-sky-500 transition-all;
  @apply hover:translate-x-0.5 hover:shadow-[-2px_0_0_theme(colors.sky.500)];
}

.error-item:last-child {
  @apply mb-0;
}

.error-head {
  @apply flex items-center justify-between gap-3 mb-1;
}

.error-title {
  @apply text-sm font-semibold text-red-600 dark:text-red-400;
}

.error-rule {
  @apply font-normal text-xs text-neutral-500 dark:text-neutral-400;
}

.error-loc {
  @apply text-xs text-neutral-500 dark:text-neutral-400 font-mono whitespace-nowrap;
  @apply px-2 py-0.5 rounded bg-neutral-100 dark:bg-neutral-700;
}

.error-message {
  @apply text-xs text-neutral-600 dark:text-neutral-400 font-mono;
  @apply whitespace-pre-wrap leading-relaxed;
}

.error-note {
  @apply text-xs text-neutral-500 dark:text-neutral-400 mt-2 italic;
}
</style>
