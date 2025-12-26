<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div class="max-w-5xl w-full mx-auto px-2">
        <div class="flex items-center gap-2 md:gap-3 mb-4 md:mb-6">
          <div class="p-1.5 md:p-2 bg-red-600 rounded-lg">
            <LucideIcon name="FileText" class="w-4 h-4 md:w-5 md:h-5 text-white" />
          </div>
          <h2 class="text-2xl md:text-3xl font-bold">SCP 文档</h2>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 md:gap-3 mb-4">
          <div class="bento-card py-2 text-center bg-gradient-to-br from-red-900/20 to-transparent">
            <div class="text-xl md:text-2xl font-black text-[rgb(var(--fg))]">
              {{ siteData.categoryDetails?.scp?.overview?.totalPages || 0 }}
            </div>
            <div class="text-[9px] md:text-xs text-[rgb(var(--muted))]">总数</div>
          </div>
          <div class="bento-card py-2 text-center">
            <div class="text-xl md:text-2xl font-black text-green-500">
              {{ siteData.categoryDetails?.scp?.overview?.originals || 0 }}
            </div>
            <div class="text-[9px] md:text-xs text-[rgb(var(--muted))]">原创</div>
          </div>
          <div class="bento-card py-2 text-center">
            <div class="text-xl md:text-2xl font-black text-blue-500">
              {{ siteData.categoryDetails?.scp?.overview?.translations || 0 }}
            </div>
            <div class="text-[9px] md:text-xs text-[rgb(var(--muted))]">翻译</div>
          </div>
          <div class="bento-card py-2 text-center">
            <div class="text-xl md:text-2xl font-black text-yellow-500">
              {{ siteData.categoryDetails?.scp?.overview?.avgRating || 0 }}
            </div>
            <div class="text-[9px] md:text-xs text-[rgb(var(--muted))]">均分</div>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4 mb-3 md:mb-4">
          <div class="bento-card md:col-span-1">
            <div class="bento-header mb-3">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">SCP 等级分布</span>
            </div>
            <div class="flex flex-col items-center gap-3">
              <div class="relative w-36 h-36 md:w-44 md:h-44">
                <div
                  class="w-full h-full rounded-full shadow-inner"
                  :style="{ background: scpClassPieGradient }"
                />
                <div class="absolute inset-3 rounded-full bg-[rgb(var(--bg))] border border-[rgba(var(--fg),0.08)] flex flex-col items-center justify-center text-center">
                  <span class="text-[9px] md:text-[10px] text-[rgb(var(--muted))]">总计</span>
                  <span class="text-lg md:text-xl font-black text-[rgb(var(--fg))]">{{ formatNumber(scpClassTotal) }}</span>
                </div>
              </div>

              <div class="grid grid-cols-3 gap-x-2 gap-y-1 w-full">
                <div
                  v-for="item in siteData.breakdown.scpByClass"
                  :key="item.key"
                  class="flex items-center gap-1"
                  :class="item.count === 0 ? 'opacity-40' : ''"
                  :title="`原创 ${item.originals} / 翻译 ${item.translations}`"
                >
                  <span class="w-1.5 h-1.5 rounded-sm flex-shrink-0" :style="{ background: item.color }" />
                  <span class="text-[8px] md:text-[9px] text-[rgb(var(--muted))] truncate">{{ item.label }}</span>
                  <span class="text-[8px] md:text-[9px] font-semibold text-[rgb(var(--fg))]">{{ formatNumber(item.count) }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="flex flex-col gap-3 md:col-span-2">
            <div class="bento-card">
              <div class="bento-header mb-1">
                <span class="text-xs font-medium text-[rgb(var(--muted))]">SCP 月度趋势</span>
                <span class="text-[10px] text-[rgb(var(--muted))]" :title="`原创 ${scpSplit.originals} / 翻译 ${scpSplit.translations}`">
                  共 {{ formatNumber(scpSplit.total) }} 篇
                </span>
              </div>
              <div class="flex items-end gap-1">
                <div
                  v-for="(item, i) in categoryHelpers.getCategoryMonthlyTrends('scp')"
                  :key="item.monthLabel"
                  class="flex-1 flex flex-col items-center justify-end"
                >
                  <div class="bar-value text-[rgb(var(--accent))] mb-0.5">{{ formatNumber(item.total) }}</div>
                  <div class="w-full h-16 md:h-20 flex items-end">
                    <div
                      class="w-full bg-gradient-to-t from-red-600 to-red-400 shadow-sm bar-fill-y"
                      :style="{ height: item.total === 0 ? '8px' : `${Math.max((item.total / categoryHelpers.getCategoryMonthlyMax('scp')) * 100, 12)}%`, minHeight: '8px', '--bar-delay': `${i * 40}ms` }"
                    />
                  </div>
                  <div class="bar-axis mt-0.5">{{ item.monthLabel }}</div>
                </div>
              </div>
            </div>

            <div class="bento-card">
              <div class="bento-header mb-1">
                <span class="text-xs font-medium text-[rgb(var(--muted))]">原创 / 翻译</span>
                <span class="text-[10px] text-[rgb(var(--muted))]">
                  {{ formatNumber(scpSplit.originals) }} / {{ formatNumber(scpSplit.translations) }}
                </span>
              </div>
              <div class="flex-1 flex flex-col justify-center gap-1.5">
                <div class="bar-track h-4 md:h-5 w-full">
                  <div
                    class="bar-fill-x bg-green-500"
                    :style="{ width: `${Math.max(scpSplit.originalPercent, 3)}%`, '--bar-delay': '0ms' }"
                  />
                  <div
                    class="bar-fill-x bg-blue-500"
                    :style="{ width: `${Math.max(scpSplit.translationPercent, 3)}%`, '--bar-delay': '80ms' }"
                  />
                </div>
                <div class="flex justify-between bar-meta">
                  <span>原创 {{ scpSplit.originalPercent }}%</span>
                  <span>翻译 {{ scpSplit.translationPercent }}%</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
          <div class="bento-card py-3">
            <div class="bento-header mb-2">
              <span class="text-xs font-medium text-[rgb(var(--muted))]">年度最高分</span>
              <LucideIcon name="Trophy" class="w-4 h-4 text-yellow-500" />
            </div>
            <div class="space-y-3">
              <div>
                <div class="text-[10px] text-green-400 font-bold uppercase tracking-wider mb-1">原创</div>
                <div v-if="categoryHelpers.getCategoryTopPages('scp', 'original').length" class="space-y-1.5">
                  <NuxtLink
                    v-for="(page, idx) in categoryHelpers.getCategoryTopPages('scp', 'original').slice(0, 3)"
                    :key="idx"
                    :to="page.wikidotId ? `/page/${page.wikidotId}` : undefined"
                    target="_blank"
                    class="flex items-center gap-2 p-1.5 bg-[rgba(var(--fg),0.05)] rounded-lg hover:bg-[rgba(var(--fg),0.1)] transition-colors"
                  >
                    <span class="w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center"
                      :class="idx === 0 ? 'bg-yellow-500 text-black' : idx === 1 ? 'bg-gray-400 text-black' : 'bg-amber-700 text-white'">{{ idx + 1 }}</span>
                    <div class="flex-1 min-w-0">
                      <div class="text-xs md:text-sm font-bold truncate">{{ page.title }}</div>
                      <div class="text-[9px] text-[rgb(var(--muted))]">
                        {{ page.authorDisplayName }} · {{ formatNumber(page.wordCount || 0) }}字
                      </div>
                    </div>
                    <div class="text-xs md:text-sm font-bold text-yellow-500">+{{ page.rating }}</div>
                  </NuxtLink>
                </div>
                <div v-else class="text-[9px] text-[rgb(var(--muted))]">暂无原创入榜</div>
              </div>
              <div>
                <div class="text-[10px] text-blue-400 font-bold uppercase tracking-wider mb-1">翻译</div>
                <div v-if="categoryHelpers.getCategoryTopPages('scp', 'translation').length" class="space-y-1.5">
                  <NuxtLink
                    v-for="(page, idx) in categoryHelpers.getCategoryTopPages('scp', 'translation').slice(0, 3)"
                    :key="idx"
                    :to="page.wikidotId ? `/page/${page.wikidotId}` : undefined"
                    target="_blank"
                    class="flex items-center gap-2 p-1.5 bg-[rgba(var(--fg),0.05)] rounded-lg hover:bg-[rgba(var(--fg),0.1)] transition-colors"
                  >
                    <span class="w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center"
                      :class="idx === 0 ? 'bg-yellow-500 text-black' : idx === 1 ? 'bg-gray-400 text-black' : 'bg-amber-700 text-white'">{{ idx + 1 }}</span>
                    <div class="flex-1 min-w-0">
                      <div class="text-xs md:text-sm font-bold truncate">{{ page.title }}</div>
                      <div class="text-[9px] text-[rgb(var(--muted))]">
                        {{ page.authorDisplayName }} · {{ formatNumber(page.wordCount || 0) }}字
                      </div>
                    </div>
                    <div class="text-xs md:text-sm font-bold text-yellow-500">+{{ page.rating }}</div>
                  </NuxtLink>
                </div>
                <div v-else class="text-[9px] text-[rgb(var(--muted))]">暂无翻译入榜</div>
              </div>
            </div>
          </div>

          <div class="bento-card py-3">
            <div class="bento-header mb-2">
              <span class="text-xs font-medium text-[rgb(var(--muted))]">作者总评分榜</span>
              <LucideIcon name="Users" class="w-4 h-4 text-[rgb(var(--accent))]" />
            </div>
            <div class="space-y-3">
              <div>
                <div class="text-[10px] text-green-400 font-bold uppercase tracking-wider mb-1">原创</div>
                <div v-if="categoryHelpers.getCategoryTopAuthors('scp', 'original').length" class="space-y-1.5">
                  <NuxtLink
                    v-for="(author, idx) in categoryHelpers.getCategoryTopAuthors('scp', 'original').slice(0, 3)"
                    :key="idx"
                    :to="author.wikidotId ? `/user/${author.wikidotId}` : undefined"
                    target="_blank"
                    class="flex items-center gap-2 p-1.5 bg-[rgba(var(--fg),0.05)] rounded-lg hover:bg-[rgba(var(--fg),0.1)] transition-colors"
                  >
                    <span class="w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center"
                      :class="idx === 0 ? 'bg-[rgb(var(--accent))] text-white' : 'bg-[rgba(var(--fg),0.1)] text-[rgb(var(--fg))]'">{{ idx + 1 }}</span>
                    <UserAvatar
                      :wikidot-id="author.wikidotId"
                      :name="author.displayName"
                      :size="isMobile ? 28 : 36"
                      class="w-7 h-7 md:w-9 md:h-9"
                    />
                    <div class="flex-1 min-w-0">
                      <div class="text-xs md:text-sm font-bold truncate">{{ author.displayName }}</div>
                      <div class="text-[9px] text-[rgb(var(--muted))]">{{ author.pageCount }} 篇 · 均分 {{ author.avgRating }}</div>
                    </div>
                    <div class="text-xs md:text-sm font-bold text-[rgb(var(--accent))]">+{{ author.totalRating }}</div>
                  </NuxtLink>
                </div>
                <div v-else class="text-[9px] text-[rgb(var(--muted))]">暂无原创上榜</div>
              </div>
              <div>
                <div class="text-[10px] text-blue-400 font-bold uppercase tracking-wider mb-1">翻译</div>
                <div v-if="categoryHelpers.getCategoryTopAuthors('scp', 'translation').length" class="space-y-1.5">
                  <NuxtLink
                    v-for="(author, idx) in categoryHelpers.getCategoryTopAuthors('scp', 'translation').slice(0, 3)"
                    :key="idx"
                    :to="author.wikidotId ? `/user/${author.wikidotId}` : undefined"
                    target="_blank"
                    class="flex items-center gap-2 p-1.5 bg-[rgba(var(--fg),0.05)] rounded-lg hover:bg-[rgba(var(--fg),0.1)] transition-colors"
                  >
                    <span class="w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center"
                      :class="idx === 0 ? 'bg-[rgb(var(--accent))] text-white' : 'bg-[rgba(var(--fg),0.1)] text-[rgb(var(--fg))]'">{{ idx + 1 }}</span>
                    <UserAvatar
                      :wikidot-id="author.wikidotId"
                      :name="author.displayName"
                      :size="isMobile ? 28 : 36"
                      class="w-7 h-7 md:w-9 md:h-9"
                    />
                    <div class="flex-1 min-w-0">
                      <div class="text-xs md:text-sm font-bold truncate">{{ author.displayName }}</div>
                      <div class="text-[9px] text-[rgb(var(--muted))]">{{ author.pageCount }} 篇 · 均分 {{ author.avgRating }}</div>
                    </div>
                    <div class="text-xs md:text-sm font-bold text-[rgb(var(--accent))]">+{{ author.totalRating }}</div>
                  </NuxtLink>
                </div>
                <div v-else class="text-[9px] text-[rgb(var(--muted))]">暂无翻译上榜</div>
              </div>
            </div>
          </div>
        </div>

        <div class="mt-3 flex flex-wrap gap-1.5">
          <span
            v-for="(tag, idx) in (siteData.categoryDetails?.scp?.popularTags || []).slice(0, 10)"
            :key="idx"
            class="px-2 py-0.5 bg-red-500/10 border border-red-500/30 text-red-400 text-[10px] rounded"
          >
            {{ tag.tag }} <span class="opacity-60">({{ tag.count }})</span>
          </span>
        </div>
      </div>
    </div>
    <div class="slide-bg">
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-red-600/10 blur-[100px] rounded-full" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AnnualCategoryHelpers, AnnualSiteData } from '~/types/annual2025'
import { formatNumber } from '~/utils/annual2025'

const props = defineProps<{
  isActive: boolean
  siteData: AnnualSiteData
  categoryHelpers: AnnualCategoryHelpers
  isMobile: boolean
}>()

const scpClassTotal = computed(() => {
  return props.siteData.breakdown.scpByClass.reduce((sum, item) => sum + item.count, 0)
})

const scpSplit = computed(() => props.categoryHelpers.getCategorySplit('scp'))

const scpClassPieGradient = computed(() => {
  const items = props.siteData.breakdown.scpByClass
  const total = scpClassTotal.value
  if (!items.length || total === 0) {
    return 'conic-gradient(rgba(var(--fg),0.08) 0deg 360deg)'
  }

  let currentAngle = 0
  const segments: string[] = []

  items.forEach(item => {
    if (!item.ratio) return
    const start = currentAngle
    const end = currentAngle + item.ratio * 360
    segments.push(`${item.color} ${start}deg ${end}deg`)
    currentAngle = end
  })

  return segments.length ? `conic-gradient(${segments.join(', ')})` : 'conic-gradient(rgba(var(--fg),0.08) 0deg 360deg)'
})
</script>
