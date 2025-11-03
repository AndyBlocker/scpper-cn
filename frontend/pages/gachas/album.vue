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
          图鉴功能仅对已绑定 Wikidot 的用户开放。请联系管理员完成绑定或前往管理页处理绑定申请。
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

    <div v-else class="space-y-8">
      <section class="grid gap-4 lg:grid-cols-[minmax(0,1.15fr),minmax(0,1fr)]">
        <div class="flex h-full flex-col justify-between gap-5 rounded-3xl border border-neutral-200/70 bg-white/90 p-6 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
          <div class="space-y-3">
            <span class="inline-flex w-fit items-center rounded-full bg-[rgb(var(--accent-strong))]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-[rgb(var(--accent-strong))]">
              图鉴概览
            </span>
            <div class="space-y-2">
              <h2 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">我的收藏图鉴</h2>
              <p class="text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">
                查看不同卡池的收集成果，并从这里返回抽卡或查看全局进度统计。
              </p>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-4 text-xs text-neutral-500 dark:text-neutral-400">
            <span>当前列表 <strong class="text-neutral-900 dark:text-neutral-100">{{ loading ? '—' : visibleCount }}</strong> / 共 {{ loading ? '—' : total }}</span>
            <span>已收集 <strong class="text-emerald-600 dark:text-emerald-300">{{ loading ? '—' : ownedCount }}</strong></span>
            <span>待收集 <strong class="text-neutral-900 dark:text-neutral-100">{{ loading ? '—' : missingCount }}</strong></span>
            <span>上次刷新 {{ lastUpdated || '尚未刷新' }}</span>
          </div>
          <div class="flex flex-wrap gap-3">
            <NuxtLink
              to="/gachas"
              class="inline-flex items-center justify-center rounded-xl border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50"
            >
              返回抽卡
            </NuxtLink>
            <NuxtLink
              to="/gachas/progress"
              class="inline-flex items-center justify-center rounded-xl bg-[rgb(var(--accent-strong))] px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))]"
            >
              查看收集进度
            </NuxtLink>
          </div>
        </div>
        <div class="rounded-3xl border border-neutral-200/70 bg-white/90 p-6 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
          <h3 class="text-sm font-semibold uppercase tracking-[0.18em] text-neutral-400 dark:text-neutral-500">稀有度分布</h3>
          <div v-if="rarityBreakdown.length" class="mt-4 flex flex-wrap gap-2">
            <span
              v-for="entry in rarityBreakdown"
              :key="entry.rarity"
              class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-semibold"
              :class="rarityChipClassMap[entry.rarity]"
            >
              <span>{{ entry.label }}</span>
              <span class="font-medium text-neutral-900 dark:text-neutral-50">{{ entry.owned }}/{{ entry.total }}</span>
            </span>
          </div>
          <p v-else class="mt-4 rounded-xl border border-dashed border-neutral-200/70 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-700/70 dark:text-neutral-400">
            暂无数据，尝试调整筛选条件。
          </p>
        </div>
      </section>

      <section class="rounded-3xl border border-neutral-200/70 bg-white/90 p-6 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
        <header class="flex flex-col gap-2 border-b border-dashed border-neutral-200/70 pb-4 dark:border-neutral-800/60">
          <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50">稀有度快速筛选</h2>
          <p class="text-sm text-neutral-500 dark:text-neutral-400">使用下方按钮切换稀有度，右侧按钮可刷新图鉴数据。</p>
        </header>

        <div class="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button
            type="button"
            class="inline-flex items-center justify-center rounded-lg border border-neutral-200 px-3 py-2 text-xs font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50 disabled:opacity-50"
            :disabled="bulkProcessing || duplicateDismantleCount === 0"
            @click="openBulkDismantle"
          >
            一键分解重复
            <span v-if="duplicateDismantleCount" class="ml-1 text-[10px] text-neutral-400 dark:text-neutral-500">
              ({{ duplicateDismantleCount }})
            </span>
          </button>
          <button
            type="button"
            class="inline-flex items-center justify-center rounded-lg border border-neutral-200 px-3 py-2 text-xs font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50 disabled:opacity-50"
            :disabled="loading"
            @click="refreshInventory"
          >
            刷新
          </button>
        </div>

        <div class="mt-4 flex flex-wrap gap-2">
          <button
            v-for="filter in rarityQuickFilters"
            :key="filter.value"
            type="button"
            class="rounded-full border px-3 py-1 text-xs font-medium transition"
            :class="selectedRarity === filter.value ? 'border-[rgb(var(--accent-strong))] bg-[rgb(var(--accent-strong))]/10 text-[rgb(var(--accent-strong))]' : 'border-neutral-200 text-neutral-500 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-neutral-600 dark:hover:text-neutral-200'"
            @click="selectedRarity = filter.value"
          >
            {{ filter.label }}
          </button>
        </div>
      </section>

      <section class="rounded-3xl border border-neutral-200/70 bg-white/90 p-6 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50">卡片列表</h3>
            <p class="text-sm text-neutral-500 dark:text-neutral-400">
              共 {{ total }} 张，支持分解重复卡。当前页显示 {{ visibleCount }} 张<span v-if="pageRange.start !== '—'">（第 {{ pageRange.start }} - {{ pageRange.end }} 条）</span>，已收集 {{ ownedCount }} 张。
            </p>
          </div>
          <div class="text-xs text-neutral-400 dark:text-neutral-500">更新时间：{{ lastUpdated || '尚未刷新' }}</div>
        </header>

        <div v-if="loading" class="mt-6 rounded-2xl border border-dashed border-neutral-200/70 px-4 py-4 text-center text-sm text-neutral-500 dark:border-neutral-800/70 dark:text-neutral-400">
          正在加载图鉴...
        </div>

        <div v-else-if="items.length" class="mt-6 grid min-w-0 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <div v-for="item in decoratedPaginatedItems" :key="item.cardId" class="group relative min-w-0">
            <GachaCard
              :title="item.title"
              :rarity="item.rarity"
              :tags="item.tags"
              :authors="item.authors"
              :count="item.count"
              :image-url="item.imageUrl || undefined"
              :page-url="cardPageUrl(item)"
              class="transition"
              :class="item.count === 0 ? 'opacity-60' : ''"
            >
              <template #meta>
              </template>
              <template #actions>
                <button
                  v-if="item.count > 0"
                  type="button"
                  class="rounded-lg border border-neutral-200 px-3 py-1 text-xs font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50 disabled:opacity-50"
                  :disabled="dismantling"
                  @click.stop="openDismantle(item)"
                >
                  {{ dismantling && dismantleTarget?.cardId === item.cardId ? '处理中...' : '分解' }}
                </button>
                <span
                  v-else
                  class="rounded-lg border border-dashed border-neutral-200 px-3 py-1 text-xs text-neutral-400 dark:border-neutral-700 dark:text-neutral-500"
                >
                  未收集
                </span>
              </template>
            </GachaCard>
            <div
              v-if="item.count === 0"
              class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl bg-white/75 text-sm font-semibold text-neutral-500 dark:bg-neutral-900/80 dark:text-neutral-400"
            >
              尚未收集
            </div>
          </div>
        </div>

        <div
          v-if="items.length && totalPages > 1"
          class="mt-6 flex flex-col gap-3 rounded-2xl border border-neutral-200/70 bg-white/70 px-4 py-3 text-xs text-neutral-500 dark:border-neutral-800/70 dark:bg-neutral-900/60 sm:flex-row sm:items-center sm:justify-between sm:text-sm"
        >
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="inline-flex items-center rounded-lg border border-neutral-200 px-3 py-1.5 font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50 disabled:opacity-50"
              :disabled="currentPage === 1"
              @click="goToPreviousPage"
            >
              上一页
            </button>
            <button
              type="button"
              class="inline-flex items-center rounded-lg border border-neutral-200 px-3 py-1.5 font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50 disabled:opacity-50"
              :disabled="currentPage === totalPages"
              @click="goToNextPage"
            >
              下一页
            </button>
          </div>
          <div class="flex items-center gap-2">
            <span>第 {{ currentPage }} / {{ totalPages }} 页</span>
            <label class="flex items-center gap-1">
              跳转
              <select
                v-model.number="currentPage"
                class="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-600 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-200"
              >
                <option v-for="page in pageNumbers" :key="page" :value="page">第 {{ page }} 页</option>
              </select>
            </label>
          </div>
          <div class="text-neutral-400 dark:text-neutral-500">
            显示 {{ pageRange.start }} - {{ pageRange.end }} 条
          </div>
        </div>

        <p v-else class="mt-6 rounded-2xl border border-dashed border-neutral-200/70 px-4 py-3 text-sm text-neutral-500 dark:border-neutral-800/70 dark:text-neutral-400">
          暂无符合条件的卡片。尝试调整稀有度筛选。
        </p>
      </section>
    </div>

    <Teleport to="body">
      <transition name="fade">
        <div v-if="dismantleDialog" class="fixed inset-0 z-[70] flex items-center justify-center">
          <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" @click="closeDismantle" />
          <div class="relative z-[71] w-full max-w-md rounded-3xl border border-neutral-200/70 bg-white/95 p-6 shadow-2xl dark:border-neutral-700/70 dark:bg-neutral-900/95">
            <header class="flex items-start justify-between gap-3">
              <div>
                <h3 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50">分解卡片</h3>
                <p class="text-sm text-neutral-500 dark:text-neutral-400">
                  分解后会返还 Token，数量取决于卡片稀有度与重复奖励。
                </p>
              </div>
              <button
                type="button"
                class="inline-flex h-9 w-9 items-center justify-center rounded-full border border-neutral-200/70 text-neutral-500 transition hover:text-neutral-900 dark:border-neutral-700/70 dark:text-neutral-400 dark:hover:text-neutral-100"
                @click="closeDismantle"
              >
                <LucideIcon name="X" class="h-4 w-4" />
              </button>
            </header>

            <div class="mt-4 space-y-3 text-sm text-neutral-600 dark:text-neutral-300">
              <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/70 p-3 dark:border-neutral-800/70 dark:bg-neutral-900/60">
                <h4 class="font-semibold text-neutral-900 dark:text-neutral-100">{{ dismantleTarget?.title }}</h4>
                <p class="text-xs text-neutral-500 dark:text-neutral-400">
                  稀有度：{{ rarityLabel(dismantleTarget?.rarity || 'WHITE') }} · 当前拥有：{{ dismantleTarget?.count ?? 0 }}
                </p>
              </div>

              <label class="flex flex-col gap-1 text-sm text-neutral-500 dark:text-neutral-400">
                分解数量
                <input
                  v-model.number="dismantleCount"
                  type="number"
                  min="1"
                  :max="dismantleTarget?.count ?? 1"
                  class="rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"
                />
              </label>

              <transition name="fade">
                <p
                  v-if="dismantleError"
                  class="rounded-xl border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
                >
                  {{ dismantleError }}
                </p>
              </transition>
            </div>

            <footer class="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                class="rounded-xl border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50"
                @click="closeDismantle"
              >
                取消
              </button>
              <button
                type="button"
                class="rounded-xl bg-[rgb(var(--accent-strong))] px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))] disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="dismantling"
                @click="confirmDismantle"
              >
                <span v-if="dismantling">处理中...</span>
                <span v-else>确认分解</span>
              </button>
            </footer>
          </div>
        </div>
      </transition>
    </Teleport>

    <Teleport to="body">
      <transition name="fade">
        <div v-if="bulkDialog" class="fixed inset-0 z-[70] flex items-center justify-center">
          <div
            class="absolute inset-0 bg-black/60 backdrop-blur-sm"
            @click="bulkProcessing ? null : closeBulkDismantle"
          />
          <div class="relative z-[71] w-full max-w-md rounded-3xl border border-neutral-200/70 bg-white/95 p-6 shadow-2xl dark:border-neutral-700/70 dark:bg-neutral-900/95">
            <header class="flex items-start justify-between gap-3">
              <div>
                <h3 class="text-lg font-semibold text-neutral-900 dark:text-neutral-50">批量分解重复卡片</h3>
                <p class="text-sm text-neutral-500 dark:text-neutral-400">
                  自动分解当前筛选下的重复卡片，仅保留每张卡片的一份。
                </p>
              </div>
              <button
                type="button"
                class="inline-flex h-9 w-9 items-center justify-center rounded-full border border-neutral-200/70 text-neutral-500 transition hover:text-neutral-900 dark:border-neutral-700/70 dark:text-neutral-400 dark:hover:text-neutral-100 disabled:opacity-40"
                :disabled="bulkProcessing"
                @click="closeBulkDismantle"
              >
                <LucideIcon name="X" class="h-4 w-4" />
              </button>
            </header>

            <div class="mt-4 space-y-3 text-sm text-neutral-600 dark:text-neutral-300">
              <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/70 p-3 dark:border-neutral-800/70 dark:bg-neutral-900/60">
                <p>重复卡片：{{ duplicateCardCount }} 张</p>
                <p>将要分解：{{ duplicateDismantleCount }} 张（保留一张）</p>
              </div>

              <p v-if="duplicateDismantleCount === 0" class="text-xs text-neutral-400 dark:text-neutral-500">
                当前筛选下没有可分解的重复卡片。
              </p>

              <p v-if="bulkProcessing" class="rounded-xl border border-[rgb(var(--accent-strong))]/30 bg-[rgb(var(--accent-strong))]/5 px-3 py-2 text-sm text-[rgb(var(--accent-strong))]">
                正在分解第 {{ Math.min(bulkProgress + 1, duplicateCardCount) }} / {{ duplicateCardCount }} 张卡片的重复部分，请稍候...
              </p>

              <transition name="fade">
                <p
                  v-if="bulkError"
                  class="rounded-xl border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
                >
                  {{ bulkError }}
                </p>
              </transition>

              <transition name="fade">
                <div
                  v-if="bulkResult"
                  class="rounded-xl border border-emerald-200/70 bg-emerald-50/70 px-3 py-2 text-sm text-emerald-600 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200"
                >
                  已分解 {{ bulkResult.dismantled }} 张重复卡片，获得 Token {{ bulkResult.reward }}。钱包余额已同步更新。
                </div>
              </transition>

              <div
                v-if="duplicateDialogEntries.length"
                class="max-h-56 overflow-y-auto rounded-xl border border-neutral-200/70 bg-white/80 dark:border-neutral-700/60 dark:bg-neutral-900/60"
              >
                <div class="flex flex-wrap gap-2 px-3 py-3">
                  <span
                    v-for="entry in duplicateDialogEntries"
                    :key="entry.cardId"
                    class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold transition"
                    :class="duplicateChipClassMap[entry.rarity] || duplicateChipClassMap.WHITE"
                  >
                    <span class="h-2 w-2 rounded-full" :class="duplicateChipDotClassMap[entry.rarity] || duplicateChipDotClassMap.WHITE" />
                    <span class="max-w-[10rem] truncate text-[11px] font-medium normal-case">{{ entry.title }}</span>
                    <span class="text-[10px] uppercase tracking-wide opacity-80">{{ rarityLabel(entry.rarity) }}</span>
                    <span class="text-[11px] font-semibold text-neutral-500 dark:text-neutral-300">×{{ entry.duplicateCount }}</span>
                  </span>
                </div>
              </div>
            </div>

            <footer class="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                class="rounded-xl border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50 disabled:opacity-50"
                :disabled="bulkProcessing"
                @click="closeBulkDismantle"
              >
                {{ bulkResult ? '完成' : '取消' }}
              </button>
              <button
                v-if="!bulkResult"
                type="button"
                class="rounded-xl bg-[rgb(var(--accent-strong))] px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))] disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="bulkProcessing || duplicateDismantleCount === 0"
                @click="confirmBulkDismantle"
              >
                <span v-if="bulkProcessing">处理中...</span>
                <span v-else>开始分解</span>
              </button>
            </footer>
          </div>
        </div>
      </transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onActivated, onMounted, ref, watch } from 'vue'
