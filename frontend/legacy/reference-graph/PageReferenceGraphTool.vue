<!-- pages/references/graph.vue -->
<template>
  <div class="max-w-6xl mx-auto w-full py-12 space-y-10">
    <!-- 顶部说明 -->
    <section class="space-y-3 text-center sm:text-left">
      <div class="inline-flex items-center gap-2 rounded-full border border-[rgba(var(--accent),0.35)] bg-[rgba(var(--accent),0.08)] px-4 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--accent))]">
        <span>引用网络</span>
      </div>
      <div class="space-y-2">
        <h1 class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50 sm:text-4xl">页面引用关系分析</h1>
        <p class="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
          基于 PageReference 快照，探索“被引用/引用他人”分布与全站引用网络。可在力导与层次布局间切换，支持视角节点 + K 层邻域、度/权重阈值等过滤。
        </p>
      </div>
      <div v-if="lastUpdated" class="text-xs text-neutral-500 dark:text-neutral-400">
        最新快照时间：{{ lastUpdated }}
      </div>
    </section>

    <!-- 错误提示 -->
    <section v-if="error" class="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-600 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-200">
      无法加载引用快照：{{ error }}
    </section>

    <section v-else class="space-y-6">
      <!-- 加载中 -->
      <div v-if="loading" class="flex items-center justify-center rounded-2xl border border-neutral-200 bg-white/90 p-10 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
        正在加载引用统计…
      </div>

      <!-- 排名表 -->
      <template v-else-if="snapshot">
        <div class="grid gap-6 lg:grid-cols-2">
          <div class="rounded-2xl border border-neutral-200 bg-white/90 p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <header class="mb-4 space-y-1">
              <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">被引用次数 Top {{ topSize }}</h2>
              <p class="text-xs text-neutral-500 dark:text-neutral-400">发现全站“热点中心”。</p>
            </header>
            <ReferenceRankingTable :rows="snapshot.data.topInbound" empty-text="暂无引用数据" />
          </div>

          <div class="rounded-2xl border border-neutral-200 bg-white/90 p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <header class="mb-4 space-y-1">
              <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">引用他人次数 Top {{ topSize }}</h2>
              <p class="text-xs text-neutral-500 dark:text-neutral-400">定位整理性/导航性页面。</p>
            </header>
            <ReferenceRankingTable :rows="snapshot.data.topOutbound" empty-text="暂无引用数据" />
          </div>
        </div>

        <!-- 图可视化 -->
        <div class="rounded-2xl border border-neutral-200 bg-white/90 p-6 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div class="space-y-2">
              <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">引用网络图谱（WebGL）</h2>
              <p class="text-xs text-neutral-500 dark:text-neutral-400">
                总节点 {{ totalNodeCount }}，边 {{ totalEdgeCount }}；选中节点将高亮其 1 跳邻居，支持按视角节点 + 层级筛选。
              </p>
            </div>
            <div class="flex gap-2 flex-wrap">
              <button
                v-if="!graphReady"
                :disabled="graphBooting"
                @click="bootGraph"
                class="inline-flex items-center gap-2 rounded-full bg-[rgb(var(--accent))] px-4 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:bg-[rgba(var(--accent),0.5)]"
              >
                <span v-if="graphBooting">初始化中…</span>
                <span v-else>开始加载可视化</span>
              </button>

              <template v-else>
                <select
                  v-model="layoutMode"
                  class="rounded-full border border-neutral-300 bg-white px-3 py-2 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                  @change="applyLayout"
                >
                  <option value="fa2">力导（FA2-Worker）</option>
                  <option value="layered">层次（ELK）</option>
                </select>
                <button
                  class="inline-flex items-center gap-2 rounded-full border border-neutral-300 px-4 py-2 text-xs text-neutral-600 transition hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-500"
                  @click="restartLayout"
                >
                  重新布局
                </button>
                <button
                  class="inline-flex items-center gap-2 rounded-full border border-neutral-300 px-4 py-2 text-xs text-neutral-600 transition hover:border-neutral-400 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-neutral-500"
                  @click="exportPNG"
                >
                  导出 PNG
                </button>
              </template>
            </div>
          </div>

          <!-- 控制条 -->
          <div
            v-if="graphReady"
            class="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-neutral-200 bg-white/60 px-4 py-3 text-xs text-neutral-600 dark:border-neutral-800 dark:bg-neutral-950/40 dark:text-neutral-300"
          >
            <!-- 搜索 -->
            <label class="flex items-center gap-2">
              <span class="whitespace-nowrap">搜索</span>
              <input v-model.trim="searchQuery" @input="onSearchInput" placeholder="标题包含…" class="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900" />
            </label>

            <!-- 视角 -->
            <label class="flex items-center gap-2">
              <span class="whitespace-nowrap">视角节点</span>
              <select v-model="viewpointSelection" class="rounded-md border border-neutral-300 bg-white px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900">
                <option value="all">全部</option>
                <option v-for="o in viewpointOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
              </select>
            </label>
            <label class="flex items-center gap-2">
              <span class="whitespace-nowrap">层级</span>
              <input v-model.number="viewpointDepth" type="range" min="1" max="4" step="1" class="h-1 w-28 accent-[rgb(var(--accent))]" />
              <span class="font-semibold text-neutral-700 dark:text-neutral-200">{{ viewpointDepth }}</span>
            </label>
            <button type="button" class="rounded-full bg-[rgb(var(--accent))] px-3 py-1.5 text-xs font-semibold text-white" @click="applyViewpoint">
              应用视角
            </button>
            <button v-if="isViewpointActive" type="button" class="rounded-full border border-neutral-300 px-3 py-1.5 text-xs" @click="clearViewpoint">
              清除视角
            </button>

            <!-- 阈值 -->
            <label class="flex items-center gap-2">
              <span class="whitespace-nowrap">最小度</span>
              <input v-model.number="minDegree" type="range" min="0" :max="degreeMax" step="1" class="h-1 w-28 accent-[rgb(var(--accent))]" @input="onFilterInput" />
              <span class="font-semibold">{{ minDegree }}</span>
            </label>
            <label class="flex items-center gap-2">
              <span class="whitespace-nowrap">最小权重</span>
              <input v-model.number="minWeight" type="range" min="0" :max="weightMax" step="1" class="h-1 w-28 accent-[rgb(var(--accent))]" @input="onFilterInput" />
              <span class="font-semibold">{{ minWeight }}</span>
            </label>

            <!-- 着色/过滤 -->
            <label class="flex items-center gap-2">
              <input type="checkbox" v-model="colorByCommunity" @change="recolorByCommunity" />
              <span>社区着色（Louvain）</span>
            </label>
            <label class="flex items-center gap-2">
              <input type="checkbox" v-model="onlyGiantComponent" @change="computeGiantComponent" />
              <span>仅最大连通分量</span>
            </label>

            <span class="ml-auto hidden text-[11px] text-neutral-400 dark:text-neutral-500 sm:inline">
              提示：滚轮缩放，拖动画布；点击节点高亮邻居；缩小时自动隐藏连线与标签。
            </span>
          </div>

          <!-- 画布 -->
          <div class="mt-6 rounded-xl border border-dashed border-neutral-200 bg-white/70 dark:border-neutral-800 dark:bg-neutral-950/50">
            <ClientOnly>
              <div ref="sigmaContainer" :style="{height: graphHeight + 'px'}" class="w-full min-w-0 relative"></div>
              <template #fallback>
                <div class="flex h-64 items-center justify-center text-sm text-neutral-500 dark:text-neutral-400">客户端渲染图谱中…</div>
              </template>
            </ClientOnly>
            <div v-if="graphReady" class="mt-4 grid gap-2 text-xs text-neutral-500 dark:text-neutral-400 sm:grid-cols-3 p-4">
              <div>节点数：{{ totalNodeCount }}</div>
              <div>边数：{{ totalEdgeCount }}</div>
              <div v-if="isViewpointActive">视角：#{{ activeViewpoint }}（层级 {{ activeDepth }}）</div>
            </div>
          </div>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, defineComponent, h, nextTick, onBeforeUnmount, onMounted, ref, resolveComponent } from 'vue'
