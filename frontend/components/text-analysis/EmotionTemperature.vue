<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-neutral-900">
    <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-200 mb-1">情绪温度</h2>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mb-4">基于情绪词典计算的 per-page 情绪分数，散点图（评分 vs 情绪）+ 分类柱状图</p>
    <div v-if="pending" class="h-72 flex items-center justify-center text-neutral-400">加载中...</div>
    <div v-else-if="!emotionData?.points?.length" class="h-72 flex items-center justify-center text-neutral-400">暂无数据</div>
    <div v-else class="space-y-6">
      <div v-show="emotionData?.points?.length && !pending" class="relative w-full" style="height: clamp(280px, 36vh, 400px)">
        <canvas ref="scatterEl"></canvas>
      </div>
      <div v-show="emotionData?.points?.length && !pending" class="relative w-full" style="height: clamp(200px, 24vh, 280px)">
        <canvas ref="barEl"></canvas>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import type { EmotionData } from '~/types/text-analysis'

const { data: emotionData, pending } = useAsyncData<EmotionData>(
  'text-analysis-emotion',
  () => $fetch('/api/text-analysis/emotion-temperature')
)

const scatterEl = ref<HTMLCanvasElement | null>(null)
const barEl = ref<HTMLCanvasElement | null>(null)
let scatterChart: any = null
let barChart: any = null

function isDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

function sentimentColor(s: number): string {
  if (s > 0.3) return '#10b981'
  if (s > 0) return '#3b82f6'
  if (s > -0.3) return '#f59e0b'
  return '#ef4444'
}

function render() {
  if (!emotionData.value) return
  import('chart.js/auto').then((mod: any) => {
    const Chart = mod?.default || mod?.Chart
    if (!Chart) return

    const textColor = isDark() ? '#e5e5e5' : '#262626'
    const gridColor = isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'

    // Scatter
    if (scatterEl.value && emotionData.value!.points?.length) {
      if (scatterChart) scatterChart.destroy()
      const pts = emotionData.value!.points
      scatterChart = new Chart(scatterEl.value!, {
        type: 'scatter',
        data: {
          datasets: [{
            label: '页面',
            data: pts.map(p => ({ x: p.sentimentScore, y: p.rating, title: p.title })),
            backgroundColor: pts.map(p => sentimentColor(p.sentimentScore) + '88'),
            borderColor: pts.map(p => sentimentColor(p.sentimentScore)),
            borderWidth: 1,
            pointRadius: 3
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: (ctx: any) => `${ctx.raw.title} (情绪=${ctx.raw.x.toFixed(2)}, 评分=${ctx.raw.y})`
              }
            }
          },
          scales: {
            x: { title: { display: true, text: '情绪分数', color: textColor }, grid: { color: gridColor }, ticks: { color: textColor } },
            y: { title: { display: true, text: '评分', color: textColor }, grid: { color: gridColor }, ticks: { color: textColor } }
          }
        }
      })
    }

    // Bar
    if (barEl.value && emotionData.value!.summary?.length) {
      if (barChart) barChart.destroy()
      const sum = emotionData.value!.summary
      barChart = new Chart(barEl.value!, {
        type: 'bar',
        data: {
          labels: sum.map(s => s.category),
          datasets: [
            {
              label: '平均情绪',
              data: sum.map(s => s.avgSentiment),
              backgroundColor: sum.map(s => sentimentColor(s.avgSentiment) + 'cc'),
              yAxisID: 'y'
            },
            {
              label: '平均评分',
              data: sum.map(s => s.avgRating),
              backgroundColor: '#8b5cf6cc',
              yAxisID: 'y1'
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: textColor } } },
          scales: {
            x: { grid: { color: gridColor }, ticks: { color: textColor } },
            y: { grid: { color: gridColor }, ticks: { color: textColor }, title: { display: true, text: '平均情绪', color: textColor }, position: 'left' },
            y1: { grid: { drawOnChartArea: false }, ticks: { color: textColor }, title: { display: true, text: '平均评分', color: textColor }, position: 'right' }
          }
        }
      })
    }
  })
}

let observer: MutationObserver | null = null
onMounted(() => {
  if (emotionData.value?.points?.length) nextTick(render)
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      if (emotionData.value?.points?.length) render()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
})
onBeforeUnmount(() => {
  if (scatterChart) { scatterChart.destroy(); scatterChart = null }
  if (barChart) { barChart.destroy(); barChart = null }
  if (observer) { observer.disconnect(); observer = null }
})
watch(() => emotionData.value, () => nextTick(render), { deep: true })
</script>