import { navigateTo } from '#app'
import LucideIcon from '~/components/LucideIcon.vue'
import GachaCard from '~/components/GachaCard.vue'
import { useAuth } from '~/composables/useAuth'
import { useGacha, type InventoryItem, type Rarity } from '~/composables/useGacha'
import { usePageAuthors } from '~/composables/usePageAuthors'

const { status, user, loading: authLoading, fetchCurrentUser } = useAuth()
const gacha = useGacha()
const { getConfig, getInventory, dismantle } = gacha

const INVENTORY_PAGE_SIZE = 120
const MAX_INVENTORY_PAGES = 25
const inventoryDateFormatter = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit'
})

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
      console.warn('[gacha-album] fetchCurrentUser failed', error)
    })
  } else if (status.value === 'unauthenticated') {
    navigateTo('/auth/login', { replace: true })
  }
})

const rarityOptions: Array<{ value: Rarity; label: string }> = [
  { value: 'GOLD', label: '金色' },
  { value: 'PURPLE', label: '紫色' },
  { value: 'BLUE', label: '蓝色' },
  { value: 'GREEN', label: '绿色' },
  { value: 'WHITE', label: '白色' }
]
const rarityQuickFilters: Array<{ value: 'ALL' | Rarity; label: string }> = [
  { value: 'ALL', label: '全部' },
  ...rarityOptions
]
const rarityOrder: Record<Rarity, number> = {
  GOLD: 0,
  PURPLE: 1,
  BLUE: 2,
  GREEN: 3,
  WHITE: 4
}
const inventoryTitleCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' })
const rarityChipClassMap: Record<Rarity, string> = {
  GOLD: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-400/60 dark:bg-amber-500/10 dark:text-amber-200',
  PURPLE: 'border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-400/60 dark:bg-purple-500/10 dark:text-purple-200',
  BLUE: 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-400/60 dark:bg-blue-500/10 dark:text-blue-200',
  GREEN: 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-400/60 dark:bg-emerald-500/10 dark:text-emerald-200',
  WHITE: 'border-neutral-200 bg-neutral-50 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300'
}
const duplicateChipClassMap: Record<Rarity, string> = {
  GOLD: 'border-amber-300 bg-amber-50/80 text-amber-700 dark:border-amber-400/60 dark:bg-amber-500/10 dark:text-amber-200',
  PURPLE: 'border-purple-300 bg-purple-50/80 text-purple-700 dark:border-purple-400/60 dark:bg-purple-500/10 dark:text-purple-200',
  BLUE: 'border-blue-300 bg-blue-50/80 text-blue-700 dark:border-blue-400/60 dark:bg-blue-500/10 dark:text-blue-200',
  GREEN: 'border-emerald-300 bg-emerald-50/80 text-emerald-700 dark:border-emerald-400/60 dark:bg-emerald-500/10 dark:text-emerald-200',
  WHITE: 'border-neutral-200 bg-white/80 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300'
}
const duplicateChipDotClassMap: Record<Rarity, string> = {
  GOLD: 'bg-amber-400',
  PURPLE: 'bg-purple-400',
  BLUE: 'bg-blue-400',
  GREEN: 'bg-emerald-400',
  WHITE: 'bg-neutral-400'
}
const selectedRarity = ref<'ALL' | Rarity>('ALL')
const items = ref<InventoryItem[]>([])
const total = ref(0)
const loading = ref(false)
const lastUpdated = ref<string | null>(null)