import type { PropType } from 'vue'
import { format } from 'date-fns'
import { useNuxtApp } from 'nuxt/app'

/* ------------------------ 类型与服务 ------------------------ */
interface RankingRow {
  rank: number
  wikidotId: number
  pageId: number
  title: string
  url: string
  inbound: number
  outbound: number
}
interface SnapshotGraphNode {
  wikidotId: number
  pageId: number
  title: string
  url: string
  inbound: number
  outbound: number
}
interface SnapshotGraphEdge {
  source: number
  target: number
  weight: number
}
interface SnapshotData {
  generatedAt: string
  parameters: { top: number; maxNodes: number; maxEdges: number; storedFullGraph?: boolean }
  totals: { pages: number; edges: number }
  topInbound: RankingRow[]
  topOutbound: RankingRow[]
  graph: { nodeCount: number; edgeCount: number; maxWeight: number; nodes: SnapshotGraphNode[]; edges: SnapshotGraphEdge[] }
}
interface SnapshotResponse { label: string; description: string | null; generatedAt: string; data: SnapshotData }

const { $bff } = useNuxtApp()

/* ------------------------ 工具：等待容器可见 ------------------------ */
async function waitForVisibleContainer(el: HTMLElement, timeout = 4000) {
  if (!el) throw new Error('sigma container unavailable')
  if (el.offsetWidth > 0 && el.offsetHeight > 0) return
  await new Promise<void>((resolve) => {
    const start = performance.now()
    const supportRO = typeof ResizeObserver !== 'undefined'
    const ro = supportRO ? new ResizeObserver(() => {
      if (el.offsetWidth > 0) {
        ro.disconnect()
        resolve()
      }
    }) : null
    if (ro) ro.observe(el)
    const tick = () => {
      if (el.offsetWidth > 0) {
        if (ro) ro.disconnect()
        resolve()
        return
      }
      if (performance.now() - start > timeout) {
        if (ro) ro.disconnect()
        resolve()
        return
      }
      requestAnimationFrame(tick)
    }
    tick()
  })
}

