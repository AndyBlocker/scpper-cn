<template>
  <div class="ftml-demo-page">
    <ClientOnly>
      <FtmlHeader
        :worker-status="state.workerStatus"
        :worker-version="state.workerVersion"
        :auto-render="state.preferences.autoRender"
        :theme="state.preferences.theme"
        :is-rendering="state.isRendering"
        :can-render="canRender"
        @update:auto-render="updatePreference('autoRender', $event)"
        @render="requestRender('manual')"
        @reset="handleReset"
        @toggle-theme="toggleTheme"
      />

      <FtmlToolbar
        :page-title="state.pageMeta.title"
        :page-tags="state.pageMeta.tags.join(' ')"
        :mode="state.preferences.mode"
        :layout="state.preferences.layout"
        :ui-layout="state.preferences.uiLayout"
        :preview-device="state.preferences.previewDevice"
        :include-mode="state.preferences.includeMode"
        :include-stats="state.includeStats"
        @update:page-title="updatePageTitle"
        @update:page-tags="updatePageTags"
        @update:mode="updatePreference('mode', $event)"
        @update:layout="updatePreference('layout', $event)"
        @update:ui-layout="updatePreference('uiLayout', $event)"
        @update:preview-device="updatePreference('previewDevice', $event)"
        @update:include-mode="updatePreference('includeMode', $event)"
        @clear-include-cache="clearIncludeCache"
      />

      <main class="main-content">
        <div class="split-container" :class="[uiLayoutClass]">
          <!-- Editor Pane -->
          <div v-show="showEditor" class="pane editor-pane" :style="editorStyle">
            <FtmlEditor
              ref="editorRef"
              v-model="state.source"
              :stats="editorStats"
              :worker-version="state.workerVersion"
              @update:model-value="updateSource"
              @render="requestRender('manual')"
              @save="handleSave"
            />
          </div>

          <!-- Splitter -->
          <div
            v-show="showBoth"
            class="splitter"
            @mousedown="startResize"
            @dblclick="resetSplit"
          />

          <!-- Preview Pane -->
          <div v-show="showPreview" class="pane preview-pane" :style="previewStyle">
            <FtmlPreview
              ref="previewRef"
              :html="previewHtml"
              :title="state.pageMeta.title || 'FTML 预览'"
              :device="state.preferences.previewDevice"
              :is-loading="state.isRendering"
              :render-summary="renderSummary"
            />

            <FtmlDiagnostics
              :errors="diagnosticErrors"
              :note-text="state.lastResult?.noteText || ''"
              @goto-error="handleGotoError"
            />
          </div>
        </div>
      </main>

      <!-- Toast notifications -->
      <FtmlToast :toasts="toasts" />

      <!-- Server-side placeholder -->
      <template #fallback>
        <div class="loading-placeholder">
          <div class="loading-spinner" />
          <p>正在加载 FTML Demo...</p>
        </div>
      </template>
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useFtmlDemo, type DiagnosticError, type FtmlPreferences } from '~/composables/useFtmlDemo'

// Page meta
definePageMeta({
  layout: false, // Use custom layout for full-screen editor
})

