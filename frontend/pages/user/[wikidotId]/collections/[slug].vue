<template>
  <div class="mx-auto max-w-5xl space-y-8 py-10">
    <div class="flex items-center gap-3 text-sm text-neutral-500 dark:text-neutral-400">
      <NuxtLink :to="`/user/${wikidotId}`" class="inline-flex items-center gap-1 hover:text-[rgb(var(--accent))]">
        <LucideIcon name="ArrowLeft" class="h-4 w-4" />
        返回作者页
      </NuxtLink>
      <span>/</span>
      <span>收藏夹</span>
    </div>

    <div v-if="pending" class="rounded-3xl border border-neutral-200 bg-white/80 p-10 text-center text-sm text-neutral-500 shadow-lg dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
      正在载入收藏夹...
    </div>

    <div v-else-if="error" class="rounded-3xl border border-red-200 bg-red-50 p-10 text-center text-sm font-medium text-red-600 dark:border-red-800 dark:bg-red-900/30 dark:text-red-300">
      {{ errorMessage }}
    </div>

    <div v-else-if="detail" class="space-y-6">
      <section class="relative overflow-hidden rounded-3xl border border-white/50 bg-white/90 shadow-[0_26px_70px_rgba(15,23,42,0.14)] dark:border-white/10 dark:bg-neutral-950/75 dark:shadow-[0_32px_80px_rgba(0,0,0,0.6)]">
        <div class="absolute inset-0">
          <div
            v-if="detail.collection.coverImageUrl"
            class="absolute inset-0 bg-cover bg-center opacity-95 transition-transform duration-[1800ms] ease-out"
            :style="coverStyle(detail.collection.coverImageUrl, detail.collection.coverImageOffsetX, detail.collection.coverImageOffsetY, detail.collection.coverImageScale)"
          />
          <div v-else class="absolute inset-0 bg-gradient-to-br from-neutral-200 via-neutral-300 to-neutral-100 dark:from-neutral-800 dark:via-neutral-900 dark:to-neutral-800" />
          <div class="absolute inset-0 bg-gradient-to-b from-black/70 via-black/45 to-black/70 dark:from-black/80 dark:via-black/55 dark:to-black/80" />
          <div class="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.28),transparent_55%)] mix-blend-screen opacity-70 dark:bg-[radial-gradient(circle_at_top_left,rgba(59,130,246,0.4),transparent_60%)]" />
        </div>
        <div class="relative z-10 px-7 py-9 sm:px-12 sm:py-12">
          <div class="flex flex-wrap items-start justify-between gap-6 text-white">
            <div class="space-y-4">
              <div class="flex items-center gap-3 text-xs uppercase tracking-[0.18em] text-white/70">
                <LucideIcon name="BookmarkPlus" class="h-4 w-4" />
                <span>收藏夹</span>
                <span>·</span>
                <span>{{ ownerName }}</span>
              </div>
              <h1 class="max-w-3xl text-3xl font-semibold leading-snug sm:text-[2.5rem]">
                {{ detail.collection.title }}
              </h1>
              <p
                v-if="detail.collection.description"
                class="max-w-3xl text-sm leading-relaxed text-white/80"
              >
                {{ detail.collection.description }}
              </p>
            </div>
            <div class="flex flex-col items-start gap-2 text-xs text-white/80">
              <span class="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1 font-medium backdrop-blur">
                <LucideIcon :name="detail.collection.visibility === 'PUBLIC' ? 'Globe2' : 'Lock'" class="h-3.5 w-3.5" />
                {{ detail.collection.visibility === 'PUBLIC' ? '公开收藏夹' : '私人收藏夹' }}
              </span>
              <NuxtLink
                :to="`/user/${wikidotId}`"
                class="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 font-medium text-white/85 transition hover:border-white/40 hover:bg-white/10"
              >
                <LucideIcon name="UserCircle" class="h-4 w-4" />
                {{ ownerName }}
              </NuxtLink>
            </div>
          </div>
          <div class="mt-6 flex flex-wrap items-center gap-3 text-xs text-white/75">
            <span class="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1">
              <LucideIcon name="BookOpen" class="h-3.5 w-3.5" />
              共 {{ detail.collection.itemCount }} 条目
            </span>
            <span class="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1">
              <LucideIcon name="Clock" class="h-3.5 w-3.5" />
              更新于 {{ formatDate(detail.collection.updatedAt) }}
            </span>
            <span class="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-3 py-1">
              <LucideIcon name="CalendarDays" class="h-3.5 w-3.5" />
              创建于 {{ formatDate(detail.collection.createdAt) }}
            </span>
          </div>
        </div>
      </section>

      <section class="space-y-5">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-lg font-semibold text-neutral-800 dark:text-neutral-100">收藏条目</h2>
          <span class="text-xs text-neutral-500 dark:text-neutral-400">共 {{ detail.items.length }} 条</span>
        </div>
        <div v-if="detail.items.length === 0" class="rounded-3xl border border-dashed border-neutral-300/80 bg-neutral-50/80 px-10 py-12 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300">
          <LucideIcon name="Inbox" class="mx-auto mb-3 h-8 w-8 text-neutral-300 dark:text-neutral-600" />
          暂无公开条目。
        </div>
        <ul v-else class="space-y-4">
          <li
            v-for="(item, index) in detail.items"
            :key="item.id"
            :class="[
              'group relative overflow-hidden rounded-2xl border p-5 shadow-sm transition duration-300 hover:-translate-y-1 hover:shadow-[0_22px_50px_rgba(15,23,42,0.14)]',
              item.pinned
                ? 'border-[rgba(var(--accent),0.45)] bg-[rgba(var(--accent),0.05)] dark:border-[rgba(var(--accent),0.45)] dark:bg-[rgba(var(--accent),0.16)]'
                : 'border-neutral-200/80 bg-white/95 dark:border-neutral-800/70 dark:bg-neutral-900/80'
            ]"
          >
            <div class="absolute inset-0 pointer-events-none opacity-0 transition-opacity duration-300 group-hover:opacity-100">
              <div class="absolute inset-0 bg-gradient-to-br from-[rgba(var(--accent),0.12)] via-transparent to-transparent" />
            </div>
            <span
              v-if="item.pinned"
              class="absolute right-5 top-5 inline-flex items-center gap-1 rounded-full bg-[rgba(var(--accent),0.9)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-white shadow-lg"
            >
              <LucideIcon name="Star" class="h-3 w-3" />
              置顶
            </span>
            <div class="relative z-10 flex flex-col gap-4">
              <div class="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div class="flex items-start gap-4">
                  <div class="hidden h-10 w-10 shrink-0 items-center justify-center rounded-full border border-[rgba(var(--accent),0.35)] bg-[rgba(var(--accent),0.12)] text-sm font-semibold text-[rgb(var(--accent))] md:flex">
                    {{ index + 1 }}
                  </div>
                  <div class="min-w-0 space-y-2">
                    <NuxtLink
                      v-if="item.page.wikidotId"
                      :to="`/page/${item.page.wikidotId}`"
                      class="text-lg font-semibold text-neutral-900 transition hover:text-[rgb(var(--accent))] dark:text-neutral-100"
                    >
                      {{ item.page.title ?? `页面 #${item.page.wikidotId}` }}
                    </NuxtLink>
                    <span v-else class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                      {{ item.page.title || '未知页面' }}
                    </span>
                    <p v-if="item.page.alternateTitle" class="text-xs text-neutral-500 dark:text-neutral-400">
                      {{ item.page.alternateTitle }}
                    </p>
                    <div class="flex flex-wrap items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
                      <span class="inline-flex items-center gap-1">
                        <LucideIcon name="CalendarDays" class="h-3.5 w-3.5" />
                        添加于 {{ formatDate(item.createdAt) }}
                      </span>
                      <span v-if="item.page.rating != null" class="inline-flex items-center gap-1">
                        <LucideIcon name="Gauge" class="h-3.5 w-3.5" />
                        评分 {{ item.page.rating }}
                      </span>
                      <span
                        v-if="item.pinned"
                        class="inline-flex items-center gap-1 rounded-full bg-[rgba(var(--accent),0.12)] px-2 py-0.5 font-medium text-[rgb(var(--accent))]"
                      >
                        <LucideIcon name="BookmarkCheck" class="h-3.5 w-3.5" />
                        已置顶
                      </span>
                    </div>
                  </div>
                </div>
                <NuxtLink
                  v-if="item.page.wikidotId"
                  :to="`/page/${item.page.wikidotId}`"
                  class="inline-flex items-center gap-2 rounded-full border border-[rgba(var(--accent),0.35)] bg-white/90 px-4 py-1.5 text-xs font-semibold text-[rgb(var(--accent))] shadow-sm transition hover:translate-x-0.5 hover:bg-white dark:border-[rgba(var(--accent),0.35)] dark:bg-neutral-900/80"
                >
                  <LucideIcon name="ArrowUpRight" class="h-3.5 w-3.5" />
                  前往页面
                </NuxtLink>
              </div>
              <blockquote
                v-if="item.annotation"
                class="relative rounded-2xl border border-neutral-200/80 bg-neutral-50/90 px-5 py-4 text-sm leading-relaxed text-neutral-700 dark:border-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-200"
              >
                <LucideIcon name="Quote" class="absolute left-4 top-4 h-4 w-4 text-neutral-300 dark:text-neutral-500" />
                <p class="pl-6 whitespace-pre-wrap">
                  {{ item.annotation }}
                </p>
              </blockquote>
            </div>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { useNuxtApp } from 'nuxt/app'
