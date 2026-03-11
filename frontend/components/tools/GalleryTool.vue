<template>
  <div class="gallery-shell space-y-6">
    <header class="gallery-head rounded-[1.6rem] border border-neutral-200/75 bg-white/88 px-5 py-5 shadow-lg dark:border-neutral-800/70 dark:bg-neutral-900/70">
      <div class="flex flex-wrap items-start justify-between gap-4">
        <div class="space-y-2">
          <p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-[rgb(var(--accent-strong))]">Cached Gallery</p>
          <h1 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-100">图片画廊</h1>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">
            浏览系统已缓存的页面插图，点击图片可放大查看，并支持一键复制图片 URL。
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2 text-xs">
          <span class="inline-flex items-center rounded-full border border-neutral-200/80 bg-white/80 px-3 py-1 text-neutral-600 dark:border-neutral-700/70 dark:bg-neutral-900/70 dark:text-neutral-300">
            当前 {{ galleryImages.length }} 张
          </span>
          <button
            type="button"
            @click="reload"
            class="inline-flex items-center gap-2 rounded-full border border-[var(--g-accent-border)] bg-[var(--g-accent-soft)] px-3 py-1.5 text-xs font-semibold text-[rgb(var(--accent-strong))] transition hover:bg-[var(--g-accent-medium)]"
          >
            <LucideIcon name="RefreshCcw" class="h-3.5 w-3.5" stroke-width="2" />
            换一批
          </button>
        </div>
      </div>
    </header>

    <div v-if="pending" class="rounded-lg border border-dashed border-neutral-200/80 px-5 py-12 text-center text-neutral-500 dark:border-neutral-700/70 dark:text-neutral-400">
      加载图片中…
    </div>
    <div v-else-if="error" class="rounded-lg border border-rose-200/70 bg-rose-50/80 px-5 py-12 text-center text-rose-600 dark:border-rose-500/35 dark:bg-rose-500/10 dark:text-rose-200">
      获取图片失败：{{ error.message || error }}
    </div>
    <div v-else>
      <div class="mb-4 grid gap-2 md:grid-cols-[minmax(0,1fr),minmax(130px,160px),minmax(180px,220px),auto]">
        <input
          v-model.trim="gallerySearch"
          type="search"
          placeholder="搜索标题 / 页面 ID / URL / 作者"
          class="w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none transition focus:border-[rgb(var(--accent-strong))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
        >
        <select
          v-model="galleryOrientationFilter"
          class="rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none transition focus:border-[rgb(var(--accent-strong))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
        >
          <option value="all">全部方向</option>
          <option value="panorama">超宽</option>
          <option value="landscape">横图</option>
          <option value="normal">标准</option>
          <option value="portrait">竖图</option>
          <option value="tall">超高</option>
          <option value="unknown">未知</option>
        </select>
        <select
          v-model="gallerySortMode"
          class="rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none transition focus:border-[rgb(var(--accent-strong))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
        >
          <option value="RANDOM">随机顺序</option>
          <option value="AREA_DESC">尺寸从大到小</option>
          <option value="AREA_ASC">尺寸从小到大</option>
          <option value="PAGE_ID_ASC">页面 ID 升序</option>
        </select>
        <button
          type="button"
          class="inline-flex items-center justify-center rounded-xl border border-neutral-200 px-3 py-2 text-sm font-medium text-neutral-500 transition hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-600 dark:hover:text-neutral-100"
          @click="resetFilters"
        >
          重置筛选
        </button>
      </div>

      <p class="mb-3 text-xs text-neutral-500 dark:text-neutral-400">
        匹配 {{ filteredGalleryImages.length }} / {{ galleryImages.length }} 张
      </p>

      <div v-if="!galleryImages.length" class="rounded-lg border border-dashed border-neutral-200/80 px-5 py-12 text-center text-neutral-500 dark:border-neutral-700/70 dark:text-neutral-400">
        暂无缓存图片可展示。
      </div>
      <div v-else-if="!filteredGalleryImages.length" class="rounded-lg border border-dashed border-neutral-200/80 px-5 py-12 text-center text-neutral-500 dark:border-neutral-700/70 dark:text-neutral-400">
        当前筛选条件下没有图片。
      </div>

      <div v-else class="gallery-grid">
        <article
          v-for="item in visibleGalleryImages"
          :key="item.id"
          class="gallery-item group"
        >
          <div
            class="gallery-card block overflow-hidden rounded-[1.1rem] border border-neutral-200/75 bg-white/94 shadow-lg transition duration-300 hover:-translate-y-1 hover:shadow-lg dark:border-neutral-700/70 dark:bg-neutral-900/76"
          >
            <button
              type="button"
              class="gallery-card__media gallery-card__media-btn relative w-full overflow-hidden border-b border-neutral-200/70 bg-neutral-100 dark:border-neutral-700/70 dark:bg-neutral-900"
              :class="`gallery-card__media--${item.orientation}`"
              :title="`放大查看：${item.caption}`"
              @click="openGalleryPreview(item)"
            >
              <img
                :src="item.imageSrc"
                :alt="item.caption"
                loading="lazy"
                :class="['h-full w-full transition duration-500 group-hover:scale-[1.04]', item.imageClass]"
                :style="item.imageStyle"
              >
              <div class="gallery-card__shade" />
              <div class="gallery-card__foil" />

              <div class="absolute left-2 top-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                <span class="inline-flex rounded-full border border-white/60 bg-black/35 px-2 py-0.5 font-semibold text-white backdrop-blur-sm">
                  {{ item.orientationLabel }}
                </span>
                <span
                  v-if="item.dimensionLabel"
                  class="inline-flex rounded-full border border-white/45 bg-black/28 px-2 py-0.5 font-medium text-white/90 backdrop-blur-sm"
                >
                  {{ item.dimensionLabel }}
                </span>
              </div>

              <div class="gallery-card__cta absolute inset-x-2 bottom-2 flex items-center justify-between rounded-lg border border-white/35 bg-black/35 px-2.5 py-1 text-[10px] text-white/95 backdrop-blur-sm">
                <span class="truncate">{{ item.pageIdLabel }}</span>
                <span>点击放大</span>
              </div>
            </button>

            <div class="space-y-1.5 px-3 py-3">
              <div class="line-clamp-2 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                {{ item.caption }}
              </div>
              <div class="flex items-center gap-2">
                <div class="min-w-0 flex-1 truncate text-[11px] text-neutral-500 dark:text-neutral-400">
                  {{ item.pageUrl || '无外链 URL' }}
                </div>
                <button
                  type="button"
                  class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 text-neutral-500 transition hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:text-neutral-300"
                  :title="copiedGalleryImageId === item.id ? '已复制图片 URL' : '复制图片 URL'"
                  @click="copyGalleryImageUrl(item)"
                >
                  <LucideIcon
                    v-if="copiedGalleryImageId === item.id"
                    name="Check"
                    class="h-3.5 w-3.5"
                    stroke-width="2"
                    aria-hidden="true"
                  />
                  <LucideIcon
                    v-else
                    name="Copy"
                    class="h-3.5 w-3.5"
                    stroke-width="2"
                    aria-hidden="true"
                  />
                </button>
                <NuxtLink
                  v-if="item.pageId"
                  :to="item.pageLink"
                  class="inline-flex items-center rounded-full border border-neutral-200 px-2.5 py-1 text-[11px] font-medium text-neutral-600 transition hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:text-neutral-300"
                >
                  查看页面
                </NuxtLink>
              </div>
            </div>
          </div>
        </article>
      </div>
      <div v-if="hasMoreGallery" class="mt-4 flex items-center justify-center">
        <button
          type="button"
          class="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:border-neutral-600 dark:hover:text-neutral-100"
          @click="galleryVisibleCount += GALLERY_PAGE_SIZE"
        >
          加载更多（剩余 {{ filteredGalleryImages.length - galleryVisibleCount }} 张）
        </button>
      </div>
      <ImagePreviewDialog
        v-if="galleryPreviewItem"
        v-model:open="galleryPreviewOpen"
        :src="galleryPreviewItem.imageSrcFull || galleryPreviewItem.imageSrc"
        :alt="galleryPreviewItem.caption"
        :title="galleryPreviewItem.caption"
        :copy-url="galleryPreviewItem.copyUrl"
        :link-to="galleryPreviewItem.pageId ? galleryPreviewItem.pageLink : null"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useAsyncData, useNuxtApp, useRuntimeConfig } from 'nuxt/app'
