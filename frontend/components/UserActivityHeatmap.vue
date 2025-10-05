<template>
  <div>
    <div v-if="isLoading" class="h-48 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
      <svg class="w-5 h-5 animate-spin text-[rgb(var(--accent))]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
      </svg>
      <span class="ml-2 text-sm">加载热力图...</span>
    </div>
    <div v-else-if="loadError" class="p-4 bg-red-50/70 dark:bg-red-900/20 text-sm text-red-600 dark:text-red-400 rounded-lg">
      加载用户活跃数据失败，请稍后重试。
    </div>
    <div v-else class="space-y-4">
      <div class="overflow-x-auto px-1">
        <div class="mx-auto w-max">
          <div class="grid" style="grid-template-columns: auto 1fr; grid-template-rows: auto 1fr; column-gap: 0.5rem; row-gap: 0.5rem;">
            <div></div>
            <div class="flex gap-1 text-[10px] text-neutral-400 dark:text-neutral-500">
              <span
                v-for="(label, index) in monthLabels"
                :key="`month-${index}`"
                class="w-4 text-center whitespace-pre leading-tight"
              >
                {{ label }}
              </span>
            </div>
            <div class="grid grid-rows-7 gap-1 text-[10px] text-neutral-500 dark:text-neutral-400 select-none leading-none pr-1">
              <span v-for="(label, index) in weekdayMarkers" :key="`weekday-${index}`" class="h-4 flex items-center justify-end">
                <span v-if="label">{{ label }}</span>
              </span>
            </div>
            <div class="flex gap-1">
              <div v-for="(week, wIndex) in weeks" :key="`week-${wIndex}`" class="grid grid-rows-7 gap-1 w-4">
                <div
                  v-for="day in week"
                  :key="day.iso"
                  :title="day.title"
                  :aria-label="day.title"
                  :class="cellClass(day)"
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-4 text-xs text-neutral-500 dark:text-neutral-400">
        <div class="flex items-center gap-2">
          <span>更少</span>
          <div class="flex items-center gap-1">
            <span
              v-for="level in legendLevels"
              :key="`legend-${level}`"
              :class="legendClass(level)"
            />
          </div>
          <span>更多</span>
        </div>
        <div v-if="summary.activeDays === 0" class="text-neutral-500 dark:text-neutral-400">
          过去一年暂无投票或创作记录。
        </div>
        <div v-else class="flex flex-wrap items-center gap-3">
          <span>活跃天数 <span class="font-semibold text-neutral-800 dark:text-neutral-100">{{ summary.activeDays }}</span></span>
          <span>投票总数 <span class="font-semibold text-neutral-800 dark:text-neutral-100">{{ summary.totalVotes }}</span></span>
          <span>创作总数 <span class="font-semibold text-neutral-800 dark:text-neutral-100">{{ summary.totalPages }}</span></span>
          <span>修订次数 <span class="font-semibold text-neutral-800 dark:text-neutral-100">{{ summary.totalRevisions }}</span></span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

type RawRecord = {
  iso: string;
  votesCast: number;
  pagesCreated: number;
  revisions: number;
  lastActivity?: string | null;
};

type HeatmapRange = {
  startIso: string;
  endIso: string;
};

type RawDay = {
  iso: string;
  date: Date;
  votesCast: number;
  pagesCreated: number;
  revisions: number;
  value: number;
  isFuture: boolean;
  isToday: boolean;
};

type DayCell = RawDay & {
  level: number;
  title: string;
};

const MS_PER_DAY = 86_400_000;
const legendLevels = [0, 1, 2, 3, 4] as const;
const weekdayMarkers = ['周一', '', '周三', '', '周五', '', ''] as const;

const props = defineProps<{
  records: Array<{
    date: string;
    votesCast?: number | null;
    pagesCreated?: number | null;
    revisions?: number | null;
    lastActivity?: string | null;
  }>;
  requestedRange?: HeatmapRange | null;
  pending?: boolean;
  error?: unknown;
}>();

const isLoading = computed(() => props.pending === true);
const loadError = computed(() => props.error ?? null);

