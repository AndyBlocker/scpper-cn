<!-- pages/page/[wikidotId].vue -->
<template>
  <div>
    <!-- Loading -->
    <div v-if="pagePending" class="p-10 text-center">
      <div class="inline-flex items-center gap-2">
        <LucideIcon name="Loader2" class="w-5 h-5 animate-spin text-[var(--g-accent)]" stroke-width="2" aria-hidden="true" />
        <span class="text-neutral-600 dark:text-neutral-400">加载中…</span>
      </div>
    </div>

    <!-- Error -->
    <div v-else-if="pageError" class="p-10 text-center text-red-600 dark:text-red-400">
      加载失败：{{ pageError.message }}
    </div>

    <!-- Content -->
    <div v-else class="space-y-6">
      <!-- Title + Actions -->
      <header class="relative flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <h1 class="text-[22px] leading-snug font-bold text-neutral-900 dark:text-neutral-100">
          {{ pageDisplayTitle }}
        </h1>
        <div class="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:justify-end sm:shrink-0">
          <button
            v-if="page?.wikidotId"
            @click="copyId"
            :title="copiedId ? '已复制' : '复制'"
            class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 border border-neutral-200 dark:border-neutral-700"
          >
            <LucideIcon name="Copy" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            ID {{ page?.wikidotId }}
          </button>

          <span v-if="page?.isDeleted" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100/90 dark:bg-red-900/40 text-red-700 dark:text-red-300 border border-red-200/80 dark:border-red-800">
            <LucideIcon name="Trash2" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            <span>已删除</span>
            <span v-if="deletedDate" class="text-[11px] opacity-80">· {{ deletedDate }}</span>
          </span>

          <a v-if="page?.url"
             :href="sourceUrlHttps" target="_blank" rel="noopener"
             class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 border border-neutral-200 dark:border-neutral-700">
            <LucideIcon name="ExternalLink" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            源页面
            <span class="ml-1 pl-1 inline-flex items-center border-l border-neutral-200 dark:border-neutral-700">
              <span
                @click.stop.prevent="copySourceUrl"
                :title="copiedSource ? '已复制' : '复制 URL'"
                :class="['inline-flex items-center gap-0.5 px-1 py-0.5 rounded transition-colors', copiedSource ? 'bg-[var(--g-accent-soft)] text-[var(--g-accent)]' : 'bg-neutral-200/60 dark:bg-neutral-700/60 text-neutral-600 dark:text-neutral-300']"
              >
                <LucideIcon name="Copy" class="w-3 h-3" stroke-width="2" aria-hidden="true" />
              </span>
            </span>
          </a>
          <NuxtLink
            v-if="page?.wikidotId && previewAvailable"
            :to="`/page/${page.wikidotId}/preview`"
            class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 border border-neutral-200 dark:border-neutral-700"
            title="预览 Wikidot 页面"
          >
            <LucideIcon name="Eye" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            预览
          </NuxtLink>
          <CollectionPicker
            v-if="page?.pageId"
            :page-id="page.pageId"
            :page-wikidot-id="page?.wikidotId ?? null"
            :page-title="pageDisplayTitle"
          />
        </div>
      </header>

      <!-- Meta line -->
      <section class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-5 text-neutral-600 dark:text-neutral-400">
        <div v-if="groupedAttributions && groupedAttributions.length > 0" class="inline-flex items-center gap-2">
          <LucideIcon name="Users" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
          <div class="flex flex-wrap gap-2 items-center">
            <template v-for="attr in groupedAttributions" :key="attr.type">
              <template v-for="(person, idx) in attr.users" :key="`p-${attr.type}-${idx}`">
                <UserCard
                  size="sm"
                  :wikidot-id="(person?.userWikidotId ?? 0)"
                  :display-name="normalizeAuthorName(person?.displayName) || '(account deleted)'"
                  :to="person?.userWikidotId ? `/user/${person.userWikidotId}` : null"
                  :avatar="true"
                />
              </template>
            </template>
          </div>
        </div>

        <div class="inline-flex items-center gap-1">
          <LucideIcon name="Clock" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
          <span>{{ createdDate ? formatDate(createdDate) : 'N/A' }}</span>
        </div>

        <div class="inline-flex items-center gap-1">
          <LucideIcon name="History" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
          <span>
            修订 {{ page?.revisionCount || 0 }}
            <template v-if="totalViewsCount > 0">
              · 浏览 {{ totalViewsDisplay }}
              <span v-if="todayViewsCount > 0" class="text-green-600 dark:text-green-400">
                (+{{ todayViewsDisplay }})
              </span>
            </template>
          </span>
        </div>

        <div class="inline-flex items-center gap-2 flex-wrap">
          <template v-for="t in allTags" :key="t">
            <NuxtLink :to="{ path: '/search', query: { tags: [t] } }"
                      class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-800/40 transition-colors"
                      :title="`查看包含「${t}」标签的所有页面`">#{{ t }}</NuxtLink>
          </template>
        </div>
      </section>

      <!-- Metrics -->
      <PageMetrics
        :total-score-display="totalScoreDisplay"
        :upvotes="upvotes"
        :downvotes="downvotes"
        :total-votes="totalVotes"
        :upvote-pct="upvotePct"
        :downvote-pct="downvotePct"
        :like-ratio-pct="likeRatioPct"
        :wilson-l-b="wilsonLB"
        :controversy-idx="controversyIdx"
        :rating-tooltip="ratingTooltip"
        :vote-tooltip="voteTooltip"
        :wilson-tooltip="wilsonTooltip"
        :metrics-updated-at="metricsUpdatedAt"
        :copied-anchor-id="copiedAnchorId"
        @copy-anchor="copyAnchorLink"
      />

      <!-- Chart -->
      <section
        v-if="ratingHistoryPending || ratingHistoryError || (Array.isArray(ratingHistory) && ratingHistory.length)"
        id="rating-history"
        class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm"
      >
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">评分趋势</h3>
            <button
              type="button"
              class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-[var(--g-accent)] hover:border-[var(--g-accent-border)] dark:text-neutral-400 dark:hover:text-[var(--g-accent)]"
              @click="copyAnchorLink('rating-history')"
              :title="copiedAnchorId === 'rating-history' ? '已复制链接' : '复制该段落链接'"
            >
              <LucideIcon v-if="copiedAnchorId === 'rating-history'" name="Check" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
              <LucideIcon v-else name="Link" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            </button>
          </div>
          <span class="text-xs text-neutral-500 dark:text-neutral-500">按周聚合</span>
        </div>
        <div v-if="ratingHistoryPending" class="h-64 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
          加载图表中...
        </div>
        <div v-else-if="ratingHistoryError" class="rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50/80 dark:bg-neutral-900/60 p-6 text-sm text-neutral-600 dark:text-neutral-400">
          加载评分趋势失败。
          <button type="button" class="ml-2 inline-flex items-center gap-1 text-[var(--g-accent)] hover:underline" @click="refreshRatingHistory()">重试</button>
        </div>
        <ClientOnly v-else>
          <RatingHistoryChart
            :data="ratingHistory"
            :first-activity-date="firstRev && firstRev[0] ? firstRev[0].timestamp : ''"
            :allow-page-markers="false"
            :debug="Boolean(route?.query?.debugChart)"
          />
          <template #fallback>
            <div class="h-64 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
              加载图表中...
            </div>
          </template>
        </ClientOnly>
      </section>

      <!-- Revisions -->
      <PageRevisions
        :revisions="revisionsPaged"
        :pending="revisionsPending"
        :error="revisionsError"
        :rev-page="revPage"
        :rev-total-pages="revTotalPages"
        :rev-page-numbers="revPageNumbers"
        :has-more="hasMoreRevisions"
        :jump-page="revJumpPage"
        :copied-anchor-id="copiedAnchorId"
        @copy-anchor="copyAnchorLink"
        @refresh="refreshRevisions()"
        @prev-page="prevRevPage"
        @next-page="nextRevPage"
        @go-page="goRevPage"
        @jump="jumpToRevPage"
        @update:jump-page="revJumpPage = $event"
      />

      <!-- Recent Votes -->
      <PageVotes
        :votes="recentVotes"
        :pending="recentVotesPending"
        :error="recentVotesError"
        :offset="voteOffset"
        :current-page="currentVotePage"
        :total-pages="voteTotalPages"
        :page-numbers="votePageNumbers"
        :has-more="hasMoreVotes"
        :jump-page="voteJumpPage"
        :viewer-linked-id="viewerLinkedId"
        :copied-anchor-id="copiedAnchorId"
        @copy-anchor="copyAnchorLink"
        @refresh="refreshRecentVotes()"
        @prev-page="prevVotePage"
        @next-page="nextVotePage"
        @go-page="goVotePage"
        @jump="jumpToVotePage"
        @update:jump-page="voteJumpPage = $event"
      />

      <!-- Related Pages -->
      <section id="related" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">相关页面</h3>
            <button
              type="button"
              class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-[var(--g-accent)] hover:border-[var(--g-accent-border)] dark:text-neutral-400 dark:hover:text-[var(--g-accent)]"
              @click="copyAnchorLink('related')"
              :title="copiedAnchorId === 'related' ? '已复制链接' : '复制该段落链接'"
            >
              <LucideIcon v-if="copiedAnchorId === 'related'" name="Check" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
              <LucideIcon v-else name="Link" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            class="hidden sm:inline-flex items-center gap-1 rounded-full border border-neutral-200 dark:border-neutral-700 px-3 py-1 text-xs text-neutral-500 hover:text-[var(--g-accent)] hover:border-[var(--g-accent-border)] dark:text-neutral-400 dark:hover:text-[var(--g-accent)]"
            @click="refreshRelatedPages()"
            title="刷新推荐"
          >
            <LucideIcon name="RefreshCcw" class="h-3.5 w-3.5" stroke-width="1.8" />
            刷新
          </button>
        </div>
        <div v-if="relatedPending" class="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div v-for="i in 3" :key="`skeleton-${i}`" class="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 bg-neutral-50 dark:bg-neutral-900/60 animate-pulse">
            <div class="h-4 w-3/4 bg-neutral-200 dark:bg-neutral-800 rounded mb-3"></div>
            <div class="flex gap-2 mb-3">
              <div class="h-3 w-16 bg-neutral-200 dark:bg-neutral-800 rounded"></div>
              <div class="h-3 w-12 bg-neutral-200 dark:bg-neutral-800 rounded"></div>
              <div class="h-3 w-10 bg-neutral-200 dark:bg-neutral-800 rounded"></div>
            </div>
            <div class="h-20 w-full bg-neutral-200/70 dark:bg-neutral-800/70 rounded"></div>
          </div>
        </div>
        <div v-else-if="relatedError" class="rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50/80 dark:bg-neutral-900/60 p-6 text-sm text-neutral-600 dark:text-neutral-400">
          加载推荐失败。
          <button type="button" class="ml-2 inline-flex items-center gap-1 text-[var(--g-accent)] hover:underline" @click="refreshRelatedPages()">重试</button>
        </div>
        <div v-else-if="relatedPages && relatedPages.length > 0" class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <PageCard
            v-for="rp in relatedPages.slice(0, 3)"
            :key="rp.wikidotId"
            size="md"
            :to="`/page/${rp.wikidotId}`"
            :wikidot-id="rp.wikidotId"
            :title="rp.title"
            :snippet-html="(rp as any).snippet || null"
            :tags="orderTags(Array.isArray(rp.tags) ? rp.tags : [])"
            :rating="Number(rp.rating ?? 0)"
            :comments="Number(rp.commentCount ?? rp.revisionCount ?? 0)"
            :wilson95="typeof rp.wilson95 === 'number' ? rp.wilson95 : undefined"
            :controversy="typeof rp.controversy === 'number' ? rp.controversy : 0"
            :date-iso="rp.createdAt || ''"
            :authors="Array.isArray((rp as any).authors_full) ? (rp as any).authors_full.map((a:any) => ({ name: a?.displayName || '', url: a?.wikidotId ? `/user/${a.wikidotId}` : undefined })) : []"
          />
        </div>
        <div v-else class="text-center py-4 text-neutral-500 dark:text-neutral-400">
          暂无推荐
        </div>
      </section>

      <!-- Page Images -->
      <PageImages
        :images="pageImages"
        :pending="pageImagesPending"
        :error="pageImagesError"
        :page-display-title="pageDisplayTitle"
        :copied-anchor-id="copiedAnchorId"
        @copy-anchor="copyAnchorLink"
        @refresh="refreshPageImages()"
      />

      <!-- Source Viewer -->
      <PageSource
        :wikidot-id="wikidotId"
        :page-display-title="pageDisplayTitle"
        :copied-anchor-id="copiedAnchorId"
        :page-versions="pageVersions"
        :displayed-source="displayedSource"
        :source-character-count="sourceCharacterCount"
        :text-content-character-count="textContentCharacterCount"
        @copy-anchor="copyAnchorLink"
        @version-change="onVersionChange"
      />

      <!-- Forum Discussion Section -->
      <ForumsDiscussionSection
        v-if="page?.wikidotId"
        :wikidot-id="Number(page.wikidotId)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, watchEffect, onMounted, onBeforeUnmount } from 'vue'
