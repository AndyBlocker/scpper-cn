<template>
  <div class="mx-auto flex w-full max-w-5xl flex-col gap-8 py-10">
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
          收集进度仅对已绑定 Wikidot 的用户开放。请联系管理员完成绑定或前往管理页处理绑定申请。
        </p>
      </div>
      <div class="flex flex-wrap gap-3">
        <NuxtLink
          to="/admin"
          class="inline-flex items-center justify-center rounded-xl bg-[rgb(var(--accent-strong))] px-4 py-2 text-sm font-semibold text白 shadow transition hover:bg-[rgb(var(--accent))]"
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

    <div v-else class="space-y-8">
      <section class="rounded-3xl border border-neutral-200/70 bg-white/85 p-6 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
        <header class="flex flex-col gap-2 border-b border-dashed border-neutral-200/70 pb-4 dark:border-neutral-800/60">
          <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50">收集进度</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">
            统计当前卡池卡片的完成度。收集到至少一张卡片后即可在此查看完成情况。
          </p>
        </header>

        <div class="mt-4 flex flex-wrap items-center gap-3">
          <label class="text-xs font-semibold uppercase tracking-[0.2em] text-neutral-400 dark:text-neutral-500">卡池</label>
          <select
            v-model="selectedPoolId"
            class="rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
          >
            <option v-for="pool in pools" :key="pool.id" :value="pool.id">
              {{ pool.name }}
            </option>
          </select>
          <button
            type="button"
            class="inline-flex items-center justify-center rounded-lg border border-neutral-200 px-3 py-2 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50"
            @click="refreshProgress"
          >
            刷新
          </button>
        </div>
      </section>

      <section class="rounded-3xl border border-neutral-200/70 bg-white/85 p-6 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
        <div v-if="loading" class="rounded-2xl border border-dashed border-neutral-200/70 px-4 py-4 text-center text-sm text-neutral-500 dark:border-neutral-800/70 dark:text-neutral-400">
          正在计算进度...
        </div>

        <div v-else>
          <div class="rounded-2xl border border-neutral-200/70 bg-neutral-50/70 p-4 text-sm dark:border-neutral-800/70 dark:bg-neutral-900/60 dark:text-neutral-300">
            <div class="flex items-center justify-between">
              <div>
                <h3 class="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                  总进度：{{ progress?.collected || 0 }} / {{ progress?.total || 0 }}
                </h3>
                <p class="text-xs text-neutral-500 dark:text-neutral-400">至少获得一张卡片即可计入收集进度。</p>
              </div>
              <div class="text-sm font-semibold text-[rgb(var(--accent-strong))]">
                完成度 {{ totalPercent }}%
              </div>
            </div>
            <div class="mt-3 h-3 overflow-hidden rounded-full bg-neutral-200/70 dark:bg-neutral-800/70">
              <div
                class="h-full rounded-full bg-[rgb(var(--accent-strong))]"
                :style="{ width: `${totalPercent}%` }"
              />
            </div>
          </div>

          <div class="mt-6 grid gap-4 sm:grid-cols-2">
            <div
              v-for="entry in progress?.byRarity ?? []"
              :key="entry.rarity"
              class="rounded-2xl border border-neutral-200/70 bg-neutral-50/70 p-4 text-sm dark:border-neutral-800/70 dark:bg-neutral-900/60 dark:text-neutral-300"
            >
              <div class="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
                <span>{{ rarityLabel(entry.rarity) }}</span>
                <span>{{ entry.collected }} / {{ entry.total }}</span>
              </div>
              <div class="mt-2 h-2 overflow-hidden rounded-full bg-neutral-200/70 dark:bg-neutral-800/70">
                <div
                  class="h-full rounded-full bg-[rgb(var(--accent))]"
                  :style="{ width: `${rarityPercent(entry)}%` }"
                />
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { navigateTo } from '#app'
import { useAuth } from '~/composables/useAuth'
import { useGacha, type GachaPool, type Progress, type Rarity } from '~/composables/useGacha'

const { status, user, loading: authLoading, fetchCurrentUser } = useAuth()
const gacha = useGacha()
const { getConfig, getProgress } = gacha

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
      console.warn('[gacha-progress] fetchCurrentUser failed', error)
    })
  } else if (status.value === 'unauthenticated') {
    navigateTo('/auth/login', { replace: true })
  }
})

const pools = ref<GachaPool[]>([])
const selectedPoolId = ref<string | null>(null)
const progress = ref<Progress | null>(null)
const loading = ref(false)

const totalPercent = computed(() => {
  if (!progress.value || progress.value.total === 0) return 0
  return Math.min(100, Math.round((progress.value.collected / progress.value.total) * 100))
})

function rarityLabel(rarity: Rarity) {
  switch (rarity) {
    case 'GOLD':
      return '金色'
    case 'PURPLE':
      return '紫色'
    case 'BLUE':
      return '蓝色'
    case 'GREEN':
      return '绿色'
    case 'WHITE':
      return '白色'
    default:
      return rarity
  }
}

function rarityPercent(entry: { collected: number; total: number }) {
  if (!entry.total) return 0
  return Math.min(100, Math.round((entry.collected / entry.total) * 100))
}

async function refreshConfig(force = false) {
  try {
    const res = await getConfig(force)
    if (res.ok && res.data) {
      pools.value = res.data.pools ?? []
      if (!selectedPoolId.value && pools.value.length) {
        selectedPoolId.value = pools.value[0].id
      } else if (selectedPoolId.value && !pools.value.some((pool) => pool.id === selectedPoolId.value)) {
        selectedPoolId.value = pools.value[0]?.id ?? null
      }
    }
  } catch (error) {
    console.warn('[gacha-progress] refresh config failed', error)
  }
}

async function refreshProgress() {
  if (!selectedPoolId.value) return
  loading.value = true
  try {
    const res = await getProgress({ poolId: selectedPoolId.value })
    if (res.ok) {
      progress.value = res.data
    } else {
      progress.value = null
      console.warn('[gacha-progress] load progress failed', res.error)
    }
  } catch (error) {
    console.warn('[gacha-progress] load progress failed', error)
  } finally {
    loading.value = false
  }
}

watch(selectedPoolId, () => {
  if (!showBindingBlock.value) {
    refreshProgress().catch((error) => {
      console.warn('[gacha-progress] progress refresh failed', error)
    })
  }
})

onMounted(() => {
  if (!showBindingBlock.value) {
    Promise.allSettled([refreshConfig(), refreshProgress()]).catch((error) => {
      console.warn('[gacha-progress] initial load failed', error)
    })
  }
})

watch(showBindingBlock, (blocked) => {
  if (!blocked) {
    Promise.allSettled([refreshConfig(true), refreshProgress()]).catch((error) => {
      console.warn('[gacha-progress] load after unblocked failed', error)
    })
  }
})
</script>
