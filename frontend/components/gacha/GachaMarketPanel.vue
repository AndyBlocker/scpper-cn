<script setup lang="ts">
/**
 * 市场面板 — 移动优先单栏布局。
 * A. 合约选择 pills
 * B. 行情卡片（价格 + K 线 + 开仓按钮）
 * C. 我的持仓（仅 OPEN）
 * D. 折叠区（多空深度、结算、统计、诊断、排行榜）
 * E. 开仓弹窗（Dialog）
 */
import { computed, nextTick, ref, watch } from 'vue'
import type {
  MarketContract, MarketTick, MarketCandle, MarketPositionMarker,
  MarketTickDiagnostics, MarketPosition, MarketSettlement,
  MarketOpponentSnapshot, MarketLockTier, MarketLockTierMeta,
  MarketPositionSide
} from '~/types/gacha'
import {
  formatTokens, formatTokenDecimal, formatSignedNumber, formatPrice,
  formatDateCompact, formatLagDuration, pnlClass, marketCategoryLabel
} from '~/utils/gachaFormatters'
import {
  fallbackMarketLockTierMeta as fallbackTierMeta,
  type MarketLockTierViewMeta as LockTierViewMeta
} from '~/utils/gachaConstants'
import { UiButton } from '~/components/ui/button'
import { UiSelectRoot, UiSelectTrigger, UiSelectContent, UiSelectItem } from '~/components/ui/select'
import {
  UiDialogRoot,
  UiDialogPortal,
  UiDialogOverlay,
  UiDialogContent
} from '~/components/ui/dialog'
import MarketCandlestickChart from '~/components/gacha/MarketCandlestickChart.vue'
import GachaConfirmDialog from '~/components/gacha/GachaConfirmDialog.vue'

const props = withDefaults(defineProps<{
  contracts: MarketContract[]
  ticks: MarketTick[]
  candles: MarketCandle[]
  markers: MarketPositionMarker[]
  tickDiagnostics: MarketTickDiagnostics | null
  positions: MarketPosition[]
  settlements: MarketSettlement[]
  settlementSummary: { total: number; pnl: number } | null
  opponents: MarketOpponentSnapshot | null
  lockTierConfig: Partial<Record<MarketLockTier, MarketLockTierMeta>>
  loading: boolean
  opening: boolean
  selectedContractId?: string | null
  timeframe?: '24H' | '7D' | '30D'
}>(), {
  selectedContractId: null,
  timeframe: '24H'
})

const emit = defineEmits<{
  refresh: []
  'select-contract': [contractId: string | null]
  'change-timeframe': [timeframe: '24H' | '7D' | '30D']
  'open-position': [payload: {
    contractId: string
    side: MarketPositionSide
    lockTier: MarketLockTier
    stake: number
    leverage: number
  }]
}>()

// ─── 合约 & timeframe ────────────────────────────────────
const selectedContractId = computed<string | null>({
  get: () => props.selectedContractId ?? null,
  set: (value) => emit('select-contract', value ?? null)
})
const timeframe = computed<'24H' | '7D' | '30D'>({
  get: () => props.timeframe ?? '24H',
  set: (value) => emit('change-timeframe', value)
})

const timeframeOptions = [
  { value: '24H' as const, label: '日' },
  { value: '7D' as const, label: '7日' },
  { value: '30D' as const, label: '30日' }
]
const changeBasisShortLabel = computed(() => {
  const map: Record<string, string> = { '24H': '日内', '7D': '7日', '30D': '30日' }
  return map[timeframe.value] ?? '日内'
})

const selectedContract = computed<MarketContract | null>(() => {
  if (!props.contracts.length) return null
  if (selectedContractId.value) return props.contracts.find((c) => c.id === selectedContractId.value) ?? props.contracts[0]
  return props.contracts[0]
})

const latestTickPrice = computed(() => {
  if (props.ticks.length === 0) return selectedContract.value?.latestPrice ?? 0
  return Number(props.ticks[props.ticks.length - 1]?.price ?? 0)
})

// ─── 持仓 ──────────────────────────────────────────────────
const openPositions = computed(() =>
  props.positions
    .filter((p) => (p.status ?? 'OPEN') === 'OPEN')
    .sort((a, b) => new Date(b.openedAt || 0).getTime() - new Date(a.openedAt || 0).getTime())
)
const unrealizedTotal = computed(() => openPositions.value.reduce((sum, p) => sum + Number(p.unrealizedPnl ?? 0), 0))

// ─── 折叠区数据 ────────────────────────────────────────────
const sortedSettlements = computed(() =>
  [...props.settlements].sort((a, b) =>
    new Date(b.settledAt || 0).getTime() - new Date(a.settledAt || 0).getTime()
  )
)
const settlementPnlTotal = computed(() =>
  props.settlements.reduce((sum, item) => sum + Number(item.pnl ?? 0), 0)
)

