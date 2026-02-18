<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-neutral-900">
    <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-200 mb-1">词汇演化</h2>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mb-4">按半年分桶，追踪候选词典（103K 词）中各词首次出现的时间与新词涌现趋势</p>
    <div v-if="pending" class="h-72 flex items-center justify-center text-neutral-400">加载中...</div>
    <div v-else-if="!buckets?.length" class="h-72 flex items-center justify-center text-neutral-400">暂无数据</div>
    <div v-show="buckets?.length && !pending" class="relative w-full" style="height: clamp(280px, 40vh, 420px)">
      <canvas ref="canvasEl"></canvas>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import type { VocabEvolutionBucket } from '~/types/text-analysis'

const { data: buckets, pending } = useAsyncData<VocabEvolutionBucket[]>(
  'text-analysis-evolution',
  () => $fetch('/api/text-analysis/vocabulary-evolution')
)

const canvasEl = ref<HTMLCanvasElement | null>(null)
let chart: any = null

function isDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

function render() {
  if (!canvasEl.value || !buckets.value?.length) return
  import('chart.js/auto').then((mod: any) => {
    const Chart = mod?.default || mod?.Chart
    if (!Chart) return
    if (chart) chart.destroy()

    const textColor = isDark() ? '#e5e5e5' : '#262626'
    const gridColor = isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'

    chart = new Chart(canvasEl.value!, {
      type: 'line',
      data: {
        labels: buckets.value!.map(b => b.period),
        datasets: [
          {
            label: '总词汇量',
            data: buckets.value!.map(b => b.totalWords),
            borderColor: '#3b82f6',
            backgroundColor: '#3b82f633',
            fill: true,
            tension: 0.3,
            pointRadius: 3,
            borderWidth: 2,
            yAxisID: 'y'
          },
          {
            label: '新增词汇',
            data: buckets.value!.map(b => b.newWords),
            borderColor: '#f97316',
            backgroundColor: '#f9731666',
            type: 'bar',
            yAxisID: 'y1'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { labels: { color: textColor } },
          tooltip: {
            callbacks: {
              afterBody: (items: any[]) => {
                const idx = items[0]?.dataIndex ?? 0
                const b = buckets.value![idx]
                return b?.topNew?.length ? `代表新词: ${b.topNew.slice(0, 5).join('、')}` : ''
              }
            }
          }
        },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: textColor } },
          y: { grid: { color: gridColor }, ticks: { color: textColor }, title: { display: true, text: '总词汇量', color: textColor }, beginAtZero: true },
          y1: { grid: { drawOnChartArea: false }, ticks: { color: textColor }, title: { display: true, text: '新增词汇', color: textColor }, position: 'right', beginAtZero: true }
        }
      }
    })
  })
}

let observer: MutationObserver | null = null
onMounted(() => {
  if (buckets.value?.length) nextTick(render)
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      if (buckets.value?.length) render()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
})
onBeforeUnmount(() => {
  if (chart) { chart.destroy(); chart = null }
  if (observer) { observer.disconnect(); observer = null }
})
watch(() => buckets.value, () => nextTick(render), { deep: true })
</script>
