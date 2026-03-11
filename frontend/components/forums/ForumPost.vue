<script setup lang="ts">
const props = defineProps<{
  post: {
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
  }
  depth?: number
}>()

const depth = props.depth ?? 0

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  })
}

const sanitizedHtml = computed(() => {
  return sanitizeForumHtml(props.post.textHtml)
})

// Wikidot 折叠块点击切换
const rootEl = ref<HTMLElement | null>(null)

function handleCollapsibleClick(e: MouseEvent) {
  const target = e.target as HTMLElement
  const link = target.closest('.collapsible-block-link') as HTMLElement | null
  if (!link) return
  e.preventDefault()
  const block = link.closest('.collapsible-block')
  if (block) block.classList.toggle('is-open')
}

onMounted(() => {
  rootEl.value?.addEventListener('click', handleCollapsibleClick)
})

onUnmounted(() => {
  rootEl.value?.removeEventListener('click', handleCollapsibleClick)
})
</script>

<template>
  <div
    ref="rootEl"
    class="forum-post rounded-lg border border-[rgb(var(--panel-border)_/_0.35)] bg-[rgb(var(--panel)_/_0.72)] p-3"
    :class="{ 'opacity-50': post.isDeleted }"
    :style="depth > 0 ? { marginLeft: `${Math.min(depth, 4) * 16}px` } : undefined"
  >
    <!-- Post header -->
    <div class="flex items-center gap-2 text-xs text-[rgb(var(--muted))]">
      <span v-if="post.createdByName" class="font-medium text-[rgb(var(--muted-strong))]">
        {{ post.createdByName }}
      </span>
      <span v-else class="italic">匿名用户</span>

      <span v-if="post.createdByType && post.createdByType !== 'User'" class="text-[10px] rounded bg-[rgb(var(--tag-bg))] px-1 text-[rgb(var(--tag-text))]">
        {{ post.createdByType }}
      </span>

      <span class="text-[rgb(var(--muted))]">·</span>
      <span v-if="post.createdAt">{{ formatDate(post.createdAt) }}</span>

      <template v-if="post.editedAt">
        <span class="text-[rgb(var(--muted))]">·</span>
        <span class="italic">编辑于 {{ formatDate(post.editedAt) }}</span>
      </template>

      <span v-if="post.isDeleted" class="text-red-500 dark:text-red-400 font-medium">[已删除]</span>
    </div>

    <!-- Post title -->
    <h4 v-if="post.title" class="mt-1 text-sm font-semibold text-[rgb(var(--fg))]">
      {{ post.title }}
    </h4>

    <!-- Post content -->
    <ClientOnly>
      <div
        v-if="sanitizedHtml"
        class="forum-post-content mt-2 text-sm text-[rgb(var(--fg))] prose prose-sm max-w-none dark:prose-invert"
        v-html="sanitizedHtml"
      ></div>
    </ClientOnly>
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
</style>
