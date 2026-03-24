<template>
  <section
    v-if="pending || hasImages || error"
    id="page-images"
    class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm"
  >
    <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
      <div class="space-y-1">
        <div class="flex items-center gap-2">
          <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-200">相关图片</h3>
          <button
            type="button"
            class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-[var(--g-accent)] hover:border-[var(--g-accent-border)] dark:text-neutral-400 dark:hover:text-[var(--g-accent)]"
            @click="$emit('copy-anchor', 'page-images')"
            :title="copiedAnchorId === 'page-images' ? '已复制链接' : '复制该段落链接'"
          >
            <LucideIcon v-if="copiedAnchorId === 'page-images'" name="Check" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            <LucideIcon v-else name="Link" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
          </button>
        </div>
        <p v-if="hasImages" class="text-xs text-neutral-500 dark:text-neutral-400">
          第 {{ currentPage }} / {{ totalPages }} 页 · 展示 {{ rangeLabel }} · 共 {{ images.length }} 张
        </p>
        <p v-else class="text-xs text-neutral-500 dark:text-neutral-400">
          暂无可用图片资源。
        </p>
      </div>
      <div v-if="hasImages" class="flex flex-wrap items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
        <div class="inline-flex items-center gap-2">
          <span class="hidden sm:inline">每行数量</span>
          <div class="inline-flex overflow-hidden rounded-full border border-neutral-200 dark:border-neutral-700 bg-neutral-100/60 dark:bg-neutral-800/60">
            <button
              v-for="option in sizeOptions"
              :key="option.value"
              type="button"
              @click="localColumns = option.value"
              :class="[
                'px-3 py-1 font-medium transition-colors',
                localColumns === option.value
                  ? 'bg-white dark:bg-neutral-700 text-[var(--g-accent)] shadow'
                  : 'text-neutral-600 dark:text-neutral-300 hover:text-[var(--g-accent)]'
              ]"
            >
              {{ option.label }} ({{ option.value }})
            </button>
          </div>
        </div>
        <div class="inline-flex items-center gap-2">
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-full border border-neutral-200 dark:border-neutral-700 px-3 py-1 text-neutral-600 dark:text-neutral-300 hover:border-[var(--g-accent)] hover:text-[var(--g-accent)] disabled:opacity-40"
            @click="localPage = Math.max(1, localPage - 1)"
            :disabled="localPage <= 1"
          >上一页</button>
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded-full border border-neutral-200 dark:border-neutral-700 px-3 py-1 text-neutral-600 dark:text-neutral-300 hover:border-[var(--g-accent)] hover:text-[var(--g-accent)] disabled:opacity-40"
            @click="localPage = Math.min(totalPages, localPage + 1)"
            :disabled="localPage >= totalPages"
          >下一页</button>
        </div>
      </div>
    </div>

    <div v-if="pending" class="mt-6 text-sm text-neutral-500 dark:text-neutral-400">正在加载图片…</div>
    <div v-else-if="error" class="mt-6 rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50/80 dark:bg-neutral-900/60 p-6 text-sm text-neutral-600 dark:text-neutral-400">
      加载图片失败。
      <button type="button" class="ml-2 inline-flex items-center gap-1 text-[var(--g-accent)] hover:underline" @click="$emit('refresh')">重试</button>
    </div>
    <div v-else-if="hasImages" class="page-images-grid mt-4" :style="gridStyle">
      <figure
        v-for="img in paginatedImages"
        :key="img.imageKey"
        class="group space-y-2"
      >
        <button
          type="button"
          class="page-image-trigger relative w-full overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900/40"
          :style="img.aspectStyle"
          :title="`放大查看：${img.label || pageDisplayTitle}`"
          @click="openPreview(img)"
        >
          <img
            :src="img.imageSrc"
            :srcset="img.imageSrcFull && img.imageSrc ? `${img.imageSrc} 1x, ${img.imageSrcFull} 2x` : undefined"
            :alt="img.label || pageDisplayTitle"
            loading="lazy"
            class="absolute inset-0 h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
          >
          <span class="page-image-zoom-chip">点击放大</span>
        </button>
        <figcaption class="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
          <span class="min-w-0 flex-1 truncate">
            {{ img.label || '图片资源' }}
          </span>
          <button
            type="button"
            class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-neutral-200 text-neutral-500 transition hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:text-neutral-300"
            :title="copiedImageKey === img.imageKey ? '已复制图片 URL' : '复制图片 URL'"
            @click="copyImageUrl(img)"
          >
            <LucideIcon
              v-if="copiedImageKey === img.imageKey"
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
        </figcaption>
      </figure>
    </div>
    <div v-else class="mt-6 text-sm text-neutral-500 dark:text-neutral-400">暂无图片。</div>
    <ImagePreviewDialog
      v-if="previewItem"
      v-model:open="previewOpen"
      :src="previewItem.imageSrcFull || previewItem.imageSrc"
      :alt="previewItem.label || pageDisplayTitle"
      :title="previewItem.label || pageDisplayTitle"
      :copy-url="previewItem.copyUrl"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import ImagePreviewDialog from '~/components/media/ImagePreviewDialog.vue'
