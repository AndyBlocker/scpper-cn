<template>
  <div class="ftml-editor-page">
    <!-- Auth/Loading states -->
    <div v-if="authLoading || projectLoading" class="loading-overlay">
      <div class="spinner" />
      <p>{{ authLoading ? '验证登录状态...' : '加载项目...' }}</p>
    </div>

    <div v-else-if="!isAuthenticated" class="error-overlay">
      <div class="error-card">
        <h2>需要登录</h2>
        <p>请先登录 SCPper 账号。</p>
        <NuxtLink to="/account" class="btn btn-primary">前往登录</NuxtLink>
      </div>
    </div>

    <div v-else-if="!hasLinkedWikidot" class="error-overlay">
      <div class="error-card">
        <h2>需要绑定 Wikidot</h2>
        <p>请先绑定 Wikidot 账号。</p>
        <NuxtLink to="/account" class="btn btn-primary">前往绑定</NuxtLink>
      </div>
    </div>

    <div v-else-if="loadError" class="error-overlay">
      <div class="error-card">
        <h2>加载失败</h2>
        <p>{{ loadError }}</p>
        <NuxtLink to="/ftml-projects" class="btn">返回项目列表</NuxtLink>
      </div>
    </div>

    <!-- Main editor -->
    <ClientOnly v-else>
      <FtmlProjectHeader
        :title="state.pageMeta.title"
        :is-saving="isSaving"
        :has-unsaved="hasUnsavedChanges"
        :worker-status="state.workerStatus"
        :worker-version="state.workerVersion"
        :auto-render="state.preferences.autoRender"
        :is-rendering="state.isRendering"
        :can-render="canRender"
        :ui-layout="state.preferences.uiLayout"
        :preview-device="state.preferences.previewDevice"
        :theme="state.preferences.theme"
        @update:title="updateTitle"
        @update:auto-render="updatePreference('autoRender', $event)"
        @update:ui-layout="updatePreference('uiLayout', $event)"
        @update:preview-device="updatePreference('previewDevice', $event)"
        @save="saveProject"
        @render="requestRender('manual')"
        @back="goBack"
        @toggle-theme="toggleTheme"
      />

      <main class="main-content">
        <div class="split-container" :class="[uiLayoutClass]">
          <div v-show="showEditor" class="pane editor-pane" :style="editorStyle">
            <FtmlEditor
              ref="editorRef"
              v-model="state.source"
              :stats="editorStats"
              :worker-version="state.workerVersion"
              @update:model-value="handleSourceChange"
              @render="requestRender('manual')"
              @save="saveProject"
            />
          </div>

          <div
            v-show="showBoth"
            class="splitter"
            @mousedown="startResize"
            @dblclick="resetSplit"
          />

          <div v-show="showPreview" class="pane preview-pane" :style="previewStyle">
            <FtmlPreview
              ref="previewRef"
              :html="previewHtml"
              :title="state.pageMeta.title || '预览'"
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

      <FtmlToast :toasts="toasts" />

      <template #fallback>
        <div class="loading-overlay">
          <div class="spinner" />
          <p>正在加载编辑器...</p>
        </div>
      </template>
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useAuth } from '~/composables/useAuth'
import { useFtmlProjects, type FtmlProject } from '~/composables/useFtmlProjects'
import { useFtmlDemo, type DiagnosticError, type FtmlPreferences } from '~/composables/useFtmlDemo'

definePageMeta({
  layout: false
})

const route = useRoute()
const router = useRouter()
const projectId = computed(() => route.params.id as string)

// Auth
const { user, loading: authLoading, isAuthenticated, fetchCurrentUser } = useAuth()
const hasLinkedWikidot = computed(() => !!user.value?.linkedWikidotId)

// Project API
const { getProject, updateProject: apiUpdateProject, isLoading: projectLoading, error: apiError } = useFtmlProjects()
const loadError = ref<string | null>(null)
const isSaving = ref(false)
const hasUnsavedChanges = ref(false)
const lastSavedSource = ref('')
const lastSavedTitle = ref('')

// FTML Demo composable
const {
  state,
  toasts,
  canRender,
  editorStats,
  renderSummary,
  initialize,
  cleanup,
  requestRender,
  updateSource,
  updatePageTitle: updatePageTitleInternal,
  updatePreference,
  toggleTheme,
  showToast
} = useFtmlDemo()

// Refs
const editorRef = ref<any>(null)
const previewRef = ref<any>(null)

// Split resizing
const splitRatio = ref(50)
const isResizing = ref(false)

// Computed
const showEditor = computed(() => state.preferences.uiLayout !== 'preview-only')
const showPreview = computed(() => state.preferences.uiLayout !== 'editor-only')
const showBoth = computed(() => state.preferences.uiLayout === 'both')

const uiLayoutClass = computed(() => ({
  'layout-both': state.preferences.uiLayout === 'both',
  'layout-editor-only': state.preferences.uiLayout === 'editor-only',
  'layout-preview-only': state.preferences.uiLayout === 'preview-only'
}))

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

