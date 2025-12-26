/**
 * useFtmlDemo - FTML Demo 状态管理 composable
 *
 * 管理 FTML 渲染器的 Worker 状态、渲染请求、include 缓存、用户偏好等。
 * 注意：此 composable 包含仅客户端代码（Web Worker、localStorage），
 * 必须在 ClientOnly 组件或 onMounted 中使用。
 */

import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue'

// ==================== Types ====================

export type FtmlMode = 'page' | 'draft' | 'forum-post' | 'direct-message' | 'list'
export type FtmlLayout = 'wikidot' | 'wikijump'
export type UiLayout = 'both' | 'editor-only' | 'preview-only'
export type PreviewDevice = 'desktop' | 'tablet' | 'mobile'
export type IncludeMode = 'hybrid' | 'bff' | 'cache-only' | 'disabled'
export type WorkerStatus = 'idle' | 'initializing' | 'ready' | 'busy' | 'error'

export interface PageMeta {
  site: string
  page: string
  title: string
  alt_title?: string
  category: string
  language: string
  score: number
  tags: string[]
}

export interface FtmlPreferences {
  mode: FtmlMode
  layout: FtmlLayout
  uiLayout: UiLayout
  previewDevice: PreviewDevice
  theme: 'light' | 'dark'
  includeMode: IncludeMode
  autoRender: boolean
}

export interface IncludeStats {
  hits: number
  misses: number
  lastMode: string
  lastNote: string
}

export interface RenderTimings {
  include?: number
  preprocess?: number
  tokenize?: number
  parse?: number
  render?: number
  total?: number
}

export interface DiagnosticError {
  kind: string
  rule?: string
  message: string
  loc: { line: number; col: number }
  viaInclude?: boolean
}

export interface RenderResult {
  ok: boolean
  html?: string
  errors?: DiagnosticError[]
  timings?: RenderTimings
  includeStats?: IncludeStats
  noteText?: string
  error?: string
}

export interface FtmlDemoState {
  workerStatus: WorkerStatus
  workerVersion: string | null
  isRendering: boolean
  lastResult: RenderResult | null
  includeStats: IncludeStats
  source: string
  pageMeta: { title: string; tags: string[] }
  preferences: FtmlPreferences
}

// ==================== Constants ====================

const STORAGE_KEYS = {
  PREFS: 'ftml-demo-adv:prefs:v1',
  SOURCE: 'ftml-demo-adv:source:v1',
  PAGE_META: 'ftml-demo-adv:page-meta:v1',
} as const

const DEFAULT_PAGE_META: PageMeta = {
  site: 'scp-wiki-cn',
  page: 'sandbox:demo-ftml',
  title: 'Demo FTML',
  alt_title: undefined,
  category: 'sandbox',
  language: 'zh-cn',
  score: 0,
  tags: [],
}

const DEFAULT_PREFERENCES: FtmlPreferences = {
  mode: 'page',
  layout: 'wikidot',
  uiLayout: 'both',
  previewDevice: 'desktop',
  theme: 'dark',
  includeMode: 'bff',
  autoRender: false,
}

const DEFAULT_SOURCE = `++ 示例

[[module CSS]]
/* 在这里写自定义 CSS，会影响下方 [[html]] 中的内容 */
.demo-box {
  border: 1px solid #888;
  padding: 0.5em;
  background: #f5f5f5;
}
[[/module]]

[[html]]
<div class="demo-box">
  <strong>这里是 [[html]] 模块渲染结果。</strong><br />
  你可以在左侧编辑 FTML / Wikidot 文本，然后点上方"渲染预览"。
</div>
[[/html]]

----

普通 Wikidot 语法也应当正常工作：

* 这是一个列表项
* **加粗文本** / //斜体文本// / __下划线__

> 这是一个引用块。

另外也可以试试 SCP Wiki 风格的东西，例如：

||~ 项目编号 || SCP-CN-000 ||
||~ 项目等级 || Safe ||

当然，和 Wikidot 本身完全一致还需要更多工作，这里只是 FTML 视角的一个预览。
`

const INCLUDE_BFF_API = 'https://scpper.mer.run/api'
const INCLUDE_BASE_URL = 'http://scp-wiki-cn.wikidot.com'
const AUTO_DEBOUNCE_MS = 350

// ==================== Helper Functions ====================

function isClient(): boolean {
  return typeof window !== 'undefined'
}

function safeLocalStorage<T>(key: string, fallback: T): T {
  if (!isClient()) return fallback
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function saveLocalStorage<T>(key: string, value: T): void {
  if (!isClient()) return
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // ignore
  }
}

function parseTagsInput(text: string): string[] {
  if (!text) return []
  return text
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
}

// ==================== Composable ====================

