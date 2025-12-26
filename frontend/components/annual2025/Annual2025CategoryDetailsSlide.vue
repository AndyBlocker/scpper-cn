<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div class="max-w-5xl w-full mx-auto px-2">
        <div class="flex items-center gap-2 md:gap-3 mb-4 md:mb-6">
          <div class="p-1.5 md:p-2 rounded-lg" :class="style.iconBg">
            <LucideIcon :name="style.icon" class="w-4 h-4 md:w-5 md:h-5 text-white" />
          </div>
          <h2 class="text-2xl md:text-3xl font-bold">{{ style.title }}</h2>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-2 md:gap-3 mb-4">
          <div class="bento-card py-2 text-center bg-gradient-to-br to-transparent" :class="style.summaryGradientFrom">
            <div class="text-xl md:text-2xl font-black text-[rgb(var(--fg))]">
              {{ siteData.categoryDetails?.[categoryKey]?.overview?.totalPages || 0 }}
            </div>
            <div class="text-[9px] md:text-xs text-[rgb(var(--muted))]">总数</div>
          </div>
          <div class="bento-card py-2 text-center">
            <div class="text-xl md:text-2xl font-black text-green-500">
              {{ siteData.categoryDetails?.[categoryKey]?.overview?.originals || 0 }}
            </div>
            <div class="text-[9px] md:text-xs text-[rgb(var(--muted))]">原创</div>
          </div>
          <div class="bento-card py-2 text-center">
            <div class="text-xl md:text-2xl font-black text-blue-500">
              {{ siteData.categoryDetails?.[categoryKey]?.overview?.translations || 0 }}
            </div>
            <div class="text-[9px] md:text-xs text-[rgb(var(--muted))]">翻译</div>
          </div>
          <div class="bento-card py-2 text-center">
            <div class="text-xl md:text-2xl font-black text-yellow-500">
              {{ siteData.categoryDetails?.[categoryKey]?.overview?.avgRating || 0 }}
            </div>
            <div class="text-[9px] md:text-xs text-[rgb(var(--muted))]">均分</div>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4 mb-3 md:mb-4">
          <div class="bento-card md:col-span-2">
            <div class="bento-header mb-1">
              <span class="text-xs font-medium text-[rgb(var(--muted))]">月度趋势</span>
              <span class="text-[10px] text-[rgb(var(--muted))]">
                原 {{ formatNumber(split.originals) }} / 译 {{ formatNumber(split.translations) }} / 总 {{ formatNumber(split.total) }}
              </span>
            </div>
            <div class="flex items-end gap-1">
              <div
                v-for="(item, i) in categoryHelpers.getCategoryMonthlyTrends(categoryKey)"
                :key="item.monthLabel"
                class="flex-1 flex flex-col items-center justify-end"
              >
                <div class="bar-value mb-0.5" :class="style.monthlyCountText">{{ formatNumber(item.total) }}</div>
                <div class="w-full h-16 md:h-20 flex items-end">
                  <div
                    class="w-full bg-gradient-to-t shadow-sm bar-fill-y"
                    :class="style.monthlyBarGradient"
                    :style="{ height: item.total === 0 ? '8px' : `${Math.max((item.total / categoryHelpers.getCategoryMonthlyMax(categoryKey)) * 100, 12)}%`, minHeight: '8px', '--bar-delay': `${i * 40}ms` }"
                  />
                </div>
                <div class="bar-axis mt-0.5">{{ item.monthLabel }}</div>
              </div>
            </div>
          </div>

          <div class="bento-card">
            <div class="bento-header mb-1">
              <span class="text-xs font-medium text-[rgb(var(--muted))]">原创 / 翻译比例</span>
              <span class="text-[10px] text-[rgb(var(--muted))]">
                原 {{ formatNumber(split.originals) }} / 译 {{ formatNumber(split.translations) }} / 总 {{ formatNumber(split.total) }}
              </span>
            </div>
            <div class="flex-1 flex flex-col justify-center gap-1.5">
              <div class="bar-track h-3 md:h-4 w-full">
                <div
                  class="bar-fill-x bg-green-500"
                  :style="{ width: `${Math.max(split.originalPercent, 3)}%`, '--bar-delay': '0ms' }"
                />
                <div
                  class="bar-fill-x bg-blue-500"
                  :style="{ width: `${Math.max(split.translationPercent, 3)}%`, '--bar-delay': '80ms' }"
                />
              </div>
              <div class="flex justify-between bar-meta">
                <span>原创 {{ split.originalPercent }}%</span>
                <span>翻译 {{ split.translationPercent }}%</span>
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
                <div v-if="categoryHelpers.getCategoryTopPages(categoryKey, 'original').length" class="space-y-1.5">
                  <NuxtLink
                    v-for="(page, idx) in categoryHelpers.getCategoryTopPages(categoryKey, 'original').slice(0, 3)"
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
                        {{ page.authorDisplayName }}<span v-if="style.showWordCount && page.wordCount !== undefined && page.wordCount !== null"> · {{ formatNumber(page.wordCount) }}字</span>
                      </div>
                    </div>
                    <div class="text-xs md:text-sm font-bold text-yellow-500">+{{ page.rating }}</div>
                  </NuxtLink>
                </div>
                <div v-else class="text-[9px] text-[rgb(var(--muted))]">暂无原创入榜</div>
              </div>
              <div>
                <div class="text-[10px] text-blue-400 font-bold uppercase tracking-wider mb-1">翻译</div>
                <div v-if="categoryHelpers.getCategoryTopPages(categoryKey, 'translation').length" class="space-y-1.5">
                  <NuxtLink
                    v-for="(page, idx) in categoryHelpers.getCategoryTopPages(categoryKey, 'translation').slice(0, 3)"
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
                        {{ page.authorDisplayName }}<span v-if="style.showWordCount && page.wordCount !== undefined && page.wordCount !== null"> · {{ formatNumber(page.wordCount) }}字</span>
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
                <div v-if="categoryHelpers.getCategoryTopAuthors(categoryKey, 'original').length" class="space-y-1.5">
                  <NuxtLink
                    v-for="(author, idx) in categoryHelpers.getCategoryTopAuthors(categoryKey, 'original').slice(0, 3)"
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
                <div v-if="categoryHelpers.getCategoryTopAuthors(categoryKey, 'translation').length" class="space-y-1.5">
                  <NuxtLink
                    v-for="(author, idx) in categoryHelpers.getCategoryTopAuthors(categoryKey, 'translation').slice(0, 3)"
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
            v-for="(tag, idx) in (siteData.categoryDetails?.[categoryKey]?.popularTags || []).slice(0, 10)"
            :key="idx"
            class="px-2 py-0.5 border text-[10px] rounded"
            :class="style.tagClass"
          >
            {{ tag.tag }} <span class="opacity-60">({{ tag.count }})</span>
          </span>
        </div>
      </div>
    </div>
    <div class="slide-bg">
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] blur-[100px] rounded-full" :class="style.glowClass" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AnnualCategoryHelpers, AnnualSiteData } from '~/types/annual2025'
import { formatNumber } from '~/utils/annual2025'