const pageAuthors = usePageAuthors()
const currentPage = ref(1)
const paginatedItems = computed(() => {
  const start = (currentPage.value - 1) * INVENTORY_PAGE_SIZE
  return items.value.slice(start, start + INVENTORY_PAGE_SIZE)
})
const totalPages = computed(() => {
  if (items.value.length <= 0) return 1
  return Math.max(1, Math.ceil(items.value.length / INVENTORY_PAGE_SIZE))
})
const pageNumbers = computed(() => Array.from({ length: totalPages.value }, (_, index) => index + 1))
const pageRange = computed(() => {
  if (!paginatedItems.value.length) {
    return { start: '—', end: '—' }
  }
  const startIndex = (currentPage.value - 1) * INVENTORY_PAGE_SIZE + 1
  const endIndex = startIndex + paginatedItems.value.length - 1
  return { start: String(startIndex), end: String(endIndex) }
})

const dismantleDialog = ref(false)
const dismantleTarget = ref<InventoryItem | null>(null)
const dismantleCount = ref(1)
const dismantleError = ref<string | null>(null)
const dismantling = ref(false)

const activated = ref(false)

const visibleCount = computed(() => paginatedItems.value.length)
const ownedCount = computed(() => items.value.filter((item) => item.count > 0).length)
const missingCount = computed(() => Math.max(0, total.value - ownedCount.value))
const rarityBreakdown = computed(() => {
  const summary: Record<Rarity, { total: number; owned: number }> = {
    GOLD: { total: 0, owned: 0 },
    PURPLE: { total: 0, owned: 0 },
    BLUE: { total: 0, owned: 0 },
    GREEN: { total: 0, owned: 0 },
    WHITE: { total: 0, owned: 0 }
  }

  items.value.forEach((item) => {
    const entry = summary[item.rarity]
    if (!entry) return
    entry.total += 1
    if (item.count > 0) {
      entry.owned += 1
    }
  })

  return (Object.keys(summary) as Rarity[])
    .map((rarity) => ({
      rarity,
      label: rarityLabel(rarity),
      total: summary[rarity].total,
      owned: summary[rarity].owned
    }))
    .filter((entry) => entry.total > 0)
    .sort((a, b) => rarityOrder[a.rarity] - rarityOrder[b.rarity])
})

