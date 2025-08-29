<template>
  <div class="w-full">
    <div class="h-72 sm:h-80">
      <canvas ref="canvasEl" class="w-full h-full"></canvas>
    </div>
    <div v-if="loaded && payload" class="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
      基准更新于 {{ new Date(payload.asOf).toLocaleString('zh-CN') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch, computed } from 'vue'
import { useNuxtApp, useAsyncData } from 'nuxt/app'
import { Chart as ChartJS, RadialLinearScale, PointElement, LineElement, Filler, Tooltip, Legend, Title, RadarController } from 'chart.js'

ChartJS.register(RadialLinearScale, PointElement, LineElement, Filler, Tooltip, Legend, Title, RadarController)

type CategoryKey = 'scp' | 'story' | 'goi' | 'translation' | 'wanderers' | 'art'

type UserStatsLike = {
  scpRating?: number
  pageCountScp?: number
  storyRating?: number
  pageCountTale?: number
  goiRating?: number
  pageCountGoiFormat?: number
  translationRating?: number
  translationPageCount?: number
  wanderersRating?: number
  wanderersPageCount?: number
  artRating?: number
  pageCountArtwork?: number
}

type CategoryBenchmark = {
  category: CategoryKey
  p50Rating: number
  p95Rating: number
  avgRating: number
  nAuthors: number
}

type CategoryBenchmarksPayload = {
  asOf: string
  benchmarks: Record<CategoryKey, CategoryBenchmark>
  method?: string
  version?: number
}

const props = defineProps<{ userStats: UserStatsLike | null | undefined }>()

const { $bff } = useNuxtApp()
const { data: resp, pending } = await useAsyncData(
  () => 'stats-category-benchmarks',
  () => $bff('/stats/category-benchmarks'),
  { server: false }
)

const payload = computed<CategoryBenchmarksPayload | null>(() => {
  const p = resp.value?.payload as CategoryBenchmarksPayload | undefined
  // 后端返回形如 { payload, updatedAt, expiresAt }
  return p ? p : null
})

const labels: string[] = ['SCP', '故事', 'GoI格式', '翻译', '被放逐者的图书馆', '艺术作品']
const catKeys: CategoryKey[] = ['scp', 'story', 'goi', 'translation', 'wanderers', 'art']

function asinhMap(v: number, p50: number, p95: number, tau: number) {
  const t = Math.max(1e-6, Number(tau) || 0)
  const g = (x: number) => Math.asinh(Number(x || 0) / t)
  const denom = g(p95) - g(p50)
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-6) return 50
  const s = 50 + 50 * (g(v) - g(p50)) / denom
  return Math.min(100, Math.max(0, s))
}

function linearMap(v: number, p50: number, p95: number) {
  const denom = (p95 - p50)
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-6) return 50
  const s = 50 + 50 * (v - p50) / denom
  return Math.min(100, Math.max(0, s))
}

const canvasEl = ref<HTMLCanvasElement | null>(null)
let chart: ChartJS<'radar'> | null = null

const loaded = computed(() => !!payload.value && !pending.value)

function buildDatasets() {
  const p = payload.value
  const s = props.userStats
  if (!p || !s) return { user: [] as number[], siteAvg: [] as number[], top10: [] as number[] }

  const counts: Record<CategoryKey, number> = {
    scp: Number(s.pageCountScp || 0),
    story: Number(s.pageCountTale || 0),
    goi: Number(s.pageCountGoiFormat || 0),
    translation: Number(s.translationPageCount || 0),
    wanderers: Number(s.wanderersPageCount || 0),
    art: Number(s.pageCountArtwork || 0)
  }

  const ratings: Record<CategoryKey, number> = {
    scp: counts.scp > 0 ? Number(s.scpRating || 0) : 0,
    story: counts.story > 0 ? Number(s.storyRating || 0) : 0,
    goi: counts.goi > 0 ? Number(s.goiRating || 0) : 0,
    translation: counts.translation > 0 ? Number(s.translationRating || 0) : 0,
    wanderers: counts.wanderers > 0 ? Number(s.wanderersRating || 0) : 0,
    art: counts.art > 0 ? Number(s.artRating || 0) : 0
  }

  const user: number[] = []
  const siteAvg: number[] = []
  const top10: number[] = []
  for (const k of catKeys) {
    const b = p.benchmarks[k]
    const userScore = counts[k] > 0
      ? (p.method === 'asinh_p50_p95_v2'
          ? asinhMap(ratings[k] || 0, b?.p50Rating || 0, b?.p95Rating || 1, (b as any)?.tau || 1)
          : linearMap(ratings[k] || 0, b?.p50Rating || 0, b?.p95Rating || 1))
      : 0
    user.push(Number.isFinite(userScore) ? userScore : 0)
    siteAvg.push(50)
    const topScore = p.method === 'asinh_p50_p95_v2'
      ? asinhMap(b?.avgRating || 0, b?.p50Rating || 0, b?.p95Rating || 1, (b as any)?.tau || 1)
      : linearMap(b?.avgRating || 0, b?.p50Rating || 0, b?.p95Rating || 1)
    top10.push(Number.isFinite(topScore) ? topScore : 0)
  }
  return { user, siteAvg, top10 }
}

function isDark(): boolean {
  if (typeof document === 'undefined') return false
  return document.documentElement.classList.contains('dark')
}

function renderChart() {
  const ctx = canvasEl.value?.getContext('2d')
  if (!ctx) return
  const { user, siteAvg } = buildDatasets()
  const dark = isDark()

  const userColor = dark ? 'rgba(16,185,129,0.45)' : 'rgba(16,185,129,0.35)'
  const userBorder = dark ? 'rgba(16,185,129,0.9)' : 'rgba(5,150,105,1)'
  const avgColor = dark ? 'rgba(148,163,184,0.20)' : 'rgba(148,163,184,0.18)'
  const avgBorder = dark ? 'rgba(148,163,184,0.7)' : 'rgba(100,116,139,0.9)'

  if (chart) { chart.destroy() }
  chart = new ChartJS(ctx, {
    type: 'radar',
    data: {
      labels,
      datasets: [
        { label: '用户', data: user, fill: true, backgroundColor: userColor, borderColor: userBorder, pointBackgroundColor: userBorder, pointRadius: 2, borderWidth: 2 },
        { label: '站点均值', data: siteAvg, fill: false, backgroundColor: avgColor, borderColor: avgBorder, pointBackgroundColor: avgBorder, pointRadius: 0, borderDash: [2,3], borderWidth: 1 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        title: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${Number(ctx.parsed.r).toFixed(0)}`
          }
        }
      },
      scales: {
        r: {
          suggestedMin: 0,
          suggestedMax: 100,
          ticks: { display: false, color: dark ? '#9ca3af' : '#6b7280', stepSize: 25, showLabelBackdrop: false },
          pointLabels: { color: dark ? '#d1d5db' : '#374151', font: { size: 12 } },
          grid: { color: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)' },
          angleLines: { color: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)' }
        }
      }
    }
  })
}

onMounted(() => {
  renderChart()
})

watch([payload, () => props.userStats], () => {
  renderChart()
})

onUnmounted(() => {
  if (chart) { chart.destroy(); chart = null }
})
</script>

<style scoped>
</style>


