<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between border-b-2 border-[rgba(var(--accent),0.18)] dark:border-[rgba(var(--accent),0.24)] pb-3">
      <div class="flex items-center gap-3">
        <div class="h-8 w-1 bg-[rgb(var(--accent))] rounded" />
        <h2 class="text-lg font-bold text-neutral-800 dark:text-neutral-100">搜索</h2>
      </div>
      <button 
        @click="showAdvanced = !showAdvanced"
        class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
      >
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 100 4m0-4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 100 4m0-4v2m0-6V4"/>
        </svg>
        {{ showAdvanced ? '简单搜索' : '高级搜索' }}
      </button>
    </div>

    <!-- 高级搜索面板 -->
    <div v-show="showAdvanced" class="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 shadow-sm">
      <form @submit.prevent="performAdvancedSearch" class="space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- 关键词搜索 -->
          <div class="md:col-span-2">
            <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">关键词</label>
            <input 
              v-model="searchForm.query"
              type="text"
              placeholder="搜索页面标题或内容..."
              class="w-full bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[rgb(var(--accent))] focus:border-transparent transition-all"
            />
          </div>

          <!-- 标签过滤 -->
          <div class="md:col-span-2">
            <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">标签</label>
            <div class="space-y-2">
              <!-- 包含标签 -->
              <div>
                <label class="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">包含标签</label>
                <div class="relative">
                  <input 
                    v-model="tagSearchQuery"
                    @input="searchTags"
                    @focus="showTagSuggestions = true"
                    @blur="hideTagSuggestions"
                    type="text"
                    placeholder="输入标签名搜索..."
                    class="w-full bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[rgb(var(--accent))] focus:border-transparent transition-all"
                  />
                  <!-- Tag建议下拉 -->
                  <div v-if="showTagSuggestions && tagSuggestions.length > 0" class="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
                    <button
                      v-for="tag in tagSuggestions"
                      :key="tag.tag"
                      @click="addIncludeTag(tag.tag)"
                      type="button"
                      class="w-full text-left px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors border-b border-neutral-100 dark:border-neutral-800 last:border-b-0"
                    >
                      <div class="flex items-center justify-between">
                        <span class="text-sm text-neutral-800 dark:text-neutral-200">{{ tag.tag }}</span>
                        <span class="text-xs text-neutral-500 dark:text-neutral-400">{{ tag.pageCount }} 页面</span>
                      </div>
                    </button>
                  </div>
                </div>
                <label class="mt-2 flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400 select-none">
                  <input
                    id="only-include-tags"
                    v-model="searchForm.onlyIncludeTags"
                    type="checkbox"
                    class="h-4 w-4 rounded border-neutral-300 dark:border-neutral-600 text-[rgb(var(--accent))] focus:ring-[rgb(var(--accent))]"
                  />
                  <span>仅包含</span>
                </label>
                <div v-if="searchForm.includeTags.length > 0" class="mt-2 space-y-1">
                  <div class="text-xs text-neutral-500 dark:text-neutral-400">
                    {{ searchForm.onlyIncludeTags ? '仅包含这些tag' : '包含这些tag' }}
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <span 
                      v-for="tag in searchForm.includeTags" 
                      :key="tag"
                      class="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded text-sm"
                    >
                      #{{ tag }}
                      <button @click="removeIncludeTag(tag)" type="button" class="hover:text-blue-800 dark:hover:text-blue-300">
                        <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                      </button>
                    </span>
                  </div>
                </div>
              </div>

              <!-- 排除标签 -->
              <div>
                <label class="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">排除标签</label>
                <div class="relative">
                  <input 
                    v-model="excludeTagSearchQuery"
                    @input="searchExcludeTags"
                    @focus="showExcludeTagSuggestions = true"
                    @blur="hideExcludeTagSuggestions"
                    type="text"
                    placeholder="输入要排除的标签..."
                    class="w-full bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[rgb(var(--accent))] focus:border-transparent transition-all"
                  />
                  <!-- 排除Tag建议下拉 -->
                  <div v-if="showExcludeTagSuggestions && excludeTagSuggestions.length > 0" class="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
                    <button
                      v-for="tag in excludeTagSuggestions"
                      :key="tag.tag"
                      @click="addExcludeTag(tag.tag)"
                      type="button"
                      class="w-full text-left px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors border-b border-neutral-100 dark:border-neutral-800 last:border-b-0"
                    >
                      <div class="flex items-center justify-between">
                        <span class="text-sm text-neutral-800 dark:text-neutral-200">{{ tag.tag }}</span>
                        <span class="text-xs text-neutral-500 dark:text-neutral-400">{{ tag.pageCount }} 页面</span>
                      </div>
                    </button>
                  </div>
                </div>
                <div v-if="searchForm.excludeTags.length > 0" class="flex flex-wrap gap-2 mt-2">
                  <span 
                    v-for="tag in searchForm.excludeTags" 
                    :key="tag"
                    class="inline-flex items-center gap-1 px-2 py-1 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded text-sm"
                  >
                    #{{ tag }}
                    <button @click="removeExcludeTag(tag)" type="button" class="hover:text-red-800 dark:hover:text-red-300">
                      <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                      </svg>
                    </button>
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- 分数范围 -->
          <div>
            <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">评分范围</label>
            <div class="flex items-center gap-2">
              <input 
                v-model="searchForm.ratingMin"
                type="number"
                placeholder="最低分"
                step="1"
                class="flex-1 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[rgb(var(--accent))] focus:border-transparent transition-all"
              />
              <span class="text-neutral-500 dark:text-neutral-400">至</span>
              <input 
                v-model="searchForm.ratingMax"
                type="number"
                placeholder="最高分"
                step="1"
                class="flex-1 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[rgb(var(--accent))] focus:border-transparent transition-all"
              />
            </div>
          </div>

          <!-- 排序方式 -->
          <div>
            <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">排序方式</label>
            <select 
              v-model="searchForm.orderBy"
              class="w-full bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[rgb(var(--accent))] focus:border-transparent transition-all"
            >
              <option value="relevance">相关性</option>
              <option value="rating">评分：高到低</option>
              <option value="rating_asc">评分：低到高</option>
              <option value="recent">日期：新到旧</option>
              <option value="recent_asc">日期：旧到新</option>
            </select>
          </div>
        </div>

        <!-- 搜索按钮 -->
        <div class="flex items-center justify-between">
          <button
            @click="clearForm"
            type="button"
            class="px-4 py-2 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors"
          >
            重置
          </button>
          <button
            type="submit"
            class="px-6 py-2 bg-[rgb(var(--accent))] text-white font-medium rounded-lg hover:bg-[rgb(var(--accent-strong))] transition-colors disabled:opacity-50"
            :disabled="!searchForm.query && searchForm.includeTags.length === 0 && searchForm.excludeTags.length === 0 && !searchForm.ratingMin && !searchForm.ratingMax"
          >
            搜索
          </button>
        </div>
      </form>
    </div>

    <!-- 搜索结果显示 -->
    <div v-if="searchPerformed">
      <div v-if="initialLoading" class="text-sm text-neutral-600 dark:text-neutral-400">搜索中…</div>
      <div v-else-if="error" class="text-sm text-red-600 dark:text-red-400">搜索失败，请稍后重试</div>
      <div v-else>
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div class="text-sm text-neutral-600 dark:text-neutral-400">
            找到用户 <span class="font-semibold text-[rgb(var(--accent))]">{{ totalUsers }}</span>
            ，页面 <span class="font-semibold text-[rgb(var(--accent))]">{{ totalPages }}</span>
          </div>
          <!--
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-medium text-neutral-600 shadow-sm transition hover:border-[rgba(var(--accent),0.35)] hover:text-[rgb(var(--accent))] disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
            :disabled="csvPending || pageResults.length === 0"
            @click="exportCsv"
          >
            <svg class="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0 0l-4-4m4 4l4-4" />
            </svg>
            <span>{{ csvPending ? '导出中…' : '导出 CSV' }}</span>
          </button>
          -->
        </div>

        <div class="space-y-8">
          <section v-if="totalUsers > 0 || usersLoading" class="space-y-3">
            <div class="flex items-center justify-between">
              <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">用户</div>
              <div class="text-[11px] text-neutral-400 dark:text-neutral-500">共 {{ totalUsers }}</div>
            </div>
            <div v-if="usersLoading && userResults.length === 0" class="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              <div v-for="i in 6" :key="`user-skel-${i}`" class="h-24 rounded-2xl border border-neutral-200 bg-neutral-100/70 animate-pulse dark:border-neutral-800 dark:bg-neutral-800/40"></div>
            </div>
            <div v-else-if="userResults.length === 0" class="rounded-2xl border border-dashed border-neutral-300 bg-neutral-50/80 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
              暂无用户符合条件。
            </div>
            <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              <UserCard
                v-for="u in userResults"
                :key="u.wikidotId || u.id"
                size="md"
                :wikidot-id="u.wikidotId"
                :display-name="u.displayName"
                :rank="u.rank"
                :totals="{ totalRating: u.totalRating, works: u.pageCount }"
              />
            </div>
            <div v-if="userLoadingMore" class="flex items-center justify-center text-xs text-neutral-500 dark:text-neutral-400">
              正在载入更多用户…
            </div>
            <div v-else-if="userHasMore" class="flex flex-col items-center gap-2">
              <button
                type="button"
                class="rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-[rgba(var(--accent),0.35)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                @click="loadMoreUsers"
              >加载更多用户</button>
              <div ref="userSentinelRef" class="h-1 w-full"></div>
            </div>
          </section>

          <section class="space-y-4">
            <div class="flex items-center justify-between">
              <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">页面</div>
              <div class="text-[11px] text-neutral-400 dark:text-neutral-500">共 {{ totalPages }}</div>
            </div>
            <div v-if="pagesLoading && pageResults.length === 0" class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              <div v-for="i in 6" :key="`page-skel-${i}`" class="h-48 rounded-2xl border border-neutral-200 bg-neutral-100/70 animate-pulse dark:border-neutral-800 dark:bg-neutral-800/40"></div>
            </div>
            <div v-else-if="pageResults.length === 0" class="rounded-2xl border border-dashed border-neutral-300 bg-neutral-50/80 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
              暂无页面符合条件。
            </div>
            <div v-else>
              <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                <PageCard size="md" v-for="p in pageResults" :key="p.wikidotId || p.id" :p="p" />
              </div>
            </div>
            <div v-if="pageLoadingMore" class="flex items-center justify-center text-xs text-neutral-500 dark:text-neutral-400">
              正在载入更多页面…
            </div>
            <div v-else-if="pageHasMore" class="flex flex-col items-center gap-2">
              <button
                type="button"
                class="rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-[rgba(var(--accent),0.35)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                @click="loadMorePages"
              >加载更多页面</button>
              <div ref="pageSentinelRef" class="h-1 w-full"></div>
            </div>
            <div v-else>
              <div ref="pageSentinelRef" class="h-0 w-full"></div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNuxtApp, useHead, useState } from 'nuxt/app'
