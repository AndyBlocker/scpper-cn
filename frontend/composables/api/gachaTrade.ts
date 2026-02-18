import type { GachaCoreContext, ApiResponse } from './gachaCore'
import { normalizeError } from './gachaCore'
import type { TradeListing, Wallet, Rarity } from '~/types/gacha'
import type { TradeSortMode } from '~/utils/gachaConstants'

export function useGachaTradeApi(core: GachaCoreContext) {
  const { $bff, state, withTradeListingCardVariant, createIdempotencyKey } = core

  async function getTradeListings(params: {
    status?: 'OPEN' | 'SOLD' | 'CANCELLED' | 'EXPIRED' | 'ALL'
    cardId?: string
    mine?: boolean
    search?: string
    searchMode?: 'ALL' | 'CARD' | 'SELLER'
    rarity?: Rarity
    sort?: TradeSortMode
    limit?: number
    offset?: number
  } = {}) {
    try {
      const res = await $bff<ApiResponse<{
        items: TradeListing[]
        pagination?: { total: number; limit: number; offset: number }
      }>>('/gacha/trade/listings', {
        method: 'GET',
        params: {
          status: params.status,
          cardId: params.cardId,
          mine: params.mine ? '1' : '0',
          search: params.search?.trim() || undefined,
          searchMode: params.searchMode,
          rarity: params.rarity,
          sort: params.sort,
          limit: params.limit != null ? String(params.limit) : undefined,
          offset: params.offset != null ? String(params.offset) : undefined
        }
      })
      if (res?.ok) {
        const items = (res.items ?? []).map(withTradeListingCardVariant)
        return {
          ok: true as const,
          data: items,
          pagination: res.pagination ?? { total: items.length, limit: params.limit ?? 20, offset: params.offset ?? 0 }
        }
      }
      return { ok: false as const, error: res?.error || '加载集换市场失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '加载集换市场失败') }
    }
  }

  async function getMyTradeListings() {
    try {
      const res = await $bff<ApiResponse<{ items: TradeListing[] }>>('/gacha/trade/my-listings', {
        method: 'GET'
      })
      if (res?.ok) {
        return { ok: true as const, data: (res.items ?? []).map(withTradeListingCardVariant) }
      }
      return { ok: false as const, error: res?.error || '加载我的挂牌失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '加载我的挂牌失败') }
    }
  }

  async function createTradeListing(payload: {
    cardId: string
    quantity: number
    unitPrice: number
    expiresHours?: number
    affixSignature?: string
  }) {
    try {
      const idemKey = createIdempotencyKey('trade-create')
      const res = await $bff<ApiResponse<{ listing: TradeListing; wallet?: Wallet }>>('/gacha/trade/listings', {
        method: 'POST',
        headers: {
          'x-idempotency-key': idemKey
        },
        body: payload
      })
      if (res?.ok) {
        if (res.wallet) {
          state.value.wallet = res.wallet
          state.value.walletFetchedAt = new Date().toISOString()
        }
        return { ok: true as const, listing: withTradeListingCardVariant(res.listing), wallet: res.wallet ?? null }
      }
      return { ok: false as const, error: res?.error || '上架失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '上架失败') }
    }
  }

  async function buyTradeListing(listingId: string, payload: { quantity?: number } = {}) {
    try {
      const idemKey = createIdempotencyKey('trade-buy')
      const res = await $bff<ApiResponse<{ listing: TradeListing; wallet?: Wallet }>>(`/gacha/trade/listings/${encodeURIComponent(listingId)}/buy`, {
        method: 'POST',
        headers: {
          'x-idempotency-key': idemKey
        },
        body: payload
      })
      if (res?.ok) {
        if (res.wallet) {
          state.value.wallet = res.wallet
          state.value.walletFetchedAt = new Date().toISOString()
        }
        return { ok: true as const, listing: withTradeListingCardVariant(res.listing), wallet: res.wallet ?? null }
      }
      return { ok: false as const, error: res?.error || '购买失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '购买失败') }
    }
  }

  async function cancelTradeListing(listingId: string) {
    try {
      const idemKey = createIdempotencyKey('trade-cancel')
      const res = await $bff<ApiResponse<{ listing: TradeListing; wallet?: Wallet }>>(`/gacha/trade/listings/${encodeURIComponent(listingId)}/cancel`, {
        method: 'POST',
        headers: {
          'x-idempotency-key': idemKey
        },
        body: {}
      })
      if (res?.ok) {
        if (res.wallet) {
          state.value.wallet = res.wallet
          state.value.walletFetchedAt = new Date().toISOString()
        }
        return { ok: true as const, listing: withTradeListingCardVariant(res.listing), wallet: res.wallet ?? null }
      }
      return { ok: false as const, error: res?.error || '撤单失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '撤单失败') }
    }
  }

  return {
    getTradeListings,
    getMyTradeListings,
    createTradeListing,
    buyTradeListing,
    cancelTradeListing
  }
}
