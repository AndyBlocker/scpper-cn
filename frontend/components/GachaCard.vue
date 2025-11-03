<template>
  <div
    class="relative flex h-full w-full max-w-full flex-col gap-3 rounded-2xl border bg-white/90 p-4 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:shadow-md dark:bg-neutral-900/60 sm:p-5"
    :class="rarityClass.card"
  >
    <component
      :is="linkComponent"
      v-bind="linkAttrs"
      class="flex flex-1 items-start gap-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgb(var(--accent-strong))] focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-neutral-900"
    >
      <div
        class="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-neutral-100 text-neutral-400 shadow-inner dark:bg-neutral-800 sm:h-16 sm:w-16"
        :class="rarityClass.preview"
      >
        <img v-if="props.imageUrl" :src="props.imageUrl" alt="" class="h-full w-full object-cover" />
        <span v-else class="text-[12px] font-semibold tracking-wide">SCiP</span>
      </div>

      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <h3 class="truncate text-sm font-semibold leading-snug sm:text-base" :class="rarityClass.title">
          {{ props.title }}
        </h3>

        <div v-if="authorsVisible.length || visibleTags.length" class="flex min-w-0 flex-col gap-1">
          <div
            v-if="authorsVisible.length"
            class="flex flex-wrap items-center gap-1.5 text-neutral-500 dark:text-neutral-400"
          >
            <UserCard
              v-for="author in authorsVisible"
              :key="author.key"
              size="S"
              :display-name="author.name"
              :wikidot-id="author.wikidotId ?? undefined"
              bare
            />
            <span v-if="authorsMoreCount > 0" class="text-[10px] text-neutral-400 dark:text-neutral-500">+{{ authorsMoreCount }}</span>
          </div>
          <div v-if="visibleTags.length" class="tags-track text-neutral-500 dark:text-neutral-400">
            <span v-for="tag in visibleTags" :key="tag" class="tag-pill">
              <span class="truncate">#{{ tag }}</span>
            </span>
            <span v-if="tagsMoreCount > 0" class="more-indicator">+{{ tagsMoreCount }}</span>
          </div>
        </div>
      </div>
    </component>

    <div class="mt-auto flex items-center justify-between gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
      <div class="flex min-w-0 items-center gap-2">
        <span
          v-if="props.count != null"
          class="shrink-0 rounded-lg bg-neutral-100 px-2 py-0.5 text-xs font-semibold text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300"
        >
          拥有 {{ props.count }}
        </span>
        <slot name="meta" />
      </div>
      <div class="flex shrink-0 items-center gap-2">
        <slot name="actions" />
      </div>
    </div>

    <div
      v-if="showCountBadge"
      class="pointer-events-none absolute right-3 top-3 rounded-full bg-[rgb(var(--accent-strong))] px-2 py-0.5 text-[11px] font-semibold text-white shadow"
    >
      ×{{ props.count }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NuxtLink, UserCard } from '#components'
import { orderTags } from '~/composables/useTagOrder'
import type { Rarity } from '~/composables/useGacha'
import type { PageAuthor } from '~/composables/usePageAuthors'

const rarityClassMap: Record<Rarity, { card: string; title: string; preview: string }> = {
  WHITE: {
    card: 'border-neutral-200/80 dark:border-neutral-800/70',
    title: 'text-neutral-700 dark:text-neutral-100',
    preview: 'bg-white text-neutral-400 dark:bg-neutral-800'
  },
  GREEN: {
    card: 'border-emerald-200/70 shadow-[0_0_0_1px_rgba(16,185,129,0.08)] dark:border-emerald-500/40',
    title: 'text-emerald-700 dark:text-emerald-300',
    preview: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-200'
  },
  BLUE: {
    card: 'border-blue-200/70 shadow-[0_0_0_1px_rgba(59,130,246,0.08)] dark:border-blue-500/40',
    title: 'text-blue-700 dark:text-blue-300',
    preview: 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-200'
  },
  PURPLE: {
    card: 'border-purple-200/70 shadow-[0_0_0_1px_rgba(168,85,247,0.08)] dark:border-purple-500/40',
    title: 'text-purple-700 dark:text-purple-300',
    preview: 'bg-purple-50 text-purple-600 dark:bg-purple-500/10 dark:text-purple-200'
  },
  GOLD: {
    card: 'border-amber-200/80 shadow-[0_0_0_1px_rgba(245,158,11,0.12)] dark:border-amber-400/40',
    title: 'text-amber-700 dark:text-amber-300',
    preview: 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-200'
  }
}

