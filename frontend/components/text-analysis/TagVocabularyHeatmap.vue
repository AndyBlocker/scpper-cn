<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-neutral-900">
    <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-200 mb-1">标签 × 词汇热力图</h2>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
      卡方统计量热力图（log 尺度），展示哪些词与哪些标签强相关。颜色越亮表示该词在该标签下出现远超随机预期。
    </p>
    <div v-if="pending" class="h-72 flex items-center justify-center text-neutral-400">加载中...</div>
    <div v-else-if="!heatData?.tags?.length" class="h-72 flex items-center justify-center text-neutral-400">暂无数据</div>
    <div v-show="heatData?.tags?.length && !pending" class="overflow-x-auto">
      <canvas ref="canvasEl" :width="canvasWidth" :height="canvasHeight"></canvas>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, computed, nextTick } from 'vue'
import type { TagVocabHeatmapData } from '~/types/text-analysis'

const tagVocabularyHeatmapEndpoint: string = '/api/text-analysis/tag-vocabulary-heatmap'

const { data: heatData, pending } = useAsyncData<TagVocabHeatmapData>(
  'text-analysis-tag-heatmap',
  () => $fetch<TagVocabHeatmapData>(tagVocabularyHeatmapEndpoint)
)

const canvasEl = ref<HTMLCanvasElement | null>(null)
const CELL = 34
const LABEL_LEFT = 100
const LABEL_TOP = 90

const canvasWidth = computed(() => LABEL_LEFT + (heatData.value?.words?.length ?? 0) * CELL + 80)
const canvasHeight = computed(() => LABEL_TOP + (heatData.value?.tags?.length ?? 0) * CELL + 20)

function isDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

// Viridis-inspired colormap: dark purple → teal → yellow
function viridis(t: number): string {
  // t in [0, 1]
  const clamped = Math.max(0, Math.min(1, t))
  // Key stops: (0: #440154) (0.25: #31688e) (0.5: #35b779) (0.75: #90d743) (1.0: #fde725)
  let r: number, g: number, b: number
  if (clamped < 0.25) {
    const s = clamped / 0.25
    r = 68 + s * (49 - 68)
    g = 1 + s * (104 - 1)
    b = 84 + s * (142 - 84)
  } else if (clamped < 0.5) {
    const s = (clamped - 0.25) / 0.25
    r = 49 + s * (53 - 49)
    g = 104 + s * (183 - 104)
    b = 142 + s * (121 - 142)
  } else if (clamped < 0.75) {
    const s = (clamped - 0.5) / 0.25
    r = 53 + s * (144 - 53)
    g = 183 + s * (215 - 183)
    b = 121 + s * (67 - 121)
  } else {
    const s = (clamped - 0.75) / 0.25
    r = 144 + s * (253 - 144)
    g = 215 + s * (231 - 215)
    b = 67 + s * (37 - 67)
  }
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`
}

function render() {
  const canvas = canvasEl.value
  if (!canvas || !heatData.value?.matrix?.length) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return

  const { tags, words, matrix } = heatData.value
  const dark = isDark()
  const textColor = dark ? '#e5e5e5' : '#262626'
  const bgColor = dark ? '#171717' : '#ffffff'

  // Log-scale normalization: log(1 + value)
  let maxLog = 0
  const logMatrix: number[][] = []
  for (const row of matrix) {
    const logRow: number[] = []
    for (const v of row) {
      const lv = Math.log1p(v) // log(1 + v)
      if (lv > maxLog) maxLog = lv
      logRow.push(lv)
    }
    logMatrix.push(logRow)
  }
  if (maxLog === 0) maxLog = 1

  // Set canvas DPI for retina
  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1
  const w = canvas.width
  const h = canvas.height
  canvas.width = w * dpr
  canvas.height = h * dpr
  canvas.style.width = w + 'px'
  canvas.style.height = h + 'px'
  ctx.scale(dpr, dpr)

  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, w, h)

  // Draw cells
  for (let ti = 0; ti < tags.length; ti++) {
    for (let wi = 0; wi < words.length; wi++) {
      const norm = logMatrix[ti]?.[wi] ? logMatrix[ti][wi] / maxLog : 0
      ctx.fillStyle = norm === 0 ? (dark ? '#262626' : '#f5f5f5') : viridis(norm)
      ctx.fillRect(LABEL_LEFT + wi * CELL, LABEL_TOP + ti * CELL, CELL - 2, CELL - 2)
    }
  }

  // Draw tag labels (left)
  ctx.fillStyle = textColor
  ctx.font = '11px system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.textBaseline = 'middle'
  for (let ti = 0; ti < tags.length; ti++) {
    ctx.fillText(tags[ti], LABEL_LEFT - 6, LABEL_TOP + ti * CELL + CELL / 2)
  }

  // Draw word labels (top, rotated 45°)
  ctx.font = '11px system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'bottom'
  for (let wi = 0; wi < words.length; wi++) {
    ctx.save()
    ctx.translate(LABEL_LEFT + wi * CELL + CELL / 2, LABEL_TOP - 6)
    ctx.rotate(-Math.PI / 4)
    ctx.fillStyle = textColor
    ctx.fillText(words[wi], 0, 0)
    ctx.restore()
  }

  // Color bar legend (log scale)
  const barX = LABEL_LEFT + words.length * CELL + 20
  const barH = tags.length * CELL
  for (let i = 0; i < barH; i++) {
    ctx.fillStyle = viridis(1 - i / barH)
    ctx.fillRect(barX, LABEL_TOP + i, 16, 1)
  }

  // Bar labels - show actual (non-log) values at key points
  ctx.fillStyle = textColor
  ctx.font = '9px system-ui, sans-serif'
  ctx.textAlign = 'left'

  // Max value
  const maxOrig = Math.max(...matrix.flat())
  ctx.fillText(formatNum(maxOrig), barX + 20, LABEL_TOP + 6)
  // Mid value (in log space → real value)
  const midLog = maxLog / 2
  const midOrig = Math.expm1(midLog)
  ctx.fillText(formatNum(midOrig), barX + 20, LABEL_TOP + barH / 2 + 3)
  // Zero
  ctx.fillText('0', barX + 20, LABEL_TOP + barH - 2)

  // Legend title
  ctx.save()
  ctx.translate(barX + 48, LABEL_TOP + barH / 2)
  ctx.rotate(-Math.PI / 2)
  ctx.textAlign = 'center'
  ctx.font = '9px system-ui, sans-serif'
  ctx.fillText('χ² (log scale)', 0, 0)
  ctx.restore()
}

function formatNum(n: number): string {
  if (n >= 10000) return (n / 1000).toFixed(0) + 'K'
  if (n >= 100) return n.toFixed(0)
  if (n >= 1) return n.toFixed(1)
  return n.toFixed(2)
}

let observer: MutationObserver | null = null

onMounted(() => {
  if (heatData.value?.tags?.length) nextTick(render)
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => { if (heatData.value?.tags?.length) render() })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
})

onBeforeUnmount(() => {
  if (observer) { observer.disconnect(); observer = null }
})

watch(() => heatData.value, () => { nextTick(render) }, { deep: true })
</script>
