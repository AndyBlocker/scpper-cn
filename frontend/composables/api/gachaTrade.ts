import type { GachaCoreContext, ApiResponse } from './gachaCore'
import { normalizeError } from './gachaCore'
import type { TradeListing, TradeActivityItem, BuyRequest, Wallet, Rarity } from '~/types/gacha'
import type { TradeSortMode } from '~/utils/gachaConstants'

export function useGachaTradeApi(core: GachaCoreContext) {
  const { $bff, state, withCardVariant, withTradeListingCardVariant, createIdempotencyKey, captureWalletSeq, setWalletIfFresh } = core

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
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '加载集换市场失败') }
    }
  }

  async function getMyTradeListings(params: { status?: string; limit?: number; offset?: number } = {}) {
    try {
      const res = await $bff<ApiResponse<{ items: TradeListing[]; pagination?: { total: number; limit: number; offset: number } }>>('/gacha/trade/my-listings', {
        method: 'GET',
        params: {
          status: params.status || undefined,
          limit: params.limit != null ? String(params.limit) : undefined,
          offset: params.offset != null ? String(params.offset) : undefined
        }
      })
      if (res?.ok) {
        return {
          ok: true as const,
          data: (res.items ?? []).map(withTradeListingCardVariant),
          pagination: res.pagination ?? null
        }
      }
      return { ok: false as const, error: res?.error || '加载我的挂牌失败' }
    } catch (error: unknown) {
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
      const walletSeq = captureWalletSeq()
      const res = await $bff<ApiResponse<{ listing: TradeListing; wallet?: Wallet }>>('/gacha/trade/listings', {
        method: 'POST',
        headers: {
          'x-idempotency-key': idemKey
        },
        body: payload
      })
      if (res?.ok) {
        if (res.wallet) {
          setWalletIfFresh(res.wallet, walletSeq)
        }
        return { ok: true as const, listing: withTradeListingCardVariant(res.listing), wallet: res.wallet ?? null }
      }
      return { ok: false as const, error: res?.error || '上架失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '上架失败') }
    }
  }

  async function buyTradeListing(listingId: string, payload: { quantity?: number } = {}) {
    try {
      const idemKey = createIdempotencyKey('trade-buy')
      const walletSeq = captureWalletSeq()
      const res = await $bff<ApiResponse<{ listing: TradeListing; wallet?: Wallet }>>(`/gacha/trade/listings/${encodeURIComponent(listingId)}/buy`, {
        method: 'POST',
        headers: {
          'x-idempotency-key': idemKey
        },
        body: payload
      })
      if (res?.ok) {
        if (res.wallet) {
          setWalletIfFresh(res.wallet, walletSeq)
        }
        return { ok: true as const, listing: withTradeListingCardVariant(res.listing), wallet: res.wallet ?? null }
      }
      return { ok: false as const, error: res?.error || '购买失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '购买失败') }
    }
  }

  async function cancelTradeListing(listingId: string) {
    try {
      const idemKey = createIdempotencyKey('trade-cancel')
      const walletSeq = captureWalletSeq()
      const res = await $bff<ApiResponse<{ listing: TradeListing; wallet?: Wallet }>>(`/gacha/trade/listings/${encodeURIComponent(listingId)}/cancel`, {
        method: 'POST',
        headers: {
          'x-idempotency-key': idemKey
        },
        body: {}
      })
      if (res?.ok) {
        if (res.wallet) {
          setWalletIfFresh(res.wallet, walletSeq)
        }
        return { ok: true as const, listing: withTradeListingCardVariant(res.listing), wallet: res.wallet ?? null }
      }
      return { ok: false as const, error: res?.error || '撤单失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '撤单失败') }
    }
  }

  async function getOwnedCardIds() {
    try {
      const res = await $bff<ApiResponse<{ cardIds: string[] }>>('/gacha/trade/owned-card-ids', {
        method: 'GET'
      })
      if (res?.ok) {
        return { ok: true as const, data: res.cardIds ?? [] }
      }
      return { ok: false as const, error: res?.error || '加载持有卡片失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '加载持有卡片失败') }
    }
  }

  function withBuyRequestCardVariant(br: BuyRequest): BuyRequest {
    return {
      ...br,
      targetCard: withCardVariant(br.targetCard),
      offeredCards: (br.offeredCards ?? []).map((offered) => ({
        ...offered,
        card: withCardVariant(offered.card)
      }))
    }
  }

  async function getMyActivity(params: { limit?: number; offset?: number } = {}) {
    try {
      const res = await $bff<ApiResponse<{
        items: TradeActivityItem[]
        pagination?: { total: number; limit: number; offset: number }
      }>>('/gacha/trade/my-activity', {
        method: 'GET',
        params: {
          limit: params.limit != null ? String(params.limit) : undefined,
          offset: params.offset != null ? String(params.offset) : undefined
        }
      })
      if (res?.ok) {
        const items = (res.items ?? []).map((item) => {
          if (item.kind === 'listing') {
            return { ...item, data: withTradeListingCardVariant(item.data as TradeListing) }
          }
          return { ...item, data: withBuyRequestCardVariant(item.data as BuyRequest) }
        })
        return {
          ok: true as const,
          data: items,
          pagination: res.pagination ?? { total: items.length, limit: params.limit ?? 20, offset: params.offset ?? 0 }
        }
      }
      return { ok: false as const, error: res?.error || '加载交易动态失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '加载交易动态失败') }
    }
  }

  return {
    getTradeListings,
    getMyTradeListings,
    createTradeListing,
    buyTradeListing,
    cancelTradeListing,
    getOwnedCardIds,
    getMyActivity
  }
}
