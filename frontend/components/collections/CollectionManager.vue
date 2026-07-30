<template>
  <div class="space-y-6">
    <section class="rounded-lg border border-neutral-200/80 bg-white p-4 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-950 sm:p-5">
      <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50">收藏夹管理</h2>
          <p class="mt-1 text-sm leading-6 text-neutral-600 dark:text-neutral-400">
            选择一个收藏夹查看条目，或新建收藏夹开始整理。
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <button
            type="button"
            class="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg border border-neutral-200 bg-white px-4 py-2 text-sm font-medium text-neutral-600 transition hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] disabled:cursor-wait disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 sm:flex-none"
            :disabled="loading"
            @click="handleRefresh"
          >
            <LucideIcon
              name="RefreshCw"
              class="h-4 w-4"
              :class="{ 'animate-spin': loading }"
            />
            {{ loading ? '刷新中…' : '刷新' }}
          </button>
          <button
            type="button"
            class="inline-flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white dark:focus:ring-neutral-100 dark:focus:ring-offset-neutral-950 sm:flex-none"
            @click="openCreate"
          >
            <LucideIcon name="Plus" class="h-4 w-4" />
            新建收藏夹
          </button>
        </div>
      </div>
    </section>

    <section class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div class="space-y-4">
        <header class="flex items-center justify-between">
          <div>
            <h3 class="text-sm font-semibold uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400">我的收藏夹</h3>
            <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">点击卡片切换收藏夹，选中后查看条目与批注。</p>
          </div>
          <span v-if="collectionList.length > 0" class="text-xs text-neutral-400 dark:text-neutral-500">
            共 {{ collectionList.length }} 个
          </span>
        </header>

        <div v-if="loading" class="grid gap-4 sm:grid-cols-2">
          <div
            v-for="n in 4"
            :key="`collection-skeleton-${n}`"
            class="h-36 rounded-lg bg-neutral-100/80 animate-pulse dark:bg-neutral-800/50"
          />
        </div>

        <div
          v-else-if="error && collectionList.length === 0"
          class="flex flex-col items-center justify-center gap-3 rounded-lg border border-red-200 bg-red-50/80 p-10 text-center text-sm text-red-600 dark:border-red-900/60 dark:bg-red-900/30 dark:text-red-200"
          role="alert"
        >
          <LucideIcon name="AlertTriangle" class="h-5 w-5" />
          <p>加载收藏夹失败：{{ error }}</p>
          <button
            type="button"
            class="inline-flex min-h-10 items-center gap-2 rounded-lg border border-neutral-200 bg-white/90 px-4 py-2 text-sm font-semibold text-neutral-600 transition hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
            @click="handleRefresh"
          >
            再试一次
          </button>
        </div>

        <div
          v-else-if="collectionList.length === 0"
          class="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-neutral-300 bg-neutral-50/80 p-10 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300"
        >
          <LucideIcon name="BookmarkPlus" class="h-5 w-5 text-[var(--g-accent)]" />
          <p>目前还没有收藏夹。可以先创建一个，或在页面右上角点击星标快速收藏。</p>
        </div>

        <ul
          v-else
          class="grid gap-4 sm:grid-cols-2"
        >
          <li
            v-for="collection in collectionList"
            :key="collection.id"
          >
            <button
              type="button"
              class="group relative w-full overflow-hidden rounded-lg border border-transparent bg-white/90 p-5 text-left shadow-sm backdrop-blur-sm transition duration-300 hover:-translate-y-1 hover:shadow-sm dark:bg-neutral-900/80 dark:shadow-lg"
              :class="collection.id === activeId
                ? 'ring-2 ring-[var(--g-accent-border)] shadow dark:ring-[rgb(var(--accent)_/_0.5)]'
                : 'border-neutral-200/80 hover:border-[var(--g-accent-border)] dark:border-neutral-800/70'"
              :aria-pressed="collection.id === activeId"
              aria-controls="active-collection-detail"
              @click="select(collection.id)"
            >
              <div
                class="pointer-events-none absolute inset-0 rounded-lg opacity-0 transition group-hover:opacity-90"
                :class="accentGradient(collection.id)"
              />
              <div class="relative z-10 flex flex-col gap-4">
                <div class="flex items-start justify-between gap-3">
                  <div class="space-y-2">
                    <div class="inline-flex items-center gap-2 rounded-full bg-white/80 px-3 py-1 text-xs font-semibold text-neutral-600 shadow-sm dark:bg-neutral-900/70 dark:text-neutral-300">
                      <LucideIcon name="Layers" class="h-3.5 w-3.5 text-[var(--g-accent)]" />
                      {{ collection.itemCount }} 条目
                    </div>
                    <h4 class="text-base font-semibold text-neutral-900 dark:text-neutral-100">{{ collection.title }}</h4>
                    <p class="text-xs text-neutral-500 dark:text-neutral-400 line-clamp-2">
                      {{ collection.description || '暂无简介' }}
                    </p>
                  </div>
                  <span
                    :class="[
                      'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-medium backdrop-blur-sm',
                      collection.visibility === 'PUBLIC'
                        ? 'bg-emerald-400/15 text-emerald-600 dark:text-emerald-200'
                        : 'bg-neutral-200/60 text-neutral-600 dark:bg-neutral-800/60 dark:text-neutral-300'
                    ]"
                  >
                    <LucideIcon :name="collection.visibility === 'PUBLIC' ? 'Globe2' : 'Lock'" class="h-3.5 w-3.5" />
                    {{ collection.visibility === 'PUBLIC' ? '公开' : '私密' }}
                  </span>
                </div>
                <div class="flex items-center justify-between text-xs text-neutral-400 dark:text-neutral-500">
                  <span>更新于 {{ formatTime(collection.updatedAt) }}</span>
                  <span class="inline-flex items-center gap-1">
                    <LucideIcon name="Sparkle" class="h-3.5 w-3.5" />
                    精选收藏
                  </span>
                </div>
              </div>
            </button>
          </li>
        </ul>
      </div>

      <div
        v-if="activeId && detailLoading"
        id="active-collection-detail"
        class="flex min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-neutral-200/80 bg-white/95 p-8 text-center text-sm text-neutral-500 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-950/85 dark:text-neutral-300"
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <LucideIcon
          name="LoaderCircle"
          class="h-5 w-5 animate-spin text-[var(--g-accent)]"
          aria-hidden="true"
        />
        <p>正在加载收藏夹详情…</p>
      </div>

      <div
        v-else-if="activeId && detailError"
        id="active-collection-detail"
        class="flex min-h-64 flex-col items-center justify-center gap-3 rounded-lg border border-red-200 bg-red-50/80 p-8 text-center text-sm text-red-700 shadow-sm dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-200"
        role="alert"
      >
        <LucideIcon
          name="AlertTriangle"
          class="h-5 w-5"
          aria-hidden="true"
        />
        <div>
          <h3 class="font-semibold">无法加载收藏夹详情</h3>
          <p class="mt-1">{{ detailError }}</p>
        </div>
        <button
          type="button"
          class="inline-flex min-h-10 items-center gap-2 rounded-lg border border-neutral-200 bg-white/90 px-4 py-2 text-sm font-semibold text-neutral-700 transition hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-200"
          @click="loadDetail(activeId)"
        >
          再试一次
        </button>
      </div>

      <div
        v-if="activeDetail"
        id="active-collection-detail"
        class="relative overflow-hidden rounded-lg border border-neutral-200/80 bg-white/95 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-950/85 dark:shadow-lg"
        role="region"
        :aria-label="`${activeDetail.collection.title} 收藏夹详情`"
        aria-live="polite"
        aria-atomic="false"
        :aria-busy="detailLoading"
      >
        <div class="relative h-48 overflow-hidden">
          <div
            class="absolute inset-0 opacity-90"
            :class="accentGradient(activeDetail.collection.id)"
          />
          <div
            v-if="activeDetail.collection.coverImageUrl"
            class="absolute inset-0 bg-cover bg-center opacity-70"
            :style="{
              backgroundImage: `url(${activeDetail.collection.coverImageUrl})`,
              backgroundPosition: coverPosition(activeDetail.collection.coverImageOffsetX, activeDetail.collection.coverImageOffsetY),
              backgroundSize: coverSize(activeDetail.collection.coverImageScale)
            }"
          />
          <div class="absolute inset-0 bg-gradient-to-t from-neutral-950/70 via-neutral-900/30 to-transparent" />
          <div class="relative z-10 flex h-full flex-col justify-end gap-4 px-6 pb-6">
            <div class="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div class="space-y-2">
                <div class="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-medium text-white/90 backdrop-blur">
                  <LucideIcon name="Bookmark" class="h-4 w-4" />
                  {{ activeDetail.collection.itemCount }} 条精选
                </div>
                <h3 class="text-2xl font-semibold text-white drop-shadow">{{ activeDetail.collection.title }}</h3>
                <p class="max-w-2xl text-sm text-white/80 line-clamp-2">
                  {{ activeDetail.collection.description || '暂无简介，点击编辑补充一段简短介绍吧。' }}
                </p>
              </div>
              <div class="flex shrink-0 flex-col items-start gap-2 text-xs text-white/80">
                <span class="inline-flex items-center gap-1 rounded-full bg-white/15 px-3 py-1 font-medium backdrop-blur">
                  <LucideIcon :name="activeDetail.collection.visibility === 'PUBLIC' ? 'Globe2' : 'Lock'" class="h-3.5 w-3.5" />
                  {{ activeDetail.collection.visibility === 'PUBLIC' ? '公开展示' : '仅自己可见' }}
                </span>
                <span class="inline-flex items-center gap-1">
                  <LucideIcon name="Clock" class="h-3.5 w-3.5" />
                  更新于 {{ formatTime(activeDetail.collection.updatedAt) }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div class="space-y-6 border-t border-white/70 bg-white/95 p-6 dark:border-neutral-800/70 dark:bg-neutral-950/90">
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="text-sm text-neutral-500 dark:text-neutral-400">
              {{ activeDetail.collection.notes || '可以在这里添加整理思路或给自己的提醒。' }}
            </div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="inline-flex min-h-10 items-center gap-2 rounded-lg border border-neutral-200/80 bg-white/90 px-4 py-2 text-xs font-semibold text-neutral-600 hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                @click="openEdit"
              >
                <LucideIcon name="Pencil" class="h-3.5 w-3.5" />
                编辑
              </button>
              <button
                type="button"
                class="inline-flex min-h-10 items-center gap-2 rounded-lg border border-red-300/70 bg-red-50/80 px-4 py-2 text-xs font-semibold text-red-600 transition hover:bg-red-100 dark:border-red-900/70 dark:bg-red-900/30 dark:text-red-200"
                @click="confirmDelete"
              >
                <LucideIcon name="Trash2" class="h-3.5 w-3.5" />
                删除收藏夹
              </button>
            </div>
          </div>

          <div v-if="activeItems.length > 0" class="space-y-4">
            <div
              v-for="(item, index) in activeItems"
              :key="item.id"
              class="rounded-lg border border-neutral-200/80 bg-white/90 p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg dark:border-neutral-800/70 dark:bg-neutral-900/70"
            >
              <div class="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div class="space-y-3">
                  <div class="flex flex-wrap items-center gap-2 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                    <NuxtLink
                      v-if="item.page.wikidotId"
                      :to="`/page/${item.page.wikidotId}`"
                      class="inline-flex items-center gap-1 hover:text-[var(--g-accent)]"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <LucideIcon name="ArrowUpRight" class="h-3.5 w-3.5" />
                      {{ item.page.title ?? `页面 #${item.page.wikidotId}` }}
                    </NuxtLink>
                    <span v-else>{{ item.page.title || '未知页面' }}</span>
                    <span
                      v-if="item.pinned"
                      class="inline-flex items-center gap-1 rounded-full bg-amber-100/90 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-200"
                    >
                      <LucideIcon name="Star" class="h-3 w-3" />
                      置顶
                    </span>
                  </div>
                  <div class="flex flex-wrap items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
                    <span>添加于 {{ formatTime(item.createdAt) }}</span>
                    <span v-if="item.page.rating != null" class="inline-flex items-center gap-1">
                      <LucideIcon name="Gauge" class="h-3.5 w-3.5" />
                      评分 {{ item.page.rating }}
                    </span>
                    <span class="inline-flex items-center gap-1">
                      <LucideIcon name="Hash" class="h-3.5 w-3.5" />
                      ID {{ item.page.wikidotId ?? item.page.id }}
                    </span>
                  </div>
                  <label
                    :for="`collection-item-annotation-${item.id}`"
                    class="block text-xs font-medium text-neutral-600 dark:text-neutral-300"
                  >
                    {{ item.page.title ? `《${item.page.title}》的批注` : '页面批注' }}
                  </label>
                  <textarea
                    :id="`collection-item-annotation-${item.id}`"
                    v-model="annotations[item.id]"
                    rows="2"
                    maxlength="1200"
                    :aria-describedby="`collection-item-annotation-hint-${item.id}`"
                    class="w-full rounded-xl border border-neutral-200/80 bg-neutral-50/80 px-3 py-2 text-sm text-neutral-700 focus:border-[var(--g-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-strong)] dark:border-neutral-700 dark:bg-neutral-800/70 dark:text-neutral-200"
                    placeholder="为这篇页面写点读后感或整理要点..."
                    @blur="handleAnnotationSave(item)"
                  />
                  <div class="flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-400 dark:text-neutral-500">
                    <span :id="`collection-item-annotation-hint-${item.id}`">批注会自动保存，也可以随时在收藏面板中调整。</span>
                    <button
                      type="button"
                      class="inline-flex min-h-10 items-center gap-1 rounded-lg border border-neutral-200/80 bg-white/90 px-3 py-2 font-semibold text-neutral-600 hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                      @click="handleAnnotationSave(item)"
                    >
                      <LucideIcon name="Save" class="h-3 w-3" />
                      保存批注
                    </button>
                  </div>
                </div>
                <div class="flex shrink-0 flex-col items-end gap-2">
                  <div class="inline-flex items-center gap-1 rounded-lg border border-neutral-200/80 bg-neutral-50/80 px-1 text-xs font-semibold text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800/70 dark:text-neutral-200">
                    <button
                      type="button"
                      class="inline-flex h-10 w-10 items-center justify-center rounded-lg transition hover:text-[var(--g-accent)] disabled:opacity-40"
                      :disabled="index === 0"
                      :aria-label="`将${item.page.title ? `《${item.page.title}》` : '此页面'}上移`"
                      @click="moveItem(index, index - 1)"
                    >
                      <LucideIcon name="ArrowUp" class="h-4 w-4" />
                    </button>
                    <span class="px-2 text-[11px] font-medium text-neutral-500 dark:text-neutral-400">排序</span>
                    <button
                      type="button"
                      class="inline-flex h-10 w-10 items-center justify-center rounded-lg transition hover:text-[var(--g-accent)] disabled:opacity-40"
                      :disabled="index === activeItems.length - 1"
                      :aria-label="`将${item.page.title ? `《${item.page.title}》` : '此页面'}下移`"
                      @click="moveItem(index, index + 1)"
                    >
                      <LucideIcon name="ArrowDown" class="h-4 w-4" />
                    </button>
                  </div>
                  <button
                    type="button"
                    class="inline-flex min-h-10 items-center gap-1 rounded-lg border border-neutral-200/80 bg-white/90 px-3 py-2 text-xs font-semibold text-neutral-600 hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                    @click="togglePin(item)"
                  >
                    <LucideIcon :name="item.pinned ? 'BookmarkX' : 'Bookmark'" class="h-3.5 w-3.5" />
                    {{ item.pinned ? '取消置顶' : '置顶' }}
                  </button>
                  <button
                    type="button"
                    class="inline-flex min-h-10 items-center gap-1 rounded-lg border border-red-300/80 bg-red-50/80 px-3 py-2 text-xs font-semibold text-red-600 hover:bg-red-100 dark:border-red-800/80 dark:bg-red-900/30 dark:text-red-200"
                    @click="remove(item)"
                  >
                    <LucideIcon name="Trash2" class="h-3 w-3" />
                    移除
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div v-else class="rounded-lg border border-dashed border-neutral-300 bg-neutral-50/80 p-10 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300">
            这个收藏夹还没有条目。前往页面点击“收藏”按钮即可快速加入。
          </div>
        </div>
      </div>
    </section>

    <CollectionEditorModal
      :open="modal.open"
      :mode="modal.mode"
      :collection="modal.collection"
      :saving="saving"
      :submit-error="modal.submitError"
      @close="closeModal"
      @submit="handleSubmit"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import type { CollectionDetail, CollectionItem, CollectionSummary } from '~/composables/useCollections'
import { useCollections } from '~/composables/useCollections'
import CollectionEditorModal from './CollectionEditorModal.vue'

const accentTokens = [
  'bg-gradient-to-br from-sky-500/20 via-blue-500/10 to-indigo-500/25 dark:from-sky-500/25 dark:via-blue-500/15 dark:to-indigo-500/30',
  'bg-gradient-to-br from-emerald-400/20 via-teal-400/10 to-cyan-500/25 dark:from-emerald-400/25 dark:via-teal-400/15 dark:to-cyan-500/30',
  'bg-gradient-to-br from-amber-400/20 via-orange-400/10 to-rose-400/20 dark:from-amber-400/25 dark:via-orange-400/15 dark:to-rose-400/25',
  'bg-gradient-to-br from-fuchsia-500/20 via-purple-500/10 to-blue-500/25 dark:from-fuchsia-500/25 dark:via-purple-500/15 dark:to-blue-500/30'
]

const {
  collections,
  loading,
  error,
  saving,
  fetchCollections,
  fetchCollectionDetail,
  createCollection,
  updateCollection,
  removeCollection,
  updateItem,
  removeItem,
  reorderItems
} = useCollections()

const collectionList = computed(() => {
  const source = collections.value
  return Array.isArray(source) ? source : []
})

const activeId = ref<number | null>(null)
const activeDetail = ref<CollectionDetail | null>(null)
const detailLoading = ref(false)
const detailError = ref<string | null>(null)
const annotations = reactive<Record<number, string>>({})
let detailRequestSequence = 0

const modal = reactive<{
  open: boolean
  mode: 'create' | 'edit'
  collection: CollectionSummary | null
  submitError: string | null
}>({
  open: false,
  mode: 'create',
  collection: null,
  submitError: null
})

watch(collectionList, (list) => {
  const selectionStillExists = list.some(collection => collection.id === activeId.value)
  if (list.length > 0 && !selectionStillExists) {
    activeId.value = list[0].id
  } else if (list.length === 0) {
    activeId.value = null
    activeDetail.value = null
    detailError.value = null
  }
}, { immediate: true })

watch(activeId, (id) => {
  if (id) {
    void loadDetail(id)
  } else {
    activeDetail.value = null
    detailError.value = null
    detailLoading.value = false
  }
}, { immediate: true })

const activeItems = computed(() => activeDetail.value?.items ?? [])

function accentGradient(id: number | null | undefined) {
  if (!Number.isFinite(Number(id))) return accentTokens[0]
  const index = Math.abs(Number(id)) % accentTokens.length
  return accentTokens[index]
}

function coverPosition(offsetX: number | null | undefined, offsetY: number | null | undefined): string {
  const x = clampOffset(offsetX)
  const y = clampOffset(offsetY)
  return `${50 - x}% ${50 - y}%`
}

function coverSize(scale: number | null | undefined): string {
  const value = clampScale(scale)
  return `${value * 100}% auto`
}

function clampOffset(value: number | null | undefined): number {
  if (!Number.isFinite(Number(value))) return 0
  const numeric = Number(value)
  if (Number.isNaN(numeric)) return 0
  return Math.min(60, Math.max(-60, numeric))
}

function clampScale(value: number | null | undefined): number {
  if (!Number.isFinite(Number(value))) return 1
  const numeric = Number(value)
  if (Number.isNaN(numeric)) return 1
  return Math.min(2.5, Math.max(0.75, numeric))
}

function select(id: number) {
  if (activeId.value === id) return
  // Do not leave the previous collection editable while the newly selected
  // detail is unresolved or has failed to load.
  activeDetail.value = null
  detailError.value = null
  detailLoading.value = true
  activeId.value = id
}

async function loadDetail(id: number) {
  const requestSequence = ++detailRequestSequence
  if (id === activeId.value) {
    activeDetail.value = null
    detailError.value = null
    detailLoading.value = true
  }
  try {
    const detail = await fetchCollectionDetail(id, true)
    if (requestSequence === detailRequestSequence && id === activeId.value) {
      if (detail) {
        activeDetail.value = detail
        detailError.value = null
        annotationsReset(detail.items)
      } else {
        activeDetail.value = null
        detailError.value = error.value || '加载收藏夹详情失败，请重试。'
      }
    }
  } finally {
    if (requestSequence === detailRequestSequence) {
      detailLoading.value = false
    }
  }
}

function annotationsReset(items: CollectionItem[]) {
  Object.keys(annotations).forEach((key) => {
    delete annotations[Number(key)]
  })
  for (const item of items) {
    annotations[item.id] = item.annotation ?? ''
  }
}

function openCreate() {
  modal.mode = 'create'
  modal.collection = null
  modal.submitError = null
  modal.open = true
}

function openEdit() {
  if (!activeDetail.value) return
  modal.mode = 'edit'
  modal.collection = activeDetail.value.collection
  modal.submitError = null
  modal.open = true
}

function closeModal() {
  const shouldRefresh = Boolean(modal.submitError)
  modal.open = false
  modal.submitError = null
  if (shouldRefresh) void handleRefresh()
}

function submitErrorMessage(errorValue: string | undefined, fallback: string) {
  const messages: Record<string, string> = {
    require_linked_wikidot: '公开收藏夹前需要先绑定 Wikidot 账号。',
    invalid_title: '请填写有效的收藏夹名称。',
    invalid_visibility: '收藏夹公开状态无效，请重新选择。',
    collection_limit_reached: '收藏夹数量已达上限。'
  }
  return errorValue ? (messages[errorValue] || errorValue) : fallback
}

async function handleSubmit(payload: {
  title: string
  description: string | null
  notes: string | null
  coverImageUrl: string | null
  coverImageOffsetX: number
  coverImageOffsetY: number
  coverImageScale: number
  isDefault: boolean
  visibility: 'PUBLIC' | 'PRIVATE'
}) {
  modal.submitError = null
  if (modal.mode === 'create') {
    const result = await createCollection(payload)
    if (result.ok) {
      modal.open = false
      activeId.value = result.collection.id
    } else {
      modal.submitError = submitErrorMessage(result.error, '创建收藏夹失败，请重试。')
    }
  } else if (modal.collection) {
    const result = await updateCollection(modal.collection.id, payload)
    if (result.ok && activeId.value === modal.collection.id) {
      modal.open = false
      await loadDetail(modal.collection.id)
    } else if (!result.ok) {
      modal.submitError = submitErrorMessage(result.error, '保存收藏夹失败，请重试。')
    }
  }
}

async function confirmDelete() {
  if (!activeDetail.value) return
  if (!window.confirm(`确定删除收藏夹「${activeDetail.value.collection.title}」吗？此操作无法撤销。`)) return
  const result = await removeCollection(activeDetail.value.collection.id)
  if (result.ok) {
    modal.open = false
    activeDetail.value = null
    const remaining = collectionList.value.filter((c) => c.id !== activeId.value)
    activeId.value = remaining[0]?.id ?? null
  }
}

async function handleAnnotationSave(item: CollectionItem) {
  const next = annotations[item.id]?.trim() || null
  if (next === item.annotation) return
  await updateItem(item.collectionId, item.id, { annotation: next })
  await loadDetail(item.collectionId)
}

async function togglePin(item: CollectionItem) {
  await updateItem(item.collectionId, item.id, { pinned: !item.pinned })
  await loadDetail(item.collectionId)
}

async function moveItem(from: number, to: number) {
  if (!activeDetail.value) return
  const items = [...activeDetail.value.items]
  const [moved] = items.splice(from, 1)
  items.splice(to, 0, moved)
  await reorderItems(activeDetail.value.collection.id, items.map((item) => item.id))
  await loadDetail(activeDetail.value.collection.id)
}

async function remove(item: CollectionItem) {
  if (!window.confirm('确定从收藏夹中移除此页面吗？')) return
  await removeItem(item.collectionId, item.id)
  await loadDetail(item.collectionId)
}

async function handleRefresh() {
  const refreshed = await fetchCollections(true)
  if (
    activeId.value
    && refreshed.some(collection => collection.id === activeId.value)
  ) {
    await loadDetail(activeId.value)
  }
}

function formatTime(value: string) {
  try {
    const date = new Date(value)
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', timeZone: 'Asia/Shanghai' })
  } catch {
    return value.slice(0, 10)
  }
}

onMounted(() => {
  void fetchCollections(true)
})
</script>
