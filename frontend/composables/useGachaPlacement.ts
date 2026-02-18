import { computed, nextTick, ref, watch } from 'vue'
import type { GachaPageContext } from '~/composables/useGachaPage'
import type {
  AffixVisualStyle,
  HistoryItem,
  InventoryItem,
  PlacementOverview,
  Rarity
} from '~/types/gacha'
import {
  resolveAffixParts,
  resolveAffixSignatureFromSource,
  resolvePrimaryAffixStyleFromSource,
  hasAffixStyle
} from '~/utils/gachaAffix'
import { normalizeAffixStyle } from '~/utils/gachaAffixTheme'
import { raritySortWeight } from '~/utils/gachaRarity'
import { displayCardTitle } from '~/utils/gachaTitle'
import { paginatedLoadAll } from '~/utils/gachaPagination'
import { usePageAuthors } from '~/composables/usePageAuthors'
import { resolveAuthorSearchText } from '~/utils/gachaAuthorSearch'

/**
 * placement.vue (放置页面) 的状态管理和业务逻辑。
 * 从 useGachaIndex 中提取放置相关逻辑。
 */
export function useGachaPlacement(page: GachaPageContext) {
  const { gacha, activated, emitError, handleWalletUpdated } = page
  const pageAuthors = usePageAuthors()

  function authorSearchText(
    authors: Array<{ name: string; wikidotId: number | null }> | null | undefined,
    wikidotId: number | null | undefined
  ) {
    const id = Number(wikidotId)
    const cachedAuthors = Number.isFinite(id) && id > 0 ? pageAuthors.getAuthors(id) : []
    return resolveAuthorSearchText(authors, cachedAuthors)
  }

  // ─── Local Wrapper for placementStackKey ──────────────
  // The index.vue version handles null cardId and normalizes signature via resolveAffixSignatureFromSource
  function placementSlotKey(
    cardId: string | null | undefined,
    affixSignature: string | null | undefined,
    style: AffixVisualStyle | null | undefined
  ): string {
    if (!cardId) return ''
    return `${cardId}::${resolveAffixSignatureFromSource({
      affixSignature,
      affixVisualStyle: style
    })}`
  }

  // ─── History ──────────────────────────────────────────
  const history = ref<HistoryItem[]>([])

  // ─── Placement State ──────────────────────────────────
  const placement = ref<PlacementOverview | null>(null)
  const placementOptions = ref<InventoryItem[]>([])
  const placementOptionsLoading = ref(false)
  const placementOptionsRefreshQueued = ref(false)
  const placementLoading = ref(false)
  const placementClaiming = ref(false)
  const placementUnlocking = ref(false)
  const placementSlotUpdating = ref<number | null>(null)
  const placementAddonUpdating = ref(false)
  const placementPickerSlot = ref<number | null>(null)
  const placementPickerSearch = ref('')
  const placementPickerRarity = ref<Rarity | 'ALL'>('ALL')
  const placementAddonPickerOpen = ref(false)
  const placementAddonSearch = ref('')

  // Debounced picker search — avoids recomputing heavy picker options on every keystroke
  const debouncedPickerSearch = ref('')
  let pickerSearchTimer: ReturnType<typeof setTimeout> | null = null
  watch(placementPickerSearch, (val) => {
    if (pickerSearchTimer) clearTimeout(pickerSearchTimer)
    pickerSearchTimer = setTimeout(() => {
      debouncedPickerSearch.value = val
    }, 200)
  })

  let placementAuthorQueueTimer: ReturnType<typeof setTimeout> | null = null
  const placementAuthorQueue = new Set<number>()

  // ─── Placement Picker Focus Refs ──────────────────────
  const placementPickerContainerRef = ref<HTMLElement | null>(null)
  const placementPickerSearchRef = ref<HTMLInputElement | null>(null)
  const placementPickerFocusReturnRef = ref<HTMLElement | null>(null)
  const placementAddonContainerRef = ref<HTMLElement | null>(null)
  const placementAddonSearchRef = ref<HTMLInputElement | null>(null)
  const placementAddonFocusReturnRef = ref<HTMLElement | null>(null)

  // ═══════════════════════════════════════════════════════
  // COMPUTED PROPERTIES
  // ═══════════════════════════════════════════════════════

  const placementColorlessAddon = computed(() =>
    (placement.value?.addons ?? []).find((addon) => addon.kind === 'COLORLESS') ?? null
  )

  const placementUnlockedSlots = computed(() => {
    const slotCount = Math.max(0, Number(placement.value?.slotCount ?? 0))
    return (placement.value?.slots ?? []).filter((slot) => slot.slotIndex <= slotCount)
  })

  const placementFilledSlotCount = computed(() =>
    placementUnlockedSlots.value.filter((slot) => Boolean(slot.card)).length
  )

  const placementAssignedCount = computed<Record<string, number>>(() => {
    const map: Record<string, number> = {}
    ;(placement.value?.slots ?? []).forEach((slot) => {
      const key = placementSlotKey(
        slot.card?.id ?? null,
        slot.card?.affixSignature,
        slot.card?.affixVisualStyle
      )
      if (!key) return
      map[key] = (map[key] || 0) + 1
    })
    ;(placement.value?.addons ?? []).forEach((addon) => {
      const key = placementSlotKey(
        addon.card?.id ?? null,
        addon.card?.affixSignature,
        addon.card?.affixVisualStyle
      )
      if (!key) return
      map[key] = (map[key] || 0) + 1
    })
    return map
  })

  const placementPickerCurrentSlot = computed(() =>
    placement.value?.slots.find((slot) => slot.slotIndex === placementPickerSlot.value) ?? null
  )

  const placementPickerCurrentStackKey = computed(() => placementSlotKey(
    placementPickerCurrentSlot.value?.card?.id ?? null,
    placementPickerCurrentSlot.value?.card?.affixSignature,
    placementPickerCurrentSlot.value?.card?.affixVisualStyle
  ))

  const placementPickerOptions = computed(() => {
    const slotIndex = placementPickerSlot.value
    if (slotIndex == null) return []
    const activeStackKey = placementPickerCurrentStackKey.value
    const assignedMap = placementAssignedCount.value
    const keyword = debouncedPickerSearch.value.trim().toLowerCase()
    const mapped = placementOptions.value
      .map((item) => {
        const stackKey = placementSlotKey(item.cardId, item.affixSignature, item.affixVisualStyle)
        const assignedElsewhere = (assignedMap[stackKey] || 0) - (activeStackKey === stackKey ? 1 : 0)
        const availableCount = item.count - Math.max(0, assignedElsewhere)
        const disabled = availableCount <= 0 && stackKey !== activeStackKey
        const primaryAffixStyle = hasAffixStyle(item, 'COLORLESS')
          ? 'COLORLESS'
          : resolvePrimaryAffixStyleFromSource(item)
        return {
          ...item,
          stackKey,
          availableCount,
          disabled,
          affixParts: resolveAffixParts(item),
          primaryAffixStyle,
          affixSignatureNormalized: resolveAffixSignatureFromSource(item)
        }
      })
      .filter((item) => {
        if (placementPickerRarity.value !== 'ALL' && item.rarity !== placementPickerRarity.value) {
          return false
        }
        if (!keyword) return true
        const target = `${item.title} ${(item.tags ?? []).filter(t => !t.startsWith('_')).join(' ')} ${authorSearchText(item.authors, item.wikidotId)} ${item.cardId}`.toLowerCase()
        return target.includes(keyword)
      })
      .sort((a, b) => {
        const rarityDiff = compareInventoryRarity(a, b)
        if (rarityDiff !== 0) {
          return rarityDiff
        }
        if (a.availableCount !== b.availableCount) {
          return b.availableCount - a.availableCount
        }
        return compareInventoryRarityAndTitle(a, b)
      })
    if (mapped.length > 0) return mapped

    const current = placementPickerCurrentSlot.value?.card
    if (!current?.id) return []
    const currentStackKey = placementSlotKey(current.id, current.affixSignature, current.affixVisualStyle)
    return [{
      id: `${current.id}:${currentStackKey || 'current'}`,
      cardId: current.id,
      poolId: current.poolId ?? 'permanent-main-pool',
      title: current.title,
      rarity: current.rarity,
      tags: current.tags ?? [],
      authors: current.authors ?? [],
      imageUrl: current.imageUrl ?? null,
      wikidotId: current.wikidotId ?? null,
      pageId: current.pageId ?? null,
      rewardTokens: 0,
      count: 1,
      affixSignature: current.affixSignature,
      affixStyles: current.affixStyles,
      affixStyleCounts: current.affixStyleCounts,
      affixVisualStyle: current.affixVisualStyle,
      affixLabel: current.affixLabel,
      affixYieldBoostPercent: current.affixYieldBoostPercent ?? 0,
      affixOfflineBufferBonus: current.affixOfflineBufferBonus ?? 0,
      affixDismantleBonusPercent: current.affixDismantleBonusPercent ?? 0,
      stackKey: currentStackKey,
      availableCount: 1,
      disabled: false,
      affixParts: resolveAffixParts(current),
      primaryAffixStyle: resolvePrimaryAffixStyleFromSource(current),
      affixSignatureNormalized: resolveAffixSignatureFromSource(current)
    }]
  })

  const placementColorlessPickerOptions = computed(() => {
    const keyword = placementAddonSearch.value.trim().toLowerCase()
    const assignedMap = placementAssignedCount.value
    const currentStackKey = placementSlotKey(
      placementColorlessAddon.value?.card?.id ?? null,
      placementColorlessAddon.value?.card?.affixSignature,
      placementColorlessAddon.value?.card?.affixVisualStyle
    )
    return placementOptions.value
      .map((item) => {
        const stackKey = placementSlotKey(item.cardId, item.affixSignature, item.affixVisualStyle)
        const assignedElsewhere = (assignedMap[stackKey] || 0) - (currentStackKey === stackKey ? 1 : 0)
        const availableCount = item.count - Math.max(0, assignedElsewhere)
        const disabled = availableCount <= 0 && stackKey !== currentStackKey
        const primaryAffixStyle = resolvePrimaryAffixStyleFromSource(item)
        return {
          ...item,
          stackKey,
          availableCount,
          disabled,
          primaryAffixStyle,
          affixParts: resolveAffixParts(item),
          affixSignatureNormalized: resolveAffixSignatureFromSource(item)
        }
      })
      .filter((item) => hasAffixStyle(item, 'COLORLESS'))
      .filter((item) => {
        if (!keyword) return true
        const target = `${item.title} ${(item.tags ?? []).filter(t => !t.startsWith('_')).join(' ')} ${authorSearchText(item.authors, item.wikidotId)} ${item.cardId}`.toLowerCase()
        return target.includes(keyword)
      })
      .sort((a, b) => {
        const rarityDiff = compareInventoryRarity(a, b)
        if (rarityDiff !== 0) {
          return rarityDiff
        }
        if (a.availableCount !== b.availableCount) {
          return b.availableCount - a.availableCount
        }
        return compareInventoryRarityAndTitle(a, b)
      })
  })

  // ═══════════════════════════════════════════════════════
  // HELPER FUNCTIONS
  // ═══════════════════════════════════════════════════════

  function compareInventoryRarity(
    a: Pick<InventoryItem, 'rarity'>,
    b: Pick<InventoryItem, 'rarity'>
  ) {
    return (raritySortWeight[a.rarity] ?? 99) - (raritySortWeight[b.rarity] ?? 99)
  }

  function compareInventoryRarityAndTitle(
    a: Pick<InventoryItem, 'rarity' | 'title' | 'cardId' | 'affixSignature' | 'affixVisualStyle'>,
    b: Pick<InventoryItem, 'rarity' | 'title' | 'cardId' | 'affixSignature' | 'affixVisualStyle'>
  ) {
    const rarityDiff = compareInventoryRarity(a, b)
    if (rarityDiff !== 0) return rarityDiff
    const titleDiff = a.title.localeCompare(b.title, 'zh-CN')
    if (titleDiff !== 0) return titleDiff
    const cardDiff = a.cardId.localeCompare(b.cardId, 'zh-CN')
    if (cardDiff !== 0) return cardDiff
    return placementSlotKey(a.cardId, a.affixSignature, a.affixVisualStyle)
      .localeCompare(placementSlotKey(b.cardId, b.affixSignature, b.affixVisualStyle), 'zh-CN')
  }

  function captureFocusTarget() {
    if (typeof document === 'undefined') return null
    const active = document.activeElement
    return active instanceof HTMLElement ? active : null
  }

  function restoreFocusTarget(target: HTMLElement | null) {
    if (!target || typeof window === 'undefined') return
    window.requestAnimationFrame(() => {
      target.focus?.()
    })
  }

  function queueAuthorHydration(ids: Array<number | null | undefined>) {
    ids.forEach((value) => {
      const id = Number(value)
      if (!Number.isFinite(id) || id <= 0) return
      placementAuthorQueue.add(id)
    })
    if (!placementAuthorQueue.size || placementAuthorQueueTimer) return
    placementAuthorQueueTimer = setTimeout(() => {
      placementAuthorQueueTimer = null
      const batch = Array.from(placementAuthorQueue)
      placementAuthorQueue.clear()
      void pageAuthors.ensureAuthors(batch)
    }, 80)
  }

  function seedAuthorCacheFromInventory(items: InventoryItem[]) {
    for (const item of items) {
      pageAuthors.seedAuthors(item.wikidotId ?? null, item.authors ?? null)
    }
  }

  function seedAuthorCacheFromPlacement(overview: PlacementOverview | null) {
    const ids: Array<number | null | undefined> = []
    for (const slot of overview?.slots ?? []) {
      if (!slot.card) continue
      pageAuthors.seedAuthors(slot.card.wikidotId ?? null, slot.card.authors ?? null)
      ids.push(slot.card.wikidotId)
    }
    for (const addon of overview?.addons ?? []) {
      if (!addon.card) continue
      pageAuthors.seedAuthors(addon.card.wikidotId ?? null, addon.card.authors ?? null)
      ids.push(addon.card.wikidotId)
    }
    queueAuthorHydration(ids)
  }

  // ═══════════════════════════════════════════════════════
  // PLACEMENT PICKER HANDLERS
  // ═══════════════════════════════════════════════════════

  function openPlacementPicker(slotIndex: number) {
    placementPickerFocusReturnRef.value = captureFocusTarget()
    closePlacementAddonPicker()
    placementPickerSlot.value = slotIndex
    placementPickerSearch.value = ''
    placementPickerRarity.value = 'ALL'
    refreshPlacementOptions().catch((error) => {
      console.warn('[gacha] preload placement options for picker failed', error)
    })
  }

  function closePlacementPicker() {
    const previous = placementPickerFocusReturnRef.value
    placementPickerFocusReturnRef.value = null
    placementPickerSlot.value = null
    restoreFocusTarget(previous)
  }

  function openPlacementAddonPicker() {
    placementAddonFocusReturnRef.value = captureFocusTarget()
    closePlacementPicker()
    placementAddonSearch.value = ''
    placementAddonPickerOpen.value = true
    if (!placementOptions.value.length && !placementOptionsLoading.value) {
      refreshPlacementOptions().catch((error) => {
        console.warn('[gacha] preload placement options for addon picker failed', error)
      })
    }
  }

  function closePlacementAddonPicker() {
    const previous = placementAddonFocusReturnRef.value
    placementAddonFocusReturnRef.value = null
    placementAddonPickerOpen.value = false
    restoreFocusTarget(previous)
  }

  async function selectPlacementCard(
    cardId: string,
    affixVisualStyle: AffixVisualStyle = 'NONE',
    affixSignature?: string
  ) {
    const slotIndex = placementPickerSlot.value
    if (slotIndex == null) return
    await handlePlacementSlotSelect(slotIndex, cardId, affixVisualStyle, affixSignature)
  }

  async function clearPlacementFromPicker() {
    const slotIndex = placementPickerSlot.value
    if (slotIndex == null) return
    await handlePlacementClear(slotIndex)
  }

  async function selectPlacementAddonCard(
    cardId: string,
    affixVisualStyle: AffixVisualStyle = 'COLORLESS',
    affixSignature?: string
  ) {
    await handlePlacementColorlessSelect(cardId, affixVisualStyle, affixSignature)
  }

  // ═══════════════════════════════════════════════════════
  // REFRESH HANDLERS
  // ═══════════════════════════════════════════════════════

  async function refreshHistory() {
    if (!activated.value) {
      history.value = []
      return
    }
    try {
      const res = await gacha.getHistory({ limit: 8 })
      if (res.ok) {
        history.value = res.data ?? []
      }
    } catch (error) {
      console.warn('[gacha] load history failed', error)
    }
  }

  async function refreshPlacement(force = false) {
    if (!activated.value) {
      placement.value = null
      return
    }
    if (placementLoading.value) return
    placementLoading.value = true
    try {
      const res = await gacha.getPlacement(force)
      if (res.ok) {
        placement.value = res.data ?? null
        seedAuthorCacheFromPlacement(placement.value)
      }
    } catch (error) {
      console.warn('[gacha] load placement failed', error)
    } finally {
      placementLoading.value = false
    }
  }

  async function refreshPlacementOptions() {
    if (!activated.value) {
      placementOptions.value = []
      placementOptionsLoading.value = false
      placementOptionsRefreshQueued.value = false
      return
    }
    if (placementOptionsLoading.value) {
      placementOptionsRefreshQueued.value = true
      return
    }
    placementOptionsLoading.value = true
    placementOptionsRefreshQueued.value = false
    try {
      const allItems = await paginatedLoadAll<InventoryItem>({
        fetchPage: async (offset, limit, skipTotal) => {
          const res = await gacha.getInventory({ limit, offset, skipTotal })
          if (!res.ok) throw new Error(res.error || '加载放置卡片库存失败')
          return { items: res.data ?? [], total: res.total ?? 0, pageRows: Number(res.pageRows ?? 0) }
        },
        pageSize: 1000
      })
      const byStackKey = new Map<string, InventoryItem>()
      for (const item of allItems) {
        if (!item) continue
        const itemCount = Math.max(0, Math.floor(Number(item.count ?? 0)))
        if (itemCount <= 0) continue
        const stackKey = placementSlotKey(item.cardId, item.affixSignature, item.affixVisualStyle)
        if (!stackKey) continue
        const existing = byStackKey.get(stackKey)
        if (!existing) {
          byStackKey.set(stackKey, {
            ...item,
            count: itemCount
          })
        } else {
          existing.count = Math.max(0, Math.floor(Number(existing.count ?? 0))) + itemCount
        }
      }
      const items = Array.from(byStackKey.values())
        .sort((a, b) => compareInventoryRarityAndTitle(a, b))
      placementOptions.value = items
      seedAuthorCacheFromInventory(items)
      queueAuthorHydration(items.map((item) => item.wikidotId))
    } catch (error) {
      console.warn('[gacha] load placement options failed', error)
    } finally {
      placementOptionsLoading.value = false
      if (placementOptionsRefreshQueued.value) {
        placementOptionsRefreshQueued.value = false
        await refreshPlacementOptions()
      }
    }
  }

  async function refreshPlacementPanel(force = false) {
    await Promise.allSettled([
      refreshPlacement(force),
      refreshPlacementOptions()
    ])
  }

  // ═══════════════════════════════════════════════════════
  // PLACEMENT ACTION HANDLERS
  // ═══════════════════════════════════════════════════════

  async function handlePlacementSlotSelect(
    slotIndex: number,
    cardIdInput: string,
    affixVisualStyleInput: AffixVisualStyle = 'NONE',
    affixSignatureInput?: string
  ) {
    const cardId = cardIdInput?.trim() || ''
    if (!cardId) {
      await handlePlacementClear(slotIndex)
      return
    }
    const affixVisualStyle = normalizeAffixStyle(affixVisualStyleInput)
    const affixSignature = resolveAffixSignatureFromSource({
      affixSignature: affixSignatureInput,
      affixVisualStyle
    })
    if (placementSlotUpdating.value != null || placementAddonUpdating.value || placementUnlocking.value) return
    placementSlotUpdating.value = slotIndex
    try {
      const res = await gacha.setPlacementSlot(slotIndex, cardId, affixVisualStyle, affixSignature)
      if (!res.ok || !res.data) {
        emitError(res.error || '放置卡片失败')
        return
      }
      placement.value = res.data
      closePlacementPicker()
      // 后台刷新库存，不阻塞弹窗关闭
      refreshPlacementOptions()
    } catch (error: any) {
      emitError(error?.message || '放置卡片失败')
    } finally {
      placementSlotUpdating.value = null
    }
  }

  async function handlePlacementClear(slotIndex: number) {
    if (placementSlotUpdating.value != null || placementAddonUpdating.value || placementUnlocking.value) return
    placementSlotUpdating.value = slotIndex
    try {
      const res = await gacha.clearPlacementSlot(slotIndex)
      if (!res.ok || !res.data) {
        emitError(res.error || '清空槽位失败')
        return
      }
      placement.value = res.data
      if (placementPickerSlot.value === slotIndex) {
        closePlacementPicker()
      }
      refreshPlacementOptions()
    } catch (error: any) {
      emitError(error?.message || '清空槽位失败')
    } finally {
      placementSlotUpdating.value = null
    }
  }

  async function handlePlacementColorlessSelect(
    cardIdInput: string,
    affixVisualStyleInput: AffixVisualStyle = 'COLORLESS',
    affixSignatureInput?: string
  ) {
    const cardId = cardIdInput?.trim() || ''
    if (!cardId) return
    const affixVisualStyle = normalizeAffixStyle(affixVisualStyleInput)
    const affixSignature = resolveAffixSignatureFromSource({
      affixSignature: affixSignatureInput,
      affixVisualStyle
    })
    if (!hasAffixStyle({ affixSignature, affixVisualStyle }, 'COLORLESS')) {
      emitError('仅可挂载无色词条卡')
      return
    }
    if (placementAddonUpdating.value || placementSlotUpdating.value != null || placementUnlocking.value) return
    placementAddonUpdating.value = true
    try {
      const res = await gacha.setPlacementColorlessAddon(cardId, affixVisualStyle, affixSignature)
      if (!res.ok || !res.data) {
        emitError(res.error || '设置无色挂载失败')
        return
      }
      placement.value = res.data
      closePlacementAddonPicker()
      refreshPlacementOptions()
    } catch (error: any) {
      emitError(error?.message || '设置无色挂载失败')
    } finally {
      placementAddonUpdating.value = false
    }
  }

  async function handlePlacementSlotUnlock() {
    if (placementUnlocking.value || placementSlotUpdating.value != null || placementAddonUpdating.value || placementClaiming.value) return
    if (!placement.value?.nextUnlockCost) return
    placementUnlocking.value = true
    try {
      const res = await gacha.unlockPlacementSlot()
      if (!res.ok || !res.data) {
        emitError(res.error || '解锁槽位失败')
        return
      }
      placement.value = res.data
      if (res.wallet) {
        handleWalletUpdated(res.wallet)
      }
      await refreshPlacementOptions()
    } catch (error: any) {
      emitError(error?.message || '解锁槽位失败')
    } finally {
      placementUnlocking.value = false
    }
  }

  async function handlePlacementColorlessClear() {
    if (placementAddonUpdating.value || placementSlotUpdating.value != null || placementUnlocking.value) return
    placementAddonUpdating.value = true
    try {
      const res = await gacha.clearPlacementColorlessAddon()
      if (!res.ok || !res.data) {
        emitError(res.error || '清空无色挂载失败')
        return
      }
      placement.value = res.data
      closePlacementAddonPicker()
      refreshPlacementOptions()
    } catch (error: any) {
      emitError(error?.message || '清空无色挂载失败')
    } finally {
      placementAddonUpdating.value = false
    }
  }

  async function handlePlacementClaim() {
    if (placementClaiming.value || placementUnlocking.value) return
    if (!placement.value || placement.value.claimableToken <= 0) {
      emitError('当前暂无可领取收益')
      return
    }
    placementClaiming.value = true
    try {
      const res = await gacha.claimPlacement()
      if (!res.ok) {
        emitError(res.error || '领取失败')
        return
      }
      if (res.wallet) {
        handleWalletUpdated(res.wallet)
      }
      if (res.placement) {
        placement.value = res.placement
      } else {
        await refreshPlacement(true)
      }
    } catch (error: any) {
      emitError(error?.message || '领取失败')
    } finally {
      placementClaiming.value = false
    }
  }

  // ═══════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════

  async function loadInitial() {
    // 必须先等 config 就绪（设置 activated），后续 refreshPlacement 依赖它
    await page.refreshConfig(false)
    await Promise.allSettled([refreshHistory(), refreshPlacement(true)])
  }

  // ═══════════════════════════════════════════════════════
  // WATCHERS
  // ═══════════════════════════════════════════════════════

  watch(placementPickerSlot, async (slot) => {
    if (slot == null) return
    await nextTick()
    placementPickerContainerRef.value?.focus()
    placementPickerSearchRef.value?.focus()
  })

  watch(placementAddonPickerOpen, async (open) => {
    if (!open) return
    await nextTick()
    placementAddonContainerRef.value?.focus()
    placementAddonSearchRef.value?.focus()
  })

  // ═══════════════════════════════════════════════════════
  // RETURN
  // ═══════════════════════════════════════════════════════

  return {
    // History (for StatusBar)
    history,

    // Placement state
    placement,
    placementOptions,
    placementOptionsLoading,
    placementOptionsRefreshQueued,
    placementLoading,
    placementClaiming,
    placementUnlocking,
    placementSlotUpdating,
    placementAddonUpdating,
    placementPickerSlot,
    placementPickerSearch,
    placementPickerRarity,
    placementAddonPickerOpen,
    placementAddonSearch,

    // Placement picker refs (for template)
    placementPickerContainerRef,
    placementPickerSearchRef,
    placementPickerFocusReturnRef,
    placementAddonContainerRef,
    placementAddonSearchRef,
    placementAddonFocusReturnRef,

    // Placement computed
    placementColorlessAddon,
    placementUnlockedSlots,
    placementFilledSlotCount,
    placementAssignedCount,
    placementPickerCurrentSlot,
    placementPickerCurrentStackKey,
    placementPickerOptions,
    placementColorlessPickerOptions,

    // Helper functions
    placementSlotKey,
    compareInventoryRarity,
    compareInventoryRarityAndTitle,
    captureFocusTarget,
    restoreFocusTarget,

    // Placement picker handlers
    openPlacementPicker,
    closePlacementPicker,
    openPlacementAddonPicker,
    closePlacementAddonPicker,
    selectPlacementCard,
    clearPlacementFromPicker,
    selectPlacementAddonCard,

    // Refresh handlers
    refreshHistory,
    refreshPlacement,
    refreshPlacementOptions,
    refreshPlacementPanel,

    // Placement action handlers
    handlePlacementSlotSelect,
    handlePlacementClear,
    handlePlacementColorlessSelect,
    handlePlacementSlotUnlock,
    handlePlacementColorlessClear,
    handlePlacementClaim,

    // Lifecycle
    loadInitial,

    // Utility
    displayCardTitle
  }
}
