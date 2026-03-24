<template>
  <section id="metrics" class="space-y-3">
    <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-center gap-2">
        <h2 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">核心指标</h2>
        <button
          type="button"
          class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-[var(--g-accent)] hover:border-[var(--g-accent-border)] dark:text-neutral-400 dark:hover:text-[var(--g-accent)]"
          @click="$emit('copy-anchor', 'metrics')"
          :title="copiedAnchorId === 'metrics' ? '已复制链接' : '复制该段落链接'"
        >
          <LucideIcon v-if="copiedAnchorId === 'metrics'" name="Check" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
          <LucideIcon v-else name="Link" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
        </button>
      </div>
      <span v-if="metricsUpdatedAt" class="text-xs text-neutral-500 dark:text-neutral-400">
        更新于 {{ formatDate(metricsUpdatedAt) }}
      </span>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <!-- 评分 -->
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 bg-white dark:bg-neutral-900 shadow-sm">
        <div class="flex items-start justify-between">
          <div class="text-[12px] text-neutral-600 dark:text-neutral-400">评分</div>
          <div class="text-lg font-bold text-neutral-900 dark:text-neutral-100" :title="ratingTooltip">
            {{ totalScoreDisplay }}
          </div>
        </div>
        <div class="mt-2 grid grid-cols-2 text-[11px]">
          <div class="text-green-600 dark:text-green-400">↑ {{ upvotes }}</div>
          <div class="text-red-600 dark:text-red-400 text-right">↓ {{ downvotes }}</div>
        </div>
        <div class="mt-2 h-1.5 w-full rounded bg-neutral-200 dark:bg-neutral-800 overflow-hidden flex">
          <div class="h-full bg-[var(--g-accent)]" :style="{ width: upvotePct + '%' }" aria-hidden="true"></div>
          <div class="h-full bg-red-500" :style="{ width: downvotePct + '%' }" aria-hidden="true"></div>
        </div>
      </div>

      <!-- 支持率 -->
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 bg-white dark:bg-neutral-900 shadow-sm">
        <div class="flex items-start justify-between">
          <div class="text-[12px] text-neutral-600 dark:text-neutral-400">支持率</div>
          <div class="text-lg font-bold text-neutral-900 dark:text-neutral-100" :title="voteTooltip">
            {{ likeRatioPct.toFixed(0) }}%
          </div>
        </div>
        <div class="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">总票数 {{ totalVotes }}</div>
        <div class="mt-2 h-1.5 w-full rounded bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
          <div class="h-full bg-[var(--g-accent)]" :style="{ width: likeRatioPct + '%' }" aria-hidden="true"></div>
        </div>
      </div>

      <!-- Wilson95 下界 -->
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 bg-white dark:bg-neutral-900 shadow-sm">
        <div class="flex items-start justify-between">
          <div class="text-[12px] text-neutral-600 dark:text-neutral-400">Wilson 95% 下界</div>
          <div class="text-lg font-bold text-neutral-900 dark:text-neutral-100" :title="wilsonTooltip">
            {{ (wilsonLB * 100).toFixed(1) }}%
          </div>
        </div>
        <div class="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
          在相同票数下更稳健的支持率估计
        </div>
        <div class="mt-2 h-1.5 w-full rounded bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
          <div class="h-full bg-[var(--g-accent)]" :style="{ width: Math.max(0, Math.min(100, wilsonLB * 100)) + '%' }" aria-hidden="true"></div>
        </div>
      </div>

      <!-- 争议指数 -->
      <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 bg-white dark:bg-neutral-900 shadow-sm">
        <div class="flex items-start justify-between">
          <div class="text-[12px] text-neutral-600 dark:text-neutral-400">争议指数</div>
          <div class="text-lg font-bold text-neutral-900 dark:text-neutral-100">
            {{ controversyIdx.toFixed(3) }}
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { formatDateUtc8 } from '~/utils/timezone'

defineProps<{
  totalScoreDisplay: string
  upvotes: number
  downvotes: number
  totalVotes: number
  upvotePct: number
  downvotePct: number
  likeRatioPct: number
  wilsonLB: number
  controversyIdx: number
  ratingTooltip: string
  voteTooltip: string
  wilsonTooltip: string
  metricsUpdatedAt: string | null
  copiedAnchorId: string | null
}>()

defineEmits<{
  'copy-anchor': [sectionId: string]
}>()

function formatDate(dateStr: string) {
  if (!dateStr) return 'N/A'
  return formatDateUtc8(dateStr, { year: 'numeric', month: 'short', day: 'numeric' }) || 'N/A'
}
</script>
