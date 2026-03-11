import type { GachaCoreContext, ApiResponse } from './gachaCore'
import { normalizeError } from './gachaCore'
import type { Rarity, AffixVisualStyle } from '~/types/gacha'

export interface LockedInstance {
  instanceId: string
  cardId: string
  title: string
  rarity: Rarity
  imageUrl: string | null
  tags: string[]
  isRetired?: boolean
  authors?: Array<{ name: string; wikidotId: number | null }> | null
  wikidotId: number | null
  pageId: number | null
  affixVisualStyle: AffixVisualStyle
  affixSignature: string
  affixLabel: string | null
  lockedAt: string | null
  isLocked?: boolean
}

export function useGachaLockApi(core: GachaCoreContext) {
  const { $bff, withCardVariant } = core

  const withLockedInstanceCardVariant = (instance: LockedInstance): LockedInstance => (
    withCardVariant(instance)
  )

  async function lockInstances(instanceIds: string[]) {
    try {
      const res = await $bff<ApiResponse<{ locked: number; alreadyLocked: number }>>('/gacha/lock', {
        method: 'POST',
        body: { instanceIds }
      })
      if (res?.ok) {
        return { ok: true as const, locked: res.locked ?? 0, alreadyLocked: res.alreadyLocked ?? 0 }
      }
      return { ok: false as const, error: res?.error || '锁定失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '锁定失败') }
    }
  }

  async function lockVariant(cardId: string, affixSignature?: string, count?: number) {
    try {
      const res = await $bff<ApiResponse<{ locked: number; alreadyLocked: number }>>('/gacha/lock', {
        method: 'POST',
        body: { cardId, affixSignature, count }
      })
      if (res?.ok) {
        return { ok: true as const, locked: res.locked ?? 0, alreadyLocked: res.alreadyLocked ?? 0 }
      }
      return { ok: false as const, error: res?.error || '锁定失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '锁定失败') }
    }
  }

  async function unlockInstances(instanceIds: string[]) {
    try {
      const res = await $bff<ApiResponse<{ unlocked: number; alreadyUnlocked: number }>>('/gacha/unlock', {
        method: 'POST',
        body: { instanceIds }
      })
      if (res?.ok) {
        return { ok: true as const, unlocked: res.unlocked ?? 0, alreadyUnlocked: res.alreadyUnlocked ?? 0 }
      }
      return { ok: false as const, error: res?.error || '解锁失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '解锁失败') }
    }
  }

  async function unlockVariant(cardId: string, affixSignature?: string, count?: number) {
    try {
      const res = await $bff<ApiResponse<{ unlocked: number; alreadyUnlocked: number }>>('/gacha/unlock', {
        method: 'POST',
        body: { cardId, affixSignature, count }
      })
      if (res?.ok) {
        return { ok: true as const, unlocked: res.unlocked ?? 0, alreadyUnlocked: res.alreadyUnlocked ?? 0 }
      }
      return { ok: false as const, error: res?.error || '解锁失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '解锁失败') }
    }
  }

  async function getLockedInstances() {
    try {
      const res = await $bff<ApiResponse<{ items: LockedInstance[] }>>('/gacha/locked', {
        method: 'GET'
      })
      if (res?.ok) {
        return { ok: true as const, items: (res.items ?? []).map(withLockedInstanceCardVariant) }
      }
      return { ok: false as const, error: res?.error || '获取锁定列表失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '获取锁定列表失败') }
    }
  }

  async function getFreeInstances(params: {
    limit?: number | 'all'
    offset?: number
    search?: string
    rarity?: Rarity | 'ALL'
    includePlaced?: boolean
    includeLocked?: boolean
    sort?: 'LATEST' | 'PICKER'
  } = {}) {
    const limit = params.limit ?? 500
    try {
      const res = await $bff<ApiResponse<{ items: LockedInstance[]; total?: number; pageRows?: number }>>('/gacha/instances/free', {
        method: 'GET',
        params: {
          limit: limit === 'all' ? 'all' : String(limit),
          offset: params.offset != null ? String(params.offset) : undefined,
          search: params.search?.trim() || undefined,
          rarity: params.rarity && params.rarity !== 'ALL' ? params.rarity : undefined,
          includePlaced: params.includePlaced ? '1' : undefined,
          includeLocked: params.includeLocked ? '1' : undefined,
          sort: params.sort ?? undefined
        }
      })
      if (res?.ok) {
        return {
          ok: true as const,
          items: (res.items ?? []).map(withLockedInstanceCardVariant),
          total: Math.max(0, Number(res.total ?? 0)),
          pageRows: Math.max(0, Number(res.pageRows ?? 0))
        }
      }
      return { ok: false as const, error: res?.error || '获取自由实例失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '获取自由实例失败') }
    }
  }

  return {
    lockInstances,
    lockVariant,
    unlockInstances,
    unlockVariant,
    getLockedInstances,
    getFreeInstances
  }
}