const normalizedRecords = computed<RawRecord[]>(() => {
  if (!Array.isArray(props.records)) return [];
  const items: RawRecord[] = [];
  for (const record of props.records) {
    const iso = normalizeToIso(record?.date);
    if (!iso) continue;
    items.push({
      iso,
      votesCast: Number(record?.votesCast ?? 0),
      pagesCreated: Number(record?.pagesCreated ?? 0),
      revisions: Number(record?.revisions ?? 0),
      lastActivity: record?.lastActivity ?? null
    });
  }
  items.sort((a, b) => a.iso.localeCompare(b.iso));
  return items;
});

const recordMap = computed(() => {
  const map = new Map<string, RawRecord>();
  for (const item of normalizedRecords.value) {
    map.set(item.iso, item);
  }
  return map;
});

const fallbackEndIso = computed(() => props.requestedRange?.endIso || formatIso(new Date()));

const resolvedRange = computed(() => {
  const { startIso, endIso } = props.requestedRange || {};
  const start = alignToWeekStart(isoToDate(startIso) || inferStart());
  const end = alignToWeekEnd(isoToDate(endIso) || inferEnd());
  return { start, end };
});

const rawDays = computed<RawDay[]>(() => {
  const { start, end } = resolvedRange.value;
  if (!start || !end) return [];
  const days: RawDay[] = [];
  const limit = 370 * MS_PER_DAY;
  const startTs = start.getTime();
  const endTs = end.getTime();
  const upperIso = fallbackEndIso.value;
  const todayIso = formatIso(new Date());
  for (let ts = startTs, guard = 0; ts <= endTs && guard * MS_PER_DAY <= limit; ts += MS_PER_DAY, guard++) {
    const date = new Date(ts);
    const iso = formatIso(date);
    const base = recordMap.value.get(iso);
    const votesCast = base?.votesCast ?? 0;
    const pagesCreated = base?.pagesCreated ?? 0;
    const revisions = base?.revisions ?? 0;
    const nonCreationRevisions = Math.max(0, revisions - pagesCreated);
    const value = votesCast + pagesCreated + nonCreationRevisions;
    const isFuture = iso > upperIso;
    const isToday = iso === todayIso;
    days.push({ iso, date, votesCast, pagesCreated, revisions, value, isFuture, isToday });
  }
  return days;
});

const maxValue = computed(() => {
  let max = 0;
  for (const day of rawDays.value) {
    if (day.isFuture) continue;
    if (day.value > max) max = day.value;
  }
  return max;
});

const dayCells = computed<DayCell[]>(() => {
  const max = maxValue.value;
  return rawDays.value.map((day) => {
    const level = computeLevel(day.value, max, day.isFuture);
    return {
      ...day,
      level,
      title: buildTooltip(day)
    };
  });
});

const weeks = computed(() => {
  const list: DayCell[][] = [];
  const source = dayCells.value;
  for (let i = 0; i < source.length; i += 7) {
    list.push(source.slice(i, i + 7));
  }
  return list;
});

const monthLabels = computed(() => {
  const labels: string[] = [];
  let lastMonth = -1;
  let lastYear = -1;
  weeks.value.forEach((week, index) => {
    const first = week[0];
    if (!first) {
      labels.push('');
      return;
    }
    const month = first.date.getUTCMonth();
    const year = first.date.getUTCFullYear();
    const isFirstWeek = index === 0;
    const isFirstDayOfMonth = first.date.getUTCDate() === 1;
    if (isFirstWeek && !isFirstDayOfMonth) {
      labels.push('');
      lastMonth = month;
      lastYear = year;
      return;
    }

    if (month !== lastMonth || year !== lastYear) {
      if (year !== lastYear) {
        labels.push(`${year}年\n${month + 1}月`);
      } else {
        labels.push(`${month + 1}月`);
      }
      lastMonth = month;
      lastYear = year;
    } else {
      labels.push('');
    }
  });
  return labels;
});

