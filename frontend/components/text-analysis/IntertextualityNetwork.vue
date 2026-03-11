<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-neutral-900">
    <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-200 mb-1">互文网络</h2>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mb-4">节点=页面（大小=评分），边=共享词汇 Jaccard 相似度，颜色=评分等级</p>
    <div v-if="pending" class="h-96 flex items-center justify-center text-neutral-400">加载中...</div>
    <div v-else-if="!netData?.nodes?.length" class="h-96 flex items-center justify-center text-neutral-400">暂无数据</div>
    <div v-show="netData?.nodes?.length && !pending" ref="containerEl" class="relative w-full rounded-lg overflow-hidden" style="height: clamp(400px, 50vh, 600px)">
      <div ref="sigmaEl" class="absolute inset-0"></div>
      <div
        v-if="hoveredTitle"
        class="absolute z-10 px-3 py-2 rounded-lg bg-white/95 dark:bg-neutral-800/95 shadow-lg border border-neutral-200 dark:border-neutral-700 text-xs pointer-events-none"
        :style="{ left: tooltipPos.x + 'px', top: tooltipPos.y + 'px' }"
      >
        <div class="font-medium text-neutral-800 dark:text-neutral-200">{{ hoveredTitle }}</div>
        <div class="text-neutral-500">评分: {{ hoveredRating }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import type { IntertextualityData } from '~/types/text-analysis'

const intertextualityEndpoint: string = '/api/text-analysis/intertextuality-network'

const { data: netData, pending } = useAsyncData<IntertextualityData>(
  'text-analysis-intertextuality',
  () => $fetch<IntertextualityData>(intertextualityEndpoint)
)

const sigmaEl = ref<HTMLElement | null>(null)
const containerEl = ref<HTMLElement | null>(null)
const hoveredTitle = ref<string | null>(null)
const hoveredRating = ref(0)
const tooltipPos = ref({ x: 0, y: 0 })

let sigmaInstance: any = null

function isDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

function ratingColor(r: number): string {
  if (r >= 50) return '#10b981'
  if (r >= 20) return '#3b82f6'
  if (r >= 0) return '#f59e0b'
  return '#ef4444'
}

async function render() {
  if (!sigmaEl.value || !netData.value?.nodes?.length) return
  if (sigmaInstance) { sigmaInstance.kill(); sigmaInstance = null }

  try {
    const [graphologyMod, sigmaMod, fa2Mod] = await Promise.all([
      import('graphology'),
      import('sigma'),
      import('graphology-layout-forceatlas2')
    ])

    const Graph = graphologyMod.default
    const Sigma = sigmaMod.default || sigmaMod.Sigma
    const fa2 = fa2Mod.default || fa2Mod

    const graph = new Graph()
    const nodeMap = new Map<number, { title: string; rating: number }>()

    for (const node of netData.value!.nodes) {
      nodeMap.set(node.id, node)
      graph.addNode(String(node.id), {
        label: node.title.length > 15 ? node.title.slice(0, 15) + '…' : node.title,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: Math.max(3, Math.sqrt(Math.max(0, node.rating)) * 1.2),
        color: ratingColor(node.rating)
      })
    }

    for (const edge of netData.value!.edges) {
      const src = String(edge.source)
      const tgt = String(edge.target)
      if (graph.hasNode(src) && graph.hasNode(tgt) && !graph.hasEdge(src, tgt)) {
        graph.addEdge(src, tgt, { weight: edge.jaccard, size: edge.jaccard * 4 })
      }
    }

    // Synchronous FA2 layout
    fa2.assign(graph, { iterations: 100, settings: { gravity: 1, scalingRatio: 8, barnesHutOptimize: true } })

    sigmaInstance = new Sigma(graph, sigmaEl.value!, {
      renderEdgeLabels: false,
      labelColor: { color: isDark() ? '#e5e5e5' : '#262626' },
      defaultEdgeColor: isDark() ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)'
    })

    sigmaInstance.on('enterNode', ({ node }: any) => {
      const id = parseInt(node)
      const nd = nodeMap.get(id)
      hoveredTitle.value = nd?.title || null
      hoveredRating.value = nd?.rating ?? 0
      const pos = sigmaInstance.getNodeDisplayData(node)
      if (pos) tooltipPos.value = { x: pos.x + 10, y: pos.y - 10 }
    })
    sigmaInstance.on('leaveNode', () => { hoveredTitle.value = null })
  } catch (err) {
    console.warn('Intertextuality network render failed:', err)
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
