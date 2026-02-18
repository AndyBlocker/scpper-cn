import { ref } from 'vue'
import type { GachaPageContext } from '~/composables/useGachaPage'
import type { LockedInstance } from '~/composables/api/gachaLock'

export function useGachaLock(page: GachaPageContext) {
  const { gacha, emitError, emitSuccess } = page

  const lockedInstances = ref<LockedInstance[]>([])
  const loadingLocked = ref(false)
  const lockBusy = ref(false)

  async function refreshLocked() {
    loadingLocked.value = true
    try {
      const res = await gacha.getLockedInstances()
      if (res.ok) {
        lockedInstances.value = res.items
      }
    } catch {
      // silent
    } finally {
      loadingLocked.value = false
    }
  }

  async function lockVariant(cardId: string, affixSignature?: string, count?: number) {
    lockBusy.value = true
    try {
      const res = await gacha.lockVariant(cardId, affixSignature, count)
      if (!res.ok) {
        emitError(res.error)
        return false
      }
      if (res.locked > 0) emitSuccess(`已锁定 ${res.locked} 张卡片`)
      else emitSuccess('卡片已全部处于锁定状态')
      return true
    } catch (e: any) {
      emitError(e?.message || '锁定失败')
      return false
    } finally {
      lockBusy.value = false
    }
  }

  async function unlockVariant(cardId: string, affixSignature?: string, count?: number) {
    lockBusy.value = true
    try {
      const res = await gacha.unlockVariant(cardId, affixSignature, count)
      if (!res.ok) {
        emitError(res.error)
        return false
      }
      if (res.unlocked > 0) emitSuccess(`已解锁 ${res.unlocked} 张卡片`)
      else emitSuccess('卡片已全部处于解锁状态')
      return true
    } catch (e: any) {
      emitError(e?.message || '解锁失败')
      return false
    } finally {
      lockBusy.value = false
    }
  }

  return {
    lockedInstances,
    loadingLocked,
    lockBusy,
    refreshLocked,
    lockVariant,
    unlockVariant
  }
}
