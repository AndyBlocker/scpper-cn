import { useNuxtApp, useState } from 'nuxt/app'
import { computed } from 'vue'
import { useAuth } from '~/composables/useAuth'
import { getErrorMessage } from '~/utils/httpError'

export type CollectionVisibility = 'PUBLIC' | 'PRIVATE'

export interface CollectionSummary {
  id: number
  ownerId: number
  title: string
  slug: string
  visibility: CollectionVisibility
  description: string | null
  notes: string | null
  coverImageUrl: string | null
  coverImageOffsetX: number
  coverImageOffsetY: number
  coverImageScale: number
  isDefault: boolean
  publishedAt: string | null
  createdAt: string
  updatedAt: string
  itemCount: number
}

export interface CollectionItem {
  id: number
  collectionId: number
  pageId: number
  annotation: string | null
  order: number
  pinned: boolean
  createdAt: string
  updatedAt: string
  page: {
    id: number
    wikidotId: number | null
    currentUrl: string | null
    slug: string | null
    title: string | null
    alternateTitle: string | null
    rating: number | null
  }
}

export interface CollectionDetail {
  collection: CollectionSummary
  items: CollectionItem[]
}

interface CollectionsState {
  /**
   * 私有收藏数据属于哪个登录账号。null 表示当前没有已确认的登录身份。
   * 该字段随 Nuxt state 一起保存，避免 hydration/HMR 后把旧账号缓存误认成当前账号。
   */
  privateOwnerId: string | null
  /**
   * 每次身份切换或显式 reset 都递增。在途请求只允许写回发起时的同一世代。
   */
  privateEpoch: number
  loading: boolean
  collections: CollectionSummary[]
  total: number
  lastFetchedAt: string | null
  active: Record<number, CollectionDetail>
  saving: boolean
  error: string | null
  publicCache: Record<string, CollectionDetail>
  publicList: Record<string, CollectionSummary[]>
}

const MAX_CACHE_AGE_MS = 60_000

function createState(): CollectionsState {
  return {
    privateOwnerId: null,
    privateEpoch: 0,
    loading: false,
    collections: [],
    total: 0,
    lastFetchedAt: null,
    active: {},
    saving: false,
    error: null,
    publicCache: {},
    publicList: {}
  }
}

