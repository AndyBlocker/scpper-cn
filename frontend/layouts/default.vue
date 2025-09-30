<template>
  <div class="relative min-h-screen overflow-hidden bg-[#f6f7fb] dark:bg-[#0b0d12] text-neutral-900 dark:text-neutral-100">
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(10,132,255,0.18),_transparent_58%)] dark:bg-[radial-gradient(circle_at_top,_rgba(64,156,255,0.25),_rgba(11,13,18,0.92)_62%)]"
    ></div>
    <div class="relative z-10 flex min-h-screen flex-col">
      <header class="sticky top-0 z-50 border border-white/60 bg-white/70 shadow-[0_12px_40px_rgba(15,23,42,0.08)] backdrop-blur-2xl dark:border-white/5 dark:bg-neutral-900/65 dark:shadow-[0_14px_40px_rgba(0,0,0,0.45)]">
        <div class="max-w-7xl mx-auto flex items-center gap-3 px-4 py-4 sm:gap-6">
          <div class="flex items-center gap-4 whitespace-nowrap">
            <NuxtLink to="/" class="flex items-center gap-2 group">
              <BrandIcon class="w-8 h-8 text-neutral-900 dark:text-neutral-100 group-hover:text-[rgb(var(--accent))] transition-colors" />
              <span class="hidden sm:inline font-bold text-lg text-neutral-800 dark:text-neutral-100 group-hover:text-[rgb(var(--accent))]">SCPPER-CN</span>
            </NuxtLink>
            <NuxtLink to="/ranking" class="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300 hover:text-[rgb(var(--accent))] whitespace-nowrap">
              <svg class="w-5 h-5 sm:w-4 sm:h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 13h4v7H4v-7zm6-6h4v13h-4V7zm6 3h4v10h-4V10z" />
              </svg>
              <span class="hidden sm:inline">排行</span>
            </NuxtLink>
            <NuxtLink to="/analytics" class="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300 hover:text-[rgb(var(--accent))] whitespace-nowrap">
              <svg class="w-5 h-5 sm:w-4 sm:h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 3v18M3 12h18" />
              </svg>
              <span class="hidden sm:inline">分析</span>
            </NuxtLink>
            <NuxtLink to="/tag-analytics" class="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300 hover:text-[rgb(var(--accent))] whitespace-nowrap">
              <svg class="w-5 h-5 sm:w-4 sm:h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
              </svg>
              <span class="hidden sm:inline">标签</span>
            </NuxtLink>
            <NuxtLink to="/gallery" class="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300 hover:text-[rgb(var(--accent))] whitespace-nowrap">
              <svg class="w-5 h-5 sm:w-4 sm:h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <rect x="3" y="4" width="18" height="16" rx="2" ry="2" stroke-width="2" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12l2.5 3 3.5-5 4 6" />
                <circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" />
              </svg>
              <span class="hidden sm:inline">随机画廊</span>
            </NuxtLink>
            <NuxtLink to="/about" class="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300 hover:text-[rgb(var(--accent))] whitespace-nowrap">
              <svg class="w-5 h-5 sm:w-4 sm:h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <circle cx="12" cy="12" r="9" stroke-width="2" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8h.01" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 12v4" />
              </svg>
              <span class="hidden sm:inline">关于</span>
            </NuxtLink>
          </div>
          <div class="ml-auto flex w-auto items-center gap-2 sm:w-full sm:justify-end">
            <button
              @click="openMobileSearch"
              class="p-2 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg hover:shadow-md transition-all text-neutral-700 dark:text-neutral-300 sm:hidden"
              aria-label="打开搜索"
              title="打开搜索"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
            <form class="relative hidden flex-1 max-w-md sm:block" @submit.prevent="onSearch">
              <input
                v-model="q"
                @input="handleInput"
                @focus="handleFocus"
                @blur="handleBlur"
                @keydown="handleKeyDown"
                placeholder="搜索页面 / 用户 / 标签…"
                class="w-full bg-white/80 dark:bg-neutral-900/70 border border-neutral-200 dark:border-neutral-800 rounded-full px-5 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] focus:border-transparent transition-all backdrop-blur placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
              />
              <button type="submit" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-[rgb(var(--accent-strong))] hover:text-[rgb(var(--accent))] p-1">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </button>
              <div v-if="showSuggestions" class="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto">
                <div v-if="suggestionsLoading" class="p-3 text-sm text-neutral-500 dark:text-neutral-400">搜索中...</div>
                <div v-else-if="suggestions.length === 0 && q.length >= 2" class="p-3 text-sm text-neutral-500 dark:text-neutral-400">没有找到相关结果</div>
                <div v-else>
                  <a
                    v-for="(item, index) in suggestions"
                    :key="item.key"
                    :href="item.href"
                    @click.prevent="selectSuggestion(item)"
                    @mouseenter="selectedIndex = index"
                    class="block px-4 py-2 hover:bg-[rgba(var(--accent),0.08)] dark:hover:bg-[rgba(var(--accent),0.20)] cursor-pointer transition-colors"
                    :class="{ 'bg-[rgba(var(--accent),0.08)] dark:bg-[rgba(var(--accent),0.20)]': selectedIndex === index }"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0 flex-1">
                        <div class="font-medium text-sm text-neutral-800 dark:text-neutral-200 truncate">
                          <span>{{ item.title }}</span>
                          <span v-if="item.subtitle" class="text-neutral-500 dark:text-neutral-400"> - {{ item.subtitle }}</span>
                        </div>
                        <div
                          v-if="item.snippet"
                          class="mt-1 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400"
                          v-html="item.snippet"
                        ></div>
                      </div>
                      <span class="ml-2 shrink-0 rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.08)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--accent-strong))] dark:border-[rgba(var(--accent),0.35)] dark:bg-[rgba(var(--accent),0.18)]">
                        {{ item.badge }}
                      </span>
                    </div>
                  </a>
                </div>
              </div>
            </form>
            <button
              @click="toggleTheme"
              class="p-2 bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg hover:shadow-md transition-all text-neutral-700 dark:text-neutral-300"
              aria-label="切换主题"
              title="切换主题"
            >
              <svg v-if="currentTheme === 'dark'" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v2m0 14v2m4.22-12.22l1.42-1.42M6.34 17.66l-1.42 1.42M21 12h-2M5 12H3m12.66 5.66l1.42 1.42M6.34 6.34L4.92 4.92M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              <svg v-else class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
              </svg>
            </button>
          </div>
        </div>
      </header>

      <div v-if="isMobileSearchOpen" class="fixed inset-0 z-[70]">
        <div class="absolute inset-0 bg-neutral-950/60" @click="closeMobileSearch" />
        <div class="absolute inset-0 flex flex-col">
          <div class="border-b border-white/50 bg-white/80 backdrop-blur dark:border-white/10 dark:bg-neutral-900/80">
            <div class="max-w-7xl mx-auto flex items-center gap-2 px-4 py-3">
              <form class="relative flex-1" @submit.prevent="onSearch">
                <input
                  ref="mobileInputRef"
                  v-model="q"
                  @input="handleInput"
                  @keydown="handleKeyDown"
                  placeholder="搜索页面 / 用户 / 标签…"
                  class="w-full bg-white/85 dark:bg-neutral-900/70 border border-neutral-200 dark:border-neutral-800 rounded-full px-5 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] focus:border-transparent transition-all backdrop-blur placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
                />
                <button type="submit" class="absolute right-2 top-1/2 -translate-y-1/2 text-[rgb(var(--accent-strong))] hover:text-[rgb(var(--accent))] p-1">
                  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </button>
              </form>
              <button
                @click="closeMobileSearch"
                class="p-2 bg-white/80 dark:bg-neutral-800/80 border border-white/60 dark:border-white/10 rounded-lg text-neutral-700 dark:text-neutral-300"
                aria-label="关闭搜索"
                title="关闭搜索"
              >
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div class="flex-1 overflow-y-auto bg-white/85 backdrop-blur dark:bg-neutral-900/85">
            <div class="max-w-7xl mx-auto px-4 py-2">
              <div v-if="suggestionsLoading" class="p-3 text-sm text-neutral-500 dark:text-neutral-400">搜索中...</div>
              <div v-else-if="suggestions.length === 0 && q.length >= 2" class="p-3 text-sm text-neutral-500 dark:text-neutral-400">没有找到相关结果</div>
              <div v-else>
                <a
                  v-for="(item, index) in suggestions"
                  :key="item.key"
                  :href="item.href"
                  @click.prevent="selectSuggestion(item)"
                  @mouseenter="selectedIndex = index"
                  class="block px-4 py-3 border-b border-neutral-200/70 dark:border-neutral-800/70 hover:bg-[rgba(var(--accent),0.08)] dark:hover:bg-[rgba(var(--accent),0.20)] transition-colors"
                  :class="{ 'bg-[rgba(var(--accent),0.08)] dark:bg-[rgba(var(--accent),0.20)]': selectedIndex === index }"
                >
                  <div class="flex items-start justify-between gap-3">
                    <div class="min-w-0 flex-1">
                      <div class="font-medium text-sm text-neutral-800 dark:text-neutral-200 truncate">
                        <span>{{ item.title }}</span>
                        <span v-if="item.subtitle" class="text-neutral-500 dark:text-neutral-400"> - {{ item.subtitle }}</span>
                      </div>
                      <div
                        v-if="item.snippet"
                        class="mt-1 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400"
                        v-html="item.snippet"
                      ></div>
                    </div>
                    <span class="ml-2 shrink-0 rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.08)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--accent-strong))] dark:border-[rgba(var(--accent),0.35)] dark:bg-[rgba(var(--accent),0.18)]">
                      {{ item.badge }}
                    </span>
                  </div>
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>

      <main class="w-full px-4 pt-10 pb-16 sm:px-6 md:px-8">
        <div class="max-w-7xl mx-auto">
          <slot />
        </div>
      </main>
      <footer class="mt-auto border-t border-white/60 bg-white/60 py-6 text-center text-xs text-neutral-500 backdrop-blur dark:border-white/10 dark:bg-neutral-900/60">© {{ new Date().getFullYear() }} SCPPER-CN</footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import BrandIcon from '../components/BrandIcon.vue'
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useNuxtApp, navigateTo, useHead } from 'nuxt/app'
import { useRoute } from 'vue-router'
const GA_ID = 'G-QCYZ6ZEF46'
useHead({
  script: [
    { src: `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`, async: true },
    { innerHTML: `window.dataLayer = window.dataLayer || [];\nfunction gtag(){dataLayer.push(arguments);}\ngtag('js', new Date());\n\ngtag('config', '${GA_ID}');` }
  ]
})
const q = ref('');
const isMobileSearchOpen = ref(false);
const mobileInputRef = ref<HTMLInputElement | null>(null);
const showSuggestions = ref(false);
type SearchPreviewType = 'page' | 'user'

