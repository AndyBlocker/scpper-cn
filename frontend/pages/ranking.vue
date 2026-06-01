<template>
  <div class="space-y-6">
    <!-- 顶部标题与辅助说明 -->
    <div class="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">作者排行</h1>
        <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          按类别浏览作者贡献与评分，点击表头可排序
        </p>
      </div>

      <!-- 每页尺寸（桌面） -->
      <div class="hidden sm:flex items-center gap-2">
        <span class="text-xs text-neutral-500 dark:text-neutral-400">每页</span>
        <div class="inline-flex border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
          <button
            v-for="s in PAGE_SIZES"
            :key="s"
            type="button"
            :aria-pressed="pageSize === s"
            @click="setPageSize(s)"
            class="px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--g-accent)] transition-colors"
            :class="pageSize === s ? 'bg-[var(--g-accent)] text-white' : 'bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800'"
          >
            {{ s }}
          </button>
        </div>
      </div>
    </div>

    <!-- 工具栏：分类 + 移动端每页 -->
    <div
      class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between p-3 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white/60 dark:bg-neutral-900/60 shadow-sm"
    >
      <!-- 分类切换 -->
      <div class="w-full flex justify-center">
        <div
          class="flex overflow-x-auto no-scrollbar flex-nowrap border border-neutral-200 dark:border-neutral-800 rounded-lg bg-white dark:bg-neutral-900"
          role="tablist"
          aria-label="类别"
        >
          <button
            v-for="[key, label] in CATEGORIES"
            :key="key"
            role="tab"
            type="button"
            :aria-selected="category === key"
            @click="category = key"
            class="px-2 py-1 text-xs sm:px-3 sm:py-1.5 sm:text-sm whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-[var(--g-accent)] transition-colors"
            :class="category === key
              ? 'bg-[var(--g-accent)] text-white'
              : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800'"
          >
            {{ label }}
          </button>
        </div>
      </div>

      <!-- 每页尺寸（移动端） -->
      <div class="sm:hidden flex items-center gap-1">
        <span class="text-xs text-neutral-500 dark:text-neutral-400">每页</span>
        <div class="inline-flex border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden">
          <button
            v-for="s in PAGE_SIZES"
            :key="s"
            type="button"
            :aria-pressed="pageSize === s"
            @click="setPageSize(s)"
            class="px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-[var(--g-accent)] transition-colors"
            :class="pageSize === s ? 'bg-[var(--g-accent)] text-white' : 'bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800'"
          >
            {{ s }}
          </button>
        </div>
      </div>
    </div>

    <!-- 主体列表 -->
    <div
      class="border border-neutral-200 dark:border-neutral-800 rounded-lg overflow-hidden bg-white dark:bg-neutral-900 shadow-md"
      :aria-busy="pending ? 'true' : 'false'"
      aria-live="polite"
    >
      <!-- 表头（粘性） -->
      <div
        class="grid grid-cols-12 text-xs px-4 py-2 text-neutral-600 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-800 sticky top-0 z-10 backdrop-blur bg-white/85 dark:bg-neutral-900/85"
        role="row"
      >
        <!-- 排名：桌面&移动统一居中 -->
        <div class="col-span-2 px-2 py-1 flex items-center justify-center">排名</div>

        <!-- 作者：修正对齐与断行 -->
        <div class="col-span-6 md:col-span-5 px-2 py-1 flex items-center whitespace-nowrap">作者</div>

        <!-- 表头右侧：使用与正文一致的网格，并加 ref 用于测量 -->
        <div class="col-span-4 md:col-span-5 px-0 relative">
          <!-- 论坛模式：简化为单列"发帖数" -->
          <div v-if="isForumCategory" class="flex items-center justify-center h-full">
            <button
              class="th-btn justify-center"
              :class="sortedHeadClass('count')"
              :aria-sort="ariaSort('count')"
              @click="toggleSort('count')"
              title="按发帖数排序"
            >
              发帖数
              <span v-if="sortBy==='count'">{{ sortDir==='asc' ? '▲' : '▼' }}</span>
            </button>
          </div>

          <!-- 正常模式：进度条 + 三项数值 -->
          <div
            v-else
            ref="headGridEl"
            class="metric-head-grid grid grid-cols-3 md:grid-cols-5 items-stretch gap-2"
          >
            <!-- 进度条占位（仅桌面） -->
            <div class="hidden md:block md:col-span-2"></div>

            <!-- 作品数（桌面） -->
            <div class="hidden md:block md:col-start-3 h-full head-cell head-count">
              <button
                class="th-btn justify-end"
                :class="sortedHeadClass('count')"
                :aria-sort="ariaSort('count')"
                @click="toggleSort('count')"
                title="按作品数排序"
              >
                作品数
                <span class="hidden md:inline" v-if="sortBy==='count'">{{ sortDir==='asc' ? '▲' : '▼' }}</span>
              </button>
            </div>

            <!-- 均分（桌面） -->
            <div class="hidden md:block md:col-start-4 h-full head-cell head-mean">
              <button
                class="th-btn justify-end"
                :class="sortedHeadClass('mean')"
                :aria-sort="ariaSort('mean')"
                @click="toggleSort('mean')"
                title="按均分排序"
              >
                均分
                <span class="hidden md:inline" v-if="sortBy==='mean'">{{ sortDir==='asc' ? '▲' : '▼' }}</span>
              </button>
            </div>

            <!-- 总分（移动端/桌面；移动端不显示升降序，只显示下拉） -->
            <div class="col-span-3 md:col-start-5 md:col-span-1 h-full head-cell head-rating">
              <!-- 移动端：切换指标（无升降序） -->
              <div class="relative md:hidden h-full">
                <button
                  type="button"
                  class="th-btn justify-end hover:bg-neutral-50 dark:hover:bg-neutral-800/40"
                  :class="sortedHeadClass(sortBy)"
                  :aria-expanded="mobileSortOpen ? 'true' : 'false'"
                  @click="mobileSortOpen = !mobileSortOpen"
                  title="选择排序指标"
                >
                  {{ metricLabel(sortBy) }} <span>▾</span>
                </button>
                <div
                  v-if="mobileSortOpen"
                  class="absolute right-0 top-[calc(100%+4px)] z-20 w-36 rounded-md border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow-lg"
                >
                  <button class="w-full text-left px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800" @click="applyMobileSort('rating')">总分</button>
                  <button class="w-full text-left px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800" @click="applyMobileSort('mean')">均分</button>
                  <button class="w-full text-left px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800" @click="applyMobileSort('count')">作品数</button>
                </div>
              </div>

              <!-- 桌面：点击排序（显示升降序箭头） -->
              <div class="hidden md:flex h-full">
                <button
                  class="th-btn justify-center"
                  :class="sortedHeadClass('rating')"
                  :aria-sort="ariaSort('rating')"
                  @click="toggleSort('rating')"
                  title="按总分排序"
                >
                  总分
                  <span v-if="sortBy==='rating'">{{ sortDir==='asc' ? '▲' : '▼' }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 加载态骨架屏 -->
      <div v-if="pending" class="divide-y divide-neutral-100 dark:divide-neutral-800">
        <div
          v-for="i in pageSize"
          :key="'skeleton-'+i"
          class="grid grid-cols-12 items-center px-4 py-3 animate-pulse rank-row"
        >
          <div class="col-span-2">
            <div class="h-6 w-14 rounded bg-neutral-100 dark:bg-neutral-800"></div>
          </div>
          <div class="col-span-6 md:col-span-5 flex items-center gap-3">
            <div class="h-9 w-9 rounded-full bg-neutral-100 dark:bg-neutral-800"></div>
            <div class="w-full">
              <div class="h-3 rounded bg-neutral-100 dark:bg-neutral-800 w-2/3"></div>
              <div class="mt-2 h-2 rounded bg-neutral-100 dark:bg-neutral-800 w-1/3"></div>
            </div>
          </div>
          <div class="col-span-4 md:col-span-5">
            <div class="grid grid-cols-3 md:grid-cols-5 items-center gap-2">
              <div class="hidden md:block md:col-span-2 h-2 rounded bg-neutral-100 dark:bg-neutral-800"></div>
              <div class="hidden md:block h-3 w-10 rounded bg-neutral-100 dark:bg-neutral-800 ml-auto"></div>
              <div class="hidden md:block h-3 w-8 rounded bg-neutral-100 dark:bg-neutral-800 ml-auto"></div>
              <div class="h-3 w-10 rounded bg-neutral-100 dark:bg-neutral-800 mx-auto"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-else-if="!items?.length" class="p-10 text-center text-sm text-neutral-500 dark:text-neutral-400">
        <div class="text-3xl mb-2">🗂️</div>
        暂无数据。试试切换类别或重置排序。
        <div class="mt-4">
          <button
            type="button"
            class="px-3 py-1.5 text-xs rounded-md border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-[var(--g-accent)]"
            @click="setSortDefault('rating'); goToPage(1)"
          >
            重置筛选
          </button>
        </div>
      </div>

      <!-- 列表 -->
      <TransitionGroup name="list" tag="div" class="list-wrapper">
        <div
          v-for="(u, idx) in items || []"
          :key="u.wikidotId || u.id"
          :ref="el => setRowRef(el as HTMLElement, idx)"
          class="group grid grid-cols-12 items-center px-4 py-3 border-t border-neutral-100 dark:border-neutral-800 rank-row focus:outline-none"
          tabindex="0"
          role="row"
        >
          <!-- 排名（统一居中） -->
          <div class="col-span-2 tabular-nums px-2 flex justify-center">
            <span class="inline-flex items-center gap-0.5">
              <span v-if="isAprilFools" class="text-[10px]">🐾</span>
              <span
                class="inline-flex items-center justify-center min-w-[2.75rem] text-xs font-semibold px-2 py-0.5 rounded-full ring-1 ring-inset"
                :class="rankBadgeClass(displayRank(u, idx))"
                :aria-label="`排名第 ${displayRank(u, idx)} 位`"
              >
                #{{ displayRank(u, idx) }}
              </span>
              <span v-if="isAprilFools" class="text-[10px]">🐾</span>
            </span>
          </div>

          <!-- 作者 -->
          <div class="col-span-6 md:col-span-5 min-w-0 px-1 md:px-2 user-cell">
            <UserCard
              bare
              size="sm"
              :wikidot-id="u.wikidotId"
              :display-name="u.displayName"
              :subtitle="u.favTag ? ('#'+u.favTag) : undefined"
              :sm-avatar-size="22"
              sm-text-class="text-[13px] leading-none font-medium text-[var(--g-accent)] dark:text-[var(--g-accent)] truncate max-w-[160px]"
            />
          </div>

          <!-- 度量：进度条(桌面) + 三项数值 -->
          <div class="col-span-4 md:col-span-5 px-0">
            <!-- 论坛模式：仅显示发帖数 -->
            <div v-if="isForumCategory" class="flex items-center justify-center h-full text-center text-sm text-neutral-900 dark:text-neutral-100 tabular-nums font-semibold">
              {{ formatInt(u.catCount ?? u.postCount ?? u.pageCount) }}
            </div>

            <!-- 正常模式：进度条 + 三项数值 -->
            <div v-else class="metric-grid grid grid-cols-1 md:grid-cols-5 items-stretch gap-2">
              <!-- 进度条 -->
              <div class="hidden md:flex md:items-center md:col-start-1 md:col-span-2 h-full">
                <div class="h-2 w-full rounded-full bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
                  <div
                    class="h-full rounded-full bg-[var(--g-accent)] transition-[width] duration-200"
                    :style="{ width: metricPercent(u) + '%' }"
                    role="progressbar"
                    :aria-valuenow="Math.round(metricPercent(u))"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    :aria-label="`相对${metricLabel(sortBy)}：${Math.round(metricPercent(u))}%`"
                  ></div>
                </div>
              </div>

              <!-- 作品数（右对齐） -->
              <div class="hidden md:flex md:col-start-3 md:justify-end md:items-center h-full text-right text-sm text-neutral-900 dark:text-neutral-100 tabular-nums cell-count">
                <span class="pr-2">{{ formatInt(u.catCount ?? u.pageCount) }}</span>
              </div>

              <!-- 均分（右对齐） -->
              <div class="hidden md:flex md:col-start-4 md:justify-end md:items-center h-full text-right text-sm text-neutral-900 dark:text-neutral-100 tabular-nums cell-mean">
                <span class="pr-2">{{ formatMean(u.catMean ?? u.meanRating) }}</span>
              </div>

              <!-- 指标值（移动端为当前选择；桌面为总分） -->
              <div class="col-span-1 md:col-start-5 h-full">
                <!-- 移动端：当前选择的指标 -->
                <div
                  class="flex md:hidden items-center justify-center h-full text-center text-sm text-neutral-900 dark:text-neutral-100 tabular-nums font-semibold whitespace-nowrap"
                  :class="sortBy==='count' ? 'cell-count' : sortBy==='mean' ? 'cell-mean' : 'cell-rating'"
                >
                  {{ formatMetric(u) }}
                </div>
                <!-- 桌面：总分固定显示在最后一列 -->
                <div class="hidden md:flex items-center justify-center h-full text-center text-sm text-neutral-900 dark:text-neutral-100 tabular-nums font-semibold cell-rating whitespace-nowrap">
                  {{ formatInt(u.rating ?? u.overallRating) }}
                </div>
              </div>
            </div>
          </div>
        </div>
      </TransitionGroup>

      <!-- 底部分页 -->
      <div
        class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 py-3 border-t border-neutral-200 dark:border-neutral-800 text-sm bg-neutral-50/60 dark:bg-neutral-900/60"
      >
        <div class="text-neutral-600 dark:text-neutral-400 tabular-nums">
          共 {{ total }} 位作者 · 第 {{ page }} / {{ totalPages }} 页
        </div>
        <div class="flex items-center gap-2">
          <div class="flex items-center gap-1">
            <button
              @click="goToPage(page - 1)"
              :disabled="page === 1"
              class="px-2.5 py-1 border border-neutral-200 dark:border-neutral-700 rounded disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--g-accent)] bg-white dark:bg-neutral-900 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            >
              上一页
            </button>
            <button
              v-for="p in visiblePages"
              :key="p"
              @click="goToPage(p)"
              class="min-w-[2rem] text-center px-2 py-1 border border-neutral-200 dark:border-neutral-700 rounded focus:outline-none focus:ring-2 focus:ring-[var(--g-accent)] transition-colors"
              :class="p === page ? 'bg-[var(--g-accent)] text-white border-[var(--g-accent)]' : 'bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800'"
            >
              {{ p }}
            </button>
            <button
              @click="goToPage(page + 1)"
              :disabled="page === totalPages"
              class="px-2.5 py-1 border border-neutral-200 dark:border-neutral-700 rounded disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--g-accent)] bg-white dark:bg-neutral-900 hover:bg-neutral-50 dark:hover:bg-neutral-800"
            >
              下一页
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAsyncData, useHead, useNuxtApp } from 'nuxt/app';

