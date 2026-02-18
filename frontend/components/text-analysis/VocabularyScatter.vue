<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-neutral-900">
    <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-200 mb-1">PMI × 熵散点图</h2>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mb-4">每个点代表一个词，横轴=最小PMI（内聚度），纵轴=平均邻接熵（灵活度），点大小=词频，颜色=词长</p>
    <div v-if="pending" class="h-72 flex items-center justify-center text-neutral-400">加载中...</div>
    <div v-else-if="!data?.items?.length" class="h-72 flex items-center justify-center text-neutral-400">暂无数据，请先运行预计算脚本</div>
    <div v-show="data?.items?.length && !pending" class="relative w-full" style="height: clamp(280px, 40vh, 420px)">
      <canvas ref="canvasEl"></canvas>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import type { VocabScatterPoint } from '~/types/text-analysis'

const { data, pending } = useAsyncData<{ items: VocabScatterPoint[]; total: number }>(
  'text-analysis-vocabulary-scatter',
  () => $fetch('/api/text-analysis/vocabulary-scatter?limit=500')
)

const canvasEl = ref<HTMLCanvasElement | null>(null)
let chart: any = null

function isDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

const COLORS_BY_LENGTH: Record<number, string> = {
  2: '#3b82f6',
  3: '#8b5cf6',
  4: '#ec4899',
  5: '#f97316',
  6: '#14b8a6',
  7: '#eab308',
}

function render() {
  if (!canvasEl.value || !data.value?.items?.length) return
  import('chart.js/auto').then((mod: any) => {
    const Chart = mod?.default || mod?.Chart
    if (!Chart) return
    if (chart) chart.destroy()

    const items = data.value!.items
    const maxFreq = Math.max(...items.map(d => d.freq))
    const textColor = isDark() ? '#e5e5e5' : '#262626'
    const gridColor = isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'

    chart = new Chart(canvasEl.value!, {
      type: 'scatter',
      data: {
        datasets: [{
          data: items.map(d => ({
            x: d.minPmi,
            y: d.avgEntropy,
            word: d.word,
            freq: d.freq,
            length: d.length
          })),
          backgroundColor: items.map(d => (COLORS_BY_LENGTH[d.length] || '#6b7280') + '99'),
          borderColor: items.map(d => COLORS_BY_LENGTH[d.length] || '#6b7280'),
          borderWidth: 1,
          pointRadius: items.map(d => Math.max(3, Math.sqrt(d.freq / maxFreq) * 18))
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx: any) => {
                const raw = ctx.raw
                return `${raw.word} (频次=${raw.freq}, 长度=${raw.length})`
              }
            }
          }
        },
        scales: {
          x: {
            title: { display: true, text: '最小 PMI（内聚度）', color: textColor },
            grid: { color: gridColor },
            ticks: { color: textColor }
          },
          y: {
            title: { display: true, text: '平均邻接熵（灵活度）', color: textColor },
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
  if (data.value?.items?.length) nextTick(render)
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => { if (data.value?.items?.length) render() })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
})

onBeforeUnmount(() => {
  if (chart) { chart.destroy(); chart = null }
  if (observer) { observer.disconnect(); observer = null }
})

watch(() => data.value, () => { nextTick(render) }, { deep: true })
</script>