const diagnosticErrors = computed(() => state.lastResult?.errors || [])

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// Load project
async function loadProject() {
  const project = await getProject(projectId.value)
  if (!project) {
    loadError.value = apiError.value || '项目不存在'
    return
  }

  // Use project.title as the unified title
  state.pageMeta.title = project.title || '未命名'
  state.source = project.source || ''
  lastSavedSource.value = project.source || ''
  lastSavedTitle.value = project.title || ''
  state.pageMeta.tags = project.pageTags || []

  // Restore settings
  if (project.settings) {
    const s = project.settings as Record<string, unknown>
    if (s.mode) state.preferences.mode = s.mode as any
    if (s.layout) state.preferences.layout = s.layout as any
    if (s.includeMode) state.preferences.includeMode = s.includeMode as any
    if (s.uiLayout) state.preferences.uiLayout = s.uiLayout as any
    if (s.previewDevice) state.preferences.previewDevice = s.previewDevice as any
  }

  useHead({ title: `${state.pageMeta.title} - FTML` })

  // Initial render
  setTimeout(() => requestRender('init'), 100)
}

// Save project
async function saveProject() {
  if (isSaving.value) return

  isSaving.value = true
  const result = await apiUpdateProject(projectId.value, {
    title: state.pageMeta.title || '未命名',
    source: state.source,
    pageTitle: null, // No longer separate
    pageTags: state.pageMeta.tags,
    settings: {
      mode: state.preferences.mode,
      layout: state.preferences.layout,
      includeMode: state.preferences.includeMode,
      uiLayout: state.preferences.uiLayout,
      previewDevice: state.preferences.previewDevice
    }
  })
  isSaving.value = false

  if (result) {
    lastSavedSource.value = state.source
    lastSavedTitle.value = state.pageMeta.title
    hasUnsavedChanges.value = false
    showToast('已保存', 'success', 1500)
  } else {
    showToast('保存失败: ' + (apiError.value || '未知错误'), 'error')
  }
}

// Handlers
function updateTitle(title: string) {
  updatePageTitleInternal(title)
  hasUnsavedChanges.value = title !== lastSavedTitle.value || state.source !== lastSavedSource.value
}

function handleSourceChange(newSource: string) {
  updateSource(newSource)
  hasUnsavedChanges.value = newSource !== lastSavedSource.value || state.pageMeta.title !== lastSavedTitle.value
}

function handleGotoError(error: DiagnosticError) {
  editorRef.value?.setCursor(error.loc.line, error.loc.col)
}

function goBack() {
  if (hasUnsavedChanges.value) {
    if (!confirm('有未保存的更改，确定要离开吗？')) {
      return
    }
  }
  router.push('/ftml-projects')
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

// Keyboard shortcuts
function handleGlobalKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    requestRender('manual')
  }
  if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    saveProject()
  }
  if (e.key === '\\' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    toggleTheme()
  }
}

// Theme
watch(
  () => state.preferences.theme,
  (theme) => {
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', theme === 'dark')
    }
  },
  { immediate: true }
)

// Warn before leaving with unsaved changes
function handleBeforeUnload(e: BeforeUnloadEvent) {
  if (hasUnsavedChanges.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}

// Lifecycle
onMounted(async () => {
  await fetchCurrentUser()
  if (isAuthenticated.value && hasLinkedWikidot.value) {
    initialize({ skipLocalStorage: true })
    await loadProject()
  }
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  document.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('beforeunload', handleBeforeUnload)
})

onUnmounted(() => {
  cleanup()
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
  document.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('beforeunload', handleBeforeUnload)
})
</script>

<style scoped>
.ftml-editor-page {
  @apply h-screen flex flex-col overflow-hidden;
  @apply bg-neutral-100 dark:bg-neutral-950;
}

.loading-overlay,
.error-overlay {
  @apply h-screen flex flex-col items-center justify-center;
  @apply text-neutral-500 dark:text-neutral-400;
}

.spinner {
  @apply w-8 h-8 border-4 border-neutral-200 dark:border-neutral-700;
  @apply border-t-sky-500 rounded-full animate-spin mb-4;
}

.error-card {
  @apply bg-white dark:bg-neutral-900 rounded-xl p-8 text-center max-w-md mx-4;
  @apply border border-neutral-200 dark:border-neutral-800;
  @apply shadow-lg;
}

.error-card h2 {
  @apply text-xl font-semibold mb-3 text-neutral-800 dark:text-neutral-100;
}

.error-card p {
  @apply text-neutral-600 dark:text-neutral-400 mb-6;
}

.btn {
  @apply px-4 py-2 rounded-lg font-medium transition-colors;
  @apply bg-neutral-100 dark:bg-neutral-800;
  @apply text-neutral-700 dark:text-neutral-300;
  @apply inline-flex items-center gap-2;
}

.btn-primary {
  @apply bg-sky-500 text-white hover:bg-sky-600;
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

:global(body.is-resizing) {
  cursor: col-resize !important;
  user-select: none !important;
}

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