/* ------------------------ 加载快照 ------------------------ */
const loading = ref(true)
const error = ref<string | null>(null)
const snapshot = ref<SnapshotResponse | null>(null)
async function fetchSnapshot() {
  loading.value = true
  error.value = null
  try {
    snapshot.value = await $bff<SnapshotResponse>('/references/graph')
  } catch (err: any) {
    error.value = err?.message ?? '加载失败'
  } finally {
    loading.value = false
  }
}
onMounted(fetchSnapshot)

/* ------------------------ Graphology + Sigma（按需动态导入，避免 SSR） ------------------------ */
let SigmaConstructor: any
let DirectedGraph: any
let forceAtlas2: any
let FA2Worker: any
let louvainAssign: any
let ELKCtor: any

const sigmaContainer = ref<HTMLElement | null>(null)
const renderer = ref<any>(null)

const baseGraph = ref<any>(null)      // 完整图（含富属性）
const layoutGraph = ref<any>(null)    // 影子图（纯数值，用于 FA2 Worker）
const displayGraph = ref<any>(null)   // 当前展示的子图（setGraph 切换）

const graphReady = ref(false)
const graphBooting = ref(false)
const layoutMode = ref<'fa2' | 'layered'>('fa2')
const fa2Instance = ref<any>(null)
const elkInstance = ref<any>(null)
const graphSwapping = ref(false)      // 切图/大批更新的“交换期”标记

const graphHeight = ref(560)

/* ----------- rAF 队列 & 批处理（避免 repaint 冲突 & 合并事件） ----------- */
const EDGE_SHOW_RATIO = 1.2
let edgesVisible = true
let rebuildTimer: ReturnType<typeof setTimeout> | null = null
let pendingEdgeVis = false

function batchUpdateEdges(g: any, updater: (key: string, attrs: any) => any) {
  if (!g || typeof g.updateEachEdgeAttributes !== 'function') return
  const canBatch = typeof g.startBatch === 'function' && typeof g.endBatch === 'function'
  if (canBatch) g.startBatch()
  try {
    g.updateEachEdgeAttributes(updater)
  } finally {
    if (canBatch) g.endBatch()
  }
}
function batchUpdateNodes(g: any, updater: (key: string, attrs: any) => any) {
  if (!g || typeof g.updateEachNodeAttributes !== 'function') return
  const canBatch = typeof g.startBatch === 'function' && typeof g.endBatch === 'function'
  if (canBatch) g.startBatch()
  try {
    g.updateEachNodeAttributes(updater)
  } finally {
    if (canBatch) g.endBatch()
  }
}
function queueEdgeVisibilityUpdate() {
  if (pendingEdgeVis) return
  pendingEdgeVis = true
  requestAnimationFrame(() => {
    pendingEdgeVis = false
    updateEdgeVisibility()
  })
}

/* ------------------------ 过滤/交互状态 ------------------------ */
const searchQuery = ref('')
const minDegree = ref(0)
const degreeMax = ref(20)
const minWeight = ref(0)
const weightMax = ref(20)
const colorByCommunity = ref(true)
const onlyGiantComponent = ref(false)

