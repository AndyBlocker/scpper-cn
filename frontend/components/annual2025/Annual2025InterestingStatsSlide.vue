<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div class="max-w-5xl w-full mx-auto px-2">
        <div class="flex items-center gap-2 md:gap-3 mb-6 md:mb-8">
          <div class="p-1.5 md:p-2 bg-[rgb(var(--accent))] rounded-lg">
            <LucideIcon name="Sparkles" class="w-4 h-4 md:w-5 md:h-5 text-white" />
          </div>
          <h2 class="text-2xl md:text-3xl font-bold">有趣数据</h2>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-4">
          <div v-if="siteData.interestingStats.mostActiveVotingDay" class="bento-card bg-gradient-to-br from-amber-500/10 to-transparent">
            <div class="flex items-center gap-1.5 text-amber-400 mb-2">
              <LucideIcon name="CalendarCheck" class="w-4 h-4" />
              <span class="text-[10px] md:text-xs font-bold uppercase">最活跃投票日</span>
            </div>
            <div class="text-lg md:text-xl font-bold text-[rgb(var(--fg))]">{{ siteData.interestingStats.mostActiveVotingDay.date }}</div>
            <div class="text-2xl md:text-3xl font-black text-amber-400">{{ siteData.interestingStats.mostActiveVotingDay.voteCount }}</div>
            <div class="text-[10px] text-[rgb(var(--muted))]">次投票</div>
          </div>

          <NuxtLink
            v-if="siteData.interestingStats.mostCollaborativePage"
            :to="siteData.interestingStats.mostCollaborativePage.wikidotId ? `/page/${siteData.interestingStats.mostCollaborativePage.wikidotId}` : undefined"
            target="_blank"
            class="bento-card bg-gradient-to-br from-pink-500/10 to-transparent block hover:scale-[1.02] transition-transform"
          >
            <div class="flex items-center gap-1.5 text-pink-400 mb-2">
              <LucideIcon name="Users" class="w-4 h-4" />
              <span class="text-[10px] md:text-xs font-bold uppercase">合著人数最多</span>
            </div>
            <div class="text-sm md:text-base font-bold text-[rgb(var(--fg))] line-clamp-1">{{ siteData.interestingStats.mostCollaborativePage.title }}</div>
            <div class="text-2xl md:text-3xl font-black text-pink-400">{{ siteData.interestingStats.mostCollaborativePage.authorCount }}</div>
            <div class="text-[10px] text-[rgb(var(--muted))]">位作者</div>
          </NuxtLink>

          <NuxtLink
            v-if="siteData.interestingStats.longestTitlePage"
            :to="siteData.interestingStats.longestTitlePage.wikidotId ? `/page/${siteData.interestingStats.longestTitlePage.wikidotId}` : undefined"
            target="_blank"
            class="bento-card bg-gradient-to-br from-cyan-500/10 to-transparent block hover:scale-[1.02] transition-transform"
          >
            <div class="flex items-center gap-1.5 text-cyan-400 mb-2">
              <LucideIcon name="Type" class="w-4 h-4" />
              <span class="text-[10px] md:text-xs font-bold uppercase">标题最长</span>
            </div>
            <div class="text-sm md:text-base font-bold text-[rgb(var(--fg))] line-clamp-2">{{ siteData.interestingStats.longestTitlePage.title }}</div>
            <div class="text-[10px] text-[rgb(var(--muted))] mb-1">{{ siteData.interestingStats.longestTitlePage.author }}</div>
            <div class="text-2xl md:text-3xl font-black text-cyan-400">{{ siteData.interestingStats.longestTitlePage.titleLength }}</div>
            <div class="text-[10px] text-[rgb(var(--muted))]">字符</div>
          </NuxtLink>

          <NuxtLink
            v-if="siteData.interestingStats.mostTagsPage"
            :to="siteData.interestingStats.mostTagsPage.wikidotId ? `/page/${siteData.interestingStats.mostTagsPage.wikidotId}` : undefined"
            target="_blank"
            class="bento-card bg-gradient-to-br from-orange-500/10 to-transparent block hover:scale-[1.02] transition-transform"
          >
            <div class="flex items-center gap-1.5 text-orange-400 mb-2">
              <LucideIcon name="Tags" class="w-4 h-4" />
              <span class="text-[10px] md:text-xs font-bold uppercase">Tag最多</span>
            </div>
            <div class="text-sm md:text-base font-bold text-[rgb(var(--fg))] line-clamp-1">{{ siteData.interestingStats.mostTagsPage.title }}</div>
            <div class="text-[10px] text-[rgb(var(--muted))] mb-1">{{ siteData.interestingStats.mostTagsPage.author }}</div>
            <div class="text-2xl md:text-3xl font-black text-orange-400">{{ siteData.interestingStats.mostTagsPage.tagCount }}</div>
            <div class="text-[10px] text-[rgb(var(--muted))]">个标签</div>
          </NuxtLink>

          <div v-if="boutiqueTagsPreview.length" class="bento-card bg-gradient-to-br from-amber-500/10 to-transparent">
            <div class="flex items-center gap-1.5 text-amber-400 mb-2">
              <LucideIcon name="Star" class="w-4 h-4" />
              <span class="text-[10px] md:text-xs font-bold uppercase">精品共现标签</span>
            </div>
            <div class="text-[10px] text-[rgb(var(--muted))]">精品页面 {{ formatNumber(boutiqueTotalPages) }} 篇</div>
            <div class="space-y-1.5 mt-2">
              <div
                v-for="(tag, i) in boutiqueTagsPreview"
                :key="tag.tag"
                class="flex items-center gap-2"
              >
                <span class="text-[9px] text-[rgb(var(--muted))] w-16 truncate">#{{ tag.tag }}</span>
                <div class="bar-track h-2 flex-1">
                  <div
                    class="bar-fill-x h-full bg-amber-500"
                    :style="{ width: `${tag.percent}%`, '--bar-delay': `${i * 60}ms` }"
                  />
                </div>
                <span class="bar-value w-8 text-right">{{ formatNumber(tag.count) }}</span>
              </div>
            </div>
          </div>

          <div class="bento-card bg-gradient-to-br from-indigo-500/10 to-transparent">
            <div class="flex items-center gap-1.5 text-indigo-400 mb-2">
              <LucideIcon name="Calendar" class="w-4 h-4" />
              <span class="text-[10px] md:text-xs font-bold uppercase">工作日 vs 周末</span>
            </div>
            <div class="space-y-2 mt-2">
              <div class="flex justify-between items-center">
                <span class="text-[10px] text-[rgb(var(--muted))]">工作日投票</span>
                <span class="text-sm font-bold text-[rgb(var(--fg))]">{{ formatNumber(siteData.interestingStats.weekdayVsWeekend.weekday.votes) }}</span>
              </div>
              <div class="flex justify-between items-center">
                <span class="text-[10px] text-[rgb(var(--muted))]">周末投票</span>
                <span class="text-sm font-bold text-[rgb(var(--fg))]">{{ formatNumber(siteData.interestingStats.weekdayVsWeekend.weekend.votes) }}</span>
              </div>
              <div class="bar-track h-2 w-full mt-2">
                <div
                  class="bar-fill-x bg-indigo-500"
                  :style="{ width: `${siteData.interestingStats.weekdayVsWeekend.weekdayPercent}%`, '--bar-delay': '0ms' }"
                />
                <div
                  class="bar-fill-x bg-indigo-300"
                  :style="{ width: `${siteData.interestingStats.weekdayVsWeekend.weekendPercent}%`, '--bar-delay': '80ms' }"
                />
              </div>
            </div>
          </div>

          <NuxtLink
            v-if="siteData.interestingStats.firstRevision"
            :to="`/page/${siteData.interestingStats.firstRevision.wikidotId}`"
            target="_blank"
            class="bento-card bg-gradient-to-br from-emerald-500/10 to-transparent block hover:scale-[1.02] transition-transform"
          >
            <div class="flex items-center gap-1.5 text-emerald-400 mb-2">
              <LucideIcon name="Play" class="w-4 h-4" />
              <span class="text-[10px] md:text-xs font-bold uppercase">年度第一个编辑</span>
            </div>
            <div class="text-sm md:text-base font-bold text-[rgb(var(--fg))] line-clamp-1">{{ siteData.interestingStats.firstRevision.title }}</div>
            <div class="text-[10px] text-[rgb(var(--muted))] mb-1">{{ siteData.interestingStats.firstRevision.author }}</div>
            <div class="text-xs md:text-sm font-medium text-emerald-400">{{ siteData.interestingStats.firstRevision.timestamp }}</div>
          </NuxtLink>
        </div>
      </div>
    </div>
    <div class="slide-bg">
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-gradient-to-r from-amber-500/10 via-pink-500/10 to-purple-500/10 blur-[120px] rounded-full" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AnnualSiteData } from '~/types/annual2025'
import { formatNumber } from '~/utils/annual2025'

const props = defineProps<{
  isActive: boolean
  siteData: AnnualSiteData
}>()

const boutiqueTags = computed(() => props.siteData.tagInsights?.boutiqueTags?.tags || [])
const boutiqueTotalPages = computed(() => props.siteData.tagInsights?.boutiqueTags?.totalPages || 0)
const boutiqueMax = computed(() => {
  const counts = boutiqueTags.value.map(tag => tag.count)
  return Math.max(...counts, 1)
})
const boutiqueTagsPreview = computed(() => {
  return boutiqueTags.value.slice(0, 6).map(tag => ({
    ...tag,
    percent: boutiqueMax.value > 0 ? Math.round((tag.count / boutiqueMax.value) * 100) : 0
  }))
})
</script>
