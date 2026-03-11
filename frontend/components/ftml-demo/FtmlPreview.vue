<template>
  <div class="preview-pane">
    <div class="pane-header">
      <div class="pane-title">
        <span>预览</span>
      </div>
      <div class="flex items-center gap-2">
        <span class="pane-stats" v-if="renderSummary">{{ renderSummary }}</span>
        <div v-if="isLoading" class="loading-spinner" />
      </div>
    </div>

    <div
      class="preview-container"
      :class="{
        'preview-tablet': device === 'tablet',
        'preview-mobile': device === 'mobile',
      }"
    >
      <iframe
        ref="iframeRef"
        class="preview-iframe"
        title="FTML / SCP-CN 预览"
        sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, toRaw } from 'vue'

const PREVIEW_FRAME_URL = '/ftml_preview_frame.html?v=20260301k'

type PreviewPayload = {
  type: 'ftml-update'
  title: string
  html: string
  pageTags: string[]
  topBarHtml: string
  sideBarHtml: string
  previewDevice: 'desktop' | 'tablet' | 'mobile'
}

const props = defineProps<{
  html: string
  title: string
  pageTags: string[]
  topBarHtml: string
  sideBarHtml: string
  device: 'desktop' | 'tablet' | 'mobile'
  isLoading: boolean
  renderSummary: string
}>()

const iframeRef = ref<HTMLIFrameElement | null>(null)
let iframeReady = false
let pendingPayload: PreviewPayload | null = null
let iframeLoadHandler: (() => void) | null = null

function toPlainTags(raw: string[]): string[] {
  if (!Array.isArray(raw)) return []
  const arr = toRaw(raw) as unknown[]
  return arr
    .map((tag) => String(tag ?? '').trim())
    .filter((tag) => tag.length > 0)
}

function createPayload(
  title: string,
  html: string,
  pageTags: string[],
  topBarHtml: string,
  sideBarHtml: string,
  previewDevice: 'desktop' | 'tablet' | 'mobile'
): PreviewPayload {
  return {
    type: 'ftml-update',
    title: String(title ?? 'FTML 预览'),
    html: String(html ?? ''),
    pageTags: toPlainTags(pageTags),
    topBarHtml: String(topBarHtml ?? ''),
    sideBarHtml: String(sideBarHtml ?? ''),
    previewDevice,
  }
}

function postPayload(payload: PreviewPayload): boolean {
  const target = iframeRef.value?.contentWindow
  if (!target) return false

  try {
    target.postMessage(JSON.stringify(payload), '*')
    return true
  } catch {
    try {
      // Fallback for older frame scripts.
      target.postMessage(payload, '*')
      return true
    } catch (e) {
      console.warn('[FtmlPreview] postMessage failed:', e)
      return false
    }
  }
}

function flushPendingPayload() {
  if (!pendingPayload || !iframeReady) return
  if (postPayload(pendingPayload)) {
    pendingPayload = null
  }
}

function initIframe(forceReload = false) {
  const iframe = iframeRef.value
  if (!iframe) return

  iframeReady = false

  if (iframeLoadHandler) {
    iframe.removeEventListener('load', iframeLoadHandler)
    iframeLoadHandler = null
  }

  iframeLoadHandler = () => {
    iframeReady = true
    flushPendingPayload()
  }

  iframe.addEventListener('load', iframeLoadHandler, { once: true })

  if (forceReload) {
    iframe.src = `${PREVIEW_FRAME_URL}&r=${Date.now()}`
    return
  }

  if (!iframe.src || !iframe.src.includes('/ftml_preview_frame.html')) {
    iframe.src = PREVIEW_FRAME_URL
  }
}

function updatePreview(
  title: string,
  html: string,
  pageTags: string[],
  topBarHtml: string,
  sideBarHtml: string,
  previewDevice: 'desktop' | 'tablet' | 'mobile'
) {
  const payload = createPayload(title, html, pageTags, topBarHtml, sideBarHtml, previewDevice)

  if (!iframeReady) {
    pendingPayload = payload
    return
  }

  if (!postPayload(payload)) {
    pendingPayload = payload
    initIframe(true)
  }
}

watch(
  () => [props.html, props.title, props.topBarHtml, props.sideBarHtml, props.device, JSON.stringify(props.pageTags || [])],
  () => {
    updatePreview(props.title, props.html, props.pageTags, props.topBarHtml, props.sideBarHtml, props.device)
  },
  { immediate: true }
)

onMounted(() => {
  initIframe(false)
  setTimeout(() => {
    updatePreview(props.title, props.html, props.pageTags, props.topBarHtml, props.sideBarHtml, props.device)
  }, 120)
})

onUnmounted(() => {
  const iframe = iframeRef.value
  if (iframe && iframeLoadHandler) {
    iframe.removeEventListener('load', iframeLoadHandler)
  }
  iframeLoadHandler = null
  pendingPayload = null
})

defineExpose({
  reset: () => {
    iframeReady = false
    pendingPayload = createPayload(
      props.title,
      props.html,
      props.pageTags,
      props.topBarHtml,
      props.sideBarHtml,
      props.device
    )
    initIframe(true)
  },
})
</script>

<style scoped>
.preview-pane {
  @apply flex flex-col h-full;
  @apply bg-white dark:bg-neutral-900;
}

.pane-header {
  @apply flex items-center justify-between px-4 py-2.5;
  @apply bg-neutral-50 dark:bg-neutral-800/50;
  @apply border-b border-neutral-200 dark:border-neutral-700;
}

.pane-title {
  @apply flex items-center gap-2 font-semibold text-neutral-800 dark:text-neutral-100;
}

.pane-icon {
  @apply text-base opacity-70;
}

.pane-stats {
  @apply text-xs text-neutral-500 dark:text-neutral-400 font-mono;
}

.loading-spinner {
  @apply w-4 h-4 border-2 border-sky-200 dark:border-sky-800;
  @apply border-t-sky-500 rounded-full animate-spin;
}

.preview-container {
  @apply flex-1 min-h-0 overflow-hidden;
  @apply flex justify-center items-stretch;
  @apply bg-white;
}

.preview-iframe {
  @apply w-full h-full border-none;
  background: #ffffff;
}

/* Device simulation */
.preview-tablet {
  @apply p-4 bg-neutral-100 dark:bg-neutral-800;
}

.preview-tablet .preview-iframe {
  @apply w-[768px] max-w-full rounded-xl shadow-lg;
  @apply border border-neutral-200 dark:border-neutral-700;
}

.preview-mobile {
  @apply p-4 bg-neutral-100 dark:bg-neutral-800;
}

.preview-mobile .preview-iframe {
  @apply w-[390px] max-w-full rounded-xl shadow-lg;
  @apply border border-neutral-200 dark:border-neutral-700;
}
</style>
