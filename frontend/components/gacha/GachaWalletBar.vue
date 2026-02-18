<script setup lang="ts">
/**
 * GachaWalletBar — 统一钱包/状态栏组件。
 * mode="full": 大字余额 + 签到按钮 + 收支 tiles（抽卡页用）
 * mode="compact": 行内条 — 余额 + 可领取 + 缓冲（其他页面用）
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useGacha } from '~/composables/useGacha'
import { formatTokens, formatTokenDecimal } from '~/utils/gachaFormatters'
import type { Wallet } from '~/types/gacha'
import { UiButton } from '~/components/ui/button'

withDefaults(defineProps<{
  mode?: 'full' | 'compact'
  claimableToken?: number
  pendingToken?: number
  missionClaimable?: number
}>(), {
  mode: 'full',
  claimableToken: 0,
  pendingToken: 0,
  missionClaimable: 0
})

const emit = defineEmits<{
  (e: 'updated', wallet: Wallet | null): void
  (e: 'claimed', wallet: Wallet): void
  (e: 'error', message: string): void
}>()

const { state, getWallet, claimDaily } = useGacha()

const loading = ref(false)
const claiming = ref(false)
const errorMessage = ref<string | null>(null)

const wallet = computed(() => state.value.wallet)

const UTC8_TZ = 'Asia/Shanghai'
const dayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: UTC8_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit'
})

function toUtc8DayKey(d: Date) {
  const p = dayFmt.formatToParts(d)
  const y = p.find((x) => x.type === 'year')?.value ?? '0000'
  const m = p.find((x) => x.type === 'month')?.value ?? '00'
  const day = p.find((x) => x.type === 'day')?.value ?? '00'
  return `${y}-${m}-${day}`
}

const claimedToday = computed(() => {
  if (!wallet.value?.lastDailyClaimAt) return false
  const d = new Date(wallet.value.lastDailyClaimAt)
  if (Number.isNaN(d.getTime())) return false
  return toUtc8DayKey(d) === toUtc8DayKey(new Date())
})

const claimDisabled = computed(() => claimedToday.value || claiming.value)

async function refreshWallet(force = false) {
  if (loading.value) return
  loading.value = true
  errorMessage.value = null
  try {
    const res = await getWallet(force)
    if (!res.ok) {
      const msg = res.error || '加载失败'
      errorMessage.value = msg
      emit('error', msg)
    } else {
      emit('updated', res.data ?? null)
    }
  } finally {
    loading.value = false
  }
}

async function handleClaim() {
  if (claimDisabled.value) return
  claiming.value = true
  errorMessage.value = null
  try {
    const res = await claimDaily()
    if (!res.ok || !res.data) {
      const msg = res.error || '签到失败'
      errorMessage.value = msg
      emit('error', msg)
      return
    }
    emit('claimed', res.data)
    emit('updated', res.data)
  } finally {
    claiming.value = false
  }
}

watch(() => state.value.wallet, (next) => {
  emit('updated', next ?? null)
})

onMounted(() => {
  if (!wallet.value) refreshWallet()
})

defineExpose({ refresh: refreshWallet })
</script>

<template>
  <!-- Full mode: used on draw page -->
  <div v-if="mode === 'full'" class="wallet-full">
    <div class="wallet-full__top">
      <div class="wallet-full__info">
        <p class="wallet-full__label">Token 余额</p>
        <p class="gacha-text-wallet">
          <span v-if="wallet">{{ wallet.balance.toLocaleString() }}</span>
          <span v-else class="gacha-skeleton" style="display:inline-block;width:120px;height:28px;border-radius:8px" />
        </p>
      </div>
      <div class="wallet-full__actions">
        <UiButton
          size="sm"
          :disabled="claimDisabled"
          @click="handleClaim"
        >
          <span v-if="claiming">领取中...</span>
          <span v-else-if="claimedToday">今日已领</span>
          <span v-else>每日签到</span>
        </UiButton>
        <UiButton
          variant="outline"
          size="sm"
          :disabled="loading"
          @click="refreshWallet(true)"
        >
          刷新
        </UiButton>
      </div>
    </div>

    <div class="wallet-full__stats">
      <div class="wallet-full__stat">
        <span class="wallet-full__stat-label">累计获得</span>
        <span class="wallet-full__stat-value">{{ wallet?.totalEarned?.toLocaleString?.() ?? '--' }}</span>
      </div>
      <div class="wallet-full__stat">
        <span class="wallet-full__stat-label">累计消耗</span>
        <span class="wallet-full__stat-value">{{ wallet?.totalSpent?.toLocaleString?.() ?? '--' }}</span>
      </div>
    </div>

    <p v-if="errorMessage" class="wallet-full__error">{{ errorMessage }}</p>
  </div>

  <!-- Compact mode: inline bar for other pages -->
  <div v-else class="wallet-compact">
    <div class="wallet-compact__item">
      <span class="wallet-compact__label">余额</span>
      <span class="wallet-compact__value">{{ wallet ? `${formatTokens(wallet.balance)} T` : '--' }}</span>
    </div>
    <div class="wallet-compact__sep" />
    <div class="wallet-compact__item">
      <span class="wallet-compact__label">可领</span>
      <span class="wallet-compact__value">{{ formatTokenDecimal(claimableToken, 2) }} T</span>
    </div>
    <div class="wallet-compact__sep" />
    <div class="wallet-compact__item">
      <span class="wallet-compact__label">缓冲</span>
      <span class="wallet-compact__value">{{ formatTokenDecimal(pendingToken, 2) }} T</span>
    </div>
    <div v-if="missionClaimable > 0" class="wallet-compact__sep" />
    <div v-if="missionClaimable > 0" class="wallet-compact__item">
      <span class="wallet-compact__label">任务</span>
      <span class="wallet-compact__value">{{ missionClaimable }}</span>
    </div>
  </div>
</template>

<style scoped>
/* ── Full Mode ── */
.wallet-full {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-xl);
  background: var(--g-surface-card);
  box-shadow: var(--g-shadow-sm);
}

