import type { GachaCoreContext, ApiResponse } from './gachaCore'
import { normalizeError } from './gachaCore'
import type {
  Wallet, TicketBalance, MissionItem, AchievementItem
} from '~/types/gacha'

export function useGachaMissionsApi(core: GachaCoreContext) {
  const { $bff, state, captureWalletSeq, setWalletIfFresh } = core

  async function getMissions() {
    try {
      const res = await $bff<ApiResponse<{ items: MissionItem[] }>>('/gacha/missions', { method: 'GET' })
      if (res?.ok) {
        return { ok: true as const, data: res.items ?? [] }
      }
      return { ok: false as const, error: res?.error || '加载任务失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '加载任务失败') }
    }
  }

  async function claimMission(missionKey: string) {
    try {
      const walletSeq = captureWalletSeq()
      const res = await $bff<ApiResponse<{ mission: MissionItem; wallet?: Wallet; tickets?: TicketBalance }>>(`/gacha/missions/${missionKey}/claim`, {
        method: 'POST',
        body: {}
      })
      if (res?.ok) {
        if (res.wallet) {
          setWalletIfFresh(res.wallet, walletSeq)
        }
        return {
          ok: true as const,
          mission: res.mission,
          wallet: res.wallet ?? null,
          tickets: {
            drawTicket: Number(res.tickets?.drawTicket ?? 0),
            draw10Ticket: Number(res.tickets?.draw10Ticket ?? 0),
            affixReforgeTicket: Number(res.tickets?.affixReforgeTicket ?? 0)
          }
        }
      }
      return { ok: false as const, error: res?.error || '领取任务奖励失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '领取任务奖励失败') }
    }
  }

  async function claimAllMissions() {
    try {
      const walletSeq = captureWalletSeq()
      const res = await $bff<ApiResponse<{ claimed: number; items?: Array<{ missionKey: string; claimedAt: string }>; wallet?: Wallet; tickets?: TicketBalance }>>('/gacha/missions/claim-all', {
        method: 'POST',
        body: {}
      })
      if (res?.ok) {
        if (res.wallet) {
          setWalletIfFresh(res.wallet, walletSeq)
        }
        return {
          ok: true as const,
          claimed: Number(res.claimed ?? 0),
          items: res.items ?? [],
          wallet: res.wallet ?? null,
          tickets: {
            drawTicket: Number(res.tickets?.drawTicket ?? 0),
            draw10Ticket: Number(res.tickets?.draw10Ticket ?? 0),
            affixReforgeTicket: Number(res.tickets?.affixReforgeTicket ?? 0)
          }
        }
      }
      return { ok: false as const, error: res?.error || '领取任务奖励失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '领取任务奖励失败') }
    }
  }

  async function getAchievements() {
    try {
      const res = await $bff<ApiResponse<{ items: AchievementItem[] }>>('/gacha/achievements', { method: 'GET' })
      if (res?.ok) {
        return { ok: true as const, data: res.items ?? [] }
      }
      return { ok: false as const, error: res?.error || '加载成就失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '加载成就失败') }
    }
  }

  async function claimAchievement(achievementKey: string) {
    try {
      const walletSeq = captureWalletSeq()
      const res = await $bff<ApiResponse<{ achievement: AchievementItem; wallet?: Wallet; tickets?: TicketBalance }>>(`/gacha/achievements/${achievementKey}/claim`, {
        method: 'POST',
        body: {}
      })
      if (res?.ok) {
        if (res.wallet) {
          setWalletIfFresh(res.wallet, walletSeq)
        }
        return {
          ok: true as const,
          achievement: res.achievement,
          wallet: res.wallet ?? null,
          tickets: {
            drawTicket: Number(res.tickets?.drawTicket ?? 0),
            draw10Ticket: Number(res.tickets?.draw10Ticket ?? 0),
            affixReforgeTicket: Number(res.tickets?.affixReforgeTicket ?? 0)
          }
        }
      }
      return { ok: false as const, error: res?.error || '领取成就奖励失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '领取成就奖励失败') }
    }
  }

  async function claimAllAchievements() {
    try {
      const walletSeq = captureWalletSeq()
      const res = await $bff<ApiResponse<{ claimed: number; items?: Array<{ achievementKey: string; claimedAt: string }>; wallet?: Wallet; tickets?: TicketBalance }>>('/gacha/achievements/claim-all', {
        method: 'POST',
        body: {}
      })
      if (res?.ok) {
        if (res.wallet) {
          setWalletIfFresh(res.wallet, walletSeq)
        }
        return {
          ok: true as const,
          claimed: Number(res.claimed ?? 0),
          items: res.items ?? [],
          wallet: res.wallet ?? null,
          tickets: {
            drawTicket: Number(res.tickets?.drawTicket ?? 0),
            draw10Ticket: Number(res.tickets?.draw10Ticket ?? 0),
            affixReforgeTicket: Number(res.tickets?.affixReforgeTicket ?? 0)
          }
        }
      }
      return { ok: false as const, error: res?.error || '领取成就奖励失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '领取成就奖励失败') }
    }
  }

  return {
    getMissions,
    claimMission,
    claimAllMissions,
    getAchievements,
    claimAchievement,
    claimAllAchievements
  }
}
