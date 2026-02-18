import type { GachaCoreContext, ApiResponse } from './gachaCore'
import { normalizeError } from './gachaCore'
import type {
  Rarity, AffixVisualStyle, Wallet,
  AlbumPageItem, AlbumPageDetail, AlbumSummary, AlbumPageVariant,
  DismantleBatchSummary, DismantleKeepScope
} from '~/types/gacha'

export function useGachaAlbumApi(core: GachaCoreContext) {
  const { $bff, state, normalizeImageUrl, normalizeCardTitle, withCardVariant, createIdempotencyKey } = core

  async function listAlbumPages(params: { search?: string; limit?: number; offset?: number } = {}) {
    try {
      const res = await $bff<ApiResponse<{ items: AlbumPageItem[]; total: number }>>('/gacha/album/pages', {
        method: 'GET',
        params: {
          search: params.search?.trim() || undefined,
          limit: params.limit != null ? String(params.limit) : undefined,
          offset: params.offset != null ? String(params.offset) : undefined
        }
      })
      if (res?.ok) {
        const items = (res.items ?? []).map((item) => ({
          ...item,
          title: normalizeCardTitle(item.title),
          coverImageUrl: normalizeImageUrl(item.coverImageUrl)
        }))
        return { ok: true as const, data: items, total: res.total ?? items.length }
      }
      const message = res?.error || '加载页面图鉴失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '加载页面图鉴失败')
      return { ok: false as const, error: message }
    }
  }

  async function getAlbumSummary() {
    try {
      const res = await $bff<ApiResponse<{ summary: AlbumSummary }>>('/gacha/album/summary', {
        method: 'GET'
      })
      if (res?.ok && res.summary) {
        return { ok: true as const, summary: {
          totalPages: Math.max(0, Number(res.summary.totalPages || 0)),
          totalImageVariants: Math.max(0, Number(res.summary.totalImageVariants || 0)),
          totalImageVariantsInPool: Math.max(0, Number(res.summary.totalImageVariantsInPool || 0)),
          coatingStyles: Math.max(0, Number(res.summary.coatingStyles || 0)),
          totalOwnedCount: Math.max(0, Number(res.summary.totalOwnedCount || 0))
        } }
      }
      const message = res?.error || '加载图鉴汇总失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '加载图鉴汇总失败')
      return { ok: false as const, error: message }
    }
  }

  async function getAlbumPageVariants(pageId: number) {
    try {
      const res = await $bff<ApiResponse<{ page: AlbumPageDetail; variants: AlbumPageVariant[] }>>(`/gacha/album/pages/${pageId}/variants`, {
        method: 'GET'
      })
      if (res?.ok) {
        const variants = (res.variants ?? []).map(withCardVariant)
        const page = res.page ? {
          ...res.page,
          title: normalizeCardTitle(res.page.title),
          coverImageUrl: normalizeImageUrl(res.page.coverImageUrl)
        } : null
        return { ok: true as const, page, variants }
      }
      const message = res?.error || '加载页面变体失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '加载页面变体失败')
      return { ok: false as const, error: message }
    }
  }

  async function dismantle(cardId: string, count: number, affixVisualStyle?: AffixVisualStyle, affixSignature?: string) {
    try {
      const idemKey = createIdempotencyKey('dismantle')
      const res = await $bff<ApiResponse<{ wallet: Wallet; remaining: number; reward: number }>>('/gacha/dismantle', {
        method: 'POST',
        headers: {
          'x-idempotency-key': idemKey
        },
        body: {
          cardId,
          count,
          affixVisualStyle: affixVisualStyle || undefined,
          affixSignature: affixSignature || undefined
        }
      })
      if (res?.ok) {
        if (res.wallet) {
          state.value.wallet = res.wallet
          state.value.walletFetchedAt = new Date().toISOString()
        }
        return { ok: true as const, remaining: res.remaining, reward: res.reward }
      }
      const message = res?.error || '分解失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '分解失败')
      return { ok: false as const, error: message }
    }
  }

  async function dismantleBatchByRarity(maxRarity: Rarity, keepAtLeast = 1, keepScope: DismantleKeepScope = 'CARD') {
    try {
      const idemKey = createIdempotencyKey('dismantle-batch')
      const res = await $bff<ApiResponse<{ wallet: Wallet; summary: DismantleBatchSummary }>>('/gacha/dismantle/batch', {
        method: 'POST',
        headers: {
          'x-idempotency-key': idemKey
        },
        body: { maxRarity, keepAtLeast, keepScope }
      })
      if (res?.ok) {
        if (res.wallet) {
          state.value.wallet = res.wallet
          state.value.walletFetchedAt = new Date().toISOString()
        }
        return { ok: true as const, summary: res.summary }
      }
      const message = res?.error || '批量分解失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '批量分解失败')
      return { ok: false as const, error: message }
    }
  }

  async function dismantleBatchPreview(maxRarity: Rarity, keepAtLeast = 1, keepScope: DismantleKeepScope = 'CARD') {
    try {
      const res = await $bff<ApiResponse<{ preview: DismantleBatchSummary }>>('/gacha/dismantle/batch/preview', {
        method: 'POST',
        body: { maxRarity, keepAtLeast, keepScope }
      })
      if (res?.ok) {
        return { ok: true as const, preview: res.preview }
      }
      const message = res?.error || '预览失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '预览失败')
      return { ok: false as const, error: message }
    }
  }

  async function dismantleBatchSelective(items: Array<{ cardId: string; affixSignature?: string; affixVisualStyle?: string; count: number }>) {
    try {
      const idemKey = createIdempotencyKey('dismantle-batch-selective')
      const res = await $bff<ApiResponse<{ wallet: Wallet; summary: DismantleBatchSummary }>>('/gacha/dismantle/batch-selective', {
        method: 'POST',
        headers: {
          'x-idempotency-key': idemKey
        },
        body: { items }
      })
      if (res?.ok) {
        if (res.wallet) {
          state.value.wallet = res.wallet
          state.value.walletFetchedAt = new Date().toISOString()
        }
        return { ok: true as const, summary: res.summary }
      }
      const message = res?.error || '批量分解失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '批量分解失败')
      return { ok: false as const, error: message }
    }
  }

  return {
    listAlbumPages,
    getAlbumSummary,
    getAlbumPageVariants,
    dismantle,
    dismantleBatchByRarity,
    dismantleBatchPreview,
    dismantleBatchSelective
  }
}
