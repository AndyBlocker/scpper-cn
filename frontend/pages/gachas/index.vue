<template>
  <div class="mx-auto flex w-full max-w-6xl flex-col gap-8 py-10">
    <div v-if="authPending" class="rounded-3xl border border-dashed border-neutral-200/80 bg-white/70 p-10 text-center text-neutral-500 dark:border-neutral-700/70 dark:bg-neutral-900/60 dark:text-neutral-400">
      正在校验登录状态...
    </div>

    <div
      v-else-if="showBindingBlock"
      class="flex flex-col gap-6 rounded-3xl border border-amber-200/70 bg-amber-50/80 p-8 text-neutral-800 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
    >
      <div class="space-y-2">
        <h2 class="text-2xl font-semibold">需要绑定 Wikidot 账户</h2>
        <p class="text-sm leading-relaxed">
          抽卡玩法仅对已绑定 Wikidot 的用户开放。请联系管理员完成绑定或前往管理页处理绑定申请。
        </p>
      </div>
      <div class="flex flex-wrap gap-3">
        <NuxtLink
          to="/admin"
          class="inline-flex items-center justify-center rounded-xl bg-[rgb(var(--accent-strong))] px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))]"
        >
          前往管理页
        </NuxtLink>
        <NuxtLink
          to="/tools"
          class="inline-flex items-center justify-center rounded-xl border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50"
        >
          返回工具页
        </NuxtLink>
      </div>
    </div>

    <div v-else class="flex flex-col gap-8">
      <section class="grid gap-4 lg:grid-cols-[minmax(0,1.15fr),minmax(0,1fr)]">
        <div class="flex h-full flex-col justify-between gap-5 rounded-3xl border border-neutral-200/80 bg-white/90 p-6 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
          <div class="space-y-4">
            <span
              class="inline-flex w-fit items-center gap-2 rounded-full px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em]"
              :class="heroStatus.class"
            >
              {{ heroStatus.label }}
            </span>
            <div class="space-y-2">
              <h2 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">SCiP 抽卡活动中心</h2>
              <p class="text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
                在这里领取每日奖励、挑选卡池并开始抽卡。图鉴记录全部收集成果，收集进度展示当前完成度。
              </p>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-4 text-xs text-neutral-500 dark:text-neutral-400">
            <span>卡池总数 <strong class="text-neutral-900 dark:text-neutral-100">{{ loadingConfig ? '—' : totalPoolCount }}</strong></span>
            <span>开放中 <strong class="text-[rgb(var(--accent-strong))]">{{ loadingConfig ? '—' : activePoolCount }}</strong></span>
            <span>上次同步 <strong class="text-neutral-900 dark:text-neutral-100">{{ lastUpdatedLabel }}</strong></span>
          </div>
          <div class="flex flex-wrap gap-3">
            <NuxtLink
              to="/gachas/album"
              class="inline-flex items-center justify-center rounded-xl bg-[rgb(var(--accent-strong))] px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))]"
            >
              浏览图鉴
            </NuxtLink>
            <NuxtLink
              to="/gachas/progress"
              class="inline-flex items-center justify-center rounded-xl border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50"
            >
              查看收集进度
            </NuxtLink>
          </div>
        </div>
        <TokenBalance ref="balanceRef" class="h-full" @updated="handleWalletUpdated" @claimed="handleWalletUpdated" @error="emitError" />
      </section>

      <transition name="fade">
        <div
          v-if="errorBanner"
          class="rounded-2xl border border-rose-200/70 bg-rose-50/70 px-4 py-3 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
        >
          {{ errorBanner }}
        </div>
      </transition>

      <section v-if="!activated" class="flex flex-col gap-3 rounded-3xl border border-neutral-200/70 bg-white/90 p-6 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
        <div class="space-y-1">
          <h3 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">激活抽卡功能</h3>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">
            首次使用需要激活抽卡功能，我们会为你创建钱包并同步抽卡活动信息。
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-3 text-sm text-neutral-500 dark:text-neutral-400">
          <button
            type="button"
            class="inline-flex items-center justify-center rounded-xl bg-[rgb(var(--accent-strong))] px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))] disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="activating"
            @click="handleActivate"
          >
            <span v-if="activating">激活中...</span>
            <span v-else>立即激活</span>
          </button>
          <span v-if="activationError" class="text-rose-500 dark:text-rose-300">{{ activationError }}</span>
        </div>
      </section>

      <section v-else class="space-y-8 rounded-3xl border border-neutral-200/70 bg-white/90 p-6 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
        <header class="flex flex-col gap-2 border-b border-dashed border-neutral-200/70 pb-4 dark:border-neutral-800/60">
          <h3 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50">探索卡池</h3>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">
            选择感兴趣的卡池即可进行抽卡。不同卡池拥有独立主题、成本与奖励加成。
          </p>
        </header>

        <div v-if="pools.length" class="space-y-6">
          <div class="flex flex-wrap items-center gap-3">
            <label class="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-400 dark:text-neutral-500">卡池</label>
            <select
              v-model="selectedPoolId"
              class="min-w-[220px] rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
            >
              <option v-for="pool in pools" :key="pool.id" :value="pool.id">
                {{ pool.name }}{{ !pool.isActive ? '（未开放）' : '' }}
              </option>
            </select>
          </div>

          <div class="grid gap-3 md:grid-cols-2">
            <button
              v-for="pool in sortedPools"
              :key="pool.id"
              type="button"
              class="relative flex flex-col gap-3 rounded-2xl border px-4 py-4 text-left text-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent-strong))]"
              :class="[
                poolCardClassMap[poolStatusKey(pool)],
                poolTextClassMap[poolStatusKey(pool)],
                currentPool?.id === pool.id ? 'ring-2 ring-[rgb(var(--accent-strong))] ring-offset-2 ring-offset-white dark:ring-offset-neutral-900 shadow-lg' : ''
              ]"
              @click="selectPool(pool.id)"
            >
              <div class="flex items-center justify-between gap-3">
                <h4 class="text-base font-semibold text-neutral-900 dark:text-neutral-50">{{ pool.name }}</h4>
                <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase" :class="poolBadgeClassMap[poolStatusKey(pool)]">
                  {{ poolStatusLabelMap[poolStatusKey(pool)] }}
                </span>
              </div>
              <p v-if="pool.description" class="text-sm text-neutral-500 dark:text-neutral-400">
                {{ pool.description }}
              </p>
              <dl class="grid gap-3 sm:grid-cols-2">
                <div class="flex flex-col gap-1 rounded-xl bg-white/70 px-3 py-2 dark:bg-neutral-900/60">
                  <dt class="text-xs uppercase tracking-[0.18em] text-neutral-400 dark:text-neutral-500">单抽消耗</dt>
                  <dd class="text-base font-semibold text-neutral-900 dark:text-neutral-100">{{ formatTokens(pool.tokenCost) }} Token</dd>
                </div>
                <div class="flex flex-col gap-1 rounded-xl bg-white/70 px-3 py-2 dark:bg-neutral-900/60">
                  <dt class="text-xs uppercase tracking-[0.18em] text-neutral-400 dark:text-neutral-500">十连消耗</dt>
                  <dd class="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                    {{ formatTokens(pool.tenDrawCost) }} Token
                    <span v-if="tenDrawSavings(pool) > 0" class="ml-1 text-xs font-medium text-emerald-600 dark:text-emerald-300">
                      节省 {{ formatTokens(tenDrawSavings(pool)) }}
                    </span>
                  </dd>
                </div>
              </dl>
              <div class="flex flex-wrap gap-2 text-[11px] text-neutral-400 dark:text-neutral-500">
                <span>开放：{{ poolRangeMap[pool.id]?.start || '未设置' }}</span>
                <span>结束：{{ poolRangeMap[pool.id]?.end || '未设置' }}</span>
              </div>
            </button>
          </div>

          <div
            v-if="currentPool"
            class="flex flex-col gap-4 rounded-2xl border border-neutral-200/70 bg-neutral-50/80 p-5 text-sm text-neutral-600 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/60 dark:text-neutral-300 md:flex-row md:items-center md:justify-between"
          >
            <div class="space-y-2">
              <h4 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                {{ currentPool.name }}
              </h4>
              <p v-if="currentPool.description" class="text-sm text-neutral-500 dark:text-neutral-400">
                {{ currentPool.description }}
              </p>
              <div class="flex flex-wrap gap-3 text-xs text-neutral-400 dark:text-neutral-500">
                <span>开放时间：{{ poolRangeMap[currentPool.id]?.label || '长期开放' }}</span>
                <span>重复返还：{{ formatTokens(currentPool.rewardPerDuplicate) }} Token</span>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-3 text-sm text-neutral-500 dark:text-neutral-400">
              <button
                type="button"
                class="inline-flex min-w-[140px] flex-col items-center justify-center rounded-2xl bg-[rgb(var(--accent-strong))] px-5 py-3 text-sm font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))] disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="drawing || !currentPool?.isActive"
                @click="handleDraw(1)"
              >
                <span class="text-base font-semibold">立即抽卡</span>
                <span class="text-[11px] text-white/80">消耗 {{ formatTokens(currentPool.tokenCost) }} Token</span>
              </button>
              <button
                type="button"
                class="inline-flex min-w-[140px] flex-col items-center justify-center rounded-2xl bg-neutral-900 px-5 py-3 text-sm font-semibold text-white shadow transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-neutral-100"
                :disabled="drawing || !currentPool?.isActive"
                @click="handleDraw(10)"
              >
                <span class="text-base font-semibold">十连抽</span>
                <span class="text-[11px] text-white/80 dark:text-neutral-700">消耗 {{ formatTokens(currentPool.tenDrawCost) }} Token</span>
              </button>
              <span v-if="drawing" class="w-full text-sm text-neutral-500 dark:text-neutral-400 md:w-auto">抽卡进行中，请稍候...</span>
              <span v-else-if="!currentPool?.isActive" class="w-full text-sm text-neutral-500 dark:text-neutral-400 md:w-auto">卡池未开放，暂不可抽取。</span>
            </div>
          </div>
        </div>

        <p v-else class="rounded-2xl border border-dashed border-neutral-200/70 px-4 py-4 text-sm text-neutral-500 dark:border-neutral-800/70 dark:text-neutral-400">
          暂无可用卡池，请稍后再试。
        </p>
      </section>

      <section v-if="boosts.length" class="rounded-3xl border border-neutral-200/70 bg-white/90 p-6 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
        <header class="flex items-center justify-between gap-3">
          <div>
            <h3 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50">当前概率加成</h3>
            <p class="text-sm text-neutral-500 dark:text-neutral-400">满足条件时，对应卡片权重将提升。</p>
          </div>
          <NuxtLink to="/gachas/album" class="inline-flex items-center gap-1 text-xs font-medium text-[rgb(var(--accent-strong))] hover:underline">
            查看图鉴
          </NuxtLink>
        </header>
        <ul class="mt-4 space-y-3 text-sm text-neutral-600 dark:text-neutral-300">
          <li
            v-for="boost in boosts"
            :key="boost.id"
            class="rounded-2xl border border-dashed border-emerald-200/70 bg-emerald-50/70 px-4 py-3 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100"
          >
            <div class="flex items-center justify-between">
              <span class="font-semibold text-emerald-700 dark:text-emerald-200">倍率 ×{{ boost.weightMultiplier }}</span>
              <span class="text-xs text-neutral-400 dark:text-neutral-500">
                {{ formatBoostTime(boost.startsAt, boost.endsAt) }}
              </span>
            </div>
            <div class="mt-2 space-y-1 text-xs">
              <div>包含标签：{{ boost.includeTags.length ? boost.includeTags.join(', ') : '不限' }}</div>
              <div>排除标签：{{ boost.excludeTags.length ? boost.excludeTags.join(', ') : '无' }}</div>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="history.length" class="rounded-3xl border border-neutral-200/80 bg-white/90 p-6 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
        <header class="flex items-center justify-between gap-3">
          <div>
            <h3 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50">最近抽卡记录</h3>
            <p class="text-sm text-neutral-500 dark:text-neutral-400">展示最近 {{ history.length }} 次抽取结果。</p>
          </div>
          <button type="button" class="text-xs font-medium text-neutral-500 hover:text-neutral-900 dark:text-neutral-400 dark:hover:text-neutral-200" @click="refreshHistory">
            刷新
          </button>
        </header>
        <div class="mt-4 space-y-4">
          <article
            v-for="record in history"
            :key="record.id"
            class="rounded-2xl border border-neutral-200/70 bg-neutral-50/80 p-4 text-sm dark:border-neutral-800/70 dark:bg-neutral-900/60 dark:text-neutral-300"
          >
            <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <span>{{ formatDate(record.createdAt) }}</span>
              <span>{{ record.poolName || '卡池' }} · 抽取 {{ record.count }} · 消耗 {{ record.tokensSpent }} Token</span>
              <span>返还 {{ record.tokensReward }} Token</span>
            </div>
            <div class="mt-3 flex flex-wrap gap-2 text-xs">
              <span
                v-for="item in record.items"
                :key="`${record.id}-${item.cardId}`"
                class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition"
                :class="historyChipClassMap[item.rarity] || historyChipClassMap.WHITE"
              >
                <span class="h-2 w-2 rounded-full" :class="historyChipDotClassMap[item.rarity] || historyChipDotClassMap.WHITE" />
                <span class="max-w-[10rem] truncate text-[11px] font-medium normal-case">{{ item.title }}</span>
                <span class="text-[10px] uppercase tracking-wide opacity-80">{{ rarityLabel(item.rarity) }}</span>
              </span>
            </div>
          </article>
        </div>
      </section>
    </div>

    <GachaDrawResultModal
      :open="resultModalOpen"
      :result="lastResult"
      @close="closeResultModal"
      @view-album="navigateTo('/gachas/album')"
      @draw-again="drawAgain"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { navigateTo } from '#app'
