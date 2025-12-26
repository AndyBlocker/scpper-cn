import { useNuxtApp, useRuntimeConfig, useState } from 'nuxt/app'
import { normalizeBffBase, resolveAssetUrl } from '~/utils/assetUrl'

export type Rarity = 'WHITE' | 'GREEN' | 'BLUE' | 'PURPLE' | 'GOLD'

export type MatchMode = 'all' | 'any'

export interface Wallet {
  balance: number
  totalEarned: number
  totalSpent: number
  lastDailyClaimAt: string | null
}

export interface GachaPool {
  id: string
  name: string
  description?: string | null
  tokenCost: number
  tenDrawCost: number
  rewardPerDuplicate: number
  startsAt: string | null
  endsAt: string | null
  isActive: boolean
}

export interface GlobalBoost {
  id: string
  includeTags: string[]
  excludeTags: string[]
  match: MatchMode
  weightMultiplier: number
  startsAt: string | null
  endsAt: string | null
  isActive: boolean
  createdAt: string | null
  updatedAt: string | null
  createdBy?: {
    id: string
    email: string
    displayName: string | null
  } | null
}

export interface DrawItem {
  id: string
  title: string
  rarity: Rarity
  tags: string[]
  imageUrl: string | null
  wikidotId: number | null
  pageId: number | null
  rewardTokens: number
  duplicate: boolean
  countAfter: number
  authors?: Array<{ name: string; wikidotId: number | null }> | null
}

export interface DrawResult {
  items: DrawItem[]
  rewardSummary?: {
    totalTokens: number
    byRarity: Array<{ rarity: Rarity; count: number }>
  }
  wallet?: Wallet | null
}

export interface InventoryItem {
  id: string
  cardId: string
  poolId: string
  title: string
  rarity: Rarity
  tags: string[]
  authors?: Array<{ name: string; wikidotId: number | null }> | null
  imageUrl: string | null
  wikidotId: number | null
  pageId: number | null
  rewardTokens: number
  count: number
}

export interface AdminCard {
  id: string
  poolId: string
  poolName: string | null
  title: string
  rarity: Rarity
  weight: number
  rewardTokens: number
  tags: string[]
  imageUrl: string | null
  wikidotId: number | null
  pageId: number | null
  createdAt: string | null
  updatedAt: string | null
}

export interface Progress {
  total: number
  collected: number
  byRarity: Array<{
    rarity: Rarity
    total: number
    collected: number
  }>
}

export interface HistoryItem {
  id: string
  poolId: string
  poolName: string | null
  count: number
  tokensSpent: number
  tokensReward: number
  createdAt: string
  items: Array<{
    cardId: string
    title: string
    rarity: Rarity
    rewardTokens: number
    imageUrl: string | null
  }>
}

export interface GachaAnalytics {
  period: '7d' | '30d' | 'all'
  totalDraws: number
  totalTokensAwarded: number
  totalTokensDismantled: number
  totalTokensSpent: number
  rarityDistribution: Array<{ rarity: Rarity; count: number; percentage: number }>
  topTags: Array<{ tag: string; count: number }>
  topPages: Array<{ cardId: string; title: string; count: number; rarity: Rarity }>
}

export interface GachaConfig {
  activated: boolean
  pools: GachaPool[]
  boosts: GlobalBoost[]
}

export interface EconomyConfig {
  drawRewards: Record<Rarity, number>
  dismantleRewards: Record<Rarity, number>
}

type ApiResponse<T> = {
  ok: boolean
  error?: string
} & T

interface GachaState {
  wallet: Wallet | null
  walletFetchedAt: string | null
  walletLoading: boolean
  config: GachaConfig | null
  configFetchedAt: string | null
  configLoading: boolean
  boostCache: Record<string, { items: GlobalBoost[]; fetchedAt: string }>
  boostLoading: Record<string, boolean>
  poolsCache: { items: GachaPool[]; fetchedAt: string } | null
  economy: EconomyConfig | null
  economyFetchedAt: string | null
  economyLoading: boolean
}

const WALLET_CACHE_MS = 30_000
const CONFIG_CACHE_MS = 60_000
const BOOST_CACHE_MS = 60_000
const POOLS_CACHE_MS = 30_000
const ECONOMY_CACHE_MS = 60_000

function createState(): GachaState {
  return {
    wallet: null,
    walletFetchedAt: null,
    walletLoading: false,
    config: null,
    configFetchedAt: null,
    configLoading: false,
    boostCache: {},
    boostLoading: {},
    poolsCache: null,
    economy: null,
    economyFetchedAt: null,
    economyLoading: false
  }
}

