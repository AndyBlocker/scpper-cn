import type { GachaCoreContext, ApiResponse } from './gachaCore'
import { normalizeError } from './gachaCore'
import type {
  Rarity, DrawPaymentMethod, DrawResult, InventoryItem,
  HistoryItem, Progress, TicketBalance
} from '~/types/gacha'

export function useGachaDrawApi(core: GachaCoreContext) {
  const { $bff, state, withCardVariant, createIdempotencyKey, captureWalletSeq, setWalletIfFresh } = core

  async function draw(payload: { poolId: string; count: number; paymentMethod?: DrawPaymentMethod }) {
    try {
      const idemKey = createIdempotencyKey('draw')
      const walletSeq = captureWalletSeq()
      const res = await $bff<ApiResponse<{ data: DrawResult; tickets?: TicketBalance; paymentMethod?: DrawPaymentMethod }>>('/gacha/draw', {
        method: 'POST',
        headers: {
          'x-idempotency-key': idemKey
        },
        body: {
          poolId: payload.poolId,
          count: payload.count,
          paymentMethod: payload.paymentMethod || 'AUTO'
        }
      })
      if (res?.ok) {
        const mappedItems = res.data?.items?.map(withCardVariant) ?? []
        const data = res.data ? { ...res.data, items: mappedItems } : res.data
        if (data?.wallet) {
          setWalletIfFresh(data.wallet, walletSeq)
        }
        return {
          ok: true as const,
          data,
          paymentMethod: (res.paymentMethod || payload.paymentMethod || 'AUTO') as DrawPaymentMethod,
          tickets: {
            drawTicket: Number(res.tickets?.drawTicket ?? 0),
            draw10Ticket: Number(res.tickets?.draw10Ticket ?? 0),
            affixReforgeTicket: Number(res.tickets?.affixReforgeTicket ?? 0)
          }
        }
      }
      const message = res?.error || '抽卡失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '抽卡失败')
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
          items: Array.isArray(entry.items) ? entry.items.map(withCardVariant) : []
        }))
        return { ok: true as const, data: items }
      }
      const message = res?.error || '加载历史失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '加载历史失败')
      return { ok: false as const, error: message }
    }
  }

  async function getInventory(params: { poolId?: string; rarity?: Rarity; limit?: number; offset?: number; skipTotal?: boolean; affixFilter?: string; search?: string }) {
    try {
      const res = await $bff<ApiResponse<{ items: InventoryItem[]; total: number; pageRows?: number }>>('/gacha/inventory', {
        method: 'GET',
        params: {
          poolId: params.poolId,
          rarity: params.rarity,
          limit: params.limit != null ? String(params.limit) : undefined,
          offset: params.offset != null ? String(params.offset) : undefined,
          skipTotal: params.skipTotal ? '1' : undefined,
          affixFilter: params.affixFilter || undefined,
          search: params.search || undefined
        }
      })
      if (res?.ok) {
        const items = (res.items ?? []).map(withCardVariant)
        return { ok: true as const, data: items, total: res.total ?? 0, pageRows: Number(res.pageRows ?? 0) }
      }
      const message = res?.error || '加载图鉴失败'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = normalizeError(error, '加载图鉴失败')
      return { ok: false as const, error: message }
    }
  }

  async function getProgress(params: { poolId?: string } = {}) {
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
    } catch (error: unknown) {
      const message = normalizeError(error, '加载进度失败')
      return { ok: false as const, error: message }
    }
  }

  return { draw, getHistory, getInventory, getProgress }
}
