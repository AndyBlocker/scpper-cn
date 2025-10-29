import { computed, watch } from 'vue'
import { useNuxtApp, useState } from 'nuxt/app'
import { useAuth } from '~/composables/useAuth'

const STATE_KEY = 'viewer-vote-map'
const isClient = typeof window !== 'undefined'

interface VoteMap {
  [wikidotId: number]: number
}

export function useViewerVotes() {
  const { user } = useAuth()
  const { $bff } = useNuxtApp()
  const voteMap = useState<VoteMap>(STATE_KEY, () => ({}))

  const viewerWikidotId = computed<number | null>(() => {
    const linked = user.value?.linkedWikidotId
    return Number.isFinite(Number(linked)) ? Number(linked) : null
  })

  watch(viewerWikidotId, () => {
    voteMap.value = {}
  })

  async function ensureVotes(rawIds: Array<number | string | null | undefined>) {
    if (!isClient) return {}
    const viewerId = viewerWikidotId.value
    if (!viewerId) return {}

    const ids = Array.from(new Set(
      rawIds
        .map((id) => {
          const value = Number(id)
          return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null
        })
        .filter((value): value is number => value !== null)
    ))

    if (ids.length === 0) {
      return {}
    }

    const missing = ids.filter((id) => voteMap.value[id] === undefined)

    if (missing.length > 0) {
      try {
        const response = await $bff<{ votes?: Record<string, number> }>('/pages/vote-status', {
          params: { viewer: viewerId, ids: missing.join(',') }
        })

        const incoming = response?.votes ?? {}
        if (incoming && typeof incoming === 'object') {
          const next: VoteMap = { ...voteMap.value }
          for (const [key, value] of Object.entries(incoming)) {
            const numericKey = Number(key)
            if (!Number.isFinite(numericKey)) continue
            next[numericKey] = Number(value)
          }
          voteMap.value = next
        }
      } catch (error) {
        console.warn('[viewer-votes] failed to fetch vote status', error)
      }
    }

    const result: Record<number, number | undefined> = {}
    for (const id of ids) {
      result[id] = voteMap.value[id]
    }
    return result
  }

  function getVote(id: number | string | null | undefined) {
    if (id == null) return undefined
    const numericId = Number(id)
    if (!Number.isFinite(numericId)) return undefined
    return voteMap.value[Math.trunc(numericId)]
  }

  async function hydratePages(pages: Array<{ wikidotId?: number | string | null; viewerVote?: number | null }>) {
    if (!isClient) return
    if (!viewerWikidotId.value) return
    if (!Array.isArray(pages) || pages.length === 0) return
    const ids = pages
      .map((page) => Number(page?.wikidotId))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => Math.trunc(id))
    if (ids.length === 0) return
    try {
      const voteResult = await ensureVotes(ids)
      for (const page of pages) {
        const id = Number(page?.wikidotId)
        if (!Number.isFinite(id)) continue
        const hydrated = voteResult?.[Math.trunc(id)]
        const cached = getVote(id)
        if (hydrated != null || cached != null || page.viewerVote != null) {
          page.viewerVote = (hydrated ?? cached ?? page.viewerVote ?? null) as number | null
        }
      }
    } catch (error) {
      console.warn('[viewer-votes] hydratePages failed', error)
    }
  }

  return {
    ensureVotes,
    getVote,
    voteMap,
    viewerWikidotId,
    hydratePages
  }
}