const viewpointSelection = ref<number | 'all'>('all')
const viewpointDepth = ref(1)
const activeViewpoint = ref<number | null>(null)
const activeDepth = ref(1)
const isViewpointActive = computed(() => activeViewpoint.value != null)

const hoveredNode = ref<string | null>(null)
const selectedNode = ref<string | null>(null)
const neighborSet = ref<Set<string>>(new Set())

/* ------------------------ 基本统计 ------------------------ */
const totalNodeCount = computed(() =>
  baseGraph.value ? baseGraph.value.order : snapshot.value?.data?.graph?.nodeCount ?? 0
)
const totalEdgeCount = computed(() =>
  baseGraph.value ? baseGraph.value.size : snapshot.value?.data?.graph?.edgeCount ?? 0
)
const topSize = computed(() => snapshot.value?.data?.parameters?.top ?? 10)
const lastUpdated = computed(() => {
  const iso = snapshot.value?.data?.generatedAt || snapshot.value?.generatedAt
  if (!iso) return null
  try { return format(new Date(iso), 'yyyy-MM-dd HH:mm') } catch { return iso }
})

/* ------------------------ 视角选项 ------------------------ */
const viewpointOptions = computed(() => {
  const nodes = snapshot.value?.data?.graph?.nodes ?? []
  return nodes
    .slice()
    .sort((a, b) => (b.inbound + b.outbound) - (a.inbound + a.outbound))
    .slice(0, 400)
    .map(n => ({ value: n.wikidotId, label: `${n.title} (#${n.wikidotId})` }))
})

function scheduleRebuild() {
  if (!graphReady.value || !baseGraph.value) return
  if (rebuildTimer) clearTimeout(rebuildTimer)
  rebuildTimer = setTimeout(() => {
    rebuildDisplayGraph()
    rebuildTimer = null
  }, 200)
}
function onSearchInput() { if (graphReady.value) scheduleRebuild() }
function onFilterInput() { if (graphReady.value) scheduleRebuild() }

/* ------------------------ 构建 display 子图（一次性过滤） ------------------------ */
function rebuildDisplayGraph() {
  if (!baseGraph.value || !DirectedGraph) return
  const g = new DirectedGraph({ allowSelfLoops: false, multi: false })

  // 1) 视角 BFS
  const allowed = new Set<string>()
  if (activeViewpoint.value == null) {
    baseGraph.value.forEachNode((k: string) => allowed.add(k))
  } else {
    const root = String(activeViewpoint.value)
    if (baseGraph.value.hasNode(root)) {
      const queue: Array<{ id: string; depth: number }> = [{ id: root, depth: 0 }]
      allowed.add(root)
      while (queue.length) {
        const cur = queue.shift()!
        if (cur.depth >= activeDepth.value) continue
        baseGraph.value.forEachNeighbor(cur.id, (n: string) => {
          if (!allowed.has(n)) { allowed.add(n); queue.push({ id: n, depth: cur.depth + 1 }) }
        })
      }
    }
  }

  const query = searchQuery.value.trim().toLowerCase()

  // 2) 节点复制（含 x/y/size/label/color）
  baseGraph.value.forEachNode((key: string, attrs: any) => {
    if (!allowed.has(key)) return
    if (query && !String(attrs.label || '').toLowerCase().includes(query)) return
    g.addNode(key, { ...attrs, hidden: false, dim: false })
  })

  // 3) 边复制（加上 s/t 供轻量 reducer 使用）
  baseGraph.value.forEachEdge((_ek: string, ea: any, s: string, t: string) => {
    if (!g.hasNode(s) || !g.hasNode(t)) return
    const w = typeof ea.weight === 'number' ? ea.weight : 0
    if (w < minWeight.value) return
    g.addEdge(s, t, { ...ea, s, t, hidden: false, type: 'line' })
  })

  // 4) 按度阈值再裁一次
  if (minDegree.value > 0) {
    const deg = new Map<string, number>()
    g.forEachNode((k: string) => deg.set(k, 0))
    g.forEachEdge((_ek: string, _ea: any, s: string, t: string) => {
      deg.set(s, (deg.get(s) ?? 0) + 1)
      deg.set(t, (deg.get(t) ?? 0) + 1)
    })
    const drop: string[] = []
    g.forEachNode((k: string) => { if ((deg.get(k) ?? 0) < minDegree.value) drop.push(k) })
    drop.forEach(k => g.dropNode(k))
  }

  // 5) 仅最大分量（弱连通）
  if (onlyGiantComponent.value) {
    const visited = new Set<string>()
    let best: Set<string> = new Set()
    g.forEachNode((u: string) => {
      if (visited.has(u)) return
      const comp = new Set<string>()
      const q = [u]; visited.add(u); comp.add(u)
      while (q.length) {
        const cur = q.shift()!
        g.forEachNeighbor(cur, (n: string) => {
          if (!visited.has(n)) { visited.add(n); comp.add(n); q.push(n) }
        })
      }
      if (comp.size > best.size) best = comp
    })
    const del: string[] = []
    g.forEachNode((k: string) => { if (!best.has(k)) del.push(k) })
    del.forEach(k => g.dropNode(k))
  }

  // 6) 社区着色（子图上重算）
  if (colorByCommunity.value && g.order) {
    try {
      louvainAssign(g, { getEdgeWeight: 'weight' })
      applyCommunityColors(g)
    } catch {}
  }

  displayGraph.value = g

  if (renderer.value) {
    graphSwapping.value = true
    try {
      renderer.value.setGraph(displayGraph.value)
      installLightReducers()
    } finally {
      graphSwapping.value = false
    }
    // 给一帧缓冲再做边显隐，避免 repaint 冲突
    requestAnimationFrame(() => {
      queueEdgeVisibilityUpdate()
      renderer.value!.scheduleRefresh()
    })
  }

  rebuildNeighborSet()
}