import TokenBalance from '~/components/TokenBalance.vue'
import GachaDrawResultModal from '~/components/GachaDrawResultModal.vue'
import { useAuth } from '~/composables/useAuth'
import { useGacha, type DrawResult, type GachaPool, type GlobalBoost, type HistoryItem, type Wallet, type Rarity } from '~/composables/useGacha'

type PoolStatusKey = 'active' | 'upcoming' | 'ended' | 'inactive'

const dateTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
})

const poolStatusLabelMap: Record<PoolStatusKey, string> = {
  active: '开放中',
  upcoming: '即将开放',
  inactive: '未开放',
  ended: '已结束'
}

const poolBadgeClassMap: Record<PoolStatusKey, string> = {
  active: 'bg-emerald-50/90 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200',
  upcoming: 'bg-amber-50/90 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200',
  inactive: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800/70 dark:text-neutral-300',
  ended: 'bg-neutral-100 text-neutral-500 dark:bg-neutral-800/70 dark:text-neutral-400'
}

const poolCardClassMap: Record<PoolStatusKey, string> = {
  active: 'border-emerald-200/70 bg-emerald-50/50 dark:border-emerald-500/40 dark:bg-emerald-500/10',
  upcoming: 'border-amber-200/70 bg-amber-50/50 dark:border-amber-500/40 dark:bg-amber-500/10',
  inactive: 'border-neutral-200/70 bg-white/70 dark:border-neutral-700/60 dark:bg-neutral-900/50',
  ended: 'border-neutral-200/70 bg-neutral-100/60 dark:border-neutral-700/60 dark:bg-neutral-900/50'
}

