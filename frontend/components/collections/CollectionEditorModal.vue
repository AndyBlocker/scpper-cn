<template>
  <Teleport to="body">
    <transition name="fade">
      <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-neutral-900/70 backdrop-blur-sm px-4 py-8">
        <div class="relative w-full max-w-2xl rounded-3xl border border-white/10 bg-white/95 p-6 shadow-2xl dark:border-neutral-700 dark:bg-neutral-950/90">
          <button
            type="button"
            class="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-neutral-200 text-neutral-500 hover:text-neutral-800 dark:border-neutral-700 dark:text-neutral-300 dark:hover:text-white"
            aria-label="关闭"
            @click="$emit('close')"
          >
            <LucideIcon name="X" class="h-4.5 w-4.5" />
          </button>
          <header class="mb-6 space-y-2">
            <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{{ title }}</h2>
            <p class="text-sm text-neutral-600 dark:text-neutral-400">
              {{ subtitle }}
            </p>
          </header>

          <form class="space-y-5" @submit.prevent="handleSubmit">
            <div class="space-y-2">
              <label class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">名称</label>
              <input
                v-model="local.title"
                type="text"
                maxlength="80"
                required
                class="w-full rounded-xl border border-neutral-200 bg-white/80 px-4 py-3 text-sm text-neutral-800 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-100"
                placeholder="收藏夹名称"
              >
            </div>

            <div class="grid gap-4 md:grid-cols-2">
              <div class="space-y-2">
                <label class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">简介</label>
                <textarea
                  v-model="local.description"
                  rows="4"
                  maxlength="800"
                  class="w-full rounded-xl border border-neutral-200 bg-white/80 px-4 py-3 text-sm text-neutral-800 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-100"
                  placeholder="向他人介绍这个收藏夹（可选）"
                />
                <p class="text-right text-[11px] text-neutral-400 dark:text-neutral-500">{{ (local.description?.length || 0) }}/800</p>
              </div>
              <div class="space-y-2">
                <label class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">个人备注</label>
                <textarea
                  v-model="local.notes"
                  rows="4"
                  maxlength="1200"
                  class="w-full rounded-xl border border-neutral-200 bg-white/80 px-4 py-3 text-sm text-neutral-800 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-100"
                  placeholder="只有自己可见的笔记（可选）"
                />
                <p class="text-right text-[11px] text-neutral-400 dark:text-neutral-500">{{ (local.notes?.length || 0) }}/1200</p>
              </div>
            </div>

            <div class="space-y-2">
              <label class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">封面图片链接</label>
              <input
                v-model="local.coverImageUrl"
                type="url"
                maxlength="400"
                class="w-full rounded-xl border border-neutral-200 bg-white/80 px-4 py-3 text-sm text-neutral-800 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-100"
                placeholder="https://example.com/cover.jpg"
              >
              <p class="text-[11px] text-neutral-400 dark:text-neutral-500">建议使用 1200×640 或更高分辨率的图片，链接需可公开访问。</p>
              <div
                v-if="local.coverImageUrl"
                class="space-y-3 rounded-2xl border border-neutral-200 bg-neutral-50/80 p-4 dark:border-neutral-700 dark:bg-neutral-900/50"
              >
                <div class="flex items-center justify-between text-xs font-medium text-neutral-600 dark:text-neutral-300">
                  <span>封面预览与位置</span>
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/90 px-3 py-1 text-[11px] font-semibold text-neutral-600 transition hover:border-[rgba(var(--accent),0.35)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                    @click="resetCoverTransform"
                  >
                    <LucideIcon name="RefreshCcw" class="h-3.5 w-3.5" />
                    重置
                  </button>
                </div>
                <div
                  ref="coverPreviewRef"
                  class="relative mt-3 aspect-[1200/640] w-full select-none overflow-hidden rounded-xl border border-white/70 bg-neutral-200/60 dark:border-white/10 dark:bg-neutral-800/60"
                  @pointerdown="startPreviewDrag"
                  @wheel.prevent="handleWheelZoom"
                >
                  <div
                    class="absolute inset-0 bg-cover bg-center transition-all duration-150 ease-out"
                    :style="previewStyle"
                  />
                  <div class="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-black/5 to-transparent" />
                  <div class="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-between gap-2 bg-gradient-to-t from-black/55 via-black/10 to-transparent p-3 text-[11px] text-white/80">
                    <span>拖拽背景以调整</span>
                    <span>垂直 {{ local.coverImageOffsetY.toFixed(0) }}% ｜ 水平 {{ local.coverImageOffsetX.toFixed(0) }}%</span>
                  </div>
                </div>
                <div class="space-y-2 text-xs text-neutral-500 dark:text-neutral-400">
                  <div class="flex items-center gap-3">
                    <LucideIcon name="ArrowUpDown" class="h-4 w-4" />
                    <input
                      v-model.number="local.coverImageOffsetY"
                      type="range"
                      min="-60"
                      max="60"
                      step="1"
                      class="flex-1 accent-[rgb(var(--accent))]"
                      @input="local.coverImageOffsetY = clampOffset(local.coverImageOffsetY)"
                    >
                    <span class="w-20 text-right font-medium">垂直 {{ local.coverImageOffsetY.toFixed(0) }}%</span>
                  </div>
                  <div class="flex items-center gap-3">
                    <LucideIcon name="ArrowLeftRight" class="h-4 w-4" />
                    <input
                      v-model.number="local.coverImageOffsetX"
                      type="range"
                      min="-60"
                      max="60"
                      step="1"
                      class="flex-1 accent-[rgb(var(--accent))]"
                      @input="local.coverImageOffsetX = clampOffset(local.coverImageOffsetX)"
                    >
                    <span class="w-20 text-right font-medium">水平 {{ local.coverImageOffsetX.toFixed(0) }}%</span>
                  </div>
                  <div class="flex items-center gap-3">
                    <LucideIcon name="ZoomIn" class="h-4 w-4" />
                    <input
                      v-model.number="local.coverImageScale"
                      type="range"
                      min="0.75"
                      max="2.5"
                      step="0.05"
                      class="flex-1 accent-[rgb(var(--accent))]"
                      @input="local.coverImageScale = clampScale(local.coverImageScale)"
                    >
                    <span class="w-24 text-right font-medium">缩放 ×{{ local.coverImageScale.toFixed(2) }}</span>
                  </div>
                </div>
              </div>
            </div>

            <div class="grid gap-4 md:grid-cols-2">
              <label class="flex items-start gap-3 rounded-xl border border-neutral-200 bg-white/80 p-4 dark:border-neutral-700 dark:bg-neutral-900/60">
                <input
                  v-model="local.isDefault"
                  type="checkbox"
                  class="mt-1 h-4 w-4 rounded border-neutral-300 text-[rgb(var(--accent))] focus:ring-[rgb(var(--accent))]"
                >
                <div class="space-y-1">
                  <div class="text-sm font-medium text-neutral-800 dark:text-neutral-100">设为默认收藏夹</div>
                  <p class="text-xs text-neutral-500 dark:text-neutral-400">收藏页面时将默认选中该收藏夹，随时可以调整。</p>
                </div>
              </label>
              <div class="space-y-3 rounded-xl border border-neutral-200 bg-white/80 p-4 dark:border-neutral-700 dark:bg-neutral-900/60">
                <div class="flex items-center justify-between">
                  <div class="text-sm font-medium text-neutral-800 dark:text-neutral-100">公开展示</div>
                  <button
                    type="button"
                    :class="[
                      'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold transition',
                      local.visibility === 'PUBLIC'
                        ? 'bg-[rgba(var(--accent),0.15)] text-[rgb(var(--accent))]'
                        : 'bg-neutral-200/60 text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300'
                    ]"
                    @click="toggleVisibility"
                  >
                    <LucideIcon :name="local.visibility === 'PUBLIC' ? 'Globe2' : 'Lock'" class="h-3.5 w-3.5" />
                    <span>{{ local.visibility === 'PUBLIC' ? '公开' : '私密' }}</span>
                  </button>
                </div>
                <p class="text-xs text-neutral-500 dark:text-neutral-400">
                  公开后，收藏夹会展示在你的个人主页，任何人均可浏览。
                </p>
                <p v-if="visibilityHint" class="rounded-lg bg-amber-100/60 px-3 py-2 text-[11px] text-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
                  {{ visibilityHint }}
                </p>
              </div>
            </div>

            <div class="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                class="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white/80 px-4 py-2 text-sm font-semibold text-neutral-600 hover:border-[rgba(var(--accent),0.3)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                @click="$emit('close')"
              >
                取消
              </button>
              <button
                type="submit"
                class="inline-flex items-center gap-2 rounded-full bg-[rgb(var(--accent))] px-5 py-2 text-sm font-semibold text-white shadow-[0_12px_30px_rgba(37,99,235,0.35)] transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="saving || !local.title.trim()"
              >
                <LucideIcon v-if="saving" name="Loader2" class="h-4.5 w-4.5 animate-spin" />
                <span>{{ submitLabel }}</span>
              </button>
            </div>
          </form>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { CollectionSummary, CollectionVisibility } from '~/composables/useCollections'
import { useAuth } from '~/composables/useAuth'

const props = defineProps<{
  open: boolean
  saving?: boolean
  mode: 'create' | 'edit'
  collection?: CollectionSummary | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'submit', payload: {
    title: string
    description: string | null
    notes: string | null
    coverImageUrl: string | null
    coverImageOffsetX: number
    coverImageOffsetY: number
    coverImageScale: number
    isDefault: boolean
    visibility: CollectionVisibility
  }): void
}>()

