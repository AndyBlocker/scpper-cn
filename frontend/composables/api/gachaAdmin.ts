import type { GachaCoreContext, ApiResponse } from './gachaCore'
import { normalizeError, toCacheKey } from './gachaCore'
import type {
  Rarity, MatchMode, Wallet, GachaPool, GlobalBoost,
  AdminCard, EconomyConfig, GachaAnalytics
} from '~/types/gacha'

const BOOST_CACHE_MS = 60_000
const POOLS_CACHE_MS = 30_000

export function useGachaAdminApi(core: GachaCoreContext) {
  const { $bff, state, normalizeCardTitle } = core

  async function listGlobalBoosts(params: { active?: boolean } = {}) {
    const key = toCacheKey({ active: params.active ? 1 : 0 })
    const cached = state.value.boostCache[key]
    if (cached && Date.now() - new Date(cached.fetchedAt).getTime() <= BOOST_CACHE_MS) {
      return { ok: true as const, data: cached.items }
    }
    if (state.value.boostLoading[key]) {
      return { ok: true as const, data: cached?.items ?? [] }
    }
    state.value.boostLoading[key] = true
    try {
      const res = await $bff<ApiResponse<{ items: GlobalBoost[] }>>('/gacha/admin/boosts', {
        method: 'GET',
        params: { active: params.active ? '1' : undefined }
      })
      if (res?.ok && Array.isArray(res.items)) {
        state.value.boostCache[key] = { items: res.items, fetchedAt: new Date().toISOString() }
        return { ok: true as const, data: res.items }
      }
      const message = res?.error || '加载概率提升列表失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '加载概率提升列表失败')
      return { ok: false as const, error: message }
    } finally {
      state.value.boostLoading[key] = false
    }
  }

  async function createGlobalBoost(payload: {
    includeTags?: string[]
    excludeTags?: string[]
    match: MatchMode
    weightMultiplier: number
    startsAt?: string | null
    endsAt?: string | null
  }) {
    try {
      const res = await $bff<ApiResponse<{ boost: GlobalBoost }>>('/gacha/admin/boosts', {
        method: 'POST',
        body: payload
      })
      if (res?.ok && res.boost) {
        state.value.boostCache = {}
        return { ok: true as const, data: res.boost }
      }
      const message = res?.error || '新增概率提升失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '新增概率提升失败')
      return { ok: false as const, error: message }
    }
  }

  async function updateGlobalBoost(id: string, payload: Partial<{
    includeTags: string[]
    excludeTags: string[]
    match: MatchMode
    weightMultiplier: number
    startsAt: string | null
    endsAt: string | null
    isActive: boolean
  }>) {
    try {
      const res = await $bff<ApiResponse<{ boost: GlobalBoost }>>(`/gacha/admin/boosts/${id}`, {
        method: 'PATCH',
        body: payload
      })
      if (res?.ok && res.boost) {
        state.value.boostCache = {}
        return { ok: true as const, data: res.boost }
      }
      const message = res?.error || '更新概率提升失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '更新概率提升失败')
      return { ok: false as const, error: message }
    }
  }

  async function deleteGlobalBoost(id: string) {
    try {
      const res = await $bff<ApiResponse<{}>>(`/gacha/admin/boosts/${id}`, { method: 'DELETE' })
      if (res?.ok) {
        state.value.boostCache = {}
        return { ok: true as const }
      }
      const message = res?.error || '删除失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '删除失败')
      return { ok: false as const, error: message }
    }
  }

  async function updateEconomyConfig(payload: Partial<EconomyConfig>) {
    try {
      const res = await $bff<ApiResponse<{ rewards: EconomyConfig }>>('/gacha/admin/economy', {
        method: 'PUT',
        body: payload
      })
      if (res?.ok && res.rewards) {
        state.value.economy = res.rewards
        state.value.economyFetchedAt = new Date().toISOString()
        state.value.configFetchedAt = null
        return { ok: true as const, data: res.rewards }
      }
      const message = res?.error || '更新经济配置失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '更新经济配置失败')
      return { ok: false as const, error: message }
    }
  }

  async function listPools(force = false, includeCards = false) {
    const cache = state.value.poolsCache
    if (!force && cache && Date.now() - new Date(cache.fetchedAt).getTime() <= POOLS_CACHE_MS) {
      return { ok: true as const, data: cache.items }
    }
    try {
      const res = await $bff<ApiResponse<{ items: Array<{ cards?: any } & GachaPool> }>>('/gacha/admin/pools', {
        method: 'GET',
        params: { includeCards: includeCards ? '1' : undefined }
      })
      if (res?.ok) {
        const pools = res.items?.map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description ?? null,
          tokenCost: item.tokenCost,
          tenDrawCost: item.tenDrawCost,
          rewardPerDuplicate: item.rewardPerDuplicate,
          startsAt: item.startsAt,
          endsAt: item.endsAt,
          isActive: item.isActive
        })) ?? []
        state.value.poolsCache = { items: pools, fetchedAt: new Date().toISOString() }
        return { ok: true as const, data: pools }
      }
      const message = res?.error || '加载卡池失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '加载卡池失败')
      return { ok: false as const, error: message }
    }
  }

  async function createPool(payload: {
    name: string
    description?: string
    tokenCost?: number
    tenDrawCost?: number
    rewardPerDuplicate?: number
    startsAt?: string
    endsAt?: string
    isActive?: boolean
    cloneAllCards?: boolean
    cloneFromPoolId?: string
  }) {
    try {
      const res = await $bff<ApiResponse<{ pool: GachaPool; copied?: number }>>('/gacha/admin/pools', {
        method: 'POST',
        body: payload
      })
      if (res?.ok && res.pool) {
        state.value.poolsCache = null
        state.value.configFetchedAt = null
        return { ok: true as const, data: res.pool, copied: res.copied ?? 0 }
      }
      const message = res?.error || '新增卡池失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '新增卡池失败')
      return { ok: false as const, error: message }
    }
  }

  async function updatePool(id: string, payload: Partial<{
    name: string
    description: string | null
    tokenCost: number
    tenDrawCost: number
    rewardPerDuplicate: number
    startsAt: string | null
    endsAt: string | null
    isActive: boolean
  }>) {
    try {
      const res = await $bff<ApiResponse<{ pool: GachaPool; copied?: number }>>(`/gacha/admin/pools/${id}`, {
        method: 'PATCH',
        body: payload
      })
      if (res?.ok && res.pool) {
        state.value.poolsCache = null
        state.value.configFetchedAt = null
        return { ok: true as const, data: res.pool, copied: res.copied ?? 0 }
      }
      const message = res?.error || '更新卡池失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '更新卡池失败')
      return { ok: false as const, error: message }
    }
  }

  async function deletePool(id: string) {
    try {
      const res = await $bff<ApiResponse<{}>>(`/gacha/admin/pools/${id}`, { method: 'DELETE' })
      if (res?.ok) {
        state.value.poolsCache = null
        state.value.configFetchedAt = null
        return { ok: true as const }
      }
      const message = res?.error || '删除卡池失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '删除卡池失败')
      return { ok: false as const, error: message }
    }
  }

  async function createCard(payload: {
    poolId: string
    title: string
    rarity: Rarity
    tags?: string[]
    weight?: number
    rewardTokens?: number
    wikidotId?: number
    pageId?: number
    imageUrl?: string
  }) {
    try {
      const res = await $bff<ApiResponse<{ card: any }>>('/gacha/admin/cards', {
        method: 'POST',
        body: payload
      })
      if (res?.ok) {
        state.value.configFetchedAt = null
        const card = res.card && typeof res.card === 'object'
          ? { ...res.card, title: normalizeCardTitle(res.card.title) }
          : res.card
        return { ok: true as const, data: card }
      }
      const message = res?.error || '新增卡片失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '新增卡片失败')
      return { ok: false as const, error: message }
    }
  }

  async function updateCard(id: string, payload: Partial<{
    poolId: string
    title: string
    rarity: Rarity
    tags: string[]
    weight: number
    rewardTokens: number
    wikidotId: number
    pageId: number
    imageUrl: string
  }>) {
    try {
      const res = await $bff<ApiResponse<{ card: any }>>(`/gacha/admin/cards/${id}`, {
        method: 'PATCH',
        body: payload
      })
      if (res?.ok) {
        state.value.configFetchedAt = null
        const card = res.card && typeof res.card === 'object'
          ? { ...res.card, title: normalizeCardTitle(res.card.title) }
          : res.card
        return { ok: true as const, data: card }
      }
      const message = res?.error || '更新卡片失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '更新卡片失败')
      return { ok: false as const, error: message }
    }
  }

  async function deleteCard(id: string) {
    try {
      const res = await $bff<ApiResponse<{}>>(`/gacha/admin/cards/${id}`, { method: 'DELETE' })
      if (res?.ok) {
        state.value.configFetchedAt = null
        return { ok: true as const }
      }
      const message = res?.error || '删除卡片失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '删除卡片失败')
      return { ok: false as const, error: message }
    }
  }

  async function listAdminCards(params: {
    poolId?: string
    rarity?: Rarity
    includeTags?: string[]
    excludeTags?: string[]
    search?: string
    limit?: number
    offset?: number
  }) {
    try {
      const res = await $bff<ApiResponse<{ items: AdminCard[]; total: number }>>('/gacha/admin/cards', {
        method: 'GET',
        params: {
          poolId: params.poolId,
          rarity: params.rarity,
          includeTags: params.includeTags?.length ? params.includeTags.join(',') : undefined,
          excludeTags: params.excludeTags?.length ? params.excludeTags.join(',') : undefined,
          search: params.search,
          limit: params.limit != null ? String(params.limit) : undefined,
          offset: params.offset != null ? String(params.offset) : undefined
        }
      })
      if (res?.ok) {
        const items = (res.items ?? []).map((item) => ({
          ...item,
          title: normalizeCardTitle(item.title)
        }))
        return { ok: true as const, data: items, total: res.total ?? 0 }
      }
      const message = res?.error || '加载卡片失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '加载卡片失败')
      return { ok: false as const, error: message }
    }
  }

  async function batchAdjustCardWeights(payload: {
    poolId?: string
    includeTags?: string[]
    excludeTags?: string[]
    match?: MatchMode
    rarity?: Rarity
    multiplier?: number
    setWeight?: number
  }) {
    try {
      const res = await $bff<ApiResponse<{ matched: number; updated: number }>>('/gacha/admin/cards/batch-adjust', {
        method: 'POST',
        body: {
          poolId: payload.poolId,
          includeTags: payload.includeTags,
          excludeTags: payload.excludeTags,
          match: payload.match,
          rarity: payload.rarity,
          multiplier: payload.multiplier,
          setWeight: payload.setWeight
        }
      })
      if (res?.ok) {
        return { ok: true as const, matched: res.matched ?? 0, updated: res.updated ?? 0 }
      }
      const message = res?.error || '批量调整失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '批量调整失败')
      return { ok: false as const, error: message }
    }
  }

  async function adjustWalletTokens(payload: {
    scope?: 'user' | 'all'
    userId?: string
    email?: string
    delta: number
    reason?: string
    message?: string
    allowNegative?: boolean
  }) {
    try {
      const body: Record<string, any> = {
        scope: payload.scope ?? 'user',
        delta: payload.delta,
        allowNegative: payload.allowNegative
      }
      if (payload.userId) body.userId = payload.userId
      if (payload.email) body.email = payload.email
      if (payload.reason) body.reason = payload.reason
      if (payload.message) body.message = payload.message
      const res = await $bff<ApiResponse<{ wallet?: Wallet; updated?: number }>>('/gacha/admin/wallets/adjust', {
        method: 'POST',
        body
      })
      if (res?.ok) {
        if (res.wallet) {
          return { ok: true as const, wallet: res.wallet }
        }
        return { ok: true as const, updated: res.updated ?? 0 }
      }
      const message = res?.error || '调整 Token 失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '调整 Token 失败')
      return { ok: false as const, error: message }
    }
  }

  async function adjustWallet(payload: {
    userId?: string
    email?: string
    delta: number
    reason?: string
    message?: string
    allowNegative?: boolean
  }) {
    return adjustWalletTokens({ ...payload, scope: 'user' })
  }

  async function adjustAllWallets(payload: {
    delta: number
    reason?: string
    message?: string
    allowNegative?: boolean
  }) {
    return adjustWalletTokens({ ...payload, scope: 'all' })
  }

  async function getAnalytics(params: { period: '7d' | '30d' | 'all' }) {
    try {
      const res = await $bff<ApiResponse<{ analytics: GachaAnalytics }>>('/gacha/admin/analytics', {
        method: 'GET',
        params: { period: params.period }
      })
      if (res?.ok) {
        const analytics = res.analytics ? {
          ...res.analytics,
          topPages: (res.analytics.topPages ?? []).map((item) => ({
            ...item,
            title: normalizeCardTitle(item.title)
          }))
        } : res.analytics
        return { ok: true as const, data: analytics }
      }
      const message = res?.error || '加载分析数据失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '加载分析数据失败')
      return { ok: false as const, error: message }
    }
  }

  return {
    listGlobalBoosts,
    createGlobalBoost,
    updateGlobalBoost,
    deleteGlobalBoost,
    updateEconomyConfig,
    listPools,
    createPool,
    updatePool,
    deletePool,
    createCard,
    updateCard,
    deleteCard,
    listAdminCards,
    batchAdjustCardWeights,
    adjustWallet,
    adjustAllWallets,
    getAnalytics
  }
}
