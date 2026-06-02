import { computed, ref, watch } from 'vue'
import type { GachaPageContext } from '~/composables/useGachaPage'
import type {
  AffixVisualStyle,
  DrawResult,
  GachaPool,
  GlobalBoost,
  HistoryItem,
  InventoryItem,
  Rarity,
  TicketBalance,
  TicketUseResult
} from '~/types/gacha'
import {
  normalizeTickets,
  emptyTickets,
  poolStatusKey,
  resolvePoolRange,
  toTimestamp
} from '~/utils/gachaFormatters'
import { resolveAffixSignatureFromSource } from '~/utils/gachaAffix'
import {
  poolPriorityMap
} from '~/utils/gachaConstants'
import { raritySortWeight } from '~/utils/gachaRarity'
import { displayCardTitle } from '~/utils/gachaTitle'
import { normalizeError } from '~/composables/api/gachaCore'
import GachaWalletBar from '~/components/gacha/GachaWalletBar.vue'
import { usePageAuthors } from '~/composables/usePageAuthors'

export interface ReforgeCardOption {
  stackKey: string
  cardId: string
  title: string
  rarity: Rarity
  imageUrl: string | null
  isRetired?: boolean
  wikidotId?: number | null
  tags: string[]
  authors?: Array<{ name: string; wikidotId: number | null }> | null
  count: number
  placedCount: number
  affixSignature?: string
  affixStyles?: AffixVisualStyle[]
  affixStyleCounts?: Partial<Record<AffixVisualStyle, number>>
}

/**
 * index.vue (gacha draw page) 的状态管理和业务逻辑。
 * 从 useGachaIndex 中提取纯抽卡相关的 state + handlers。
 */
