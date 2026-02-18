<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-neutral-900">
    <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-200 mb-1">质量 × 丰富度</h2>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mb-4">散点图：TTR（词汇丰富度）vs 评分，带回归线</p>
    <div v-if="pending" class="h-72 flex items-center justify-center text-neutral-400">加载中...</div>
    <div v-else-if="!items?.items?.length" class="h-72 flex items-center justify-center text-neutral-400">暂无数据</div>
    <div v-show="items?.items?.length && !pending" class="relative w-full" style="height: clamp(280px, 40vh, 420px)">
      <canvas ref="canvasEl"></canvas>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import type { QualityRichnessPoint } from '~/types/text-analysis'

const { data: items, pending } = useAsyncData<{ items: QualityRichnessPoint[]; total: number }>(
  'text-analysis-quality',
  () => $fetch('/api/text-analysis/quality-richness?limit=500')
)

const canvasEl = ref<HTMLCanvasElement | null>(null)
let chart: any = null

function isDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

function linearRegression(points: { x: number; y: number }[]) {
  const n = points.length
  if (n < 2) return { slope: 0, intercept: 0 }
  let sx = 0, sy = 0, sxy = 0, sx2 = 0
  for (const p of points) { sx += p.x; sy += p.y; sxy += p.x * p.y; sx2 += p.x * p.x }
  const slope = (n * sxy - sx * sy) / (n * sx2 - sx * sx)
  const intercept = (sy - slope * sx) / n
  return { slope, intercept }
}

function render() {
  if (!canvasEl.value || !items.value?.items?.length) return
  import('chart.js/auto').then((mod: any) => {
    const Chart = mod?.default || mod?.Chart
    if (!Chart) return
    if (chart) chart.destroy()

    const data = items.value!.items
    const textColor = isDark() ? '#e5e5e5' : '#262626'
    const gridColor = isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'

    // Regression
    const pts = data.map(d => ({ x: d.ttr, y: d.rating }))
    const { slope, intercept } = linearRegression(pts)
    const minX = Math.min(...pts.map(p => p.x))
    const maxX = Math.max(...pts.map(p => p.x))

    chart = new Chart(canvasEl.value!, {
      type: 'scatter',
      data: {
        datasets: [
          {
            label: '页面',
            data: data.map(d => ({ x: d.ttr, y: d.rating, title: d.title })),
            backgroundColor: '#3b82f666',
            borderColor: '#3b82f6',
            borderWidth: 1,
            pointRadius: 3
          },
          {
            label: '回归线',
            data: [
              { x: minX, y: slope * minX + intercept },
              { x: maxX, y: slope * maxX + intercept }
            ],
            type: 'line',
            borderColor: '#ef4444',
            borderDash: [6, 3],
            borderWidth: 2,
            pointRadius: 0,
            fill: false
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: textColor } },
          tooltip: {
            callbacks: {
              label: (ctx: any) => {
                if (ctx.datasetIndex === 1) return '回归线'
                return `${ctx.raw.title} (TTR=${ctx.raw.x.toFixed(3)}, 评分=${ctx.raw.y})`
              }
            }
          }
        },
        scales: {
          x: { title: { display: true, text: 'TTR（词汇丰富度）', color: textColor }, grid: { color: gridColor }, ticks: { color: textColor } },
          y: { title: { display: true, text: '评分', color: textColor }, grid: { color: gridColor }, ticks: { color: textColor } }
        }
      }
    })
  })
}

let observer: MutationObserver | null = null
onMounted(() => {
  if (items.value?.items?.length) nextTick(render)
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      if (items.value?.items?.length) render()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
})
onBeforeUnmount(() => {
  if (chart) { chart.destroy(); chart = null }
  if (observer) { observer.disconnect(); observer = null }
})
watch(() => items.value, () => nextTick(render), { deep: true })
</script>
