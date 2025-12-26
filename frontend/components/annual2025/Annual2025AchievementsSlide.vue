<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div v-if="!hasUserData" class="max-w-md w-full mx-auto px-4 text-center">
        <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-2xl p-8 md:p-12">
          <div class="w-20 h-20 mx-auto mb-6 bg-[rgba(var(--fg),0.1)] rounded-full flex items-center justify-center">
            <LucideIcon name="Award" class="w-10 h-10 text-[rgb(var(--muted))]" />
          </div>
          <h2 class="text-xl md:text-2xl font-bold text-[rgb(var(--fg))] mb-3">年度成就</h2>
          <p class="text-[rgb(var(--muted))] text-sm">输入用户名查看成就</p>
        </div>
      </div>
      <div v-else class="max-w-5xl w-full px-2">
        <div class="flex items-center justify-between mb-6 md:mb-8">
          <h3 class="text-xl md:text-2xl font-bold flex items-center gap-2">
            <LucideIcon name="Award" class="text-yellow-500 w-5 h-5 md:w-6 md:h-6" /> 年度成就
            <span class="text-xs md:text-sm font-normal text-[rgb(var(--muted))]">
              ({{ userData.achievements.length }} 项)
            </span>
          </h3>
          <div v-if="achievementTotalPages > 1" class="flex items-center gap-1 md:gap-2">
            <button
              @click.stop="prevAchievementPage"
              :disabled="achievementPageIndex === 0"
              class="p-1.5 md:p-2 rounded-lg hover:bg-[rgba(var(--fg),0.1)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <LucideIcon name="ChevronLeft" class="w-4 h-4 md:w-5 md:h-5" />
            </button>
            <span class="text-xs md:text-sm text-[rgb(var(--muted))] min-w-[50px] md:min-w-[60px] text-center">
              {{ achievementPageIndex + 1 }} / {{ achievementTotalPages }}
            </span>
            <button
              @click.stop="nextAchievementPage"
              :disabled="achievementPageIndex >= achievementTotalPages - 1"
              class="p-1.5 md:p-2 rounded-lg hover:bg-[rgba(var(--fg),0.1)] disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <LucideIcon name="ChevronRight" class="w-4 h-4 md:w-5 md:h-5" />
            </button>
          </div>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
          <div
            v-for="ach in visibleAchievements"
            :key="ach.id"
            class="relative overflow-hidden rounded-xl md:rounded-2xl p-4 md:p-5 border transition-all duration-300 hover:scale-[1.01] hover:shadow-lg bg-[rgb(var(--panel))] border-[rgb(var(--panel-border))]"
          >
            <div class="flex items-start justify-between gap-3 md:gap-4">
              <div class="flex items-start gap-3 md:gap-4">
                <div class="w-9 h-9 md:w-10 md:h-10 rounded-lg flex items-center justify-center flex-shrink-0" :class="trophyBgClass(ach.period)">
                  <LucideIcon name="Trophy" class="w-4 h-4 md:w-5 md:h-5" :class="trophyIconClass(ach.period)" />
                </div>
                <div class="flex-1 min-w-0">
                  <!-- 完整成就标题 -->
                  <h4
                    class="text-sm md:text-base font-bold leading-tight text-[rgb(var(--fg))] mb-1"
                    :title="ach.originalTitle || ach.title"
                  >
                    {{ ach.title }}
                  </h4>
                  <p class="text-[10px] md:text-xs text-[rgb(var(--muted))]">{{ ach.periodText || '成就' }}</p>
                </div>
              </div>
              <span
                class="px-2 py-1 rounded-full text-[9px] md:text-[10px] font-semibold whitespace-nowrap"
                :class="achievementChipClass(ach.period)"
              >
                {{ getPeriodLabel(ach.period) }}
              </span>
            </div>

            <div class="mt-3 md:mt-4 flex justify-end items-center">
              <span class="font-mono text-sm md:text-base text-[rgb(var(--fg))] font-bold">{{ formatValue(ach.value) }}</span>
            </div>
          </div>
        </div>

      </div>
    </div>
    <div class="slide-bg">
      <div class="w-full h-full bg-[linear-gradient(rgba(var(--accent),0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(var(--accent),0.03)_1px,transparent_1px)] bg-[length:50px_50px]" />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AnnualUserData } from '~/types/annual2025'
import { normalizePeriod } from '~/utils/annual2025'

const props = defineProps<{
  isActive: boolean
  hasUserData: boolean
  userData: AnnualUserData
}>()

const ACHIEVEMENTS_PER_PAGE = 6
const achievementPageIndex = ref(0)

