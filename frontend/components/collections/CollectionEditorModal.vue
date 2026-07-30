<template>
  <Teleport to="body">
    <transition name="fade">
      <div
        v-if="open"
        class="fixed inset-0 z-50 overflow-y-auto bg-neutral-900/70 px-4 py-4 backdrop-blur-sm sm:py-8"
      >
        <div class="flex min-h-full items-center justify-center">
          <div
            ref="dialogRef"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="dialogTitleId"
            :aria-describedby="dialogDescriptionId"
            tabindex="-1"
            class="relative max-h-[calc(100vh-2rem)] max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto overscroll-contain rounded-lg border border-white/10 bg-white p-4 shadow-2xl dark:border-neutral-700 dark:bg-neutral-950 sm:max-h-[calc(100vh-4rem)] sm:max-h-[calc(100dvh-4rem)] sm:p-6"
          >
          <button
            type="button"
            class="absolute right-4 top-4 inline-flex h-9 w-9 items-center justify-center rounded-full border border-neutral-200 text-neutral-500 hover:text-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:text-white"
            :aria-label="`关闭${title}`"
            :disabled="saving"
            @click="requestClose"
          >
            <LucideIcon name="X" class="h-4.5 w-4.5" />
          </button>
          <header class="mb-6 space-y-2 pr-12">
            <h2 :id="dialogTitleId" class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">{{ title }}</h2>
            <p :id="dialogDescriptionId" class="text-sm text-neutral-600 dark:text-neutral-400">
              {{ subtitle }}
            </p>
          </header>

          <form class="space-y-5" @submit.prevent="handleSubmit">
            <div class="space-y-2">
              <label
                for="collection-editor-title"
                class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400"
              >
                名称
              </label>
              <input
                id="collection-editor-title"
                ref="titleInputRef"
                v-model="local.title"
                type="text"
                maxlength="80"
                required
                class="w-full rounded-xl border border-neutral-200 bg-white/80 px-4 py-3 text-sm text-neutral-800 shadow-sm transition focus:border-[var(--g-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-100"
                placeholder="收藏夹名称"
              >
            </div>

            <div class="grid gap-4 md:grid-cols-2">
              <div class="space-y-2">
                <label
                  for="collection-editor-description"
                  class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400"
                >
                  简介
                </label>
                <textarea
                  id="collection-editor-description"
                  v-model="local.description"
                  rows="4"
                  maxlength="800"
                  aria-describedby="collection-editor-description-count"
                  class="w-full rounded-xl border border-neutral-200 bg-white/80 px-4 py-3 text-sm text-neutral-800 shadow-sm transition focus:border-[var(--g-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-100"
                  placeholder="向他人介绍这个收藏夹（可选）"
                />
                <p id="collection-editor-description-count" class="text-right text-[11px] text-neutral-400 dark:text-neutral-500">{{ (local.description?.length || 0) }}/800</p>
              </div>
              <div class="space-y-2">
                <label
                  for="collection-editor-notes"
                  class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400"
                >
                  个人备注
                </label>
                <textarea
                  id="collection-editor-notes"
                  v-model="local.notes"
                  rows="4"
                  maxlength="1200"
                  aria-describedby="collection-editor-notes-count"
                  class="w-full rounded-xl border border-neutral-200 bg-white/80 px-4 py-3 text-sm text-neutral-800 shadow-sm transition focus:border-[var(--g-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-100"
                  placeholder="只有自己可见的笔记（可选）"
                />
                <p id="collection-editor-notes-count" class="text-right text-[11px] text-neutral-400 dark:text-neutral-500">{{ (local.notes?.length || 0) }}/1200</p>
              </div>
            </div>

            <div class="space-y-2">
              <label
                for="collection-editor-cover-url"
                class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400"
              >
                封面图片链接
              </label>
              <input
                id="collection-editor-cover-url"
                v-model="local.coverImageUrl"
                type="url"
                maxlength="400"
                aria-describedby="collection-editor-cover-hint"
                class="w-full rounded-xl border border-neutral-200 bg-white/80 px-4 py-3 text-sm text-neutral-800 shadow-sm transition focus:border-[var(--g-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-100"
                placeholder="https://example.com/cover.jpg"
              >
              <p id="collection-editor-cover-hint" class="text-[11px] text-neutral-400 dark:text-neutral-500">建议使用 1200×640 或更高分辨率的图片，链接需可公开访问。</p>
              <div
                v-if="local.coverImageUrl"
                class="space-y-3 rounded-lg border border-neutral-200 bg-neutral-50/80 p-4 dark:border-neutral-700 dark:bg-neutral-900/50"
              >
                <div class="flex items-center justify-between text-xs font-medium text-neutral-600 dark:text-neutral-300">
                  <span>封面预览与位置</span>
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/90 px-3 py-1 text-[11px] font-semibold text-neutral-600 transition hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
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
                      id="collection-editor-cover-y"
                      v-model.number="local.coverImageOffsetY"
                      type="range"
                      min="-60"
                      max="60"
                      step="1"
                      class="flex-1 accent-[var(--g-accent)]"
                      @input="local.coverImageOffsetY = clampOffset(local.coverImageOffsetY)"
                    >
                    <label for="collection-editor-cover-y" class="w-20 text-right font-medium">垂直 {{ local.coverImageOffsetY.toFixed(0) }}%</label>
                  </div>
                  <div class="flex items-center gap-3">
                    <LucideIcon name="ArrowLeftRight" class="h-4 w-4" />
                    <input
                      id="collection-editor-cover-x"
                      v-model.number="local.coverImageOffsetX"
                      type="range"
                      min="-60"
                      max="60"
                      step="1"
                      class="flex-1 accent-[var(--g-accent)]"
                      @input="local.coverImageOffsetX = clampOffset(local.coverImageOffsetX)"
                    >
                    <label for="collection-editor-cover-x" class="w-20 text-right font-medium">水平 {{ local.coverImageOffsetX.toFixed(0) }}%</label>
                  </div>
                  <div class="flex items-center gap-3">
                    <LucideIcon name="ZoomIn" class="h-4 w-4" />
                    <input
                      id="collection-editor-cover-scale"
                      v-model.number="local.coverImageScale"
                      type="range"
                      min="0.75"
                      max="2.5"
                      step="0.05"
                      class="flex-1 accent-[var(--g-accent)]"
                      @input="local.coverImageScale = clampScale(local.coverImageScale)"
                    >
                    <label for="collection-editor-cover-scale" class="w-24 text-right font-medium">缩放 ×{{ local.coverImageScale.toFixed(2) }}</label>
                  </div>
                </div>
              </div>
            </div>

            <div class="grid gap-4 md:grid-cols-2">
              <label
                for="collection-editor-default"
                class="flex items-start gap-3 rounded-xl border border-neutral-200 bg-white/80 p-4 dark:border-neutral-700 dark:bg-neutral-900/60"
              >
                <input
                  id="collection-editor-default"
                  v-model="local.isDefault"
                  type="checkbox"
                  class="mt-1 h-4 w-4 rounded border-neutral-300 text-[var(--g-accent)] focus:ring-[var(--g-accent)]"
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
                    role="switch"
                    :aria-checked="local.visibility === 'PUBLIC'"
                    aria-describedby="collection-editor-visibility-hint"
                    aria-label="公开展示收藏夹"
                    :disabled="local.visibility === 'PRIVATE' && !canPublish"
                    :class="[
                      'inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-50',
                      local.visibility === 'PUBLIC'
                        ? 'bg-[var(--g-accent-medium)] text-[var(--g-accent)]'
                        : 'bg-neutral-200/60 text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300'
                    ]"
                    @click="toggleVisibility"
                  >
                    <LucideIcon :name="local.visibility === 'PUBLIC' ? 'Globe2' : 'Lock'" class="h-3.5 w-3.5" />
                    <span>{{ local.visibility === 'PUBLIC' ? '公开' : '私密' }}</span>
                  </button>
                </div>
                <p
                  id="collection-editor-visibility-hint"
                  class="text-xs text-neutral-500 dark:text-neutral-400"
                >
                  公开后，收藏夹会展示在你的个人主页，任何人均可浏览。
                </p>
                <p v-if="visibilityHint" class="rounded-lg bg-amber-100/60 px-3 py-2 text-[11px] text-amber-700 dark:bg-amber-900/20 dark:text-amber-200">
                  {{ visibilityHint }}
                  <NuxtLink
                    v-if="!canPublish"
                    to="/account/connections"
                    class="ml-1 font-semibold underline underline-offset-2"
                  >
                    前往绑定
                  </NuxtLink>
                </p>
              </div>
            </div>

            <p
              v-if="submitError"
              class="rounded-lg border border-red-300/70 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900/70 dark:bg-red-950/40 dark:text-red-200"
              role="alert"
              aria-live="assertive"
            >
              {{ submitError }}
            </p>

            <div class="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                class="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white/80 px-4 py-2 text-sm font-semibold text-neutral-600 hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                :disabled="saving"
                @click="requestClose"
              >
                取消
              </button>
              <button
                type="submit"
                class="inline-flex items-center gap-2 rounded-full bg-[var(--g-accent)] px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="saving || !local.title.trim()"
              >
                <LucideIcon v-if="saving" name="Loader2" class="h-4.5 w-4.5 animate-spin" />
                <span>{{ submitLabel }}</span>
              </button>
            </div>
          </form>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import type { CollectionSummary, CollectionVisibility } from '~/composables/useCollections'
