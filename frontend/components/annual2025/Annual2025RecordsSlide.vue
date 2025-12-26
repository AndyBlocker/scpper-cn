<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div class="max-w-5xl w-full mx-auto px-2">
        <div class="text-center mb-4 md:mb-8">
          <h2 class="text-2xl md:text-3xl font-bold mb-2">数据之最</h2>
          <div class="w-12 md:w-16 h-1 bg-[rgb(var(--panel-border))] mx-auto rounded-full" />
        </div>

        <div class="grid grid-cols-2 lg:grid-cols-3 gap-2 md:gap-4">
          <NuxtLink
            :to="siteData.records.longest.wikidotId ? `/page/${siteData.records.longest.wikidotId}` : undefined"
            target="_blank"
            class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-xl p-3 md:p-5 relative overflow-hidden block hover:scale-[1.02] transition-transform"
          >
            <div class="hidden md:block absolute top-0 right-0 p-16 bg-blue-600/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
            <div class="relative z-10">
              <div class="flex items-center gap-1.5 text-blue-400 mb-1.5 md:mb-2">
                <LucideIcon name="ScrollText" class="w-3.5 h-3.5 md:w-4 md:h-4" />
                <span class="text-[10px] md:text-xs font-bold uppercase tracking-wider">最长文档</span>
              </div>
              <h3 class="text-sm md:text-base font-bold text-[rgb(var(--fg))] mb-0.5 line-clamp-1">{{ siteData.records.longest.title }}</h3>
              <div class="text-[9px] md:text-[11px] text-[rgb(var(--muted))] mb-1.5">{{ siteData.records.longest.author }}</div>
              <div class="text-xl md:text-2xl font-black text-[rgb(var(--fg))]">
                {{ formatNumber(siteData.records.longest.count) }}
                <span class="text-[10px] md:text-xs text-[rgb(var(--muted))] font-normal">字</span>
              </div>
            </div>
          </NuxtLink>

          <NuxtLink
            :to="siteData.records.shortest.wikidotId ? `/page/${siteData.records.shortest.wikidotId}` : undefined"
            target="_blank"
            class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-xl p-3 md:p-5 relative overflow-hidden block hover:scale-[1.02] transition-transform"
          >
            <div class="hidden md:block absolute top-0 right-0 p-16 bg-green-600/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
            <div class="relative z-10">
              <div class="flex items-center gap-1.5 text-green-400 mb-1.5 md:mb-2">
                <LucideIcon name="Minimize2" class="w-3.5 h-3.5 md:w-4 md:h-4" />
                <span class="text-[10px] md:text-xs font-bold uppercase tracking-wider">最短高分</span>
              </div>
              <h3 class="text-sm md:text-base font-bold text-[rgb(var(--fg))] mb-0.5 line-clamp-1">{{ siteData.records.shortest.title }}</h3>
              <div class="text-[9px] md:text-[11px] text-[rgb(var(--muted))] mb-1.5">{{ siteData.records.shortest.author }}</div>
              <div class="text-xl md:text-2xl font-black text-[rgb(var(--fg))]">
                {{ siteData.records.shortest.count }}
                <span class="text-[10px] md:text-xs text-[rgb(var(--muted))] font-normal">字</span>
              </div>
            </div>
          </NuxtLink>

          <NuxtLink
            v-if="siteData.interestingStats.mostTagsPage"
            :to="siteData.interestingStats.mostTagsPage.wikidotId ? `/page/${siteData.interestingStats.mostTagsPage.wikidotId}` : undefined"
            target="_blank"
            class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-xl p-3 md:p-5 relative overflow-hidden block hover:scale-[1.02] transition-transform"
          >
            <div class="hidden md:block absolute top-0 right-0 p-16 bg-fuchsia-600/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
            <div class="relative z-10">
              <div class="flex items-center gap-1.5 text-fuchsia-400 mb-1.5 md:mb-2">
                <LucideIcon name="Tags" class="w-3.5 h-3.5 md:w-4 md:h-4" />
                <span class="text-[10px] md:text-xs font-bold uppercase tracking-wider">标签最多</span>
              </div>
              <h3 class="text-sm md:text-base font-bold text-[rgb(var(--fg))] mb-0.5 line-clamp-1">{{ siteData.interestingStats.mostTagsPage.title }}</h3>
              <div class="text-[9px] md:text-[11px] text-[rgb(var(--muted))] mb-1.5">{{ siteData.interestingStats.mostTagsPage.author }}</div>
              <div class="text-xl md:text-2xl font-black text-[rgb(var(--fg))]">
                {{ formatNumber(siteData.interestingStats.mostTagsPage.tagCount) }}
                <span class="text-[10px] md:text-xs text-[rgb(var(--muted))] font-normal">个标签</span>
              </div>
            </div>
          </NuxtLink>

          <NuxtLink
            v-if="siteData.extremeStats.mostVotesTotal"
            :to="siteData.extremeStats.mostVotesTotal.wikidotId ? `/page/${siteData.extremeStats.mostVotesTotal.wikidotId}` : undefined"
            target="_blank"
            class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-xl p-3 md:p-5 relative overflow-hidden block hover:scale-[1.02] transition-transform"
          >
            <div class="hidden md:block absolute top-0 right-0 p-16 bg-yellow-600/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
            <div class="relative z-10">
              <div class="flex items-center gap-1.5 text-yellow-400 mb-1.5 md:mb-2">
                <LucideIcon name="Vote" class="w-3.5 h-3.5 md:w-4 md:h-4" />
                <span class="text-[10px] md:text-xs font-bold uppercase tracking-wider">获票最多</span>
              </div>
              <h3 class="text-sm md:text-base font-bold text-[rgb(var(--fg))] mb-0.5 line-clamp-1">{{ siteData.extremeStats.mostVotesTotal.title }}</h3>
              <div class="text-[9px] md:text-[11px] text-[rgb(var(--muted))] mb-1.5">{{ siteData.extremeStats.mostVotesTotal.author }}</div>
              <div class="text-xl md:text-2xl font-black text-[rgb(var(--fg))]">
                {{ siteData.extremeStats.mostVotesTotal.count.toLocaleString() }}
                <span class="text-[10px] md:text-xs text-[rgb(var(--muted))] font-normal">票</span>
              </div>
            </div>
          </NuxtLink>

          <NuxtLink
            v-if="siteData.extremeStats.mostVotesOneDay"
            :to="siteData.extremeStats.mostVotesOneDay.wikidotId ? `/page/${siteData.extremeStats.mostVotesOneDay.wikidotId}` : undefined"
            target="_blank"
            class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-xl p-3 md:p-5 relative overflow-hidden block hover:scale-[1.02] transition-transform"
          >
            <div class="hidden md:block absolute top-0 right-0 p-16 bg-orange-600/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
            <div class="relative z-10">
              <div class="flex items-center gap-1.5 text-orange-400 mb-1.5 md:mb-2">
                <LucideIcon name="Zap" class="w-3.5 h-3.5 md:w-4 md:h-4" />
                <span class="text-[10px] md:text-xs font-bold uppercase tracking-wider">单日最多票</span>
              </div>
              <h3 class="text-sm md:text-base font-bold text-[rgb(var(--fg))] mb-0.5 line-clamp-1">{{ siteData.extremeStats.mostVotesOneDay.title }}</h3>
              <div class="text-[9px] md:text-[11px] text-[rgb(var(--muted))] mb-1.5">{{ siteData.extremeStats.mostVotesOneDay.date }}</div>
              <div class="text-xl md:text-2xl font-black text-[rgb(var(--fg))]">
                {{ siteData.extremeStats.mostVotesOneDay.count }}
                <span class="text-[10px] md:text-xs text-[rgb(var(--muted))] font-normal">票</span>
              </div>
            </div>
          </NuxtLink>

          <NuxtLink
            v-if="siteData.extremeStats.mostUpvotesOneDay"
            :to="siteData.extremeStats.mostUpvotesOneDay.wikidotId ? `/page/${siteData.extremeStats.mostUpvotesOneDay.wikidotId}` : undefined"
            target="_blank"
            class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-xl p-3 md:p-5 relative overflow-hidden block hover:scale-[1.02] transition-transform"
          >
            <div class="hidden md:block absolute top-0 right-0 p-16 bg-cyan-600/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
            <div class="relative z-10">
              <div class="flex items-center gap-1.5 text-cyan-400 mb-1.5 md:mb-2">
                <LucideIcon name="ThumbsUp" class="w-3.5 h-3.5 md:w-4 md:h-4" />
                <span class="text-[10px] md:text-xs font-bold uppercase tracking-wider">单日最多 UpVote</span>
              </div>
              <h3 class="text-sm md:text-base font-bold text-[rgb(var(--fg))] mb-0.5 line-clamp-1">{{ siteData.extremeStats.mostUpvotesOneDay.title }}</h3>
              <div class="text-[9px] md:text-[11px] text-[rgb(var(--muted))] mb-1.5">{{ siteData.extremeStats.mostUpvotesOneDay.date }}</div>
              <div class="text-xl md:text-2xl font-black text-[rgb(var(--fg))]">
                {{ siteData.extremeStats.mostUpvotesOneDay.count }}
                <span class="text-[10px] md:text-xs text-[rgb(var(--muted))] font-normal">票</span>
              </div>
            </div>
          </NuxtLink>

          <div v-if="siteData.extremeStats.mostProlificDay" class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-xl p-3 md:p-5 relative overflow-hidden">
            <div class="hidden md:block absolute top-0 right-0 p-16 bg-purple-600/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
            <div class="relative z-10">
              <div class="flex items-center gap-1.5 text-purple-400 mb-1.5 md:mb-2">
                <LucideIcon name="Calendar" class="w-3.5 h-3.5 md:w-4 md:h-4" />
                <span class="text-[10px] md:text-xs font-bold uppercase tracking-wider">最繁忙日</span>
              </div>
              <h3 class="text-sm md:text-base font-bold text-[rgb(var(--fg))] mb-0.5">{{ siteData.extremeStats.mostProlificDay.date }}</h3>
              <div class="text-[9px] md:text-[11px] text-[rgb(var(--muted))] mb-1.5">单日发布最多</div>
              <div class="text-xl md:text-2xl font-black text-[rgb(var(--fg))]">
                {{ siteData.extremeStats.mostProlificDay.count }}
                <span class="text-[10px] md:text-xs text-[rgb(var(--muted))] font-normal">篇</span>
              </div>
            </div>
          </div>

          <NuxtLink
            v-if="siteData.records.topTranslation"
            :to="siteData.records.topTranslation.wikidotId ? `/page/${siteData.records.topTranslation.wikidotId}` : undefined"
            target="_blank"
            class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-xl p-3 md:p-5 relative overflow-hidden block hover:scale-[1.02] transition-transform"
          >
            <div class="hidden md:block absolute top-0 right-0 p-16 bg-indigo-600/10 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2" />
            <div class="relative z-10">
              <div class="flex items-center gap-1.5 text-indigo-400 mb-1.5 md:mb-2">
                <LucideIcon name="Languages" class="w-3.5 h-3.5 md:w-4 md:h-4" />
                <span class="text-[10px] md:text-xs font-bold uppercase tracking-wider">最高分翻译</span>
              </div>
              <h3 class="text-sm md:text-base font-bold text-[rgb(var(--fg))] mb-0.5 line-clamp-1">{{ siteData.records.topTranslation.title }}</h3>
              <div class="text-[9px] md:text-[11px] text-[rgb(var(--muted))] mb-1.5">{{ siteData.records.topTranslation.author }}</div>
              <div class="text-xl md:text-2xl font-black text-[rgb(var(--fg))]">
                +{{ siteData.records.topTranslation.rating }}
                <span class="text-[10px] md:text-xs text-[rgb(var(--muted))] font-normal">分</span>
              </div>
            </div>
          </NuxtLink>

        </div>
      </div>
    </div>
    <div class="slide-bg">
      <div class="w-full h-full bg-[radial-gradient(rgba(var(--fg),0.03)_1px,transparent_1px)] bg-[length:24px_24px]" />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AnnualSiteData } from '~/types/annual2025'
import { formatNumber } from '~/utils/annual2025'

defineProps<{
  isActive: boolean
  siteData: AnnualSiteData
}>()
</script>
