import type { GachaCoreContext, ApiResponse } from './gachaCore'
import { normalizeError } from './gachaCore'
import type { Wallet, Rarity, AffixVisualStyle } from '~/types/gacha'

export interface ShowcaseSlotCard {
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
}

export interface ShowcaseSlot {
  slotIndex: number
  card: ShowcaseSlotCard | null
}

export interface Showcase {
  id: string
  name: string
  sortOrder: number
  createdAt: string
  slots: ShowcaseSlot[]
}

export interface ShowcaseMeta {
  freeCount: number
  maxCount: number
  unlockCost: number
  slotMax: number
}

export function useGachaShowcaseApi(core: GachaCoreContext) {
  const { $bff, state, withCardVariant, captureWalletSeq, setWalletIfFresh } = core

  const withShowcaseSlotCardVariant = (slot: ShowcaseSlot): ShowcaseSlot => ({
    ...slot,
    card: slot.card ? withCardVariant(slot.card) : null
  })

  const withShowcaseCardVariant = (showcase: Showcase): Showcase => ({
    ...showcase,
    slots: (showcase.slots ?? []).map(withShowcaseSlotCardVariant)
  })

  async function getShowcases() {
    try {
      const res = await $bff<ApiResponse<{ showcases: Showcase[] } & ShowcaseMeta>>('/gacha/showcases', { method: 'GET' })
      if (res?.ok) {
        return {
          ok: true as const,
          showcases: (res.showcases ?? []).map(withShowcaseCardVariant),
          meta: {
            freeCount: res.freeCount ?? 3,
            maxCount: res.maxCount ?? 10,
            unlockCost: res.unlockCost ?? 3000,
            slotMax: res.slotMax ?? 10
          }
        }
      }
      return { ok: false as const, error: res?.error || '获取展示柜失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '获取展示柜失败') }
    }
  }

  async function createShowcase(name: string) {
    try {
      const walletSeq = captureWalletSeq()
      const res = await $bff<ApiResponse<{ showcase: Showcase; wallet?: Wallet }>>('/gacha/showcases', {
        method: 'POST',
        body: { name }
      })
      if (res?.ok) {
        if (res.wallet) {
          setWalletIfFresh(res.wallet, walletSeq)
        }
        return { ok: true as const, showcase: withShowcaseCardVariant(res.showcase) }
      }
      return { ok: false as const, error: res?.error || '创建展示柜失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '创建展示柜失败') }
    }
  }

  async function renameShowcase(id: string, name: string) {
    try {
      const res = await $bff<ApiResponse<{}>>(`/gacha/showcases/${id}`, {
        method: 'PATCH',
        body: { name }
      })
      if (res?.ok) return { ok: true as const }
      return { ok: false as const, error: res?.error || '重命名失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '重命名失败') }
    }
  }

  async function deleteShowcase(id: string) {
    try {
      const res = await $bff<ApiResponse<{}>>(`/gacha/showcases/${id}`, {
        method: 'DELETE'
      })
      if (res?.ok) return { ok: true as const }
      return { ok: false as const, error: res?.error || '删除展示柜失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '删除展示柜失败') }
    }
  }

  async function setShowcaseSlot(showcaseId: string, slotIndex: number, instanceId: string) {
    try {
      const res = await $bff<ApiResponse<{ slot: ShowcaseSlot }>>(`/gacha/showcases/${showcaseId}/slots/${slotIndex}/set`, {
        method: 'POST',
        body: { instanceId }
      })
      if (res?.ok) return { ok: true as const, slot: withShowcaseSlotCardVariant(res.slot) }
      return { ok: false as const, error: res?.error || '放入卡片失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '放入卡片失败') }
    }
  }

  async function clearShowcaseSlot(showcaseId: string, slotIndex: number) {
    try {
      const res = await $bff<ApiResponse<{}>>(`/gacha/showcases/${showcaseId}/slots/${slotIndex}/clear`, {
        method: 'POST'
      })
      if (res?.ok) return { ok: true as const }
      return { ok: false as const, error: res?.error || '移除卡片失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '移除卡片失败') }
    }
  }

  async function reorderShowcaseSlots(showcaseId: string, slotOrder: number[]) {
    try {
      const res = await $bff<ApiResponse<{}>>(`/gacha/showcases/${showcaseId}/reorder`, {
        method: 'POST',
        body: { slotOrder }
      })
      if (res?.ok) return { ok: true as const }
      return { ok: false as const, error: res?.error || '重排卡片失败' }
    } catch (error: unknown) {
      return { ok: false as const, error: normalizeError(error, '重排卡片失败') }
    }
  }

  return {
    getShowcases,
    createShowcase,
    renameShowcase,
    deleteShowcase,
    setShowcaseSlot,
    clearShowcaseSlot,
    reorderShowcaseSlots
  }
}