interface SearchPreviewItem {
  key: string;
  type: SearchPreviewType;
  title: string;
  subtitle: string | null;
  snippet: string | null;
  href: string;
  badge: string;
}

const TYPE_BADGE_LABELS: Record<SearchPreviewType, string> = {
  page: '页面',
  user: '用户'
};

const suggestions = ref<SearchPreviewItem[]>([]);
const suggestionsLoading = ref(false);
const selectedIndex = ref(-1);
type BffFetcher = <T = any>(url: string, options?: any) => Promise<T>
const {$bff} = useNuxtApp() as unknown as { $bff: BffFetcher };

// 主题状态
const currentTheme = ref('dark');

const applyTheme = (mode: string) => {
  if (process.client) {
    const root = document.documentElement;
    if (mode === 'light') {
      root.classList.remove('dark');
      root.classList.add('light');
    } else {
      root.classList.remove('light');
      root.classList.add('dark');
    }
    localStorage.setItem('theme', mode);
    currentTheme.value = mode;
  }
};

// 使用新的默认配色（aurora 蓝）
function enforceDefaultScheme() {
  if (!process.client) return
  const root = document.documentElement
  Array.from(root.classList).forEach(c => { if (c.startsWith('scheme-')) root.classList.remove(c) })
  root.classList.add('scheme-aurora')
  try { localStorage.setItem('color-scheme', 'aurora') } catch {}
}

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
  enforceDefaultScheme();
});

