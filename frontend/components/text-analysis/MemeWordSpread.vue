<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-neutral-900">
    <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-200 mb-1">模因词传播</h2>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mb-4">追踪选定词的月度累计出现数，观察传播 S 曲线</p>
    <div v-if="pending" class="h-72 flex items-center justify-center text-neutral-400">加载中...</div>
    <div v-else-if="!series?.length" class="h-72 flex items-center justify-center text-neutral-400">暂无数据</div>
    <div v-show="series?.length && !pending" class="relative w-full" style="height: clamp(280px, 40vh, 420px)">
      <canvas ref="canvasEl"></canvas>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import type { MemeWordSeries } from '~/types/text-analysis'

const memeWordSpreadEndpoint: string = '/api/text-analysis/meme-word-spread'

const { data: series, pending } = useAsyncData<MemeWordSeries[]>(
  'text-analysis-meme',
  () => $fetch<MemeWordSeries[]>(memeWordSpreadEndpoint)
)

const canvasEl = ref<HTMLCanvasElement | null>(null)
let chart: any = null

function isDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316']

function render() {
  if (!canvasEl.value || !series.value?.length) return
  import('chart.js/auto').then((mod: any) => {
    const Chart = mod?.default || mod?.Chart
    if (!Chart) return
    if (chart) chart.destroy()

    const textColor = isDark() ? '#e5e5e5' : '#262626'
    const gridColor = isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'

    // Use the union of all months as labels
    const monthSet = new Set<string>()
    for (const s of series.value!) for (const p of s.points) monthSet.add(p.month)
    const months = [...monthSet].sort()

    chart = new Chart(canvasEl.value!, {
      type: 'line',
      data: {
        labels: months,
        datasets: series.value!.map((s, i) => ({
          label: s.word,
          data: months.map(m => {
            const pt = s.points.find(p => p.month === m)
            return pt?.cumulative ?? null
          }),
          borderColor: COLORS[i % COLORS.length],
          backgroundColor: COLORS[i % COLORS.length] + '22',
          tension: 0.35,
          pointRadius: 0,
          borderWidth: 2,
          fill: false,
          spanGaps: true
        }))
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: { legend: { labels: { color: textColor } } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: textColor, maxTicksLimit: 20 } },
          y: { grid: { color: gridColor }, ticks: { color: textColor }, title: { display: true, text: '累计出现次数', color: textColor }, beginAtZero: true }
        }
      }
    })
  })
}

let observer: MutationObserver | null = null
onMounted(() => {
  if (series.value?.length) nextTick(render)
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      if (series.value?.length) render()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
})
onBeforeUnmount(() => {
  if (chart) { chart.destroy(); chart = null }
  if (observer) { observer.disconnect(); observer = null }
})
watch(() => series.value, () => nextTick(render), { deep: true })
</script>