export function useFtmlDemo() {
  // Worker instance (client-side only)
  let worker: Worker | null = null
  let renderSeq = 0
  let autoRenderTimer: ReturnType<typeof setTimeout> | null = null

  // Reactive state
  const state = reactive<FtmlDemoState>({
    workerStatus: 'idle',
    workerVersion: null,
    isRendering: false,
    lastResult: null,
    includeStats: { hits: 0, misses: 0, lastMode: '', lastNote: '' },
    source: DEFAULT_SOURCE,
    pageMeta: { title: DEFAULT_PAGE_META.title, tags: [...DEFAULT_PAGE_META.tags] },
    preferences: { ...DEFAULT_PREFERENCES },
  })

  // Toast messages queue
  const toasts = ref<Array<{ id: number; message: string; type: 'success' | 'error' | 'warning' | 'info' }>>([])
  let toastId = 0

  // Computed
  const isWorkerReady = computed(() => state.workerStatus === 'ready' || state.workerStatus === 'busy')
  const canRender = computed(() => isWorkerReady.value && !state.isRendering)

  const editorStats = computed(() => {
    const text = state.source
    const lines = text ? text.split('\n').length : 0
    const chars = text.length
    const words = text.trim() ? text.trim().split(/\s+/).length : 0
    return { lines, chars, words, tags: state.pageMeta.tags.length }
  })

  const renderSummary = computed(() => {
    const t = state.lastResult?.timings
    if (!t) return ''
    const parts: string[] = []
    if (t.include != null) parts.push(`include ${t.include.toFixed(0)}ms`)
    if (t.preprocess != null) parts.push(`预处理 ${t.preprocess.toFixed(0)}ms`)
    if (t.tokenize != null) parts.push(`分词 ${t.tokenize.toFixed(0)}ms`)
    if (t.parse != null) parts.push(`解析 ${t.parse.toFixed(0)}ms`)
    if (t.render != null) parts.push(`渲染 ${t.render.toFixed(0)}ms`)
    if (t.total != null) parts.push(`总计 ${t.total.toFixed(0)}ms`)
    return parts.join(' · ')
  })

  // Toast management
  function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info', duration = 3000) {
    const id = ++toastId
    toasts.value.push({ id, message, type })
    setTimeout(() => {
      toasts.value = toasts.value.filter((t) => t.id !== id)
    }, duration)
  }

  // Load saved state from localStorage
  function loadSavedState() {
    if (!isClient()) return

    // Load preferences
    const savedPrefs = safeLocalStorage<Partial<FtmlPreferences>>(STORAGE_KEYS.PREFS, {})
    state.preferences = {
      mode: (['page', 'draft', 'forum-post', 'direct-message', 'list'].includes(savedPrefs.mode || '')
        ? savedPrefs.mode
        : DEFAULT_PREFERENCES.mode) as FtmlMode,
      layout: (['wikidot', 'wikijump'].includes(savedPrefs.layout || '')
        ? savedPrefs.layout
        : DEFAULT_PREFERENCES.layout) as FtmlLayout,
      uiLayout: (['both', 'editor-only', 'preview-only'].includes(savedPrefs.uiLayout || '')
        ? savedPrefs.uiLayout
        : DEFAULT_PREFERENCES.uiLayout) as UiLayout,
      previewDevice: (['desktop', 'tablet', 'mobile'].includes(savedPrefs.previewDevice || '')
        ? savedPrefs.previewDevice
        : DEFAULT_PREFERENCES.previewDevice) as PreviewDevice,
      theme: savedPrefs.theme === 'light' ? 'light' : 'dark',
      includeMode: (['hybrid', 'bff', 'cache-only', 'disabled'].includes(savedPrefs.includeMode || '')
        ? savedPrefs.includeMode
        : DEFAULT_PREFERENCES.includeMode) as IncludeMode,
      autoRender: !!savedPrefs.autoRender,
    }

    // Load source
    const savedSource = safeLocalStorage<string>(STORAGE_KEYS.SOURCE, '')
    if (savedSource) {
      state.source = savedSource
    }

    // Load page meta
    const savedMeta = safeLocalStorage<{ title?: string; tags?: string[] }>(STORAGE_KEYS.PAGE_META, {})
    state.pageMeta = {
      title: savedMeta.title || DEFAULT_PAGE_META.title,
      tags: Array.isArray(savedMeta.tags) ? savedMeta.tags : [],
    }
  }

  // Save preferences
  function savePreferences() {
    saveLocalStorage(STORAGE_KEYS.PREFS, state.preferences)
  }

  // Save source
  function saveSource() {
    saveLocalStorage(STORAGE_KEYS.SOURCE, state.source)
  }

  // Save page meta
  function savePageMeta() {
    saveLocalStorage(STORAGE_KEYS.PAGE_META, state.pageMeta)
  }

  // Worker initialization
  function initWorker(): Worker | null {
    if (!isClient()) return null
    if (worker) return worker

    try {
      worker = new Worker('/ftml-worker.js', { type: 'module' })
      state.workerStatus = 'initializing'

      worker.addEventListener('message', (ev) => {
        const msg = ev.data || {}

        if (msg.type === 'worker-ready') {
          state.workerStatus = 'ready'
          state.workerVersion = msg.version || null
          return
        }

        if (msg.type === 'include-cache-cleared') {
          state.includeStats = { hits: 0, misses: 0, lastMode: '', lastNote: '已清空缓存' }
          showToast('include 缓存已清空', 'success')
          return
        }

        if (msg.type === 'render-result') {
          state.isRendering = false
          const seq = msg.seq || 0
          if (seq !== renderSeq) return // stale result

          state.lastResult = {
            ok: msg.ok,
            html: msg.html,
            errors: msg.errors,
            timings: msg.timings,
            includeStats: msg.includeStats,
            noteText: msg.noteText,
            error: msg.error,
          }

          if (msg.includeStats) {
            state.includeStats = msg.includeStats
          }

          if (msg.ok) {
            state.workerStatus = 'ready'
          } else {
            showToast('渲染失败: ' + (msg.error || '').slice(0, 50), 'error')
          }
        }
      })

      worker.addEventListener('error', (ev) => {
        console.error('[FTML Demo] Worker error:', ev)
        state.workerStatus = 'error'
        showToast('Worker 发生错误', 'error')
      })

      worker.postMessage({ type: 'init' })
      return worker
    } catch (e) {
      console.error('[FTML Demo] Failed to create worker:', e)
      state.workerStatus = 'error'
      return null
    }
  }

  // Request render
  function requestRender(trigger: 'manual' | 'auto' | 'settings' | 'init' = 'manual') {
    const w = worker || initWorker()
    if (!w) return

    if (state.isRendering) return // already rendering

    // Clear include cache on manual render to ensure fresh data
    if (trigger === 'manual') {
      w.postMessage({ type: 'clear-include-cache' })
    }

    state.isRendering = true
    state.workerStatus = 'busy'
    renderSeq++

    // Convert reactive state to plain objects for Worker postMessage
    const pageMeta: PageMeta = {
      ...DEFAULT_PAGE_META,
      title: state.pageMeta.title || DEFAULT_PAGE_META.title,
      tags: [...state.pageMeta.tags], // Spread to plain array (reactive arrays can't be cloned)
    }

    w.postMessage({
      type: 'render',
      seq: renderSeq,
      trigger,
      source: state.source,
      mode: state.preferences.mode,
      layout: state.preferences.layout,
      includeMode: state.preferences.includeMode,
      includeApi: INCLUDE_BFF_API,
      includeBaseUrl: INCLUDE_BASE_URL,
      pageMeta,
    })
  }

  // Schedule auto render
  function scheduleAutoRender() {
    if (!state.preferences.autoRender) return

    if (autoRenderTimer) {
      clearTimeout(autoRenderTimer)
    }

    autoRenderTimer = setTimeout(() => {
      requestRender('auto')
    }, AUTO_DEBOUNCE_MS)
  }

  // Clear include cache
  function clearIncludeCache() {
    if (!worker) return
    worker.postMessage({ type: 'clear-include-cache' })
  }

  // Update source
  function updateSource(newSource: string) {
    state.source = newSource
    saveSource()
    scheduleAutoRender()
  }

  // Update page title
  function updatePageTitle(title: string) {
    state.pageMeta.title = title
    savePageMeta()
    scheduleAutoRender()
  }

  // Update page tags
  function updatePageTags(tagsInput: string) {
    state.pageMeta.tags = parseTagsInput(tagsInput)
    savePageMeta()
    scheduleAutoRender()
  }

  // Update preference
  function updatePreference<K extends keyof FtmlPreferences>(key: K, value: FtmlPreferences[K]) {
    state.preferences[key] = value
    savePreferences()

    // Trigger re-render for relevant settings
    if (['mode', 'layout', 'includeMode'].includes(key)) {
      requestRender('settings')
    }
  }

  // Toggle theme
  function toggleTheme() {
    const next = state.preferences.theme === 'dark' ? 'light' : 'dark'
    state.preferences.theme = next
    savePreferences()
    showToast(`已切换到${next === 'dark' ? '深色' : '浅色'}主题`, 'info', 2000)
  }

  // Initialize
  function initialize(options: { skipLocalStorage?: boolean } = {}) {
    if (!options.skipLocalStorage) {
      loadSavedState()
    }
    initWorker()
    // Note: requestRender should be called by the caller after loading data
  }

  // Cleanup
  function cleanup() {
    if (autoRenderTimer) {
      clearTimeout(autoRenderTimer)
      autoRenderTimer = null
    }
    if (worker) {
      worker.terminate()
      worker = null
    }
  }

  // Watch for preference changes that need UI updates
  watch(
    () => state.preferences.autoRender,
    (enabled) => {
      if (enabled) {
        scheduleAutoRender()
      }
    }
  )

  return {
    // State
    state,
    toasts,

    // Computed
    isWorkerReady,
    canRender,
    editorStats,
    renderSummary,

    // Actions
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
  }
}