const summary = computed(() => {
  let totalVotes = 0;
  let totalPages = 0;
  let totalRevisions = 0;
  let activeDays = 0;
  rawDays.value.forEach((day) => {
    if (!day.isFuture && day.value > 0) activeDays += 1;
  });
  normalizedRecords.value.forEach((item) => {
    totalVotes += item.votesCast;
    totalPages += item.pagesCreated;
    totalRevisions += item.revisions;
  });
  return { totalVotes, totalPages, totalRevisions, activeDays };
});

const palette: Record<number, string> = {
  0: 'bg-neutral-100 dark:bg-neutral-800 border-neutral-200/70 dark:border-neutral-700/60',
  1: 'heatmap-level-1',
  2: 'heatmap-level-2',
  3: 'heatmap-level-3',
  4: 'heatmap-level-4'
};

const futureCellClass = 'border-dashed border-neutral-200/80 dark:border-neutral-700/60 bg-transparent opacity-60 cursor-default';

function cellClass(day: DayCell) {
  const base = 'w-4 h-4 rounded-sm border transition-transform duration-150 ease-out hover:scale-110';
  if (day.level < 0) {
    return `${base} ${futureCellClass}`;
  }
  let className = `${base} ${palette[day.level] ?? palette[0]}`;
  if (day.isToday) {
    className += ' ring-1 ring-green-600/60 dark:ring-green-400/60';
  }
  return className;
}

function legendClass(level: number) {
  return `w-4 h-4 rounded-sm border ${palette[level] ?? palette[0]}`;
}

function computeLevel(value: number, max: number, isFuture: boolean) {
  if (isFuture) return -1;
  if (value <= 0) return 0;
  if (max <= 0) return 1;
  const ratio = value / max;
  if (ratio >= 0.85) return 4;
  if (ratio >= 0.6) return 3;
  if (ratio >= 0.35) return 2;
  return 1;
}

function buildTooltip(day: RawDay) {
  const display = formatDisplayDate(day.date);
  return `${display} · 投票 ${day.votesCast} · 创作 ${day.pagesCreated} · 修订 ${day.revisions}`;
}

function formatDisplayDate(date: Date) {
  return date.toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    weekday: 'short'
  });
}

function formatIso(date: Date) {
  const d = new Date(date.getTime());
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function normalizeToIso(value?: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCHours(0, 0, 0, 0);
  return parsed.toISOString().slice(0, 10);
}

function isoToDate(value?: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  parsed.setUTCHours(0, 0, 0, 0);
  return parsed;
}

function alignToWeekStart(date: Date) {
  const d = new Date(date.getTime());
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diff);
  return d;
}

function alignToWeekEnd(date: Date) {
  const d = new Date(date.getTime());
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();
  const diff = day === 0 ? 0 : 7 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  return d;
}

function inferStart() {
  if (normalizedRecords.value.length > 0) {
    return isoToDate(normalizedRecords.value[0].iso) as Date;
  }
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  now.setUTCDate(now.getUTCDate() - 364);
  return now;
}

function inferEnd() {
  if (normalizedRecords.value.length > 0) {
    return isoToDate(normalizedRecords.value[normalizedRecords.value.length - 1].iso) as Date;
  }
  const now = new Date();
  now.setUTCHours(0, 0, 0, 0);
  return now;
}
</script>

<style scoped>
.heatmap-level-1 {
  background-color: #aceebb;
  border-color: #8cd79f;
  color: #134c28;
}

.dark .heatmap-level-1 {
  background-color: #152f22;
  border-color: #244833;
  color: #b9f4cb;
}

.heatmap-level-2 {
  background-color: #4ac26b;
  border-color: #3ba85a;
  color: #0f3f1f;
}

.dark .heatmap-level-2 {
  background-color: #18462b;
  border-color: #26623d;
  color: #d2f7dc;
}

.heatmap-level-3 {
  background-color: #116329;
  border-color: #0f5623;
  color: #ffffff;
}

.dark .heatmap-level-3 {
  background-color: #257a45;
  border-color: #2f9656;
  color: #f1fff3;
}

.heatmap-level-4 {
  background-color: #126029;
  border-color: #0f521f;
  color: #ffffff;
}

.dark .heatmap-level-4 {
  background-color: #4fd27f;
  border-color: #39b768;
  color: #062a16;
}
</style>