import { createError, useAsyncData, useHead } from '#imports'
import { useCollections } from '~/composables/useCollections'

const route = useRoute()
const { fetchPublicCollectionDetail } = useCollections()
const wikidotId = computed(() => route.params.wikidotId as string)
const slug = computed(() => route.params.slug as string)

const { data: detail, pending, error } = await useAsyncData(
  () => `user-collection-${wikidotId.value}-${slug.value}`,
  async () => {
    const id = Number(wikidotId.value)
    if (!Number.isFinite(id) || !slug.value) {
      throw createError({ statusCode: 404, statusMessage: 'Not Found' })
    }
    const result = await fetchPublicCollectionDetail(id, slug.value, true)
    if (!result) {
      throw createError({ statusCode: 404, statusMessage: '收藏夹不存在或未公开' })
    }
    return result
  }
)

const { data: ownerData } = await useAsyncData(
  () => `user-meta-${wikidotId.value}`,
  async () => {
    const id = Number(wikidotId.value)
    if (!Number.isFinite(id)) return null
    const { $bff } = useNuxtApp()
    try {
      const res = await $bff(`/users/by-wikidot-id`, { params: { wikidotId: id } })
      return res?.displayName ?? null
    } catch {
      return null
    }
  }
)

const ownerName = computed(() => ownerData.value || `作者 #${wikidotId.value}`)
const errorMessage = computed(() => {
  if (!error.value) return ''
  if (error.value.statusCode === 404) return '该收藏夹不存在或未公开。'
  return error.value.message || '加载失败'
})

