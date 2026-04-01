<template>
  <div class="space-y-8">
    <section
      class="relative mx-auto max-w-5xl overflow-hidden rounded-lg border border-white/30 p-6 shadow-sm"
      :style="bannerSectionStyle"
    >
      <div class="relative flex flex-col gap-6">
        <div class="space-y-4">
          <div class="inline-flex items-center gap-2 rounded-full border border-white/25 bg-black/20 px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em] text-white">
            <span>竞赛专题</span>
            <span class="h-1.5 w-1.5 rounded-full bg-[var(--g-accent)]" />
            <span>2026 冬季征文</span>
          </div>
          <div class="space-y-2">
            <h2 class="text-2xl font-semibold text-white">2026冬季征文：循环</h2>
            <p class="max-w-2xl text-sm leading-relaxed text-white/90">
              专题页已上线，包含赛程节点、完整规则、随机四篇与全部参赛作品列表。
            </p>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-xs text-white/90">
            <span class="rounded-full border border-white/20 bg-black/20 px-3 py-1">征文开始：2026-02-17 00:00（GMT+8）</span>
            <span class="rounded-full border border-white/20 bg-black/20 px-3 py-1">投稿截止：2026-03-03 23:59（GMT+8）</span>
            <span class="rounded-full border border-white/20 bg-black/20 px-3 py-1">计票截止：2026-03-10 23:59（GMT+8）</span>
          </div>
          <NuxtLink
            to="/winter-contest-2026"
            class="inline-flex w-fit items-center rounded-lg bg-[var(--g-accent)] px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:opacity-95"
          >
            查看竞赛页
          </NuxtLink>
        </div>
      </div>
    </section>

    <!-- Overview metrics -->
    <section class="space-y-6">
      <div class="flex items-center justify-between gap-2 flex-wrap">
        <div class="flex items-center gap-4">
          <div class="flex h-12 w-12 items-center justify-center rounded-lg bg-[var(--g-accent-medium)] text-[var(--g-accent)]">
            <LucideIcon name="LayoutDashboard" class="h-6 w-6" />
          </div>
          <div>
            <h2 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-50">站点总览</h2>
          </div>
        </div>
        <span class="text-sm text-neutral-500 dark:text-neutral-400" :title="overviewUpdatedAtFull">上次更新：{{ overviewUpdatedAtRelative }}</span>
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 items-stretch max-w-4xl mx-auto">
        <!-- Users Block -->
        <div class="h-full min-h-[13rem] text-center relative overflow-hidden rounded-lg border border-neutral-200 bg-white p-6 shadow-sm transition-all duration-200 dark:border-white/10 dark:bg-neutral-900">
          <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">用户</div>
          <div class="mt-4 flex items-end justify-center">
            <div class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">{{ Number(overview?.users?.total || 0).toLocaleString() }}</div>
          </div>
          <div class="mt-4 space-y-2 text-xs text-neutral-600 dark:text-neutral-400">
            <div class="flex items-center justify-center gap-2">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">活跃</span>
              <div class="flex items-center gap-2"><span>{{ Number(overview?.users?.active || 0).toLocaleString() }}</span></div>
            </div>
            <div class="flex items-center justify-center gap-2">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">贡献者</span>
              <div class="flex items-center gap-2"><span>{{ Number(overview?.users?.contributors || 0).toLocaleString() }}</span></div>
            </div>
            <div class="flex items-center justify-center gap-2">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">作者</span>
              <div class="flex items-center gap-2"><span>{{ Number(overview?.users?.authors || 0).toLocaleString() }}</span></div>
            </div>
          </div>
        </div>

        <!-- Pages Block -->
        <div class="h-full min-h-[13rem] text-center relative overflow-hidden rounded-lg border border-neutral-200 bg-white p-6 shadow-sm transition-all duration-200 dark:border-white/10 dark:bg-neutral-900">
          <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">页面</div>
          <div class="mt-4 flex items-end justify-center">
            <div class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">{{ Number(overview?.pages?.total || 0).toLocaleString() }}</div>
          </div>
          <div class="mt-4 space-y-2 text-xs text-neutral-600 dark:text-neutral-400">
            <div class="flex items-center justify-center gap-2">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">原创</span>
              <div class="flex items-center gap-2"><span>{{ Number(overview?.pages?.originals || 0).toLocaleString() }}</span></div>
            </div>
            <div class="flex items-center justify-center gap-2">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">翻译</span>
              <div class="flex items-center gap-2"><span>{{ Number(overview?.pages?.translations || 0).toLocaleString() }}</span></div>
            </div>
            <div class="flex items-center justify-center gap-2">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">已删除</span>
              <div class="flex items-center gap-2"><span>{{ Number((overview as any)?.pages?.deleted || 0).toLocaleString() }}</span></div>
            </div>
          </div>
        </div>

        <!-- Votes Block -->
        <div class="h-full min-h-[13rem] text-center relative overflow-hidden rounded-lg border border-neutral-200 bg-white p-6 shadow-sm transition-all duration-200 dark:border-white/10 dark:bg-neutral-900">
          <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">投票</div>
          <div class="mt-4 flex items-end justify-center">
            <div class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">{{ Number(overview?.votes?.total || 0).toLocaleString() }}</div>
          </div>
          <div class="mt-4 space-y-2 text-xs text-neutral-600 dark:text-neutral-400">
            <div class="flex items-center justify-center gap-2">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">upvote</span>
              <div class="flex items-center gap-2"><span>{{ Number(overview?.votes?.upvotes || 0).toLocaleString() }}</span></div>
            </div>
            <div class="flex items-center justify-center gap-2">
              <span class="font-medium text-neutral-700 dark:text-neutral-300">downvote</span>
              <div class="flex items-center gap-2"><span>{{ Number(overview?.votes?.downvotes || 0).toLocaleString() }}</span></div>
            </div>
          </div>
        </div>

        <!-- Revisions Block -->
        <div class="h-full min-h-[13rem] text-center relative overflow-hidden rounded-lg border border-neutral-200 bg-white p-6 shadow-sm transition-all duration-200 dark:border-white/10 dark:bg-neutral-900">
          <div class="flex h-full flex-col">
            <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">修订</div>
            <div class="flex-1 flex items-center justify-center">
              <div class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">{{ Number(overview?.revisions?.total || 0).toLocaleString() }}</div>
            </div>
          </div>
        </div>
      </div>
    </section>

  </div>
