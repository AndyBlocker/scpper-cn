<script setup lang="ts">
import { useForumsApi } from '~/composables/api/forums'

const props = defineProps<{
  wikidotId: number
}>()

const { getPageDiscussion } = useForumsApi()

const { data, pending } = useAsyncData(
  `page-discussion-${props.wikidotId}`,
  () => getPageDiscussion(props.wikidotId),
  { watch: [() => props.wikidotId] }
)

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  return d.toLocaleDateString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Shanghai',
  })
}
</script>

<template>
  <section v-if="pending || (data?.threads && data.threads.length > 0)">
    <h3 class="text-base font-semibold text-[rgb(var(--fg))] mb-3">
      <LucideIcon name="MessageSquare" class="w-4 h-4 inline-block mr-1" stroke-width="2" aria-hidden="true" />
      讨论
    </h3>

    <div v-if="pending" class="text-sm text-[rgb(var(--muted))]">加载中…</div>

    <div v-else-if="data?.threads && data.threads.length > 0" class="space-y-2">
      <article
        v-for="thread in data.threads"
        :key="thread.id"
        class="rounded-lg border border-[rgb(var(--panel-border)_/_0.35)] bg-[rgb(var(--panel)_/_0.72)] p-3 transition hover:border-[var(--g-accent-border)] hover:bg-[rgb(var(--panel)_/_0.92)]"
      >
        <div class="flex items-start gap-3">
          <NuxtLink
            :to="`/forums/t/${thread.id}`"
            class="flex min-w-0 flex-1 items-start gap-3"
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
          </NuxtLink>
          <div class="flex shrink-0 items-center gap-2">
            <span class="inline-flex items-center gap-1 rounded-full bg-[rgb(var(--tag-bg))] px-2 py-0.5 text-xs text-[rgb(var(--tag-text))]">
              <LucideIcon name="MessageSquare" class="w-3 h-3" stroke-width="2" aria-hidden="true" />
              {{ thread.postCount }}
            </span>
            <a
              v-if="thread.sourceThreadUrl"
              :href="thread.sourceThreadUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-1 rounded-full border border-[rgb(var(--panel-border)_/_0.4)] px-2 py-0.5 text-xs text-[rgb(var(--muted-strong))] hover:text-[var(--g-accent)] hover:border-[var(--g-accent-border)]"
              @click.stop
            >
              <LucideIcon name="ExternalLink" class="w-3 h-3" stroke-width="2" aria-hidden="true" />
              原帖
            </a>
          </div>
        </div>
      </article>
    </div>
  </section>
</template>