const decoratedPaginatedItems = computed(() =>
  paginatedItems.value.map((item) => ({
    ...item,
    authors: pageAuthors.getAuthors(item.wikidotId)
  }))
)

const duplicateEntries = computed(() => items.value.filter((item) => item.count > 1))
const duplicateDialogEntries = computed(() =>
  duplicateEntries.value
    .map((item) => ({
      cardId: item.cardId,
      title: item.title,
      duplicateCount: Math.max(0, item.count - 1),
      rarity: item.rarity
    }))
    .filter((entry) => entry.duplicateCount > 0)
    .sort((a, b) => {
      const diff = b.duplicateCount - a.duplicateCount
      if (diff !== 0) return diff
      return inventoryTitleCollator.compare(a.title, b.title)
    })
)
const duplicateCardCount = computed(() => duplicateDialogEntries.value.length)
const duplicateDismantleCount = computed(() =>
  duplicateEntries.value.reduce((acc, item) => acc + Math.max(0, item.count - 1), 0)
)

const bulkDialog = ref(false)
const bulkProcessing = ref(false)
const bulkError = ref<string | null>(null)
const bulkResult = ref<{ dismantled: number; reward: number } | null>(null)
const bulkProgress = ref(0)

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
function cardPageUrl(item: InventoryItem | null) {
  if (!item) return null
  if (item.wikidotId != null) {
    return `/page/${item.wikidotId}`
  }
  if (item.pageId != null) {
    return `/page/${item.pageId}`
  }
  return null
}