const poolTextClassMap: Record<PoolStatusKey, string> = {
  active: 'text-neutral-600 dark:text-neutral-300',
  upcoming: 'text-neutral-600 dark:text-neutral-300',
  inactive: 'text-neutral-500 dark:text-neutral-400',
  ended: 'text-neutral-500 dark:text-neutral-500'
}
const historyChipClassMap: Record<Rarity, string> = {
  GOLD: 'border-amber-300 bg-amber-50/80 text-amber-700 dark:border-amber-400/60 dark:bg-amber-500/10 dark:text-amber-200',
  PURPLE: 'border-purple-300 bg-purple-50/80 text-purple-700 dark:border-purple-400/60 dark:bg-purple-500/10 dark:text-purple-200',
  BLUE: 'border-blue-300 bg-blue-50/80 text-blue-700 dark:border-blue-400/60 dark:bg-blue-500/10 dark:text-blue-200',
  GREEN: 'border-emerald-300 bg-emerald-50/80 text-emerald-700 dark:border-emerald-400/60 dark:bg-emerald-500/10 dark:text-emerald-200',
  WHITE: 'border-neutral-200 bg-white/80 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300'
}
const historyChipDotClassMap: Record<Rarity, string> = {
  GOLD: 'bg-amber-400',
  PURPLE: 'bg-purple-400',
  BLUE: 'bg-blue-400',
  GREEN: 'bg-emerald-400',
  WHITE: 'bg-neutral-400'
}