const longShortMarginTotal = computed(() => Number(props.opponents?.longMargin ?? 0) + Number(props.opponents?.shortMargin ?? 0))
const longMarginPercent = computed(() => {
  const total = longShortMarginTotal.value
  if (total <= 0) return 50
  return Math.max(6, Math.min(94, (Number(props.opponents?.longMargin ?? 0) / total) * 100))
})
const shortMarginPercent = computed(() => {
  const total = longShortMarginTotal.value
  if (total <= 0) return 50
  return Math.max(6, Math.min(94, (Number(props.opponents?.shortMargin ?? 0) / total) * 100))
})

const dataStatusLevel = computed<'ok' | 'lagging' | 'stale'>(() => props.tickDiagnostics?.staleLevel ?? 'ok')
const dataStatusLabel = computed(() => {
  if (dataStatusLevel.value === 'stale') return '数据滞后'
  if (dataStatusLevel.value === 'lagging') return '数据偏慢'
  return '数据正常'
})
const dataStatusClass = computed(() => {
  if (dataStatusLevel.value === 'stale') return 'text-rose-600 dark:text-rose-300'
  if (dataStatusLevel.value === 'lagging') return 'text-amber-600 dark:text-amber-300'
  return 'text-emerald-600 dark:text-emerald-300'
})

const latestTickAsOfTs = computed(() => props.tickDiagnostics?.latestTickAsOfTs || props.ticks[props.ticks.length - 1]?.asOfTs || props.ticks[props.ticks.length - 1]?.ts || null)
const latestWatermarkTs = computed(() => props.tickDiagnostics?.latestWatermarkTs || props.ticks[props.ticks.length - 1]?.watermarkTs || null)
const latestVoteCutoffDate = computed(() => props.tickDiagnostics?.latestVoteCutoffDate || props.ticks[props.ticks.length - 1]?.voteCutoffDate || null)
const tickLagLabel = computed(() => formatLagDuration(props.tickDiagnostics?.tickLagMs))
const watermarkLagLabel = computed(() => formatLagDuration(props.tickDiagnostics?.watermarkLagMs))

// ─── 开仓弹窗 ──────────────────────────────────────────────
const tradeDialogOpen = ref(false)
const openPositionConfirmOpen = ref(false)
const openPositionSubmitting = ref(false)
const side = ref<MarketPositionSide>('LONG')
const lockTier = ref<MarketLockTier>('T1')
const stake = ref<number>(120)
const leverage = ref<number>(2)

const lockTierMeta = computed<Record<MarketLockTier, LockTierViewMeta>>(() => {
  const output = { ...fallbackTierMeta }
  ;(Object.keys(output) as MarketLockTier[]).forEach((tier) => {
    const remote = props.lockTierConfig[tier]
    if (!remote) return
    output[tier] = {
      ...output[tier],
      leverageOptions: remote.leverageOptions ?? output[tier].leverageOptions,
      stakePreset: remote.stakePreset ?? output[tier].stakePreset,
      minLots: remote.minLots ?? output[tier].minLots,
      openFeeBaseRate: Number(remote.openFeeBaseRate ?? output[tier].openFeeBaseRate)
    }
  })
  return output
})

const tierMeta = computed(() => lockTierMeta.value[lockTier.value])
const leverageOptions = computed(() => tierMeta.value.leverageOptions)
const stakePreset = computed(() => tierMeta.value.stakePreset)
const estimatedLots = computed(() => Math.max(0, Math.floor(Number(stake.value || 0) / 10)))

const estimatedOpenFee = computed(() => {
  const s = Number(stake.value || 0)
  if (!Number.isFinite(s) || s <= 0) return 0
  const lev = Number(leverage.value || 0)
  const surchargeMap: Record<number, number> = { 1: 0, 2: 0.002, 5: 0.008, 10: 0.018, 20: 0.04, 50: 0.1, 100: 0.22 }
  const feeRate = Number(tierMeta.value.openFeeBaseRate || 0) + (surchargeMap[lev] ?? 0)
  return Math.floor(s * feeRate)
})

const openPositionPayload = computed(() => {
  const contract = selectedContract.value
  if (!contract) return null
  return {
    contractId: contract.id,
    side: side.value,
    lockTier: lockTier.value,
    stake: stake.value,
    leverage: leverage.value
  }
})

const openPositionConfirmDetails = computed(() => {
  const contract = selectedContract.value
  const contractLabel = contract
    ? `${marketCategoryLabel(contract.category || contract.symbol)} · ${contract.symbol}`
    : '--'
  return [
    { label: '合约名', value: contractLabel },
    { label: '方向', value: side.value === 'LONG' ? '做多' : '做空' },
    { label: '锁仓', value: lockTier.value },
    { label: '本金', value: `${formatTokens(stake.value)}T` },
    { label: '杠杆', value: `${leverage.value}x` },
    { label: '预估手续费', value: `${formatTokens(estimatedOpenFee.value)}T` }
  ]
})

