<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-xl p-4 sm:p-6 bg-white dark:bg-neutral-900">
    <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-200 mb-1">作者相似度网络</h2>
    <p class="text-xs text-neutral-500 dark:text-neutral-400 mb-4">节点=作者（大小=作品数），边=词汇余弦相似度，力导向布局</p>
    <div v-if="pending" class="h-96 flex items-center justify-center text-neutral-400">加载中...</div>
    <div v-else-if="!netData?.nodes?.length" class="h-96 flex items-center justify-center text-neutral-400">暂无数据</div>
    <div v-show="netData?.nodes?.length && !pending" ref="containerEl" class="relative w-full rounded-lg overflow-hidden" style="height: clamp(400px, 50vh, 600px)">
      <div ref="sigmaEl" class="absolute inset-0"></div>
      <div
        v-if="hoveredNode"
        class="absolute z-10 px-3 py-2 rounded-lg bg-white/95 dark:bg-neutral-800/95 shadow-lg border border-neutral-200 dark:border-neutral-700 text-xs pointer-events-none"
        :style="{ left: tooltipPos.x + 'px', top: tooltipPos.y + 'px' }"
      >
        <div class="font-medium text-neutral-800 dark:text-neutral-200">{{ hoveredNode.displayName }}</div>
        <div class="text-neutral-500">{{ hoveredNode.pageCount }} 篇作品</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import type { AuthorSimilarityData, AuthorSimilarityNode } from '~/types/text-analysis'

const { data: netData, pending } = useAsyncData<AuthorSimilarityData>(
  'text-analysis-author-similarity',
  () => $fetch('/api/text-analysis/author-similarity')
)

const sigmaEl = ref<HTMLElement | null>(null)
const containerEl = ref<HTMLElement | null>(null)
const hoveredNode = ref<AuthorSimilarityNode | null>(null)
const tooltipPos = ref({ x: 0, y: 0 })

let sigmaInstance: any = null

function isDark() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

const PALETTE = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316']

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
    const nodeMap = new Map<number, AuthorSimilarityNode>()

    for (const node of netData.value!.nodes) {
      nodeMap.set(node.id, node)
      graph.addNode(String(node.id), {
        label: node.displayName,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: Math.max(4, Math.sqrt(node.pageCount) * 2),
        color: PALETTE[node.id % PALETTE.length]
      })
    }

    for (const edge of netData.value!.edges) {
      const src = String(edge.source)
      const tgt = String(edge.target)
      if (graph.hasNode(src) && graph.hasNode(tgt) && !graph.hasEdge(src, tgt)) {
        graph.addEdge(src, tgt, { weight: edge.similarity, size: edge.similarity * 3 })
      }
    }

    // Synchronous FA2 layout (fine for <100 nodes)
    fa2.assign(graph, { iterations: 100, settings: { gravity: 1, scalingRatio: 10, barnesHutOptimize: true } })

    sigmaInstance = new Sigma(graph, sigmaEl.value!, {
      renderEdgeLabels: false,
      labelColor: { color: isDark() ? '#e5e5e5' : '#262626' },
      defaultEdgeColor: isDark() ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'
    })

    sigmaInstance.on('enterNode', ({ node }: any) => {
      const id = parseInt(node)
      hoveredNode.value = nodeMap.get(id) || null
      const pos = sigmaInstance.getNodeDisplayData(node)
      if (pos) tooltipPos.value = { x: pos.x + 10, y: pos.y - 10 }
    })
    sigmaInstance.on('leaveNode', () => { hoveredNode.value = null })
  } catch (err) {
    console.warn('Author similarity network render failed:', err)
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