</template>

<script setup lang="ts">
import { useNuxtApp, useAsyncData, useRuntimeConfig, useCookie, navigateTo } from 'nuxt/app';
import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import { normalizeBffBase, resolveAssetUrl } from '~/utils/assetUrl';

// 愚人节彩蛋：2026-04-01 (UTC+8) 首页仅首次访问跳转到排行榜
const _afCookie = useCookie('af2026', { maxAge: 86400 })
const _now = new Date()
const _utc8 = new Date(_now.getTime() + 8 * 60 * 60 * 1000)
if (_utc8.getUTCFullYear() === 2026 && _utc8.getUTCMonth() === 3 && _utc8.getUTCDate() === 1 && !_afCookie.value) {
  _afCookie.value = '1'
  navigateTo('/ranking', { redirectCode: 302 })
}

type SiteOverviewRich = {
  date?: string;
  updatedAt?: string;
  users: { total: number; active: number; contributors: number; authors: number };
  pages: { total: number; originals: number; translations: number; deleted?: number };
  votes: { total: number; upvotes: number; downvotes: number };
  revisions: { total: number };
};
import type { BffFetcher } from '~/types/nuxt-bff'
const nuxtApp = useNuxtApp();
const bff = nuxtApp.$bff as unknown as BffFetcher;
const runtimeConfig = useRuntimeConfig();
const bffBase = normalizeBffBase((runtimeConfig?.public as any)?.bffBase);
const WINTER_CONTEST_HERO_ASSET_PATH = '/page-images/39867';
const WINTER_CONTEST_HERO_FALLBACK_URL = 'https://05command-cn.wdfiles.com/local--files/collab%3Aimage-collection/2026wintercon-banner.jpg';
const bannerImageLowSrc = resolveAssetUrl(WINTER_CONTEST_HERO_ASSET_PATH, bffBase, { variant: 'low' });
const bannerImageFullSrc = resolveAssetUrl(WINTER_CONTEST_HERO_ASSET_PATH, bffBase) || WINTER_CONTEST_HERO_FALLBACK_URL;
const bannerSectionStyle = computed(() => {
  const imageLayers = [bannerImageLowSrc, bannerImageFullSrc]
    .filter((src): src is string => typeof src === 'string' && src.length > 0)
    .map(src => `url("${src}")`);
  const overlay = 'linear-gradient(120deg, rgba(8, 12, 20, 0.78) 0%, rgba(10, 18, 34, 0.62) 48%, rgba(18, 35, 72, 0.58) 100%)';
  return {
    backgroundImage: imageLayers.length > 0 ? `${overlay}, ${imageLayers.join(', ')}` : overlay,
    backgroundPosition: 'center 24%',
    backgroundSize: 'cover',
    backgroundRepeat: 'no-repeat'
  };
});

// Fetch overview data server-side
const { data: overview } = await useAsyncData<SiteOverviewRich>('site-overview', () => bff<SiteOverviewRich>('/stats/site/overview'));

// Sparkline removed for a simpler, centered overview layout

// 更新时间（GMT+8，悬浮显示完整时间，正文为相对时间）
const mounted = ref(false)
const relativeNowMs = ref(Date.now())
let relativeTimer: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  mounted.value = true
  relativeNowMs.value = Date.now()
  relativeTimer = setInterval(() => {
    relativeNowMs.value = Date.now()
  }, 30_000)
})

onBeforeUnmount(() => {
  if (!relativeTimer) return
  clearInterval(relativeTimer)
  relativeTimer = null
})

const overviewUpdatedAtRaw = computed(() => (overview.value as any)?.updatedAt || (overview.value as any)?.date || null)
const overviewUpdatedAtFull = computed(() => formatToGmt8Full(overviewUpdatedAtRaw.value))
const overviewUpdatedAtRelative = computed(() => mounted.value
  ? formatRelativeZh(overviewUpdatedAtRaw.value, relativeNowMs.value)
  : overviewUpdatedAtFull.value
)
</script>