watch(() => props.opening, (isOpening, wasOpening) => {
  if (!openPositionSubmitting.value) return
  if (!isOpening && wasOpening) {
    openPositionSubmitting.value = false
    openPositionConfirmOpen.value = false
  }
})

function openTradeDialog() {
  tradeDialogOpen.value = true
}

function handleTradeDialogOpenChange(nextOpen: boolean) {
  tradeDialogOpen.value = nextOpen
}

function handleStakeChange(value: string | number) {
  stake.value = Number(value)
}

function handleLeverageChange(value: string | number) {
  leverage.value = Number(value)
}

function handleSubmit() {
  if (!openPositionPayload.value || props.opening) return
  tradeDialogOpen.value = false
  openPositionConfirmOpen.value = true
  openPositionSubmitting.value = false
}

async function handleConfirmOpenPosition() {
  const payload = openPositionPayload.value
  if (!payload || props.opening || openPositionSubmitting.value) return
  openPositionSubmitting.value = true
  emit('open-position', payload)
  await nextTick()
  if (!props.opening) {
    openPositionSubmitting.value = false
    openPositionConfirmOpen.value = false
  }
}

function handleCancelOpenPositionConfirm() {
  if (props.opening || openPositionSubmitting.value) return
  openPositionSubmitting.value = false
  openPositionConfirmOpen.value = false
  tradeDialogOpen.value = true
}

function formatExpiry(expireAt: string | null | undefined) {
  if (!expireAt) return '未定'
  const diff = new Date(expireAt).getTime() - Date.now()
  if (diff <= 0) return '已到期'
  const hours = Math.floor(diff / 3600000)
  if (hours < 24) return `${hours}h后`
  const days = Math.floor(hours / 24)
  return `${days}d后`
}
</script>