function sortInventoryEntries(list: InventoryItem[]) {
  return [...list].sort((a, b) => {
    const rarityDiff = rarityOrder[a.rarity] - rarityOrder[b.rarity]
    if (rarityDiff !== 0) return rarityDiff
    const ownershipDiff = Number(b.count > 0) - Number(a.count > 0)
    if (ownershipDiff !== 0) return ownershipDiff
    return inventoryTitleCollator.compare(a.title, b.title)
  })
}

async function refreshInventory() {
  if (!activated.value) {
    items.value = []
    total.value = 0
    currentPage.value = 1
    return
  }
  loading.value = true
  try {
    const aggregated: InventoryItem[] = []
    let totalCount = 0
    let offset = 0
    let failed = false

    for (let page = 0; page < MAX_INVENTORY_PAGES; page += 1) {
      const res = await getInventory({
        rarity: selectedRarity.value !== 'ALL' ? selectedRarity.value : undefined,
        limit: INVENTORY_PAGE_SIZE,
        offset
      })
      if (!res.ok) {
        console.warn('[gacha-album] load inventory failed', res.error)
        failed = true
        break
      }
      const batch = res.data ?? []
      aggregated.push(...batch)
      if (res.total != null) {
        totalCount = res.total
      }
      if (!totalCount) {
        totalCount = aggregated.length
      }
      if (aggregated.length >= totalCount) {
        break
      }
      if (batch.length === 0) {
        break
      }
      offset += batch.length
    }

    if (!failed) {
      const sorted = sortInventoryEntries(aggregated)
      items.value = sorted
      total.value = totalCount || sorted.length
      lastUpdated.value = inventoryDateFormatter.format(new Date())
      currentPage.value = 1
    }
  } catch (error) {
    console.warn('[gacha-album] load inventory failed', error)
  } finally {
    loading.value = false
  }
}