import { copyTextWithFallback } from '~/utils/clipboard'

type PageImageItem = {
  imageKey: string
  width: number
  height: number
  ratio: number | null
  orientation: 'unknown' | 'wide' | 'tall' | 'normal'
  aspectStyle: string
  label: string
  imageSrc: string
  imageSrcFull: string
  copyUrl: string
  pageVersionImageId?: number
  normalizedUrl?: string
  originUrl?: string
}

const props = defineProps<{
  images: PageImageItem[]
  pending: boolean
  error: any
  pageDisplayTitle: string
  copiedAnchorId: string | null
}>()

defineEmits<{
  'copy-anchor': [sectionId: string]
  'refresh': []
}>()

const sizeOptions = [
  { label: '小', value: 9 },
  { label: '中', value: 6 },
  { label: '大', value: 3 }
]

const localColumns = ref<number>(6)
const localPage = ref(1)

const hasImages = computed(() => props.images.length > 0)

const rows = computed(() => {
  const cols = localColumns.value
  if (cols >= 9) return 5
  if (cols >= 6) return 4
  return 3
})
const perPage = computed(() => Math.max(1, localColumns.value * rows.value))
const totalPages = computed(() => {
  if (!props.images.length) return 1
  return Math.max(1, Math.ceil(props.images.length / perPage.value))
})
const currentPage = computed(() => Math.max(1, Math.min(localPage.value, totalPages.value)))

const paginatedImages = computed(() => {
  const pageIndex = currentPage.value - 1
  const start = pageIndex * perPage.value
  return props.images.slice(start, start + perPage.value)
})

const rangeLabel = computed(() => {
  if (!props.images.length) return '0'
  const start = (currentPage.value - 1) * perPage.value + 1
  const end = Math.min(props.images.length, start + perPage.value - 1)
  return `${start} - ${end}`
})

const gridStyle = computed(() => ({
  '--columns': String(Math.max(1, Math.min(localColumns.value, 12)))
}))

type PreviewPayload = {
  imageKey: string
  label: string
  imageSrc: string
  imageSrcFull: string
  copyUrl: string
}
const previewOpen = ref(false)
const previewItem = ref<PreviewPayload | null>(null)
const copiedImageKey = ref<string | null>(null)
let copyTimer: ReturnType<typeof setTimeout> | null = null

function openPreview(img: PageImageItem) {
  previewItem.value = {
    imageKey: img.imageKey,
    label: img.label,
    imageSrc: img.imageSrc,
    imageSrcFull: img.imageSrcFull || img.imageSrc,
    copyUrl: img.copyUrl || img.imageSrcFull || img.imageSrc
  }
  previewOpen.value = true
}

async function copyImageUrl(img: PageImageItem) {
  const imageKey = img.imageKey
  const target = (img.copyUrl || img.imageSrcFull || img.imageSrc || '').trim()
  if (!imageKey || !target) return

  const copied = await copyTextWithFallback(target, '请复制图片 URL')
  if (!copied) return

  copiedImageKey.value = imageKey
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    if (copiedImageKey.value === imageKey) copiedImageKey.value = null
  }, 1800)
}

watch(() => props.images, (newImages, oldImages) => {
  // Full reset when images array changes identity (route navigation)
  if (newImages !== oldImages) {
    previewOpen.value = false
    previewItem.value = null
    copiedImageKey.value = null
    localPage.value = 1
  }
  if (localPage.value > totalPages.value) {
    localPage.value = totalPages.value
  }
  if (previewItem.value) {
    const exists = props.images.some((img) => img.imageKey === previewItem.value?.imageKey)
    if (!exists) {
      previewOpen.value = false
      previewItem.value = null
    }
  }
})

watch(localColumns, () => {
  localPage.value = 1
})
</script>

<style scoped>
.page-images-grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(var(--columns, 6), minmax(0, 1fr));
}

.page-image-trigger {
  display: block;
  width: 100%;
  padding: 0;
  border-width: 1px;
  text-align: left;
  cursor: zoom-in;
}

.page-image-trigger:focus-visible {
  outline: 2px solid var(--g-accent-border);
  outline-offset: 1px;
}

.page-image-zoom-chip {
  pointer-events: none;
  position: absolute;
  right: 0.5rem;
  bottom: 0.5rem;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.45);
  background: rgba(15, 23, 42, 0.48);
  padding: 0.15rem 0.5rem;
  font-size: 10px;
  line-height: 1.2;
  color: rgba(248, 250, 252, 0.95);
  opacity: 0.86;
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.group:hover .page-image-zoom-chip {
  opacity: 1;
  transform: translateY(-1px);
}

@media (max-width: 1024px) {
  .page-images-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .page-images-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 420px) {
  .page-images-grid {
    grid-template-columns: repeat(1, minmax(0, 1fr));
  }
}
</style>