.wallet-full__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}

.wallet-full__info {
  min-width: 0;
}

.wallet-full__label {
  font-size: 12px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--g-text-tertiary);
  margin-bottom: 4px;
}

.wallet-full__actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.wallet-full__stats {
  display: flex;
  gap: 0;
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-md);
  overflow: hidden;
}

.wallet-full__stat {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  min-width: 0;
}

.wallet-full__stat + .wallet-full__stat {
  border-left: 1px solid var(--g-border);
}

.wallet-full__stat-label {
  font-size: 11px;
  font-weight: 500;
  color: var(--g-text-tertiary);
  letter-spacing: 0.02em;
}

.wallet-full__stat-value {
  font-size: 15px;
  font-weight: 700;
  color: var(--g-text-primary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.wallet-full__stat-value--secondary {
  font-size: 12px;
  font-weight: 500;
  color: var(--g-text-secondary);
}

.wallet-full__error {
  padding: 10px 14px;
  border-radius: var(--g-radius-sm);
  font-size: 13px;
  color: #be123c;
  background: rgba(255, 228, 230, 0.5);
  border: 1px solid rgba(251, 113, 133, 0.2);
}

html.dark .wallet-full__error {
  color: #fda4af;
  background: rgba(159, 18, 57, 0.12);
  border-color: rgba(251, 113, 133, 0.15);
}

/* ── Compact Mode ── */
.wallet-compact {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 8px 12px;
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-md);
  background: var(--g-surface-card);
  box-shadow: var(--g-shadow-xs);
  overflow-x: auto;
  scrollbar-width: none;
}

.wallet-compact::-webkit-scrollbar {
  display: none;
}

.wallet-compact__item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 2px 12px;
  min-width: 0;
  flex-shrink: 0;
}

.wallet-compact__label {
  font-size: 11px;
  font-weight: 500;
  color: var(--g-text-tertiary);
}

.wallet-compact__value {
  font-size: 14px;
  font-weight: 700;
  color: var(--g-text-primary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.wallet-compact__sep {
  flex-shrink: 0;
  width: 1px;
  height: 24px;
  background: var(--g-border);
}

@media (max-width: 639px) {
  .wallet-full__stats {
    flex-direction: column;
  }

  .wallet-full__stat + .wallet-full__stat {
    border-left: none;
    border-top: 1px solid var(--g-border);
  }
}
</style>