export function useGachaDraw(page: GachaPageContext) {
  const { gacha, activated, emitError, handleWalletUpdated } = page
  const gachaState = gacha.state
  const pageAuthors = usePageAuthors()
  type DrawRepeatMode = 'AUTO' | 'DRAW_TICKET' | 'DRAW10_TICKET'

  // ─── Config / Pools / Boosts ──────────────────────────
  const pools = ref<GachaPool[]>([])
  const selectedPoolId = ref<string | null>(null)
  const boosts = ref<GlobalBoost[]>([])
  const loadingConfig = ref(false)

  // ─── Draw State ───────────────────────────────────────
  const drawing = ref(false)
  const lastResult = ref<DrawResult | null>(null)
  const resultModalOpen = ref(false)
  const lastDrawCount = ref(1)
  const lastDrawRepeatMode = ref<DrawRepeatMode>('AUTO')

  // ─── History ──────────────────────────────────────────
  const history = ref<HistoryItem[]>([])

  // ─── Tickets State ────────────────────────────────────
  const tickets = ref<TicketBalance>(emptyTickets())
  const ticketsLoading = ref(false)
  const ticketAction = ref<'draw' | 'draw10' | 'reforge' | null>(null)
  const reforgeCardId = ref('')
  const reforgeCardOptions = ref<ReforgeCardOption[]>([])
  const reforgeOptionsLoading = ref(false)
  const reforgeOptionsFullyLoaded = ref(false)
  const reforgeAffixFilter = ref<string>('')
  const reforgeOptionsReloadQueued = ref(false)
  let drawAuthorQueueTimer: ReturnType<typeof setTimeout> | null = null
  const drawAuthorQueue = new Set<number>()
  let reforgeLoadedAt = 0
  let reforgeLoadedFilter = ''
  let reforgeReconcileTimer: ReturnType<typeof setTimeout> | null = null
  // 改造 mutation 的单调序号：在每次改造【开始】时自增（见 beginReforgeMutation）。
  // 全量刷新捕获起始序号，落地前比对——若 fetch 期间有改造开始则丢弃该快照（拦住"中途开始"的改造）。
  let reforgeMutationSeq = 0
  // 进行中的改造数：改造期间任何全量刷新都可能读到"已提交但本地 patch 未到"的中间态，落地后再被
  // 本地 patch 叠加成双重计数。故 in-flight 期间的刷新一律放弃、交由改造完成后的对账补刷
  // （拦住"刷新启动时改造已在飞行"的情形，与序号守卫互补闭合竞态）。
  let reforgeMutationInFlight = 0
  const lastReforgeResult = ref<{
    cardId: string
    title: string
    before: { affixVisualStyle: AffixVisualStyle; affixLabel: string }
    after: { affixVisualStyle: AffixVisualStyle; affixLabel: string }
  } | null>(null)

  // ─── Reforge Modal State ─────────────────────────────
  const reforgeModalOpen = ref(false)
  const reforgeModalPhase = ref<'confirm' | 'result'>('confirm')
  const reforgeConfirming = ref(false)

  const selectedReforgeCardOption = computed(() =>
    reforgeCardOptions.value.find((item) => item.stackKey === reforgeCardId.value) ?? null
  )

  // ─── Balance Ref ──────────────────────────────────────
  const balanceRef = ref<InstanceType<typeof GachaWalletBar> | null>(null)

  // ═══════════════════════════════════════════════════════
  // COMPUTED PROPERTIES
  // ═══════════════════════════════════════════════════════

  const sortedPools = computed(() => {
    const now = Date.now()
    return [...pools.value].sort((a, b) => {
      const statusA = poolStatusKey(a)
      const statusB = poolStatusKey(b)
      if (statusA !== statusB) {
        return poolPriorityMap[statusA] - poolPriorityMap[statusB]
      }
      if (statusA === 'upcoming') {
        const startA = toTimestamp(a.startsAt)
        const startB = toTimestamp(b.startsAt)
        if (startA !== startB) {
          if (startA == null) return 1
          if (startB == null) return -1
          return startA - startB
        }
      }
      if (statusA === 'ended') {
        const endA = toTimestamp(a.endsAt)
        const endB = toTimestamp(b.endsAt)
        if (endA !== endB) {
          if (endA == null) return 1
          if (endB == null) return -1
          return endB - endA
        }
      }
      const startA = toTimestamp(a.startsAt) ?? now
      const startB = toTimestamp(b.startsAt) ?? now
      if (startA !== startB) {
        return startB - startA
      }
      return a.name.localeCompare(b.name, 'zh-CN')
    })
  })

  const poolRangeMap = computed(() => {
    const map: Record<string, { start: string; end: string; label: string }> = {}
    pools.value.forEach((pool) => {
      map[pool.id] = resolvePoolRange(pool)
    })
    return map
  })

  const currentPool = computed<GachaPool | null>(() => {
    if (!pools.value.length) return null
    if (selectedPoolId.value) {
      return pools.value.find((pool) => pool.id === selectedPoolId.value) ?? null
    }
    return pools.value[0] ?? null
  })

  const walletBalance = computed(() => {
    const raw = Number(gachaState.value.wallet?.balance ?? 0)
    if (!Number.isFinite(raw)) return 0
    return Math.max(0, Math.floor(raw))
  })

  function resolveAutoDrawTokenCost(count: number, pool?: GachaPool | null) {
    const targetPool = pool ?? currentPool.value
    if (!targetPool) return Number.POSITIVE_INFINITY
    const singleCost = Math.max(0, Math.floor(Number(targetPool.tokenCost ?? 0)))
    const tenCost = Math.max(0, Math.floor(Number(targetPool.tenDrawCost ?? singleCost * 10)))
    if (count === 1) {
      return tickets.value.drawTicket > 0 ? 0 : singleCost
    }
    if (count === 10) {
      if (tickets.value.draw10Ticket > 0) return 0
      const drawTicketUsed = Math.max(0, Math.min(10, Math.floor(Number(tickets.value.drawTicket ?? 0))))
      if (drawTicketUsed <= 0) return tenCost
      return Math.max(0, tenCost - (drawTicketUsed * singleCost))
    }
    return Math.max(0, singleCost * count)
  }

  function canAutoDraw(count: number, pool?: GachaPool | null) {
    const targetPool = pool ?? currentPool.value
    if (!targetPool || !targetPool.isActive) return false
    const requiredToken = resolveAutoDrawTokenCost(count, targetPool)
    return walletBalance.value >= requiredToken
  }

  const canDrawSingle = computed(() => canAutoDraw(1))
  const canDrawTen = computed(() => canAutoDraw(10))
  const canDrawAgain = computed(() => {
    if (drawing.value || ticketAction.value) return false
    if (!currentPool.value?.isActive) return false
    const repeatMode = lastDrawRepeatMode.value
    if (repeatMode === 'DRAW_TICKET') {
      return tickets.value.drawTicket > 0
    }
    if (repeatMode === 'DRAW10_TICKET') {
      return tickets.value.draw10Ticket > 0
    }
    return canAutoDraw(lastDrawCount.value)
  })

  // ═══════════════════════════════════════════════════════
  // HELPER FUNCTIONS
  // ═══════════════════════════════════════════════════════

  function selectPool(poolId: string) {
    selectedPoolId.value = poolId
  }

  function reforgeStackKey(
    cardId: string,
    source: Pick<InventoryItem, 'affixSignature' | 'affixVisualStyle' | 'affixStyles' | 'affixStyleCounts'>
  ) {
    return `${cardId}::${resolveAffixSignatureFromSource(source)}`
  }

  function queueAuthorHydration(ids: Array<number | null | undefined>) {
    ids.forEach((value) => {
      const id = Number(value)
      if (!Number.isFinite(id) || id <= 0) return
      drawAuthorQueue.add(id)
    })
    if (!drawAuthorQueue.size || drawAuthorQueueTimer) return
    drawAuthorQueueTimer = setTimeout(() => {
      drawAuthorQueueTimer = null
      const batch = Array.from(drawAuthorQueue)
      drawAuthorQueue.clear()
      void pageAuthors.ensureAuthors(batch)
    }, 80)
  }

  function seedAuthorCacheFromInventory(items: InventoryItem[]) {
    for (const item of items) {
      pageAuthors.seedAuthors(item.wikidotId ?? null, item.authors ?? null)
    }
  }

  function seedAuthorCacheFromDrawResult(result: DrawResult | null | undefined) {
    for (const item of result?.items ?? []) {
      pageAuthors.seedAuthors(item.wikidotId ?? null, item.authors ?? null)
    }
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
      const res = await gacha.getHistory({ poolId: currentPool.value?.id, limit: 8 })
      if (res.ok) {
        history.value = res.data ?? []
      }
    } catch (error) {
      console.warn('[gacha] load history failed', error)
    }
  }

  async function refreshTicketsPanel() {
    if (!activated.value) {
      tickets.value = emptyTickets()
      reforgeCardOptions.value = []
      reforgeCardId.value = ''
      lastReforgeResult.value = null
      return
    }
    ticketsLoading.value = true
    try {
      const res = await gacha.getTickets()
      if (!res.ok) {
        emitError(res.error || '加载票券失败')
        return
      }
      tickets.value = normalizeTickets(res.tickets)
    } catch (error: unknown) {
      emitError(normalizeError(error, '加载票券失败'))
    } finally {
      ticketsLoading.value = false
    }
  }

  function sortReforgeOptions(items: Iterable<ReforgeCardOption>): ReforgeCardOption[] {
    return Array.from(items).sort((a, b) => {
      const rarityDiff = (raritySortWeight[a.rarity] ?? 99) - (raritySortWeight[b.rarity] ?? 99)
      if (rarityDiff !== 0) return rarityDiff
      if (a.count !== b.count) return b.count - a.count
      const titleDiff = a.title.localeCompare(b.title, 'zh-CN')
      if (titleDiff !== 0) return titleDiff
      return a.stackKey.localeCompare(b.stackKey, 'zh-CN')
    })
  }

  // 改造开始时调用：自增序号（让 fetch 中途启动的全量刷新落地时识别"期间发生了改造"并丢弃），
  // 标记 in-flight（让此刻已在飞行的全量刷新放弃落地），并取消尚未触发的对账。
  function beginReforgeMutation() {
    reforgeMutationSeq++
    reforgeMutationInFlight++
    if (reforgeReconcileTimer) {
      clearTimeout(reforgeReconcileTimer)
      reforgeReconcileTimer = null
    }
  }

  // 改造结束时调用（成功或失败的 finally）。
  function endReforgeMutation() {
    reforgeMutationInFlight = Math.max(0, reforgeMutationInFlight - 1)
  }

  // 改造后本地乐观增量：改造把一张卡的一个实例从 before 词条变成 after 词条（服务端 -1/+1）。
  // 不再为反映这一处变化而全量重拉 + 重聚合整库存（重库存用户单次数秒），直接 patch 本地分组：
  // before 分组 -1（归零则移除），after 分组 +1（不存在则用同卡的卡面元数据克隆一份）。
  // 产生的 stackKey 与全量刷新完全一致（reforgeStackKey = cardId::resolveAffixSignatureFromSource）。
  // 返回新选中项的 stackKey（用于"再来一次"链式改造）；若 after 未并入列表（不符筛选或无模板）则返回 null。
  function applyReforgeResultLocally(result: NonNullable<TicketUseResult['result']>): string | null {
    const cardId = result.cardId
    if (!cardId) return null
    const beforeSig = resolveAffixSignatureFromSource({ affixSignature: result.before.affixSignature })
    const afterSig = resolveAffixSignatureFromSource({ affixSignature: result.after.affixSignature })
    const beforeKey = `${cardId}::${beforeSig}`
    const afterKey = `${cardId}::${afterSig}`
    // 改造命中已放置实例时（placementUpdated），后端同步更新了放置槽词条，placedCount 需随之迁移。
    const placedDelta = result.placementUpdated ? 1 : 0
    const list = reforgeCardOptions.value.slice()

    const beforeIdx = list.findIndex((o) => o.stackKey === beforeKey)
    // 克隆 after 新项所需的卡面元数据（与词条无关）：优先用 before 项，否则退回同 cardId 的任意变体。
    const template = beforeIdx >= 0 ? list[beforeIdx] : (list.find((o) => o.cardId === cardId) ?? null)
    if (beforeIdx >= 0) {
      const prev = list[beforeIdx]
      const next = {
        ...prev,
        count: prev.count - 1,
        placedCount: Math.max(0, prev.placedCount - placedDelta)
      }
      if (next.count <= 0) list.splice(beforeIdx, 1)
      else list[beforeIdx] = next
    }

    // 仅当 after 词条符合当前筛选时才并入列表：筛选 'NONE' 时列表只含无词条变体，而改造必产出有词条
    // 变体，故不并入（与全量刷新在该筛选下的结果一致）。
    const filter = reforgeAffixFilter.value || ''
    const afterMatchesFilter = !filter
      || afterSig === resolveAffixSignatureFromSource({ affixSignature: filter })
    let afterPresent = false
    if (afterMatchesFilter) {
      const afterIdx = list.findIndex((o) => o.stackKey === afterKey)
      if (afterIdx >= 0) {
        const prev = list[afterIdx]
        list[afterIdx] = { ...prev, count: prev.count + 1, placedCount: prev.placedCount + placedDelta }
        afterPresent = true
      } else if (template) {
        list.push({
          ...template,
          stackKey: afterKey,
          count: 1,
          placedCount: placedDelta,
          affixSignature: afterSig,
          // panel 仅用 affixStyles[0] 渲染视觉样式；完整数组由后续对账刷新补全。
          affixStyles: [result.after.affixVisualStyle],
          affixStyleCounts: undefined
        })
        afterPresent = true
      }
    }

    reforgeCardOptions.value = sortReforgeOptions(list)
    return afterPresent ? afterKey : null
  }

  // 停手 1.5s 后做一次服务端对账，纠正本地增量可能的细微漂移（如多端并发、affixStyles 完整数组）。
  // 用尾部去抖 + 序号守卫而非每次改造都后台刷新，避免连点时旧快照覆盖更新的本地 patch 造成计数闪烁。
  function scheduleReforgeReconcile() {
    if (reforgeReconcileTimer) clearTimeout(reforgeReconcileTimer)
    reforgeReconcileTimer = setTimeout(() => {
      reforgeReconcileTimer = null
      refreshReforgeCardOptions(true).catch((error) => {
        console.warn('[gacha] reforge reconcile failed', error)
      })
    }, 1500)
  }

  async function refreshReforgeCardOptions(force = false) {
    if (!activated.value) {
      reforgeCardOptions.value = []
      reforgeCardId.value = ''
      reforgeOptionsReloadQueued.value = false
      reforgeOptionsFullyLoaded.value = true
      return
    }
    // 改造进行中：放弃这次全量刷新（其快照可能与随后到达的本地 patch 叠加成双重计数），
    // 改由改造完成后的对账补刷。覆盖"刷新启动时已有改造在飞行"的竞态（与落地处的序号守卫互补）。
    if (reforgeMutationInFlight > 0) {
      scheduleReforgeReconcile()
      return
    }
    // Freshness check: skip reload if data was loaded recently with same filter
    const currentFilter = reforgeAffixFilter.value || ''
    if (!force && reforgeOptionsFullyLoaded.value
        && currentFilter === reforgeLoadedFilter
        && Date.now() - reforgeLoadedAt < 60_000) {
      return
    }
    if (reforgeOptionsLoading.value) {
      reforgeOptionsReloadQueued.value = true
      return
    }
    reforgeOptionsLoading.value = true
    reforgeOptionsFullyLoaded.value = false
    reforgeOptionsReloadQueued.value = false
    const requestedAffixFilter = currentFilter
    // 捕获起始序号：若 fetch 期间发生任何改造（序号变化），落地时丢弃这次（可能已陈旧）的全量结果，
    // 保留更准的本地 patch；后续对账会再刷一次。
    const seqAtStart = reforgeMutationSeq
    try {
      // Fetch placement data in parallel for placedCount marking
      const placementPromise = gacha.getPlacement().then((res) => {
        const placedCountMap = new Map<string, number>()
        if (!res.ok || !res.data) return placedCountMap
        for (const slot of res.data.slots ?? []) {
          if (!slot.card?.id) continue
          const key = reforgeStackKey(slot.card.id, {
            affixSignature: slot.card.affixSignature,
            affixVisualStyle: slot.card.affixVisualStyle,
            affixStyles: slot.card.affixStyles,
            affixStyleCounts: slot.card.affixStyleCounts
          })
          placedCountMap.set(key, (placedCountMap.get(key) ?? 0) + 1)
        }
        for (const addon of res.data.addons ?? []) {
          if (!addon.card?.id) continue
          const key = reforgeStackKey(addon.card.id, {
            affixSignature: addon.card.affixSignature,
            affixVisualStyle: addon.card.affixVisualStyle,
            affixStyles: addon.card.affixStyles,
            affixStyleCounts: addon.card.affixStyleCounts
          })
          placedCountMap.set(key, (placedCountMap.get(key) ?? 0) + 1)
        }
        return placedCountMap
      }).catch(() => new Map<string, number>())

      const activeAffixFilter = reforgeAffixFilter.value || undefined
      // 单次全量取尽(all=1)：后端一次扫描+排序+聚合返回全部库存。安全上限远高于卡牌定义总数，
      // 故按稀有度排序也绝不会在紫卡区间截断(保持 #129 的紫卡可检索保证)，同时消除逐页 offset
      // 重扫的近二次成本(#95)。
      const res = await gacha.getInventory({ all: true, skipTotal: true, affixFilter: activeAffixFilter })
      if (!res.ok) throw new Error(res.error || '加载改造候选卡片失败')
      const allItems: InventoryItem[] = res.data ?? []
      seedAuthorCacheFromInventory(allItems)
      queueAuthorHydration(allItems.map((item) => item.wikidotId))
      const grouped = new Map<string, ReforgeCardOption>()

      allItems.forEach((item: InventoryItem) => {
          const count = Math.max(0, Math.floor(Number(item.count ?? 0)))
          if (count <= 0) return
          const affixSignature = resolveAffixSignatureFromSource(item)
          const stackKey = reforgeStackKey(item.cardId, item)
          const existing = grouped.get(stackKey)
          if (!existing) {
            grouped.set(stackKey, {
              stackKey,
              cardId: item.cardId,
              title: displayCardTitle(item.title),
              rarity: item.rarity,
              imageUrl: item.imageUrl ?? null,
              isRetired: !!item.isRetired,
              wikidotId: item.wikidotId ?? null,
              tags: item.tags ?? [],
              authors: item.authors ?? null,
              count,
              placedCount: 0,
              affixSignature,
              affixStyles: item.affixStyles,
              affixStyleCounts: item.affixStyleCounts
            })
            return
          }
          existing.count += count
          if ((raritySortWeight[item.rarity] ?? 99) < (raritySortWeight[existing.rarity] ?? 99)) {
            existing.rarity = item.rarity
          }
          if (!existing.imageUrl && item.imageUrl) {
            existing.imageUrl = item.imageUrl
          }
          if (!existing.isRetired && item.isRetired) {
            existing.isRetired = true
          }
          if (existing.wikidotId == null && item.wikidotId != null) {
            existing.wikidotId = item.wikidotId
          }
          if ((existing.tags?.length ?? 0) === 0 && (item.tags?.length ?? 0) > 0) {
            existing.tags = item.tags
          }
          if (!(existing.authors?.length) && (item.authors?.length ?? 0) > 0) {
            existing.authors = item.authors
          }
          if (!existing.title && item.title) {
            existing.title = displayCardTitle(item.title)
          }
          // Merge affix style counts from multiple inventory rows
          if (item.affixStyleCounts) {
            if (!existing.affixStyleCounts) {
              existing.affixStyleCounts = { ...item.affixStyleCounts }
            } else {
              for (const [style, cnt] of Object.entries(item.affixStyleCounts)) {
                const key = style as AffixVisualStyle
                existing.affixStyleCounts[key] = (existing.affixStyleCounts[key] ?? 0) + (cnt ?? 0)
              }
            }
          }
          if (item.affixStyles?.length && !existing.affixStyles?.length) {
            existing.affixStyles = item.affixStyles
          }
          if (!existing.affixSignature || existing.affixSignature === 'NONE') {
            existing.affixSignature = affixSignature
          }
        })

      // Merge placement data, then sort and emit once
      const placedCountMap = await placementPromise
      if (placedCountMap.size > 0) {
        for (const option of grouped.values()) {
          option.placedCount = Math.max(0, Number(placedCountMap.get(option.stackKey) ?? 0))
        }
      }
      const nextOptions = sortReforgeOptions(grouped.values())
      // 期间发生过改造 → 本地 patch 已更新且更准，丢弃这次全量结果，避免旧快照覆盖。
      if (reforgeMutationSeq === seqAtStart) {
        reforgeCardOptions.value = nextOptions
        if (reforgeCardId.value && !nextOptions.some((item) => item.stackKey === reforgeCardId.value)) {
          reforgeCardId.value = ''
        }
        reforgeLoadedAt = Date.now()
        reforgeLoadedFilter = requestedAffixFilter
      }
    } catch (error: unknown) {
      emitError(normalizeError(error, '加载改造候选卡片失败'))
    } finally {
      reforgeOptionsLoading.value = false
      reforgeOptionsFullyLoaded.value = true
      const activeAffixFilter = reforgeAffixFilter.value || ''
      if (reforgeOptionsReloadQueued.value || activeAffixFilter !== requestedAffixFilter) {
        reforgeOptionsReloadQueued.value = false
        refreshReforgeCardOptions().catch((error) => {
          console.warn('[gacha] reforge options refresh retry failed', error)
        })
      }
    }
  }

  // ═══════════════════════════════════════════════════════
  // ACTION HANDLERS
  // ═══════════════════════════════════════════════════════

  // ─── Config ───────────────────────────────────────────

  async function refreshConfig(force = false) {
    loadingConfig.value = true
    try {
      const res = await gacha.getConfig(force)
      if (res.ok && res.data) {
        activated.value = !!res.data.activated
        pools.value = res.data.pools ?? []
        if (!selectedPoolId.value && pools.value.length > 0) {
          const activePool = pools.value.find((pool) => pool.isActive)
          selectedPoolId.value = activePool?.id ?? pools.value[0].id
        }
        if (res.data.boosts) {
          boosts.value = res.data.boosts.filter((boost) => boost.isActive)
        }
        if (!activated.value) {
          tickets.value = emptyTickets()
          lastReforgeResult.value = null
        }
      }
      const boostRes = await gacha.listGlobalBoosts({ active: true })
      if (boostRes.ok) {
        boosts.value = boostRes.data ?? []
      }
    } catch (error) {
      console.warn('[gacha] refresh config failed', error)
    } finally {
      loadingConfig.value = false
    }
  }

  // ─── Activation ───────────────────────────────────────

  async function handleActivate() {
    const result = await page.handleActivate()
    if (result.ok) {
      activated.value = true
    }
    return result
  }

  // ─── Draw ─────────────────────────────────────────────

  async function handleDraw(count: number, poolId?: string) {
    if (drawing.value) return
    if (poolId && poolId !== selectedPoolId.value) {
      selectedPoolId.value = poolId
    }
    const pool = poolId
      ? pools.value.find((item) => item.id === poolId) ?? null
      : currentPool.value
    if (!pool) {
      emitError('没有可用的卡池')
      return
    }
    if (!pool.isActive) {
      emitError('卡池尚未开放')
      return
    }
    if (!canAutoDraw(count, pool)) {
      emitError('Token 余额不足')
      return
    }
    drawing.value = true
    lastDrawCount.value = count
    lastDrawRepeatMode.value = 'AUTO'
    try {
      const drawRes = await gacha.draw({
        poolId: pool.id,
        count,
        paymentMethod: 'AUTO'
      })
      if (!drawRes.ok || !drawRes.data) {
        emitError(drawRes.error || '抽卡失败')
        return
      }

      const drawData: DrawResult = drawRes.data
      seedAuthorCacheFromDrawResult(drawData)
      queueAuthorHydration(drawData.items.map((item) => item.wikidotId))
      if (drawRes.paymentMethod && drawRes.paymentMethod !== 'TOKEN') {
        tickets.value = normalizeTickets(drawRes.tickets)
      }

      lastResult.value = drawData
      resultModalOpen.value = true
      if (drawData.wallet) {
        gachaState.value.wallet = drawData.wallet
        gachaState.value.walletFetchedAt = new Date().toISOString()
      } else {
        await gacha.getWallet(true)
      }
      void Promise.allSettled([
        refreshHistory(),
        refreshTicketsPanel()
      ]).catch((error) => {
        console.warn('[gacha] draw refresh failed', error)
      })
    } catch (error: unknown) {
      emitError(normalizeError(error, '抽卡失败'))
    } finally {
      drawing.value = false
    }
  }

  function drawAgain() {
    if (!canDrawAgain.value) {
      const repeatMode = lastDrawRepeatMode.value
      if (repeatMode === 'DRAW_TICKET') {
        emitError('单抽券已用完')
      } else if (repeatMode === 'DRAW10_TICKET') {
        emitError('十连券已用完')
      } else {
        emitError('Token 余额不足')
      }
      return
    }
    resultModalOpen.value = false
    const count = lastDrawCount.value
    const repeatMode = lastDrawRepeatMode.value
    setTimeout(() => {
      if (repeatMode === 'DRAW_TICKET') {
        if (tickets.value.drawTicket <= 0) {
          emitError('单抽券已用完')
          return
        }
        void handleTicketDraw(1)
        return
      }
      if (repeatMode === 'DRAW10_TICKET') {
        if (tickets.value.draw10Ticket <= 0) {
          emitError('十连券已用完')
          return
        }
        void handleTicketDraw(10)
        return
      }
      void handleDraw(count)
    }, 260)
  }

  function closeResultModal() {
    resultModalOpen.value = false
  }

  // ─── Ticket Handlers ──────────────────────────────────

  async function handleTicketDraw(mode: 1 | 10) {
    if (ticketAction.value) return
    ticketAction.value = mode === 1 ? 'draw' : 'draw10'
    lastDrawCount.value = mode
    lastDrawRepeatMode.value = mode === 1 ? 'DRAW_TICKET' : 'DRAW10_TICKET'
    try {
      const res = mode === 1 ? await gacha.useDrawTicket() : await gacha.useDraw10Ticket()
      if (!res.ok) {
        emitError(res.error || '使用票券失败')
        return
      }
      tickets.value = normalizeTickets(res.tickets)
      if (res.data) {
        seedAuthorCacheFromDrawResult(res.data)
        queueAuthorHydration(res.data.items.map((item) => item.wikidotId))
        lastResult.value = res.data
        resultModalOpen.value = true
        if (res.data.wallet) {
          handleWalletUpdated(res.data.wallet)
        }
      }
      void Promise.allSettled([
        refreshHistory()
      ]).catch((error) => {
        console.warn('[gacha] ticket draw refresh failed', error)
      })
    } catch (error: unknown) {
      emitError(normalizeError(error, '使用票券失败'))
    } finally {
      ticketAction.value = null
    }
  }

  async function handleAffixReforgeTicketUse() {
    if (ticketAction.value) return
    ticketAction.value = 'reforge'
    beginReforgeMutation()
    try {
      const selected = selectedReforgeCardOption.value
      const res = await gacha.useAffixReforgeTicket(
        selected?.cardId || undefined,
        selected?.affixSignature || undefined
      )
      if (!res.ok) {
        emitError(res.error || '使用改造券失败')
        return
      }
      tickets.value = normalizeTickets(res.tickets)
      lastReforgeResult.value = res.result ?? null
      // 与 confirmReforge 一致：本地乐观增量，替代全量重拉；对账统一在 finally 兜底排程。
      if (res.result) {
        const nextKey = applyReforgeResultLocally(res.result)
        reforgeCardId.value = nextKey ?? ''
      }
    } catch (error: unknown) {
      emitError(normalizeError(error, '使用改造券失败'))
    } finally {
      endReforgeMutation()
      // 无论成功/失败/无 result，都排一次尾部对账：补回 begin 时被清掉的上一次对账、
      // 以及失败路径下被 seq/in-flight 守卫丢弃的刷新，避免刷新被饿死。
      scheduleReforgeReconcile()
      ticketAction.value = null
    }
  }

  // ─── Reforge Modal Handlers ─────────────────────────

  function openReforgeModal() {
    reforgeModalPhase.value = 'confirm'
    lastReforgeResult.value = null
    reforgeModalOpen.value = true
  }

  function closeReforgeModal() {
    reforgeModalOpen.value = false
  }

  async function reforgeAgain() {
    await confirmReforge()
  }

  async function confirmReforge() {
    if (reforgeConfirming.value) return
    reforgeConfirming.value = true
    beginReforgeMutation()
    try {
      const selected = selectedReforgeCardOption.value
      const res = await gacha.useAffixReforgeTicket(
        selected?.cardId || undefined,
        selected?.affixSignature || undefined
      )
      if (!res.ok) {
        emitError(res.error || '使用改造券失败')
        reforgeModalOpen.value = false
        return
      }
      tickets.value = normalizeTickets(res.tickets)
      lastReforgeResult.value = res.result ?? null
      reforgeModalPhase.value = 'result'
      // 本地乐观增量（瞬时返回），并把选中项切到新词条以支持"再来一次"链式改造；
      // 不再同步全量重拉库存（重库存用户此处曾卡数秒）。对账统一在 finally 兜底排程。
      if (res.result) {
        const nextKey = applyReforgeResultLocally(res.result)
        reforgeCardId.value = nextKey ?? ''
      }
    } catch (error: unknown) {
      emitError(normalizeError(error, '使用改造券失败'))
      reforgeModalOpen.value = false
    } finally {
      endReforgeMutation()
      // 无论成功/失败，都排一次尾部对账：补回 begin 时被清掉的上一次对账、以及失败路径下
      // 被 seq/in-flight 守卫丢弃的刷新，避免刷新被饿死。
      scheduleReforgeReconcile()
      reforgeConfirming.value = false
    }
  }

  // ═══════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════

  async function loadInitial() {
    // Wallet/featureStatus 已由 useGachaPage 统一加载
    await refreshConfig(true)
    await Promise.allSettled([refreshHistory(), refreshTicketsPanel()])
  }

  // ═══════════════════════════════════════════════════════
  // WATCHERS
  // ═══════════════════════════════════════════════════════

  watch(selectedPoolId, () => {
    refreshHistory().catch((error) => {
      console.warn('[gacha] history refresh failed', error)
    })
  })

  watch(reforgeAffixFilter, () => {
    if (activated.value) {
      refreshReforgeCardOptions()
    }
  })

  // ═══════════════════════════════════════════════════════
  // RETURN
  // ═══════════════════════════════════════════════════════

  return {
    // Balance ref (for template binding)
    balanceRef,

    // Config / Pools / Boosts
    pools,
    selectedPoolId,
    boosts,
    loadingConfig,
    refreshConfig,

    // Draw state
    drawing,
    lastResult,
    resultModalOpen,
    canDrawSingle,
    canDrawTen,
    canDrawAgain,
    handleDraw,
    drawAgain,
    closeResultModal,

    // Activation
    handleActivate,

    // Computed pools
    sortedPools,
    poolRangeMap,
    currentPool,
    selectPool,

    // History
    history,
    refreshHistory,

    // Tickets state
    tickets,
    ticketsLoading,
    ticketAction,
    reforgeCardId,
    reforgeCardOptions,
    reforgeOptionsLoading,
    reforgeOptionsFullyLoaded,
    reforgeAffixFilter,
    lastReforgeResult,

    // Ticket handlers
    refreshTicketsPanel,
    refreshReforgeCardOptions,
    handleTicketDraw,
    handleAffixReforgeTicketUse,

    // Reforge modal
    reforgeModalOpen,
    reforgeModalPhase,
    reforgeConfirming,
    selectedReforgeCardOption,
    openReforgeModal,
    closeReforgeModal,
    reforgeAgain,
    confirmReforge,

    // Lifecycle
    loadInitial,

    // Cleanup (call from onBeforeUnmount)
    cleanup: () => {
      if (drawAuthorQueueTimer) {
        clearTimeout(drawAuthorQueueTimer)
        drawAuthorQueueTimer = null
      }
      if (reforgeReconcileTimer) {
        clearTimeout(reforgeReconcileTimer)
        reforgeReconcileTimer = null
      }
      drawAuthorQueue.clear()
    },

    // Wallet utility
    handleWalletUpdated
  }
}