useHead(() => ({
  title: detail.value
    ? `${detail.value.collection.title} - 收藏夹`
    : '收藏夹',
  meta: detail.value
    ? [
        { name: 'description', content: detail.value.collection.description || `来自 ${ownerName.value} 的收藏夹` },
        { property: 'og:title', content: detail.value.collection.title },
        { property: 'og:description', content: detail.value.collection.description || `来自 ${ownerName.value} 的收藏夹` },
        ...(detail.value.collection.coverImageUrl
          ? [{ property: 'og:image', content: detail.value.collection.coverImageUrl }]
          : [])
      ]
    : []
}))

function formatDate(value: string | null) {
  if (!value) return '—'
  try {
    return new Date(value).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return value.slice(0, 10)
  }
}

function coverPosition(offsetX: number | null | undefined, offsetY: number | null | undefined): string {
  const clamp = (value: number | null | undefined) => {
    if (!Number.isFinite(Number(value))) return 0
    const numeric = Number(value)
    if (Number.isNaN(numeric)) return 0
    return Math.min(60, Math.max(-60, numeric))
  }
  const x = clamp(offsetX)
  const y = clamp(offsetY)
  return `${50 - x}% ${50 - y}%`
}

function coverStyle(url: string | null | undefined, offsetX: number | null | undefined, offsetY: number | null | undefined, scale: number | null | undefined) {
  if (!url) return {}
  const clampScale = (value: number | null | undefined) => {
    if (!Number.isFinite(Number(value))) return 1
    const numeric = Number(value)
    if (Number.isNaN(numeric)) return 1
    return Math.min(2.5, Math.max(0.75, numeric))
  }
  return {
    backgroundImage: `url(${url})`,
    backgroundPosition: coverPosition(offsetX, offsetY),
    backgroundSize: `${clampScale(scale) * 100}% auto`
  }
}
</script>
