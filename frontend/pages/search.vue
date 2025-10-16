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
              <option value="rating">评分</option>
              <option value="recent">最新</option>
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
        <div class="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          找到用户 <span class="font-semibold text-[rgb(var(--accent))]">{{ totalUsers }}</span>
          ，页面 <span class="font-semibold text-[rgb(var(--accent))]">{{ totalPages }}</span>
        </div>
        <!-- Users on top -->
        <div v-if="totalUsers > 0 || usersLoading">
          <div class="text-xs text-neutral-500 dark:text-neutral-400 mb-2">用户</div>
          <div class="relative">
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <template v-for="u in userResults" :key="u.wikidotId || u.id">
                <UserCard
                  size="md"
                  :wikidot-id="u.wikidotId"
                  :display-name="u.displayName"
                  :rank="u.rank"
                  :totals="{ totalRating: u.totalRating, works: u.pageCount }"
                />
              </template>
            </div>
            <div v-if="usersLoading" class="absolute inset-0 rounded bg-neutral-100/70 dark:bg-neutral-800/60 flex items-center justify-center">
              <span class="text-[12px] text-neutral-600 dark:text-neutral-300">加载中…</span>
            </div>
          </div>
          <div class="flex items-center justify-end gap-2 mt-3">
            <button class="px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-700 disabled:opacity-50"
                    :disabled="userPageIndex === 0 || usersLoading"
                    @click="userPageIndex = Math.max(0, userPageIndex - 1)">上一页</button>
            <div class="text-xs text-neutral-500 dark:text-neutral-400">第 {{ userPageIndex + 1 }} / {{ Math.max(1, Math.ceil(totalUsers / userPageSize)) }} 页</div>
            <button class="px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-700 disabled:opacity-50"
                    :disabled="(userPageIndex + 1) >= Math.ceil(totalUsers / userPageSize) || usersLoading"
                    @click="userPageIndex = userPageIndex + 1">下一页</button>
          </div>
        </div>
        <!-- Pages below -->
        <div v-if="totalPages > 0 || pagesLoading" class="mt-5">
          <div class="text-xs text-neutral-500 dark:text-neutral-400 mb-2">页面</div>
          <div class="relative">
            <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <template v-for="p in pageResults" :key="p.wikidotId || p.id">
                <PageCard size="md" :p="normalizePage(p)" />
              </template>
            </div>
            <div v-if="pagesLoading" class="absolute inset-0 rounded bg-neutral-100/70 dark:bg-neutral-800/60 flex items-center justify-center">
              <span class="text-[12px] text-neutral-600 dark:text-neutral-300">加载中…</span>
            </div>
          </div>
          <div class="flex items-center justify-end gap-2 mt-3">
            <button class="px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-700 disabled:opacity-50"
                    :disabled="pagePageIndex === 0 || pagesLoading"
                    @click="pagePageIndex = Math.max(0, pagePageIndex - 1)">上一页</button>
            <div class="text-xs text-neutral-500 dark:text-neutral-400">第 {{ pagePageIndex + 1 }} / {{ Math.max(1, Math.ceil(totalPages / pagePageSize)) }} 页</div>
            <button class="px-2 py-1 text-xs rounded border border-neutral-300 dark:border-neutral-700 disabled:opacity-50"
                    :disabled="(pagePageIndex + 1) >= Math.ceil(totalPages / pagePageSize) || pagesLoading"
                    @click="pagePageIndex = pagePageIndex + 1">下一页</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNuxtApp, useHead } from 'nuxt/app'

const route = useRoute();
const router = useRouter();
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
const userPageIndex = ref(0) // 0-based
const pagePageIndex = ref(0)
const userPageSize = 12
const pagePageSize = 12
const usersLoading = ref(false)
const pagesLoading = ref(false)

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
    tags: p.tags,
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

