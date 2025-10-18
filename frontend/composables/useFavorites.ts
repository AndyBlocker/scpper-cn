import { computed } from 'vue'
import { useState } from 'nuxt/app'

export interface FavoritePageSnapshot {
  id: number
  title: string
  alternateTitle?: string | null
  rating?: number | null
  tags?: string[]
  commentCount?: number | null
  controversy?: number | null
  snippet?: string | null
  addedAt: string
}

interface FavoriteState {
  pages: FavoritePageSnapshot[]
  loaded: boolean
}

const STORAGE_KEY = 'scpper:favorites:v1'
const MAX_ENTRIES = 120

function nowIso() {
  return new Date().toISOString()
}

function normalizePageInput(input: Partial<FavoritePageSnapshot> & { id: number; title?: string | null }) {
  const title = (input.title || '').trim() || '未命名页面'
  const normalizeNumeric = (value: unknown) => {
    if (value === null || value === undefined) return null
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }
  const item: FavoritePageSnapshot = {
    id: Number(input.id),
    title,
    alternateTitle: (input.alternateTitle ?? null) || null,
    rating: input.rating ?? null,
    tags: Array.isArray(input.tags) ? [...new Set(input.tags.filter(Boolean))] : [],
    commentCount: normalizeNumeric(input.commentCount),
    controversy: normalizeNumeric(input.controversy),
    snippet: typeof input.snippet === 'string' ? input.snippet : null,
    addedAt: input.addedAt || nowIso()
  }
  return item
}

export function useFavorites() {
  const state = useState<FavoriteState>('favorites-store', () => ({
    pages: [],
    loaded: false
  }))

  function ensureLoaded() {
    if (state.value.loaded || !process.client) return
    try {
      const payload = localStorage.getItem(STORAGE_KEY)
      if (payload) {
        const parsed = JSON.parse(payload) as Partial<FavoriteState>
        state.value.pages = Array.isArray(parsed.pages)
          ? parsed.pages
              .map((p: any) => {
                if (!p || typeof p !== 'object') return null
                if (!Number.isFinite(Number(p.id))) return null
                return normalizePageInput({
                  id: Number(p.id),
                  title: typeof p.title === 'string' ? p.title : '未命名页面',
                  alternateTitle: typeof p.alternateTitle === 'string' ? p.alternateTitle : null,
                  rating: Number.isFinite(Number(p.rating)) ? Number(p.rating) : null,
                  tags: Array.isArray(p.tags) ? p.tags.filter((t: any) => typeof t === 'string') : [],
                  addedAt: typeof p.addedAt === 'string' ? p.addedAt : nowIso(),
                  commentCount: Number.isFinite(Number(p.commentCount)) ? Number(p.commentCount) : null,
                  controversy: Number.isFinite(Number(p.controversy)) ? Number(p.controversy) : null,
                  snippet: typeof p.snippet === 'string' ? p.snippet : null
                })
              })
              .filter((p): p is FavoritePageSnapshot => !!p)
          : []
      }
    } catch (error) {
      console.warn('[favorites] failed to load from storage', error)
      state.value.pages = []
    } finally {
      state.value.loaded = true
    }
  }

  function persist() {
    if (!process.client) return
    try {
      const payload = JSON.stringify({
        pages: state.value.pages.slice(0, MAX_ENTRIES)
      })
      localStorage.setItem(STORAGE_KEY, payload)
    } catch (error) {
      console.warn('[favorites] failed to persist', error)
    }
  }

  function isPageFavorite(id: number | string | null | undefined) {
    ensureLoaded()
    const numeric = Number(id)
    if (!Number.isFinite(numeric)) return false
    return state.value.pages.some((p) => p.id === Math.trunc(numeric))
  }

  function togglePageFavorite(input: Partial<FavoritePageSnapshot> & { id: number | string; title?: string | null }) {
    ensureLoaded()
    const numeric = Number(input.id)
    if (!Number.isFinite(numeric) || numeric <= 0) return
    const id = Math.trunc(numeric)
    const idx = state.value.pages.findIndex((p) => p.id === id)
    if (idx >= 0) {
      state.value.pages.splice(idx, 1)
    } else {
      const item = normalizePageInput({
        ...input,
        id
      })
      state.value.pages.unshift(item)
      if (state.value.pages.length > MAX_ENTRIES) {
        state.value.pages.length = MAX_ENTRIES
      }
    }
    persist()
  }

  function removePageFavorite(id: number | string) {
    ensureLoaded()
    const numeric = Number(id)
    if (!Number.isFinite(numeric)) return
    const idx = state.value.pages.findIndex((p) => p.id === Math.trunc(numeric))
    if (idx >= 0) {
      state.value.pages.splice(idx, 1)
      persist()
    }
  }

  const favoritePages = computed(() => {
    ensureLoaded()
    return state.value.pages
  })

  return {
    favoritePages,
    isPageFavorite,
    togglePageFavorite,
    removePageFavorite
  }
}
