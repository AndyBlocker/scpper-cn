import type { GachaCoreContext, ApiResponse } from './gachaCore'
import { normalizeError } from './gachaCore'
import type {
  AffixVisualStyle, Wallet, TicketBalance, TicketUseResult, DrawResult
} from '~/types/gacha'

export function useGachaTicketsApi(core: GachaCoreContext) {
  const { $bff, state, withCardVariant, normalizeCardTitle, createIdempotencyKey } = core

  async function getTickets() {
    try {
      const res = await $bff<ApiResponse<{ tickets: TicketBalance; wallet?: Wallet }>>('/gacha/tickets', {
        method: 'GET'
      })
      if (res?.ok) {
        if (res.wallet) {
          state.value.wallet = res.wallet
          state.value.walletFetchedAt = new Date().toISOString()
        }
        return {
          ok: true as const,
          tickets: {
            drawTicket: Number(res.tickets?.drawTicket ?? 0),
            draw10Ticket: Number(res.tickets?.draw10Ticket ?? 0),
            affixReforgeTicket: Number(res.tickets?.affixReforgeTicket ?? 0)
          }
        }
      }
      return { ok: false as const, error: res?.error || '加载票券失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '加载票券失败') }
    }
  }

  async function useDrawTicket() {
    try {
      const idemKey = createIdempotencyKey('ticket-draw')
      const res = await $bff<ApiResponse<{ tickets: TicketBalance; data?: DrawResult }>>('/gacha/tickets/draw/use', {
        method: 'POST',
        headers: {
          'x-idempotency-key': idemKey
        },
        body: {}
      })
      if (res?.ok) {
        const mappedItems = res.data?.items?.map(withCardVariant) ?? []
        const data = res.data ? { ...res.data, items: mappedItems } : null
        if (data?.wallet) {
          state.value.wallet = data.wallet
          state.value.walletFetchedAt = new Date().toISOString()
        }
        return {
          ok: true as const,
          tickets: {
            drawTicket: Number(res.tickets?.drawTicket ?? 0),
            draw10Ticket: Number(res.tickets?.draw10Ticket ?? 0),
            affixReforgeTicket: Number(res.tickets?.affixReforgeTicket ?? 0)
          },
          data
        }
      }
      return { ok: false as const, error: res?.error || '使用单抽券失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '使用单抽券失败') }
    }
  }

  async function useDraw10Ticket() {
    try {
      const idemKey = createIdempotencyKey('ticket-draw10')
      const res = await $bff<ApiResponse<{ tickets: TicketBalance; data?: DrawResult }>>('/gacha/tickets/draw10/use', {
        method: 'POST',
        headers: {
          'x-idempotency-key': idemKey
        },
        body: {}
      })
      if (res?.ok) {
        const mappedItems = res.data?.items?.map(withCardVariant) ?? []
        const data = res.data ? { ...res.data, items: mappedItems } : null
        if (data?.wallet) {
          state.value.wallet = data.wallet
          state.value.walletFetchedAt = new Date().toISOString()
        }
        return {
          ok: true as const,
          tickets: {
            drawTicket: Number(res.tickets?.drawTicket ?? 0),
            draw10Ticket: Number(res.tickets?.draw10Ticket ?? 0),
            affixReforgeTicket: Number(res.tickets?.affixReforgeTicket ?? 0)
          },
          data
        }
      }
      return { ok: false as const, error: res?.error || '使用十连券失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '使用十连券失败') }
    }
  }

  async function useAffixReforgeTicket(cardId?: string, affixSignature?: string) {
    try {
      const idemKey = createIdempotencyKey('ticket-reforge')
      const res = await $bff<ApiResponse<{ tickets: TicketBalance; result?: TicketUseResult['result'] }>>('/gacha/tickets/affix-reforge/use', {
        method: 'POST',
        headers: {
          'x-idempotency-key': idemKey
        },
        body: {
          cardId: cardId || undefined,
          affixSignature: affixSignature || undefined
        }
      })
      if (res?.ok) {
        const result = res.result ? {
          ...res.result,
          title: normalizeCardTitle(res.result.title)
        } : null
        return {
          ok: true as const,
          tickets: {
            drawTicket: Number(res.tickets?.drawTicket ?? 0),
            draw10Ticket: Number(res.tickets?.draw10Ticket ?? 0),
            affixReforgeTicket: Number(res.tickets?.affixReforgeTicket ?? 0)
          },
          result
        }
      }
      return { ok: false as const, error: res?.error || '使用改造券失败' }
    } catch (error: any) {
      return { ok: false as const, error: normalizeError(error, '使用改造券失败') }
    }
  }

  return { getTickets, useDrawTicket, useDraw10Ticket, useAffixReforgeTicket }
}