<template>
  <section class="market-panel mx-auto w-full max-w-[900px] space-y-2">

    <!-- A. 合约选择条 -->
    <div class="market-contract-bar">
      <button
        v-for="contract in contracts"
        :key="contract.id"
        type="button"
        class="market-contract-pill"
        :class="selectedContractId === contract.id
          ? 'market-contract-pill--active'
          : ''"
        @click="selectedContractId = contract.id"
      >
        <span class="market-contract-pill__name">{{ marketCategoryLabel(contract.category || contract.symbol) }}</span>
        <span class="market-contract-pill__change" :class="pnlClass(contract.changePercent ?? contract.change24hPercent)">
          {{ formatSignedNumber(contract.changePercent ?? contract.change24hPercent, 2) }}%
        </span>
      </button>
    </div>

    <!-- B. 行情卡片 -->
    <article class="market-quote-card surface-card p-3 sm:p-4">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <p class="text-[11px] uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">
            {{ marketCategoryLabel(selectedContract?.category || selectedContract?.symbol) }} · {{ selectedContract?.symbol || '--' }}
          </p>
          <p class="mt-0.5 text-2xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-50 sm:text-3xl">
            {{ formatPrice(latestTickPrice) }}
          </p>
          <p class="mt-0.5 text-xs font-medium" :class="pnlClass((selectedContract?.changePercent ?? selectedContract?.change24hPercent) || 0)">
            {{ changeBasisShortLabel }}
            {{ formatSignedNumber((selectedContract?.change ?? selectedContract?.change24h) || 0, 4) }}（{{ formatSignedNumber((selectedContract?.changePercent ?? selectedContract?.change24hPercent) || 0, 2) }}%）
          </p>
        </div>
        <div class="flex items-center gap-1.5 flex-shrink-0">
          <div class="flex items-center gap-0.5">
            <button
              v-for="item in timeframeOptions"
              :key="`market-tf-${item.value}`"
              type="button"
              class="market-tf-btn"
              :class="timeframe === item.value ? 'market-tf-btn--active' : ''"
              @click="timeframe = item.value"
            >
              {{ item.label }}
            </button>
          </div>
          <UiButton
            variant="outline"
            size="sm"
            class="h-7 w-7 p-0"
            :disabled="loading"
            @click="emit('refresh')"
          >
            <svg class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6M3 12a9 9 0 0115.36-6.36L21 8M3 22v-6h6M21 12a9 9 0 01-15.36 6.36L3 16"/></svg>
          </UiButton>
          <UiButton size="sm" class="text-xs" :disabled="opening || !selectedContract" @click="openTradeDialog">
            开仓
          </UiButton>
        </div>
      </div>

      <!-- K线图 -->
      <div class="mt-3 rounded-xl border border-neutral-200/80 bg-neutral-100/65 p-1.5 dark:border-neutral-700/70 dark:bg-neutral-950/50">
        <MarketCandlestickChart :candles="candles" :markers="markers" :timeframe="timeframe" :as-of-ts="tickDiagnostics?.asOfTs || null" />
      </div>
    </article>

    <!-- C. 我的持仓 -->
    <section v-if="openPositions.length" class="market-positions surface-card p-3 sm:p-4">
      <header class="flex items-center justify-between gap-2">
        <h4 class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">
          持仓 · 浮动 <span :class="pnlClass(unrealizedTotal)">{{ formatSignedNumber(unrealizedTotal, 0) }}T</span>
        </h4>
        <span class="text-[11px] text-neutral-500 dark:text-neutral-400">{{ openPositions.length }} 仓</span>
      </header>
      <div class="mt-2 space-y-2">
        <div
          v-for="pos in openPositions"
          :key="pos.positionId"
          class="market-position-card"
          :class="pos.side === 'LONG' ? 'market-position-card--long' : 'market-position-card--short'"
        >
          <div class="flex items-center justify-between gap-2">
            <div class="flex items-center gap-2 min-w-0">
              <span
                class="market-position-side-badge"
                :class="pos.side === 'LONG'
                  ? 'bg-emerald-500 dark:bg-emerald-400'
                  : 'bg-rose-500 dark:bg-rose-400'"
              >
                {{ pos.side === 'LONG' ? '多' : '空' }}
              </span>
              <span class="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100 truncate">
                {{ marketCategoryLabel(pos.contractId) }}
              </span>
              <span class="market-position-tier-tag">{{ pos.lockTier || 'T1' }}</span>
            </div>
            <span class="text-sm font-bold tabular-nums" :class="pnlClass(pos.unrealizedPnl)">
              {{ formatSignedNumber(pos.unrealizedPnl, 0) }}T
            </span>
          </div>
          <div class="mt-1.5 flex items-center justify-between text-[11px] text-neutral-500 dark:text-neutral-400">
            <div class="flex items-center gap-3">
              <span>保证金 <span class="font-medium text-neutral-600 dark:text-neutral-300">{{ formatTokens(pos.margin ?? pos.stake) }}T</span></span>
              <span>杠杆 <span class="font-medium text-neutral-600 dark:text-neutral-300">{{ pos.leverage }}x</span></span>
            </div>
            <span>{{ formatExpiry(pos.expireAt) }}</span>
          </div>
        </div>
      </div>
    </section>

    <!-- D. 折叠区 -->
    <details class="market-advanced surface-card">
      <summary class="market-advanced__summary">
        更多数据
      </summary>
      <div class="market-advanced__body">
        <!-- 最近结算 -->
        <div v-if="sortedSettlements.length" class="space-y-1">
          <h5 class="text-xs font-semibold text-neutral-700 dark:text-neutral-200">最近结算 · <span :class="pnlClass(settlementSummary?.pnl ?? settlementPnlTotal)">{{ formatSignedNumber(settlementSummary?.pnl ?? settlementPnlTotal, 0) }}T</span></h5>
          <div
            v-for="item in sortedSettlements.slice(0, 8)"
            :key="`settle-${item.positionId}`"
            class="flex items-center justify-between rounded-lg border border-neutral-200/70 bg-neutral-50/75 px-2.5 py-1.5 text-xs dark:border-neutral-700/70 dark:bg-neutral-800/60"
          >
            <div class="min-w-0">
              <span class="font-medium text-neutral-700 dark:text-neutral-100">
                {{ marketCategoryLabel(item.contractId) }} {{ item.side === 'LONG' ? '多' : '空' }} · {{ item.lockTier || 'T1' }} · {{ item.status === 'LIQUIDATED' ? '爆仓' : '结算' }}
              </span>
              <span class="ml-2 text-[11px] text-neutral-500 dark:text-neutral-400">{{ formatDateCompact(item.settledAt) }}</span>
            </div>
            <span class="shrink-0" :class="pnlClass(item.pnl)">{{ formatSignedNumber(item.pnl, 0) }}T</span>
          </div>
        </div>

        <!-- 多空深度 -->
        <div v-if="opponents" class="space-y-2.5">
          <div class="flex items-center justify-between">
            <h5 class="text-xs font-semibold text-neutral-700 dark:text-neutral-200">多空深度</h5>
            <span class="text-[11px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{{ opponents.mood }}</span>
          </div>

          <!-- 多空卡片 -->
          <div class="grid gap-2 text-xs sm:grid-cols-2">
            <div class="market-depth-card market-depth-card--long">
              <div class="flex items-center gap-1.5">
                <span class="market-depth-dot bg-emerald-500 dark:bg-emerald-400" />
                <span class="font-semibold text-emerald-700 dark:text-emerald-200">多头</span>
              </div>
              <div class="mt-1 grid grid-cols-3 gap-1 text-[11px]">
                <div class="text-center">
                  <p class="font-bold text-emerald-800 dark:text-emerald-100">{{ formatTokens(opponents.longUsers || 0) }}</p>
                  <p class="text-emerald-600/70 dark:text-emerald-300/60">人</p>
                </div>
                <div class="text-center">
                  <p class="font-bold text-emerald-800 dark:text-emerald-100">{{ formatTokens(opponents.longLots || 0) }}</p>
                  <p class="text-emerald-600/70 dark:text-emerald-300/60">手</p>
                </div>
                <div class="text-center">
                  <p class="font-bold text-emerald-800 dark:text-emerald-100">{{ formatTokens(opponents.longMargin || 0) }}</p>
                  <p class="text-emerald-600/70 dark:text-emerald-300/60">保证金</p>
                </div>
              </div>
            </div>
            <div class="market-depth-card market-depth-card--short">
              <div class="flex items-center gap-1.5">
                <span class="market-depth-dot bg-rose-500 dark:bg-rose-400" />
                <span class="font-semibold text-rose-700 dark:text-rose-200">空头</span>
              </div>
              <div class="mt-1 grid grid-cols-3 gap-1 text-[11px]">
                <div class="text-center">
                  <p class="font-bold text-rose-800 dark:text-rose-100">{{ formatTokens(opponents.shortUsers || 0) }}</p>
                  <p class="text-rose-600/70 dark:text-rose-300/60">人</p>
                </div>
                <div class="text-center">
                  <p class="font-bold text-rose-800 dark:text-rose-100">{{ formatTokens(opponents.shortLots || 0) }}</p>
                  <p class="text-rose-600/70 dark:text-rose-300/60">手</p>
                </div>
                <div class="text-center">
                  <p class="font-bold text-rose-800 dark:text-rose-100">{{ formatTokens(opponents.shortMargin || 0) }}</p>
                  <p class="text-rose-600/70 dark:text-rose-300/60">保证金</p>
                </div>
              </div>
            </div>
          </div>

          <!-- 保证金结构条 -->
          <div class="rounded-lg border border-neutral-200/70 bg-white/85 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-900/65">
            <div class="flex items-center justify-between text-[11px] text-neutral-500 dark:text-neutral-400">
              <span>保证金结构</span>
              <span>{{ formatTokens(longShortMarginTotal) }}T</span>
            </div>
            <div class="mt-1.5 h-2.5 overflow-hidden rounded-full bg-neutral-200/80 dark:bg-neutral-800/70">
              <div class="flex h-full">
                <div class="h-full rounded-l-full bg-emerald-500/80" :style="{ width: `${longMarginPercent}%` }" />
                <div class="h-full rounded-r-full bg-rose-500/80" :style="{ width: `${shortMarginPercent}%` }" />
              </div>
            </div>
            <div class="mt-1 flex items-center justify-between text-[10px] text-neutral-500 dark:text-neutral-400">
              <span>多头 {{ formatTokenDecimal(longMarginPercent, 1) }}%</span>
              <span>空头 {{ formatTokenDecimal(shortMarginPercent, 1) }}%</span>
            </div>
          </div>

          <!-- 排行榜 -->
          <div v-if="opponents.leaderboard?.length">
            <h6 class="mb-1.5 text-[11px] font-semibold text-neutral-500 dark:text-neutral-400">持仓排行</h6>
            <div class="space-y-1.5">
              <div
                v-for="entry in opponents.leaderboard.slice(0, 5)"
                :key="`market-board-${entry.userId}`"
                class="market-leaderboard-card"
              >
                <div class="flex items-center gap-2.5 min-w-0">
                  <span class="market-rank-badge" :class="{
                    'market-rank-badge--gold': entry.rank === 1,
                    'market-rank-badge--silver': entry.rank === 2,
                    'market-rank-badge--bronze': entry.rank === 3
                  }">
                    {{ entry.rank }}
                  </span>
                  <div class="min-w-0 flex-1">
                    <p class="text-xs font-semibold text-neutral-800 dark:text-neutral-100 truncate">{{ entry.displayName }}</p>
                    <p class="text-[10px] text-neutral-500 dark:text-neutral-400">
                      总保证金 {{ formatTokens(entry.totalMargin ?? entry.balance) }}T
                    </p>
                  </div>
                </div>
                <div class="flex items-center gap-2 text-[10px] tabular-nums flex-shrink-0">
                  <span class="market-lb-side-chip market-lb-side-chip--long">
                    {{ formatTokens(entry.longLots || 0) }}手 / {{ formatTokens(entry.longMargin || 0) }}T
                  </span>
                  <span class="market-lb-side-chip market-lb-side-chip--short">
                    {{ formatTokens(entry.shortLots || 0) }}手 / {{ formatTokens(entry.shortMargin || 0) }}T
                  </span>
                  <span class="font-semibold w-14 text-right" :class="pnlClass(entry.netMargin ?? 0)">
                    {{ formatSignedNumber(entry.netMargin ?? 0, 0) }}T
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 区间统计 -->
        <div class="space-y-1">
          <h5 class="text-xs font-semibold text-neutral-700 dark:text-neutral-200">区间统计</h5>
          <div class="grid gap-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
            <div class="market-stat-chip">开盘 <span class="font-semibold text-neutral-800 dark:text-neutral-100">{{ formatPrice(selectedContract?.indexOpen) }}</span></div>
            <div class="market-stat-chip">高点 <span class="font-semibold text-neutral-800 dark:text-neutral-100">{{ formatPrice(selectedContract?.rangeHigh ?? selectedContract?.high24h) }}</span></div>
            <div class="market-stat-chip">低点 <span class="font-semibold text-neutral-800 dark:text-neutral-100">{{ formatPrice(selectedContract?.rangeLow ?? selectedContract?.low24h) }}</span></div>
            <div class="market-stat-chip">量能 <span class="font-semibold text-neutral-800 dark:text-neutral-100">{{ formatTokens((selectedContract?.rangeVolume ?? selectedContract?.volume24h) || 0) }}</span></div>
          </div>
        </div>

        <!-- 数据诊断 -->
        <div class="space-y-1">
          <h5 class="text-xs font-semibold text-neutral-700 dark:text-neutral-200">数据状态</h5>
          <div class="grid gap-1.5 text-[11px] sm:grid-cols-2 lg:grid-cols-4">
            <div class="market-stat-chip">状态 <span class="font-semibold" :class="dataStatusClass">{{ dataStatusLabel }}</span></div>
            <div class="market-stat-chip">Tick 滞后 <span class="font-semibold text-neutral-800 dark:text-neutral-100">{{ tickLagLabel }}</span></div>
            <div class="market-stat-chip">Watermark <span class="font-semibold text-neutral-800 dark:text-neutral-100">{{ formatDateCompact(latestWatermarkTs) || '--' }}</span></div>
            <div class="market-stat-chip">voteCutoff <span class="font-semibold text-neutral-800 dark:text-neutral-100">{{ latestVoteCutoffDate || '--' }}</span></div>
          </div>
        </div>
      </div>
    </details>

    <!-- E. 开仓弹窗 -->
    <UiDialogRoot :open="tradeDialogOpen" @update:open="handleTradeDialogOpenChange">
      <UiDialogPortal>
        <UiDialogOverlay class="market-dialog-overlay" />
        <UiDialogContent class="market-trade-dialog">
          <h3 class="text-base font-semibold text-neutral-900 dark:text-neutral-100">
            开仓 {{ marketCategoryLabel(selectedContract?.category || selectedContract?.symbol) }}
          </h3>

          <form class="mt-3 space-y-3" @submit.prevent="handleSubmit">
            <!-- 做多/做空 toggle -->
            <div class="grid grid-cols-2 gap-2">
              <button
                type="button"
                class="market-side-btn"
                :class="side === 'LONG'
                  ? 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-200'
                  : 'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:border-neutral-600'"
                @click="side = 'LONG'"
              >
                做多
              </button>
              <button
                type="button"
                class="market-side-btn"
                :class="side === 'SHORT'
                  ? 'border-rose-300 bg-rose-50 text-rose-700 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200'
                  : 'border-neutral-200 bg-white text-neutral-600 hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200 dark:hover:border-neutral-600'"
                @click="side = 'SHORT'"
              >
                做空
              </button>
            </div>

            <!-- 锁仓/保证金/杠杆 -->
            <div class="grid gap-2 sm:grid-cols-3">
              <label class="space-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                <span>锁仓</span>
                <UiSelectRoot v-model="lockTier">
                  <UiSelectTrigger class="w-full" placeholder="锁仓层级" />
                  <UiSelectContent>
                    <UiSelectItem value="T1">T1（24h）</UiSelectItem>
                    <UiSelectItem value="T7">T7（168h）</UiSelectItem>
                    <UiSelectItem value="T15">T15（360h）</UiSelectItem>
                    <UiSelectItem value="T30">T30（720h）</UiSelectItem>
                  </UiSelectContent>
                </UiSelectRoot>
              </label>
              <label class="space-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                <span>保证金</span>
                <UiSelectRoot
                  :model-value="String(stake)"
                  @update:model-value="handleStakeChange"
                >
                  <UiSelectTrigger class="w-full" placeholder="保证金" />
                  <UiSelectContent>
                    <UiSelectItem
                      v-for="preset in stakePreset"
                      :key="`dialog-stake-${preset}`"
                      :value="String(preset)"
                    >
                      {{ preset }}T
                    </UiSelectItem>
                  </UiSelectContent>
                </UiSelectRoot>
              </label>
              <label class="space-y-1 text-xs text-neutral-500 dark:text-neutral-400">
                <span>杠杆</span>
                <UiSelectRoot
                  :model-value="String(leverage)"
                  @update:model-value="handleLeverageChange"
                >
                  <UiSelectTrigger class="w-full" placeholder="杠杆" />
                  <UiSelectContent>
                    <UiSelectItem
                      v-for="level in leverageOptions"
                      :key="`dialog-lev-${lockTier}-${level}`"
                      :value="String(level)"
                    >
                      {{ level }}x
                    </UiSelectItem>
                  </UiSelectContent>
                </UiSelectRoot>
              </label>
            </div>

            <!-- 摘要 -->
            <p class="text-[11px] text-neutral-500 dark:text-neutral-400">
              约 {{ estimatedLots }} 手 · fee ≈ {{ formatTokens(estimatedOpenFee) }}T
            </p>

            <!-- 操作按钮 -->
            <div class="flex justify-end gap-2 pt-1">
              <UiButton variant="outline" size="sm" type="button" @click="tradeDialogOpen = false">取消</UiButton>
              <UiButton size="sm" type="submit" :disabled="opening || !selectedContract">
                {{ opening ? '开仓中...' : '确认开仓' }}
              </UiButton>
            </div>
          </form>
        </UiDialogContent>
      </UiDialogPortal>
    </UiDialogRoot>

    <GachaConfirmDialog
      :open="openPositionConfirmOpen"
      title="确认开仓"
      :description="`确认按以下参数开仓 ${marketCategoryLabel(selectedContract?.category || selectedContract?.symbol)} 吗？`"
      confirm-text="确认开仓"
      :busy="opening || openPositionSubmitting"
      :details="openPositionConfirmDetails"
      @cancel="handleCancelOpenPositionConfirm"
      @confirm="handleConfirmOpenPosition"
    />
  </section>
