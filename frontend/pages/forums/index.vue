<script setup lang="ts">
import { useForumsApi } from '~/composables/api/forums'
import ForumRecentPostCard from '~/components/forums/ForumRecentPostCard.vue'

definePageMeta({ key: route => route.fullPath })

type ForumTab = 'recent' | 'categories'

const TABS: Array<{ key: ForumTab; label: string }> = [
  { key: 'recent', label: '最新回帖' },
  { key: 'categories', label: '分类浏览' },
]

const { activeTab, setTab } = useQueryTab<ForumTab>({ defaultTab: 'recent' })

const { getCategories, getForumStats, getRecentPosts } = useForumsApi()

// 统计数据（始终加载）
const { data: stats } = useAsyncData('forum-stats', () => getForumStats())

// Tab 1: 最新回帖（分页）
const recentPage = ref(1)
const { data: recentData, pending: recentPending } = useAsyncData(
  'forum-recent-posts',
  () => getRecentPosts(recentPage.value, 20),
  { watch: [recentPage] }
)

const totalRecentPages = computed(() => {
  if (!recentData.value) return 1
  return Math.max(1, Math.ceil(recentData.value.total / recentData.value.limit))
})

// Tab 2: 分类浏览
const { data: categories, pending: catPending } = useAsyncData(
  'forum-categories',
  () => getCategories()
)

function formatLastPost(dateStr: string | null): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  if (diffMins < 1) return '刚刚'
  if (diffMins < 60) return `${diffMins} 分钟前`
  const diffHours = Math.floor(diffMins / 60)
  if (diffHours < 24) return `${diffHours} 小时前`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 30) return `${diffDays} 天前`
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Shanghai' })
}

useHead({ title: '讨论 - SCPPER-CN' })

const btnClass = 'px-3 py-1.5 rounded-lg text-sm border border-[rgb(var(--panel-border)_/_0.45)] bg-[rgb(var(--panel)_/_0.88)] text-[rgb(var(--fg))] disabled:opacity-40 hover:border-[var(--g-accent-border)] transition'
</script>

