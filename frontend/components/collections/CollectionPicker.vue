<template>
  <div class="relative">
    <button
      type="button"
      class="inline-flex items-center gap-1 rounded-full border border-[rgba(var(--accent),0.3)] bg-[rgba(var(--accent),0.1)] px-3 py-1.5 text-xs font-semibold text-[rgb(var(--accent))] transition hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)]"
      @click="togglePanel"
    >
      <LucideIcon name="BookmarkPlus" class="h-3.5 w-3.5" />
      收藏
    </button>

    <transition name="fade">
      <div
        v-if="open"
        ref="panelRef"
        :key="panelStateKey"
        class="absolute right-0 z-40 mt-2 w-96 rounded-2xl border border-neutral-200 bg-white/95 p-4 shadow-[0_22px_45px_rgba(15,23,42,0.12)] dark:border-neutral-700 dark:bg-neutral-900/95 dark:shadow-[0_30px_60px_rgba(0,0,0,0.6)]"
      >
        <div class="flex items-center justify-between border-b border-neutral-200 pb-2 dark:border-neutral-700">
          <h4 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">收藏 “{{ pageTitle }}”</h4>
          <button type="button" class="text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300" @click="open = false">
            <LucideIcon name="X" class="h-4 w-4" />
          </button>
        </div>

        <div v-if="panelMode === 'loading'" class="flex items-center gap-2 py-4 text-sm text-neutral-500 dark:text-neutral-300">
          <LucideIcon name="Loader2" class="h-4 w-4 animate-spin" />
          正在确认登录状态...
        </div>

        <div v-else-if="panelMode === 'guest'" class="space-y-3 py-4 text-sm text-neutral-600 dark:text-neutral-300">
          <p>登录后即可将页面加入收藏夹，并在个人中心统一管理。</p>
          <NuxtLink
            to="/auth/login"
            class="inline-flex items-center gap-2 rounded-full bg-[rgb(var(--accent))] px-4 py-1.5 text-xs font-semibold text-white shadow-[0_12px_30px_rgba(37,99,235,0.35)]"
          >
            <LucideIcon name="LogIn" class="h-4 w-4" />
            前往登录
          </NuxtLink>
        </div>

        <div v-else class="space-y-5 py-4">
          <div v-if="collectionsLoading" class="flex items-center gap-2 text-sm text-neutral-500 dark:text-neutral-300">
            <LucideIcon name="Loader2" class="h-4 w-4 animate-spin" />
            正在加载收藏夹...
          </div>
          <div v-else-if="collectionList.length === 0" class="space-y-3 text-sm text-neutral-600 dark:text-neutral-300">
            <p>还没有收藏夹，先创建一个吧。</p>
            <form class="space-y-3" @submit.prevent="create">
              <input
                v-model="createPayload.title"
                type="text"
                maxlength="80"
                required
                placeholder="收藏夹名称"
                class="w-full rounded-xl border border-neutral-200 bg-white/90 px-3 py-2 text-sm text-neutral-800 focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.25)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-100"
              >
              <div class="flex items-center justify-between">
                <button
                  type="button"
                  class="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white/90 px-3 py-1 text-xs font-semibold text-neutral-500 hover:border-[rgba(var(--accent),0.3)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                  @click="open = false"
                >
                  以后再说
                </button>
                <button
                  type="submit"
                  class="inline-flex items-center gap-2 rounded-full bg-[rgb(var(--accent))] px-4 py-1.5 text-xs font-semibold text-white shadow-[0_12px_30px_rgba(37,99,235,0.35)]"
                  :disabled="saving.value || isApplying"
                >
                  <LucideIcon v-if="saving.value" name="Loader2" class="h-4 w-4 animate-spin" />
                  <span>创建收藏夹</span>
                </button>
              </div>
            </form>
          </div>
          <div v-else class="space-y-4">
            <div class="flex items-start justify-between gap-3 text-xs text-neutral-500 dark:text-neutral-400">
              <p>勾选收藏夹并填写批注，点击下方保存即可同步到云端。</p>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-2.5 py-1 text-[11px] font-semibold text-neutral-500 hover:border-[rgba(var(--accent),0.3)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                  @click="openCreateForm = !openCreateForm"
                >
                  <LucideIcon name="PlusCircle" class="h-3.5 w-3.5" />
                  新建
                </button>
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold text-neutral-500 hover:text-[rgb(var(--accent))] dark:text-neutral-300"
                  @click="refresh"
                >
                  <LucideIcon name="RefreshCw" class="h-3.5 w-3.5" />
                  刷新
                </button>
              </div>
            </div>

            <form v-if="openCreateForm" class="space-y-3 rounded-xl border border-dashed border-neutral-300 bg-neutral-50/70 p-3 dark:border-neutral-700 dark:bg-neutral-900/60" @submit.prevent="create">
              <div class="flex items-center justify-between">
                <h5 class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">新建收藏夹</h5>
                <button type="button" class="text-xs text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300" @click="openCreateForm = false">
                  取消
                </button>
              </div>
              <input
                v-model="createPayload.title"
                type="text"
                maxlength="80"
                required
                placeholder="收藏夹名称"
                class="w-full rounded-xl border border-neutral-200 bg-white/90 px-3 py-2 text-sm text-neutral-800 focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.25)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-100"
              >
              <div class="flex justify-end">
                <button
                  type="submit"
                  class="inline-flex items-center gap-2 rounded-full bg-[rgb(var(--accent))] px-4 py-1.5 text-xs font-semibold text-white shadow-[0_12px_30px_rgba(37,99,235,0.35)]"
                  :disabled="saving.value || isApplying"
                >
                  <LucideIcon v-if="saving.value" name="Loader2" class="h-4 w-4 animate-spin" />
                  <span>创建</span>
                </button>
              </div>
            </form>

            <ul class="space-y-3 max-h-72 overflow-y-auto pr-1">
              <li
                v-for="collection in collectionList"
                :key="collection.id"
                class="rounded-2xl border border-neutral-200/70 bg-neutral-50/70 p-3 transition hover:border-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/60"
              >
                <label class="flex items-start gap-3">
                  <input
                    :checked="draftSelected.has(collection.id)"
                    type="checkbox"
                    class="mt-1 h-4 w-4 rounded border-neutral-300 text-[rgb(var(--accent))] focus:ring-[rgb(var(--accent))]"
                    @change="toggleDraft(collection)"
                  >
                  <div class="flex-1 space-y-2">
                    <div class="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">{{ collection.title }}</div>
                        <p class="text-[11px] text-neutral-500 dark:text-neutral-400">
                          {{ collection.visibility === 'PUBLIC' ? '公开可见' : '仅自己可见' }} · {{ collection.itemCount }} 条目
                        </p>
                      </div>
                      <span v-if="selected.has(collection.id)" class="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-200">
                        <LucideIcon name="ShieldCheck" class="h-3.5 w-3.5" />
                        已同步
                      </span>
                    </div>
                    <textarea
                      v-model="annotationDrafts[collection.id]"
                      rows="2"
                      maxlength="1200"
                      :placeholder="draftSelected.has(collection.id) ? '为此页面写点批注吧（可选）' : '勾选上方后可保存批注'"
                      class="w-full rounded-xl border border-neutral-200 bg-white/90 px-3 py-2 text-sm text-neutral-700 focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.25)] disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800/70 dark:text-neutral-200"
                      :disabled="!draftSelected.has(collection.id)"
                    />
                    <div class="flex flex-wrap items-center justify-between gap-2 text-[11px] text-neutral-400 dark:text-neutral-500">
                      <span>
                        <span v-if="messages[collection.id]" class="text-[rgb(var(--accent))]">{{ messages[collection.id] }}</span>
                        <span v-else-if="isRemovalPending(collection.id)">将移除，点击保存后生效</span>
                        <span v-else-if="isNewlySelected(collection.id)">新选择，保存后加入收藏</span>
                        <span v-else-if="isAnnotationDirty(collection.id)" class="text-[rgb(var(--accent))]">批注已修改，保存后同步</span>
                        <span v-else>已与云端同步</span>
                      </span>
                      <button
                        type="button"
                        class="inline-flex items-center gap-1 text-[rgb(var(--accent))]"
                        @click.stop="openCreateForm = true"
                      >
                        <LucideIcon name="FolderPlus" class="h-3.5 w-3.5" />
                        管理收藏夹
                      </button>
                    </div>
                  </div>
                </label>
              </li>
            </ul>

            <div class="flex flex-col gap-3 rounded-xl border-t border-neutral-200/80 pt-3 text-[11px] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400 md:flex-row md:items-center md:justify-between">
              <div>
                <span v-if="hasPendingChanges">有待保存的更改。</span>
                <span v-else>所有更改已同步。</span>
              </div>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/90 px-3 py-1 font-semibold text-neutral-500 hover:border-[rgba(var(--accent),0.3)] hover:text-[rgb(var(--accent))] disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                  :disabled="!hasPendingChanges || disableActions"
                  @click="resetDrafts"
                >
                  取消更改
                </button>
                <button
                  type="button"
                  class="inline-flex items-center gap-2 rounded-full bg-[rgb(var(--accent))] px-4 py-1.5 font-semibold text-white shadow-[0_10px_28px_rgba(37,99,235,0.35)] transition hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0"
                  :disabled="!hasPendingChanges || disableActions"
                  @click="applyChanges"
                >
                  <LucideIcon v-if="isApplying" name="Loader2" class="h-3.5 w-3.5 animate-spin" />
                  <span>{{ isApplying ? '保存中...' : '保存收藏' }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <div class="pt-3 text-right text-[11px] text-neutral-400 dark:text-neutral-500">
          收藏夹管理位于 <NuxtLink to="/account?tab=collections" class="text-[rgb(var(--accent))]">账号设置 · 收藏夹</NuxtLink>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useAuth } from '~/composables/useAuth'
import { useCollections, type CollectionSummary } from '~/composables/useCollections'

const props = defineProps<{
  pageId: number
  pageWikidotId: number | null
  pageTitle: string
}>()

const { isAuthenticated, status: authStatus, fetchCurrentUser, loading: authLoading } = useAuth()
const {
  collections,
  loading: collectionsLoading,
  saving,
  fetchCollections,
  fetchCollectionDetail,
  createCollection,
  addItem,
  updateItem,
  removeItem
} = useCollections()

const open = ref(false)
const panelRef = ref<HTMLElement | null>(null)
const selected = ref(new Set<number>())
const draftSelected = ref(new Set<number>())
const annotations = reactive<Record<number, string>>({})
const annotationDrafts = reactive<Record<number, string>>({})
const itemIdMap = reactive<Record<number, number>>({})
const messages = reactive<Record<number, string>>({})
const isApplying = ref(false)
const openCreateForm = ref(false)
const createPayload = reactive({ title: '' })

const collectionList = computed(() => {
  const source = collections.value
  return Array.isArray(source) ? source : []
})

const panelMode = computed<'loading' | 'guest' | 'auth'>(() => {
  if (authLoading.value) return 'loading'
  return isAuthenticated.value ? 'auth' : 'guest'
})
const panelStateKey = computed(() => panelMode.value)

const hasSelectionChanges = computed(() => {
  if (draftSelected.value.size !== selected.value.size) return true
  for (const id of draftSelected.value) {
    if (!selected.value.has(id)) return true
  }
  for (const id of selected.value) {
    if (!draftSelected.value.has(id)) return true
  }
  return false
})

const hasAnnotationChanges = computed(() => {
  for (const id of draftSelected.value) {
    if (!selected.value.has(id)) continue
    if (normalizeAnnotation(annotationDrafts[id]) !== normalizeAnnotation(annotations[id])) {
      return true
    }
  }
  return false
})

const hasPendingChanges = computed(() => hasSelectionChanges.value || hasAnnotationChanges.value)
const disableActions = computed(() => isApplying.value || authLoading.value || saving.value)

function normalizeAnnotation(value: string | null | undefined) {
  return (value ?? '').trim()
}

function replaceReactive<T>(target: Record<number, T>, source: Record<number, T>) {
  Object.keys(target).forEach((key) => { delete target[Number(key)] })
  for (const [key, value] of Object.entries(source)) {
    target[Number(key)] = value as T
  }
}

function clearMessages() {
  Object.keys(messages).forEach((key) => { delete messages[Number(key)] })
}

function markMessage(id: number, text: string, duration = 1800) {
  if (!text) return
  messages[id] = text
  window.setTimeout(() => {
    if (messages[id] === text) {
      delete messages[id]
    }
  }, duration)
}

function isRemovalPending(id: number) {
  return selected.value.has(id) && !draftSelected.value.has(id)
}

function isNewlySelected(id: number) {
  return !selected.value.has(id) && draftSelected.value.has(id)
}

function isAnnotationDirty(id: number) {
  if (!selected.value.has(id) || !draftSelected.value.has(id)) return false
  return normalizeAnnotation(annotationDrafts[id]) !== normalizeAnnotation(annotations[id])
}

async function ensureLoaded() {
  if (!isAuthenticated.value) return
  await fetchCollections(true)
  const nextSelected = new Set<number>()
  const nextAnnotations: Record<number, string> = {}
  const nextItemIdMap: Record<number, number> = {}

  await Promise.all(collectionList.value.map(async (collection) => {
    const detail = await fetchCollectionDetail(collection.id, true)
    if (!detail) {
      nextAnnotations[collection.id] = ''
      return
    }
    const target = detail.items.find(
      (item) => item.pageId === props.pageId || item.page.wikidotId === props.pageWikidotId
    )
    if (target) {
      nextSelected.add(collection.id)
      nextAnnotations[collection.id] = target.annotation ?? ''
      nextItemIdMap[collection.id] = target.id
    } else {
      nextAnnotations[collection.id] = ''
    }
  }))

  selected.value = nextSelected
  draftSelected.value = new Set(nextSelected)
  replaceReactive(annotations, nextAnnotations)
  replaceReactive(annotationDrafts, nextAnnotations)
  replaceReactive(itemIdMap, nextItemIdMap)
  clearMessages()
}

async function ensureAuthState() {
  if (isAuthenticated.value || authLoading.value) return
  await fetchCurrentUser(true).catch((error) => {
    console.warn('[collections] failed to refresh auth state', error)
  })
}

async function togglePanel() {
  if (!isAuthenticated.value) {
    await ensureAuthState()
  }
  if (!isAuthenticated.value) {
    open.value = true
    return
  }
  if (!open.value) {
    clearMessages()
  }
  open.value = !open.value
  if (!open.value) {
    draftSelected.value = new Set(selected.value)
    replaceReactive(annotationDrafts, annotations)
  }
}

function toggleDraft(collection: CollectionSummary) {
  if (!isAuthenticated.value) return
  const next = new Set(draftSelected.value)
  if (next.has(collection.id)) {
    next.delete(collection.id)
    markMessage(collection.id, selected.value.has(collection.id) ? '将移除，保存后生效' : '已取消', 2200)
  } else {
    next.add(collection.id)
    if (!(collection.id in annotationDrafts)) {
      annotationDrafts[collection.id] = ''
    }
    markMessage(collection.id, selected.value.has(collection.id) ? '已选中，保存即可更新' : '已勾选，保存后同步', 2200)
  }
  draftSelected.value = next
}

function resetDrafts() {
  draftSelected.value = new Set(selected.value)
  replaceReactive(annotationDrafts, annotations)
  clearMessages()
}

async function applyChanges() {
  if (!isAuthenticated.value || !hasPendingChanges.value || isApplying.value) return
  const toAdd = Array.from(draftSelected.value).filter((id) => !selected.value.has(id))
  const toRemove = Array.from(selected.value).filter((id) => !draftSelected.value.has(id))
  const toUpdate = Array.from(draftSelected.value).filter(
    (id) => selected.value.has(id) && normalizeAnnotation(annotationDrafts[id]) !== normalizeAnnotation(annotations[id])
  )
  if (toAdd.length === 0 && toRemove.length === 0 && toUpdate.length === 0) return

  isApplying.value = true
  try {
    clearMessages()
    for (const id of toAdd) {
      const result = await addItem(id, {
        pageId: props.pageId,
        pageWikidotId: props.pageWikidotId ?? undefined,
        annotation: normalizeAnnotation(annotationDrafts[id]) || undefined
      })
      if (!result.ok) {
        const friendly = result.error === 'invalid_page'
          ? '无法收藏此页面，可能尚未同步或已删除'
          : (result.error || '添加失败')
        markMessage(id, friendly, 3200)
      }
    }
    for (const id of toRemove) {
      const itemId = itemIdMap[id]
      if (!itemId) {
        markMessage(id, '无法定位该条目，可能已经删除', 2800)
        continue
      }
      const result = await removeItem(id, itemId)
      if (!result.ok) {
        markMessage(id, result.error || '移除失败', 3200)
      }
    }
    for (const id of toUpdate) {
      const itemId = itemIdMap[id]
      if (!itemId) continue
      const result = await updateItem(id, itemId, { annotation: normalizeAnnotation(annotationDrafts[id]) || null })
      if (!result.ok) {
        markMessage(id, result.error || '批注更新失败', 3200)
      }
    }
    await ensureLoaded()
    toAdd.forEach((id) => markMessage(id, '已添加', 2000))
    toRemove.forEach((id) => markMessage(id, '已移除', 2000))
    toUpdate.forEach((id) => markMessage(id, '批注已更新', 2000))
  } finally {
    isApplying.value = false
  }
}

async function create() {
  if (!createPayload.title.trim() || isApplying.value) return
  const result = await createCollection({
    title: createPayload.title.trim(),
    description: null,
    notes: null,
    coverImageUrl: null,
    isDefault: false,
    visibility: 'PRIVATE'
  })
  if (result.ok && result.collection) {
    createPayload.title = ''
    openCreateForm.value = false
    await ensureLoaded()
  }
}

async function refresh() {
  await ensureLoaded()
}

function handleGlobalClick(event: MouseEvent) {
  if (!open.value) return
  const target = event.target as Node | null
  if (panelRef.value && target && !panelRef.value.contains(target)) {
    open.value = false
  }
}

onMounted(() => {
  document.addEventListener('click', handleGlobalClick, true)
  void ensureAuthState()
})

onBeforeUnmount(() => {
  document.removeEventListener('click', handleGlobalClick, true)
})

watch(
  [isAuthenticated, open],
  ([auth, opened]) => {
    if (auth && opened) {
      void ensureLoaded()
    }
  },
  { immediate: true }
)
</script>

<style scoped>
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
</style>