import type { BffFetcher } from '~/types/nuxt-bff'
type RankUser = {
  id: number;
  wikidotId: number;
  displayName: string;
  rank: number;
  rating: number;
  overallRating?: number;
  pageCount?: number;
  totalRating?: number;
  meanRating?: number;
  totalUp?: number;
  totalDown?: number;
  favTag?: string | null;
  scpPageCount?: number;
  storyPageCount?: number;
  goiPageCount?: number;
  translationPageCount?: number;
  wanderersPageCount?: number;
  artPageCount?: number;
  ratingUpdatedAt?: string | null;

  // 分类视图兼容
  catCount?: number;
  catMean?: number;
  postCount?: number;
};

const route = useRoute();
const router = useRouter();
const { $bff } = useNuxtApp();
const bff = $bff as BffFetcher;

/** —— 参数状态 —— */
const PAGE_SIZES = [20, 50, 100] as const;
const ALLOWED_SORTS = ['count', 'mean', 'rating'] as const;

const pageSize = ref<number>((() => {
  const q = parseInt((route.query.size as string) || '20', 10) || 20;
  return (PAGE_SIZES as unknown as number[]).includes(q) ? q : 20;
})());

const category = ref<string>((route.query.category as string) || 'overall');
const CATEGORIES = [
  ['overall', '综合'],
  ['scp', 'SCP'],
  ['story', '故事'],
  ['goi', 'GoI格式'],
  ['translation', '翻译'],
  ['wanderers', '被放逐者之图书馆'],
  ['art', '艺术作品'],
  ['forum', '论坛'],
] as const;