import { useAuth } from '~/composables/useAuth'

const props = defineProps<{
  open: boolean
  saving?: boolean
  mode: 'create' | 'edit'
  collection?: CollectionSummary | null
  submitError?: string | null
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

const dialogTitleId = 'collection-editor-dialog-title'
const dialogDescriptionId = 'collection-editor-dialog-description'
const dialogRef = ref<HTMLElement | null>(null)
const titleInputRef = ref<HTMLInputElement | null>(null)
let previouslyFocusedElement: HTMLElement | null = null
let previousBodyOverflow = ''
let dialogActive = false

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
  async (open) => {
    if (open) {
      // 每次打开都从已确认的 collection 重新建立草稿；关闭即代表放弃未保存修改。
      reset()
    }
    if (typeof document === 'undefined') return

    if (open) {
      previouslyFocusedElement = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null
      previousBodyOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      document.addEventListener('keydown', handleDocumentKeydown)
      dialogActive = true
      await nextTick()
      titleInputRef.value?.focus()
      return
    }

    cleanupDialog()
    await nextTick()
    previouslyFocusedElement?.focus()
    previouslyFocusedElement = null
  },
  { immediate: true }
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
  if (!canPublish.value) {
    return local.visibility === 'PUBLIC'
      ? '当前收藏夹已公开；切回私密后，需要先绑定 Wikidot 才能再次公开。'
      : '公开收藏夹前需要先绑定 Wikidot 账号。'
  }
  if (local.visibility === 'PRIVATE') {
    return '仅自己可见，可用于暂存或私密整理。'
  }
  return '公开收藏夹会显示在个人主页，包含标题、简介与摘录。'
})

