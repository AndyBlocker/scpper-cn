<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-neutral-900">
    <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-200 mb-1">创意密度排行</h2>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mb-4">按稀有词密度排名的文章，展示文字创新程度</p>
    <div v-if="pending" class="h-48 flex items-center justify-center text-neutral-400">加载中...</div>
    <div v-else-if="!items?.items?.length" class="h-48 flex items-center justify-center text-neutral-400">暂无数据</div>
    <div v-else class="space-y-4">
      <div v-show="items?.items?.length && !pending" class="relative w-full" style="height: clamp(200px, 28vh, 320px)">
        <canvas ref="canvasEl"></canvas>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-neutral-200 dark:border-neutral-700 text-left text-neutral-500 dark:text-neutral-400">
              <th class="py-2 pr-3 font-medium">#</th>
              <th class="py-2 pr-3 font-medium">标题</th>
              <th class="py-2 pr-3 font-medium">评分</th>
              <th class="py-2 pr-3 font-medium">稀有词密度</th>
              <th class="py-2 font-medium">独特稀有词</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(item, idx) in items.items.slice(0, 30)"
              :key="item.pageId"
              class="border-b border-neutral-100 dark:border-neutral-800"
            >
              <td class="py-2 pr-3 text-neutral-400">{{ idx + 1 }}</td>
              <td class="py-2 pr-3 font-medium text-neutral-800 dark:text-neutral-200 max-w-xs truncate">{{ item.title }}</td>
              <td class="py-2 pr-3 text-neutral-600 dark:text-neutral-400">{{ item.rating }}</td>
              <td class="py-2 pr-3 text-[var(--g-accent)]">{{ (item.rareWordDensity * 100).toFixed(1) }}%</td>
              <td class="py-2 text-neutral-600 dark:text-neutral-400">{{ item.uniqueRareWords }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import type { CreativityEntry } from '~/types/text-analysis'

const creativityRankingEndpoint: string = '/api/text-analysis/creativity-ranking'

const { data: items, pending } = useAsyncData<{ items: CreativityEntry[]; total: number }>(
  'text-analysis-creativity',
  () => $fetch<{ items: CreativityEntry[]; total: number }>(creativityRankingEndpoint, {
    params: { limit: 100 }
  })
)

const canvasEl = ref<HTMLCanvasElement | null>(null)
let chart: any = null

function isDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

function render() {
  if (!canvasEl.value || !items.value?.items?.length) return
  import('chart.js/auto').then((mod: any) => {
    const Chart = mod?.default || mod?.Chart
    if (!Chart) return
    if (chart) chart.destroy()

    const top20 = items.value!.items.slice(0, 20)
    const textColor = isDark() ? '#e5e5e5' : '#262626'
    const gridColor = isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'

    chart = new Chart(canvasEl.value!, {
      type: 'bar',
      data: {
        labels: top20.map(d => d.title.length > 12 ? d.title.slice(0, 12) + '…' : d.title),
        datasets: [{
          label: '稀有词密度 (%)',
          data: top20.map(d => d.rareWordDensity * 100),
          backgroundColor: '#8b5cf6cc',
          borderColor: '#8b5cf6',
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: { grid: { color: gridColor }, ticks: { color: textColor }, title: { display: true, text: '稀有词密度 (%)', color: textColor } },
          y: { grid: { color: gridColor }, ticks: { color: textColor, font: { size: 10 } } }
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
