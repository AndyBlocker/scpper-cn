import { useNuxtApp, useState } from 'nuxt/app'

export interface PageAuthor {
  name: string
  wikidotId: number | null
}

type AuthorCache = Record<number, PageAuthor[]>
type PendingMap = Record<number, boolean>

function chunkIds(ids: number[], size: number) {
  const chunks: number[][] = []
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size))
  }
  return chunks
}

export function usePageAuthors() {
  const cache = useState<AuthorCache>('page-authors/cache', () => ({}))
  const pending = useState<PendingMap>('page-authors/pending', () => ({}))
  const nuxt = useNuxtApp()

  function getAuthors(wikidotId?: number | null): PageAuthor[] {
    if (!wikidotId || !Number.isFinite(wikidotId)) return []
    return cache.value[wikidotId] ?? []
  }

  async function ensureAuthors(ids: Array<number | null | undefined>) {
    const targets = Array.from(
      new Set(
        ids
          .map((id) => (Number.isFinite(Number(id)) ? Number(id) : null))
          .filter((id): id is number => Number.isFinite(id) && id > 0)
      )
    ).filter((id) => cache.value[id] == null && pending.value[id] !== true)

    if (targets.length === 0) return
    targets.forEach((id) => {
      pending.value[id] = true
    })

    const chunks = chunkIds(targets, 5)
    for (const chunk of chunks) {
      await Promise.all(
        chunk.map(async (id) => {
          try {
            const response = await nuxt.$bff<any>(`/pages/${id}/attributions`, { method: 'GET' })
            const authors = Array.isArray(response)
              ? response
                  .map((entry: any) => {
                    const name = String(entry?.displayName ?? '').trim()
                    if (!name) return null
                    const wikidotId =
                      entry?.userWikidotId != null && Number.isFinite(Number(entry.userWikidotId))
                        ? Number(entry.userWikidotId)
                        : null
                    return { name, wikidotId }
                  })
                  .filter((author): author is PageAuthor => !!author)
              : []
            cache.value[id] = authors
          } catch (_error) {
            cache.value[id] = []
          } finally {
            delete pending.value[id]
          }
        })
      )
    }
  }

  return {
    getAuthors,
    ensureAuthors
  }
}