const openMobileSearch = () => {
  isMobileSearchOpen.value = true;
  if (process.client) {
    document.body.style.overflow = 'hidden';
  }
  nextTick(() => {
    mobileInputRef.value?.focus();
  });
};

const closeMobileSearch = () => {
  isMobileSearchOpen.value = false;
  showSuggestions.value = false;
  if (process.client) {
    document.body.style.overflow = '';
  }
};

const openSearch = openMobileSearch; // backward alias if needed
const toggleMobileSearch = () => {
  if (isMobileSearchOpen.value) closeMobileSearch(); else openMobileSearch();
};

function onSearch() {
  const term = q.value.trim();
  if (!term) return;
  showSuggestions.value = false;
  if (isMobileSearchOpen.value) {
    closeMobileSearch();
  }
  navigateTo({ path: '/search', query: { q: term } });
}

// 搜索建议功能
let searchTimeout: NodeJS.Timeout | null = null;

const normalizeSuggestion = (raw: any): SearchPreviewItem | null => {
  if (!raw) return null;
  const type: SearchPreviewType = raw.type === 'user' ? 'user' : 'page';
  const primaryId = raw.wikidotId ?? raw.wikidotID ?? raw.id;
  if (primaryId === undefined || primaryId === null) return null;
  const key = String(primaryId);

  const rawTitle = typeof raw.title === 'string' ? raw.title.trim() : '';
  const rawDisplayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
  const rawAlternate = typeof raw.alternateTitle === 'string' ? raw.alternateTitle.trim() : '';

  const title = type === 'user'
    ? (rawDisplayName || rawTitle || key)
    : (rawTitle || rawDisplayName || rawAlternate || key);

  const subtitle = type === 'page' && rawAlternate && rawAlternate !== title ? rawAlternate : null;
  const snippet = typeof raw.snippet === 'string' && raw.snippet.trim().length > 0 ? raw.snippet : null;

  const href = type === 'user'
    ? `/user/${key}`
    : `/page/${key}`;

  return {
    key,
    type,
    title,
    subtitle,
    snippet,
    href,
    badge: TYPE_BADGE_LABELS[type]
  };
};

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
      const normalized = (data?.results ?? [])
        .map(normalizeSuggestion)
        .filter((item): item is SearchPreviewItem => !!item);
      suggestions.value = normalized;
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
    if (isMobileSearchOpen.value) {
      e.preventDefault();
      closeMobileSearch();
    } else {
      showSuggestions.value = false;
    }
  }
};

const selectSuggestion = (item: SearchPreviewItem) => {
  const path = item.href;
  showSuggestions.value = false;
  q.value = '';
  if (isMobileSearchOpen.value) {
    closeMobileSearch();
  }
  navigateTo(path);
};

// 监听全局 ESC 关闭移动搜索浮层
const handleGlobalKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && isMobileSearchOpen.value) {
    e.preventDefault();
    closeMobileSearch();
  }
};

watch(isMobileSearchOpen, (open) => {
  if (!process.client) return;
  if (open) {
    document.addEventListener('keydown', handleGlobalKeydown);
  } else {
    document.removeEventListener('keydown', handleGlobalKeydown);
  }
});

onBeforeUnmount(() => {
  if (!process.client) return;
  document.removeEventListener('keydown', handleGlobalKeydown);
});

// GA: route change page_view
const route = useRoute()
watch(() => route.fullPath, (path) => {
  if (!process.client) return
  const w = window as unknown as { gtag?: (...args: any[]) => void }
  if (typeof w.gtag === 'function') {
    w.gtag('config', GA_ID, { page_path: path })
  }
})
</script>