type AuthorLike = string | PageAuthor

const props = defineProps<{
  title: string
  rarity: Rarity
  tags: string[]
  authors?: Array<AuthorLike> | null
  count?: number
  imageUrl?: string | null
  pageUrl?: string | null
}>()

const linkComponent = computed(() => (props.pageUrl ? NuxtLink : 'div'))
const linkAttrs = computed(() => (props.pageUrl ? { to: props.pageUrl } : {}))

const rarityClass = computed(() => rarityClassMap[props.rarity] || rarityClassMap.WHITE)

function clampByBudget(items: string[], budget: number, padding = 2, minItems = 0, maxItems = Infinity) {
  if (!Array.isArray(items) || items.length === 0) return 0
  let used = 0
  let count = 0
  const upper = Math.min(maxItems, items.length)
  for (let i = 0; i < upper; i += 1) {
    const item = items[i] || ''
    const next = item.length + padding
    if (used + next > budget) break
    used += next
    count += 1
  }
  return Math.max(minItems, count)
}

const sanitizedTags = computed(() => {
  const raw = Array.isArray(props.tags) ? props.tags : []
  return orderTags(raw.filter((tag) => tag && !tag.startsWith('_')))
})
const visibleTagsCount = computed(() => {
  if (!sanitizedTags.value.length) return 0
  return clampByBudget(sanitizedTags.value, 28, 1, 1, 4)
})
const visibleTags = computed(() => sanitizedTags.value.slice(0, visibleTagsCount.value))
const tagsMoreCount = computed(() => Math.max(0, sanitizedTags.value.length - visibleTagsCount.value))

const normalizedAuthors = computed<PageAuthor[]>(() => {
  if (!Array.isArray(props.authors)) return []
  return props.authors
    .map((entry) => {
      if (entry && typeof entry === 'object' && 'name' in entry) {
        const name = String((entry as PageAuthor).name || '').trim()
        if (!name) return null
        return {
          name,
          wikidotId: Number.isFinite((entry as PageAuthor).wikidotId)
            ? Number((entry as PageAuthor).wikidotId)
            : null
        }
      }
      const name = String(entry || '').trim()
      if (!name) return null
      return { name, wikidotId: null }
    })
    .filter((author): author is PageAuthor => !!author)
})
const authorsVisibleCount = computed(() => {
  const names = normalizedAuthors.value.map((author) => author.name)
  if (!names.length) return 0
  return clampByBudget(names, 18, 2, 1, 3)
})
const authorsVisible = computed(() =>
  normalizedAuthors.value.slice(0, authorsVisibleCount.value).map((author, index) => ({
    ...author,
    key: `${author.wikidotId ?? author.name}-${index}`
  }))
)
const authorsMoreCount = computed(() => Math.max(0, normalizedAuthors.value.length - authorsVisibleCount.value))

const showCountBadge = computed(() => (props.count ?? 0) > 1)
</script>

<style scoped>
.tags-track {
  display: inline-flex;
  min-width: 0;
  flex: 1 1 auto;
  align-items: center;
  gap: 0.25rem;
  overflow: hidden;
  flex-wrap: nowrap;
}
.tag-pill {
  display: inline-flex;
  align-items: center;
  border-radius: 9999px;
  border: 1px solid rgba(148, 163, 184, 0.5);
  background-color: rgba(148, 163, 184, 0.18);
  color: rgb(100, 116, 139);
  padding: 0.125rem 0.5rem;
  font-size: 0.6875rem;
  line-height: 1;
  max-width: 100%;
}
.dark .tag-pill {
  border-color: rgba(148, 163, 184, 0.4);
  background-color: rgba(148, 163, 184, 0.16);
  color: rgb(203, 213, 225);
}
.tag-pill > span {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.more-indicator {
  flex-shrink: 0;
  font-size: 0.6875rem;
  color: rgba(100, 116, 139, 0.8);
}
.dark .more-indicator {
  color: rgba(148, 163, 184, 0.8);
}
</style>