/* ------------------------ 极简 reducers（只做置灰） ------------------------ */
function installLightReducers() {
  if (!renderer.value) return
  renderer.value.setSetting('nodeReducer', (key: string, data: any) => {
    if (data.hidden) return data
    const focus = selectedNode.value || hoveredNode.value
    if (!focus) return data
    const dim = !(key === focus || neighborSet.value.has(key))
    return dim ? { ...data, color: 'rgba(160,160,160,0.35)' } : data
  })
  renderer.value.setSetting('edgeReducer', (_key: string, data: any) => {
    if (data.hidden) return data
    const focus = selectedNode.value || hoveredNode.value
    if (!focus) return data
    const dim = !(data.s === focus || data.t === focus || neighborSet.value.has(data.s) || neighborSet.value.has(data.t))
    return dim ? { ...data, color: 'rgba(160,160,160,0.2)' } : data
  })
  renderer.value.scheduleRefresh()
}

/* ------------------------ 边显隐（按缩放，批处理） ------------------------ */
function updateEdgeVisibility() {
  if (graphSwapping.value) return
  if (!renderer.value || !displayGraph.value) return
  const ratio = renderer.value.getCamera().getState().ratio
  const shouldShow = ratio >= EDGE_SHOW_RATIO
  if (shouldShow === edgesVisible) return

  edgesVisible = shouldShow
  graphSwapping.value = true
  try {
    batchUpdateEdges(displayGraph.value, (_k, a) => ({ ...a, hidden: !shouldShow }))
  } finally {
    graphSwapping.value = false
  }
  renderer.value.scheduleRefresh()
}

/* ------------------------ tick 同步坐标（影子 -> base -> display） ------------------------ */
function syncPositionsToAll() {
  if (graphSwapping.value || !layoutGraph.value || !baseGraph.value) return
  batchUpdateNodes(baseGraph.value, (k: string, a: any) => {
    const x = layoutGraph.value!.getNodeAttribute(k, 'x')
    const y = layoutGraph.value!.getNodeAttribute(k, 'y')
    return (typeof x === 'number' && typeof y === 'number') ? { ...a, x, y } : a
  })
  if (displayGraph.value) {
    batchUpdateNodes(displayGraph.value, (k: string, a: any) => {
      if (!baseGraph.value!.hasNode(k)) return a
      const b = baseGraph.value!.getNodeAttributes(k)
      return (typeof b.x === 'number' && typeof b.y === 'number') ? { ...a, x: b.x, y: b.y } : a
    })
  }
  renderer.value?.scheduleRefresh()
}