import { orderTags } from '~/composables/useTagOrder'
import { useViewerVotes } from '~/composables/useViewerVotes'

const route = useRoute();
const router = useRouter();
const currentQueryKey = computed(() => route.fullPath || '')
type BffFetcher = <T = any>(url: string, options?: any) => Promise<T>
const { $bff } = useNuxtApp();
const bff = $bff as unknown as BffFetcher

// UI状态
const showAdvanced = ref(false);
const searchPerformed = ref(false);
const initialLoading = ref(false);
const error = ref(false);

// 高级搜索表单
const searchForm = ref({
  query: '',
  includeTags: [] as string[],
  excludeTags: [] as string[],
  onlyIncludeTags: false,
  ratingMin: '',
  ratingMax: '',
  orderBy: 'relevance'
});

// Tag联想功能
const tagSearchQuery = ref('');
const excludeTagSearchQuery = ref('');
const tagSuggestions = ref<Array<{tag: string, pageCount: number}>>([]);
const excludeTagSuggestions = ref<Array<{tag: string, pageCount: number}>>([]);
const showTagSuggestions = ref(false);
const showExcludeTagSuggestions = ref(false);
let tagSearchTimeout: NodeJS.Timeout | null = null;
let excludeTagSearchTimeout: NodeJS.Timeout | null = null;
let tagRequestSeq = 0;
let excludeTagRequestSeq = 0;
const suggestionStabilizeDelay = 120;