const { user, isAuthenticated } = useAuth()

const local = reactive({
  title: '',
  description: '' as string | null,
  notes: '' as string | null,
  coverImageUrl: '' as string | null,
  coverImageOffsetX: 0,
  coverImageOffsetY: 0,
  coverImageScale: 1,
  isDefault: false,
  visibility: 'PRIVATE' as CollectionVisibility
})

watch(
  () => props.collection,
  (next) => {
    if (next) {
      local.title = next.title
      local.description = next.description
      local.notes = next.notes
      local.coverImageUrl = next.coverImageUrl
      local.coverImageOffsetX = clampOffset(next.coverImageOffsetX ?? 0)
      local.coverImageOffsetY = clampOffset(next.coverImageOffsetY ?? 0)
      local.coverImageScale = clampScale(next.coverImageScale ?? 1)
      local.isDefault = next.isDefault
      local.visibility = next.visibility
    } else {
      reset()
    }
  },
  { immediate: true }
)

watch(
  () => props.open,
  (open) => {
    if (open && props.mode === 'create') {
      reset()
      local.isDefault = props.collection?.isDefault === true
    }
  }
)

const coverPreviewRef = ref<HTMLElement | null>(null)

watch(
  () => local.coverImageUrl,
  (url) => {
    if (!url) {
      local.coverImageOffsetX = 0
      local.coverImageOffsetY = 0
      local.coverImageScale = 1
    }
  }
)