/* ------------------------ FA2 主线程兜底（小步快跑） ------------------------ */
async function runFA2OnMainThreadBatched() {
  if (!baseGraph.value || !layoutGraph.value) return
  fa2Instance.value = null
  const settings = forceAtlas2.inferSettings(layoutGraph.value)
  const TOTAL = 1000
  const STEP = 50
  for (let done = 0; done < TOTAL; done += STEP) {
    forceAtlas2.assign(layoutGraph.value, { iterations: STEP, settings })
    syncPositionsToAll()
    await new Promise(res => requestAnimationFrame(() => res(null)))
  }
  queueEdgeVisibilityUpdate()
}

/* ------------------------ 初始化 WebGL 图 ------------------------ */
async function bootGraph() {
  if (!snapshot.value) return
  graphBooting.value = true
  try {
    edgesVisible = true

    await nextTick()
    const container = sigmaContainer.value
    if (!container) throw new Error('Sigma container not mounted')
    await waitForVisibleContainer(container)

    // 动态导入依赖（只在客户端）
    const [{ DirectedGraph: DG }, sigmaMod, fa2Mod, fa2WorkerMod, louvainMod, elkBundledMod] = await Promise.all([
      import('graphology'),
      import('sigma'),
      import('graphology-layout-forceatlas2'),
      import('graphology-layout-forceatlas2/worker'),
      import('graphology-communities-louvain'),
      import('elkjs/lib/elk.bundled.js')
    ])
    DirectedGraph = DG
    SigmaConstructor = sigmaMod.default
    forceAtlas2 = fa2Mod.default
    FA2Worker = fa2WorkerMod.default
    louvainAssign = louvainMod.default?.assign ?? louvainMod.default
    ELKCtor = elkBundledMod.default

    // 构建完整图
    const g = new DirectedGraph({ allowSelfLoops: false, multi: false })
    const magnitudes: number[] = []
    for (const n of snapshot.value.data.graph.nodes) {
      const key = String(n.wikidotId)
      const mag = Math.max(0, (n.inbound ?? 0) + (n.outbound ?? 0))
      magnitudes.push(mag)
      g.addNode(key, {
        label: n.title,
        url: n.url,
        inbound: n.inbound,
        outbound: n.outbound,
        size: 6 + Math.sqrt(mag),
        x: Math.random() * 10,
        y: Math.random() * 10,
        color: '#8b8b8b'
      })
    }
    const maxMag = magnitudes.length ? Math.max(...magnitudes) : 1
    degreeMax.value = Math.ceil(Math.sqrt(maxMag)) + 10

    let maxW = 0
    for (const e of snapshot.value.data.graph.edges) {
      if (e.source === e.target) continue
      maxW = Math.max(maxW, e.weight || 0)
      g.addEdge(String(e.source), String(e.target), {
        weight: e.weight || 1,
        size: 1 + (e.weight || 1) / 10,
        type: 'line'
      })
    }
    weightMax.value = Math.max(1, maxW)
    minWeight.value = Math.min(minWeight.value, weightMax.value)

    // Louvain（可关）
    louvainAssign(g, { getEdgeWeight: 'weight' })
    if (colorByCommunity.value) applyCommunityColors(g)

    baseGraph.value = g

    // 影子图：仅数值属性，供 Worker 使用
    const lg = new DirectedGraph({ allowSelfLoops: false, multi: false })
    g.forEachNode((k: string, a: any) => {
      lg.addNode(k, {
        x: typeof a.x === 'number' ? a.x : Math.random() * 10,
        y: typeof a.y === 'number' ? a.y : Math.random() * 10,
        size: typeof a.size === 'number' ? a.size : 1
      })
    })
    g.forEachEdge((_ek: string, ea: any, s: string, t: string) => {
      const w = typeof ea.weight === 'number' ? ea.weight : 1
      if (!lg.hasEdge(s, t)) lg.addEdge(s, t, { weight: w })
    })
    layoutGraph.value = lg

    // 初始 display 子图（此时 renderer 还未创建，仅生成）
    rebuildDisplayGraph()

    // 创建 Sigma 渲染器（WebGL）
    renderer.value = new SigmaConstructor(displayGraph.value || baseGraph.value, container, {
      allowInvalidContainer: true,
      defaultEdgeType: 'line',
      renderEdgeLabels: false,
      labelRenderedSizeThreshold: 12,
      labelDensity: 0.06,
      zIndex: false
    })
    installLightReducers()

    // 交互：hover/选中 -> 高亮邻居
    renderer.value.on('enterNode', ({ node }: any) => { hoveredNode.value = node; rebuildNeighborSet() })
    renderer.value.on('leaveNode', () => { hoveredNode.value = null; rebuildNeighborSet() })
    renderer.value.on('clickNode', ({ node }: any) => { selectedNode.value = node; rebuildNeighborSet() })
    renderer.value.getCamera().on('updated', () => queueEdgeVisibilityUpdate())

    queueEdgeVisibilityUpdate()

    // 初始布局：FA2 Worker（ELK 实例备用）
    elkInstance.value = new ELKCtor()
    await applyLayout()
    syncPositionsToAll()
    rebuildNeighborSet()

    graphReady.value = true
  } catch (e: any) {
    error.value = e?.message ?? '初始化失败'
  } finally {
    graphBooting.value = false
  }
}

