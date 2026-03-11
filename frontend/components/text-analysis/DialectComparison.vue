<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-neutral-900">
    <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-200 mb-1">方言对比</h2>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mb-4">原创 vs 翻译、早期 vs 近期文章的词汇特征对比</p>
    <div v-if="pending" class="h-72 flex items-center justify-center text-neutral-400">加载中...</div>
    <div v-else-if="!groups?.length" class="h-72 flex items-center justify-center text-neutral-400">暂无数据</div>
    <div v-else class="space-y-6">
      <!-- Stats cards -->
      <div class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <div v-for="g in groups" :key="g.label" class="rounded-lg border border-neutral-100 dark:border-neutral-800 p-3">
          <div class="text-xs text-neutral-500 dark:text-neutral-400 mb-1">{{ g.label }}</div>
          <div class="text-lg font-semibold text-neutral-800 dark:text-neutral-200">{{ g.stats.totalPages }} 篇</div>
          <div class="text-xs text-neutral-500 mt-1">
            平均词长 {{ g.stats.avgWordLength.toFixed(2) }} · TTR {{ g.stats.avgTtr.toFixed(3) }}
          </div>
        </div>
      </div>
      <!-- Bar chart -->
      <div v-show="groups?.length && !pending" class="relative w-full" style="height: clamp(240px, 32vh, 360px)">
        <canvas ref="canvasEl"></canvas>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import type { DialectGroup } from '~/types/text-analysis'

const dialectComparisonEndpoint: string = '/api/text-analysis/dialect-comparison'

const { data: groups, pending } = useAsyncData<DialectGroup[]>(
  'text-analysis-dialect',
  () => $fetch<DialectGroup[]>(dialectComparisonEndpoint)
)

const canvasEl = ref<HTMLCanvasElement | null>(null)
let chart: any = null

function isDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

const COLORS = ['#3b82f6', '#8b5cf6', '#ec4899', '#f97316']

function render() {
  if (!canvasEl.value || !groups.value?.length) return
  import('chart.js/auto').then((mod: any) => {
    const Chart = mod?.default || mod?.Chart
    if (!Chart) return
    if (chart) chart.destroy()

    const textColor = isDark() ? '#e5e5e5' : '#262626'
    const gridColor = isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'

    // Top 10 words across all groups
    const allWords = new Set<string>()
    for (const g of groups.value!) {
      for (const w of g.stats.topWords.slice(0, 10)) allWords.add(w.word)
    }
    const words = [...allWords].slice(0, 12)

    chart = new Chart(canvasEl.value!, {
      type: 'bar',
      data: {
        labels: words,
        datasets: groups.value!.map((g, i) => ({
          label: g.label,
          data: words.map(w => {
            const found = g.stats.topWords.find(tw => tw.word === w)
            return found?.freq ?? 0
          }),
          backgroundColor: COLORS[i % COLORS.length] + 'cc',
          borderColor: COLORS[i % COLORS.length],
          borderWidth: 1
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: textColor } } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: textColor } },
          y: { grid: { color: gridColor }, ticks: { color: textColor }, beginAtZero: true }
        }
      }
    })
  })
}

let observer: MutationObserver | null = null
onMounted(() => {
  if (groups.value?.length) nextTick(render)
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      if (groups.value?.length) render()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
})
onBeforeUnmount(() => {
  if (chart) { chart.destroy(); chart = null }
  if (observer) { observer.disconnect(); observer = null }
})
watch(() => groups.value, () => nextTick(render), { deep: true })
</script>