const poolPriorityMap: Record<PoolStatusKey, number> = {
  active: 0,
  upcoming: 1,
  inactive: 2,
  ended: 3
}

const { status, user, loading: authLoading, fetchCurrentUser } = useAuth()
const gacha = useGacha()
const { getConfig, getWallet, draw, getHistory, listGlobalBoosts, activate } = gacha
const gachaState = gacha.state

const authPending = computed(() => status.value === 'unknown' || authLoading.value)
const showBindingBlock = computed(() => status.value === 'authenticated' && !user.value?.linkedWikidotId)

watch(status, (next) => {
  if (next === 'unauthenticated') {
    navigateTo('/auth/login', { replace: true })
  }
})

onMounted(() => {
  if (status.value === 'unknown') {
    fetchCurrentUser().catch((error) => {
      console.warn('[gacha] fetchCurrentUser failed', error)
    })
  } else if (status.value === 'unauthenticated') {
    navigateTo('/auth/login', { replace: true })
  }
})

const balanceRef = ref<InstanceType<typeof TokenBalance> | null>(null)
const errorBanner = ref<string | null>(null)
const activating = ref(false)
const activationError = ref<string | null>(null)
const drawing = ref(false)

const pools = ref<GachaPool[]>([])
const selectedPoolId = ref<string | null>(null)
const boosts = ref<GlobalBoost[]>([])
const activated = ref(false)
const history = ref<HistoryItem[]>([])
const lastResult = ref<DrawResult | null>(null)
const resultModalOpen = ref(false)
const loadingConfig = ref(false)