export function useCollections() {
  const { $bff } = useNuxtApp()
  const { user: authUser, status: authStatus } = useAuth()
  const state = useState<CollectionsState>('collections/state', createState)

  interface PrivateRequestToken {
    ownerId: string | null
    epoch: number
  }

  function currentOwnerId(): string | null {
    if (authStatus.value !== 'authenticated') return null
    const id = authUser.value?.id?.trim()
    return id || null
  }

  function clearRecord<T>(record: Record<string | number, T>) {
    for (const key of Object.keys(record)) {
      delete record[key]
    }
  }

  /**
   * 只清私有数据，公开收藏缓存与登录身份无关，可以安全保留。
   * 原地清 active，避免已有调用方持有旧对象引用时继续读到上个账号的详情。
   */
  function resetState(ownerId = currentOwnerId()) {
    state.value.privateEpoch = (Number(state.value.privateEpoch) || 0) + 1
    state.value.privateOwnerId = ownerId
    state.value.loading = false
    state.value.collections = []
    state.value.total = 0
    state.value.lastFetchedAt = null
    clearRecord(state.value.active)
    state.value.saving = false
    state.value.error = null
  }

  function beginPrivateRequest(): PrivateRequestToken {
    const ownerId = currentOwnerId()
    // 兼容旧版本 hydration state（字段为 undefined）并防止同标签页 A→B 泄露。
    if (state.value.privateOwnerId !== ownerId) {
      resetState(ownerId)
    }
    return {
      ownerId,
      epoch: state.value.privateEpoch
    }
  }

  function isCurrentRequest(token: PrivateRequestToken): boolean {
    return state.value.privateEpoch === token.epoch
      && state.value.privateOwnerId === token.ownerId
      && currentOwnerId() === token.ownerId
  }

  function markError(message: string | null, token?: PrivateRequestToken) {
    if (token && !isCurrentRequest(token)) return
    state.value.error = message
  }

  function staleMutationResult() {
    return {
      ok: false as const,
      error: '登录账号已切换，请重新操作。'
    }
  }

  // 组件一挂载就校验归属，不能等第一次网络请求才清掉旧账号的同步缓存。
  beginPrivateRequest()

  async function fetchCollections(force = false) {
    const token = beginPrivateRequest()
    console.debug('[collections] fetchCollections invoked', {
      force,
      loading: state.value.loading,
      lastFetchedAt: state.value.lastFetchedAt,
      cachedLength: state.value.collections.length
    })
    if (!force && state.value.lastFetchedAt) {
      const last = new Date(state.value.lastFetchedAt).getTime()
      if (Date.now() - last < MAX_CACHE_AGE_MS && state.value.collections.length > 0) {
        console.debug('[collections] fetchCollections hit cache')
        return state.value.collections
      }
    }
    if (state.value.loading) return state.value.collections
    state.value.loading = true
    markError(null)
    try {
      const res = await $bff<{ ok: boolean; items: CollectionSummary[]; total: number }>('/collections', { method: 'GET' })
      if (!isCurrentRequest(token)) return state.value.collections
      if (res?.ok) {
        state.value.collections = Array.isArray(res.items) ? res.items : []
        state.value.total = Number.isFinite(res.total) ? Number(res.total) : 0
        state.value.lastFetchedAt = new Date().toISOString()
        console.debug('[collections] fetchCollections success', {
          length: state.value.collections.length,
          total: state.value.total
        })
      } else {
        state.value.collections = []
        state.value.total = 0
        state.value.lastFetchedAt = null
        markError('加载收藏夹失败', token)
      }
    } catch (error: unknown) {
      if (!isCurrentRequest(token)) return state.value.collections
      state.value.collections = []
      state.value.total = 0
      state.value.lastFetchedAt = null
      const message = getErrorMessage(error, '加载收藏夹失败')
      console.warn('[collections] fetchCollections error', message, error)
      markError(message, token)
    } finally {
      if (isCurrentRequest(token)) {
        state.value.loading = false
      }
    }
    return state.value.collections
  }

  async function fetchCollectionDetail(id: number, force = false): Promise<CollectionDetail | null> {
    if (!Number.isFinite(id) || id <= 0) return null
    const token = beginPrivateRequest()
    const existing = state.value.active[id]
    if (!force && existing) return existing
    try {
      const res = await $bff<{ ok: boolean; collection: CollectionSummary; items: CollectionItem[] }>(`/collections/${id}`, { method: 'GET' })
      if (!isCurrentRequest(token)) return null
      if (res?.ok && res.collection) {
        const detail: CollectionDetail = {
          collection: res.collection,
          items: Array.isArray(res.items) ? res.items : []
        }
        state.value.active[id] = detail
        // sync list cache
        const index = state.value.collections.findIndex((c) => c.id === id)
        if (index >= 0) {
          state.value.collections[index] = detail.collection
        }
        return detail
      }
      markError('收藏夹不存在', token)
      return null
    } catch (error: unknown) {
      if (!isCurrentRequest(token)) return null
      markError(getErrorMessage(error, '加载收藏夹失败'), token)
      return null
    }
  }

  async function createCollection(payload: Partial<CollectionSummary>) {
    const token = beginPrivateRequest()
    state.value.saving = true
    markError(null, token)
    try {
      const res = await $bff<{ ok: boolean; collection: CollectionSummary; error?: string }>('/collections', {
        method: 'POST',
        body: {
          title: payload.title,
          visibility: payload.visibility ?? 'PRIVATE',
          description: payload.description,
          notes: payload.notes,
          coverImageUrl: payload.coverImageUrl,
          coverImageOffsetX: typeof payload.coverImageOffsetX === 'number' ? payload.coverImageOffsetX : 0,
          coverImageOffsetY: typeof payload.coverImageOffsetY === 'number' ? payload.coverImageOffsetY : 0,
          coverImageScale: typeof payload.coverImageScale === 'number' ? payload.coverImageScale : 1,
          isDefault: payload.isDefault === true
        }
      })
      if (!isCurrentRequest(token)) return staleMutationResult()
      if (res?.ok && res.collection) {
        state.value.collections.unshift(res.collection)
        state.value.total += 1
        state.value.lastFetchedAt = new Date().toISOString()
        state.value.active[res.collection.id] = { collection: res.collection, items: [] }
        return { ok: true as const, collection: res.collection }
      }
      const message = res?.error || '创建收藏夹失败'
      markError(message, token)
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      if (!isCurrentRequest(token)) return staleMutationResult()
      const message = getErrorMessage(error, '创建收藏夹失败')
      markError(message, token)
      return { ok: false as const, error: message }
    } finally {
      if (isCurrentRequest(token)) {
        state.value.saving = false
      }
    }
  }

  async function updateCollection(id: number, payload: Partial<CollectionSummary & { visibility: CollectionVisibility }>) {
    if (!Number.isFinite(id) || id <= 0) {
      return { ok: false as const, error: '参数错误' }
    }
    const token = beginPrivateRequest()
    state.value.saving = true
    markError(null, token)
    try {
      const res = await $bff<{ ok: boolean; collection: CollectionSummary; error?: string }>(`/collections/${id}`, {
        method: 'PATCH',
        body: payload
      })
      if (!isCurrentRequest(token)) return staleMutationResult()
      if (res?.ok && res.collection) {
        const idx = state.value.collections.findIndex((c) => c.id === id)
        if (idx >= 0) {
          state.value.collections[idx] = res.collection
        }
        state.value.active[id] = {
          collection: res.collection,
          items: state.value.active[id]?.items ?? []
        }
        return { ok: true as const, collection: res.collection }
      }
      const message = res?.error || '更新失败'
      markError(message, token)
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      if (!isCurrentRequest(token)) return staleMutationResult()
      const message = getErrorMessage(error, '更新失败')
      markError(message, token)
      return { ok: false as const, error: message }
    } finally {
      if (isCurrentRequest(token)) {
        state.value.saving = false
      }
    }
  }

  async function removeCollection(id: number) {
    if (!Number.isFinite(id) || id <= 0) {
      return { ok: false as const, error: '参数错误' }
    }
    const token = beginPrivateRequest()
    state.value.saving = true
    markError(null, token)
    try {
      const res = await $bff<{ ok: boolean; deleted: number; error?: string }>(`/collections/${id}`, { method: 'DELETE' })
      if (!isCurrentRequest(token)) return staleMutationResult()
      if (res?.ok) {
        state.value.collections = state.value.collections.filter((c) => c.id !== id)
        delete state.value.active[id]
        state.value.total = Math.max(0, state.value.total - 1)
        return { ok: true as const }
      }
      const message = res?.error || '删除失败'
      markError(message, token)
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      if (!isCurrentRequest(token)) return staleMutationResult()
      const message = getErrorMessage(error, '删除失败')
      markError(message, token)
      return { ok: false as const, error: message }
    } finally {
      if (isCurrentRequest(token)) {
        state.value.saving = false
      }
    }
  }

  async function addItem(collectionId: number, payload: { pageId?: number; pageWikidotId?: number; annotation?: string | null; pinned?: boolean }) {
    if (!Number.isFinite(collectionId) || collectionId <= 0) {
      return { ok: false as const, error: '参数错误' }
    }
    const token = beginPrivateRequest()
    state.value.saving = true
    try {
      const res = await $bff<{ ok: boolean; item: CollectionItem; items: CollectionItem[]; error?: string }>(`/collections/${collectionId}/items`, {
        method: 'POST',
        body: payload
      })
      if (!isCurrentRequest(token)) return staleMutationResult()
      if (res?.ok) {
        const detail = await fetchCollectionDetail(collectionId, true)
        if (!isCurrentRequest(token)) return staleMutationResult()
        return { ok: true as const, item: res.item, detail }
      }
      const message = res?.error || '添加失败'
      markError(message, token)
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      if (!isCurrentRequest(token)) return staleMutationResult()
      const message = getErrorMessage(error, '添加失败')
      markError(message, token)
      return { ok: false as const, error: message }
    } finally {
      if (isCurrentRequest(token)) {
        state.value.saving = false
      }
    }
  }

  async function updateItem(collectionId: number, itemId: number, payload: Partial<CollectionItem>) {
    if (!Number.isFinite(collectionId) || collectionId <= 0 || !Number.isFinite(itemId) || itemId <= 0) {
      return { ok: false as const, error: '参数错误' }
    }
    const token = beginPrivateRequest()
    state.value.saving = true
    try {
      const res = await $bff<{ ok: boolean; item: CollectionItem; error?: string }>(`/collections/${collectionId}/items/${itemId}`, {
        method: 'PATCH',
        body: payload
      })
      if (!isCurrentRequest(token)) return staleMutationResult()
      if (res?.ok && res.item) {
        const detail = state.value.active[collectionId]
        if (detail) {
          const index = detail.items.findIndex((item) => item.id === itemId)
          if (index >= 0) {
            detail.items[index] = res.item
          }
        }
        return { ok: true as const, item: res.item }
      }
      const message = res?.error || '更新失败'
      markError(message, token)
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      if (!isCurrentRequest(token)) return staleMutationResult()
      const message = getErrorMessage(error, '更新失败')
      markError(message, token)
      return { ok: false as const, error: message }
    } finally {
      if (isCurrentRequest(token)) {
        state.value.saving = false
      }
    }
  }

  async function removeItem(collectionId: number, itemId: number) {
    if (!Number.isFinite(collectionId) || collectionId <= 0 || !Number.isFinite(itemId) || itemId <= 0) {
      return { ok: false as const, error: '参数错误' }
    }
    const token = beginPrivateRequest()
    state.value.saving = true
    try {
      const res = await $bff<{ ok: boolean; deleted: number; error?: string }>(`/collections/${collectionId}/items/${itemId}`, { method: 'DELETE' })
      if (!isCurrentRequest(token)) return staleMutationResult()
      if (res?.ok) {
        const detail = state.value.active[collectionId]
        if (detail) {
          detail.items = detail.items.filter((item) => item.id !== itemId)
          detail.collection.itemCount = Math.max(0, detail.collection.itemCount - 1)
        }
        return { ok: true as const }
      }
      const message = res?.error || '删除失败'
      markError(message, token)
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      if (!isCurrentRequest(token)) return staleMutationResult()
      const message = getErrorMessage(error, '删除失败')
      markError(message, token)
      return { ok: false as const, error: message }
    } finally {
      if (isCurrentRequest(token)) {
        state.value.saving = false
      }
    }
  }

  async function reorderItems(collectionId: number, orderedIds: number[]) {
    if (!Number.isFinite(collectionId) || collectionId <= 0 || orderedIds.length === 0) {
      return { ok: false as const, error: '参数错误' }
    }
    const token = beginPrivateRequest()
    state.value.saving = true
    try {
      const res = await $bff<{ ok: boolean; items: CollectionItem[]; error?: string }>(`/collections/${collectionId}/items/reorder`, {
        method: 'POST',
        body: { order: orderedIds }
      })
      if (!isCurrentRequest(token)) return staleMutationResult()
      if (res?.ok && Array.isArray(res.items)) {
        const detail = state.value.active[collectionId]
        if (detail) {
          detail.items = res.items
        }
        return { ok: true as const, items: res.items }
      }
      const message = res?.error || '排序失败'
      markError(message, token)
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      if (!isCurrentRequest(token)) return staleMutationResult()
      const message = getErrorMessage(error, '排序失败')
      markError(message, token)
      return { ok: false as const, error: message }
    } finally {
      if (isCurrentRequest(token)) {
        state.value.saving = false
      }
    }
  }

  async function fetchPublicCollections(wikidotId: number, force = false) {
    if (!Number.isFinite(wikidotId) || wikidotId <= 0) return []
    const listKey = String(wikidotId)
    const cached = state.value.publicList[listKey]
    if (!force && cached) return cached
    try {
      const res = await $bff<{ ok: boolean; items: CollectionSummary[]; total: number }>(
        `/collections/public/user/${wikidotId}`,
        { method: 'GET' }
      )
      if (res?.ok && Array.isArray(res.items)) {
        state.value.publicList[listKey] = res.items
        return res.items
      }
      return []
    } catch {
      return []
    }
  }

  async function fetchPublicCollectionDetail(wikidotId: number, slug: string, force = false) {
    if (!Number.isFinite(wikidotId) || wikidotId <= 0 || !slug) return null
    const cacheKey = `${wikidotId}:${slug}`
    if (!force && state.value.publicCache[cacheKey]) {
      return state.value.publicCache[cacheKey]
    }
    try {
      const res = await $bff<{ ok: boolean; collection: CollectionSummary; items: CollectionItem[] }>(
        `/collections/public/user/${wikidotId}/${slug}`,
        { method: 'GET' }
      )
      if (res?.ok && res.collection) {
        const detail: CollectionDetail = {
          collection: res.collection,
          items: Array.isArray(res.items) ? res.items : []
        }
        state.value.publicCache[cacheKey] = detail
        return detail
      }
      return null
    } catch {
      return null
    }
  }

  const collections = computed(() => state.value.collections)
  const loading = computed(() => state.value.loading)
  const saving = computed(() => state.value.saving)
  const error = computed(() => state.value.error)

  return {
    collections,
    loading,
    saving,
    error,
    total: computed(() => state.value.total),
    active: state.value.active,
    resetState,
    fetchCollections,
    fetchCollectionDetail,
    createCollection,
    updateCollection,
    removeCollection,
    addItem,
    updateItem,
    removeItem,
    reorderItems,
    fetchPublicCollections,
    fetchPublicCollectionDetail
  }
}
