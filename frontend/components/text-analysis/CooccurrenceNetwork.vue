<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-neutral-900">
    <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-200 mb-1">词汇共现网络</h2>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mb-4">高频词的共现关系网络，社区检测着色</p>
    <div v-if="pending" class="h-96 flex items-center justify-center text-neutral-400">加载中...</div>
    <div v-else-if="!netData?.nodes?.length" class="h-96 flex items-center justify-center text-neutral-400">暂无数据</div>
    <div v-show="netData?.nodes?.length && !pending" ref="containerEl" class="relative w-full rounded-lg overflow-hidden" style="height: clamp(400px, 50vh, 600px)">
      <div ref="sigmaEl" class="absolute inset-0"></div>
      <div
        v-if="hoveredWord"
        class="absolute z-10 px-3 py-2 rounded-lg bg-white/95 dark:bg-neutral-800/95 shadow-lg border border-neutral-200 dark:border-neutral-700 text-xs pointer-events-none"
        :style="{ left: tooltipPos.x + 'px', top: tooltipPos.y + 'px' }"
      >
        <div class="font-medium text-neutral-800 dark:text-neutral-200">{{ hoveredWord }}</div>
        <div class="text-neutral-500">词频: {{ hoveredFreq }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import type { CooccurrenceData } from '~/types/text-analysis'

const { data: netData, pending } = useAsyncData<CooccurrenceData>(
  'text-analysis-cooccurrence',
  () => $fetch('/api/text-analysis/cooccurrence-network')
)

const sigmaEl = ref<HTMLElement | null>(null)
const containerEl = ref<HTMLElement | null>(null)
const hoveredWord = ref<string | null>(null)
const hoveredFreq = ref(0)
const tooltipPos = ref({ x: 0, y: 0 })

let sigmaInstance: any = null

function isDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

const COMMUNITY_COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#a855f7']

async function render() {
  if (!sigmaEl.value || !netData.value?.nodes?.length) return
  if (sigmaInstance) { sigmaInstance.kill(); sigmaInstance = null }

  try {
    const [graphologyMod, sigmaMod, fa2Mod] = await Promise.all([
      import('graphology'),
      import('sigma'),
      import('graphology-layout-forceatlas2')
    ])

    const Graph = graphologyMod.default || graphologyMod.Graph
    const Sigma = sigmaMod.default || sigmaMod.Sigma
    const fa2 = fa2Mod.default || fa2Mod

    const graph = new Graph()

    for (const node of netData.value!.nodes) {
      graph.addNode(node.id, {
        label: node.id,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: Math.max(3, Math.sqrt(node.freq) * 0.3),
        color: COMMUNITY_COLORS[node.community % COMMUNITY_COLORS.length]
      })
    }

    for (const edge of netData.value!.edges) {
      if (graph.hasNode(edge.source) && graph.hasNode(edge.target) && !graph.hasEdge(edge.source, edge.target)) {
        graph.addEdge(edge.source, edge.target, { weight: edge.weight, size: Math.max(0.5, edge.weight * 0.5) })
      }
    }

    // Synchronous FA2 layout
    fa2.assign(graph, { iterations: 100, settings: { gravity: 1, scalingRatio: 5, barnesHutOptimize: true } })

    sigmaInstance = new Sigma(graph, sigmaEl.value!, {
      renderEdgeLabels: false,
      labelColor: { color: isDark() ? '#e5e5e5' : '#262626' },
      defaultEdgeColor: isDark() ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'
    })

    sigmaInstance.on('enterNode', ({ node }: any) => {
      hoveredWord.value = node
      const nd = netData.value!.nodes.find(n => n.id === node)
      hoveredFreq.value = nd?.freq ?? 0
      const pos = sigmaInstance.getNodeDisplayData(node)
      if (pos) tooltipPos.value = { x: pos.x + 10, y: pos.y - 10 }
    })
    sigmaInstance.on('leaveNode', () => { hoveredWord.value = null })
  } catch (err) {
    console.warn('Cooccurrence network render failed:', err)
  }
}

let observer: MutationObserver | null = null
onMounted(() => {
  if (netData.value?.nodes?.length) nextTick(render)
  if (typeof MutationObserver !== 'undefined') {
    observer = new MutationObserver(() => { if (netData.value?.nodes?.length) render() })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  }
})
onBeforeUnmount(() => {
  if (sigmaInstance) { sigmaInstance.kill(); sigmaInstance = null }
  if (observer) { observer.disconnect(); observer = null }
})
watch(() => netData.value, () => { nextTick(render) }, { deep: true })
</script>