const page = ref<number>(parseInt((route.query.page as string) || '1', 10) || 1);

// 只允许三项可排序；默认按总分
const initialSort = (route.query.sort as string) || 'rating';
const sanitizedSort = (ALLOWED_SORTS as unknown as string[]).includes(initialSort) ? initialSort : 'rating';
const sortBy = ref<string>(sanitizedSort);
const sortDir = ref<string>((route.query.dir as string) || 'desc'); // 移动端不暴露 UI，但仍沿用参数

const offset = computed(() => (page.value - 1) * pageSize.value);

const isForumCategory = computed(() => category.value === 'forum');

/** —— 数据获取 —— */
type RankResponse = { total: number; items: RankUser[] };
const { data, pending } = await useAsyncData<RankResponse>(
  () => `ranking-${category.value}-${page.value}-${pageSize.value}-${sortBy.value}-${sortDir.value}`,
  () =>
    bff<RankResponse>(`/users/by-rank`, {
      params: {
        category: category.value,
        limit: pageSize.value,
        offset: offset.value,
        sortBy: sortBy.value,
        sortDir: sortDir.value
      }
    }),
  { watch: [category, () => page.value, () => pageSize.value, sortBy, sortDir] }
);

const total = computed(() => data.value?.total ?? 0);
const items = computed<RankUser[]>(() => data.value?.items ?? []);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)));
const startIndex = computed(() => offset.value + 1);

