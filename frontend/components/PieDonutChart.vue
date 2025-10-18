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

const props = defineProps<{
  labels: string[]
  values: number[]
  colors: string[]
  title?: string
}>()

const canvasEl = ref<HTMLCanvasElement | null>(null)
let chart: any = null

function isDark(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

const canvasStyle = computed(() => ({ height: 'clamp(200px, 34vh, 340px)' }))

function buildConfig() {
  const textColor = isDark() ? '#e5e5e5' : '#262626'
  return {
    type: 'doughnut',
    data: {
      labels: props.labels,
      datasets: [{
        data: props.values,
        backgroundColor: props.colors.map(c => c + 'dd'),
        borderColor: props.colors,
        borderWidth: 1,
        hoverOffset: 8
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '60%',
      plugins: {
        title: props.title ? { display: true, text: props.title, color: textColor, font: { weight: 'bold' } } : { display: false },
        legend: { labels: { color: textColor } },
        tooltip: { enabled: true }
      }
    }
  } as any
}

function render() {
  if (!canvasEl.value) return
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
onBeforeUnmount(() => { if (chart) { chart.destroy(); chart = null } if (themeObserver) { themeObserver.disconnect(); themeObserver = null } })

watch(() => [props.labels, props.values, props.colors, props.title], () => {
  if (!chart) { render(); return }
  const cfg = buildConfig()
  chart.data = cfg.data
  chart.options = cfg.options
  chart.update()
}, { deep: true })
</script>

<style scoped>
</style>