// 搜索功能
async function fetchUsers(params: any) {
  usersLoading.value = true;
  try {
    const resp = await bff('/search/users', { params: { ...params, limit: userPageSize, offset: userPageIndex.value * userPageSize, includeTotal: userPageIndex.value === 0 } });
    userResults.value = resp.results || resp || [];
    if (typeof resp.total === 'number') totalUsers.value = Number(resp.total || 0);
  } catch (err) {
    console.error('搜索用户失败:', err);
    userResults.value = [];
    totalUsers.value = 0;
    error.value = true;
  } finally {
    usersLoading.value = false;
  }
}

async function fetchPages(params: any) {
  pagesLoading.value = true;
  try {
    const searchParams = {
      ...params,
      limit: pagePageSize,
      offset: pagePageIndex.value * pagePageSize,
      includeTotal: pagePageIndex.value === 0,
      includeSnippet: true,
      includeDate: pagePageIndex.value === 0
    } as Record<string, any>;

    const resp = await bff('/search/pages', { params: searchParams });
    pageResults.value = resp.results || resp || [];
    if (typeof resp.total === 'number') totalPages.value = Number(resp.total || 0);
  } catch (err) {
    console.error('搜索页面失败:', err);
    pageResults.value = [];
    totalPages.value = 0;
    error.value = true;
  } finally {
    pagesLoading.value = false;
  }
}

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

  const searchParams: any = {};
  
  if (query) searchParams.query = query;
  if (searchForm.value.includeTags.length > 0) searchParams.tags = searchForm.value.includeTags;
  if (searchForm.value.onlyIncludeTags) searchParams.onlyIncludeTags = 'true';
  if (searchForm.value.excludeTags.length > 0) searchParams.excludeTags = searchForm.value.excludeTags;
  if (searchForm.value.ratingMin) searchParams.ratingMin = searchForm.value.ratingMin;
  if (searchForm.value.ratingMax) searchParams.ratingMax = searchForm.value.ratingMax;
  if (searchForm.value.orderBy !== 'relevance') searchParams.orderBy = searchForm.value.orderBy;
  
  // 更新URL
  router.push({ path: '/search', query: searchParams });
  // 主动触发一次搜索，避免路由未变化时页面无响应
  void performSearch();
};

// 根据URL参数初始化搜索
const initializeFromQuery = () => {
  const query = route.query;
  
  // 检查是否是高级搜索
  const hasAdvancedParams = query.tags || query.excludeTags || query.ratingMin || query.ratingMax || (query.orderBy && query.orderBy !== 'relevance') || query.advanced || String(query.onlyIncludeTags || '').toLowerCase() === 'true';
  
  if (hasAdvancedParams || !query.q) {
    showAdvanced.value = true;
    
    // 初始化高级搜索表单（兼容 query 与 q 两种参数名）
    searchForm.value.query = String((query as any).query ?? query.q ?? '');
    searchForm.value.includeTags = query.tags ? (Array.isArray(query.tags) ? query.tags as string[] : [query.tags as string]) : [];
    searchForm.value.excludeTags = query.excludeTags ? (Array.isArray(query.excludeTags) ? query.excludeTags as string[] : [query.excludeTags as string]) : [];
    searchForm.value.onlyIncludeTags = ['true', '1', 'yes'].includes(String(query.onlyIncludeTags || '').toLowerCase());
    searchForm.value.ratingMin = String(query.ratingMin || '');
    searchForm.value.ratingMax = String(query.ratingMax || '');
    searchForm.value.orderBy = String(query.orderBy || 'relevance');
    
    // 高级搜索模式下，即使没有搜索条件也显示空的搜索结果状态
    if (searchForm.value.query || searchForm.value.includeTags.length > 0) {
      performSearch();
    } else {
      searchPerformed.value = true; // 显示空的搜索状态，而不是隐藏搜索结果区域
    }
  } else {
    // 简单搜索模式
    showAdvanced.value = false;
    // 简单搜索模式，兼容 query 与 q
    searchForm.value.query = String((query as any).query ?? query.q ?? '');
    
    if (searchForm.value.query) {
      performSearch();
    }
  }
};

