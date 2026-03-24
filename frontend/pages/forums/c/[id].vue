<script setup lang="ts">
import { useForumsApi } from '~/composables/api/forums'

definePageMeta({ key: route => route.fullPath })

const route = useRoute()
const categoryId = computed(() => Number(route.params.id))

const { getThreads } = useForumsApi()

const currentPage = ref(1)

const { data, pending, error } = await useAsyncData(
  `forum-category-${categoryId.value}`,
  () => getThreads(categoryId.value, currentPage.value),
  { watch: [categoryId, currentPage] }
)

const totalPages = computed(() => {
  if (!data.value) return 1
  return Math.max(1, Math.ceil(data.value.total / data.value.limit))
})

useHead({
  title: computed(() =>
    data.value?.category?.title
      ? `${data.value.category.title} - 讨论`
      : '讨论分类'
  ),
})

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' })
}

const btnClass = 'px-3 py-1.5 rounded-lg text-sm border border-[rgb(var(--panel-border)_/_0.45)] bg-[rgb(var(--panel)_/_0.88)] text-[rgb(var(--fg))] disabled:opacity-40 hover:border-[var(--g-accent-border)] transition'
</script>

<template>
  <div class="max-w-5xl mx-auto px-4 py-8 space-y-6">
    <!-- Back link -->
    <NuxtLink to="/forums" class="inline-flex items-center gap-1 text-sm text-[var(--g-accent)] hover:underline">
      <LucideIcon name="ArrowLeft" class="w-4 h-4" stroke-width="2" aria-hidden="true" />
      返回讨论
    </NuxtLink>

    <!-- Loading -->
    <div v-if="pending && !data" class="text-center py-10">
      <LucideIcon name="Loader2" class="w-5 h-5 inline-block animate-spin text-[var(--g-accent)]" stroke-width="2" aria-hidden="true" />
      <span class="ml-2 text-sm text-[rgb(var(--muted))]">加载中…</span>
    </div>

    <!-- Error -->
    <div v-else-if="error" class="text-center py-10 text-red-500">
      加载失败
    </div>

    <!-- Content -->
    <template v-else-if="data">
      <header>
        <h1 class="text-2xl font-bold text-[rgb(var(--fg))]">
          {{ data.category?.title || '讨论分类' }}
        </h1>
        <p v-if="data.category?.description" class="mt-1 text-sm text-[rgb(var(--muted))]">
          {{ data.category.description }}
        </p>
        <p class="mt-1 text-xs text-[rgb(var(--muted))]">
          共 {{ data.total }} 个主题
        </p>
      </header>

      <!-- Thread list -->
      <div v-if="data.threads && data.threads.length > 0" class="space-y-2">
        <NuxtLink
          v-for="thread in data.threads"
          :key="thread.id"
          :to="`/forums/t/${thread.id}`"
          class="flex items-start gap-3 rounded-lg border border-[rgb(var(--panel-border)_/_0.35)] bg-[rgb(var(--panel)_/_0.72)] p-3 transition hover:border-[var(--g-accent-border)] hover:bg-[rgb(var(--panel)_/_0.92)]"
        >
          <UserAvatar
            v-if="thread.createdByWikidotId"
            :wikidot-id="thread.createdByWikidotId"
            :name="thread.createdByName"
            :size="32"
            class="shrink-0 mt-0.5"
          />
          <div class="min-w-0 flex-1">
            <h4 class="text-sm font-medium text-[rgb(var(--fg))] line-clamp-1">
              {{ thread.title }}
            </h4>
            <div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-[rgb(var(--muted))]">
              <span v-if="thread.createdByName">{{ thread.createdByName }}</span>
              <span v-if="thread.createdAt">{{ formatDate(thread.createdAt) }}</span>
            </div>
          </div>
          <span class="shrink-0 inline-flex items-center gap-1 rounded-full bg-[rgb(var(--tag-bg))] px-2 py-0.5 text-xs text-[rgb(var(--tag-text))]">
            <LucideIcon name="MessageSquare" class="w-3 h-3" stroke-width="2" aria-hidden="true" />
            {{ thread.postCount }}
          </span>
        </NuxtLink>
      </div>

      <div v-else class="text-sm text-[rgb(var(--muted))] text-center py-8">
        该分类暂无主题
      </div>

      <!-- Pagination -->
      <div v-if="totalPages > 1" class="flex items-center justify-center gap-2">
        <button
          :disabled="currentPage <= 1"
          :class="btnClass"
          @click="currentPage = Math.max(1, currentPage - 1)"
        >
          上一页
        </button>
        <span class="text-sm text-[rgb(var(--muted))]">{{ currentPage }} / {{ totalPages }}</span>
        <button
          :disabled="currentPage >= totalPages"
          :class="btnClass"
          @click="currentPage = Math.min(totalPages, currentPage + 1)"
        >
          下一页
        </button>
      </div>
    </template>
  </div>
</template>
