<template>
  <div class="container mx-auto px-4 py-6">
    <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-6">
      <h1 class="text-xl font-bold text-neutral-900 dark:text-neutral-100">标签偏好榜</h1>
      <div class="flex items-center gap-2 w-full sm:w-auto">
        <div class="relative w-full sm:w-80" @click.stop>
          <input
            v-model="search"
            @input="onSearchInput"
            @focus="onSearchFocus"
            @blur="onSearchBlur"
            placeholder="搜索标签，例如 原创 / scp / 故事..."
            class="px-3 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 w-full text-sm"
          />
          <div v-if="suggestionsOpen && suggestions.length > 0" class="absolute z-10 mt-1 w-full rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 shadow max-h-60 overflow-y-auto">
            <button
              v-for="s in suggestions"
              :key="s"
              @click="selectTag(s)"
              class="block w-full text-left px-3 py-2 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 text-neutral-700 dark:text-neutral-200"
            >{{ s }}</button>
          </div>
        </div>
        <select v-model.number="limit" @change="refreshAll" class="px-3 py-1.5 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 text-sm">
          <option :value="10">前10</option>
          <option :value="20">前20</option>
          <option :value="50">前50</option>
        </select>
      </div>
    </div>

    <!-- 选中标签置顶 -->
    <div v-if="selectedTag" class="mb-6">
      <TagBoard
        :tag="selectedTag"
        :limit="limit"
        :offset-lovers="offsetLovers[selectedTag] || 0"
        :offset-haters="offsetHaters[selectedTag] || 0"
        @update:offset-lovers="v => setOffset(selectedTag, 'lovers', v)"
        @update:offset-haters="v => setOffset(selectedTag, 'haters', v)"
      />
    </div>

    <!-- 默认六个标签：桌面两列三行，移动单列；每列一个TagBoard，内部双列(lovers/haters) -->
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
      <TagBoard
        v-for="t in defaultTags"
        :key="t"
        :tag="t"
        :limit="limit"
        :offset-lovers="offsetLovers[t] || 0"
        :offset-haters="offsetHaters[t] || 0"
        @update:offset-lovers="v => setOffset(t, 'lovers', v)"
        @update:offset-haters="v => setOffset(t, 'haters', v)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import TagBoard from '../../components/TagBoard.vue'
import { useNuxtApp } from 'nuxt/app'

type BffFetcher = <T=any>(url: string, options?: any) => Promise<T>
const { $bff } = useNuxtApp()
const bff = $bff as BffFetcher

const defaultTags = ['原创', 'scp', '故事', 'goi格式', 'wanderers', '艺术作品']

const search = ref('')
const suggestions = ref<string[]>([])
const suggestionsOpen = ref(false)
const selectedTag = ref<string | null>(null)
const limit = ref<number>(10)

// pagination state per tag & polarity
const offsetLovers = ref<Record<string, number>>({})
const offsetHaters = ref<Record<string, number>>({})

function setOffset(tag: string, kind: 'lovers'|'haters', v: number) {
  if (kind === 'lovers') offsetLovers.value = { ...offsetLovers.value, [tag]: Math.max(0, v|0) }
  else offsetHaters.value = { ...offsetHaters.value, [tag]: Math.max(0, v|0) }
}

let searchTimer: any
function onSearchInput() {
  suggestionsOpen.value = true
  clearTimeout(searchTimer)
  const q = search.value.trim()
  if (!q) { suggestions.value = []; return }
  searchTimer = setTimeout(async () => {
    const data = await bff<{ results: Array<{ tag: string }> }>('/search/tags', { params: { query: q, limit: 12 } })
    const results = data?.results || []
    suggestions.value = Array.isArray(results) ? results.map(r => r.tag).filter(Boolean) : []
  }, 250)
}

function selectTag(t: string) {
  selectedTag.value = t
  suggestionsOpen.value = false
  suggestions.value = []
  search.value = ''
}

function onSearchFocus() {
  if (search.value.trim() && suggestions.value.length > 0) {
    suggestionsOpen.value = true
  }
}

function onSearchBlur() {
  // Delay to allow click on suggestions
  setTimeout(() => {
    suggestionsOpen.value = false
  }, 150)
}

function refreshAll() {
  // noop here; each TagBoard fetches by itself based on props
}

onMounted(() => { /* initial fetch handled by TagBoard components */ })
</script>

<style scoped>
.container { max-width: 1200px; }
</style>