/** —— 进度条：随当前排序指标变化 —— */
function metricLabel(k: string) {
  if (isForumCategory.value) return '发帖数';
  if (k === 'count') return '作品数';
  if (k === 'mean') return '均分';
  return '总分';
}
function metricValue(u: RankUser): number {
  if (isForumCategory.value) return Number(u.catCount ?? u.postCount ?? u.pageCount ?? 0) || 0;
  if (sortBy.value === 'count') return Number(u.catCount ?? u.pageCount ?? 0) || 0;
  if (sortBy.value === 'mean') return Number(u.catMean ?? u.meanRating ?? 0) || 0;
  return Number(u.rating ?? u.overallRating ?? 0) || 0;
}
const maxMetric = computed<number>(() => {
  const vals = (items.value || []).map(metricValue).filter(Number.isFinite);
  const m = Math.max(0, ...vals);
  return m > 0 ? m : 1;
});
function metricPercent(u: RankUser) {
  const v = metricValue(u);
  return Math.min(100, Math.max(0, (v / maxMetric.value) * 100));
}

/** —— 交互 —— */
watch(category, () => {
  page.value = 1;
  if (isForumCategory.value) {
    sortBy.value = 'count';
    sortDir.value = 'desc';
  }
  updateQuery();
});
watch(page, () => { updateQuery(); });
watch(pageSize, () => { page.value = 1; updateQuery(); });
watch(sortBy, () => { page.value = 1; updateQuery(); scheduleMeasure(); });
watch(sortDir, () => { page.value = 1; updateQuery(); scheduleMeasure(); });
watch(items, () => { nextTick(scheduleMeasure); });