const totalPoolCount = computed(() => pools.value.length)
const activePoolCount = computed(() => pools.value.filter((pool) => pool.isActive).length)
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

const heroStatus = computed<{ label: string; class: string }>(() => {
  if (loadingConfig.value) {
    return { label: '同步卡池中', class: 'bg-sky-50/90 text-sky-600 dark:bg-sky-500/20 dark:text-sky-200' }
  }
  if (activated.value) {
    return { label: '功能已激活', class: 'bg-emerald-50/90 text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-200' }
  }
  return { label: '待激活', class: 'bg-amber-50/90 text-amber-700 dark:bg-amber-500/20 dark:text-amber-200' }
})

const currentPool = computed<GachaPool | null>(() => {
  if (!pools.value.length) return null
  if (selectedPoolId.value) {
    return pools.value.find((pool) => pool.id === selectedPoolId.value) ?? null
  }
  return pools.value[0] ?? null
})

function selectPool(poolId: string) {
  selectedPoolId.value = poolId
}

function emitError(message: string) {
  if (!message) return
  errorBanner.value = message
  window.setTimeout(() => {
    if (errorBanner.value === message) {
      errorBanner.value = null
    }
  }, 5000)
}

function handleWalletUpdated(wallet: Wallet | null) {
  if (wallet) {
    gachaState.value.wallet = wallet
    gachaState.value.walletFetchedAt = new Date().toISOString()
  }
}

function formatDate(input: string | null) {
  if (!input) return '未定'
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return input
  return date.toLocaleString()
}

const lastUpdatedLabel = computed(() => {
  if (loadingConfig.value) return '同步中...'
  const fetchedAt = gachaState.value.configFetchedAt
  if (!fetchedAt) return '尚未同步'
  return formatDateCompact(fetchedAt) ?? formatDate(fetchedAt)
})

function formatDateCompact(input: string | null) {
  if (!input) return null
  const date = new Date(input)
  if (Number.isNaN(date.getTime())) return null
  return dateTimeFormatter.format(date)
}

function toTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const ts = new Date(value).getTime()
  return Number.isNaN(ts) ? null : ts
}

function resolvePoolRange(pool: GachaPool) {
  const start = formatDateCompact(pool.startsAt)
  const end = formatDateCompact(pool.endsAt)
  return {
    start: start || '未设置',
    end: end || '未设置',
    label: start && end ? `${start} ~ ${end}` : start ? `${start} 开始` : end ? `截止 ${end}` : '长期开放'
  }
}

