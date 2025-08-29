<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between border-b-2 border-emerald-100 dark:border-emerald-900/30 pb-3">
      <div class="flex items-center gap-3">
        <div class="h-8 w-1 bg-emerald-600 rounded" />
        <h2 class="text-lg font-bold text-neutral-800 dark:text-neutral-100">搜索结果</h2>
      </div>
    </div>
    <div v-if="initialLoading" class="text-sm text-neutral-600 dark:text-neutral-400">搜索中…</div>
    <div v-else-if="error" class="text-sm text-red-600 dark:text-red-400">搜索失败，请稍后重试</div>
    <div v-else>
      <div class="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
        用户 <span class="font-semibold text-emerald-600 dark:text-emerald-400">{{ totalUsers }}</span>
        ，页面 <span class="font-semibold text-emerald-600 dark:text-emerald-400">{{ totalPages }}</span>
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
</template>

<script setup lang="ts">
import { ref, watch, watchEffect } from 'vue'
import { useRoute } from 'vue-router'
import { useNuxtApp } from 'nuxt/app'
const route = useRoute();
type BffFetcher = <T = any>(url: string, options?: any) => Promise<T>
const { $bff } = useNuxtApp();
const bff = $bff as unknown as BffFetcher
const initialLoading = ref(true);
const error = ref(false);

// 分开拉取用户与页面，分别分页
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
    authors: p.authors,
    tags: p.tags,
    rating: p.rating,
    wilson95: p.wilson95,
    commentCount: p.commentCount ?? p.revisionCount,
    controversy: p.controversy,
    snippetHtml: p.snippet || null,
    createdDate: toISODate(p.firstRevisionAt || p.createdAt || p.validFrom)
  };
}

async function fetchUsers(q: string) {
  usersLoading.value = true;
  try {
    const resp = await bff('/search/users', { params: { query: q, limit: userPageSize, offset: userPageIndex.value * userPageSize, includeTotal: userPageIndex.value === 0 } });
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

async function fetchPages(q: string) {
  pagesLoading.value = true;
  try {
    const resp = await bff('/search/pages', { params: { query: q, limit: pagePageSize, offset: pagePageIndex.value * pagePageSize, orderBy: 'relevance', includeTotal: pagePageIndex.value === 0, includeSnippet: true, includeDate: pagePageIndex.value === 0 } });
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

watch(() => String(route.query.q || '').trim(), async (q) => {
  error.value = false;
  if (!q) {
    userResults.value = [];
    pageResults.value = [];
    totalUsers.value = 0;
    totalPages.value = 0;
    initialLoading.value = false;
    return;
  }
  initialLoading.value = true;
  userPageIndex.value = 0;
  pagePageIndex.value = 0;
  await Promise.all([fetchUsers(q), fetchPages(q)]);
  initialLoading.value = false;
}, { immediate: true });

watch(userPageIndex, () => {
  const q = String(route.query.q || '').trim();
  if (!q) return;
  void fetchUsers(q);
});
watch(pagePageIndex, () => {
  const q = String(route.query.q || '').trim();
  if (!q) return;
  void fetchPages(q);
});

// q 改变时在上面的 watch 中已重置页码并刷新数据
</script>


