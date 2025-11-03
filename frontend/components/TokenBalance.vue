<template>
  <div class="rounded-2xl border border-neutral-200/80 bg-white/85 p-5 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div class="space-y-1">
        <div class="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500 dark:text-neutral-400">Token 余额</div>
        <div class="text-3xl font-bold text-neutral-900 dark:text-white">
          <span v-if="wallet">{{ wallet.balance.toLocaleString() }}</span>
          <span v-else>--</span>
        </div>
        <div class="flex flex-wrap gap-3 text-xs text-neutral-500 dark:text-neutral-400">
          <span>累计获得 <strong class="font-semibold text-neutral-700 dark:text-neutral-100">{{ wallet?.totalEarned?.toLocaleString?.() ?? 0 }}</strong></span>
          <span>累计消耗 <strong class="font-semibold text-neutral-700 dark:text-neutral-100">{{ wallet?.totalSpent?.toLocaleString?.() ?? 0 }}</strong></span>
        </div>
      </div>

      <div class="flex flex-col items-stretch gap-2 sm:items-end">
        <button
          type="button"
          class="inline-flex items-center justify-center rounded-xl bg-[rgb(var(--accent-strong))] px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))] disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="claimDisabled"
          @click="handleClaim"
        >
          <span v-if="claiming">领取中...</span>
          <span v-else-if="claimedToday">
            今日已领取
          </span>
          <span v-else>领取每日签到</span>
        </button>
        <button
          type="button"
          class="flex items-center gap-1 text-xs font-medium text-neutral-500 hover:text-[rgb(var(--accent-strong))] dark:text-neutral-400 dark:hover:text-[rgb(var(--accent))]"
          :disabled="loading"
          @click="refreshWallet(true)"
        >
          <LucideIcon name="RefreshCcw" class="h-3.5 w-3.5" />
          <span v-if="loading">刷新中...</span>
          <span v-else>刷新余额</span>
        </button>
      </div>
    </div>

    <transition name="fade" mode="out-in">
      <p
        v-if="errorMessage"
        key="error"
        class="mt-4 rounded-lg border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
      >
        {{ errorMessage }}
      </p>
      <p v-else key="status" class="mt-4 text-xs text-neutral-400 dark:text-neutral-500">
        上次签到：{{ lastClaimText }}
      </p>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import LucideIcon from '~/components/LucideIcon.vue'
import { useGacha, type Wallet } from '~/composables/useGacha'

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

const lastClaimText = computed(() => {
  if (!wallet.value?.lastDailyClaimAt) return '未曾签到'
  const last = new Date(wallet.value.lastDailyClaimAt)
  if (Number.isNaN(last.getTime())) return '时间未知'
  return last.toLocaleString()
})

const claimedToday = computed(() => {
  if (!wallet.value?.lastDailyClaimAt) return false
  const last = new Date(wallet.value.lastDailyClaimAt)
  if (Number.isNaN(last.getTime())) return false
  const today = new Date()
  return last.getFullYear() === today.getFullYear()
    && last.getMonth() === today.getMonth()
    && last.getDate() === today.getDate()
})

const claimDisabled = computed(() => claimedToday.value || claiming.value)

async function refreshWallet(force = false) {
  if (loading.value) return
  loading.value = true
  errorMessage.value = null
  try {
    const res = await getWallet(force)
    if (!res.ok) {
      errorMessage.value = res.error || '加载失败'
      emit('error', errorMessage.value)
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
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
