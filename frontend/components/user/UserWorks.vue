<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg bg-white dark:bg-neutral-900 shadow-sm">
    <div class="border-b border-neutral-200 dark:border-neutral-800">
      <nav class="flex items-center justify-between px-6" aria-label="Tabs">
        <button
          v-for="tab in workTabs"
          :key="tab.key"
          @click="$emit('update:activeTab', tab.key)"
          :class="[
            'py-3 px-1 border-b-2 font-medium text-sm transition-colors',
            activeTab === tab.key
              ? 'border-[var(--g-accent)] text-[var(--g-accent)]'
              : 'border-transparent text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-300'
          ]"
        >
          {{ tab.label }}
          <span v-if="tab.count !== null && tab.count !== undefined" class="ml-2 text-xs text-neutral-400">({{ tab.count }})</span>
        </button>
        <div class="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
          <label class="sr-only">排序</label>
          <select :value="sortField" @change="$emit('update:sortField', ($event.target as HTMLSelectElement).value)" class="px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">
            <option value="date">按时间</option>
            <option value="rating">按Rating</option>
          </select>
          <select :value="sortOrder" @change="$emit('update:sortOrder', ($event.target as HTMLSelectElement).value)" class="px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">
            <option value="desc">降序</option>
            <option value="asc">升序</option>
          </select>
        </div>
      </nav>
    </div>

    <!-- Works List -->
    <div class="p-6">
      <div v-if="worksPending" class="text-center py-8">
        <LucideIcon name="Loader2" class="w-5 h-5 animate-spin text-[var(--g-accent)] mx-auto" stroke-width="2" />
      </div>
      <div v-else-if="!works || works.length === 0" class="text-center py-8 text-neutral-500 dark:text-neutral-400">
        暂无{{ currentTabLabel }}作品
      </div>
      <div v-else class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        <PageCard
          v-for="work in displayedWorks"
          :key="work.wikidotId"
          size="md"
          :p="work"
          :authors="authors"
        />
      </div>

      <!-- Pagination with selector -->
      <div v-if="totalPages > 1" class="flex flex-wrap items-center justify-center gap-2 mt-6">
        <button
          @click="$emit('update:currentPage', Math.max(1, currentPage - 1))"
          :disabled="currentPage === 1"
          class="px-3 py-1 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700"
        >上一页</button>
        <div class="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-400">
          第
          <select :value="currentPage" @change="$emit('update:currentPage', Number(($event.target as HTMLSelectElement).value))" class="px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">
            <option v-for="n in totalPages" :key="`wp-${n}`" :value="n">{{ n }}</option>
          </select>
          / {{ totalPages }} 页
        </div>
        <button
          @click="$emit('update:currentPage', Math.min(totalPages, currentPage + 1))"
          :disabled="currentPage === totalPages"
          class="px-3 py-1 rounded text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700"
        >下一页</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  workTabs: Array<{ key: string; label: string; count: number }>
  activeTab: string
  sortField: string
  sortOrder: string
  worksPending: boolean
  works: any[] | null
  displayedWorks: any[]
  currentTabLabel: string
  currentPage: number
  totalPages: number
  authors: Array<{ name: string; url: string }>
}>()

defineEmits<{
  'update:activeTab': [key: string]
  'update:sortField': [field: string]
  'update:sortOrder': [order: string]
  'update:currentPage': [page: number]
}>()
</script>
