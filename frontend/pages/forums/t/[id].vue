<script setup lang="ts">
import { useForumsApi } from '~/composables/api/forums'

definePageMeta({ key: route => route.fullPath })

const route = useRoute()
const threadId = computed(() => Number(route.params.id))
const isClient = typeof window !== 'undefined'

const { getThread, locatePost } = useForumsApi()

const currentPage = ref(1)
const sortOrder = ref<'asc' | 'desc'>('asc')
const jumpPageInput = ref('')

// Target post for scrolling (from query param ?postId=xxx)
const targetPostId = ref<number | null>(null)
const highlightedPostId = ref<number | null>(null)

function parsePositiveInt(raw: unknown): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  return parsed
}

watch(
  () => route.query.postId,
  (rawPostId) => {
    targetPostId.value = parsePositiveInt(rawPostId)
  },
  { immediate: true }
)

const { data, pending, error } = useAsyncData(
  `forum-thread-${threadId.value}`,
  () => getThread(threadId.value, currentPage.value, 50, sortOrder.value),
  { watch: [threadId, currentPage, sortOrder] }
)

const totalPages = computed(() => {
  if (!data.value) return 1
  return Math.max(1, Math.ceil(data.value.total / data.value.limit))
})

watch(totalPages, (maxPage) => {
  if (!Number.isInteger(maxPage) || maxPage <= 0) return
  if (currentPage.value > maxPage) {
    currentPage.value = maxPage
  } else if (currentPage.value < 1) {
    currentPage.value = 1
  }
})

function toggleOrder() {
  sortOrder.value = sortOrder.value === 'asc' ? 'desc' : 'asc'
  currentPage.value = 1
}

function jumpToPage() {
  const p = Number(jumpPageInput.value)
  if (Number.isInteger(p) && p >= 1 && p <= totalPages.value) {
    currentPage.value = p
    jumpPageInput.value = ''
  }
}

useHead({
  title: computed(() =>
    data.value?.thread?.title
      ? `${data.value.thread.title} - 讨论`
      : '讨论帖子'
  ),
})

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  })
}

// Build post tree from flat list
interface PostItem {
  id: number
  parentId?: number | null
  title?: string | null
  textHtml?: string | null
  createdByName?: string | null
  createdByWikidotId?: number | null
  createdByType?: string | null
  createdAt?: string | null
  editedAt?: string | null
  isDeleted?: boolean
  sourceThreadUrl?: string | null
  sourcePostUrl?: string | null
  _dbIndex: number // original position in API response
}

interface TreeNode {
  post: PostItem
  children: TreeNode[]
  depth: number
}

const flatPosts = computed(() => {
  const postsRaw: Omit<PostItem, '_dbIndex'>[] = data.value?.posts || []
  // Tag each post with its original database-order index
  const postsArray: PostItem[] = postsRaw.map((p, i) => ({ ...p, _dbIndex: i }))

  const postMap = new Map<number, TreeNode>()
  const roots: TreeNode[] = []

  for (const post of postsArray) {
    postMap.set(post.id, { post, children: [], depth: 0 })
  }

  for (const post of postsArray) {
    const node = postMap.get(post.id)!
    if (post.parentId && postMap.has(post.parentId)) {
      const parent = postMap.get(post.parentId)!
      node.depth = parent.depth + 1
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }

  if (sortOrder.value === 'desc') {
    // Roots in desc order (newest first) — they already come from DB in desc
    // Children: sort chronologically (asc) so replies read naturally
    const sortChildrenAsc = (node: TreeNode) => {
      node.children.sort((a, b) => {
        const ta = a.post.createdAt ? new Date(a.post.createdAt).getTime() : 0
        const tb = b.post.createdAt ? new Date(b.post.createdAt).getTime() : 0
        return ta - tb
      })
      node.children.forEach(sortChildrenAsc)
    }
    roots.forEach(sortChildrenAsc)
  }

  // Flatten via DFS
  const result: Array<{ post: PostItem; depth: number }> = []
  const stack = [...roots].reverse()
  while (stack.length > 0) {
    const node = stack.pop()!
    result.push({ post: node.post, depth: node.depth })
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i])
    }
  }
  return result
})

