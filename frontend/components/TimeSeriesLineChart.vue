<template>
  <div class="w-full">
    <div v-if="!labels || labels.length === 0" class="h-64 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
      暂无数据
    </div>
    <canvas v-else ref="canvasEl" class="w-full" :style="canvasStyle"></canvas>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
import { useNuxtApp } from 'nuxt/app'

type Dataset = {
  label: string
  data: number[]
  color: string
  fill?: boolean
  type?: 'line' | 'bar'
  yAxisID?: 'y' | 'y1'
}

const props = defineProps<{
  labels: string[]
  datasets: Dataset[]
  yTitle?: string
  title?: string
}>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
let chart: any = null

function isDark(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

function readCssColor(varName: string, fallback: string, alpha?: number): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') return fallback
  const style = getComputedStyle(document.documentElement)
  const raw = style.getPropertyValue(varName).trim()
  if (!raw) return fallback
  const parts = raw.split(/\s+/).map((segment) => Number(segment))
  if (parts.length < 3 || parts.some((value) => Number.isNaN(value))) return fallback
  if (typeof alpha === 'number') {
    return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`
  }
  return `rgb(${parts[0]}, ${parts[1]}, ${parts[2]})`
}

const canvasStyle = computed(() => ({ height: 'clamp(200px, 34vh, 340px)' }))

function buildConfig() {
  const { labels, datasets, yTitle, title } = props
  const ds = datasets.map(d => ({
    type: d.type || 'line',
    label: d.label,
    data: d.data,
    borderColor: d.color,
    backgroundColor: d.color + '33',
    pointRadius: 0,
    tension: 0.25,
    fill: d.fill ?? false,
    borderWidth: 2,
    yAxisID: d.yAxisID || 'y'
  }))

  const gridVar = isDark() ? '--chart-grid-dark' : '--chart-grid-light'
  const gridColor = readCssColor(gridVar, isDark() ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', 0.08)
  const textColor = readCssColor('--muted', isDark() ? '#e5e5e5' : '#262626')

  return {
    type: 'line',
    data: { labels, datasets: ds },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        title: title ? { display: true, text: title, color: textColor, font: { weight: 'bold' } } : { display: false },
        legend: { labels: { color: textColor } },
        tooltip: { enabled: true }
      },
      scales: {
        x: {
          grid: { color: gridColor },
          ticks: { color: textColor }
        },
        y: {
          grid: { color: gridColor },
          ticks: { color: textColor },
          title: yTitle ? { display: true, text: yTitle, color: textColor } : undefined,
          beginAtZero: true
        },
        y1: {
          grid: { color: gridColor, drawOnChartArea: false },
          ticks: { color: textColor },
          beginAtZero: true,
          position: 'right'
        }
      }
    }
  } as any
}

function render() {
  if (!canvasEl.value) return
  // dynamic import to avoid SSR issues
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  import('chart.js/auto').then((mod: any) => {
    const ChartCtor = mod?.default || mod?.Chart
    if (!ChartCtor) return
    if (chart) { chart.destroy() }
    chart = new ChartCtor(canvasEl.value!, buildConfig())
  })
}

let themeObserver: MutationObserver | null = null

onMounted(() => {
  render()
  if (typeof MutationObserver !== 'undefined') {
    themeObserver = new MutationObserver(() => { render() })
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
})

onBeforeUnmount(() => {
  if (chart) { chart.destroy(); chart = null }
  if (themeObserver) { themeObserver.disconnect(); themeObserver = null }
})

watch(() => [props.labels, props.datasets, props.title, props.yTitle], () => {
  if (!chart) { render(); return }
  const cfg = buildConfig()
  chart.data = cfg.data
  chart.options = cfg.options
  chart.update()
}, { deep: true })
</script>

<style scoped>
</style>