// 格式化数值
const formatValue = (val: string | number): string => {
  if (typeof val === 'string') return val

  const num = Number(val)
  if (isNaN(num)) return String(val)

  if (num >= 10000) {
    return (num / 10000).toFixed(1) + '万'
  }
  return num.toLocaleString()
}

// 获取时间范围标签
const getPeriodLabel = (period?: string): string => {
  const key = normalizePeriod(period)
  const map: Record<string, string> = {
    year: '年度',
    month: '月度',
    week: '周度',
    day: '每日',
    other: '成就'
  }
  return map[key] || map.other
}

// 时间范围标签样式 - 提高对比度
const achievementChipClass = (period?: string | null) => {
  const key = normalizePeriod(period)
  const map: Record<string, string> = {
    year: 'bg-amber-500 text-amber-950',
    month: 'bg-blue-500 text-blue-950',
    week: 'bg-emerald-500 text-emerald-950',
    day: 'bg-slate-400 text-slate-900',
    other: 'bg-[rgb(var(--muted))] text-[rgb(var(--bg))]'
  }
  return map[key] || map.other
}

// 奖杯图标背景样式
const trophyBgClass = (period?: string | null) => {
  const key = normalizePeriod(period)
  const map: Record<string, string> = {
    year: 'bg-amber-500/20',
    month: 'bg-blue-500/20',
    week: 'bg-emerald-500/20',
    day: 'bg-slate-500/20',
    other: 'bg-[rgba(var(--fg),0.1)]'
  }
  return map[key] || map.other
}

// 奖杯图标颜色样式
const trophyIconClass = (period?: string | null) => {
  const key = normalizePeriod(period)
  const map: Record<string, string> = {
    year: 'text-amber-400',
    month: 'text-blue-400',
    week: 'text-emerald-400',
    day: 'text-slate-400',
    other: 'text-[rgb(var(--muted))]'
  }
  return map[key] || map.other
}

// 根据 metric 判断指标类型，返回权重：得分(4) > 篇数(3) > 字数(2) > 投票(1)
const getMetricTypeWeight = (metric: string): number => {
  if (!metric) return 0
  const m = metric.toLowerCase()
  // 得分相关
  if (m.includes('rating') || m.includes('net')) return 4
  // 篇数相关（排除投票相关的 count）
  if ((m.includes('count') || m.includes('pages')) && !m.includes('vote') && !m.includes('voter')) return 3
  // 字数相关
  if (m.includes('words') || m.includes('length')) return 2
  // 投票相关
  if (m.includes('vote') || m.includes('voter') || m.includes('_up') || m.includes('_down') || m.includes('_total')) return 1
  return 0
}

const sortedAchievements = computed(() => {
  const all = props.userData.achievements || []
  const periodWeight = (period: string) => {
    const map: Record<string, number> = { year: 4, month: 3, week: 2, day: 1, other: 0 }
    return map[normalizePeriod(period)] ?? 0
  }
  return [...all].sort((a, b) => {
    // 1. 按时间范围排序（年>月>周>日）
    const periodDiff = periodWeight(b.period) - periodWeight(a.period)
    if (periodDiff !== 0) return periodDiff

    // 2. 按指标类型排序（得分>篇数>字数>投票）
    const metricDiff = getMetricTypeWeight(b.metric) - getMetricTypeWeight(a.metric)
    if (metricDiff !== 0) return metricDiff

    // 3. 按限定条件数量排序（少的排前面）
    const qualifierDiff = (a.qualifierLength || 0) - (b.qualifierLength || 0)
    if (qualifierDiff !== 0) return qualifierDiff

    // 4. 最后按数值大小排序
    const aVal = typeof a.value === 'number' ? a.value : parseFloat(a.value) || 0
    const bVal = typeof b.value === 'number' ? b.value : parseFloat(b.value) || 0
    return bVal - aVal
  })
})

const visibleAchievements = computed(() => {
  const all = sortedAchievements.value
  const start = achievementPageIndex.value * ACHIEVEMENTS_PER_PAGE
  return all.slice(start, start + ACHIEVEMENTS_PER_PAGE)
})

const achievementTotalPages = computed(() => {
  const all = sortedAchievements.value
  return Math.ceil(all.length / ACHIEVEMENTS_PER_PAGE)
})

const nextAchievementPage = () => {
  if (achievementPageIndex.value < achievementTotalPages.value - 1) {
    achievementPageIndex.value++
  }
}

const prevAchievementPage = () => {
  if (achievementPageIndex.value > 0) {
    achievementPageIndex.value--
  }
}

watch(sortedAchievements, () => {
  achievementPageIndex.value = 0
})
</script>
