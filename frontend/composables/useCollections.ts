import { useNuxtApp, useState } from 'nuxt/app'
import { computed } from 'vue'

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
  const state = useState<CollectionsState>('collections/state', createState)

  function markError(message: string | null) {
    state.value.error = message
  }

  async function fetchCollections(force = false) {
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
        markError(res?.error || '加载收藏夹失败')
      }
    } catch (error: any) {
      state.value.collections = []
      state.value.total = 0
      state.value.lastFetchedAt = null
      const message = error?.message || '加载收藏夹失败'
      console.warn('[collections] fetchCollections error', message, error)
      markError(message)
    } finally {
      state.value.loading = false
    }
    return state.value.collections
  }

  async function fetchCollectionDetail(id: number, force = false): Promise<CollectionDetail | null> {
    if (!Number.isFinite(id) || id <= 0) return null
    const existing = state.value.active[id]
    if (!force && existing) return existing
    try {
      const res = await $bff<{ ok: boolean; collection: CollectionSummary; items: CollectionItem[] }>(`/collections/${id}`, { method: 'GET' })
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
      markError(res?.error || '收藏夹不存在')
      return null
    } catch (error: any) {
      markError(error?.message || '加载收藏夹失败')
      return null
    }
  }

  async function createCollection(payload: Partial<CollectionSummary>) {
    state.value.saving = true
    markError(null)
    try {
      const res = await $bff<{ ok: boolean; collection: CollectionSummary; error?: string }>('/collections', {
        method: 'POST',
        body: {
          title: payload.title,
          description: payload.description,
          notes: payload.notes,
          coverImageUrl: payload.coverImageUrl,
          coverImageOffsetX: typeof payload.coverImageOffsetX === 'number' ? payload.coverImageOffsetX : 0,
          coverImageOffsetY: typeof payload.coverImageOffsetY === 'number' ? payload.coverImageOffsetY : 0,
          coverImageScale: typeof payload.coverImageScale === 'number' ? payload.coverImageScale : 1,
          isDefault: payload.isDefault === true
        }
      })
      if (res?.ok && res.collection) {
        state.value.collections.unshift(res.collection)
        state.value.total += 1
        state.value.lastFetchedAt = new Date().toISOString()
        state.value.active[res.collection.id] = { collection: res.collection, items: [] }
        return { ok: true as const, collection: res.collection }
      }
      const message = res?.error || '创建收藏夹失败'
      markError(message)
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = error?.data?.error || error?.message || '创建收藏夹失败'
      markError(message)
      return { ok: false as const, error: message }
    } finally {
      state.value.saving = false
    }
  }

  async function updateCollection(id: number, payload: Partial<CollectionSummary & { visibility: CollectionVisibility }>) {
    if (!Number.isFinite(id) || id <= 0) {
      return { ok: false as const, error: '参数错误' }
    }
    state.value.saving = true
    markError(null)
    try {
      const res = await $bff<{ ok: boolean; collection: CollectionSummary; error?: string }>(`/collections/${id}`, {
        method: 'PATCH',
        body: payload
      })
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
      markError(message)
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = error?.data?.error || error?.message || '更新失败'
      markError(message)
      return { ok: false as const, error: message }
    } finally {
      state.value.saving = false
    }
  }

  async function removeCollection(id: number) {
    if (!Number.isFinite(id) || id <= 0) {
      return { ok: false as const, error: '参数错误' }
    }
    state.value.saving = true
    markError(null)
    try {
      const res = await $bff<{ ok: boolean; deleted: number; error?: string }>(`/collections/${id}`, { method: 'DELETE' })
      if (res?.ok) {
        state.value.collections = state.value.collections.filter((c) => c.id !== id)
        delete state.value.active[id]
        state.value.total = Math.max(0, state.value.total - 1)
        return { ok: true as const }
      }
      const message = res?.error || '删除失败'
      markError(message)
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = error?.data?.error || error?.message || '删除失败'
      markError(message)
      return { ok: false as const, error: message }
    } finally {
      state.value.saving = false
    }
  }

  async function addItem(collectionId: number, payload: { pageId?: number; pageWikidotId?: number; annotation?: string | null; pinned?: boolean }) {
    if (!Number.isFinite(collectionId) || collectionId <= 0) {
      return { ok: false as const, error: '参数错误' }
    }
    state.value.saving = true
    try {
      const res = await $bff<{ ok: boolean; item: CollectionItem; items: CollectionItem[]; error?: string }>(`/collections/${collectionId}/items`, {
        method: 'POST',
        body: payload
      })
      if (res?.ok) {
        const detail = await fetchCollectionDetail(collectionId, true)
        return { ok: true as const, item: res.item, detail }
      }
      const message = res?.error || '添加失败'
      markError(message)
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = error?.data?.error || error?.message || '添加失败'
      markError(message)
      return { ok: false as const, error: message }
    } finally {
      state.value.saving = false
    }
  }

  async function updateItem(collectionId: number, itemId: number, payload: Partial<CollectionItem>) {
    if (!Number.isFinite(collectionId) || collectionId <= 0 || !Number.isFinite(itemId) || itemId <= 0) {
      return { ok: false as const, error: '参数错误' }
    }
    state.value.saving = true
    try {
      const res = await $bff<{ ok: boolean; item: CollectionItem; error?: string }>(`/collections/${collectionId}/items/${itemId}`, {
        method: 'PATCH',
        body: payload
      })
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
      markError(message)
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = error?.data?.error || error?.message || '更新失败'
      markError(message)
      return { ok: false as const, error: message }
    } finally {
      state.value.saving = false
    }
  }

  async function removeItem(collectionId: number, itemId: number) {
    if (!Number.isFinite(collectionId) || collectionId <= 0 || !Number.isFinite(itemId) || itemId <= 0) {
      return { ok: false as const, error: '参数错误' }
    }
    state.value.saving = true
    try {
      const res = await $bff<{ ok: boolean; deleted: number; error?: string }>(`/collections/${collectionId}/items/${itemId}`, { method: 'DELETE' })
      if (res?.ok) {
        const detail = state.value.active[collectionId]
        if (detail) {
          detail.items = detail.items.filter((item) => item.id !== itemId)
          detail.collection.itemCount = Math.max(0, detail.collection.itemCount - 1)
        }
        return { ok: true as const }
      }
      const message = res?.error || '删除失败'
      markError(message)
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = error?.data?.error || error?.message || '删除失败'
      markError(message)
      return { ok: false as const, error: message }
    } finally {
      state.value.saving = false
    }
  }

  async function reorderItems(collectionId: number, orderedIds: number[]) {
    if (!Number.isFinite(collectionId) || collectionId <= 0 || orderedIds.length === 0) {
      return { ok: false as const, error: '参数错误' }
    }
    state.value.saving = true
    try {
      const res = await $bff<{ ok: boolean; items: CollectionItem[]; error?: string }>(`/collections/${collectionId}/items/reorder`, {
        method: 'POST',
        body: { order: orderedIds }
      })
      if (res?.ok && Array.isArray(res.items)) {
        const detail = state.value.active[collectionId]
        if (detail) {
          detail.items = res.items
        }
        return { ok: true as const, items: res.items }
      }
      const message = res?.error || '排序失败'
      markError(message)
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = error?.data?.error || error?.message || '排序失败'
      markError(message)
      return { ok: false as const, error: message }
    } finally {
      state.value.saving = false
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
