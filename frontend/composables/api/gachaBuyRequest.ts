import type { GachaCoreContext, ApiResponse } from './gachaCore'
import { normalizeError } from './gachaCore'
import type { BuyRequest, BuyRequestMatchLevel, AffixVisualStyle, CardCatalogItem, PageCatalogEntry, Wallet, Rarity } from '~/types/gacha'
import type { BuyRequestSortMode } from '~/utils/gachaConstants'

export function useGachaBuyRequestApi(core: GachaCoreContext) {
  const { $bff, state, createIdempotencyKey, withCardVariant, captureWalletSeq, setWalletIfFresh } = core

  const withBuyRequestCardVariant = (request: BuyRequest): BuyRequest => ({
    ...request,
    targetCard: withCardVariant(request.targetCard),
    offeredCards: (request.offeredCards ?? []).map((offered) => ({
      ...offered,
      card: withCardVariant(offered.card)
    }))
  })

  async function getBuyRequests(params: {
    status?: 'OPEN' | 'ALL'
    targetCardId?: string
    search?: string
    rarity?: Rarity
    sort?: BuyRequestSortMode
    limit?: number
    offset?: number
    fulfillableOnly?: boolean
  } = {}) {
    try {
      const res = await $bff<ApiResponse<{
        items: BuyRequest[]
        pagination?: { total: number; limit: number; offset: number }
      }>>('/gacha/trade/buy-requests', {
        method: 'GET',
        params: {
          status: params.status,
          targetCardId: params.targetCardId,
          search: params.search?.trim() || undefined,
          rarity: params.rarity,
          sort: params.sort,
          limit: params.limit != null ? String(params.limit) : undefined,
          offset: params.offset != null ? String(params.offset) : undefined,
          fulfillableOnly: params.fulfillableOnly ? '1' : undefined
        }
      })
      if (res?.ok) {
        const items = (res.items ?? []).map(withBuyRequestCardVariant)
        return {
          ok: true as const,
          data: items,
          pagination: res.pagination ?? { total: items.length, limit: params.limit ?? 60, offset: params.offset ?? 0 }
        }
      }
      return { ok: false as const, error: res?.error || '加载求购列表失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '加载求购列表失败') }
    }
  }

  async function getMyBuyRequests() {
    try {
      const res = await $bff<ApiResponse<{ items: BuyRequest[] }>>('/gacha/trade/my-buy-requests', {
        method: 'GET'
      })
      if (res?.ok) {
        return { ok: true as const, data: (res.items ?? []).map(withBuyRequestCardVariant) }
      }
      return { ok: false as const, error: res?.error || '加载我的求购失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '加载我的求购失败') }
    }
  }

  async function getCardCatalog() {
    try {
      const res = await $bff<ApiResponse<{ pages: Array<{ variants: Array<{ id: string; imageUrl: string | null; isRetired?: boolean }>; title: string }> }>>('/gacha/trade/buy-requests/card-catalog', {
        method: 'GET'
      })
      if (res?.ok) {
        const cards = (res.pages ?? []).flatMap(p => p.variants.map(v => withCardVariant({ ...v, title: p.title })))
        return { ok: true as const, data: cards }
      }
      return { ok: false as const, error: res?.error || '加载卡片目录失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '加载卡片目录失败') }
    }
  }

  async function getPageCatalog() {
    try {
      const res = await $bff<ApiResponse<{ pages: PageCatalogEntry[] }>>('/gacha/trade/buy-requests/card-catalog', {
        method: 'GET'
      })
      if (res?.ok) {
        const pages = (res.pages ?? []).map(page => ({
          ...page,
          title: withCardVariant({ title: page.title, imageUrl: null }).title,
          variants: page.variants.map(v => ({
            id: v.id,
            imageUrl: withCardVariant({ title: '', imageUrl: v.imageUrl }).imageUrl ?? null,
            isRetired: !!v.isRetired
          }))
        }))
        return { ok: true as const, data: pages }
      }
      return { ok: false as const, error: res?.error || '加载页面目录失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '加载页面目录失败') }
    }
  }

  async function createBuyRequest(payload: {
    targetCardId: string
    matchLevel?: BuyRequestMatchLevel
    requiredCoating?: AffixVisualStyle
    tokenOffer: number
    offeredCards: Array<{ cardId: string; affixSignature?: string; quantity: number }>
    expiresHours?: number
  }) {
    try {
      const idemKey = createIdempotencyKey('buy-request-create')
      const walletSeq = captureWalletSeq()
      const res = await $bff<ApiResponse<{ buyRequest: BuyRequest; wallet?: Wallet }>>('/gacha/trade/buy-requests', {
        method: 'POST',
        headers: { 'x-idempotency-key': idemKey },
        body: payload
      })
      if (res?.ok) {
        if (res.wallet) {
          setWalletIfFresh(res.wallet, walletSeq)
        }
        return {
          ok: true as const,
          buyRequest: withBuyRequestCardVariant(res.buyRequest),
          wallet: res.wallet ?? null
        }
      }
      return { ok: false as const, error: res?.error || '创建求购失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '创建求购失败') }
    }
  }

  async function fulfillBuyRequest(
    buyRequestId: string,
    payload?: { selectedCardId?: string; selectedAffixSignature?: string }
  ) {
    try {
      const idemKey = createIdempotencyKey('buy-request-fulfill')
      const walletSeq = captureWalletSeq()
      const res = await $bff<ApiResponse<{ buyRequest: BuyRequest; wallet?: Wallet }>>(`/gacha/trade/buy-requests/${encodeURIComponent(buyRequestId)}/fulfill`, {
        method: 'POST',
        headers: { 'x-idempotency-key': idemKey },
        body: {
          selectedCardId: payload?.selectedCardId,
          selectedAffixSignature: payload?.selectedAffixSignature
        }
      })
      if (res?.ok) {
        if (res.wallet) {
          setWalletIfFresh(res.wallet, walletSeq)
        }
        return {
          ok: true as const,
          buyRequest: withBuyRequestCardVariant(res.buyRequest),
          wallet: res.wallet ?? null
        }
      }
      return { ok: false as const, error: res?.error || '接受求购失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '接受求购失败') }
    }
  }

  async function cancelBuyRequest(buyRequestId: string) {
    try {
      const idemKey = createIdempotencyKey('buy-request-cancel')
      const walletSeq = captureWalletSeq()
      const res = await $bff<ApiResponse<{ buyRequest: BuyRequest; wallet?: Wallet }>>(`/gacha/trade/buy-requests/${encodeURIComponent(buyRequestId)}/cancel`, {
        method: 'POST',
        headers: { 'x-idempotency-key': idemKey },
        body: {}
      })
      if (res?.ok) {
        if (res.wallet) {
          setWalletIfFresh(res.wallet, walletSeq)
        }
        return {
          ok: true as const,
          buyRequest: withBuyRequestCardVariant(res.buyRequest),
          wallet: res.wallet ?? null
        }
      }
      return { ok: false as const, error: res?.error || '取消求购失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '取消求购失败') }
    }
  }

  return {
    getBuyRequests,
    getMyBuyRequests,
    getCardCatalog,
    getPageCatalog,
    createBuyRequest,
    fulfillBuyRequest,
    cancelBuyRequest
  }
}