import LucideIcon from '~/components/LucideIcon.vue'
import ImagePreviewDialog from '~/components/media/ImagePreviewDialog.vue'
import { normalizeBffBase, pickExternalAssetUrl, resolveWithFallback } from '~/utils/assetUrl'
import { copyTextWithFallback } from '~/utils/clipboard'

const props = withDefaults(defineProps<{ dataKey?: string; initialLimit?: number }>(), {
  dataKey: 'tools-gallery',
  initialLimit: 30
})

const { $bff } = useNuxtApp() as {
  $bff: (path: string, options?: { params?: Record<string, unknown> }) => Promise<unknown>
}
const runtimeConfig = useRuntimeConfig()
const bffBase = normalizeBffBase((runtimeConfig?.public as any)?.bffBase)

const resolveAssetPath = (path?: string | null, fallback?: string | null, preferLow = true) => {
  const full = resolveWithFallback(path ?? '', fallback ?? '', bffBase)
  if (!preferLow) return full
  const low = resolveWithFallback(path ?? '', fallback ?? '', bffBase, { variant: 'low' })
  return low || full
}

const limit = ref(props.initialLimit)
const dataKey = computed(() => props.dataKey || 'tools-gallery')

const { data, pending, error, refresh } = await useAsyncData(
  () => dataKey.value,
  () => $bff('/page-images/random', { params: { limit: limit.value } }),
  { watch: [limit] }
)