const delay = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

// 搜索结果
const userResults = ref<any[]>([])
const pageResults = ref<any[]>([])
const totalUsers = ref(0)
const totalPages = ref(0)
const usersLoading = ref(false)
const pagesLoading = ref(false)
const USER_BATCH_SIZE = 12
const PAGE_BATCH_SIZE = 18
const userOffset = ref(0)
const pageOffset = ref(0)
const userHasMore = ref(false)
const pageHasMore = ref(false)
const userLoadingMore = ref(false)
const pageLoadingMore = ref(false)
const lastSearchParams = ref<Record<string, any>>({})
const searchCache = useState<{
  key: string
  pages: any[]
  users: any[]
  totalPages: number
  totalUsers: number
  pageOffset: number
  userOffset: number
  pageHasMore: boolean
  userHasMore: boolean
  scrollY: number
}>('search-cache', () => ({
  key: '',
  pages: [] as any[],
  users: [] as any[],
  totalPages: 0,
  totalUsers: 0,
  pageOffset: 0,
  userOffset: 0,
  pageHasMore: false,
  userHasMore: false,
  scrollY: 0
}))
const restoringScroll = ref(false)
const pageSentinelRef = ref<HTMLElement | null>(null)
const userSentinelRef = ref<HTMLElement | null>(null)
let pageObserver: IntersectionObserver | null = null
let userObserver: IntersectionObserver | null = null
// CSV export temporarily disabled.
// const csvPending = ref(false)
const { hydratePages } = useViewerVotes()

