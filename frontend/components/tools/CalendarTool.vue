<template>
  <div class="mx-auto w-full max-w-6xl py-6">
    <!-- Header -->
    <header class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div class="flex items-center gap-3">
        <div
          class="inline-flex items-center gap-2 rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.08)] px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-[rgb(var(--accent))]"
        >
          <LucideIcon name="CalendarDays" class="h-4 w-4" />
          <span>活动月历</span>
        </div>
        <div class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
          {{ yearText }}
        </div>
      </div>

      <!-- Controls: segmented-like -->
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex items-center gap-2">
          <select
            v-model.number="jumpYear"
            class="px-2 py-1.5 rounded-xl border border-neutral-200/80 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-[13px]"
            aria-label="选择年份"
          >
            <option v-for="y in yearOptions" :key="y" :value="y">{{ y }}年</option>
          </select>
          <button class="seg-btn" @click="jumpToYear">跳转</button>
        </div>

        <div class="flex items-center rounded-xl border border-neutral-200/70 dark:border-neutral-700 overflow-hidden">
          <button class="seg-btn !rounded-none" @click="goToday" aria-label="回到今年">今年</button>
          <div class="h-8 w-px bg-neutral-200/80 dark:bg-neutral-700"></div>
          <button class="seg-icon" aria-label="上一年" @click="prevYear"><LucideIcon name="ChevronLeft" class="h-4 w-4" /></button>
          <div class="h-8 w-px bg-neutral-200/80 dark:bg-neutral-700"></div>
          <button class="seg-icon" aria-label="下一年" @click="nextYear"><LucideIcon name="ChevronRight" class="h-4 w-4" /></button>
        </div>
      </div>
    </header>

    <!-- Year Grid (Apple-like density) -->
    <section>
      <!-- xs:2 cols | sm+:3 | desktop 4x3 -->
      <div class="grid grid-cols-2 gap-1.5 sm:grid-cols-3 sm:gap-2.5 lg:grid-cols-4 xl:grid-cols-4">
        <article
          v-for="(m, mIdx) in months"
          :key="'m-' + mIdx + '-' + format(m, 'yyyyMM')"
          class="rounded-2xl border border-neutral-200/70 bg-white/90 p-2.5 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/80 overflow-hidden"
        >
          <!-- Month Header -->
          <div class="mb-0.5 px-0.5 flex items-center justify-between">
            <div class="text-[13px] font-semibold text-neutral-800 dark:text-neutral-100">
              {{ format(m, 'M月') }}
            </div>
            <!-- 点击整月打开首个活动（可选） -->
            <button
              v-if="firstEventOfMonth(m)"
              class="text-[11px] text-[rgb(var(--accent-strong))] hover:underline"
              @click="openAgenda(firstEventOfMonth(m)!)"
            >
              查看活动
            </button>
          </div>

          <!-- Week Header -->
          <div class="grid grid-cols-7 gap-0.5 px-0.5 pb-0.5">
            <div
              v-for="(d, i) in weekHeaders"
              :key="'h-' + mIdx + '-' + i"
              class="text-[10px] font-medium text-neutral-500 dark:text-neutral-400 text-center"
            >
              {{ d.short }}
            </div>
          </div>

          <!-- Weeks -->
          <div class="space-y-0">
            <div
              v-for="(week, wIdx) in weeksByMonth[mIdx]"
              :key="'w-' + mIdx + '-' + wIdx"
              class="relative rounded-xl"
            >
              <!-- Day Grid：固定每周行高，保证对齐 -->
              <div class="grid grid-cols-7" :style="{ height: DAY_ROW_H + 'px' }">
                <div
                  v-for="(day, cIdx) in week"
                  :key="'c-' + mIdx + '-' + wIdx + '-' + cIdx"
                  class="calendar-cell"
                >
                  <div class="flex h-full items-center justify-center py-0.5">
                    <div
                      class="text-[11px] font-medium tabular-nums leading-none text-center relative"
                      :class="[
                        day.inMonth ? 'font-semibold text-neutral-800 dark:text-neutral-200' : 'text-neutral-300 dark:text-neutral-600',
                        isToday(day.date) ? 'today' : ''
                      ]"
                    >
                      <span class="relative z-[1]">{{ day.date.getDate() }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- 活动层：紧贴日期与下一周之间的间距 -->
              <div
                class="relative px-0.5 -mt-[2px]"
                :style="{ height: rowHeightsByMonth[mIdx][wIdx] + 'px' }"
              >
                <template v-for="seg in segmentsByMonth[mIdx][wIdx].visible" :key="'s-' + seg.key">
                  <!-- 头段展示标题，其余保留色带 -->
                  <div
                    v-if="seg.isHead || (segmentsByMonth[mIdx][wIdx].visible.length === 1 && segmentsByMonth[mIdx][wIdx].overflow === 0)"
                    :key="'s-' + seg.key + '-expanded'"
                    class="absolute group box-border flex h-full items-center overflow-hidden px-1.5 text-[10px] font-medium leading-tight shadow-sm cursor-pointer focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.5)] z-10"
                    :style="segmentStyleExpanded(seg)"
                    role="button"
                    tabindex="0"
                    @click="onSegmentClick(seg)"
                    @keydown.enter.prevent="onSegmentClick(seg)"
                    :aria-label="`活动：${seg.title}（${formatRange(seg.startsAt, seg.endsAt)}）`"
                  >
                    <div v-if="seg.isHead" class="truncate leading-tight">
                      <span class="opacity-90">{{ seg.title }}</span>
                      <span v-if="seg.summary" class="opacity-70"> · {{ seg.summary }}</span>
                    </div>
                  </div>
                  <div
                    v-else
                    :key="'s-' + seg.key + '-collapsed'"
                    class="absolute group box-border overflow-hidden cursor-pointer focus:outline-none z-10"
                    :style="segmentStyleCollapsed(seg)"
                    role="button"
                    tabindex="0"
                    @click="onSegmentClick(seg)"
                    @keydown.enter.prevent="onSegmentClick(seg)"
                    :aria-label="`活动：${seg.title}（${formatRange(seg.startsAt, seg.endsAt)}）`"
                  />
                </template>

                <div
                  v-if="segmentsByMonth[mIdx][wIdx].overflow > 0"
                  class="absolute right-1 bottom-1 rounded-full border border-neutral-300/70 bg-white/90 px-1.5 py-0.5 text-[10px] text-neutral-700 shadow-sm dark:border-neutral-700 dark:bg-neutral-900/90 dark:text-neutral-200"
                >
                  +{{ segmentsByMonth[mIdx][wIdx].overflow }}
                </div>
              </div>
            </div>
          </div>

        </article>
      </div>
    </section>

    <!-- Details Modal -->
    <transition name="fade">
      <div
        v-if="detailVisible"
        class="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
        @click.self="closeDetail"
      >
        <div
          class="w-full max-w-2xl rounded-2xl bg-white p-5 text-neutral-800 shadow-xl dark:bg-neutral-900 dark:text-neutral-200"
          role="dialog"
          aria-modal="true"
          aria-labelledby="detail-title"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div id="detail-title" class="text-base font-semibold truncate" :style="{ color: detailColor || undefined }">
                {{ detailTitle }}
              </div>
              <div class="text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{{ detailDateRange }}</div>
            </div>
            <button
              class="shrink-0 rounded-xl border border-neutral-200 dark:border-neutral-700 px-2 py-1 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800"
              @click="closeDetail"
            >
              关闭
            </button>
          </div>
          <div
            v-if="detailSummary"
            class="mt-3 rounded-xl border border-[rgb(var(--accent)_/_0.25)] bg-[rgb(var(--accent)_/_0.06)] p-3 text-sm"
          >
            {{ detailSummary }}
          </div>
          <div
            class="prose prose-sm max-w-none mt-4 dark:prose-invert"
            v-html="detailHtml || '<p class=\'text-neutral-500 dark:text-neutral-400 text-sm\'>暂无详细内容</p>'"
          ></div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import LucideIcon from '~/components/LucideIcon.vue';
import {
  addMonths,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  addDays,
  isSameDay,
  isSameMonth,
  differenceInCalendarDays,
  format
} from 'date-fns';
import 'highlight.js/styles/github.min.css';

type RawEvent = {
  id: string;
  title: string;
  summary?: string | null;
  color?: string | null;
  startsAt: string;
  endsAt: string;
  // Optional local demo fields
  detailsMd?: string | null;
  __local?: boolean;
};

const { $bff } = useNuxtApp();

const today = new Date();
const currentMonth = ref(startOfMonth(today));
const events = ref<RawEvent[]>([]);

// Apple-like: year block helpers
const yearStart = computed(() => startOfMonth(new Date(currentMonth.value.getFullYear(), 0, 1)));
const months = computed(() => Array.from({ length: 12 }, (_, i) => startOfMonth(addMonths(yearStart.value, i))));
const yearText = computed(() => `${format(yearStart.value, 'yyyy年')}`);
const weekHeaders = computed(() => [
  { short: '一' }, { short: '二' }, { short: '三' }, { short: '四' }, { short: '五' }, { short: '六' }, { short: '日' }
]);

type DayCell = { date: Date; inMonth: boolean };
function buildWeeks(month: Date): DayCell[][] {
  // Always return 6 weeks (42 days), Monday-first
  const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
  const days: DayCell[] = [];
  for (let i = 0; i < 42; i++) {
    const d = addDays(start, i);
    days.push({ date: d, inMonth: isSameMonth(d, month) });
  }
  const res: DayCell[][] = [];
  for (let i = 0; i < days.length; i += 7) res.push(days.slice(i, i + 7));
  return res;
}
const weeksByMonth = computed(() => months.value.map((m) => buildWeeks(m)));

function isToday(d: Date) { return isSameDay(d, today); }
function isWeekend(d: Date) { const w = d.getDay(); return w === 0 || w === 6; }

// -------- Events to segments (with row capping & overflow) ----------
type Segment = {
  key: string;
  weekIndex: number;
  colStart: number;
  colEnd: number;
  row: number;
  color: string;
  title: string;
  summary?: string | null;
  eventId: string;
  startsAt: string;
  endsAt: string;
  localDetails?: string | null;
  // 本月内该事件的首个段（仅此显示标题）
  isHead?: boolean;
  // 是否为该事件（整体）的真实起点/终点片段
  leftCap?: boolean;  // 左端需要圆角与描边
  rightCap?: boolean; // 右端需要圆角与描边
};

type WeekSlice = {
  visible: Segment[];
  overflow: number;
  totalRows: number;
};

// 尺寸：数字行高度 + 每行活动条高度
const DAY_ROW_H = 22;     // 每周“日期数字”行的高度（px）；可视需求微调
const SEG_ROW_H = 12;     // 每行色带高度（px）
const maxRowsPerWeek = ref(2); // 已有：每周最多可见活动条行数

function updateMaxRows() {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1280;
  if (w < 640) maxRowsPerWeek.value = 2;
  else if (w < 1024) maxRowsPerWeek.value = 3;
  else maxRowsPerWeek.value = 4;
}

function hexToRgba(hex: string, alpha = 1) {
  const m = hex.trim().match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  if (!m) return hex;
  const r = parseInt(m[1], 16);
  const g = parseInt(m[2], 16);
  const b = parseInt(m[3], 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function buildSegments(weeksForMonth: DayCell[][], month: Date, maxRows: number): WeekSlice[] {
  const segsByWeek: Segment[][] = weeksForMonth.map(() => []);
  const seenHead = new Set<string>();
  events.value.forEach((e) => {
    const evStart = new Date(e.startsAt);
    const evEnd = new Date(e.endsAt);
    weeksForMonth.forEach((week, wIdx) => {
      const wStart = week[0].date;
      const wEnd = week[6].date;
      if (evEnd < wStart || evStart > wEnd) return;

      const segStart = evStart < wStart ? wStart : evStart;
      const segEnd = evEnd > wEnd ? wEnd : evEnd;

      let colStart = differenceInCalendarDays(segStart, wStart);
      let colEnd = differenceInCalendarDays(segEnd, wStart);

      // Clamp to in-month columns only
      const firstIn = week.findIndex((d) => d.inMonth);
      let lastIn = -1;
      for (let i = week.length - 1; i >= 0; i--) if (week[i].inMonth) { lastIn = i; break; }
      if (firstIn === -1 || lastIn === -1) return;

      const clampedStart = Math.max(colStart, firstIn);
      const clampedEnd = Math.min(colEnd, lastIn);
      if (clampedStart > clampedEnd) return;

      const isHead = !seenHead.has(e.id);
      if (isHead) seenHead.add(e.id);

      // 判断该周片段是否位于事件真实起点/终点
      const startInThisWeek = evStart >= wStart && evStart <= wEnd;
      const endInThisWeek = evEnd >= wStart && evEnd <= wEnd;
      const startInThisMonth = isSameMonth(evStart, month);
      const endInThisMonth = isSameMonth(evEnd, month);
      const leftCap = startInThisWeek && startInThisMonth;
      const rightCap = endInThisWeek && endInThisMonth;

      segsByWeek[wIdx].push({
        key: `${e.id}-${format(month, 'yyyyMM')}-${wIdx}-${clampedStart}-${clampedEnd}`,
        weekIndex: wIdx,
        colStart: clampedStart,
        colEnd: clampedEnd,
        row: 0,
        color: e.color || 'rgb(var(--accent))',
        title: e.title,
        summary: e.summary ?? null,
        eventId: e.id,
        startsAt: e.startsAt,
        endsAt: e.endsAt,
        localDetails: e.__local ? (e.detailsMd ?? null) : null,
        isHead,
        leftCap,
        rightCap
      });
    });
  });

  const result: WeekSlice[] = weeksForMonth.map(() => ({ visible: [], overflow: 0, totalRows: 0 }));

  segsByWeek.forEach((list, i) => {
    // isHead 优先，其次起始列，其次更长优先
    list.sort((a, b) => {
      if (!!a.isHead !== !!b.isHead) return a.isHead ? -1 : 1;
      const byStart = a.colStart - b.colStart;
      if (byStart !== 0) return byStart;
      const aLen = a.colEnd - a.colStart;
      const bLen = b.colEnd - b.colStart;
      return bLen - aLen;
    });

    const rows: { endCol: number }[] = [];
    list.forEach((seg) => {
      let placed = false;
      for (let r = 0; r < rows.length; r++) {
        if (seg.colStart > rows[r].endCol) {
          seg.row = r; rows[r].endCol = seg.colEnd; placed = true; break;
        }
      }
      if (!placed) { seg.row = rows.length; rows.push({ endCol: seg.colEnd }); }
    });

    const totalRows = rows.length;
    const visible = list.filter((s) => s.row < maxRows);
    const overflow = list.length - visible.length;

    result[i] = { visible, overflow, totalRows };
  });

  return result;
}

const segmentsByMonth = computed(() =>
  weeksByMonth.value.map((weeks, i) => buildSegments(weeks, months.value[i], maxRowsPerWeek.value))
);

const rowHeightsByMonth = computed(() =>
  segmentsByMonth.value.map((monthWeeks) =>
    monthWeeks.map((week) => {
      if (week.visible.length === 0) {
        return SEG_ROW_H;
      }
      const highestRow = week.visible.reduce((max, seg) => Math.max(max, seg.row), 0);
      const rowsUsed = Math.max(1, Math.min(maxRowsPerWeek.value, highestRow + 1));
      return rowsUsed * SEG_ROW_H;
    })
  )
);

function segmentStyleBase(seg: Segment) {
  const leftPct = (seg.colStart / 7) * 100;
  const widthPct = ((seg.colEnd - seg.colStart + 1) / 7) * 100;

  const border = seg.color;
  const bg =
    seg.color.startsWith('#')
      ? hexToRgba(seg.color, 0.50)
      : seg.color.includes('rgb(')
        ? seg.color.replace('rgb(', 'rgba(').replace(')', ', 0.50)')
        : seg.color;

  const top = seg.row * SEG_ROW_H;
  return {
    left: `calc(${leftPct}% + 2px)`,
    width: `calc(${widthPct}% - 4px)`,
    top: `${top}px`,
    background: bg,
    borderColor: border
  } as any;
}

function segmentStyleCollapsed(seg: Segment) {
  const base = segmentStyleBase(seg) as any;
  // Keep non-text segments the same height as text segments
  // so they don't collapse into thin lines when rows are split.
  base.height = `${SEG_ROW_H}px`;
  // 所有色块均不描边；仅通过圆角表现真实起止
  base.border = 'none';
  const capRadius = `${SEG_ROW_H / 2}px`;
  base.borderTopLeftRadius = seg.leftCap ? capRadius : '0px';
  base.borderBottomLeftRadius = seg.leftCap ? capRadius : '0px';
  base.borderTopRightRadius = seg.rightCap ? capRadius : '0px';
  base.borderBottomRightRadius = seg.rightCap ? capRadius : '0px';
  base.color = 'transparent';
  return base;
}

function segmentStyleExpanded(seg: Segment) {
  const base = segmentStyleBase(seg) as any;
  base.height = `${SEG_ROW_H}px`;
  // 所有色块均不描边；仅通过圆角表现真实起止
  base.border = 'none';
  const capRadius = `${SEG_ROW_H / 2}px`;
  base.borderTopLeftRadius = seg.leftCap ? capRadius : '0px';
  base.borderBottomLeftRadius = seg.leftCap ? capRadius : '0px';
  base.borderTopRightRadius = seg.rightCap ? capRadius : '0px';
  base.borderBottomRightRadius = seg.rightCap ? capRadius : '0px';
  base.color = 'inherit';
  return base;
}

// Fetch & helpers
async function fetchEvents() {
  try {
    const res = await $bff<{ items: RawEvent[] }>('/events');
    events.value = Array.isArray(res.items) ? res.items : [];
  } catch {
    events.value = [];
  }

  // Last resort: local demos
  if (!events.value || events.value.length === 0) {
    const y = currentMonth.value.getFullYear();
    const m = currentMonth.value.getMonth();
    const makeDate = (d: number) => new Date(y, m, d, 12).toISOString();
    events.value.push(
      { id: 'demo-1', title: '示例活动 A', summary: '新年特别企划', color: '#0ea5e9', startsAt: makeDate(5), endsAt: makeDate(9), detailsMd: '## 说明\n点击条带打开详情。\n\n- 支持 Markdown\n- 跨多日显示', __local: true },
      { id: 'demo-2', title: '示例活动 B', summary: '社区征稿', color: '#22c55e', startsAt: makeDate(15), endsAt: makeDate(18), detailsMd: '详情：**社区征稿**，欢迎投稿。', __local: true }
    );
  }
}

function prevYear() { currentMonth.value = startOfMonth(addMonths(currentMonth.value, -12)); }
function nextYear() { currentMonth.value = startOfMonth(addMonths(currentMonth.value, 12)); }
function goToday() { currentMonth.value = startOfMonth(today); }

// Quick jump
const jumpYear = ref<number>(today.getFullYear());
const yearOptions = computed(() => {
  const base = today.getFullYear();
  const years: number[] = [];
  for (let y = base - 5; y <= base + 5; y++) years.push(y);
  return years;
});
function syncJumpFromCurrent() { jumpYear.value = currentMonth.value.getFullYear(); }
function jumpToYear() {
  const target = new Date(jumpYear.value, 0, 1);
  currentMonth.value = startOfMonth(target);
}

// Details modal
const detailVisible = ref(false);
const detailTitle = ref('');
const detailSummary = ref<string | null>(null);
const detailHtml = ref<string>('');
const detailColor = ref<string | null>(null);
const detailDateRange = ref('');
let md: any = null;

async function ensureMarkdown() {
  if (!md) {
    const [mdLib, hljsMod, anchorMod, taskMod] = await Promise.all([
      import('markdown-it'),
      import('highlight.js'),
      import('markdown-it-anchor').catch(() => ({ default: undefined })),
      import('markdown-it-task-lists').catch(() => ({ default: undefined }))
    ]);
    const MarkdownIt = (mdLib as any).default ?? (mdLib as any);
    const hljs = (hljsMod as any).default ?? (hljsMod as any);
    const mdInstance = new MarkdownIt({
      linkify: true,
      breaks: true,
      html: false,
      highlight(code: string, lang: string) {
        try {
          if (lang && hljs.getLanguage(lang)) {
            return `<pre><code class="hljs language-${lang}">${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
          }
          return `<pre><code class="hljs">${hljs.highlightAuto(code).value}</code></pre>`;
        } catch {
          return `<pre><code>${code.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))}</code></pre>`;
        }
      }
    });
    const anchor = (anchorMod as any).default;
    const task = (taskMod as any).default;
    if (anchor) mdInstance.use(anchor, { permalink: false });
    if (task) mdInstance.use(task, { enabled: true, label: true, labelAfter: true });
    md = mdInstance;
  }
}

function formatRange(start: string, end: string) {
  const s = new Date(start);
  const e = new Date(end);
  return `${format(s, 'yyyy-MM-dd')} 至 ${format(e, 'yyyy-MM-dd')}`;
}

async function onSegmentClick(seg: Segment) {
  try {
    await ensureMarkdown();
    if (seg.localDetails != null) {
      detailTitle.value = seg.title;
      detailSummary.value = seg.summary ?? null;
      detailColor.value = seg.color;
      detailHtml.value = md.render(String(seg.localDetails));
      detailDateRange.value = formatRange(seg.startsAt, seg.endsAt);
      detailVisible.value = true;
      return;
    }
    const res = await $bff<any>(`/events/${seg.eventId}`);
    detailTitle.value = res.title || '';
    detailSummary.value = res.summary ?? null;
    detailColor.value = res.color ?? null;
    detailHtml.value = res.detailsMd ? md.render(String(res.detailsMd)) : '';
    detailDateRange.value = formatRange(res.startsAt, res.endsAt);
    detailVisible.value = true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('Failed to load event details:', err);
  }
}

function openAgenda(ev: RawEvent) {
  onSegmentClick({
    key: ev.id,
    weekIndex: 0,
    colStart: 0,
    colEnd: 0,
    row: 0,
    color: ev.color || 'rgb(var(--accent))',
    title: ev.title,
    summary: ev.summary ?? null,
    eventId: ev.id,
    startsAt: ev.startsAt,
    endsAt: ev.endsAt,
    localDetails: ev.__local ? (ev.detailsMd ?? null) : null
  });
}

function firstEventOfMonth(m: Date): RawEvent | null {
  const start = startOfMonth(m).toISOString();
  const end = endOfMonth(m).toISOString();
  const item = events.value.find((e) => e.startsAt <= end && e.endsAt >= start);
  return item ?? null;
}

function closeDetail() { detailVisible.value = false; }

onMounted(async () => {
  updateMaxRows();
  window.addEventListener('resize', updateMaxRows, { passive: true });
  await fetchEvents();
  syncJumpFromCurrent();
});

onUnmounted(() => {
  window.removeEventListener('resize', updateMaxRows);
});
</script>

<style scoped>
/* Controls */
.seg-btn {
  @apply rounded-xl px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 border border-neutral-200/80 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800;
}
.seg-icon {
  @apply inline-flex h-8 w-8 items-center justify-center text-neutral-700 hover:bg-neutral-50 dark:text-neutral-200 dark:hover:bg-neutral-800;
}

.calendar-cell {
  @apply relative bg-white/40 dark:bg-neutral-900/40;
  height: 22px;
}

.today::before {
  content: '';
  position: absolute;
  inset: -2px -5px;
  border-radius: 9999px;
  box-shadow: 0 0 0 1.5px rgba(var(--accent), 0.75) inset;
}

/* Animations */
.fade-enter-active, .fade-leave-active { transition: opacity .15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }

/* Markdown minimal tweaks live within prose utilities */

/* Improve focus visibility for keyboard users */
:focus-visible {
  outline: 2px solid rgba(var(--accent), 0.6);
  outline-offset: 2px;
}
</style>