type GalleryOrientation = 'unknown' | 'panorama' | 'tall' | 'landscape' | 'portrait' | 'normal'
type GallerySortMode = 'RANDOM' | 'AREA_DESC' | 'AREA_ASC' | 'PAGE_ID_ASC'

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
    authors?: Array<{
      displayName?: string
      userWikidotId?: number | null
    }>
  }
}

type GalleryViewItem = {
  id: number | string
  imageSrc: string
  imageSrcFull: string
  copyUrl: string
  imageClass: string
  imageStyle: string
  caption: string
  pageLink: string
  pageUrl: string
  pageId: number | null
  orientation: GalleryOrientation
  orientationLabel: string
  dimensionLabel: string
  pageIdLabel: string
  pixelArea: number
  authorText: string
}

const gallerySearch = ref('')
const galleryOrientationFilter = ref<GalleryOrientation | 'all'>('all')
const gallerySortMode = ref<GallerySortMode>('RANDOM')
const galleryPreviewOpen = ref(false)
const galleryPreviewItem = ref<GalleryViewItem | null>(null)
const copiedGalleryImageId = ref<number | string | null>(null)
let galleryCopyTimer: ReturnType<typeof setTimeout> | null = null

const galleryImagesRaw = computed<GalleryImage[]>(() => {
  const value = data.value
  return Array.isArray(value) ? (value as GalleryImage[]) : []
})

function orientationLabel(value: GalleryOrientation) {
  switch (value) {
    case 'panorama':
      return '超宽'
    case 'tall':
      return '超高'
    case 'landscape':
      return '横图'
    case 'portrait':
      return '竖图'
    case 'normal':
      return '标准'
    default:
      return '未知'
  }
}

