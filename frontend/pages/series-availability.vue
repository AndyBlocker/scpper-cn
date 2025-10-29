<template>
  <div class="max-w-6xl mx-auto w-full py-10 space-y-8">
    <header class="space-y-3">
      <div class="inline-flex items-center gap-2 rounded-full border border-[rgba(var(--accent),0.35)] bg-[rgba(var(--accent),0.08)] px-4 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--accent))]">
        <span>系列占用</span>
      </div>
      <div>
        <h1 class="text-2xl sm:text-3xl font-semibold text-neutral-900 dark:text-neutral-50">SCP-CN 系列占用与空闲编号</h1>
        <p class="text-sm text-neutral-600 dark:text-neutral-300">展示每个系列的使用进度，并合并连续空闲编号为区间显示。</p>
      </div>
    </header>

    <div v-if="error" class="p-4 rounded-lg border border-red-300/50 bg-red-50/40 dark:border-red-800/50 dark:bg-red-900/30 text-red-700 dark:text-red-200">
      加载失败：{{ String(error) }}
    </div>

    <div v-if="pending" class="text-sm text-neutral-600 dark:text-neutral-300">正在加载系列数据...</div>

    <div v-else class="grid gap-4 sm:grid-cols-2">
      <div v-for="s in series" :key="s.seriesNumber" class="rounded-2xl border border-neutral-200 dark:border-neutral-800 p-5 bg-white/80 dark:bg-neutral-900/70">
        <div class="flex items-center justify-between mb-3">
          <div class="flex items-center gap-3">
            <div class="flex items-baseline gap-2">
              <span class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">系列 {{ s.seriesNumber }}</span>
              <span class="text-[12px] text-neutral-600 dark:text-neutral-400">({{ seriesRange(s.seriesNumber).start }} - {{ seriesRange(s.seriesNumber).end }})</span>
            </div>
            <span
              class="text-[11px] px-2 py-0.5 rounded-full ring-1 ring-inset"
              :class="statusClass(s)"
            >
              {{ statusLabel(s) }}
            </span>
          </div>
          <div class="text-xs text-neutral-500 dark:text-neutral-400">更新于 {{ formatDate(s.lastUpdated) }}</div>
        </div>

        <!-- 进度条 -->
        <div class="space-y-2 mb-4">
          <div class="h-2 w-full rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden" role="progressbar" :aria-valuenow="Math.round(s.usagePercentage)" aria-valuemin="0" aria-valuemax="100">
            <div class="h-full rounded-full bg-[rgb(var(--accent))] transition-[width] duration-300" :style="{ width: Math.min(100, Math.max(0, s.usagePercentage)).toFixed(1) + '%' }"></div>
          </div>
          <div class="text-xs text-neutral-700 dark:text-neutral-300 tabular-nums">
            已用 {{ s.usedSlots }} / {{ s.totalSlots }}（{{ s.usagePercentage.toFixed(1) }}%），剩余 {{ s.remainingSlots }} 个
          </div>
        </div>

        <!-- 空闲编号（合并区间显示） -->
        <div>
          <div class="text-sm font-medium text-neutral-800 dark:text-neutral-200 mb-2">空闲编号</div>
          <div v-if="s.freeNumbers.length === 0" class="text-sm text-neutral-500 dark:text-neutral-400">无空闲编号</div>
          <div v-else class="text-sm text-neutral-800 dark:text-neutral-200 leading-7">
            <span v-for="(seg, idx) in toMergedSegments(s.freeNumbers)" :key="idx" class="inline-block mr-2">
              <span v-if="seg.start === seg.end">{{ seg.start }}</span>
              <span v-else>{{ seg.start }} - {{ seg.end }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatDateIsoUtc8 } from '~/utils/timezone'
type BffFetcher = <T = any>(url: string, options?: any) => Promise<T>;

type SeriesAvailability = {
  seriesNumber: number;
  isOpen: boolean;
  totalSlots: number;
  usedSlots: number;
  usagePercentage: number;
  remainingSlots: number;
  lastUpdated: string | Date;
  freeNumbers: number[];
};

const nuxtApp = useNuxtApp();
const bff = nuxtApp.$bff as unknown as BffFetcher;

const { data, pending, error } = await useAsyncData<SeriesAvailability[]>('series-availability', () => bff<SeriesAvailability[]>('/stats/series/availability'));

// 视图仅展示“已用编号 > 0”的系列（将 0 视为未开放，前端隐藏）
const series = computed(() => (data.value || [])
  .filter(s => (s.usedSlots || 0) > 0)
  .sort((a, b) => a.seriesNumber - b.seriesNumber)
);

function formatDate(d: string | Date): string {
  try {
    const formatted = formatDateIsoUtc8(d);
    return formatted || '';
  } catch {
    return '';
  }
}

type RangeSeg = { start: number; end: number };
function toMergedSegments(nums: number[]): RangeSeg[] {
  if (!Array.isArray(nums) || nums.length === 0) return [];
  const arr = Array.from(new Set(nums)).sort((a, b) => a - b);
  const segs: RangeSeg[] = [];
  let s = arr[0];
  let e = arr[0];
  for (let i = 1; i < arr.length; i++) {
    const n = arr[i];
    if (n === e + 1) {
      e = n;
    } else {
      segs.push({ start: s, end: e });
      s = e = n;
    }
  }
  segs.push({ start: s, end: e });
  // 不合并仅包含 2 个连续编号的区间，拆成单点
  const normalized: RangeSeg[] = [];
  for (const seg of segs) {
    const len = seg.end - seg.start + 1;
    if (len === 2) {
      normalized.push({ start: seg.start, end: seg.start });
      normalized.push({ start: seg.end, end: seg.end });
    } else {
      normalized.push(seg);
    }
  }
  return normalized;
}

function seriesRange(seriesNumber: number): { start: number; end: number } {
  if (seriesNumber === 1) return { start: 2, end: 999 };
  return { start: (seriesNumber - 1) * 1000, end: seriesNumber * 1000 - 1 };
}

function statusLabel(s: SeriesAvailability): string {
  if (!s.freeNumbers || s.freeNumbers.length === 0) return '已满';
  return s.isOpen ? '开放' : '未开放';
}

function statusClass(s: SeriesAvailability): string {
  if (!s.freeNumbers || s.freeNumbers.length === 0) {
    return 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-900/20 dark:text-red-300 dark:ring-red-700/50';
  }
  if (s.isOpen) {
    return 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-900/20 dark:text-emerald-300 dark:ring-emerald-700/50';
  }
  return 'bg-neutral-100 text-neutral-700 ring-neutral-300 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700';
}
</script>

<style scoped>
</style>