function poolStatusKey(pool: GachaPool): PoolStatusKey {
  const now = Date.now()
  if (pool.isActive) return 'active'
  const start = toTimestamp(pool.startsAt)
  const end = toTimestamp(pool.endsAt)
  if (start != null && start > now) return 'upcoming'
  if (end != null && end < now) return 'ended'
  return 'inactive'
}

function formatBoostTime(startsAt: string | null, endsAt: string | null) {
  const start = startsAt ? formatDate(startsAt) : '即刻生效'
  const end = endsAt ? formatDate(endsAt) : '无结束时间'
  return `${start} ~ ${end}`
}

function tenDrawSavings(pool: GachaPool) {
  const diff = pool.tokenCost * 10 - pool.tenDrawCost
  return diff > 0 ? diff : 0
}

function formatTokens(value: number | null | undefined) {
  const numeric = Number(value ?? 0)
  if (!Number.isFinite(numeric)) return '0'
  return numeric.toLocaleString()
}

function rarityLabel(rarity: Rarity) {
  switch (rarity) {
    case 'WHITE':
      return '白色'
    case 'GREEN':
      return '绿色'
    case 'BLUE':
      return '蓝色'
    case 'PURPLE':
      return '紫色'
    case 'GOLD':
      return '金色'
    default:
      return rarity
  }
}

async function refreshHistory() {
  if (!activated.value) {
    history.value = []
    return
  }
  try {
    const res = await getHistory({ poolId: currentPool.value?.id, limit: 8 })
    if (res.ok) {
      history.value = res.data ?? []
    }
  } catch (error) {
    console.warn('[gacha] load history failed', error)
  }
}

async function refreshConfig(force = false) {
  loadingConfig.value = true
  try {
    const res = await getConfig(force)
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
    }
    const boostRes = await listGlobalBoosts({ active: true })
    if (boostRes.ok) {
      boosts.value = boostRes.data ?? []
    }
  } catch (error) {
    console.warn('[gacha] refresh config failed', error)
  } finally {
    loadingConfig.value = false
  }
}

async function loadInitial() {
  await Promise.allSettled([getWallet(), refreshConfig()])
  await refreshHistory()
}

onMounted(() => {
  if (!showBindingBlock.value) {
    loadInitial().catch((error) => {
      console.warn('[gacha] initial load failed', error)
    })
  }
})

watch(selectedPoolId, () => {
  refreshHistory().catch((error) => {
    console.warn('[gacha] history refresh failed', error)
  })
})

watch(showBindingBlock, (blocked) => {
  if (!blocked) {
    loadInitial().catch((error) => {
      console.warn('[gacha] load after bind failed', error)
    })
  }
})

async function handleActivate() {
  if (activating.value) return
  activating.value = true
  activationError.value = null
  try {
    const res = await activate()
    if (!res.ok) {
      activationError.value = res.error || '激活失败'
      return
    }
    await Promise.allSettled([getWallet(true), refreshConfig(true)])
    activated.value = true
    await refreshHistory()
  } catch (error: any) {
    activationError.value = error?.message || '激活失败'
  } finally {
    activating.value = false
  }
}

async function handleDraw(count: number) {
  if (drawing.value) return
  const pool = currentPool.value
  if (!pool) {
    emitError('没有可用的卡池')
    return
  }
  if (!pool.isActive) {
    emitError('卡池尚未开放')
    return
  }
  drawing.value = true
  try {
    const res = await draw({ poolId: pool.id, count })
    if (!res.ok || !res.data) {
      emitError(res.error || '抽卡失败')
      return
    }
    lastResult.value = res.data
    resultModalOpen.value = true
    if (res.data.wallet) {
      gachaState.value.wallet = res.data.wallet
      gachaState.value.walletFetchedAt = new Date().toISOString()
    } else {
      await getWallet(true)
    }
    await refreshHistory()
  } catch (error: any) {
    emitError(error?.message || '抽卡失败')
  } finally {
    drawing.value = false
  }
}

function drawAgain() {
  resultModalOpen.value = false
  setTimeout(() => {
    handleDraw(10)
  }, 260)
}

function closeResultModal() {
  resultModalOpen.value = false
}

</script>