const galleryImages = computed<GalleryViewItem[]>(() => {
  return galleryImagesRaw.value
    .map((item) => {
      const width = Number(item.asset?.width ?? item.width ?? 0)
      const height = Number(item.asset?.height ?? item.height ?? 0)
      const ratio = width > 0 && height > 0 ? width / height : null
      const orientation: GalleryOrientation = ratio == null
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
      const imageClass = 'object-cover'
      const imageStyle = 'display: block; width: 100%; height: 100%;'
      const fullSrc = resolveAssetPath(item.imageUrl, item.displayUrl ?? item.normalizedUrl ?? item.originUrl, false)
      const imageSrc = resolveAssetPath(item.imageUrl, item.displayUrl ?? item.normalizedUrl ?? item.originUrl, true)
      const copyUrl = pickExternalAssetUrl(item.displayUrl, item.originUrl, item.normalizedUrl) || fullSrc || imageSrc
      const pageId = Number(item.page?.wikidotId ?? 0)
      const normalizedPageId = Number.isFinite(pageId) && pageId > 0 ? pageId : null
      const caption = (() => {
        const title = item.page?.title?.trim() || '未命名页面'
        const alt = item.page?.alternateTitle?.trim()
        return alt ? `${title} - ${alt}` : title
      })()
      const pageLink = normalizedPageId ? `/page/${normalizedPageId}` : '#'
      const pageUrl = item.page?.url || ''
      const authorText = (item.page?.authors ?? [])
        .map((author) => String(author?.displayName || '').trim())
        .filter(Boolean)
        .join(' ')

      if (!imageSrc) {
        return null
      }

      return {
        id: item.pageVersionImageId ?? `${item.pageVersionId}-${imageSrc}`,
        imageSrc,
        imageSrcFull: fullSrc || imageSrc,
        copyUrl,
        imageClass,
        imageStyle,
        caption,
        pageLink,
        pageUrl,
        pageId: normalizedPageId,
        orientation,
        orientationLabel: orientationLabel(orientation),
        dimensionLabel: width > 0 && height > 0 ? `${width}×${height}` : '',
        pageIdLabel: normalizedPageId ? `#${normalizedPageId}` : '未绑定页面',
        pixelArea: width > 0 && height > 0 ? width * height : 0,
        authorText
      }
    })
    .filter((item): item is GalleryViewItem => item !== null)
})

const normalizedGallerySearch = computed(() => gallerySearch.value.trim().toLowerCase())

const searchIndex = computed(() => {
  const map = new Map<number | string, string>()
  for (const item of galleryImages.value) {
    map.set(item.id, `${item.caption} ${item.pageIdLabel} ${item.pageUrl} ${item.orientationLabel} ${item.authorText}`.toLowerCase())
  }
  return map
})

const filteredGalleryImages = computed<GalleryViewItem[]>(() => {
  const keyword = normalizedGallerySearch.value
  const filtered = galleryImages.value.filter((item) => {
    if (galleryOrientationFilter.value !== 'all' && item.orientation !== galleryOrientationFilter.value) {
      return false
    }
    if (!keyword) return true
    const target = searchIndex.value.get(item.id) ?? ''
    return target.includes(keyword)
  })
  if (gallerySortMode.value === 'RANDOM') {
    return filtered
  }
  return [...filtered].sort((a, b) => {
    if (gallerySortMode.value === 'AREA_DESC') {
      const areaDiff = b.pixelArea - a.pixelArea
      if (areaDiff !== 0) return areaDiff
      return a.caption.localeCompare(b.caption, 'zh-CN')
    }
    if (gallerySortMode.value === 'AREA_ASC') {
      const areaDiff = a.pixelArea - b.pixelArea
      if (areaDiff !== 0) return areaDiff
      return a.caption.localeCompare(b.caption, 'zh-CN')
    }
    const pageA = a.pageId ?? Number.POSITIVE_INFINITY
    const pageB = b.pageId ?? Number.POSITIVE_INFINITY
    if (pageA !== pageB) return pageA - pageB
    return a.caption.localeCompare(b.caption, 'zh-CN')
  })
})

const GALLERY_PAGE_SIZE = 24
const galleryVisibleCount = ref(GALLERY_PAGE_SIZE)
const visibleGalleryImages = computed(() => filteredGalleryImages.value.slice(0, galleryVisibleCount.value))
const hasMoreGallery = computed(() => filteredGalleryImages.value.length > galleryVisibleCount.value)

watch([gallerySearch, galleryOrientationFilter, gallerySortMode], () => {
  galleryVisibleCount.value = GALLERY_PAGE_SIZE
})