function updateQuery() {
  router.replace({
    query: {
      category: category.value,
      page: String(page.value),
      size: String(pageSize.value),
      sort: sortBy.value,
      dir: sortDir.value
    }
  });
}
function goToPage(p: number) {
  const next = Math.min(totalPages.value, Math.max(1, p));
  if (next !== page.value) page.value = next;
}
const visiblePages = computed(() => {
  const span = 5;
  const half = Math.floor(span / 2);
  let start = Math.max(1, page.value - half);
  let end = Math.min(totalPages.value, start + span - 1);
  if (end - start + 1 < span) start = Math.max(1, end - span + 1);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
});
function setPageSize(s: number) {
  if (s !== pageSize.value) pageSize.value = s;
}

// 排序按钮（移动端未显示升降序，但逻辑仍在）
function toggleSort(key: string) {
  if (!(ALLOWED_SORTS as unknown as string[]).includes(key)) return;
  if (sortBy.value === key) {
    sortDir.value = (sortDir.value === 'asc') ? 'desc' : 'asc';
  } else {
    sortBy.value = key;
    sortDir.value = 'desc';
  }
}
function ariaSort(key: string) {
  if (sortBy.value !== key) return 'none';
  return sortDir.value === 'asc' ? 'ascending' : 'descending';
}
function setSortDefault(k: string) {
  if (!(ALLOWED_SORTS as unknown as string[]).includes(k)) k = 'rating';
  if (sortBy.value !== k) { sortBy.value = k; sortDir.value = 'desc'; }
}

