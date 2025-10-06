<template>
  <div class="space-y-6">
    <header class="space-y-2">
      <h1 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">图片画廊</h1>
      <p class="text-sm text-neutral-600 dark:text-neutral-400">
        浏览系统已缓存的页面插图，点击可跳转回对应页面。刷新可获取新的随机组合。
      </p>
    </header>

    <div v-if="pending" class="py-12 text-center text-neutral-500 dark:text-neutral-400">
      加载图片中…
    </div>
    <div v-else-if="error" class="py-12 text-center text-red-600 dark:text-red-400">
      获取图片失败：{{ error.message || error }}
    </div>
    <div v-else>
      <div v-if="!galleryImages.length" class="py-12 text-center text-neutral-500 dark:text-neutral-400">
        暂无缓存图片可展示。
      </div>
      <div v-else class="gallery-grid">
        <article
          v-for="item in galleryImages"
          :key="item.id"
          class="gallery-item group"
        >
          <NuxtLink
            :to="item.pageLink"
            class="block overflow-hidden rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white/95 dark:bg-neutral-900/80 shadow-sm hover:shadow-md transition-shadow"
          >
            <div class="relative w-full overflow-hidden bg-neutral-100 dark:bg-neutral-900">
              <img
                :src="item.imageSrc"
                :alt="item.caption"
                loading="lazy"
                :class="['transition-transform duration-200', item.imageClass, 'group-hover:scale-[1.03]']"
                :style="item.imageStyle"
              >
            </div>
            <div class="px-3 py-3 space-y-1">
              <div class="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">
                {{ item.caption }}
              </div>
              <div class="text-xs text-neutral-500 dark:text-neutral-400 truncate">
                {{ item.pageUrl }}
              </div>
            </div>
          </NuxtLink>
        </article>
      </div>

      <div class="flex items-center justify-center gap-3 pt-6">
        <button
          type="button"
          @click="reload"
          class="inline-flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium bg-[rgba(var(--accent),0.12)] text-[rgb(var(--accent))] hover:bg-[rgba(var(--accent),0.18)]"
        >
          <svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <polyline points="1 4 1 10 7 10"/>
            <polyline points="23 20 23 14 17 14"/>
            <path d="M20.49 9A9 9 0 0 0 6.21 4.56L1 10"/>
            <path d="M3.51 15A9 9 0 0 0 17.79 19.44L23 14"/>
          </svg>
          换一批
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAsyncData, useNuxtApp, useRuntimeConfig } from 'nuxt/app'

const props = withDefaults(defineProps<{ dataKey?: string; initialLimit?: number }>(), {
  dataKey: 'tools-gallery',
  initialLimit: 30
})

const { $bff } = useNuxtApp()
const runtimeConfig = useRuntimeConfig()
const rawBffBase = (runtimeConfig?.public as any)?.bffBase ?? '/api'
const bffBase = (() => {
  const base = typeof rawBffBase === 'string' ? rawBffBase.trim() : '/api'
  if (!base) return ''
  if (base === '/') return ''
  return base.replace(/\/+$/u, '')
})()

const resolveAssetPath = (path?: string | null, fallback?: string | null) => {
  const candidate = (path ?? '') || (fallback ?? '')
  if (!candidate) return ''
  if (/^https?:/i.test(candidate)) return candidate
  if (candidate.startsWith('//')) return `https:${candidate}`
  const suffix = candidate.startsWith('/') ? candidate : `/${candidate}`
  return `${bffBase}${suffix}`
}

const limit = ref(props.initialLimit)
const dataKey = computed(() => props.dataKey || 'tools-gallery')

const { data, pending, error, refresh } = await useAsyncData(
  () => dataKey.value,
  () => $bff('/page-images/random', { params: { limit: limit.value } }),
  { watch: [limit] }
)

type GalleryImage = {
  pageVersionImageId?: number
  pageVersionId?: number
  imageUrl?: string
  originUrl?: string
  displayUrl?: string
  normalizedUrl?: string
  asset?: {
    width?: number
    height?: number
  }
  width?: number
  height?: number
  page?: {
    wikidotId?: number
    title?: string
    alternateTitle?: string
    url?: string
  }
}

const galleryImagesRaw = computed<GalleryImage[]>(() => {
  const value = data.value
  return Array.isArray(value) ? (value as GalleryImage[]) : []
})

const galleryImages = computed(() => {
  return galleryImagesRaw.value
    .map(item => {
      const width = Number(item.asset?.width ?? item.width ?? 0)
      const height = Number(item.asset?.height ?? item.height ?? 0)
      const ratio = width > 0 && height > 0 ? width / height : null
      const orientation = ratio == null
        ? 'unknown'
        : ratio >= 2.2
          ? 'panorama'
          : ratio <= 0.45
            ? 'tall'
            : ratio >= 1.4
              ? 'landscape'
              : ratio <= 0.75
                ? 'portrait'
                : 'normal'
      const imageClass = orientation === 'normal' || orientation === 'portrait' || orientation === 'landscape' ? 'object-contain' : 'object-cover'
      const maxHeight = orientation === 'panorama' ? 260 : orientation === 'tall' ? 420 : 380
      const imageStyle = orientation === 'normal' || orientation === 'portrait' || orientation === 'landscape'
        ? 'display: block; width: 100%; height: auto;'
        : `display: block; width: 100%; max-height: ${maxHeight}px;`
      const imageSrc = resolveAssetPath(item.imageUrl, item.displayUrl ?? item.normalizedUrl ?? item.originUrl)
      const caption = (() => {
        const title = item.page?.title?.trim() || '未命名页面'
        const alt = item.page?.alternateTitle?.trim()
        return alt ? `${title} - ${alt}` : title
      })()
      const pageLink = item.page?.wikidotId ? `/page/${item.page.wikidotId}` : '#'
      const pageUrl = item.page?.url || ''

      if (!imageSrc) {
        return null
      }

      return {
        id: item.pageVersionImageId ?? `${item.pageVersionId}-${imageSrc}`,
        imageSrc,
        imageClass,
        imageStyle,
        caption,
        pageLink,
        pageUrl
      }
    })
    .filter(Boolean)
})

const reload = async () => {
  await refresh()
}
</script>

<style scoped>
.gallery-grid {
  column-count: 1;
  column-gap: 1.25rem;
}

@media (min-width: 640px) {
  .gallery-grid {
    column-count: 2;
  }
}

@media (min-width: 1024px) {
  .gallery-grid {
    column-count: 3;
  }
}

@media (min-width: 1440px) {
  .gallery-grid {
    column-count: 4;
  }
}

.gallery-item {
  break-inside: avoid;
  -webkit-column-break-inside: avoid;
  margin-bottom: 1.5rem;
}
</style>