function restartLayout() { applyLayout(true) }

async function applyLayout(_restart = false) {
  if (!baseGraph.value || !layoutGraph.value) return
  stopFA2()

  // 同步当前坐标到影子图，确保从最新状态启动
  layoutGraph.value.updateEachNodeAttributes((k: string, a: any) => {
    if (!baseGraph.value?.hasNode(k)) return a
    const b = baseGraph.value.getNodeAttributes(k)
    const x = typeof b.x === 'number' ? b.x : a.x
    const y = typeof b.y === 'number' ? b.y : a.y
    const size = typeof b.size === 'number' ? b.size : a.size
    return { ...a, x, y, size: size ?? 1 }
  })

  if (layoutMode.value === 'fa2') {
    const settings = forceAtlas2.inferSettings(layoutGraph.value)
    try {
      fa2Instance.value = new FA2Worker(layoutGraph.value, {
        settings: {
          ...settings,
          barnesHutOptimize: true,
          slowDown: 2,
          edgeWeightInfluence: 1
        }
      })
      fa2Instance.value.on?.('tick', () => syncPositionsToAll())
      fa2Instance.value.on?.('end', () => syncPositionsToAll())
      fa2Instance.value.start()
    } catch (e: any) {
      const msg = String(e?.name || e?.message || '')
      if (msg.includes('DataCloneError') || msg.includes('could not be cloned')) {
        await runFA2OnMainThreadBatched()
      } else {
        throw e
      }
    }
  } else if (layoutMode.value === 'layered') {
    // ELK：层次布局（右向）
    const elk = elkInstance.value
    const nodes: any[] = []
    const edges: any[] = []
    baseGraph.value.forEachNode((k: string, a: any) => {
      nodes.push({ id: k, width: 20 + a.size * 2, height: 20 + a.size * 2 })
    })
    baseGraph.value.forEachEdge((ek: string, _ea: any, s: string, t: string) => {
      edges.push({ id: ek, sources: [s], targets: [t] })
    })

    const g = {
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.layered.spacing.baseValue': '80',
        'elk.spacing.nodeNode': '40',
        'elk.edgeRouting': 'ORTHOGONAL'
      },
      children: nodes,
      edges
    }
    const res = await elk.layout(g)
    const pos = new Map<string, { x: number; y: number }>()
    for (const n of res.children ?? []) pos.set(n.id, { x: n.x ?? 0, y: n.y ?? 0 })

    batchUpdateNodes(baseGraph.value, (k: string, a: any) => {
      const p = pos.get(k); return p ? { ...a, x: p.x, y: p.y } : a
    })
    batchUpdateNodes(layoutGraph.value, (k: string, a: any) => {
      const p = pos.get(k); return p ? { ...a, x: p.x, y: p.y } : a
    })
  }

  syncPositionsToAll()
  queueEdgeVisibilityUpdate()
}

/* ------------------------ 邻居集合（轻量置灰所需） ------------------------ */
function rebuildNeighborSet() {
  const set = new Set<string>()
  const focus = selectedNode.value || hoveredNode.value
  const g = displayGraph.value
  if (focus && g?.hasNode(focus)) {
    g.forEachNeighbor(focus, (n: string) => set.add(n))
  } else if (focus && !g?.hasNode(focus)) {
    if (selectedNode.value && !g?.hasNode(selectedNode.value)) selectedNode.value = null
    if (hoveredNode.value && !g?.hasNode(hoveredNode.value)) hoveredNode.value = null
  }
  neighborSet.value = set
  renderer.value?.scheduleRefresh()
}

