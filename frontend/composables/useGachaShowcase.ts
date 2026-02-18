import { ref, computed } from 'vue'
import type { GachaPageContext } from '~/composables/useGachaPage'
import type { Showcase, ShowcaseMeta } from '~/composables/api/gachaShowcase'

export function useGachaShowcase(page: GachaPageContext) {
  const { gacha, emitError, emitSuccess } = page

  const showcases = ref<Showcase[]>([])
  const meta = ref<ShowcaseMeta>({ freeCount: 3, maxCount: 10, unlockCost: 3000, slotMax: 10 })
  const loadingShowcases = ref(false)
  const showcaseBusy = ref(false)
  const showcasesLoaded = ref(false)

  const canCreateFree = computed(() => showcases.value.length < meta.value.freeCount)
  const canCreatePaid = computed(() => showcases.value.length >= meta.value.freeCount && showcases.value.length < meta.value.maxCount)
  const atMax = computed(() => showcases.value.length >= meta.value.maxCount)

  async function refreshShowcases() {
    loadingShowcases.value = true
    try {
      const res = await gacha.getShowcases()
      if (res.ok) {
        showcases.value = res.showcases
        meta.value = res.meta
        showcasesLoaded.value = true
        return true
      }
      return false
    } catch {
      return false
    } finally {
      loadingShowcases.value = false
    }
  }

  async function createShowcase(name: string) {
    if (showcaseBusy.value) return false
    showcaseBusy.value = true
    try {
      if (!showcasesLoaded.value) {
        await refreshShowcases()
      }
      const res = await gacha.createShowcase(name)
      if (!res.ok) {
        emitError(res.error)
        return false
      }
      await refreshShowcases()
      emitSuccess('展示柜已创建')
      return true
    } catch (e: any) {
      emitError(e?.message || '创建展示柜失败')
      return false
    } finally {
      showcaseBusy.value = false
    }
  }

  async function renameShowcase(id: string, name: string) {
    if (showcaseBusy.value) return false
    showcaseBusy.value = true
    try {
      const res = await gacha.renameShowcase(id, name)
      if (!res.ok) {
        emitError(res.error)
        return false
      }
      const idx = showcases.value.findIndex((sc) => sc.id === id)
      if (idx >= 0) showcases.value[idx] = { ...showcases.value[idx], name }
      return true
    } catch (e: any) {
      emitError(e?.message || '重命名失败')
      return false
    } finally {
      showcaseBusy.value = false
    }
  }

  async function deleteShowcase(id: string) {
    if (showcaseBusy.value) return false
    showcaseBusy.value = true
    try {
      const res = await gacha.deleteShowcase(id)
      if (!res.ok) {
        emitError(res.error)
        return false
      }
      showcases.value = showcases.value.filter((sc) => sc.id !== id)
      emitSuccess('展示柜已删除')
      return true
    } catch (e: any) {
      emitError(e?.message || '删除展示柜失败')
      return false
    } finally {
      showcaseBusy.value = false
    }
  }

  async function setSlot(showcaseId: string, slotIndex: number, instanceId: string) {
    if (showcaseBusy.value) return false
    showcaseBusy.value = true
    try {
      const res = await gacha.setShowcaseSlot(showcaseId, slotIndex, instanceId)
      if (!res.ok) {
        emitError(res.error)
        return false
      }
      // Refresh to get latest state
      await refreshShowcases()
      return true
    } catch (e: any) {
      emitError(e?.message || '放入卡片失败')
      return false
    } finally {
      showcaseBusy.value = false
    }
  }

  async function clearSlot(showcaseId: string, slotIndex: number) {
    if (showcaseBusy.value) return false
    showcaseBusy.value = true
    try {
      const res = await gacha.clearShowcaseSlot(showcaseId, slotIndex)
      if (!res.ok) {
        emitError(res.error)
        return false
      }
      await refreshShowcases()
      return true
    } catch (e: any) {
      emitError(e?.message || '移除卡片失败')
      return false
    } finally {
      showcaseBusy.value = false
    }
  }

  return {
    showcases,
    meta,
    loadingShowcases,
    showcaseBusy,
    canCreateFree,
    canCreatePaid,
    atMax,
    refreshShowcases,
    createShowcase,
    renameShowcase,
    deleteShowcase,
    setSlot,
    clearSlot
  }
}
