<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-neutral-900">
    <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-200 mb-1">Zipf 偏差分析</h2>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
      双对数坐标下词频-排名分布。蓝线=实际分布，灰虚线=理论 Zipf 直线（α={{ alpha }}）
    </p>
    <div v-if="pending" class="h-72 flex items-center justify-center text-neutral-400">加载中...</div>
    <div v-else-if="!zipfData?.points?.length" class="h-72 flex items-center justify-center text-neutral-400">暂无数据</div>
    <div v-show="zipfData?.points?.length && !pending" class="relative w-full" style="height: clamp(280px, 40vh, 420px)">
      <canvas ref="canvasEl"></canvas>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed, nextTick } from 'vue'
import type { ZipfAnalysis } from '~/types/text-analysis'

const { data: zipfData, pending } = useAsyncData<ZipfAnalysis>(
  'text-analysis-zipf',
  () => $fetch('/api/text-analysis/zipf-analysis')
)

const alpha = computed(() => zipfData.value?.alpha?.toFixed(3) || '—')

const canvasEl = ref<HTMLCanvasElement | null>(null)
let chart: any = null

function isDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

function render() {
  if (!canvasEl.value || !zipfData.value?.points?.length) return
  import('chart.js/auto').then((mod: any) => {
    const Chart = mod?.default || mod?.Chart
    if (!Chart) return
    if (chart) chart.destroy()

    const points = zipfData.value!.points
    const textColor = isDark() ? '#e5e5e5' : '#262626'
    const gridColor = isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'

    chart = new Chart(canvasEl.value!, {
      type: 'line',
      data: {
        labels: points.map(p => p.logRank.toFixed(2)),
        datasets: [
          {
            label: '实际分布',
            data: points.map(p => p.logFreq),
            borderColor: '#3b82f6',
            backgroundColor: '#3b82f633',
            pointRadius: 0,
            borderWidth: 2,
            tension: 0.1,
            fill: false
          },
          {
            label: '理论 Zipf',
            data: points.map(p => p.expectedLogFreq),
            borderColor: isDark() ? '#6b7280' : '#9ca3af',
            borderDash: [6, 3],
            pointRadius: 0,
            borderWidth: 1.5,
            fill: false
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
              title: (items: any[]) => {
                const idx = items[0]?.dataIndex ?? 0
                const p = points[idx]
                return p ? `${p.word} (排名 #${p.rank})` : ''
              }
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: 'log(排名)', color: textColor },
            grid: { color: gridColor },
            ticks: { color: textColor, maxTicksLimit: 15 }
          },
          y: {
            title: { display: true, text: 'log(词频)', color: textColor },
            grid: { color: gridColor },
            ticks: { color: textColor }
          }
        }
      }
    })
  })
}

let observer: MutationObserver | null = null

onMounted(() => {
  if (zipfData.value?.points?.length) nextTick(render)
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => {
      if (zipfData.value?.points?.length) render()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
})

onBeforeUnmount(() => {
  if (chart) { chart.destroy(); chart = null }
  if (observer) { observer.disconnect(); observer = null }
})

watch(() => zipfData.value, () => nextTick(render), { deep: true })
</script>