</template>

<style scoped>
/* ── A. 合约选择条 ──────────────────────────── */
.market-contract-bar {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 2px 0;
}
.market-contract-bar::-webkit-scrollbar { display: none; }

.market-contract-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  padding: 6px 12px;
  border-radius: 999px;
  border: 1px solid var(--g-border);
  background: var(--g-surface-card);
  font-size: 12px;
  font-weight: 600;
  color: var(--g-text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
}
.market-contract-pill:hover {
  border-color: var(--g-border-strong);
}
.market-contract-pill--active {
  border-color: rgba(6, 182, 212, 0.5);
  background: rgba(6, 182, 212, 0.08);
  color: var(--g-text-primary);
  box-shadow: 0 2px 8px -2px rgba(8, 145, 178, 0.25);
}
html.dark .market-contract-pill--active {
  border-color: rgba(6, 182, 212, 0.4);
  background: rgba(6, 182, 212, 0.1);
}

.market-contract-pill__name {
  color: var(--g-text-primary);
}
.market-contract-pill__change {
  font-variant-numeric: tabular-nums;
}

/* ── B. 行情卡片 ──────────────────────────── */
.market-quote-card {
  border-radius: var(--g-radius-xl);
}

.market-tf-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--g-radius-sm);
  border: 1px solid var(--g-border);
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 600;
  color: var(--g-text-tertiary);
  background: var(--g-surface-card);
  cursor: pointer;
  transition: all 0.15s ease;
}
.market-tf-btn:hover {
  color: var(--g-text-primary);
  border-color: var(--g-border-strong);
}
.market-tf-btn--active {
  border-color: rgba(6, 182, 212, 0.5);
  background: rgba(6, 182, 212, 0.08);
  color: #0891b2;
}
html.dark .market-tf-btn--active {
  border-color: rgba(6, 182, 212, 0.4);
  background: rgba(6, 182, 212, 0.1);
  color: #67e8f9;
}

