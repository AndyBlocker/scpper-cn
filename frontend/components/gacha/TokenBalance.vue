<template>
  <div class="token-balance-panel relative flex min-h-[9.5rem] flex-col overflow-hidden rounded-[24px] border border-white/45 bg-white/78 p-4 shadow-[0_24px_70px_-40px_rgba(10,37,64,0.9)] backdrop-blur-xl dark:border-neutral-700/65 dark:bg-neutral-950/62 sm:p-5">
    <div class="token-balance-panel__glow token-balance-panel__glow--a" />
    <div class="token-balance-panel__glow token-balance-panel__glow--b" />

    <div class="relative z-[2] flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="min-w-0 space-y-1">
        <div class="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-neutral-500 dark:text-neutral-400">
          <LucideIcon name="Wallet" class="h-3.5 w-3.5" />
          <span>Token 余额中心</span>
          <span
            class="inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold tracking-[0.08em]"
            :class="claimedToday
              ? 'border-emerald-300/70 bg-emerald-50/80 text-emerald-700 dark:border-emerald-500/40 dark:bg-emerald-500/12 dark:text-emerald-200'
              : 'border-amber-300/70 bg-amber-50/80 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/12 dark:text-amber-200'"
          >
            {{ claimedToday ? '今日签到已领取' : '今日签到可领取' }}
          </span>
        </div>
        <p class="text-[11px] text-neutral-500 dark:text-neutral-400">
          上次签到（UTC+8）：{{ lastClaimText }}
        </p>
      </div>

      <div class="flex w-full items-center justify-end gap-1.5 sm:w-auto sm:shrink-0">
        <UiButton
          size="sm"
          class="gap-1.5 px-3 py-1.5 text-xs"
          :disabled="claimDisabled"
          @click="handleClaim"
        >
          <LucideIcon name="Gift" class="h-3.5 w-3.5" />
          <span v-if="claiming">领取中...</span>
          <span v-else-if="claimedToday">今日已领</span>
          <span v-else>每日签到</span>
        </UiButton>
        <UiButton
          variant="outline"
          size="sm"
          class="h-8 w-8 p-0"
          :disabled="loading"
          @click="refreshWallet(true)"
        >
          <LucideIcon name="RefreshCcw" class="h-3.5 w-3.5" />
        </UiButton>
      </div>
    </div>

    <div class="relative z-[2] mt-3 grid gap-2 sm:grid-cols-2">
      <article class="balance-core sm:col-span-2">
        <p class="balance-core__label">当前余额</p>
        <div class="balance-core__value-wrap">
          <p class="balance-core__value">
            <span v-if="wallet">{{ wallet.balance.toLocaleString() }}</span>
            <span v-else>--</span>
          </p>
          <span class="balance-core__unit">Token</span>
        </div>
      </article>

      <article class="info-tile">
        <p class="info-label">累计获得</p>
        <p class="info-value">{{ wallet?.totalEarned?.toLocaleString?.() ?? 0 }}</p>
      </article>
      <article class="info-tile">
        <p class="info-label">累计消耗</p>
        <p class="info-value">{{ wallet?.totalSpent?.toLocaleString?.() ?? 0 }}</p>
      </article>
    </div>

    <p
      v-if="errorMessage"
      class="relative z-[2] mt-2 rounded-xl border border-rose-200/70 bg-rose-50/80 px-3 py-2 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
    >
      {{ errorMessage }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import LucideIcon from '~/components/LucideIcon.vue'
import { useGacha } from '~/composables/useGacha'
import type { Wallet } from '~/types/gacha'
import { UiButton } from '~/components/ui/button'

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
const UTC8_TIME_ZONE = 'Asia/Shanghai'
const utc8DateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: UTC8_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})
const utc8DayKeyFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: UTC8_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
})

function toUtc8DayKey(input: Date) {
  const parts = utc8DayKeyFormatter.formatToParts(input)
  const year = parts.find((part) => part.type === 'year')?.value ?? '0000'
  const month = parts.find((part) => part.type === 'month')?.value ?? '00'
  const day = parts.find((part) => part.type === 'day')?.value ?? '00'
  return `${year}-${month}-${day}`
}

const lastClaimText = computed(() => {
  if (!wallet.value?.lastDailyClaimAt) return '未曾签到'
  const last = new Date(wallet.value.lastDailyClaimAt)
  if (Number.isNaN(last.getTime())) return '时间未知'
  return utc8DateTimeFormatter.format(last)
})

