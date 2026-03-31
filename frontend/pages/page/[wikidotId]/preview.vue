<template>
  <div class="preview-page">
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
const iframeRef = ref<HTMLIFrameElement | null>(null)
const iframeLoading = ref(true)

function onIframeLoad() {
  iframeLoading.value = false
}

onMounted(() => {
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

useHead({
  title: computed(() => `预览 - ${fullname.value || wikidotId.value}`),
})
</script>

<style scoped>
.preview-page {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 60px);
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
