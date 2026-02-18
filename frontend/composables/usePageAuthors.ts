import { useNuxtApp, useState } from 'nuxt/app'

export interface PageAuthor {
  name: string
  wikidotId: number | null
}

type AuthorCache = Record<number, PageAuthor[]>
type PendingMap = Record<number, boolean>
type FailureMap = Record<number, number>

const AUTHOR_STORAGE_KEY = 'page-authors/v1'
const AUTHOR_STORAGE_MAX = 800
const AUTHOR_FAIL_COOLDOWN_MS = 10 * 60 * 1000
const AUTHOR_BATCH_SIZE = 120

function chunkIds(ids: number[], size: number) {
  const chunks: number[][] = []
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size))
  }
  return chunks
}

function normalizeAuthors(entries: any[]): PageAuthor[] {
  const rows = Array.isArray(entries) ? entries : []
  const dedupe = new Set<string>()
  const normalized: PageAuthor[] = []
  for (const entry of rows) {
    const name = String(entry?.displayName ?? entry?.name ?? '').trim()
    if (!name) continue
    const rawId = Number(entry?.userWikidotId ?? entry?.wikidotId)
    const wikidotId = Number.isFinite(rawId) && rawId > 0 ? rawId : null
    const key = wikidotId != null ? `id:${wikidotId}` : `name:${name.toLowerCase()}`
    if (dedupe.has(key)) continue
    dedupe.add(key)
    normalized.push({ name, wikidotId })
  }
  return normalized
}

export function usePageAuthors() {
  const cache = useState<AuthorCache>('page-authors/cache', () => ({}))
  const pending = useState<PendingMap>('page-authors/pending', () => ({}))
  const failUntil = useState<FailureMap>('page-authors/fail-until', () => ({}))
  const hydrated = useState<boolean>('page-authors/hydrated', () => false)
  const nuxt = useNuxtApp()

  function persistCacheToStorage() {
    if (!import.meta.client) return
    try {
      const entries = Object.entries(cache.value)
        .filter(([id, authors]) => Number(id) > 0 && Array.isArray(authors) && authors.length > 0)
        .slice(0, AUTHOR_STORAGE_MAX)
        .map(([id, authors]) => ({ id: Number(id), authors }))
      localStorage.setItem(AUTHOR_STORAGE_KEY, JSON.stringify(entries))
    } catch {
      // Ignore localStorage failures.
    }
  }

  function hydrateCacheFromStorage() {
    if (!import.meta.client || hydrated.value) return
    hydrated.value = true
    try {
      const raw = localStorage.getItem(AUTHOR_STORAGE_KEY)
      if (!raw) return
      const rows = JSON.parse(raw)
      if (!Array.isArray(rows)) return
      for (const entry of rows) {
        const id = Number(entry?.id)
        if (!Number.isFinite(id) || id <= 0) continue
        if (cache.value[id]?.length) continue
        const authors = normalizeAuthors(entry?.authors)
        if (!authors.length) continue
        cache.value[id] = authors
      }
    } catch {
      // Ignore malformed localStorage payloads.
    }
  }

  function mergeAuthors(current: PageAuthor[], incoming: PageAuthor[]) {
    const dedupe = new Set<string>()
    const merged: PageAuthor[] = []
    for (const entry of [...current, ...incoming]) {
      const name = String(entry?.name ?? '').trim()
      if (!name) continue
      const rawId = Number(entry?.wikidotId)
      const wikidotId = Number.isFinite(rawId) && rawId > 0 ? rawId : null
      const key = wikidotId != null ? `id:${wikidotId}` : `name:${name.toLowerCase()}`
      if (dedupe.has(key)) continue
      dedupe.add(key)
      merged.push({ name, wikidotId })
    }
    return merged
  }

  function seedAuthors(wikidotId: number | null | undefined, entries: any[] | null | undefined) {
    const id = Number(wikidotId)
    if (!Number.isFinite(id) || id <= 0) return
    const incoming = normalizeAuthors(Array.isArray(entries) ? entries : [])
    if (!incoming.length) return
    const merged = mergeAuthors(cache.value[id] ?? [], incoming)
    if (!merged.length) return
    cache.value[id] = merged
    delete failUntil.value[id]
    persistCacheToStorage()
  }

  function getAuthors(wikidotId?: number | null): PageAuthor[] {
    hydrateCacheFromStorage()
    if (!wikidotId || !Number.isFinite(wikidotId)) return []
    return cache.value[wikidotId] ?? []
  }

  function isCoolingDown(wikidotId?: number | null) {
    const id = Number(wikidotId)
    if (!Number.isFinite(id) || id <= 0) return false
    return Number(failUntil.value[id] ?? 0) > Date.now()
  }

  async function ensureAuthors(ids: Array<number | null | undefined>) {
    hydrateCacheFromStorage()
    const now = Date.now()
    const targets = Array.from(
      new Set(
        ids
          .map((id) => (Number.isFinite(Number(id)) ? Number(id) : null))
          .filter((id): id is number => Number.isFinite(id) && id > 0)
      )
    ).filter((id) => (
      cache.value[id] == null
      && pending.value[id] !== true
      && Number(failUntil.value[id] ?? 0) <= now
    ))

    if (targets.length === 0) return
    targets.forEach((id) => {
      pending.value[id] = true
    })

    const chunks = chunkIds(targets, AUTHOR_BATCH_SIZE)
    for (const chunk of chunks) {
      try {
        const response = await nuxt.$bff<any>('/pages/attributions/batch', {
          method: 'GET',
          params: { ids: chunk.join(',') }
        })
        const rows = Array.isArray(response?.items) ? response.items : []
        const touched = new Set<number>()
        let hasNewAuthors = false

        for (const row of rows) {
          const id = Number(row?.wikidotId ?? row?.id)
          if (!Number.isFinite(id) || id <= 0) continue
          const payload = Array.isArray(row?.attributions)
            ? row.attributions
            : (Array.isArray(row?.authors) ? row.authors : [])
          const authors = normalizeAuthors(payload)
          cache.value[id] = authors
          touched.add(id)
          delete failUntil.value[id]
          if (authors.length) {
            hasNewAuthors = true
          }
        }

        for (const id of chunk) {
          if (!touched.has(id)) {
            cache.value[id] = cache.value[id] ?? []
            delete failUntil.value[id]
          }
        }

        if (hasNewAuthors) {
          persistCacheToStorage()
        }
      } catch (_error) {
        for (const id of chunk) {
          failUntil.value[id] = Date.now() + AUTHOR_FAIL_COOLDOWN_MS
        }
      } finally {
        for (const id of chunk) {
          delete pending.value[id]
        }
      }
    }
  }

  return {
    getAuthors,
    ensureAuthors,
    seedAuthors,
    isCoolingDown
  }
}
