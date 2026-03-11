import type { GachaCoreContext, ApiResponse } from './gachaCore'
import { normalizeError } from './gachaCore'
import type {
  AffixVisualStyle, Wallet, PlacementOverview
} from '~/types/gacha'

const PLACEMENT_CACHE_MS = 10_000

let placementInflight: Promise<{ ok: true; data: PlacementOverview } | { ok: false; error: string }> | null = null

export function useGachaPlacementApi(core: GachaCoreContext) {
  const { $bff, state, withPlacementImageVariant, captureWalletSeq, setWalletIfFresh } = core

  async function getPlacement(force = false) {
    if (!force && state.value.placement && state.value.placementFetchedAt) {
      const last = new Date(state.value.placementFetchedAt).getTime()
      if (Date.now() - last <= PLACEMENT_CACHE_MS) {
        return { ok: true as const, data: state.value.placement }
      }
    }
    if (placementInflight) {
      return placementInflight
    }
    placementInflight = (async () => {
      state.value.placementLoading = true
      try {
        const res = await $bff<ApiResponse<{ placement: PlacementOverview }>>('/gacha/placement', { method: 'GET' })
        if (res?.ok && res.placement) {
          const mapped = withPlacementImageVariant(res.placement)
          state.value.placement = mapped
          state.value.placementFetchedAt = new Date().toISOString()
          return { ok: true as const, data: mapped }
        }
        const message = res?.error || '加载放置信息失败'
        return { ok: false as const, error: message }
      } catch (error: unknown) {
        const message = normalizeError(error, '加载放置信息失败')
        return { ok: false as const, error: message }
      } finally {
        state.value.placementLoading = false
        placementInflight = null
      }
    })()
    return placementInflight
  }

  async function setPlacementSlot(slotIndex: number, cardId: string, affixVisualStyle?: AffixVisualStyle, affixSignature?: string) {
    try {
      const res = await $bff<ApiResponse<{ placement: PlacementOverview }>>(`/gacha/placement/slots/${slotIndex}/set`, {
        method: 'POST',
        body: {
          cardId,
          affixVisualStyle: affixVisualStyle || undefined,
          affixSignature: affixSignature || undefined
        }
      })
      if (res?.ok && res.placement) {
        const mapped = withPlacementImageVariant(res.placement)
        state.value.placement = mapped
        state.value.placementFetchedAt = new Date().toISOString()
        return { ok: true as const, data: mapped }
      }
      const message = res?.error || '放置卡片失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '放置卡片失败')
      return { ok: false as const, error: message }
    }
  }

  async function clearPlacementSlot(slotIndex: number) {
    try {
      const res = await $bff<ApiResponse<{ placement: PlacementOverview }>>(`/gacha/placement/slots/${slotIndex}/clear`, {
        method: 'POST'
      })
      if (res?.ok && res.placement) {
        const mapped = withPlacementImageVariant(res.placement)
        state.value.placement = mapped
        state.value.placementFetchedAt = new Date().toISOString()
        return { ok: true as const, data: mapped }
      }
      const message = res?.error || '清空槽位失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '清空槽位失败')
      return { ok: false as const, error: message }
    }
  }

  async function unlockPlacementSlot() {
    try {
      const walletSeq = captureWalletSeq()
      const res = await $bff<ApiResponse<{ placement: PlacementOverview; wallet?: Wallet }>>('/gacha/placement/slots/unlock', {
        method: 'POST'
      })
      if (res?.ok && res.placement) {
        const mapped = withPlacementImageVariant(res.placement)
        state.value.placement = mapped
        state.value.placementFetchedAt = new Date().toISOString()
        if (res.wallet) {
          setWalletIfFresh(res.wallet, walletSeq)
        }
        return { ok: true as const, data: mapped, wallet: res.wallet ?? null }
      }
      const message = res?.error || '解锁槽位失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '解锁槽位失败')
      return { ok: false as const, error: message }
    }
  }

  async function setPlacementColorlessAddon(cardId: string, affixVisualStyle: AffixVisualStyle = 'COLORLESS', affixSignature?: string) {
    try {
      const res = await $bff<ApiResponse<{ placement: PlacementOverview }>>('/gacha/placement/addons/colorless/set', {
        method: 'POST',
        body: {
          cardId,
          affixVisualStyle,
          affixSignature: affixSignature || undefined
        }
      })
      if (res?.ok && res.placement) {
        const mapped = withPlacementImageVariant(res.placement)
        state.value.placement = mapped
        state.value.placementFetchedAt = new Date().toISOString()
        return { ok: true as const, data: mapped }
      }
      const message = res?.error || '设置无色挂载失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '设置无色挂载失败')
      return { ok: false as const, error: message }
    }
  }

  async function clearPlacementColorlessAddon() {
    try {
      const res = await $bff<ApiResponse<{ placement: PlacementOverview }>>('/gacha/placement/addons/colorless/clear', {
        method: 'POST'
      })
      if (res?.ok && res.placement) {
        const mapped = withPlacementImageVariant(res.placement)
        state.value.placement = mapped
        state.value.placementFetchedAt = new Date().toISOString()
        return { ok: true as const, data: mapped }
      }
      const message = res?.error || '清空无色挂载失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '清空无色挂载失败')
      return { ok: false as const, error: message }
    }
  }

  async function claimPlacement(idempotencyKey?: string) {
    try {
      const key = (idempotencyKey || '').trim() || core.createIdempotencyKey('placement-claim')
      const walletSeq = captureWalletSeq()
      const res = await $bff<ApiResponse<{ claimedToken: number; wallet: Wallet; placement: PlacementOverview }>>('/gacha/placement/claim', {
        method: 'POST',
        headers: {
          'x-idempotency-key': key
        },
        body: {}
      })
      if (res?.ok && res.wallet && res.placement) {
        const mapped = withPlacementImageVariant(res.placement)
        setWalletIfFresh(res.wallet, walletSeq)
        state.value.placement = mapped
        state.value.placementFetchedAt = new Date().toISOString()
        return { ok: true as const, claimedToken: Number(res.claimedToken || 0), wallet: res.wallet, placement: mapped }
      }
      const message = res?.error || '领取放置收益失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '领取放置收益失败')
      return { ok: false as const, error: message }
    }
  }

  return {
    getPlacement,
    setPlacementSlot,
    clearPlacementSlot,
    unlockPlacementSlot,
    setPlacementColorlessAddon,
    clearPlacementColorlessAddon,
    claimPlacement
  }
}
