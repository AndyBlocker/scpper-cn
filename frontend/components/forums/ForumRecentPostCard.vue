<script setup lang="ts">
const props = defineProps<{
  post: {
    id: number
    title: string | null
    textHtml: string | null
    createdByName: string | null
    createdByWikidotId: number | null
    createdByType: string | null
    createdAt: string | null
    threadId: number
    threadTitle: string
    categoryId: number
    categoryTitle: string | null
    sourceThreadUrl?: string | null
    sourcePostUrl?: string | null
  }
}>()

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  })
}

function stripHtml(html: string | null): string {
  if (!html) return ''
  // 移除折叠块控制链接文字（如 "+显示" / "-隐藏"），只保留内容
  let cleaned = html
    .replace(/<div class="collapsible-block-folded">[\s\S]*?<\/div>/g, '')
    .replace(/<div class="collapsible-block-unfolded-link">[\s\S]*?<\/div>/g, '')
  // 移除所有 HTML 标签
  return cleaned.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

const preview = computed(() => {
  const text = stripHtml(props.post.textHtml)
  return text.length > 200 ? text.slice(0, 200) + '…' : text
})

const threadLink = computed(() => `/forums/t/${props.post.threadId}?postId=${props.post.id}`)
</script>

<template>
  <article class="rounded-lg border border-[rgb(var(--panel-border)_/_0.35)] bg-[rgb(var(--panel)_/_0.72)] p-3 transition hover:border-[var(--g-accent-border)] hover:bg-[rgb(var(--panel)_/_0.92)]">
    <NuxtLink
      :to="threadLink"
      class="block"
    >
      <div class="flex items-start gap-3">
        <!-- Avatar -->
        <UserAvatar
          v-if="post.createdByWikidotId"
          :wikidot-id="post.createdByWikidotId"
          :name="post.createdByName"
          :size="32"
          class="shrink-0 mt-0.5"
        />

        <div class="min-w-0 flex-1">
          <!-- Post title (if any) -->
          <h4 v-if="post.title" class="text-sm font-medium text-[rgb(var(--fg))] line-clamp-1">
            {{ post.title }}
          </h4>

          <!-- Content preview -->
          <p v-if="preview" class="text-sm text-[rgb(var(--fg)_/_0.85)] leading-relaxed line-clamp-2" :class="{ 'mt-0.5': post.title }">
            {{ preview }}
          </p>

          <!-- Thread title (secondary context) -->
          <div class="mt-1.5 inline-flex items-center gap-1 text-xs text-[var(--g-accent)] line-clamp-1">
            <LucideIcon name="MessageSquare" class="w-3 h-3 shrink-0 opacity-60" stroke-width="2" aria-hidden="true" />
            {{ post.threadTitle }}
          </div>

          <!-- Meta row: author + date + category -->
          <div class="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-[rgb(var(--muted))]">
            <span v-if="post.createdByName" class="font-medium text-[rgb(var(--muted-strong))]">
              {{ post.createdByName }}
            </span>
            <span v-else class="italic">匿名用户</span>

            <span v-if="post.createdAt" class="text-[rgb(var(--muted)_/_0.7)]">{{ formatDate(post.createdAt) }}</span>

            <span
              v-if="post.categoryTitle"
              class="rounded-full bg-[rgb(var(--tag-bg))] px-1.5 py-0.5 text-[10px] text-[rgb(var(--tag-text))]"
            >
              {{ post.categoryTitle }}
            </span>
          </div>
        </div>
      </div>
    </NuxtLink>

    <div v-if="post.sourcePostUrl" class="mt-2 flex justify-end">
      <a
        :href="post.sourcePostUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="inline-flex items-center gap-1 text-xs text-[var(--g-accent)] hover:underline"
      >
        <LucideIcon name="ExternalLink" class="w-3 h-3" stroke-width="2" aria-hidden="true" />
        原帖
      </a>
    </div>
  </article>
</template>