function toCacheKey(params?: Record<string, any>) {
  if (!params || Object.keys(params).length === 0) {
    return 'default'
  }
  const sorted = Object.keys(params)
    .filter((key) => params[key] != null)
    .sort()
    .map((key) => `${key}:${Array.isArray(params[key]) ? params[key].join(',') : params[key]}`)
  return sorted.join('|') || 'default'
}

function normalizeError(error: any, fallback: string) {
  return error?.data?.error || error?.message || fallback
}

export function useGacha() {
  const { $bff } = useNuxtApp()
  const runtimeConfig = useRuntimeConfig()
  const bffBase = normalizeBffBase((runtimeConfig?.public as any)?.bffBase)
  const state = useState<GachaState>('gacha/state', createState)

  const normalizeImageUrl = (url?: string | null): string | null => {
    const low = resolveAssetUrl(url ?? '', bffBase, { variant: 'low' })
    if (low) return low
    const full = resolveAssetUrl(url ?? '', bffBase)
    return full || null
  }

  const withImageVariant = <T extends { imageUrl?: string | null }>(item: T): T => ({
    ...item,
    imageUrl: normalizeImageUrl(item.imageUrl)
  })

  async function activate() {
    try {
      const res = await $bff<ApiResponse<{ wallet?: Wallet }>>('/gacha/activate', { method: 'POST' })
      if (res?.ok) {
        if (res.wallet) {
          state.value.wallet = res.wallet
          state.value.walletFetchedAt = new Date().toISOString()
        }
        return { ok: true as const }
      }
      return { ok: false as const, error: res?.error || '激活失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '激活失败') }
    }
  }

  async function getConfig(force = false) {
    if (!force && state.value.config && state.value.configFetchedAt) {
      const last = new Date(state.value.configFetchedAt).getTime()
      if (Date.now() - last <= CONFIG_CACHE_MS) {
        return { ok: true as const, data: state.value.config }
      }
    }
    if (state.value.configLoading) {
      return { ok: true as const, data: state.value.config }
    }
    state.value.configLoading = true
    try {
      const res = await $bff<ApiResponse<{ config: GachaConfig }>>('/gacha/config', { method: 'GET' })
      if (res?.ok && res.config) {
        state.value.config = res.config
        state.value.configFetchedAt = new Date().toISOString()
        return { ok: true as const, data: res.config }
      }
      const message = res?.error || '加载配置失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '加载配置失败')
      return { ok: false as const, error: message }
    } finally {
      state.value.configLoading = false
    }
  }

  async function getEconomyConfig(force = false) {
    if (!force && state.value.economy && state.value.economyFetchedAt) {
      const last = new Date(state.value.economyFetchedAt).getTime()
      if (Date.now() - last <= ECONOMY_CACHE_MS) {
        return { ok: true as const, data: state.value.economy }
      }
    }
    if (state.value.economyLoading) {
      return { ok: true as const, data: state.value.economy }
    }
    state.value.economyLoading = true
    try {
      const res = await $bff<ApiResponse<{ rewards: EconomyConfig }>>('/gacha/admin/economy', { method: 'GET' })
      if (res?.ok && res.rewards) {
        state.value.economy = res.rewards
        state.value.economyFetchedAt = new Date().toISOString()
        return { ok: true as const, data: res.rewards }
      }
      const message = res?.error || '加载经济配置失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '加载经济配置失败')
      return { ok: false as const, error: message }
    } finally {
      state.value.economyLoading = false
    }
  }

  async function getWallet(force = false) {
    if (!force && state.value.wallet && state.value.walletFetchedAt) {
      const last = new Date(state.value.walletFetchedAt).getTime()
      if (Date.now() - last <= WALLET_CACHE_MS) {
        return { ok: true as const, data: state.value.wallet }
      }
    }
    if (state.value.walletLoading) {
      return { ok: true as const, data: state.value.wallet }
    }
    state.value.walletLoading = true
    try {
      const res = await $bff<ApiResponse<{ wallet: Wallet }>>('/gacha/wallet', { method: 'GET' })
      if (res?.ok && res.wallet) {
        state.value.wallet = res.wallet
        state.value.walletFetchedAt = new Date().toISOString()
        return { ok: true as const, data: res.wallet }
      }
      const message = res?.error || '加载钱包失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '加载钱包失败')
      return { ok: false as const, error: message }
    } finally {
      state.value.walletLoading = false
    }
  }

  async function claimDaily() {
    try {
      const res = await $bff<ApiResponse<{ wallet: Wallet; reward: number }>>('/gacha/claim-daily', { method: 'POST' })
      if (res?.ok && res.wallet) {
        state.value.wallet = res.wallet
        state.value.walletFetchedAt = new Date().toISOString()
        return { ok: true as const, data: res.wallet, reward: res.reward }
      }
      return { ok: false as const, error: res?.error || '签到失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '签到失败') }
    }
  }

  async function draw(payload: { poolId: string; count: number }) {
    try {
      const res = await $bff<ApiResponse<{ data: DrawResult }>>('/gacha/draw', {
        method: 'POST',
        body: {
          poolId: payload.poolId,
          count: payload.count
        }
      })
      if (res?.ok) {
        const mappedItems = res.data?.items?.map(withImageVariant) ?? []
        const data = res.data ? { ...res.data, items: mappedItems } : res.data
        if (data?.wallet) {
          state.value.wallet = data.wallet
          state.value.walletFetchedAt = new Date().toISOString()
        }
        return { ok: true as const, data }
      }
      const message = res?.error || '抽卡失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '抽卡失败')
      return { ok: false as const, error: message }
    }
  }

  async function getInventory(params: { poolId?: string; rarity?: Rarity; limit?: number; offset?: number }) {
    try {
      const res = await $bff<ApiResponse<{ items: InventoryItem[]; total: number }>>('/gacha/inventory', {
        method: 'GET',
        params: {
          poolId: params.poolId,
          rarity: params.rarity,
          limit: params.limit != null ? String(params.limit) : undefined,
          offset: params.offset != null ? String(params.offset) : undefined
        }
      })
      if (res?.ok) {
        const items = (res.items ?? []).map(withImageVariant)
        return { ok: true as const, data: items, total: res.total ?? 0 }
      }
      const message = res?.error || '加载图鉴失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '加载图鉴失败')
      return { ok: false as const, error: message }
    }
  }

  async function dismantle(cardId: string, count: number) {
    try {
      const res = await $bff<ApiResponse<{ wallet: Wallet; remaining: number; reward: number }>>('/gacha/dismantle', {
        method: 'POST',
        body: { cardId, count }
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

  async function getProgress(params: { poolId?: string }) {
    try {
      const res = await $bff<ApiResponse<{ progress: Progress }>>('/gacha/progress', {
        method: 'GET',
        params: {
          poolId: params.poolId
        }
      })
      if (res?.ok) {
        return { ok: true as const, data: res.progress }
      }
      const message = res?.error || '加载进度失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '加载进度失败')
      return { ok: false as const, error: message }
    }
  }

  async function getHistory(params: { poolId?: string; limit?: number }) {
    try {
      const res = await $bff<ApiResponse<{ items: HistoryItem[] }>>('/gacha/history', {
        method: 'GET',
        params: {
          poolId: params.poolId,
          limit: params.limit != null ? String(params.limit) : undefined
        }
      })
      if (res?.ok) {
        const items = (res.items ?? []).map((entry) => ({
          ...entry,
          items: Array.isArray(entry.items) ? entry.items.map(withImageVariant) : []
        }))
        return { ok: true as const, data: items }
      }
      const message = res?.error || '加载历史失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '加载历史失败')
      return { ok: false as const, error: message }
    }
  }

  async function getAnalytics(params: { period: '7d' | '30d' | 'all' }) {
    try {
      const res = await $bff<ApiResponse<{ analytics: GachaAnalytics }>>('/gacha/admin/analytics', {
        method: 'GET',
        params: { period: params.period }
      })
      if (res?.ok) {
        return { ok: true as const, data: res.analytics }
      }
      const message = res?.error || '加载分析数据失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = normalizeError(error, '加载分析数据失败')
      return { ok: false as const, error: message }
    }
  }

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
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
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
        return { ok: true as const, data: res.card }
      }
      const message = res?.error || '新增卡片失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
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
        return { ok: true as const, data: res.card }
      }
      const message = res?.error || '更新卡片失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
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
    } catch (error: any) {
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
        return { ok: true as const, data: res.items ?? [], total: res.total ?? 0 }
      }
      const message = res?.error || '加载卡片失败'
      return { ok: false as const, error: message }
    } catch (error: any) {
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
    } catch (error: any) {
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
    } catch (error: any) {
      const message = normalizeError(error, '调整 Token 失败')
      return { ok: false as const, error: message }
    }
  }

  async function adjustWallet(payload: {
    userId?: string
    email?: string
    delta: number
    reason?: string
    allowNegative?: boolean
  }) {
    return adjustWalletTokens({ ...payload, scope: 'user' })
  }

  async function adjustAllWallets(payload: {
    delta: number
    reason?: string
    allowNegative?: boolean
  }) {
    return adjustWalletTokens({ ...payload, scope: 'all' })
  }

  function resetCache() {
    state.value.walletFetchedAt = null
    state.value.configFetchedAt = null
    state.value.boostCache = {}
    state.value.poolsCache = null
  }

  return {
    state,
    activate,
    getConfig,
    getEconomyConfig,
    getWallet,
    claimDaily,
    draw,
    getInventory,
    dismantle,
    getProgress,
    getHistory,
    getAnalytics,
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
    resetCache
  }
}
