import { useNuxtApp, useRuntimeConfig, useState } from 'nuxt/app'
import { normalizeBffBase, resolveAssetUrl } from '~/utils/assetUrl'
import { stripLegacyGachaTitleSuffix } from '~/utils/gachaTitle'
import type {
  Wallet, GachaConfig, GachaPool, GlobalBoost,
  GachaFeatureStatus, GachaFeatureFlags, EconomyConfig,
  PlacementOverview, TradeListing, MatchMode
} from '~/types/gacha'

// ─── Internal Types ──────────────────────────────────────

export type ApiResponse<T> = {
  ok: boolean
  error?: string
} & T

export interface GachaState {
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
  placement: PlacementOverview | null
  placementFetchedAt: string | null
  placementLoading: boolean
}

type LoadResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string }

// ─── Cache TTLs ──────────────────────────────────────────

const WALLET_CACHE_MS = 30_000
const CONFIG_CACHE_MS = 60_000
const BOOST_CACHE_MS = 60_000
const POOLS_CACHE_MS = 30_000
const ECONOMY_CACHE_MS = 60_000
const FEATURES_CACHE_MS = 120_000

// ─── Per-request Inflight Dedup (SSR-safe) ───────────────
// These must NOT be module-level in SSR — they would be shared across
// concurrent requests and leak data between users.
// We store inflight state on the NuxtApp instance, which is per-request in SSR.

interface GachaInflightState {
  configInflight: Promise<LoadResult<GachaConfig>> | null
  economyInflight: Promise<LoadResult<EconomyConfig>> | null
  walletInflight: Promise<LoadResult<Wallet>> | null
  featuresInflight: Promise<{ ok: true; data: GachaFeatureStatus } | { ok: false; error: string }> | null
  featuresCachedResult: { data: GachaFeatureStatus; fetchedAt: number } | null
  walletUpdateSeq: number
}

const INFLIGHT_KEY = '__gachaInflight'

function getInflightState(): GachaInflightState {
  const nuxtApp = useNuxtApp() as any
  if (!nuxtApp[INFLIGHT_KEY]) {
    nuxtApp[INFLIGHT_KEY] = {
      configInflight: null,
      economyInflight: null,
      walletInflight: null,
      featuresInflight: null,
      featuresCachedResult: null,
      walletUpdateSeq: 0
    }
  }
  return nuxtApp[INFLIGHT_KEY]
}

// ─── Helpers ─────────────────────────────────────────────

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
    economyLoading: false,
    placement: null,
    placementFetchedAt: null,
    placementLoading: false
  }
}

export function toCacheKey(params?: Record<string, any>) {
  if (!params || Object.keys(params).length === 0) {
    return 'default'
  }
  const sorted = Object.keys(params)
    .filter((key) => params[key] != null)
    .sort()
    .map((key) => `${key}:${Array.isArray(params[key]) ? params[key].join(',') : params[key]}`)
  return sorted.join('|') || 'default'
}

export function normalizeError(error: unknown, fallback: string): string {
  if (error != null && typeof error === 'object') {
    const e = error as Record<string, any>
    return e?.data?.error || e?.message || fallback
  }
  return fallback
}

// ─── Core Context ────────────────────────────────────────

export interface GachaCoreContext {
  $bff: ReturnType<typeof useNuxtApp>['$bff']
  state: ReturnType<typeof useState<GachaState>>
  normalizeImageUrl: (url?: string | null) => string | null
  normalizeCardTitle: (title?: string | null) => string
  withCardVariant: <T extends { title: string; imageUrl?: string | null }>(item: T) => T
  withTitleVariant: <T extends { title: string }>(item: T) => T
  withTradeListingCardVariant: (listing: TradeListing) => TradeListing
  withPlacementImageVariant: (placement: PlacementOverview) => PlacementOverview
  createIdempotencyKey: (prefix: string) => string
  /** Capture current wallet sequence before an API call. Pass the returned value to setWalletIfFresh after the call completes. */
  captureWalletSeq: () => number
  /** Safely update wallet only if no newer update has occurred since the captured sequence. */
  setWalletIfFresh: (wallet: Wallet, capturedSeq: number) => void
}