async function refreshConfig(force = false) {
  try {
    const res = await getConfig(force)
    if (res.ok && res.data) {
      activated.value = res.data.activated
    }
  } catch (error) {
    console.warn('[gacha-album] refresh config failed', error)
  }
}

watch(totalPages, (next) => {
  const maxPage = Number.isFinite(next) && next > 0 ? Math.floor(next) : 1
  if (currentPage.value > maxPage) {
    currentPage.value = maxPage
  }
  if (currentPage.value < 1) {
    currentPage.value = 1
  }
})

watch(currentPage, (page, prev) => {
  if (!Number.isFinite(page) || page < 1) {
    currentPage.value = 1
    return
  }
  if (page > totalPages.value) {
    currentPage.value = totalPages.value
    return
  }
  if (page !== prev && paginatedItems.value.length === 0 && items.value.length) {
    currentPage.value = Math.max(1, Math.ceil(items.value.length / INVENTORY_PAGE_SIZE))
  }
})

watch([selectedRarity, showBindingBlock], ([, blocked]) => {
  if (!blocked) {
    refreshInventory().catch((error) => {
      console.warn('[gacha-album] inventory refresh failed', error)
    })
  }
})

watch(paginatedItems, (list) => {
  pageAuthors.ensureAuthors(list.map((item) => item.wikidotId))
}, { immediate: true })