function normalizePage(p: any) {
  const toISODate = (v: any) => {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  return {
    wikidotId: p.wikidotId,
    title: p.title,
    alternateTitle: p.alternateTitle,
    authors: p.authors,
    tags: orderTags(p.tags as string[] | null | undefined),
    rating: p.rating,
    wilson95: p.wilson95,
    commentCount: p.commentCount ?? p.revisionCount,
    controversy: p.controversy,
    snippetHtml: p.snippet || null,
    isDeleted: Boolean(p.isDeleted),
    deletedAt: p.deletedAt || null,
    createdDate: toISODate(p.firstRevisionAt || p.createdAt || p.validFrom)
  };
}

// Tag搜索功能
const searchTags = () => {
  if (tagSearchTimeout) {
    clearTimeout(tagSearchTimeout);
  }

  const query = tagSearchQuery.value.trim();
  if (query.length < 1) {
    tagSuggestions.value = [];
    return;
  }

  tagSearchTimeout = setTimeout(async () => {
    const requestId = ++tagRequestSeq;
    try {
      const resp = await bff('/search/tags', { params: { query, limit: 10 } });
      await delay(suggestionStabilizeDelay);
      if (requestId !== tagRequestSeq) return;
      tagSuggestions.value = resp.results || [];
    } catch (err) {
      console.error('搜索标签失败:', err);
      if (requestId === tagRequestSeq) {
        tagSuggestions.value = [];
      }
    }
  }, 300);
};

const searchExcludeTags = () => {
  if (excludeTagSearchTimeout) {
    clearTimeout(excludeTagSearchTimeout);
  }

  const query = excludeTagSearchQuery.value.trim();
  if (query.length < 1) {
    excludeTagSuggestions.value = [];
    return;
  }

  excludeTagSearchTimeout = setTimeout(async () => {
    const requestId = ++excludeTagRequestSeq;
    try {
      const resp = await bff('/search/tags', { params: { query, limit: 10 } });
      await delay(suggestionStabilizeDelay);
      if (requestId !== excludeTagRequestSeq) return;
      excludeTagSuggestions.value = resp.results || [];
    } catch (err) {
      console.error('搜索排除标签失败:', err);
      if (requestId === excludeTagRequestSeq) {
        excludeTagSuggestions.value = [];
      }
    }
  }, 300);
};

const hideTagSuggestions = () => {
  setTimeout(() => {
    showTagSuggestions.value = false;
  }, 200);
};

const hideExcludeTagSuggestions = () => {
  setTimeout(() => {
    showExcludeTagSuggestions.value = false;
  }, 200);
};

const addIncludeTag = (tag: string) => {
  if (!searchForm.value.includeTags.includes(tag)) {
    searchForm.value.includeTags.push(tag);
  }
  tagSearchQuery.value = '';
  tagSuggestions.value = [];
  showTagSuggestions.value = false;
};

const addExcludeTag = (tag: string) => {
  if (!searchForm.value.excludeTags.includes(tag)) {
    searchForm.value.excludeTags.push(tag);
  }
  excludeTagSearchQuery.value = '';
  excludeTagSuggestions.value = [];
  showExcludeTagSuggestions.value = false;
};

const removeIncludeTag = (tag: string) => {
  const index = searchForm.value.includeTags.indexOf(tag);
  if (index > -1) {
    searchForm.value.includeTags.splice(index, 1);
  }
};

const removeExcludeTag = (tag: string) => {
  const index = searchForm.value.excludeTags.indexOf(tag);
  if (index > -1) {
    searchForm.value.excludeTags.splice(index, 1);
  }
};

const clearForm = () => {
  searchForm.value = {
    query: '',
    includeTags: [],
    excludeTags: [],
    onlyIncludeTags: false,
    ratingMin: '',
    ratingMax: '',
    orderBy: 'relevance'
  };
  tagSearchQuery.value = '';
  excludeTagSearchQuery.value = '';
};

function hasSearchCriteria(): boolean {
  return Boolean(searchForm.value.query?.trim())
    || searchForm.value.includeTags.length > 0
    || searchForm.value.excludeTags.length > 0
    || Boolean(searchForm.value.ratingMin)
    || Boolean(searchForm.value.ratingMax)
}

function buildSearchParamsFromForm(includeDefaultsForOrder = false): Record<string, any> {
  const params: Record<string, any> = {}
  const query = searchForm.value.query.trim()
  if (query) params.query = query
  if (searchForm.value.includeTags.length > 0) params.tags = [...searchForm.value.includeTags]
  if (searchForm.value.onlyIncludeTags) params.onlyIncludeTags = 'true'
  if (searchForm.value.excludeTags.length > 0) params.excludeTags = [...searchForm.value.excludeTags]
  if (searchForm.value.ratingMin) params.ratingMin = searchForm.value.ratingMin
  if (searchForm.value.ratingMax) params.ratingMax = searchForm.value.ratingMax
  if (includeDefaultsForOrder || (searchForm.value.orderBy && searchForm.value.orderBy !== 'relevance')) {
    params.orderBy = searchForm.value.orderBy || 'relevance'
  }
  return params
}

// 搜索功能
async function fetchUsers(params: Record<string, any> | null = null, options: { append?: boolean } = {}) {
  const append = options.append ?? false
  const baseParams = params ?? lastSearchParams.value
  const offset = append ? userOffset.value : 0
  const includeTotal = offset === 0
  const limit = USER_BATCH_SIZE
  if (append) {
    userLoadingMore.value = true
  } else {
    usersLoading.value = true
  }
  try {
    const resp = await bff('/search/users', { params: { ...baseParams, limit, offset, includeTotal } })
    const rows = Array.isArray(resp?.results) ? resp.results : (Array.isArray(resp) ? resp : [])
    if (append && rows.length > 0) {
      userResults.value = userResults.value.concat(rows)
    } else if (!append) {
      userResults.value = rows
    }
    const fetched = rows.length
    const totalCandidate = resp?.total
    const parsedTotal = totalCandidate === undefined || totalCandidate === null ? null : Number(totalCandidate)
    const hasValidTotal = parsedTotal !== null && Number.isFinite(parsedTotal)
    const totalValue = hasValidTotal ? parsedTotal : null
    if (totalValue !== null) {
      totalUsers.value = totalValue
    } else if (!append) {
      totalUsers.value = rows.length
    }
    userOffset.value = offset + fetched
    userHasMore.value = totalValue !== null ? userOffset.value < totalValue : fetched === limit
  } catch (err) {
    console.error('搜索用户失败:', err)
    if (!append) {
      userResults.value = []
      totalUsers.value = 0
      error.value = true
    }
  } finally {
    if (append) {
      userLoadingMore.value = false
    } else {
      usersLoading.value = false
    }
    updateCache()
  }
}

async function fetchPages(params: Record<string, any> | null = null, options: { append?: boolean } = {}) {
  const append = options.append ?? false
  const baseParams = params ?? lastSearchParams.value
  const offset = append ? pageOffset.value : 0
  const includeTotal = offset === 0
  const limit = PAGE_BATCH_SIZE
  if (append) {
    pageLoadingMore.value = true
  } else {
    pagesLoading.value = true
  }
  try {
    const resp = await bff('/search/pages', {
      params: {
        ...baseParams,
        limit,
        offset,
        includeTotal,
        includeSnippet: true,
        includeDate: includeTotal
      }
    })
    const rowsRaw = Array.isArray(resp?.results) ? resp.results : (Array.isArray(resp) ? resp : [])
    const rows = rowsRaw.map(normalizePage)
    await hydratePages(rows)
    if (append && rows.length > 0) {
      pageResults.value = pageResults.value.concat(rows)
    } else if (!append) {
      pageResults.value = rows
    }
    const fetched = rows.length
    const totalCandidate = resp?.total
    const parsedTotal = totalCandidate === undefined || totalCandidate === null ? null : Number(totalCandidate)
    const hasValidTotal = parsedTotal !== null && Number.isFinite(parsedTotal)
    const totalValue = hasValidTotal ? parsedTotal : null
    if (totalValue !== null) {
      totalPages.value = totalValue
    } else if (!append) {
      totalPages.value = rows.length
    }
    pageOffset.value = offset + fetched
    pageHasMore.value = totalValue !== null ? pageOffset.value < totalValue : fetched === limit
  } catch (err) {
    console.error('搜索页面失败:', err)
    if (!append) {
      pageResults.value = []
      totalPages.value = 0
      error.value = true
    }
  } finally {
    if (append) {
      pageLoadingMore.value = false
    } else {
      pagesLoading.value = false
    }
    updateCache()
  }
}

function resetPagination() {
  userOffset.value = 0
  pageOffset.value = 0
  userHasMore.value = false
  pageHasMore.value = false
  userResults.value = []
  pageResults.value = []
  userLoadingMore.value = false
  pageLoadingMore.value = false
}

function updateCache() {
  searchCache.value = {
    key: currentQueryKey.value,
    pages: [...pageResults.value],
    users: [...userResults.value],
    totalPages: totalPages.value,
    totalUsers: totalUsers.value,
    pageOffset: pageOffset.value,
    userOffset: userOffset.value,
    pageHasMore: pageHasMore.value,
    userHasMore: userHasMore.value,
    scrollY: process.client ? window.scrollY : searchCache.value.scrollY
  }
}

function restoreFromCacheIfAvailable(key: string) {
  if (!key || searchCache.value.key !== key) return false
  pageResults.value = [...searchCache.value.pages]
  userResults.value = [...searchCache.value.users]
  totalPages.value = searchCache.value.totalPages
  totalUsers.value = searchCache.value.totalUsers
  pageOffset.value = searchCache.value.pageOffset
  userOffset.value = searchCache.value.userOffset
  pageHasMore.value = searchCache.value.pageHasMore
  userHasMore.value = searchCache.value.userHasMore
  lastSearchParams.value = buildSearchParamsFromForm(true)
  searchPerformed.value = true
  initialLoading.value = false
  if (process.client) {
    restoringScroll.value = true
    nextTick(() => {
      window.scrollTo({ top: searchCache.value.scrollY || 0 })
      restoringScroll.value = false
    })
  }
  return true
}

async function loadMorePages() {
  if (!pageHasMore.value || pageLoadingMore.value || pagesLoading.value) return
  await fetchPages(null, { append: true })
}

async function loadMoreUsers() {
  if (!userHasMore.value || userLoadingMore.value || usersLoading.value) return
  await fetchUsers(null, { append: true })
}

// async function exportCsv() {
//   if (!pageResults.value.length) return
//   csvPending.value = true
//   try {
//     const headers = ['wikidotId', '标题', '别名', 'Rating', '评论数', '标签', '创建日期']
//     const rows = pageResults.value.map((p) => {
//       const id = p.wikidotId ?? ''
//       const title = (p.title || '').replace(/"/g, '""')
//       const alt = (p.alternateTitle || '').replace(/"/g, '""')
//       const rating = p.rating ?? ''
//       const comments = p.commentCount ?? ''
//       const tags = Array.isArray(p.tags) ? p.tags.join(' ') : ''
//       const created = p.createdDate || ''
//       return [id, `"${title}"`, alt ? `"${alt}"` : '', rating, comments, `"${tags.replace(/"/g, '""')}"`, created]
//     })
//     const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n')
//     const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
//     const url = URL.createObjectURL(blob)
//     const link = document.createElement('a')
//     link.href = url
//     link.download = `search-results-${Date.now()}.csv`
//     document.body.appendChild(link)
//     link.click()
//     document.body.removeChild(link)
//     URL.revokeObjectURL(url)
//   } catch (err) {
//     console.error('导出 CSV 失败:', err)
//   } finally {
//     csvPending.value = false
//   }
// }

function setupPageObserver() {
  if (!process.client || typeof IntersectionObserver === 'undefined') return
  if (pageObserver) pageObserver.disconnect()
  pageObserver = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting)) {
      void loadMorePages()
    }
  }, { rootMargin: '320px 0px' })
  if (pageSentinelRef.value) pageObserver.observe(pageSentinelRef.value)
}