const performSearch = async () => {
  error.value = false;
  searchPerformed.value = true;
  
  // 检查是否有任何搜索条件
  const hasAnyCondition = searchForm.value.query || 
    searchForm.value.includeTags.length > 0 || 
    searchForm.value.excludeTags.length > 0 || 
    searchForm.value.ratingMin || 
    searchForm.value.ratingMax;
  
  if (!hasAnyCondition) {
    userResults.value = [];
    pageResults.value = [];
    totalUsers.value = 0;
    totalPages.value = 0;
    return;
  }
  
  initialLoading.value = true;
  userPageIndex.value = 0;
  pagePageIndex.value = 0;
  
  const searchParams: any = {};
  if (searchForm.value.query) searchParams.query = searchForm.value.query;
  if (searchForm.value.includeTags.length > 0) searchParams.tags = searchForm.value.includeTags;
  if (searchForm.value.onlyIncludeTags) searchParams.onlyIncludeTags = 'true';
  if (searchForm.value.excludeTags.length > 0) searchParams.excludeTags = searchForm.value.excludeTags;
  if (searchForm.value.ratingMin) searchParams.ratingMin = searchForm.value.ratingMin;
  if (searchForm.value.ratingMax) searchParams.ratingMax = searchForm.value.ratingMax;
  searchParams.orderBy = searchForm.value.orderBy;
  
  if (searchParams.query) {
    // 有关键词时搜索用户和页面
    await Promise.all([fetchUsers(searchParams), fetchPages(searchParams)]);
  } else {
    // 无关键词时，仍使用 /search/pages 支持多标签与排除标签
    await fetchPages(searchParams);
    userResults.value = [];
    totalUsers.value = 0;
  }
  
  initialLoading.value = false;
};

// 监听URL变化（使用 fullPath 更稳健，避免对象复用导致不触发）
watch(() => route.fullPath, () => {
  initializeFromQuery();
}, { immediate: true });

// 监听分页变化
watch(userPageIndex, () => {
  const searchParams: any = {};
  if (searchForm.value.query) searchParams.query = searchForm.value.query;
  if (searchForm.value.includeTags.length > 0) searchParams.tags = searchForm.value.includeTags;
  if (searchForm.value.onlyIncludeTags) searchParams.onlyIncludeTags = 'true';
  if (searchForm.value.excludeTags.length > 0) searchParams.excludeTags = searchForm.value.excludeTags;
  if (searchForm.value.ratingMin) searchParams.ratingMin = searchForm.value.ratingMin;
  if (searchForm.value.ratingMax) searchParams.ratingMax = searchForm.value.ratingMax;
  searchParams.orderBy = searchForm.value.orderBy;
  
  if (searchParams.query && Object.keys(searchParams).length > 0) {
    void fetchUsers(searchParams);
  }
});

watch(pagePageIndex, () => {
  const searchParams: any = {};
  if (searchForm.value.query) searchParams.query = searchForm.value.query;
  if (searchForm.value.includeTags.length > 0) searchParams.tags = searchForm.value.includeTags;
  if (searchForm.value.onlyIncludeTags) searchParams.onlyIncludeTags = 'true';
  if (searchForm.value.excludeTags.length > 0) searchParams.excludeTags = searchForm.value.excludeTags;
  if (searchForm.value.ratingMin) searchParams.ratingMin = searchForm.value.ratingMin;
  if (searchForm.value.ratingMax) searchParams.ratingMax = searchForm.value.ratingMax;
  searchParams.orderBy = searchForm.value.orderBy;
  
  if ((searchParams.query || searchForm.value.includeTags.length > 0) && Object.keys(searchParams).length > 0) {
    void fetchPages(searchParams);
  }
});

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
