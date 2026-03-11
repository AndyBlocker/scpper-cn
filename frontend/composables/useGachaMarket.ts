import { computed, ref, watch } from 'vue'
import type { GachaPageContext } from '~/composables/useGachaPage'
import type {
  HistoryItem,
  MarketCandle,
  MarketContract,
  MarketLockTier,
  MarketLockTierMeta,
  MarketOpponentSnapshot,
  MarketPosition,
  MarketPositionMarker,
  MarketPositionSide,
  MarketSettlement,
  MarketTick,
  MarketTickDiagnostics,
  TicketBalance
} from '~/types/gacha'
import {
  formatLagDuration,
  normalizeTickets,
  emptyTickets
} from '~/utils/gachaFormatters'
import {
  fallbackMarketLockTierMeta,
  type MarketLockTierViewMeta
} from '~/utils/gachaConstants'
import { normalizeError } from '~/composables/api/gachaCore'

/**
 * market.vue (gacha market page) 的状态管理和业务逻辑。
 * 从 useGachaIndex 中提取所有 market 相关 state + handlers。
 */
export function useGachaMarket(page: GachaPageContext) {
  const { gacha, activated, emitError, handleWalletUpdated } = page

  // ─── Market State ─────────────────────────────────────
  const marketContracts = ref<MarketContract[]>([])
  const selectedMarketContractId = ref<string | null>(null)
  const marketLockTierConfig = ref<Partial<Record<MarketLockTier, MarketLockTierMeta>>>({})
  const marketTicks = ref<MarketTick[]>([])
  const marketCandles = ref<MarketCandle[]>([])
  const marketMarkers = ref<MarketPositionMarker[]>([])
  const marketTickDiagnostics = ref<MarketTickDiagnostics | null>(null)
  const marketPositions = ref<MarketPosition[]>([])
  const marketSettlements = ref<MarketSettlement[]>([])
  const marketSettlementSummary = ref<{ total: number; pnl: number } | null>(null)
  const marketOpponents = ref<MarketOpponentSnapshot | null>(null)
  const marketLoading = ref(false)
  const marketOpening = ref(false)
  const marketSide = ref<MarketPositionSide>('LONG')
  const marketLockTier = ref<MarketLockTier>('T1')
  const marketTimeframe = ref<'24H' | '7D' | '30D'>('24H')
  const marketStake = ref<number>(120)
  const marketLeverage = ref<number>(2)

  // ─── History (for StatusBar) ────────────────────────────
  const history = ref<HistoryItem[]>([])

  // ─── Tickets State (lightweight, for post-open-position) ─
  const tickets = ref<TicketBalance>(emptyTickets())
  const ticketsLoading = ref(false)

  // ─── Internal Flags ─────────────────────────────────────
  let marketRefreshPending = false
  let suppressMarketContractWatch = false

  // ─── Placement (read-only from page gacha state) ────────
  const placement = computed(() => page.gacha.state.value.placement)

  // ═══════════════════════════════════════════════════════
  // COMPUTED PROPERTIES
  // ═══════════════════════════════════════════════════════

  const selectedMarketContract = computed<MarketContract | null>(() => {
    if (!marketContracts.value.length) return null
    if (selectedMarketContractId.value) {
      return marketContracts.value.find((item) => item.id === selectedMarketContractId.value) ?? marketContracts.value[0]
    }
    return marketContracts.value[0]
  })

  const marketLatestTickPrice = computed(() => {
    if (marketTicks.value.length === 0) {
      return selectedMarketContract.value?.latestPrice ?? 0
    }
    return Number(marketTicks.value[marketTicks.value.length - 1]?.price ?? 0)
  })

  const marketUnrealizedTotal = computed(() => (
    marketPositions.value.reduce((sum, item) => sum + Number(item.unrealizedPnl ?? 0), 0)
  ))

  const marketLongShortMarginTotal = computed(() => Number(marketOpponents.value?.longMargin ?? 0) + Number(marketOpponents.value?.shortMargin ?? 0))

  const marketLongMarginPercent = computed(() => {
    const total = marketLongShortMarginTotal.value
    if (total <= 0) return 50
    return Math.max(6, Math.min(94, (Number(marketOpponents.value?.longMargin ?? 0) / total) * 100))
  })

  const marketShortMarginPercent = computed(() => {
    const total = marketLongShortMarginTotal.value
    if (total <= 0) return 50
    return Math.max(6, Math.min(94, (Number(marketOpponents.value?.shortMargin ?? 0) / total) * 100))
  })

  const marketTimeframeOptions = [
    { value: '24H' as const, label: '今日', shortLabel: '日内', openLabel: '今日开盘' },
    { value: '7D' as const, label: '7日', shortLabel: '7日', openLabel: '7日前' },
    { value: '30D' as const, label: '30日', shortLabel: '30日', openLabel: '30日前' }
  ]

  const marketTimeframeLabel = computed(() => marketTimeframeOptions.find((item) => item.value === marketTimeframe.value)?.label ?? '今日')

  const marketChangeBasisLabel = computed(() => marketTimeframeOptions.find((item) => item.value === marketTimeframe.value)?.label ?? '今日')

  const marketChangeBasisShortLabel = computed(() => marketTimeframeOptions.find((item) => item.value === marketTimeframe.value)?.shortLabel ?? '日内')

  const marketOpenLabel = computed(() => marketTimeframeOptions.find((item) => item.value === marketTimeframe.value)?.openLabel ?? '今日开盘')

  const marketDataStatusLevel = computed<'ok' | 'lagging' | 'stale'>(() => (
    marketTickDiagnostics.value?.staleLevel ?? 'ok'
  ))

  const marketDataStatusLabel = computed(() => {
    if (marketDataStatusLevel.value === 'stale') return '数据滞后'
    if (marketDataStatusLevel.value === 'lagging') return '数据偏慢'
    return '数据正常'
  })

  const marketDataStatusClass = computed(() => {
    if (marketDataStatusLevel.value === 'stale') {
      return 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200'
    }
    if (marketDataStatusLevel.value === 'lagging') {
      return 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200'
    }
    return 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200'
  })

  const marketLatestTickAsOfTs = computed(() => (
    marketTickDiagnostics.value?.latestTickAsOfTs
    || marketTicks.value[marketTicks.value.length - 1]?.asOfTs
    || marketTicks.value[marketTicks.value.length - 1]?.ts
    || null
  ))

  const marketLatestWatermarkTs = computed(() => (
    marketTickDiagnostics.value?.latestWatermarkTs
    || marketTicks.value[marketTicks.value.length - 1]?.watermarkTs
    || null
  ))

  const marketLatestVoteCutoffDate = computed(() => (
    marketTickDiagnostics.value?.latestVoteCutoffDate
    || marketTicks.value[marketTicks.value.length - 1]?.voteCutoffDate
    || null
  ))

  const marketTickLagLabel = computed(() => formatLagDuration(marketTickDiagnostics.value?.tickLagMs))

  const marketWatermarkLagLabel = computed(() => formatLagDuration(marketTickDiagnostics.value?.watermarkLagMs))

  const marketLatestCrowdDrag = computed(() => {
    const ticks = marketTicks.value
    if (!ticks.length) return 0
    return Number(ticks[ticks.length - 1]?.crowdDrag ?? 0)
  })

  const marketLockTierMeta = computed<Record<MarketLockTier, MarketLockTierViewMeta>>(() => {
    const output = { ...fallbackMarketLockTierMeta }
    ;(Object.keys(output) as MarketLockTier[]).forEach((lockTier) => {
      const remote = marketLockTierConfig.value[lockTier]
      if (!remote) return
      const minStake = Math.max(remote.minLots * remote.lotToken, remote.lotToken)
      output[lockTier] = {
        ...output[lockTier],
        minLots: remote.minLots,
        leverageOptions: remote.leverageOptions?.length ? remote.leverageOptions : output[lockTier].leverageOptions,
        durationLabel: `${remote.durationHours} 小时`,
        stakePreset: [minStake, minStake * 2, minStake * 5, minStake * 10],
        openFeeBaseRate: Number(remote.openFeeBaseRate ?? output[lockTier].openFeeBaseRate)
      }
    })
    return output
  })

  const marketTierMeta = computed(() => marketLockTierMeta.value[marketLockTier.value])

  const marketLeverageOptions = computed(() => marketTierMeta.value.leverageOptions)

  const marketStakePreset = computed(() => marketTierMeta.value.stakePreset)

  const marketMinStake = computed(() => marketTierMeta.value.minLots * 10)

  const marketEstimatedLots = computed(() => Math.max(0, Math.floor(Number(marketStake.value || 0) / 10)))

  const marketEstimatedOpenFee = computed(() => {
    const stake = Number(marketStake.value || 0)
    if (!Number.isFinite(stake) || stake <= 0) return 0
    const leverage = Number(marketLeverage.value || 0)
    const leverageSurchargeMap: Record<number, number> = {
      1: 0,
      2: 0.002,
      5: 0.008,
      10: 0.018,
      20: 0.04,
      50: 0.1,
      100: 0.22
    }
    const feeRate = Number(marketTierMeta.value.openFeeBaseRate || 0) + (leverageSurchargeMap[leverage] ?? 0)
    return Math.floor(stake * feeRate)
  })

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

  async function refreshTicketsPanel() {
    if (!activated.value) {
      tickets.value = emptyTickets()
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

  // ─── Market Refresh Handlers ──────────────────────────

  async function refreshMarketContractsPanel() {
    if (!activated.value) {
      marketContracts.value = []
      selectedMarketContractId.value = null
      marketLockTierConfig.value = {}
      marketTickDiagnostics.value = null
      marketCandles.value = []
      marketMarkers.value = []
      return
    }
    const res = await gacha.getMarketContracts({ timeframe: marketTimeframe.value })
    if (!res.ok) {
      emitError(res.error || '加载市场合约失败')
      return
    }
    marketContracts.value = res.data ?? []
    const nextTierConfig: Partial<Record<MarketLockTier, MarketLockTierMeta>> = {}
    for (const tier of res.lockTiers ?? []) {
      nextTierConfig[tier.lockTier] = tier
    }
    marketLockTierConfig.value = nextTierConfig
    if (!selectedMarketContractId.value || !marketContracts.value.some((item) => item.id === selectedMarketContractId.value)) {
      suppressMarketContractWatch = true
      selectedMarketContractId.value = marketContracts.value[0]?.id ?? null
      // watch callbacks run async; release suppression in next microtask.
      Promise.resolve().then(() => {
        suppressMarketContractWatch = false
      })
    }
  }

  async function refreshMarketTicksPanel() {
    const contract = selectedMarketContract.value
    if (!activated.value || !contract) {
      marketTicks.value = []
      marketTickDiagnostics.value = null
      marketCandles.value = []
      marketMarkers.value = []
      return
    }
    const res = await gacha.getMarketTicks({
      category: contract.category || contract.id,
      timeframe: marketTimeframe.value
    })
    if (!res.ok) {
      marketTickDiagnostics.value = null
      emitError(res.error || '加载市场价格失败')
      return
    }
    marketTicks.value = res.data ?? []
    marketTickDiagnostics.value = res.diagnostics ?? null
    marketCandles.value = res.candles ?? []
    marketMarkers.value = res.markers ?? []
    if (res.contract) {
      const index = marketContracts.value.findIndex((item) => item.id === res.contract?.id)
      if (index >= 0) {
        marketContracts.value[index] = res.contract
      }
    }
  }

  async function refreshMarketPositionsPanel() {
    if (!activated.value) {
      marketPositions.value = []
      return
    }
    const res = await gacha.getMarketPositions()
    if (!res.ok) {
      emitError(res.error || '加载持仓失败')
      return
    }
    if (res.wallet) {
      handleWalletUpdated(res.wallet)
    }
    marketPositions.value = res.data ?? []
  }

  async function refreshMarketSettlementsPanel() {
    if (!activated.value) {
      marketSettlements.value = []
      marketSettlementSummary.value = null
      return
    }
    const res = await gacha.getMarketSettlements(24)
    if (!res.ok) {
      emitError(res.error || '加载结算记录失败')
      return
    }
    marketSettlements.value = res.data ?? []
    marketSettlementSummary.value = res.summary ?? null
  }

  async function refreshMarketOpponentsPanel() {
    if (!activated.value) {
      marketOpponents.value = null
      return
    }
    const contract = selectedMarketContract.value
    const res = await gacha.getMarketOpponents({
      category: contract?.category || contract?.id,
      lockTier: marketLockTier.value
    })
    if (!res.ok) {
      emitError(res.error || '加载市场榜单失败')
      return
    }
    marketOpponents.value = res.data ?? null
  }

  async function refreshMarketPanel() {
    if (marketLoading.value) {
      marketRefreshPending = true
      return
    }
    marketLoading.value = true
    try {
      do {
        marketRefreshPending = false
        await refreshMarketContractsPanel()
        await Promise.allSettled([
          refreshMarketPositionsPanel(),
          refreshMarketSettlementsPanel(),
          refreshMarketOpponentsPanel(),
          refreshMarketTicksPanel()
        ])
      } while (marketRefreshPending)
    } finally {
      marketLoading.value = false
    }
  }

  // ═══════════════════════════════════════════════════════
  // ACTION HANDLERS
  // ═══════════════════════════════════════════════════════

  async function handleOpenMarketPosition() {
    if (marketOpening.value) return
    const contract = selectedMarketContract.value
    if (!contract) {
      emitError('当前没有可交易合约')
      return
    }
    const stake = Number(marketStake.value)
    const leverage = Number(marketLeverage.value)
    if (!Number.isFinite(stake) || stake < marketMinStake.value || stake > 100000) {
      emitError(`保证金需在 ${marketMinStake.value} 到 100000 之间`)
      return
    }
    if (stake % 10 !== 0) {
      emitError('保证金需为 10 的倍数（按 lots 结算）')
      return
    }
    if (!Number.isFinite(leverage) || !marketLeverageOptions.value.includes(Math.round(leverage))) {
      emitError(`当前档位仅支持 ${marketLeverageOptions.value.join('/')}x 杠杆`)
      return
    }
    const lots = Math.floor(stake / 10)
    marketOpening.value = true
    try {
      const res = await gacha.openMarketPosition({
        contractId: contract.id,
        side: marketSide.value,
        lockTier: marketLockTier.value,
        lots,
        stake: Math.round(stake),
        leverage: Math.round(leverage)
      })
      if (!res.ok) {
        emitError(res.error || '开仓失败')
        return
      }
      if (res.wallet) {
        handleWalletUpdated(res.wallet)
      }
      await Promise.allSettled([
        refreshMarketPositionsPanel(),
        refreshMarketSettlementsPanel(),
        refreshMarketTicksPanel(),
        refreshTicketsPanel()
      ])
    } catch (error: unknown) {
      emitError(normalizeError(error, '开仓失败'))
    } finally {
      marketOpening.value = false
    }
  }

  function handleSelectMarketContractFromPanel(contractId: string | null) {
    const next = String(contractId || '').trim()
    if (!next || next === selectedMarketContractId.value) return
    selectedMarketContractId.value = next
  }

  function handleChangeMarketTimeframeFromPanel(timeframe: '24H' | '7D' | '30D') {
    if (timeframe === marketTimeframe.value) return
    marketTimeframe.value = timeframe
  }

  async function handleOpenMarketPositionFromPanel(payload: {
    contractId: string
    side: MarketPositionSide
    lockTier: MarketLockTier
    stake: number
    leverage: number
  }) {
    if (marketOpening.value) return
    const stake = Number(payload.stake)
    const leverage = Number(payload.leverage)
    if (!Number.isFinite(stake) || stake <= 0 || stake > 100000) {
      emitError('保证金需在有效范围内')
      return
    }
    if (stake % 10 !== 0) {
      emitError('保证金需为 10 的倍数（按 lots 结算）')
      return
    }
    marketOpening.value = true
    try {
      const res = await gacha.openMarketPosition({
        contractId: payload.contractId,
        side: payload.side,
        lockTier: payload.lockTier,
        lots: Math.floor(stake / 10),
        stake: Math.round(stake),
        leverage: Math.round(leverage)
      })
      if (!res.ok) {
        emitError(res.error || '开仓失败')
        return
      }
      if (res.wallet) {
        handleWalletUpdated(res.wallet)
      }
      await Promise.allSettled([
        refreshMarketPositionsPanel(),
        refreshMarketSettlementsPanel(),
        refreshMarketTicksPanel(),
        refreshTicketsPanel()
      ])
    } catch (error: unknown) {
      emitError(normalizeError(error, '开仓失败'))
    } finally {
      marketOpening.value = false
    }
  }

  // ═══════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════

  async function loadInitial() {
    // 必须先等 config 就绪（设置 activated），afterLoad 中的 refreshMarketPanel 依赖它
    await page.refreshConfig(false)
  }

  // ═══════════════════════════════════════════════════════
  // WATCHERS
  // ═══════════════════════════════════════════════════════

  watch(selectedMarketContractId, (next, prev) => {
    if (suppressMarketContractWatch) return
    if (!next || next === prev || !activated.value) return
    if (marketLoading.value) {
      marketRefreshPending = true
      return
    }
    Promise.allSettled([
      refreshMarketTicksPanel(),
      refreshMarketOpponentsPanel()
    ]).catch((error) => {
      console.warn('[gacha] market panel refresh failed', error)
    })
  })

  watch(marketLockTier, (next) => {
    const meta = marketLockTierMeta.value[next]
    if (!meta.leverageOptions.includes(Number(marketLeverage.value))) {
      marketLeverage.value = meta.leverageOptions[0] || 1
    }
    if (Number(marketStake.value) < meta.minLots * 10) {
      marketStake.value = meta.minLots * 10
    }
    if (activated.value) {
      refreshMarketOpponentsPanel().catch((error) => {
        console.warn('[gacha] market opponents refresh on tier switch failed', error)
      })
    }
  }, { immediate: true })

  watch(marketTimeframe, () => {
    if (!activated.value) return
    refreshMarketPanel().catch((error) => {
      console.warn('[gacha] market refresh on timeframe switch failed', error)
    })
  })

  // ═══════════════════════════════════════════════════════
  // RETURN
  // ═══════════════════════════════════════════════════════

  return {
    // History (for StatusBar)
    history,
    refreshHistory,

    // Placement (read-only, for StatusBar)
    placement,

    // Market state
    marketContracts,
    selectedMarketContractId,
    marketLockTierConfig,
    marketTicks,
    marketCandles,
    marketMarkers,
    marketTickDiagnostics,
    marketPositions,
    marketSettlements,
    marketSettlementSummary,
    marketOpponents,
    marketLoading,
    marketOpening,
    marketSide,
    marketLockTier,
    marketTimeframe,
    marketStake,
    marketLeverage,

    // Market computed
    selectedMarketContract,
    marketLatestTickPrice,
    marketUnrealizedTotal,
    marketLongShortMarginTotal,
    marketLongMarginPercent,
    marketShortMarginPercent,
    marketTimeframeOptions,
    marketTimeframeLabel,
    marketChangeBasisLabel,
    marketChangeBasisShortLabel,
    marketOpenLabel,
    marketDataStatusLevel,
    marketDataStatusLabel,
    marketDataStatusClass,
    marketLatestTickAsOfTs,
    marketLatestWatermarkTs,
    marketLatestVoteCutoffDate,
    marketTickLagLabel,
    marketWatermarkLagLabel,
    marketLatestCrowdDrag,
    marketLockTierMeta,
    marketTierMeta,
    marketLeverageOptions,
    marketStakePreset,
    marketMinStake,
    marketEstimatedLots,
    marketEstimatedOpenFee,

    // Market handlers
    refreshMarketContractsPanel,
    refreshMarketTicksPanel,
    refreshMarketPositionsPanel,
    refreshMarketSettlementsPanel,
    refreshMarketOpponentsPanel,
    refreshMarketPanel,
    handleOpenMarketPosition,
    handleSelectMarketContractFromPanel,
    handleChangeMarketTimeframeFromPanel,
    handleOpenMarketPositionFromPanel,

    // Tickets (lightweight, for post-open-position refresh)
    refreshTicketsPanel,

    // Lifecycle
    loadInitial
  }
}