/* ------------------------ 视角/分量切换 ------------------------ */
function applyViewpoint() {
  activeViewpoint.value = viewpointSelection.value === 'all' ? null : Number(viewpointSelection.value)
  activeDepth.value = Math.max(1, viewpointDepth.value)
  if (!graphReady.value || !baseGraph.value) return
  rebuildDisplayGraph()
}
function clearViewpoint() {
  activeViewpoint.value = null
  activeDepth.value = 1
  viewpointSelection.value = 'all'
  viewpointDepth.value = 1
  if (!graphReady.value || !baseGraph.value) return
  rebuildDisplayGraph()
}
function computeGiantComponent() {
  if (!graphReady.value || !baseGraph.value) return
  rebuildDisplayGraph()
}

/* ------------------------ 着色与导出 ------------------------ */
function applyCommunityColors(g: any) {
  const palette = (i: number) => `hsl(${(i * 57) % 360} 70% 45%)`
  const groups = new Map<number, string[]>()
  g.forEachNode((k: string, a: any) => {
    const c = a.community ?? 0
    const arr = groups.get(c) ?? []
    arr.push(k); groups.set(c, arr)
  })
  groups.forEach((nodes, comm) => {
    const color = palette(comm)
    nodes.forEach(n => g.updateNodeAttribute(n, 'color', () => color))
  })
}
function recolorByCommunity() {
  if (!baseGraph.value) return
  if (colorByCommunity.value) {
    try { louvainAssign(baseGraph.value, { getEdgeWeight: 'weight' }); applyCommunityColors(baseGraph.value) } catch {}
  } else {
    baseGraph.value.updateEachNodeAttributes((k: string, a: any) => ({ ...a, color: '#8b8b8b' }))
  }
  if (graphReady.value) rebuildDisplayGraph()
}
function exportPNG() {
  if (!renderer.value) return
  const canvas = (renderer.value as any).getCanvas?.() || (renderer.value as any).canvas
  if (!canvas) return
  const link = document.createElement('a')
  link.download = 'reference-graph.png'
  link.href = canvas.toDataURL('image/png')
  link.click()
}

/* ------------------------ 清理 ------------------------ */
function stopFA2() {
  if (fa2Instance.value) {
    try { fa2Instance.value.stop(); fa2Instance.value.kill() } catch {}
    fa2Instance.value = null
  }
}
onBeforeUnmount(() => {
  stopFA2()
  if (renderer.value) renderer.value.kill?.()
  if (rebuildTimer) { clearTimeout(rebuildTimer); rebuildTimer = null }
})

/* ------------------------ 表格复用 ------------------------ */
const ReferenceRankingTable = defineComponent({
  name: 'ReferenceRankingTable',
  props: {
    rows: { type: Array as PropType<RankingRow[]>, default: () => [] },
    emptyText: { type: String, default: '暂无数据' }
  },
  setup(props) {
    const NuxtLinkComponent = resolveComponent('NuxtLink') as any
    return () => {
      if (!props.rows || props.rows.length === 0) {
        return h('div', { class: 'flex h-40 items-center justify-center text-sm text-neutral-500 dark:text-neutral-400' }, props.emptyText)
      }
      return h('div', { class: 'overflow-x-auto' }, [
        h('table', { class: 'w-full min-w-full divide-y divide-neutral-200 text-sm dark:divide-neutral-800' }, [
          h('thead', null, [
            h('tr', { class: 'text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400' }, [
              h('th', { class: 'py-2 text-left' }, '排名'),
              h('th', { class: 'py-2 text-left' }, '页面'),
              h('th', { class: 'py-2 text-right' }, '被引用'),
              h('th', { class: 'py-2 text-right' }, '引用他人')
            ])
          ]),
          h('tbody', { class: 'divide-y divide-neutral-100 dark:divide-neutral-900' }, props.rows.map(row =>
            h('tr', { key: row.wikidotId, class: 'text-neutral-700 transition hover:bg-neutral-50/70 dark:text-neutral-200 dark:hover:bg-neutral-900/60' }, [
              h('td', { class: 'py-2 pr-3 text-xs font-semibold text-neutral-500 dark:text-neutral-400' }, `#${row.rank}`),
              h('td', { class: 'py-2 pr-3' }, [
                h(NuxtLinkComponent, { to: `/page/${row.wikidotId}`, class: 'break-all text-[rgb(var(--accent))] transition hover:underline' }, () => row.title)
              ]),
              h('td', { class: 'py-2 text-right font-medium' }, String(row.inbound)),
              h('td', { class: 'py-2 text-right text-neutral-500 dark:text-neutral-400' }, String(row.outbound))
            ])
          ))
        ])
      ])
    }
  }
})
</script>