import { definePageMeta, useAsyncData, useHead, useNuxtApp, useRoute, useRuntimeConfig } from '#imports'
import { orderTags } from '~/composables/useTagOrder'
import { onBeforeRouteUpdate } from 'vue-router'
import { useAuth } from '~/composables/useAuth'
import { useViewerVotes } from '~/composables/useViewerVotes'
import { formatDateUtc8, formatDateIsoUtc8, diffUtc8CalendarDays } from '~/utils/timezone'
import CollectionPicker from '~/components/collections/CollectionPicker.vue'
import PageMetrics from '~/components/page/PageMetrics.vue'
import PageRevisions from '~/components/page/PageRevisions.vue'
import PageVotes from '~/components/page/PageVotes.vue'
import PageImages from '~/components/page/PageImages.vue'
import PageSource from '~/components/page/PageSource.vue'
import { normalizeBffBase, pickExternalAssetUrl, resolveWithFallback } from '~/utils/assetUrl'
import { copyTextWithFallback } from '~/utils/clipboard'

const route = useRoute();
const {$bff} = useNuxtApp();
const runtimeConfig = useRuntimeConfig();
const { user: authUser, isAuthenticated } = useAuth()
const { hydratePages: hydrateViewerVotes } = useViewerVotes()
const PAGE_ANCHOR_KEY = '__page__'
const copiedAnchorId = ref<string | null>(null)
let anchorCopyTimer: ReturnType<typeof setTimeout> | null = null
const isClient = typeof window !== 'undefined'
const isDev = import.meta.env.DEV