<template>
  <div class="max-w-5xl mx-auto px-4 py-8 space-y-8">
    <!-- Header -->
    <header>
      <h1 class="text-2xl font-bold text-[rgb(var(--fg))]">讨论</h1>
      <p class="mt-1 text-sm text-[rgb(var(--muted))]">SCP 中文站讨论区</p>
    </header>

    <!-- Stats bar -->
    <div
      v-if="stats"
      class="rounded-xl border border-[rgb(var(--panel-border)_/_0.45)] bg-[rgb(var(--panel)_/_0.88)] p-4 shadow-sm space-y-4"
    >
      <div class="flex flex-wrap items-center gap-6">
        <div class="text-center">
          <div class="text-lg font-bold text-[var(--g-accent)]">{{ stats.categoriesCount }}</div>
          <div class="text-xs text-[rgb(var(--muted))]">分类</div>
        </div>
        <div class="text-center">
          <div class="text-lg font-bold text-[var(--g-accent)]">{{ stats.threadsCount }}</div>
          <div class="text-xs text-[rgb(var(--muted))]">主题</div>
        </div>
        <div class="text-center">
          <div class="text-lg font-bold text-[var(--g-accent)]">{{ stats.postsCount }}</div>
          <div class="text-xs text-[rgb(var(--muted))]">帖子</div>
        </div>
        <div v-if="stats.lastPostAt" class="text-center ml-auto">
          <div class="text-sm font-medium text-[rgb(var(--fg))]">{{ formatLastPost(stats.lastPostAt) }}</div>
          <div class="text-xs text-[rgb(var(--muted))]">最新回帖</div>
        </div>
      </div>

      <!-- Top posters -->
      <div v-if="stats.topPosters?.length" class="pt-3 border-t border-[rgb(var(--panel-border)_/_0.25)]">
        <div class="text-xs text-[rgb(var(--muted))] mb-2">活跃用户</div>
        <div class="flex flex-wrap gap-2">
          <NuxtLink
            v-for="poster in stats.topPosters.slice(0, 8)"
            :key="poster.wikidotId"
            :to="`/user/${poster.wikidotId}`"
            class="inline-flex items-center gap-1.5 rounded-full bg-[rgb(var(--panel)_/_0.5)] border border-[rgb(var(--panel-border)_/_0.25)] px-2 py-1 text-xs text-[rgb(var(--muted-strong))] hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] transition"
          >
            <UserAvatar
              :wikidot-id="poster.wikidotId"
              :name="poster.name"
              :size="16"
            />
            {{ poster.name }}
            <span class="text-[10px] text-[rgb(var(--muted)_/_0.7)]">{{ poster.postCount }}</span>
          </NuxtLink>
        </div>
      </div>
    </div>

    <!-- Tab bar -->
    <nav class="flex gap-1 border-b border-[rgb(var(--panel-border)_/_0.3)]">
      <button
        v-for="tab in TABS"
        :key="tab.key"
        type="button"
        class="relative px-4 py-2.5 text-sm font-medium transition-colors"
        :class="activeTab === tab.key
          ? 'text-[var(--g-accent)]'
          : 'text-[rgb(var(--muted))] hover:text-[rgb(var(--fg))]'"
        @click="setTab(tab.key)"
      >
        {{ tab.label }}
        <span
          v-if="activeTab === tab.key"
          class="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--g-accent)] rounded-full"
        />
      </button>
    </nav>

    <!-- Tab 1: 最新回帖 -->
    <section v-if="activeTab === 'recent'">
      <div v-if="recentPending && !recentData" class="text-center py-10">
        <LucideIcon name="Loader2" class="w-5 h-5 inline-block animate-spin text-[var(--g-accent)]" stroke-width="2" aria-hidden="true" />
        <span class="ml-2 text-sm text-[rgb(var(--muted))]">加载中…</span>
      </div>

      <template v-else-if="recentData?.posts?.length">
        <div class="space-y-2">
          <ForumRecentPostCard
            v-for="post in recentData.posts"
            :key="post.id"
            :post="post"
          />
        </div>

        <!-- Pagination -->
        <div v-if="totalRecentPages > 1" class="flex items-center justify-center gap-2 mt-6">
          <button
            :disabled="recentPage <= 1"
            :class="btnClass"
            @click="recentPage = Math.max(1, recentPage - 1)"
          >
            上一页
          </button>
          <span class="text-sm text-[rgb(var(--muted))]">{{ recentPage }} / {{ totalRecentPages }}</span>
          <button
            :disabled="recentPage >= totalRecentPages"
            :class="btnClass"
            @click="recentPage = Math.min(totalRecentPages, recentPage + 1)"
          >
            下一页
          </button>
        </div>
      </template>

      <div v-else class="text-sm text-[rgb(var(--muted))] text-center py-8">
        暂无回帖
      </div>
    </section>

    <!-- Tab 2: 分类浏览 -->
    <section v-if="activeTab === 'categories'">
      <div v-if="catPending" class="text-center py-10">
        <LucideIcon name="Loader2" class="w-5 h-5 inline-block animate-spin text-[var(--g-accent)]" stroke-width="2" aria-hidden="true" />
        <span class="ml-2 text-sm text-[rgb(var(--muted))]">加载中…</span>
      </div>

      <div v-else-if="categories && categories.length > 0" class="grid gap-3 sm:grid-cols-2">
        <NuxtLink
          v-for="cat in categories"
          :key="cat.id"
          :to="`/forums/c/${cat.id}`"
          class="block rounded-xl border border-[rgb(var(--panel-border)_/_0.45)] bg-[rgb(var(--panel)_/_0.88)] p-4 shadow-sm transition hover:border-[var(--g-accent-border)] hover:shadow-md"
        >
          <h3 class="text-base font-semibold text-[rgb(var(--fg))]">
            {{ cat.title }}
          </h3>
          <p
            v-if="cat.description"
            class="mt-1 text-sm text-[rgb(var(--muted))] line-clamp-2"
          >
            {{ cat.description }}
          </p>
          <div class="mt-3 flex items-center gap-4 text-xs text-[rgb(var(--muted))]">
            <span class="inline-flex items-center gap-1">
              <LucideIcon name="MessageSquare" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
              {{ cat.threadsCount }} 个主题
            </span>
            <span class="inline-flex items-center gap-1">
              <LucideIcon name="MessagesSquare" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
              {{ cat.postsCount }} 条回复
            </span>
          </div>
        </NuxtLink>
      </div>

      <div v-else class="text-sm text-[rgb(var(--muted))] text-center py-8">
        暂无分类数据
      </div>
    </section>
  </div>
</template>