/* ── C. 持仓 ──────────────────────────── */
.market-positions {
  border-radius: var(--g-radius-xl);
}

.market-position-card {
  padding: 10px 12px;
  border-radius: var(--g-radius-md);
  border: 1px solid var(--g-border);
  background: var(--g-surface-recessed);
  border-left: 3px solid transparent;
  transition: border-color 0.15s ease;
}
.market-position-card--long {
  border-left-color: rgba(16, 185, 129, 0.6);
}
.market-position-card--short {
  border-left-color: rgba(244, 63, 94, 0.6);
}
html.dark .market-position-card--long {
  border-left-color: rgba(52, 211, 153, 0.5);
}
html.dark .market-position-card--short {
  border-left-color: rgba(251, 113, 133, 0.5);
}

.market-position-side-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  color: white;
  flex-shrink: 0;
}

.market-position-tier-tag {
  display: inline-flex;
  padding: 1px 5px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  background: var(--g-surface-card);
  border: 1px solid var(--g-border);
  color: var(--g-text-tertiary);
}

/* ── D. 折叠区 ──────────────────────────── */
.market-advanced {
  border-radius: var(--g-radius-xl);
}

.market-advanced__summary {
  cursor: pointer;
  padding: 12px 16px;
  font-size: 13px;
  font-weight: 600;
  color: var(--g-text-secondary);
  user-select: none;
  list-style: none;
}
.market-advanced__summary::-webkit-details-marker { display: none; }
.market-advanced__summary::before {
  content: '▸ ';
  display: inline;
  transition: transform 0.2s ease;
}
.market-advanced[open] > .market-advanced__summary::before {
  content: '▾ ';
}