const viewerLinkedId = computed(() => {
  const id = authUser.value?.linkedWikidotId
  if (id == null) return null
  const numeric = Number(id)
  return Number.isFinite(numeric) ? numeric : null
})


const bffBase = normalizeBffBase((runtimeConfig?.public as any)?.bffBase);

const resolveAssetPath = (path?: string | null, fallback?: string | null, preferLow = false) => {
  const full = resolveWithFallback(path ?? '', fallback ?? '', bffBase);
  if (!preferLow) return full;
  const low = resolveWithFallback(path ?? '', fallback ?? '', bffBase, { variant: 'low' });
  return low || full;
};

definePageMeta({ key: (route:any) => route.fullPath })

if (isDev) {
  onBeforeRouteUpdate((to:any, from:any) => {
    console.log('页面路由更新:', { to: to.fullPath, from: from.fullPath })
  });
}

const wikidotId = computed(() => route.params.wikidotId as string)

// ===== Fetches =====
const { data: page, pending: pagePending, error: pageError } = await useAsyncData(
  () => `page-${wikidotId.value}`,
  () => $bff(`/pages/by-id`, { params: { wikidotId: wikidotId.value } }),
  { watch: [() => route.params.wikidotId] }
)

// 预览可用性检查（仅客户端）
const previewAvailable = ref(false)
if (import.meta.client) {
  watchEffect(async () => {
    const wid = page.value?.wikidotId
    if (!wid) { previewAvailable.value = false; return }
    try {
      const res = await $fetch<{ available: boolean }>(`/api/pages/${wid}/preview-status`)
      previewAvailable.value = res?.available ?? false
    } catch {
      previewAvailable.value = false
    }
  })
}