function clampOffset(value: number | null | undefined): number {
  if (!Number.isFinite(Number(value))) return 0
  const parsed = Number(value)
  if (Number.isNaN(parsed)) return 0
  return Math.min(60, Math.max(-60, parsed))
}

function coverPosition(offsetX: number | null | undefined, offsetY: number | null | undefined): string {
  const clampedX = clampOffset(offsetX)
  const clampedY = clampOffset(offsetY)
  return `${50 - clampedX}% ${50 - clampedY}%`
}

function clampScale(value: number | null | undefined): number {
  if (!Number.isFinite(Number(value))) return 1
  const parsed = Number(value)
  if (Number.isNaN(parsed)) return 1
  return Math.min(2.5, Math.max(0.75, parsed))
}

function coverSize(scale: number | null | undefined): string {
  const value = clampScale(scale)
  return `${value * 100}% auto`
}

const previewStyle = computed(() => {
  if (!local.coverImageUrl) return {}
  return {
    backgroundImage: `url(${local.coverImageUrl})`,
    backgroundPosition: coverPosition(local.coverImageOffsetX, local.coverImageOffsetY),
    backgroundSize: coverSize(local.coverImageScale)
  }
})

function resetCoverTransform() {
  local.coverImageOffsetX = 0
  local.coverImageOffsetY = 0
  local.coverImageScale = 1
}