const props = defineProps<{
  isActive: boolean
  categoryKey: string
  siteData: AnnualSiteData
  categoryHelpers: AnnualCategoryHelpers
  isMobile: boolean
}>()

const CATEGORY_STYLES = {
  故事: {
    title: '基金会故事',
    icon: 'BookOpen',
    iconBg: 'bg-blue-600',
    summaryGradientFrom: 'from-blue-900/20',
    monthlyCountText: 'text-blue-400',
    monthlyBarGradient: 'from-blue-600 to-blue-400',
    tagClass: 'bg-blue-500/10 border-blue-500/30 text-blue-400',
    glowClass: 'bg-blue-600/10',
    showWordCount: true
  },
  goi格式: {
    title: 'GOI 格式',
    icon: 'Layers',
    iconBg: 'bg-yellow-600',
    summaryGradientFrom: 'from-yellow-900/20',
    monthlyCountText: 'text-amber-400',
    monthlyBarGradient: 'from-amber-600 to-amber-400',
    tagClass: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-400',
    glowClass: 'bg-yellow-600/10',
    showWordCount: true
  },
  艺术作品: {
    title: '艺术作品',
    icon: 'Palette',
    iconBg: 'bg-purple-600',
    summaryGradientFrom: 'from-purple-900/20',
    monthlyCountText: 'text-purple-400',
    monthlyBarGradient: 'from-purple-600 to-purple-400',
    tagClass: 'bg-purple-500/10 border-purple-500/30 text-purple-400',
    glowClass: 'bg-purple-600/10',
    showWordCount: false
  },
  wanderers: {
    title: '被放逐者的图书馆',
    icon: 'Library',
    iconBg: 'bg-emerald-600',
    summaryGradientFrom: 'from-emerald-900/20',
    monthlyCountText: 'text-emerald-400',
    monthlyBarGradient: 'from-emerald-600 to-emerald-400',
    tagClass: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
    glowClass: 'bg-emerald-600/10',
    showWordCount: true
  },
  文章: {
    title: '文章',
    icon: 'Newspaper',
    iconBg: 'bg-cyan-600',
    summaryGradientFrom: 'from-cyan-900/20',
    monthlyCountText: 'text-cyan-400',
    monthlyBarGradient: 'from-cyan-600 to-cyan-400',
    tagClass: 'bg-cyan-500/10 border-cyan-500/30 text-cyan-400',
    glowClass: 'bg-cyan-600/10',
    showWordCount: true
  }
} as const

const style = computed(() => CATEGORY_STYLES[props.categoryKey as keyof typeof CATEGORY_STYLES] || CATEGORY_STYLES.故事)
const split = computed(() => props.categoryHelpers.getCategorySplit(props.categoryKey))
</script>