function setupUserObserver() {
  if (!process.client || typeof IntersectionObserver === 'undefined') return
  if (userObserver) userObserver.disconnect()
  userObserver = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting)) {
      void loadMoreUsers()
    }
  }, { rootMargin: '320px 0px' })
  if (userSentinelRef.value) userObserver.observe(userSentinelRef.value)
}

watch(pageSentinelRef, (newEl, oldEl) => {
  if (!process.client || !pageObserver) return
  if (oldEl) pageObserver.unobserve(oldEl)
  if (newEl) pageObserver.observe(newEl)
})

watch(userSentinelRef, (newEl, oldEl) => {
  if (!process.client || !userObserver) return
  if (oldEl) userObserver.unobserve(oldEl)
  if (newEl) userObserver.observe(newEl)
})

onMounted(() => {
  setupPageObserver()
  setupUserObserver()
})

onBeforeUnmount(() => {
  if (pageObserver) {
    pageObserver.disconnect()
    pageObserver = null
  }
  if (userObserver) {
    userObserver.disconnect()
    userObserver = null
  }
  if (process.client) {
    searchCache.value.scrollY = window.scrollY
  }
})

const performAdvancedSearch = () => {
  const query = searchForm.value.query.trim();
  
  // 检查是否有任何搜索条件
  const hasAnyCondition = query || 
    searchForm.value.includeTags.length > 0 || 
    searchForm.value.excludeTags.length > 0 || 
    searchForm.value.ratingMin || 
    searchForm.value.ratingMax;
  
  if (!hasAnyCondition) {
    return;
  }

  // 若用户在输入框中输入了标签但未点击建议，仍然纳入搜索
  const pendingInclude = tagSearchQuery.value.trim();
  if (pendingInclude && !searchForm.value.includeTags.includes(pendingInclude)) {
    searchForm.value.includeTags.push(pendingInclude);
  }
  const pendingExclude = excludeTagSearchQuery.value.trim();
  if (pendingExclude && !searchForm.value.excludeTags.includes(pendingExclude)) {
    searchForm.value.excludeTags.push(pendingExclude);
  }

  const searchParams = buildSearchParamsFromForm();
  
  // 更新URL
  router.push({ path: '/search', query: searchParams });
};