useHead({
  title: 'FTML Demo - SCPper CN',
  meta: [
    { name: 'description', content: 'FTML (Foundation Text Markup Language) 在线预览工具' },
  ],
  link: [
    { rel: 'preconnect', href: 'https://fonts.googleapis.com' },
    { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' },
    { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap' },
  ],
})

// Composable
const {
  state,
  toasts,
  isWorkerReady,
  canRender,
  editorStats,
  renderSummary,
  initialize,
  cleanup,
  requestRender,
  clearIncludeCache,
  updateSource,
  updatePageTitle,
  updatePageTags,
  updatePreference,
  toggleTheme,
  showToast,
  saveSource,
} = useFtmlDemo()

// Refs
const editorRef = ref<any>(null)
const previewRef = ref<any>(null)

// Split resizing state
const splitRatio = ref(50)
const isResizing = ref(false)

// Computed
const showEditor = computed(() => state.preferences.uiLayout !== 'preview-only')
const showPreview = computed(() => state.preferences.uiLayout !== 'editor-only')
const showBoth = computed(() => state.preferences.uiLayout === 'both')

const uiLayoutClass = computed(() => {
  return {
    'layout-both': state.preferences.uiLayout === 'both',
    'layout-editor-only': state.preferences.uiLayout === 'editor-only',
    'layout-preview-only': state.preferences.uiLayout === 'preview-only',
  }
})

const editorStyle = computed(() => {
  if (state.preferences.uiLayout !== 'both') return {}
  return { flexBasis: `${splitRatio.value}%` }
})

const previewStyle = computed(() => {
  if (state.preferences.uiLayout !== 'both') return {}
  return { flexBasis: `${100 - splitRatio.value}%` }
})

const previewHtml = computed(() => {
  if (!state.lastResult?.ok) {
    const err = state.lastResult?.error || ''
    return `<pre class="ftml-error">${escapeHtml(err)}</pre>`
  }
  return state.lastResult?.html || ''
})

const diagnosticErrors = computed(() => {
  return state.lastResult?.errors || []
})

// Helper
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Handlers
function handleReset() {
  previewRef.value?.reset()
  if (state.lastResult?.ok) {
    // Re-render after reset
    requestRender('manual')
  }
}

function handleSave() {
  saveSource()
  showToast('草稿已保存', 'success', 2000)
}

function handleGotoError(error: DiagnosticError) {
  editorRef.value?.setCursor(error.loc.line, error.loc.col)
}

// Splitter resize
function startResize(e: MouseEvent) {
  if (e.button !== 0) return
  isResizing.value = true
  document.body.classList.add('is-resizing')
}

function onMouseMove(e: MouseEvent) {
  if (!isResizing.value) return
  const container = document.querySelector('.split-container')
  if (!container) return

  const rect = container.getBoundingClientRect()
  const isVertical = window.innerWidth > 980

  if (isVertical) {
    const offsetX = e.clientX - rect.left
    const percent = (offsetX / rect.width) * 100
    splitRatio.value = Math.min(82, Math.max(18, percent))
  } else {
    const offsetY = e.clientY - rect.top
    const percent = (offsetY / rect.height) * 100
    splitRatio.value = Math.min(82, Math.max(18, percent))
  }
}

function onMouseUp() {
  if (!isResizing.value) return
  isResizing.value = false
  document.body.classList.remove('is-resizing')
}

function resetSplit() {
  splitRatio.value = 50
}

// Global keyboard shortcuts
function handleGlobalKeydown(e: KeyboardEvent) {
  // Ctrl/Cmd + Enter to render
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    requestRender('manual')
  }
  // Ctrl/Cmd + \ to toggle theme
  if (e.key === '\\' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    toggleTheme()
  }
}

// Apply theme to document
watch(
  () => state.preferences.theme,
  (theme) => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', theme === 'dark')
    }
  },
  { immediate: true }
)

// Lifecycle
onMounted(() => {
  initialize()
  // Initial render after worker is ready
  setTimeout(() => requestRender('init'), 100)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  document.addEventListener('keydown', handleGlobalKeydown)
})

onUnmounted(() => {
  cleanup()
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  document.removeEventListener('keydown', handleGlobalKeydown)
})
</script>

<style scoped>
.ftml-demo-page {
  @apply h-screen flex flex-col overflow-hidden;
  @apply bg-neutral-100 dark:bg-neutral-950;
}

.main-content {
  @apply flex-1 min-h-0 p-2;
}

.split-container {
  @apply h-full flex rounded-xl overflow-hidden;
  @apply bg-white dark:bg-neutral-900;
  @apply border border-neutral-200 dark:border-neutral-800;
  @apply shadow-xl;
}

/* Layout modes */
.layout-both .pane {
  @apply flex-shrink-0 min-w-0;
}

.layout-editor-only .editor-pane {
  @apply flex-1;
}

.layout-editor-only .preview-pane,
.layout-editor-only .splitter {
  @apply hidden;
}

.layout-preview-only .preview-pane {
  @apply flex-1;
}

.layout-preview-only .editor-pane,
.layout-preview-only .splitter {
  @apply hidden;
}

.pane {
  @apply flex flex-col min-h-0 overflow-hidden;
}

.editor-pane {
  @apply border-r border-neutral-200 dark:border-neutral-800;
}

/* Splitter */
.splitter {
  @apply flex-shrink-0 w-1.5 cursor-col-resize relative;
  @apply bg-transparent hover:bg-sky-500/20;
  @apply transition-colors;
}

.splitter::before {
  content: "";
  @apply absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2;
  @apply w-1 h-12 rounded-full;
  @apply bg-neutral-300 dark:bg-neutral-600;
  @apply transition-all;
}

.splitter:hover::before {
  @apply bg-sky-500 h-16;
  box-shadow: 0 0 12px rgba(56, 189, 248, 0.3);
}

/* Loading placeholder */
.loading-placeholder {
  @apply h-screen flex flex-col items-center justify-center gap-4;
  @apply text-neutral-500 dark:text-neutral-400;
}

.loading-spinner {
  @apply w-8 h-8 border-4 border-neutral-200 dark:border-neutral-700;
  @apply border-t-sky-500 rounded-full animate-spin;
}

/* Global styles for resize state */
:global(body.is-resizing) {
  cursor: col-resize !important;
  user-select: none !important;
}

/* Responsive */
@media (max-width: 980px) {
  .split-container {
    @apply flex-col;
  }

  .editor-pane {
    @apply border-r-0 border-b border-neutral-200 dark:border-neutral-800;
  }

  .splitter {
    @apply w-full h-2 cursor-row-resize;
  }

  .splitter::before {
    @apply w-12 h-1;
  }

  :global(body.is-resizing) {
    cursor: row-resize !important;
  }
}
</style>
