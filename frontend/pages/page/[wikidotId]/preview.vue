<template>
  <div ref="pageRef" class="preview-page">
    <div class="preview-header">
      <div class="flex items-center gap-3">
        <NuxtLink :to="`/page/${wikidotId}`" class="back-link">
          <LucideIcon name="ArrowLeft" class="w-4 h-4" />
        </NuxtLink>
        <h1 class="preview-title">页面预览</h1>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs text-[var(--g-fg-muted)]">Wikidot 缓存</span>
        <a
          :href="`https://scp-wiki-cn.wikidot.com/${fullname || ''}`"
          target="_blank"
          rel="noopener"
          class="external-link"
          v-if="fullname"
        >
          <LucideIcon name="ExternalLink" class="w-4 h-4" />
          <span>原页面</span>
        </a>
      </div>
    </div>

    <div class="preview-frame-container">
      <div v-if="iframeLoading" class="loading-overlay">
        <LucideIcon name="Loader2" class="w-5 h-5 animate-spin" />
        <span>加载页面中...</span>
      </div>
      <iframe
        ref="iframeRef"
        :src="`/api/pages/${wikidotId}/preview`"
        class="preview-iframe"
        :class="{ 'opacity-0': iframeLoading }"
        :title="`预览 ${fullname || ''}`"
        sandbox="allow-same-origin allow-scripts allow-popups allow-popups-to-escape-sandbox"
        @load="iframeLoading = false"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
const route = useRoute()
const wikidotId = computed(() => route.params.wikidotId as string)

// 只获取 fullname 用于显示链接（轻量查询）
const { data: pageInfo } = useAsyncData(
  `page-info-${wikidotId.value}`,
  () => $fetch<{ fullname: string }>(`/api/pages/${wikidotId.value}`, {
    params: { fields: 'fullname' }
  }).catch(() => null),
  { watch: [wikidotId] }
)

const fullname = computed(() => pageInfo.value?.fullname || '')
const pageRef = ref<HTMLElement | null>(null)
const iframeRef = ref<HTMLIFrameElement | null>(null)
const iframeLoading = ref(true)

// 预览区最小高度，避免在极矮的视口里被压扁到不可用
const MIN_PREVIEW_HEIGHT = 420

// default 布局是 sticky header + main 的上下内边距 + footer，
// 原先硬编码的 calc(100vh - 60px) 会让 iframe 底部落到首屏之外；
// 改成按元素在文档中的实际位置算出可用高度。
function syncPreviewHeight() {
  const el = pageRef.value
  if (!el) return
  const offsetTop = el.getBoundingClientRect().top + window.scrollY
  const available = window.innerHeight - offsetTop
  el.style.setProperty('--preview-height', `${Math.max(MIN_PREVIEW_HEIGHT, Math.round(available))}px`)
}

let resizeFrame = 0
function scheduleSyncPreviewHeight() {
  if (resizeFrame) return
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0
    syncPreviewHeight()
  })
}

function onIframeLoad() {
  iframeLoading.value = false
}

onMounted(() => {
  syncPreviewHeight()
  window.addEventListener('resize', scheduleSyncPreviewHeight)

  const iframe = iframeRef.value
  if (!iframe) return
  // SSR hydration 可能导致 @load 丢失，手动绑定
  iframe.addEventListener('load', onIframeLoad, { once: true })
  // 如果 iframe 已经加载完成（浏览器可能在 hydration 前完成加载）
  try {
    if (iframe.contentDocument?.readyState === 'complete') {
      onIframeLoad()
    }
  } catch { /* cross-origin */ }
  // 兜底：最多 8 秒后显示
  setTimeout(() => { iframeLoading.value = false }, 8000)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', scheduleSyncPreviewHeight)
  if (resizeFrame) cancelAnimationFrame(resizeFrame)
})

useHead({
  title: computed(() => `预览 - ${fullname.value || wikidotId.value}`),
})
</script>

<style scoped>
.preview-page {
  display: flex;
  flex-direction: column;
  /* --preview-height 由 syncPreviewHeight() 在客户端量出；兜底值扣掉 header/内边距/footer */
  height: var(--preview-height, calc(100vh - 240px));
  min-height: 420px;
}

.preview-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 16px;
  border-bottom: 1px solid var(--g-border, #e5e7eb);
  background: var(--g-bg, #fff);
  flex-shrink: 0;
}

.preview-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--g-fg, #1a1a1a);
  margin: 0;
}

.back-link {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 6px;
  color: var(--g-fg-muted, #6b7280);
}
.back-link:hover {
  background: var(--g-hover, #f3f4f6);
}

.external-link {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: var(--g-fg-muted, #6b7280);
  border: 1px solid var(--g-border, #e5e7eb);
}
.external-link:hover {
  background: var(--g-hover, #f3f4f6);
}

.preview-frame-container {
  flex: 1;
  overflow: hidden;
  position: relative;
}

.loading-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--g-fg-muted, #6b7280);
  font-size: 14px;
  z-index: 1;
}

.preview-iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: none;
  transition: opacity 0.2s;
}
</style>