// 根据URL参数初始化搜索
const initializeFromQuery = () => {
  const query = route.query
  const hasAdvancedParams = query.tags || query.excludeTags || query.ratingMin || query.ratingMax || (query.orderBy && query.orderBy !== 'relevance') || query.advanced || String(query.onlyIncludeTags || '').toLowerCase() === 'true'

  showAdvanced.value = Boolean(hasAdvancedParams || !query.q)

  searchForm.value.query = String((query as any).query ?? query.q ?? '')
  searchForm.value.includeTags = query.tags ? (Array.isArray(query.tags) ? query.tags as string[] : [String(query.tags)]) : []
  searchForm.value.excludeTags = query.excludeTags ? (Array.isArray(query.excludeTags) ? query.excludeTags as string[] : [String(query.excludeTags)]) : []
  searchForm.value.onlyIncludeTags = ['true', '1', 'yes'].includes(String(query.onlyIncludeTags || '').toLowerCase())
  searchForm.value.ratingMin = String(query.ratingMin || '')
  searchForm.value.ratingMax = String(query.ratingMax || '')
  searchForm.value.orderBy = String(query.orderBy || 'relevance')

  if (restoreFromCacheIfAvailable(currentQueryKey.value)) {
    return
  }

  if (hasSearchCriteria()) {
    void performSearch()
  } else {
    resetPagination()
    totalUsers.value = 0
    totalPages.value = 0
    searchPerformed.value = true
    initialLoading.value = false
    updateCache()
  }
}

