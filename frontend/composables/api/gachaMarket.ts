import type { GachaCoreContext, ApiResponse } from './gachaCore'
import { normalizeError } from './gachaCore'
import type {
  MarketContract, MarketLockTier, MarketLockTierMeta,
  MarketTick, MarketTickDiagnostics, MarketCandle,
  MarketPositionMarker, MarketPosition, MarketPositionSide,
  MarketSettlement, MarketOpponentSnapshot, Wallet
} from '~/types/gacha'

export function useGachaMarketApi(core: GachaCoreContext) {
  const { $bff, state, createIdempotencyKey } = core

  async function getMarketContracts(params: { timeframe?: '24H' | '7D' | '30D' } = {}) {
    try {
      const res = await $bff<ApiResponse<{ items: MarketContract[]; lockTiers?: MarketLockTierMeta[]; timeframe?: '24H' | '7D' | '30D' }>>('/gacha/market/contracts', {
        method: 'GET',
        params: {
          timeframe: params.timeframe
        }
      })
      if (res?.ok) {
        return {
          ok: true as const,
          data: res.items ?? [],
          lockTiers: res.lockTiers ?? [],
          timeframe: res.timeframe ?? params.timeframe ?? '24H'
        }
      }
      return { ok: false as const, error: res?.error || '加载市场合约失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '加载市场合约失败') }
    }
  }

  async function getMarketTicks(params: { contractId?: string; category?: string; limit?: number; timeframe?: '24H' | '7D' | '30D' } = {}) {
    try {
      const res = await $bff<ApiResponse<{
        contract?: MarketContract;
        items: MarketTick[];
        candles?: MarketCandle[];
        markers?: MarketPositionMarker[];
        timeframe?: '24H' | '7D' | '30D';
        diagnostics?: MarketTickDiagnostics;
      }>>('/gacha/market/ticks', {
        method: 'GET',
        params: {
          contractId: params.contractId,
          category: params.category,
          limit: params.limit != null ? String(params.limit) : undefined,
          timeframe: params.timeframe
        }
      })
      if (res?.ok) {
        return {
          ok: true as const,
          data: res.items ?? [],
          contract: res.contract ?? null,
          candles: res.candles ?? [],
          markers: res.markers ?? [],
          timeframe: res.timeframe ?? params.timeframe ?? '24H',
          diagnostics: res.diagnostics ?? null
        }
      }
      return { ok: false as const, error: res?.error || '加载市场价格失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '加载市场价格失败') }
    }
  }

  async function getMarketOpponents(params: { contractId?: string; category?: string; lockTier?: MarketLockTier } = {}) {
    try {
      const res = await $bff<ApiResponse<{ snapshot: MarketOpponentSnapshot }>>('/gacha/market/opponents', {
        method: 'GET',
        params: {
          contractId: params.contractId,
          category: params.category,
          lockTier: params.lockTier
        }
      })
      if (res?.ok) {
        return { ok: true as const, data: res.snapshot ?? null }
      }
      return { ok: false as const, error: res?.error || '加载市场对手失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '加载市场对手失败') }
    }
  }

  async function openMarketPosition(payload: {
    contractId: string
    side: MarketPositionSide
    lockTier?: MarketLockTier
    lots?: number
    stake?: number
    leverage: number
  }) {
    try {
      const idemKey = createIdempotencyKey('market-open')
      const res = await $bff<ApiResponse<{ position: MarketPosition; wallet?: Wallet }>>('/gacha/market/positions/open', {
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
        return { ok: true as const, position: res.position, wallet: res.wallet ?? null }
      }
      return { ok: false as const, error: res?.error || '开仓失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '开仓失败') }
    }
  }

  async function getMarketPositions() {
    try {
      const res = await $bff<ApiResponse<{ items: MarketPosition[]; wallet?: Wallet; autoSettled?: MarketSettlement[] }>>('/gacha/market/positions', { method: 'GET' })
      if (res?.ok) {
        if (res.wallet) {
          state.value.wallet = res.wallet
          state.value.walletFetchedAt = new Date().toISOString()
        }
        return {
          ok: true as const,
          data: res.items ?? [],
          wallet: res.wallet ?? null,
          autoSettled: res.autoSettled ?? []
        }
      }
      return { ok: false as const, error: res?.error || '加载持仓失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '加载持仓失败') }
    }
  }

  async function getMarketPositionHistory(limit = 30) {
    try {
      const res = await $bff<ApiResponse<{ items: MarketSettlement[] }>>('/gacha/market/positions/history', {
        method: 'GET',
        params: {
          limit: String(limit)
        }
      })
      if (res?.ok) {
        return { ok: true as const, data: res.items ?? [] }
      }
      return { ok: false as const, error: res?.error || '加载持仓历史失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '加载持仓历史失败') }
    }
  }

  async function getMarketSettlements(limit = 20) {
    try {
      const res = await $bff<ApiResponse<{ items: MarketSettlement[]; summary?: { total: number; pnl: number } }>>('/gacha/market/settlements', {
        method: 'GET',
        params: {
          limit: String(limit)
        }
      })
      if (res?.ok) {
        return { ok: true as const, data: res.items ?? [], summary: res.summary ?? null }
      }
      return { ok: false as const, error: res?.error || '加载结算记录失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '加载结算记录失败') }
    }
  }

  return {
    getMarketContracts,
    getMarketTicks,
    getMarketOpponents,
    openMarketPosition,
    getMarketPositions,
    getMarketPositionHistory,
    getMarketSettlements
  }
}