// 移动端指标菜单
const mobileSortOpen = ref(false);
function applyMobileSort(k: string) {
  mobileSortOpen.value = false;
  if ((ALLOWED_SORTS as unknown as string[]).includes(k)) {
    sortBy.value = k;
    sortDir.value = 'desc'; // 移动端固定降序
  }
}

/** —— 高亮测量：把“整列高亮”铺满整行 —— */
const headGridEl = ref<HTMLElement | null>(null);
const rowEls = ref<HTMLElement[]>([]);
function setRowRef(el: HTMLElement | null, idx: number) {
  if (!el) return;
  rowEls.value[idx] = el;
}

function measureHeader() {
  const host = headGridEl.value;
  if (!host) return;
  const key = sortBy.value === 'count' ? '.head-count'
            : sortBy.value === 'mean' ? '.head-mean'
            : '.head-rating';
  const cell = host.querySelector(key) as HTMLElement | null;
  const R = host.getBoundingClientRect();
  if (cell) {
    const C = cell.getBoundingClientRect();
    host.style.setProperty('--hhl-left', `${C.left - R.left}px`);
    host.style.setProperty('--hhl-width', `${C.width}px`);
  } else {
    host.style.setProperty('--hhl-width', `0px`);
  }
}

function measureRows() {
  const key = sortBy.value === 'count' ? '.cell-count'
            : sortBy.value === 'mean' ? '.cell-mean'
            : '.cell-rating';
  rowEls.value.forEach((row) => {
    if (!row) return;
    const cell = row.querySelector(key) as HTMLElement | null;
    const R = row.getBoundingClientRect();
    if (cell) {
      const C = cell.getBoundingClientRect();
      row.style.setProperty('--hl-left', `${C.left - R.left}px`);
      row.style.setProperty('--hl-width', `${C.width}px`);
    } else {
      row.style.setProperty('--hl-width', `0px`);
    }
  });
}

let rafId = 0;
function scheduleMeasure() {
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(() => {
    // 双 RAF，等待过渡/布局稳定
    requestAnimationFrame(() => {
      measureHeader();
      measureRows();
    });
  });
}
onMounted(() => {
  scheduleMeasure();
  window.addEventListener('resize', scheduleMeasure, { passive: true });
});
onUnmounted(() => {
  cancelAnimationFrame(rafId);
  window.removeEventListener('resize', scheduleMeasure);
});

/** —— 愚人节彩蛋：2026-04-01 (UTC+8) 所有排名显示为 #1 —— */
const isAprilFools = computed(() => {
  const now = new Date()
  const utc8 = new Date(now.getTime() + 8 * 60 * 60 * 1000)
  return utc8.getUTCFullYear() === 2026 && utc8.getUTCMonth() === 3 && utc8.getUTCDate() === 1
})

