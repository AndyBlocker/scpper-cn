<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-neutral-900">
    <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-200 mb-1">作者指纹</h2>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mb-4">每位作者最具区分度的签名词（TF-IDF 排序），点击行展开词汇详情</p>
    <div v-if="pending" class="h-48 flex items-center justify-center text-neutral-400">加载中...</div>
    <div v-else-if="!authors?.items?.length" class="h-48 flex items-center justify-center text-neutral-400">暂无数据</div>
    <div v-else>
      <!-- Search -->
      <input
        v-model="search"
        type="text"
        placeholder="搜索作者..."
        class="w-full sm:w-64 mb-4 px-3 py-1.5 text-sm rounded-lg border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-800 dark:text-neutral-200"
      />
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-neutral-200 dark:border-neutral-700 text-left text-neutral-500 dark:text-neutral-400">
              <th class="py-2 pr-3 font-medium">作者</th>
              <th class="py-2 pr-3 font-medium">页面数</th>
              <th class="py-2 pr-3 font-medium">平均词长</th>
              <th class="py-2 pr-3 font-medium">TTR</th>
              <th class="py-2 font-medium">签名词</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="a in filtered"
              :key="a.userId"
              class="border-b border-neutral-100 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800/50 transition-colors"
            >
              <td class="py-2 pr-3 font-medium text-neutral-800 dark:text-neutral-200">{{ a.displayName }}</td>
              <td class="py-2 pr-3 text-neutral-600 dark:text-neutral-400">{{ a.pageCount }}</td>
              <td class="py-2 pr-3 text-neutral-600 dark:text-neutral-400">{{ a.avgWordLength.toFixed(2) }}</td>
              <td class="py-2 pr-3 text-neutral-600 dark:text-neutral-400">{{ a.ttr.toFixed(3) }}</td>
              <td class="py-2">
                <span
                  v-for="w in a.topWords.slice(0, 6)"
                  :key="w.word"
                  class="inline-block mr-1.5 mb-1 px-2 py-0.5 text-xs rounded-full bg-[rgba(var(--accent),0.1)] text-[rgb(var(--accent))]"
                  :title="`TF-IDF: ${w.tfidf.toFixed(4)}`"
                >
                  {{ w.word }}
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import type { AuthorFingerprint } from '~/types/text-analysis'

const { data: authors, pending } = useAsyncData<{ items: AuthorFingerprint[]; total: number }>(
  'text-analysis-authors',
  () => $fetch('/api/text-analysis/author-fingerprints?limit=200')
)

const search = ref('')

const filtered = computed(() => {
  const items = authors.value?.items || []
  if (!search.value.trim()) return items
  const q = search.value.trim().toLowerCase()
  return items.filter(a => a.displayName.toLowerCase().includes(q))
})
</script>