// Compute floor number for a post based on its original DB position
// 楼层号始终以正序为基准（即按时间先后顺序编号）
function getFloorNumber(item: { post: PostItem }): number {
  if (!data.value) return 0
  const { total, limit } = data.value
  const pageOffset = (currentPage.value - 1) * limit
  if (sortOrder.value === 'asc') {
    return pageOffset + item.post._dbIndex + 1
  }
  return total - pageOffset - item.post._dbIndex
}

// Get parent author name for reply indicator
function getParentAuthor(parentId: number | null | undefined): string | null {
  if (!parentId || !data.value?.posts) return null
  const parent = data.value.posts.find((p: any) => p.id === parentId)
  return parent?.createdByName || null
}

// 使用 DOMPurify 过滤 HTML 并转换 Wikidot 相对链接
function processHtml(html: string | null | undefined): string {
  return sanitizeForumHtml(html)
}

// Scroll to a specific post element and highlight it
function scrollToPost(postId: number) {
  if (!isClient) return
  const el = document.getElementById(`post-${postId}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    highlightedPostId.value = postId
    setTimeout(() => {
      highlightedPostId.value = null
    }, 2500)
  }
}

// Handle post location and scroll after data loads
let locatingPost = false
watch(
  [data, targetPostId],
  async ([newData, currentTargetPostId]) => {
    if (!isClient || locatingPost) return
    if (!currentTargetPostId || !newData) return

    const targetId = currentTargetPostId
    const postOnPage = newData.posts.find((p: any) => p.id === targetId)
    if (postOnPage) {
      await nextTick()
      scrollToPost(targetId)
      if (targetPostId.value === targetId) {
        targetPostId.value = null
      }
      return
    }

    locatingPost = true
    try {
      const location = await locatePost(targetId, sortOrder.value, 50)
      if (location && location.page !== currentPage.value) {
        currentPage.value = location.page
        return
      }
      if (targetPostId.value === targetId) {
        targetPostId.value = null
      }
    } catch {
      if (targetPostId.value === targetId) {
        targetPostId.value = null
      }
    } finally {
      locatingPost = false
    }
  },
  { immediate: true, flush: 'post' }
)

// Handle URL hash: #123 → scroll to floor 123
onMounted(() => {
  const hash = route.hash
  if (hash && /^#\d+$/.test(hash)) {
    const floor = Number(hash.slice(1))
    if (floor >= 1 && data.value) {
      jumpToFloor(floor)
    } else if (floor >= 1) {
      // data not yet loaded, watch for it
      const stop = watch(data, (newData) => {
        if (newData) {
          stop()
          jumpToFloor(floor)
        }
      })
    }
  }
})

function jumpToFloor(floor: number) {
  if (!data.value) return
  const { total, limit } = data.value
  if (floor < 1 || floor > total) return

  // 楼层号始终以正序为基准
  const targetPage = sortOrder.value === 'asc'
    ? Math.ceil(floor / limit)
    : Math.ceil((total - floor + 1) / limit)

  if (targetPage !== currentPage.value) {
    // 需要切换页面后再滚动
    pendingFloorScroll.value = floor
    currentPage.value = targetPage
  } else {
    scrollToFloor(floor)
  }
}

const pendingFloorScroll = ref<number | null>(null)

watch(data, async () => {
  if (pendingFloorScroll.value && data.value) {
    await nextTick()
    scrollToFloor(pendingFloorScroll.value)
    pendingFloorScroll.value = null
  }
})

function scrollToFloor(floor: number) {
  const el = document.getElementById(`floor-${floor}`)
  if (el) {
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    // Find the post id for this floor to highlight
    const item = flatPosts.value.find(fp => getFloorNumber(fp) === floor)
    if (item) {
      highlightedPostId.value = item.post.id
      setTimeout(() => {
        highlightedPostId.value = null
      }, 2500)
    }
  }
}

const btnClass = 'px-3 py-1.5 rounded-lg text-sm border border-[rgb(var(--panel-border)_/_0.45)] bg-[rgb(var(--panel)_/_0.88)] text-[rgb(var(--fg))] disabled:opacity-40 hover:border-[var(--g-accent-border)] transition'

// Wikidot 折叠块点击切换（事件委托）
const postsContainerRef = ref<HTMLElement | null>(null)

function handleCollapsibleClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  const link = target.closest('.collapsible-block-link') as HTMLElement | null
  if (!link) return
  e.preventDefault()
  const block = link.closest('.collapsible-block')
  if (block) block.classList.toggle('is-open')
}

onMounted(() => {
  postsContainerRef.value?.addEventListener('click', handleCollapsibleClick)
})

onUnmounted(() => {
  postsContainerRef.value?.removeEventListener('click', handleCollapsibleClick)
})

// Copy floor link to clipboard and update URL hash
function copyFloorLink(floor: number) {
  const url = `${window.location.origin}${window.location.pathname}#${floor}`
  navigator.clipboard.writeText(url).catch(() => {})
  window.history.replaceState(null, '', `#${floor}`)
}
</script>

<template>
  <div class="max-w-5xl mx-auto px-4 py-8 space-y-6">
    <!-- Back link -->
    <NuxtLink
      :to="data?.thread?.categoryId ? `/forums/c/${data.thread.categoryId}` : '/forums'"
      class="inline-flex items-center gap-1 text-sm text-[var(--g-accent)] hover:underline"
    >
      <LucideIcon name="ArrowLeft" class="w-4 h-4" stroke-width="2" aria-hidden="true" />
      {{ data?.thread?.categoryTitle || '返回讨论' }}
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
      <header class="space-y-2">
        <h1 class="text-xl font-bold text-[rgb(var(--fg))]">
          {{ data.thread?.title || '无标题' }}
        </h1>

        <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[rgb(var(--muted))]">
          <span v-if="data.thread?.createdByName" class="inline-flex items-center gap-1.5">
            <UserAvatar
              v-if="data.thread.createdByWikidotId"
              :wikidot-id="data.thread.createdByWikidotId"
              :name="data.thread.createdByName"
              :size="18"
            />
            <NuxtLink
              v-if="data.thread.createdByWikidotId"
              :to="`/user/${data.thread.createdByWikidotId}`"
              class="hover:text-[var(--g-accent)] transition-colors"
            >
              {{ data.thread.createdByName }}
            </NuxtLink>
            <span v-else>{{ data.thread.createdByName }}</span>
          </span>
          <span v-if="data.thread?.createdAt" class="inline-flex items-center gap-1">
            <LucideIcon name="Calendar" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            {{ formatDate(data.thread.createdAt) }}
          </span>
          <span class="inline-flex items-center gap-1">
            <LucideIcon name="MessageSquare" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            {{ data.total || data.thread?.postCount || 0 }} 条回复
          </span>
          <NuxtLink
            v-if="data.thread?.pageWikidotId"
            :to="`/page/${data.thread.pageWikidotId}`"
            class="inline-flex items-center gap-1 text-[var(--g-accent)] hover:underline"
          >
            <LucideIcon name="FileText" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            查看关联页面
          </NuxtLink>
          <a
            v-if="data.thread?.sourceThreadUrl"
            :href="data.thread.sourceThreadUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-1 text-[var(--g-accent)] hover:underline"
          >
            <LucideIcon name="ExternalLink" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            原帖
          </a>
        </div>

        <p v-if="data.thread?.description" class="text-sm text-[rgb(var(--muted-strong))]">
          {{ data.thread.description }}
        </p>
      </header>

      <!-- Toolbar: sort + pagination -->
      <div class="flex flex-wrap items-center justify-between gap-2">
        <button
          type="button"
          :class="btnClass"
          class="inline-flex items-center gap-1.5"
          @click="toggleOrder"
        >
          <LucideIcon
            :name="sortOrder === 'asc' ? 'ArrowUpNarrowWide' : 'ArrowDownWideNarrow'"
            class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true"
          />
          {{ sortOrder === 'asc' ? '正序' : '倒序' }}
        </button>

        <div v-if="totalPages > 1" class="flex items-center gap-2">
          <button :disabled="currentPage <= 1" :class="btnClass" @click="currentPage--">
            <LucideIcon name="ChevronLeft" class="w-4 h-4" stroke-width="2" aria-hidden="true" />
          </button>
          <span class="text-sm text-[rgb(var(--muted))]">{{ currentPage }} / {{ totalPages }}</span>
          <button :disabled="currentPage >= totalPages" :class="btnClass" @click="currentPage++">
            <LucideIcon name="ChevronRight" class="w-4 h-4" stroke-width="2" aria-hidden="true" />
          </button>
          <form class="inline-flex items-center gap-1" @submit.prevent="jumpToPage">
            <input
              v-model="jumpPageInput"
              type="number"
              :min="1"
              :max="totalPages"
              :placeholder="`1-${totalPages}`"
              class="w-16 rounded-lg border border-[rgb(var(--panel-border)_/_0.45)] bg-[rgb(var(--panel)_/_0.88)] px-2 py-1.5 text-sm text-[rgb(var(--fg))] text-center outline-none focus:border-[var(--g-accent-border)] transition"
            />
            <button type="submit" :class="btnClass">跳转</button>
          </form>
        </div>
      </div>

      <!-- Loading overlay for page/sort changes -->
      <div v-if="pending" class="text-center py-4">
        <LucideIcon name="Loader2" class="w-4 h-4 inline-block animate-spin text-[var(--g-accent)]" stroke-width="2" aria-hidden="true" />
      </div>

      <!-- Posts (tree layout) -->
      <section ref="postsContainerRef" class="space-y-2">
        <template v-if="flatPosts.length > 0">
          <div
            v-for="item in flatPosts"
            :id="`post-${item.post.id}`"
            :key="item.post.id"
            class="rounded-lg border border-[rgb(var(--panel-border)_/_0.35)] bg-[rgb(var(--panel)_/_0.72)] p-3 transition-all duration-300"
            :class="{
              'opacity-50': item.post.isDeleted,
              'post-highlight': highlightedPostId === item.post.id,
            }"
            :style="item.depth > 0 ? { marginLeft: `${Math.min(item.depth, 4) * 20}px` } : undefined"
          >
            <!-- Floor anchor (invisible, for #N linking) -->
            <span :id="`floor-${getFloorNumber(item)}`" class="invisible absolute" />

            <!-- Post header -->
            <div class="flex flex-wrap items-center gap-2 text-xs text-[rgb(var(--muted))]">
              <!-- Floor number as anchor link -->
              <a
                :href="`#${getFloorNumber(item)}`"
                class="shrink-0 font-mono text-[11px] text-[rgb(var(--muted)_/_0.6)] hover:text-[var(--g-accent)] transition-colors"
                :title="`#${getFloorNumber(item)} 楼`"
                @click.prevent="copyFloorLink(getFloorNumber(item))"
              >#{{ getFloorNumber(item) }}</a>

              <UserAvatar
                v-if="item.post.createdByWikidotId"
                :wikidot-id="item.post.createdByWikidotId"
                :name="item.post.createdByName"
                :size="22"
              />
              <NuxtLink
                v-if="item.post.createdByWikidotId && item.post.createdByName"
                :to="`/user/${item.post.createdByWikidotId}`"
                class="font-medium text-[rgb(var(--muted-strong))] hover:text-[var(--g-accent)] transition-colors"
              >
                {{ item.post.createdByName }}
              </NuxtLink>
              <span v-else-if="item.post.createdByName" class="font-medium text-[rgb(var(--muted-strong))]">
                {{ item.post.createdByName }}
              </span>
              <span v-else class="italic">匿名用户</span>

              <span v-if="item.post.createdByType && item.post.createdByType !== 'User'" class="text-[10px] rounded bg-[rgb(var(--tag-bg))] px-1 text-[rgb(var(--tag-text))]">
                {{ item.post.createdByType }}
              </span>

              <span class="text-[rgb(var(--muted)_/_0.4)]">·</span>
              <span v-if="item.post.createdAt">{{ formatDate(item.post.createdAt) }}</span>

              <template v-if="item.post.editedAt">
                <span class="text-[rgb(var(--muted)_/_0.4)]">·</span>
                <span class="italic">编辑于 {{ formatDate(item.post.editedAt) }}</span>
              </template>

              <span v-if="item.post.isDeleted" class="text-red-500 dark:text-red-400 font-medium">[已删除]</span>
              <a
                v-if="item.post.sourcePostUrl"
                :href="item.post.sourcePostUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="ml-auto inline-flex items-center gap-1 text-[var(--g-accent)] hover:underline"
              >
                <LucideIcon name="ExternalLink" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
                原帖
              </a>
            </div>

            <!-- Reply indicator -->
            <div
              v-if="item.post.parentId && getParentAuthor(item.post.parentId)"
              class="mt-1 text-[11px] text-[rgb(var(--muted)_/_0.7)] inline-flex items-center gap-1"
            >
              <LucideIcon name="CornerDownRight" class="w-3 h-3" stroke-width="2" aria-hidden="true" />
              回复 <span class="font-medium">{{ getParentAuthor(item.post.parentId) }}</span>
            </div>

            <!-- Post title -->
            <h4 v-if="item.post.title" class="mt-1 text-sm font-semibold text-[rgb(var(--fg))]">
              {{ item.post.title }}
            </h4>

            <!-- Post content -->
            <ClientOnly>
              <div
                v-if="processHtml(item.post.textHtml)"
                class="forum-post-content mt-2 text-sm text-[rgb(var(--fg))] prose prose-sm max-w-none dark:prose-invert"
                v-html="processHtml(item.post.textHtml)"
              ></div>
            </ClientOnly>
          </div>
        </template>
        <div v-else class="text-sm text-[rgb(var(--muted))] text-center py-8">
          暂无回复
        </div>
      </section>

      <!-- Bottom pagination -->
      <div v-if="totalPages > 1" class="flex items-center justify-center gap-2 pt-2">
        <button :disabled="currentPage <= 1" :class="btnClass" @click="currentPage--">上一页</button>
        <span class="text-sm text-[rgb(var(--muted))]">{{ currentPage }} / {{ totalPages }}</span>
        <button :disabled="currentPage >= totalPages" :class="btnClass" @click="currentPage++">下一页</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.forum-post-content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: 0.375rem;
}
/* Wikidot printuser 头像内联显示 */
.forum-post-content :deep(.printuser) {
  white-space: nowrap;
}
.forum-post-content :deep(.printuser img) {
  display: inline;
  width: 1em;
  height: 1em;
  border-radius: 50%;
  vertical-align: middle;
  margin-right: 0.15em;
  background-image: none !important;
}
.forum-post-content :deep(a) {
  color: var(--g-accent);
  text-decoration: underline;
}
.forum-post-content :deep(blockquote) {
  border-left: 3px solid rgb(var(--panel-border));
  padding-left: 0.75rem;
  margin-left: 0;
  color: rgb(var(--muted));
}
.forum-post-content :deep(pre) {
  background: rgb(var(--panel) / 0.5);
  border: 1px solid rgb(var(--panel-border) / 0.3);
  border-radius: 0.375rem;
  padding: 0.75rem;
  overflow-x: auto;
}
.forum-post-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
}
.forum-post-content :deep(td),
.forum-post-content :deep(th) {
  border: 1px solid rgb(var(--panel-border) / 0.4);
  padding: 0.375rem 0.5rem;
  text-align: left;
}
/* Hide number input spinners */
input[type="number"]::-webkit-outer-spin-button,
input[type="number"]::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
input[type="number"] {
  -moz-appearance: textfield;
}
/* Wikidot 折叠块 */
.forum-post-content :deep(.collapsible-block-unfolded) {
  display: none;
}
.forum-post-content :deep(.collapsible-block.is-open .collapsible-block-folded) {
  display: none;
}
.forum-post-content :deep(.collapsible-block.is-open .collapsible-block-unfolded) {
  display: block;
}
.forum-post-content :deep(.collapsible-block-link) {
  cursor: pointer;
  color: var(--g-accent);
  text-decoration: underline;
}
/* Post highlight animation */
@keyframes post-highlight-glow {
  0% {
    border-color: var(--g-accent);
    box-shadow: 0 0 12px rgb(var(--g-accent-raw) / 0.25);
  }
  100% {
    border-color: rgb(var(--panel-border) / 0.35);
    box-shadow: none;
  }
}
.post-highlight {
  animation: post-highlight-glow 2.5s ease-out;
}
</style>