/** —— 其它 —— */
function displayRank(_u: RankUser, idx: number) {
  if (isAprilFools.value) return 1
  return startIndex.value + idx;
}
function rankBadgeClass(rank: number) {
  if (rank === 1) return 'bg-amber-300 text-amber-900 ring-amber-300/40';
  if (rank === 2) return 'bg-neutral-300 text-neutral-900 ring-neutral-300/50';
  if (rank === 3) return 'bg-orange-300 text-orange-900 ring-orange-300/40';
  return 'bg-neutral-100 dark:bg-neutral-800/60 text-neutral-700 dark:text-neutral-300 ring-neutral-200 dark:ring-neutral-700';
}
function sortedHeadClass(key: string) {
  const active = sortBy.value === key;
  return active ? 'bg-[var(--g-accent-medium)] dark:bg-[var(--g-accent-strong)] text-[var(--g-accent)]' : '';
}
function formatInt(v?: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  return Math.round(n).toString();
}
function formatMean(v?: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return Number(n.toFixed(1)).toFixed(1);
}

// 根据当前排序指标格式化展示值（移动端使用）
function formatMetric(u: RankUser): string {
  if (isForumCategory.value) return formatInt(u.catCount ?? u.postCount ?? u.pageCount);
  if (sortBy.value === 'count') return formatInt(u.catCount ?? u.pageCount);
  if (sortBy.value === 'mean') return formatMean(u.catMean ?? u.meanRating);
  return formatInt(u.rating ?? u.overallRating);
}

useHead({ title: '作者排行' });
</script>

<style scoped>
/* —— 基础 —— */
.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
.tabular-nums { font-variant-numeric: tabular-nums; }

/* —— 列表过渡 —— */
.list-enter-active, .list-leave-active { transition: transform 160ms ease, opacity 160ms ease; }
.list-enter-from, .list-leave-to { opacity: 0; transform: translateY(4px); }
.list-move { transition: transform 180ms ease; }
@media (prefers-reduced-motion: reduce) {
  .list-enter-active, .list-leave-active, .list-move { transition: none !important; }
}

/* —— 稳定斑马纹 —— */
.list-wrapper { position: relative; }
.rank-row { position: relative; background-color: transparent; transition: background-color 120ms ease; }
.list-wrapper > .rank-row:nth-of-type(even) { background-color: rgba(2, 6, 23, 0.02); }
.dark .list-wrapper > .rank-row:nth-of-type(even) { background-color: rgba(255, 255, 255, 0.04); }
.rank-row:hover { background-color: rgba(2, 6, 23, 0.04); }
.dark .rank-row:hover { background-color: rgba(255, 255, 255, 0.06); }
.rank-row:focus-visible { outline: 2px solid rgb(16 185 129); outline-offset: -2px; }

/* —— 整行列高亮（核心） —— */
.rank-row::before{
  content: "";
  position: absolute;
  top: 0; bottom: 0;                      /* 覆盖整行高度（包含 py） */
  left: var(--hl-left, -9999px);          /* 未测量前隐藏 */
  width: var(--hl-width, 0);
  background-color: var(--g-accent-medium);
  pointer-events: none;
  border-radius: 0px;                     /* 需要无圆角可设为 0 */
}
.dark .rank-row::before{ background-color: rgb(var(--accent-strong) / 0.22); }

/* —— 表头列高亮（仅在右侧网格内） —— */
.metric-head-grid{ position: relative; }
.metric-head-grid::before{
  content: "";
  position: absolute;
  top: 0; bottom: 0;
  left: var(--hhl-left, -9999px);
  width: var(--hhl-width, 0);
  background-color: var(--g-accent-medium);
  pointer-events: none;
  border-radius: 6px;
}
.dark .metric-head-grid::before{ background-color: rgb(var(--accent-strong) / 0.22); }

/* —— 表头按钮（填满单元格，不影响列高亮） —— */
.th-btn{
  display:flex; width:100%; height:100%;
  gap:.25rem; align-items:center; padding:.25rem .5rem;
  border-radius:.25rem; justify-content:center;
}
</style>