const performSearch = async () => {
  error.value = false
  searchPerformed.value = true
  const hasAnyCondition = hasSearchCriteria()

  if (!hasAnyCondition) {
    resetPagination()
    totalUsers.value = 0
    totalPages.value = 0
    updateCache()
    return
  }

  initialLoading.value = true
  resetPagination()

  const routerParams = buildSearchParamsFromForm()
  const apiParams: Record<string, any> = { ...routerParams }
  apiParams.orderBy = searchForm.value.orderBy || 'relevance'
  lastSearchParams.value = apiParams

  try {
    if (apiParams.query) {
      await Promise.all([
        fetchUsers(apiParams, { append: false }),
        fetchPages(apiParams, { append: false })
      ])
    } else {
      await fetchPages(apiParams, { append: false })
      userResults.value = []
      totalUsers.value = 0
      userOffset.value = 0
      userHasMore.value = false
    }
  } finally {
    initialLoading.value = false
    updateCache()
  }
}

// 监听URL变化（使用 fullPath 更稳健，避免对象复用导致不触发）
watch(() => route.fullPath, () => {
  initializeFromQuery();
}, { immediate: true });

// 页面标题：根据搜索条件动态更新
const pageTitle = computed(() => {
  const q = (searchForm.value.query || '').trim()
  const hasTag = (searchForm.value.includeTags?.length || 0) > 0
  if (q && hasTag) return '搜索：' + q + '（含标签）'
  if (q) return '搜索：' + q
  if (hasTag) return '搜索：按标签'
  return '搜索'
})

useHead({ title: pageTitle });
</script>