// ─── Core Composable ─────────────────────────────────────

export function useGachaCore() {
  const { $bff } = useNuxtApp()
  const runtimeConfig = useRuntimeConfig()
  const bffBase = normalizeBffBase((runtimeConfig?.public as any)?.bffBase)
  const state = useState<GachaState>('gacha/state', createState)
  const _ifl = getInflightState()

  const normalizeImageUrl = (url?: string | null): string | null => {
    const full = resolveAssetUrl(url ?? '', bffBase, { variant: 'low' })
    return full || null
  }

  const normalizeCardTitle = (title?: string | null): string => stripLegacyGachaTitleSuffix(title)

  const withTitleVariant = <T extends { title: string }>(item: T): T => ({
    ...item,
    title: normalizeCardTitle(item.title)
  })

  const withCardVariant = <T extends { title: string; imageUrl?: string | null }>(item: T): T => ({
    ...withTitleVariant(item),
    imageUrl: normalizeImageUrl(item.imageUrl)
  })

  const withTradeListingCardVariant = (listing: TradeListing): TradeListing => ({
    ...listing,
    card: withCardVariant(listing.card)
  })

  const withPlacementImageVariant = (placement: PlacementOverview): PlacementOverview => ({
    ...placement,
    addons: (placement.addons ?? []).map((addon) => ({
      ...addon,
      card: withCardVariant(addon.card)
    })),
    slots: (placement.slots ?? []).map((slot) => ({
      ...slot,
      card: slot.card ? withCardVariant(slot.card) : null
    }))
  })

  const createIdempotencyKey = (prefix: string) => {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `${prefix}-${crypto.randomUUID()}`
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }

  const captureWalletSeq = () => _ifl.walletUpdateSeq

  const setWalletIfFresh = (wallet: Wallet, capturedSeq: number) => {
    if (_ifl.walletUpdateSeq !== capturedSeq) return // a newer update already occurred
    _ifl.walletUpdateSeq++
    state.value.wallet = wallet
    state.value.walletFetchedAt = new Date().toISOString()
  }

  // Direct wallet update (always applies, for primary wallet fetches)
  const setWalletDirect = (wallet: Wallet) => {
    _ifl.walletUpdateSeq++
    state.value.wallet = wallet
    state.value.walletFetchedAt = new Date().toISOString()
  }

  const ctx: GachaCoreContext = {
    $bff,
    state,
    normalizeImageUrl,
    normalizeCardTitle,
    withCardVariant,
    withTitleVariant,
    withTradeListingCardVariant,
    withPlacementImageVariant,
    createIdempotencyKey,
    captureWalletSeq,
    setWalletIfFresh
  }

  // ─── Core APIs ───────────────────────────────────────

  async function activate() {
    try {
      const res = await $bff<ApiResponse<{ wallet?: Wallet }>>('/gacha/activate', { method: 'POST' })
      if (res?.ok) {
        if (res.wallet) {
          setWalletDirect(res.wallet)
        }
        return { ok: true as const }
      }
      return { ok: false as const, error: res?.error || '激活失败' }
    } catch (error: unknown) {
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
    if (_ifl.configInflight) {
      return _ifl.configInflight
    }
    _ifl.configInflight = (async () => {
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
      } catch (error: unknown) {
        const message = normalizeError(error, '加载配置失败')
        return { ok: false as const, error: message }
      } finally {
        state.value.configLoading = false
        _ifl.configInflight = null
      }
    })()
    return _ifl.configInflight
  }

  async function getFeatures() {
    // Return cached result if fresh
    if (_ifl.featuresCachedResult && Date.now() - _ifl.featuresCachedResult.fetchedAt <= FEATURES_CACHE_MS) {
      return { ok: true as const, data: _ifl.featuresCachedResult.data }
    }
    if (_ifl.featuresInflight) return _ifl.featuresInflight

    _ifl.featuresInflight = (async () => {
      try {
        const res = await $bff<ApiResponse<GachaFeatureStatus>>('/gacha/features', { method: 'GET' })
        if (res?.ok) {
          const data: GachaFeatureStatus = {
            timezone: String(res.timezone || 'UTC+8'),
            poolMode: String(res.poolMode || 'single_permanent'),
            drawTokenCost: Number(res.drawTokenCost ?? 10),
            tenDrawTokenCost: Number(res.tenDrawTokenCost ?? 100),
            features: {
              draw: !!res.features?.draw,
              placement: !!res.features?.placement,
              album: !!res.features?.album,
              tickets: !!res.features?.tickets,
              missions: !!res.features?.missions,
              achievements: !!res.features?.achievements,
              market: !!res.features?.market,
              trade: !!(res.features as any)?.trade
            },
            notes: res.notes || {}
          }
          _ifl.featuresCachedResult = { data, fetchedAt: Date.now() }
          return { ok: true as const, data }
        }
        return { ok: false as const, error: res?.error || '加载玩法能力失败' }
      } catch (error: unknown) {
        return { ok: false as const, error: normalizeError(error, '加载玩法能力失败') }
      } finally {
        _ifl.featuresInflight = null
      }
    })()
    return _ifl.featuresInflight
  }

  async function getWallet(force = false) {
    if (!force && state.value.wallet && state.value.walletFetchedAt) {
      const last = new Date(state.value.walletFetchedAt).getTime()
      if (Date.now() - last <= WALLET_CACHE_MS) {
        return { ok: true as const, data: state.value.wallet }
      }
    }
    if (_ifl.walletInflight) {
      return _ifl.walletInflight
    }
    _ifl.walletInflight = (async () => {
      state.value.walletLoading = true
      try {
        const res = await $bff<ApiResponse<{ wallet: Wallet }>>('/gacha/wallet', { method: 'GET' })
        if (res?.ok && res.wallet) {
          setWalletDirect(res.wallet)
          return { ok: true as const, data: res.wallet }
        }
        const message = res?.error || '加载钱包失败'
        return { ok: false as const, error: message }
      } catch (error: unknown) {
        const message = normalizeError(error, '加载钱包失败')
        return { ok: false as const, error: message }
      } finally {
        state.value.walletLoading = false
        _ifl.walletInflight = null
      }
    })()
    return _ifl.walletInflight
  }

  async function claimDaily() {
    try {
      const res = await $bff<ApiResponse<{ wallet: Wallet; reward: number }>>('/gacha/claim-daily', { method: 'POST' })
      if (res?.ok && res.wallet) {
        setWalletDirect(res.wallet)
        return { ok: true as const, data: res.wallet, reward: res.reward }
      }
      return { ok: false as const, error: res?.error || '签到失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '签到失败') }
    }
  }

  async function getEconomyConfig(force = false) {
    if (!force && state.value.economy && state.value.economyFetchedAt) {
      const last = new Date(state.value.economyFetchedAt).getTime()
      if (Date.now() - last <= ECONOMY_CACHE_MS) {
        return { ok: true as const, data: state.value.economy }
      }
    }
    if (_ifl.economyInflight) {
      return _ifl.economyInflight
    }
    _ifl.economyInflight = (async () => {
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
      } catch (error: unknown) {
        const message = normalizeError(error, '加载经济配置失败')
        return { ok: false as const, error: message }
      } finally {
        state.value.economyLoading = false
        _ifl.economyInflight = null
      }
    })()
    return _ifl.economyInflight
  }

  function resetCache() {
    state.value.walletFetchedAt = null
    state.value.configFetchedAt = null
    state.value.boostCache = {}
    state.value.poolsCache = null
    state.value.placementFetchedAt = null
  }

  async function fetchNotifications(since?: string) {
    try {
      const params: Record<string, string> = {}
      if (since) params.since = since
      const res = await $bff<ApiResponse<{ items: Array<{
        id: string
        delta: number
        message: string
        reason: string | null
        createdAt: string
      }> }>>('/gacha/notifications', { method: 'GET', params })
      if (res?.ok && res.items) {
        return { ok: true as const, items: res.items }
      }
      return { ok: false as const, error: res?.error || '加载通知失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '加载通知失败') }
    }
  }

  return {
    ...ctx,
    activate,
    getConfig,
    getFeatures,
    getWallet,
    claimDaily,
    getEconomyConfig,
    resetCache,
    fetchNotifications
  }
}
