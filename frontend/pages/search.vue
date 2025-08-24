<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between border-b-2 border-emerald-100 dark:border-emerald-900/30 pb-3">
      <div class="flex items-center gap-3">
        <div class="h-8 w-1 bg-emerald-600 rounded" />
        <h2 class="text-lg font-bold text-neutral-800 dark:text-neutral-100">搜索结果</h2>
      </div>
    </div>
    <div v-if="loading" class="text-sm text-neutral-600 dark:text-neutral-400">搜索中…</div>
    <div v-else-if="error" class="text-sm text-red-600 dark:text-red-400">搜索失败，请稍后重试</div>
    <div v-else>
      <div class="text-sm text-neutral-600 dark:text-neutral-400 mb-4">共找到 <span class="font-semibold text-emerald-600 dark:text-emerald-400">{{ results.length }}</span> 条结果</div>
      <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        <NuxtLink 
          v-for="p in results" 
          :key="p.wikidotId || p.id" 
          :to="p.type==='user'?`/user/${p.wikidotId}`:`/page/${p.wikidotId}`" 
          class="group relative border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 bg-white dark:bg-neutral-900 hover:shadow-lg dark:hover:shadow-emerald-900/10 transition-all duration-200 flex flex-col gap-3"
        >
          <div class="flex items-center justify-between">
            <div class="font-semibold text-neutral-900 dark:text-neutral-100 truncate" :title="p.title || p.displayName">{{ p.title || p.displayName }}</div>
            <div class="text-xs px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400">{{ p.type || 'page' }}</div>
          </div>
          <div class="text-xs text-neutral-600 dark:text-neutral-400 line-clamp-3" v-html="p.snippet || ''"></div>
          <div class="absolute inset-0 rounded-lg ring-2 ring-emerald-500 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none" />
        </NuxtLink>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
const route = useRoute();
const {$bff} = useNuxtApp();
const loading = ref(true);
const results = ref<any[]>([]);
const error = ref(false);

watchEffect(async () => {
  const q = String(route.query.q || '').trim();
  loading.value = true;
  error.value = false;
  if (!q) { 
    results.value = []; 
    loading.value = false; 
    return; 
  }
  try {
    const data = await $bff('/search/all', { params: { query: q, limit: 30 } });
    results.value = data.results || [];
  } catch (err) {
    console.error('搜索失败:', err);
    results.value = [];
    error.value = true;
  } finally {
    loading.value = false;
  }
});
</script>