watch(bulkDialog, (open) => {
  if (open) {
    pageAuthors.ensureAuthors(duplicateEntries.value.map((item) => item.wikidotId))
  }
})

onMounted(() => {
  if (!showBindingBlock.value) {
    Promise.allSettled([refreshConfig(), refreshInventory()]).catch((error) => {
      console.warn('[gacha-album] initial load failed', error)
    })
  }
})

onActivated(() => {
  if (!showBindingBlock.value) {
    refreshInventory().catch((error) => {
      console.warn('[gacha-album] activated refresh failed', error)
    })
  }
})

watch(showBindingBlock, (blocked) => {
  if (!blocked) {
    Promise.allSettled([refreshConfig(true), refreshInventory()]).catch((error) => {
      console.warn('[gacha-album] load after unblocked failed', error)
    })
  }
})

function goToPreviousPage() {
  if (currentPage.value <= 1) return
  currentPage.value -= 1
}

function goToNextPage() {
  if (currentPage.value >= totalPages.value) return
  currentPage.value += 1
}

function openDismantle(item: InventoryItem) {
  dismantleTarget.value = item
  dismantleCount.value = Math.min(1, item.count || 1)
  if (item.count > 0) {
    dismantleCount.value = 1
  }
  dismantleError.value = null
  dismantleDialog.value = true
}