function startPreviewDrag(event: PointerEvent) {
  if (!coverPreviewRef.value) return
  coverPreviewRef.value.setPointerCapture(event.pointerId)
  const rect = coverPreviewRef.value.getBoundingClientRect()
  const width = rect.width || 1
  const height = rect.height || 1
  const startX = event.clientX
  const startY = event.clientY
  const startOffsetX = clampOffset(local.coverImageOffsetX)
  const startOffsetY = clampOffset(local.coverImageOffsetY)

  const handleMove = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return
    const deltaPercentY = ((e.clientY - startY) / height) * 100
    const deltaPercentX = ((e.clientX - startX) / width) * 100
    local.coverImageOffsetY = clampOffset(startOffsetY + deltaPercentY)
    local.coverImageOffsetX = clampOffset(startOffsetX + deltaPercentX)
  }

  const stop = (e: PointerEvent) => {
    if (e.pointerId !== event.pointerId) return
    coverPreviewRef.value?.removeEventListener('pointermove', handleMove)
    coverPreviewRef.value?.removeEventListener('pointerup', stop)
    coverPreviewRef.value?.removeEventListener('pointercancel', stop)
    try {
      coverPreviewRef.value?.releasePointerCapture(event.pointerId)
    } catch {
      // ignore release errors
    }
  }

  coverPreviewRef.value.addEventListener('pointermove', handleMove)
  coverPreviewRef.value.addEventListener('pointerup', stop)
  coverPreviewRef.value.addEventListener('pointercancel', stop)
}

function handleWheelZoom(event: WheelEvent) {
  const direction = event.deltaY > 0 ? -0.05 : 0.05
  local.coverImageScale = clampScale(local.coverImageScale + direction)
}

const title = computed(() => props.mode === 'create' ? '新建收藏夹' : '编辑收藏夹')
const subtitle = computed(() => props.mode === 'create'
  ? '给收藏夹取一个易于识别的名字，并可填写简介、备注与封面。'
  : '修改收藏夹信息，公开状态与默认状态可以随时调整。'
)
const submitLabel = computed(() => props.mode === 'create' ? '创建收藏夹' : '保存修改')

const visibilityHint = computed(() => {
  if (local.visibility === 'PRIVATE') {
    return '仅自己可见，可用于暂存或私密整理。'
  }
  if (!isAuthenticated.value || !user.value?.linkedWikidotId) {
    return '公开前需要绑定 Wikidot 账号，系统会自动校验。'
  }
  return '公开收藏夹会显示在个人主页，包含标题、简介与摘录。'
})

function toggleVisibility() {
  local.visibility = local.visibility === 'PUBLIC' ? 'PRIVATE' : 'PUBLIC'
}

function reset() {
  local.title = props.collection?.title ?? ''
  local.description = props.collection?.description ?? null
  local.notes = props.collection?.notes ?? null
  local.coverImageUrl = props.collection?.coverImageUrl ?? null
  local.coverImageOffsetX = clampOffset(props.collection?.coverImageOffsetX ?? 0)
  local.coverImageOffsetY = clampOffset(props.collection?.coverImageOffsetY ?? 0)
  local.coverImageScale = clampScale(props.collection?.coverImageScale ?? 1)
  local.isDefault = props.collection?.isDefault ?? false
  local.visibility = props.collection?.visibility ?? 'PRIVATE'
}

function handleSubmit() {
  emit('submit', {
    title: local.title.trim(),
    description: local.description?.trim() || null,
    notes: local.notes?.trim() || null,
    coverImageUrl: local.coverImageUrl?.trim() || null,
    coverImageOffsetX: clampOffset(local.coverImageOffsetX),
    coverImageOffsetY: clampOffset(local.coverImageOffsetY),
    coverImageScale: clampScale(local.coverImageScale),
    isDefault: local.isDefault,
    visibility: local.visibility
  })
}
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.25s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