.market-advanced__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 0 16px 16px;
}

.market-stat-chip {
  padding: 6px 10px;
  border-radius: var(--g-radius-sm);
  border: 1px solid var(--g-border);
  background: var(--g-surface-recessed);
  color: var(--g-text-secondary);
}

/* ── E. 开仓弹窗 ──────────────────────────── */
.market-dialog-overlay {
  position: fixed;
  inset: 0;
  z-index: 99;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.market-trade-dialog {
  position: fixed;
  z-index: 100;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  box-sizing: border-box;
  width: calc(100vw - 16px);
  width: calc(100dvw - 16px);
  max-width: 420px;
  max-height: calc(100vh - 16px);
  max-height: calc(100dvh - 16px);
  overflow-y: auto;
  border-radius: var(--g-radius-xl);
  border: 1px solid var(--g-border);
  background: var(--g-surface-card);
  box-shadow: var(--g-shadow-xl);
  padding: 16px;
}

.market-side-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 12px;
  border-radius: var(--g-radius-md);
  border: 1px solid;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

/* ── D-extra: 多空深度卡片 ──────────────── */
.market-depth-card {
  padding: 8px 10px;
  border-radius: var(--g-radius-md);
  border: 1px solid;
}
.market-depth-card--long {
  border-color: rgba(16, 185, 129, 0.25);
  background: rgba(16, 185, 129, 0.04);
}
.market-depth-card--short {
  border-color: rgba(244, 63, 94, 0.25);
  background: rgba(244, 63, 94, 0.04);
}
html.dark .market-depth-card--long {
  border-color: rgba(52, 211, 153, 0.2);
  background: rgba(52, 211, 153, 0.06);
}
html.dark .market-depth-card--short {
  border-color: rgba(251, 113, 133, 0.2);
  background: rgba(251, 113, 133, 0.06);
}

.market-depth-dot {
  display: inline-block;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

/* ── D-extra: 排行榜卡片 ──────────────── */
.market-leaderboard-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 10px;
  border-radius: var(--g-radius-md);
  border: 1px solid var(--g-border);
  background: var(--g-surface-recessed);
}

.market-rank-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
  background: var(--g-surface-card);
  border: 1px solid var(--g-border);
  color: var(--g-text-secondary);
}
.market-rank-badge--gold {
  background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
  border-color: rgba(245, 158, 11, 0.5);
  color: white;
  box-shadow: 0 1px 4px -1px rgba(245, 158, 11, 0.4);
}
.market-rank-badge--silver {
  background: linear-gradient(135deg, #d1d5db 0%, #9ca3af 100%);
  border-color: rgba(156, 163, 175, 0.5);
  color: white;
  box-shadow: 0 1px 4px -1px rgba(156, 163, 175, 0.4);
}
.market-rank-badge--bronze {
  background: linear-gradient(135deg, #d97706 0%, #b45309 100%);
  border-color: rgba(180, 83, 9, 0.5);
  color: white;
  box-shadow: 0 1px 4px -1px rgba(180, 83, 9, 0.3);
}

.market-lb-side-chip {
  display: inline-flex;
  padding: 1px 5px;
  border-radius: 4px;
  font-weight: 500;
}
.market-lb-side-chip--long {
  background: rgba(16, 185, 129, 0.08);
  color: #059669;
}
.market-lb-side-chip--short {
  background: rgba(244, 63, 94, 0.08);
  color: #e11d48;
}
html.dark .market-lb-side-chip--long {
  background: rgba(52, 211, 153, 0.1);
  color: #6ee7b7;
}
html.dark .market-lb-side-chip--short {
  background: rgba(251, 113, 133, 0.1);
  color: #fda4af;
}
</style>