const claimedToday = computed(() => {
  if (!wallet.value?.lastDailyClaimAt) return false
  const last = new Date(wallet.value.lastDailyClaimAt)
  if (Number.isNaN(last.getTime())) return false
  return toUtc8DayKey(last) === toUtc8DayKey(new Date())
})

const claimDisabled = computed(() => claimedToday.value || claiming.value)

async function refreshWallet(force = false) {
  if (loading.value) return
  loading.value = true
  errorMessage.value = null
  try {
    const res = await getWallet(force)
    if (!res.ok) {
      const message = res.error || '加载失败'
      errorMessage.value = message
      emit('error', message)
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
      const message = res.error || '签到失败'
      errorMessage.value = message
      emit('error', message)
      return
    }
    emit('claimed', res.data)
    emit('updated', res.data)
  } finally {
    claiming.value = false
  }
}

watch(
  () => state.value.wallet,
  (next) => {
    emit('updated', next ?? null)
  }
)

onMounted(() => {
  if (!wallet.value) {
    refreshWallet()
  }
})

defineExpose({ refresh: refreshWallet })
</script>

<style scoped>
.token-balance-panel::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(125deg, rgba(255, 255, 255, 0.66), rgba(255, 255, 255, 0.2) 48%, rgba(15, 23, 42, 0.05)),
    repeating-linear-gradient(
      -22deg,
      rgba(148, 163, 184, 0.09),
      rgba(148, 163, 184, 0.09) 10px,
      rgba(255, 255, 255, 0) 10px,
      rgba(255, 255, 255, 0) 24px
    );
}

html.dark .token-balance-panel::before {
  background:
    linear-gradient(125deg, rgba(15, 23, 42, 0.86), rgba(15, 23, 42, 0.32) 48%, rgba(15, 23, 42, 0.1)),
    repeating-linear-gradient(
      -22deg,
      rgba(51, 65, 85, 0.22),
      rgba(51, 65, 85, 0.22) 10px,
      rgba(255, 255, 255, 0) 10px,
      rgba(255, 255, 255, 0) 24px
    );
}

.token-balance-panel__glow {
  position: absolute;
  border-radius: 999px;
  filter: blur(40px);
  opacity: 0.7;
  pointer-events: none;
}

.token-balance-panel__glow--a {
  left: -4rem;
  top: -3rem;
  width: 13rem;
  height: 13rem;
  background: rgb(var(--accent) / 0.32);
}

.token-balance-panel__glow--b {
  right: -2.8rem;
  bottom: -3.5rem;
  width: 12rem;
  height: 12rem;
  background: rgb(var(--accent-strong) / 0.28);
}

.info-tile {
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 4.4rem;
  border-radius: 0.85rem;
  border: 1px solid rgba(148, 163, 184, 0.28);
  background: rgba(255, 255, 255, 0.72);
  padding: 0.5rem 0.68rem;
}

html.dark .info-tile {
  border-color: rgba(100, 116, 139, 0.36);
  background: rgba(15, 23, 42, 0.58);
}

.info-label {
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  color: rgb(100 116 139);
}

html.dark .info-label {
  color: rgb(148 163 184);
}

.info-value {
  margin-top: 0.15rem;
  font-size: 1.04rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  color: rgb(15 23 42);
}

.balance-core {
  border-radius: 1rem;
  border: 1px solid rgba(148, 163, 184, 0.28);
  background: rgba(255, 255, 255, 0.76);
  padding: 0.68rem 0.86rem;
}

html.dark .balance-core {
  border-color: rgba(100, 116, 139, 0.4);
  background: rgba(15, 23, 42, 0.62);
}

.balance-core__label {
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  color: rgb(100 116 139);
}

html.dark .balance-core__label {
  color: rgb(148 163 184);
}

.balance-core__value-wrap {
  margin-top: 0.08rem;
  display: flex;
  align-items: flex-end;
  gap: 0.42rem;
  min-width: 0;
}

.balance-core__value {
  margin: 0;
  min-width: 0;
  max-width: 100%;
  font-size: clamp(1.65rem, 5.2vw, 2.42rem);
  font-weight: 850;
  line-height: 1;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: rgb(15 23 42);
}

html.dark .balance-core__value {
  color: rgb(248 250 252);
}

.balance-core__unit {
  margin-bottom: 0.18rem;
  font-size: 0.66rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: rgb(100 116 139);
}

html.dark .balance-core__unit {
  color: rgb(148 163 184);
}

html.dark .info-value {
  color: rgb(241 245 249);
}

@media (max-width: 640px) {
  .balance-core__value {
    font-size: clamp(1.5rem, 9vw, 2.1rem);
  }
}
</style>
