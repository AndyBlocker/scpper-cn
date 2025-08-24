<template>
  <div class="min-h-screen bg-neutral-50 dark:bg-neutral-950">
    <header class="bg-white dark:bg-neutral-900 border-b border-neutral-200 dark:border-neutral-800 sticky top-0 z-50">
      <div class="max-w-7xl mx-auto px-4 py-4 flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-6 justify-between">
        <div class="flex items-center gap-3">
          <div class="font-bold text-lg text-neutral-800 dark:text-neutral-100">SCPPER-CN</div>
        </div>
        <form class="relative w-full max-w-md" @submit.prevent="onSearch">
          <input 
            v-model="q" 
            @input="handleInput"
            @focus="handleFocus"
            @blur="handleBlur"
            @keydown="handleKeyDown"
            placeholder="搜索页面 / 用户 / 标签…" 
            class="w-full bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg px-4 py-2 text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-transparent transition-all" 
          />
          <button type="submit" class="absolute right-2 top-1/2 -translate-y-1/2 text-emerald-600 hover:text-emerald-700 p-1">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
          <!-- 搜索建议框 -->
          <div v-if="showSuggestions" class="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto">
            <div v-if="suggestionsLoading" class="p-3 text-sm text-neutral-500 dark:text-neutral-400">搜索中...</div>
            <div v-else-if="suggestions.length === 0 && q.length >= 2" class="p-3 text-sm text-neutral-500 dark:text-neutral-400">没有找到相关结果</div>
            <div v-else>
              <a 
                v-for="(item, index) in suggestions" 
                :key="item.wikidotId || item.id"
                :href="item.type === 'user' ? `/user/${item.wikidotId}` : `/page/${item.wikidotId}`"
                @click.prevent="selectSuggestion(item)"
                @mouseenter="selectedIndex = index"
                class="block px-4 py-2 hover:bg-emerald-50 dark:hover:bg-emerald-900/20 cursor-pointer transition-colors"
                :class="{ 'bg-emerald-50 dark:bg-emerald-900/20': selectedIndex === index }"
              >
                <div class="flex items-center justify-between">
                  <div class="font-medium text-sm text-neutral-800 dark:text-neutral-200 truncate">{{ item.title || item.displayName }}</div>
                  <div class="text-xs text-neutral-500 dark:text-neutral-400 ml-2">{{ item.type || 'page' }}</div>
                </div>
                <div v-if="item.snippet" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1" v-html="item.snippet"></div>
              </a>
            </div>
          </div>
        </form>
        <div class="flex items-center gap-3">
          <button @click="toggleTheme" class="px-3 py-1.5 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg hover:shadow-md transition-all text-sm font-medium text-neutral-700 dark:text-neutral-300">
            {{ themeLabel }}
          </button>
        </div>
      </div>
    </header>
    <main class="max-w-7xl mx-auto px-4 py-6">
      <slot />
    </main>
    <footer class="border-t border-neutral-800 text-center text-xs text-neutral-500 py-6">© {{ new Date().getFullYear() }} SCPPER-CN</footer>
  </div>
</template>

<script setup lang="ts">
const q = ref('');
const themeLabel = ref('浅色');
const showSuggestions = ref(false);
const suggestions = ref<any[]>([]);
const suggestionsLoading = ref(false);
const selectedIndex = ref(-1);
const {$bff} = useNuxtApp();

// 主题状态
const currentTheme = ref('dark');

const applyTheme = (mode: string) => {
  if (process.client) {
    const root = document.documentElement;
    if (mode === 'light') {
      root.classList.remove('dark');
      root.classList.add('light');
      themeLabel.value = '🌙 深色';
    } else {
      root.classList.remove('light');
      root.classList.add('dark');
      themeLabel.value = '☀️ 浅色';
    }
    localStorage.setItem('theme', mode);
    currentTheme.value = mode;
  }
};

const toggleTheme = () => {
  const newTheme = currentTheme.value === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
};

onMounted(() => {
  // 初始化主题
  const saved = localStorage.getItem('theme') || 'dark';
  
  // 确保HTML元素有正确的类
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  
  applyTheme(saved);
});

function onSearch() {
  const term = q.value.trim();
  if (!term) return;
  showSuggestions.value = false;
  navigateTo({ path: '/search', query: { q: term } });
}

// 搜索建议功能
let searchTimeout: NodeJS.Timeout | null = null;

const handleInput = () => {
  selectedIndex.value = -1;
  
  if (searchTimeout) {
    clearTimeout(searchTimeout);
  }
  
  const query = q.value.trim();
  
  if (query.length < 2) {
    suggestions.value = [];
    showSuggestions.value = false;
    return;
  }
  
  searchTimeout = setTimeout(async () => {
    suggestionsLoading.value = true;
    showSuggestions.value = true;
    
    try {
      const data = await $bff('/search/all', { params: { query, limit: 10 } });
      suggestions.value = data.results || [];
    } catch (error) {
      console.error('获取搜索建议失败:', error);
      suggestions.value = [];
    } finally {
      suggestionsLoading.value = false;
    }
  }, 300); // 300ms 防抖
};

const handleFocus = () => {
  if (q.value.length >= 2 && suggestions.value.length > 0) {
    showSuggestions.value = true;
  }
};

const handleBlur = () => {
  // 延迟关闭，以便点击建议
  setTimeout(() => {
    showSuggestions.value = false;
  }, 200);
};

const handleKeyDown = (e: KeyboardEvent) => {
  if (!showSuggestions.value || suggestions.value.length === 0) return;
  
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIndex.value = Math.min(selectedIndex.value + 1, suggestions.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIndex.value = Math.max(selectedIndex.value - 1, -1);
  } else if (e.key === 'Enter' && selectedIndex.value >= 0) {
    e.preventDefault();
    selectSuggestion(suggestions.value[selectedIndex.value]);
  } else if (e.key === 'Escape') {
    showSuggestions.value = false;
  }
};

const selectSuggestion = (item: any) => {
  const path = item.type === 'user' ? `/user/${item.wikidotId}` : `/page/${item.wikidotId}`;
  showSuggestions.value = false;
  q.value = '';
  navigateTo(path);
};
</script>