function closeDismantle() {
  dismantleDialog.value = false
  dismantleTarget.value = null
  dismantleCount.value = 1
  dismantleError.value = null
  dismantling.value = false
}

async function confirmDismantle() {
  if (!dismantleTarget.value) return
  const count = Number(dismantleCount.value)
  if (!Number.isFinite(count) || count <= 0) {
    dismantleError.value = '分解数量无效'
    return
  }
  if (count > dismantleTarget.value.count) {
    dismantleError.value = '数量超过拥有数量'
    return
  }
  dismantling.value = true
  dismantleError.value = null
  try {
    const res = await dismantle(dismantleTarget.value.cardId, count)
    if (!res.ok) {
      dismantleError.value = res.error || '分解失败'
      return
    }
    await Promise.allSettled([refreshInventory(), getConfig(true)])
    closeDismantle()
  } catch (error: any) {
    dismantleError.value = error?.message || '分解失败'
  } finally {
    dismantling.value = false
  }
}

function openBulkDismantle() {
  bulkError.value = null
  bulkResult.value = null
  bulkProgress.value = 0
  bulkDialog.value = true
}

function closeBulkDismantle() {
  if (bulkProcessing.value) return
  bulkDialog.value = false
  bulkError.value = null
  bulkResult.value = null
  bulkProgress.value = 0
}

async function confirmBulkDismantle() {
  if (duplicateDismantleCount.value === 0) {
    bulkError.value = '当前没有可分解的重复卡片'
    return
  }
  const tasks = duplicateEntries.value
    .map((item) => ({ cardId: item.cardId, count: Math.max(0, item.count - 1) }))
    .filter((entry) => entry.count > 0)
  if (tasks.length === 0) {
    bulkError.value = '当前没有可分解的重复卡片'
    return
  }
  bulkProcessing.value = true
  bulkError.value = null
  bulkResult.value = null
  bulkProgress.value = 0
  dismantling.value = true
  let totalReward = 0
  let totalDismantled = 0
  try {
    for (let index = 0; index < tasks.length; index += 1) {
      bulkProgress.value = index
      const task = tasks[index]
      const res = await dismantle(task.cardId, task.count)
      if (!res.ok) {
        bulkError.value = res.error || '分解失败'
        break
      }
      totalReward += res.reward ?? 0
      totalDismantled += task.count
      const target = items.value.find((item) => item.cardId === task.cardId)
      if (target) {
        target.count = res.remaining
      }
    }
    if (!bulkError.value) {
      await Promise.allSettled([refreshInventory(), getConfig(true)])
      bulkResult.value = {
        dismantled: totalDismantled,
        reward: totalReward
      }
    }
  } catch (error: any) {
    bulkError.value = error?.message || '分解失败'
  } finally {
    bulkProcessing.value = false
    dismantling.value = false
    if (!bulkError.value && bulkResult.value == null) {
      bulkResult.value = {
        dismantled: totalDismantled,
        reward: totalReward
      }
    }
    if (!bulkError.value) {
      bulkProgress.value = tasks.length
    }
  }
}
</script>