const pageDisplayTitle = computed(() => {
  const base = typeof page.value?.title === 'string' ? page.value!.title!.trim() : ''
  const alt = typeof (page.value as any)?.alternateTitle === 'string' ? (page.value as any).alternateTitle.trim() : ''
  if (alt) return base ? `${base} - ${alt}` : alt
  return base || 'Untitled'
})

const metricsUpdatedAt = computed(() => {
  const record = page.value as any
  if (!record) return null
  const raw = record.updatedAt || record.validFrom || record.createdAt || null
  if (!raw) return null
  if (typeof raw === 'string') return raw
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
})

const { data: pageImagesData, pending: pageImagesPending, error: pageImagesError, refresh: refreshPageImages } = await useAsyncData(
  () => `page-images-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/images`),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

const pageImagesRaw = computed(() => {
  const images = pageImagesData.value
  return Array.isArray(images) ? images : []
})

type PageImageItem = {
  imageKey: string
  width: number
  height: number
  ratio: number | null
  orientation: 'unknown' | 'wide' | 'tall' | 'normal'
  aspectStyle: string
  label: string
  imageSrc: string
  imageSrcFull: string
  copyUrl: string
  pageVersionImageId?: number
  normalizedUrl?: string
  originUrl?: string
}

const pageImages = computed<PageImageItem[]>(() => {
  const raw = pageImagesRaw.value
  return raw.map((img: any): PageImageItem | null => {
    const width = Number(img.width ?? img.assetWidth ?? 0)
    const height = Number(img.height ?? img.assetHeight ?? 0)
    const ratio = width > 0 && height > 0 ? width / height : null
    const orientation: PageImageItem['orientation'] = ratio == null ? 'unknown' : ratio >= 1.7 ? 'wide' : ratio <= 0.65 ? 'tall' : 'normal'
    const aspectStyle = ratio == null
      ? 'aspect-ratio: 4 / 3;'
      : orientation === 'wide'
        ? 'aspect-ratio: 16 / 9;'
        : orientation === 'tall'
          ? 'aspect-ratio: 3 / 4;'
          : 'aspect-ratio: 4 / 3;'
    const labelSource = img.displayUrl || img.normalizedUrl || img.originUrl || ''
    let label = labelSource
    if (label) {
      try {
        const parsed = new URL(label)
        const pathname = parsed.pathname.replace(/\/+$/u, '') || '/'
        label = `${parsed.hostname}${pathname}`
      } catch {
        label = label.replace(/^https?:\/\//i, '')
      }
    }
    const fullSrc = resolveAssetPath(img.imageUrl, labelSource)
    const lowSrc = resolveAssetPath(img.imageUrl, labelSource, true)
    const imageSrc = lowSrc || fullSrc
    if (!imageSrc) return null
    const imageKey = String(img.pageVersionImageId || img.normalizedUrl || img.originUrl || imageSrc)
    const copyUrl = pickExternalAssetUrl(img.displayUrl, img.originUrl, img.normalizedUrl) || fullSrc || imageSrc

    return {
      ...img,
      imageKey,
      width,
      height,
      ratio,
      orientation,
      aspectStyle,
      label,
      imageSrc,
      imageSrcFull: fullSrc || imageSrc,
      copyUrl
    }
  }).filter((img): img is PageImageItem => img !== null)
})

const primaryImageUrl = computed(() => {
  const firstImage = pageImages.value[0]
  if (firstImage?.imageSrc) return firstImage.imageSrc as string
  const record = page.value as any
  if (record && Array.isArray(record.images) && record.images.length > 0) {
    const fallback = record.images[0]
    const candidate = typeof fallback === 'string'
      ? fallback
      : fallback?.imageUrl || fallback?.normalizedUrl || fallback?.originUrl || ''
    if (typeof candidate === 'string' && candidate.trim()) {
      return resolveAssetPath(candidate, candidate)
    }
  }
  const direct = typeof record?.primaryImageUrl === 'string'
    ? record.primaryImageUrl
    : typeof record?.coverImageUrl === 'string'
      ? record.coverImageUrl
      : ''
  if (direct && typeof direct === 'string') {
    return resolveAssetPath(direct)
  }
  return ''
})

const canonicalUrl = computed(() => {
  const basePath = (route.fullPath || '').split('#')[0] || ''
  const normalizedPath = basePath.startsWith('/') ? basePath : `/${basePath}`
  if (isClient && typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${normalizedPath}`
  }
  const siteBase = (runtimeConfig?.public as any)?.siteBase
  if (typeof siteBase === 'string' && siteBase.trim()) {
    const sanitized = siteBase.replace(/\/+$/u, '')
    return `${sanitized}${normalizedPath}`
  }
  return ''
})

const { data: stats, pending: statsPending } = await useAsyncData(
  () => `stats-${wikidotId.value}`,
  () => $bff(`/stats/pages/${wikidotId.value}`),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

const pageSize = ref(3)
const revPage = ref(0)
const { data: revisionsPaged, pending: revisionsPending, error: revisionsError, refresh: refreshRevisions } = await useAsyncData(
  () => `revs-${wikidotId.value}-${revPage.value}-${pageSize.value}`,
  () => $bff(`/pages/${wikidotId.value}/revisions`, { params: { limit: pageSize.value, offset: revPage.value * pageSize.value, order: 'DESC', scope: 'latest' } }),
  { watch: [() => route.params.wikidotId, () => revPage.value, () => pageSize.value], server: false, lazy: true }
)
const hasMoreRevisions = computed(() => Array.isArray(revisionsPaged.value) && revisionsPaged.value.length === pageSize.value)
function nextRevPage(){ if (hasMoreRevisions.value) revPage.value += 1 }
function prevRevPage(){ if (revPage.value > 0) revPage.value -= 1 }
const { data: revisionsCount, pending: revisionsCountPending } = await useAsyncData(
  () => `revs-count-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/revisions/count`, { params: { scope: 'latest' } }),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)
const revTotalPages = computed(() => {
  const total = Number((revisionsCount as any).value?.total ?? page.value?.revisionCount ?? 0)
  if (!total || !pageSize.value) return 1
  return Math.max(1, Math.ceil(total / pageSize.value))
})
const deletedDate = computed(() => {
  const raw = page.value?.deletedAt
  if (!raw) return ''
  return formatDateIsoUtc8(raw)
})
const revPageNumbers = computed(() => [1,2,3,4].filter(n => n <= revTotalPages.value))
function goRevPage(n:number){
  const idx = Math.max(1, Math.min(revTotalPages.value, n)) - 1
  revPage.value = idx
}
const revJumpPage = ref<number | null>(null)
function jumpToRevPage(){
  if (revJumpPage.value == null) return
  const raw = Number(revJumpPage.value)
  if (!Number.isFinite(raw) || raw < 1) return
  const target = Math.max(1, Math.min(revTotalPages.value, Math.trunc(raw)))
  revPage.value = target - 1
  revJumpPage.value = target
}

const { data: firstRev, pending: firstRevPending } = await useAsyncData(
  () => `firstrev-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/revisions`, { params: { limit: 1, offset: 0, order: 'ASC', type: 'PAGE_CREATED' } }),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

const ratingGranularity = computed(() => {
  const first = firstRev.value && firstRev.value[0] && firstRev.value[0].timestamp
  const last = page.value?.updatedAt || page.value?.createdAt || ''
  const t0 = first ? new Date(first).getTime() : undefined
  const t1 = last ? new Date(last).getTime() : undefined
  if (t0 && t1 && t1 > t0) {
    const days = (t1 - t0) / 86400000
    if (days <= 90) return 'day'
    return 'week'
  }
  return 'week'
})

const { data: ratingHistory, pending: ratingHistoryPending, error: ratingHistoryError, refresh: refreshRatingHistory } = await useAsyncData(
  () => `page-rating-history-${wikidotId.value}-${ratingGranularity.value}`,
  () => $bff(`/pages/${wikidotId.value}/rating-history`, { params: { granularity: ratingGranularity.value } }),
  { watch: [() => route.params.wikidotId, () => ratingGranularity.value], server: false, lazy: true }
)

const { data: attributions, pending: attributionsPending } = await useAsyncData(
  () => `attributions-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/attributions`),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

const { data: voteDistribution, pending: voteDistributionPending } = await useAsyncData(
  () => `vote-dist-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/vote-distribution`),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

const { data: relatedPages, pending: relatedPending, error: relatedError, refresh: refreshRelatedPages } = useAsyncData(
  () => `related-pages-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/recommendations`, { params: { limit: 6, strategy: 'both', diversity: 'simple' } }),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

watch(
  () => relatedPages.value,
  (pages) => {
    if (!isClient) return
    if (!Array.isArray(pages) || pages.length === 0) return
    void hydrateViewerVotes(pages as any[])
  },
  { immediate: true, flush: 'post' }
)

const votePageSize = ref(10)

function recalcPageSizes() {
  const w = window.innerWidth || 0
  const voteCols = w >= 1536 ? 5 : w >= 1280 ? 4 : w >= 1024 ? 3 : w >= 768 ? 2 : w >= 640 ? 2 : 2
  const revCols = w >= 1024 ? 3 : w >= 640 ? 2 : 1
  const revRows = revCols <= 1 ? 7 : revCols === 2 ? 5 : 4
  pageSize.value = Math.max(1, revCols * revRows)
  const voteRows = voteCols <= 2 ? 10 : voteCols === 3 ? 8 : voteCols === 4 ? 7 : 6
  votePageSize.value = Math.max(voteCols, voteCols * voteRows)
  revPage.value = 0
  voteOffset.value = 0
}
const voteOffset = ref(0)
const { data: recentVotes, pending: recentVotesPending, error: recentVotesError, refresh: refreshRecentVotes } = await useAsyncData(
  () => `page-votes-${wikidotId.value}-${voteOffset.value}-${votePageSize.value}`,
  () => $bff(`/pages/${wikidotId.value}/votes/fuzzy`, { params: { limit: votePageSize.value, offset: voteOffset.value } }),
  { watch: [() => route.params.wikidotId, () => voteOffset.value, () => votePageSize.value], server: false, lazy: true }
)
const hasMoreVotes = computed(() => Array.isArray(recentVotes.value) && recentVotes.value.length === votePageSize.value)
const currentVotePage = computed(() => (voteOffset.value / votePageSize.value) + 1)
const { data: voteFuzzyCount, pending: voteFuzzyCountPending } = await useAsyncData(
  () => `page-votes-count-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/votes/fuzzy/count`),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)
const voteTotalPages = computed(() => {
  const total = Number((voteFuzzyCount as any).value?.total ?? 0)
  if (!total || !votePageSize.value) return 1
  return Math.max(1, Math.ceil(total / votePageSize.value))
})
const votePageNumbers = computed(() => [1,2,3,4].filter(n => n <= voteTotalPages.value))
function goVotePage(n:number){
  const idx = Math.max(1, Math.min(voteTotalPages.value, n)) - 1
  voteOffset.value = idx * votePageSize.value
}
function nextVotePage(){ if (hasMoreVotes.value) voteOffset.value += votePageSize.value }
function prevVotePage(){ voteOffset.value = Math.max(0, voteOffset.value - votePageSize.value) }
const voteJumpPage = ref<number | null>(null)
function jumpToVotePage(){
  if (voteJumpPage.value == null) return
  const raw = Number(voteJumpPage.value)
  if (!Number.isFinite(raw) || raw < 1) return
  const target = Math.max(1, Math.min(voteTotalPages.value, Math.trunc(raw)))
  voteOffset.value = (target - 1) * votePageSize.value
  voteJumpPage.value = target
}

const selectedVersion = ref<number | null>(null)
const { data: latestSourceResp, pending: latestSourcePending } = await useAsyncData(
  () => `page-latest-source-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/source`),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)
const latestSource = computed(() => {
  const s = latestSourceResp.value as any
  if (!s) return null
  return s.source || null
})

async function onVersionChange(ver: number | null) {
  selectedVersion.value = ver
  if (ver == null) return
  try {
    const resp = await $bff(`/pages/${wikidotId.value}/versions/${ver}/source`)
    ;(latestSourceResp as any).value = { source: resp?.source ?? null }
  } catch {
    ;(latestSourceResp as any).value = { source: null }
  }
}

const displayedSource = computed(() => latestSource.value ?? '暂无源码')

const sourceText = computed(() => {
  const text = latestSource.value
  return typeof text === 'string' ? text : ''
})

const sourceCharacterCount = computed(() => sourceText.value.length)

const { data: textContentResp, pending: textContentPending } = await useAsyncData(
  () => `page-text-content-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/text-content`),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

const pageTextContent = computed(() => {
  const payload = textContentResp.value as any
  const text = payload?.textContent
  return typeof text === 'string' ? text : ''
})

const textContentCharacterCount = computed(() => {
  const raw = pageTextContent.value
  if (!raw) return 0
  return raw.replace(/[\r\n\t]/g, '').length
})

const seoDescription = computed(() => {
  const record = page.value as any
  const candidates: Array<unknown> = [
    record?.summary,
    record?.description,
    record?.excerpt,
    record?.alternateTitle,
    pageTextContent.value
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const sanitized = candidate.replace(/\s+/g, ' ').trim()
      if (sanitized) {
        return sanitized.length > 160 ? `${sanitized.slice(0, 157)}…` : sanitized
      }
    }
  }
  return `${pageDisplayTitle.value} - 页面详情`
})

useHead(() => {
  const description = seoDescription.value
  const image = primaryImageUrl.value
  const url = canonicalUrl.value
  const meta: Array<{ name?: string; property?: string; content: string; key: string }> = [
    { name: 'description', content: description, key: 'description' },
    { property: 'og:type', content: 'article', key: 'og:type' },
    { property: 'og:title', content: pageDisplayTitle.value, key: 'og:title' },
    { property: 'og:description', content: description, key: 'og:description' },
    { name: 'twitter:card', content: image ? 'summary_large_image' : 'summary', key: 'twitter:card' },
    { name: 'twitter:title', content: pageDisplayTitle.value, key: 'twitter:title' },
    { name: 'twitter:description', content: description, key: 'twitter:description' }
  ]
  if (image) {
    meta.push({ property: 'og:image', content: image, key: 'og:image' })
    meta.push({ name: 'twitter:image', content: image, key: 'twitter:image' })
  }
  if (url) {
    meta.push({ property: 'og:url', content: url, key: 'og:url' })
  }
  const link = url ? [{ rel: 'canonical', href: url, key: 'canonical' }] : []
  return {
    title: pageDisplayTitle.value,
    meta,
    link
  }
})

const { data: pageVersions, pending: pageVersionsPending } = await useAsyncData(
  () => `page-versions-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/versions`, { params: { includeSource: false, limit: 100 } }),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

// ===== Derived & UI helpers =====
const sourceUrlHttps = computed<string>(() => {
  const raw = String(page.value?.url || '')
  return raw.replace(/^http:\/\//i, 'https://')
})
const createdDate = computed(() => {
  const fr = firstRev.value && firstRev.value[0]
  if (fr && fr.timestamp) return fr.timestamp
  return page.value?.createdAt || ''
})
function normalizeAuthorName(value?: string | null): string {
  const raw = String(value ?? '').trim()
  if (!raw) return ''
  return raw.replace(/^anon:/i, '').trim()
}

const groupedAttributions = computed(() => {
  const list = Array.isArray(attributions.value) ? attributions.value : []
  const effective = list.length > 0 ? list : [{ displayName: '(account deleted)', userWikidotId: 0, type: 'AUTHOR' }]
  const grouped: Record<string, any[]> = {}
  effective.forEach((attr:any) => {
    const t = attr.type || 'AUTHOR'
    if (!grouped[t]) grouped[t] = []
    grouped[t].push(attr)
  })
  return Object.entries(grouped).map(([type, users]) => ({ type, users }))
})

function formatDate(dateStr: string) {
  if (!dateStr) return 'N/A'
  return formatDateUtc8(dateStr, { year: 'numeric', month: 'short', day: 'numeric' }) || 'N/A'
}

async function copyAnchorLink(sectionId?: string) {
  if (!isClient) return
  const hash = sectionId ? `#${sectionId}` : ''
  const basePath = route.fullPath.split('#')[0]
  const origin = window?.location?.origin || ''
  const url = `${origin}${basePath}${hash}`
  const mark = sectionId ?? PAGE_ANCHOR_KEY
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = url
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    copiedAnchorId.value = mark
    if (anchorCopyTimer) clearTimeout(anchorCopyTimer)
    anchorCopyTimer = setTimeout(() => {
      if (copiedAnchorId.value === mark) copiedAnchorId.value = null
    }, 2000)
  } catch (error) {
    console.warn('[page-detail] copy link failed', error)
    window.prompt('请复制链接', url)
  }
}

const copiedId = ref(false)
function copyId(){
  if (!page.value?.wikidotId) return
  navigator.clipboard?.writeText(String(page.value.wikidotId)).then(() => {
    copiedId.value = true
    setTimeout(() => { copiedId.value = false }, 1200)
  }).catch(() => {})
}

const copiedSource = ref(false)
async function copySourceUrl(){
  const url = sourceUrlHttps.value || ''
  if (!url) return
  try {
    await navigator.clipboard?.writeText(url)
    copiedSource.value = true
    setTimeout(() => { copiedSource.value = false }, 1200)
  } catch {
    // Clipboard writes can fail when the browser denies permission.
  }
}

// Tags
const allTags = computed(() => orderTags(Array.isArray(page.value?.tags) ? page.value!.tags : []))

// Votes derived
const upvotes = computed(() => Number(voteDistribution.value?.upvotes ?? stats.value?.uv ?? 0))
const downvotes = computed(() => Number(voteDistribution.value?.downvotes ?? stats.value?.dv ?? 0))
const totalVotes = computed(() => Math.max(0, upvotes.value + downvotes.value))
const upvotePct = computed(() => totalVotes.value ? (upvotes.value / totalVotes.value) * 100 : 0)
const downvotePct = computed(() => totalVotes.value ? (downvotes.value / totalVotes.value) * 100 : 0)
const likeRatioPct = computed(() => totalVotes.value ? (upvotes.value / totalVotes.value) * 100 : 0)
const totalScore = computed(() => {
  const distribution = voteDistribution.value as any
  if (distribution && distribution.upvotes != null && distribution.downvotes != null) {
    const up = Number(distribution.upvotes)
    const down = Number(distribution.downvotes)
    if (Number.isFinite(up) && Number.isFinite(down)) {
      return up - down
    }
  }

  const statsValue = stats.value as any
  if (statsValue && statsValue.hasStats) {
    const up = Number(statsValue.uv ?? 0)
    const down = Number(statsValue.dv ?? 0)
    if (Number.isFinite(up) && Number.isFinite(down)) {
      return up - down
    }
  }

  const fallback = Number(page.value?.rating ?? 0)
  return Number.isFinite(fallback) ? fallback : 0
})
const totalScoreDisplay = computed(() => {
  const value = totalScore.value
  return Number.isFinite(value) ? value.toFixed(0) : '0'
})

const totalViewsCount = computed(() => {
  const raw = Number((stats as any).value?.totalViews ?? 0)
  return Number.isFinite(raw) ? Math.max(0, raw) : 0
})
const todayViewsCount = computed(() => {
  const raw = Number((stats as any).value?.todayViews ?? 0)
  return Number.isFinite(raw) ? Math.max(0, raw) : 0
})
const totalViewsDisplay = computed(() => totalViewsCount.value.toLocaleString('zh-CN'))
const todayViewsDisplay = computed(() => todayViewsCount.value.toLocaleString('zh-CN'))

// Wilson 95% lower bound
const wilsonLB = computed(() => {
  const n = totalVotes.value
  if (!n) return 0
  const z = 1.96
  const phat = upvotes.value / n
  const num = phat + (z*z)/(2*n) - z * Math.sqrt((phat*(1-phat) + (z*z)/(4*n))/n)
  const den = 1 + (z*z)/n
  return Math.max(0, num/den)
})

// Tooltips
const ratingTooltip = computed(() => `最近更新：${formatRelativeTime(page.value?.updatedAt || page.value?.createdAt || '')}`)
const voteTooltip = computed(() => `总票数：${totalVotes.value}`)
const wilsonTooltip = computed(() => `基于 Wilson 区间的下界，结合票数与比例`)

// Controversy index
const controversyIdx = computed(() => {
  const v = Number((stats as any).value?.controversy ?? 0)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
})

// Clean up
function onMove(_e: MouseEvent) { /* reserved */ }
onMounted(() => {
  const el = document.querySelector('svg')
  el?.addEventListener('mousemove', onMove)
  recalcPageSizes()
  window.addEventListener('resize', recalcPageSizes)
})
onBeforeUnmount(() => {
  const el = document.querySelector('svg')
  el?.removeEventListener('mousemove', onMove as any)
  window.removeEventListener('resize', recalcPageSizes)
  if (anchorCopyTimer) {
    clearTimeout(anchorCopyTimer)
    anchorCopyTimer = null
  }
})
</script>