function resetFilters() {
  gallerySearch.value = ''
  galleryOrientationFilter.value = 'all'
  gallerySortMode.value = 'RANDOM'
  galleryVisibleCount.value = GALLERY_PAGE_SIZE
}

const reload = async () => {
  await refresh()
}

function openGalleryPreview(item: GalleryViewItem) {
  galleryPreviewItem.value = item
  galleryPreviewOpen.value = true
}

async function copyGalleryImageUrl(item: GalleryViewItem) {
  const target = item.copyUrl || item.imageSrcFull || item.imageSrc
  if (!target) return
  const copied = await copyTextWithFallback(target, '请复制图片 URL')
  if (!copied) return

  copiedGalleryImageId.value = item.id
  if (galleryCopyTimer) clearTimeout(galleryCopyTimer)
  galleryCopyTimer = setTimeout(() => {
    if (copiedGalleryImageId.value === item.id) copiedGalleryImageId.value = null
  }, 1800)
}

onBeforeUnmount(() => {
  if (galleryCopyTimer) {
    clearTimeout(galleryCopyTimer)
    galleryCopyTimer = null
  }
})
</script>

<style scoped>
.gallery-shell {
  position: relative;
}

.gallery-head {
  position: relative;
  overflow: hidden;
}

.gallery-head::before,
.gallery-head::after {
  content: '';
  pointer-events: none;
  position: absolute;
  border-radius: 999px;
  filter: blur(32px);
}

.gallery-head::before {
  left: -5rem;
  top: -5rem;
  width: 12rem;
  height: 12rem;
  background: var(--g-accent-strong);
}

.gallery-head::after {
  right: -5rem;
  bottom: -5rem;
  width: 11rem;
  height: 11rem;
  background: var(--g-accent-strong);
}

.gallery-grid {
  display: grid;
  grid-template-columns: 1fr;
  gap: 1rem;
}

@media (min-width: 720px) {
  .gallery-grid {
    display: block;
    column-count: 2;
    column-gap: 1rem;
  }
}

@media (min-width: 1120px) {
  .gallery-grid {
    column-count: 3;
  }
}

@media (min-width: 1500px) {
  .gallery-grid {
    column-count: 4;
  }
}

.gallery-item {
  break-inside: avoid;
  -webkit-column-break-inside: avoid;
  margin-bottom: 1rem;
}

.gallery-card {
  position: relative;
}

.gallery-card__media {
  min-height: 13rem;
}

.gallery-card__media-btn {
  display: block;
  width: 100%;
  padding: 0;
  border: none;
  text-align: left;
  cursor: zoom-in;
}

.gallery-card__media-btn:focus-visible {
  outline: 2px solid var(--g-accent-border);
  outline-offset: -2px;
}

.gallery-card__media--panorama {
  min-height: 10.5rem;
}

.gallery-card__media--tall {
  min-height: 19rem;
}

.gallery-card__media--landscape {
  min-height: 12.5rem;
}

.gallery-card__media--portrait {
  min-height: 17rem;
}

.gallery-card__shade {
  pointer-events: none;
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, rgba(15, 23, 42, 0.06), transparent 36%, rgba(15, 23, 42, 0.4)),
    linear-gradient(124deg, rgba(255, 255, 255, 0.22), transparent 44%);
}

.gallery-card__foil {
  pointer-events: none;
  position: absolute;
  inset: -16%;
  background: linear-gradient(118deg, transparent 24%, rgba(255, 255, 255, 0.46) 38%, transparent 52%);
  opacity: 0.56;
  transform: translateX(-30%);
  transition: transform 0.72s ease, opacity 0.4s ease;
  mix-blend-mode: screen;
}

.group:hover .gallery-card__foil {
  opacity: 0.82;
  transform: translateX(35%);
}

.gallery-card__cta {
  transform: translateY(4px);
  opacity: 0.94;
  transition: transform 0.25s ease, opacity 0.25s ease;
}

.group:hover .gallery-card__cta {
  transform: translateY(0);
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .gallery-card,
  .gallery-card__foil,
  .gallery-card__cta {
    transition: none !important;
  }
}
</style>