const canPublish = computed(() => (
  isAuthenticated.value
  && Number.isFinite(Number(user.value?.linkedWikidotId))
  && Number(user.value?.linkedWikidotId) > 0
))

function toggleVisibility() {
  if (local.visibility === 'PRIVATE' && !canPublish.value) return
  local.visibility = local.visibility === 'PUBLIC' ? 'PRIVATE' : 'PUBLIC'
}

function requestClose() {
  if (props.saving) return
  emit('close')
}

function getFocusableElements(): HTMLElement[] {
  if (!dialogRef.value) return []
  return Array.from(dialogRef.value.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((element) => element.getAttribute('aria-hidden') !== 'true')
}

function handleDocumentKeydown(event: KeyboardEvent) {
  if (!props.open) return
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
    return
  }
  if (event.key !== 'Tab') return

  const focusableElements = getFocusableElements()
  if (focusableElements.length === 0) {
    event.preventDefault()
    dialogRef.value?.focus()
    return
  }

  const firstElement = focusableElements[0]
  const lastElement = focusableElements[focusableElements.length - 1]
  const activeElement = document.activeElement
  const focusIsInsideDialog = activeElement instanceof Node && dialogRef.value?.contains(activeElement)

  if (event.shiftKey && (activeElement === firstElement || !focusIsInsideDialog)) {
    event.preventDefault()
    lastElement?.focus()
  } else if (!event.shiftKey && (activeElement === lastElement || !focusIsInsideDialog)) {
    event.preventDefault()
    firstElement?.focus()
  }
}

function cleanupDialog() {
  if (typeof document === 'undefined' || !dialogActive) return
  document.removeEventListener('keydown', handleDocumentKeydown)
  document.body.style.overflow = previousBodyOverflow
  dialogActive = false
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

onBeforeUnmount(() => {
  cleanupDialog()
})
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
