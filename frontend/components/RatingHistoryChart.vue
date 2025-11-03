<template>
  <div class="w-full">
    <div class="mb-2 flex justify-between gap-2">
      <div class="flex gap-2">
        <button 
          v-if="props.allowPageMarkers"
          @click="showPages = !showPages" 
          :class="[
            'px-3 py-1 text-xs rounded transition-colors', 
            showPages ? 'bg-blue-600 text-white' : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300'
          ]"
          title="显示/隐藏创建的页面"
        >
          <LucideIcon name="FileText" class="w-4 h-4 inline mr-1" />
          页面标记
        </button>
      </div>
    </div>
    <div class="relative" :style="canvasStyle">
      <div v-if="chartError" class="absolute inset-0 flex items-center justify-center text-xs text-red-600 dark:text-red-400 z-10 bg-transparent">
        {{ chartError }}
      </div>
      <div v-if="props.debug && debugInfo" class="absolute top-0 left-0 m-1 p-1 rounded bg-white/80 dark:bg-black/50 text-[10px] leading-[1.15] text-neutral-700 dark:text-neutral-300 z-10 max-w-[75%] whitespace-pre-wrap pointer-events-none">
        {{ debugInfo }}
      </div>
      <canvas ref="chartCanvas" class="absolute inset-0 w-full h-full"></canvas>
    </div>
  </div>
</template>

<script setup lang="ts">
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  TimeScale,
  BarElement,
  LineElement,
  PointElement,
  Title,
  Tooltip,
  Legend,
  LineController,
  BarController,
  Filler,
  type ChartOptions,
  type Plugin
} from 'chart.js'
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import 'chartjs-adapter-date-fns'
import { zhCN } from 'date-fns/locale'
import { formatDateUtc8 } from '~/utils/timezone'

// Register all necessary Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  TimeScale,
  BarElement,
  LineElement,
  PointElement,
  LineController,
  BarController,
  Title,
  Tooltip,
  Legend,
  Filler
)

interface Props {
  data: Array<{
    date: string
    upvotes: number
    downvotes: number
    net_change: number
    cumulative_rating: number
    pages?: Array<{
      wikidotId: number
      title: string
      date: string
    }>
  }>
  firstActivityDate?: string
  title?: string
  compact?: boolean      // 已废弃，仅保留兼容
  allowPageMarkers?: boolean
  targetTotal?: number
  dense?: boolean        // 紧凑模式（更矮）
  heightPx?: number      // 手动指定像素高度（优先级最高）
  debug?: boolean        // 调试开关：覆盖图和控制台输出
}

const props = withDefaults(defineProps<Props>(), {
  title: '评分历史趋势',
  compact: false,
  allowPageMarkers: false,
  targetTotal: undefined,
  dense: false,
  heightPx: undefined,
  debug: false
})

const chartCanvas = ref<HTMLCanvasElement | null>(null)
let chartInstance: ChartJS | null = null
const showPages = ref(false)
// no-op
const chartError = ref<string | null>(null)
const debugInfo = ref<string>('')

const canvasStyle = computed(() => {
  if (typeof props.heightPx === 'number' && !Number.isNaN(props.heightPx)) {
    return { height: `${props.heightPx}px` }
  }
  const unit = (typeof CSS !== 'undefined' && CSS.supports && CSS.supports('height','1svh')) ? 'svh' : 'vh'
  // Mobile-friendly: slightly shorter default heights to avoid near-square look
  return { height: props.dense ? `clamp(220px, 34${unit}, 360px)` : `clamp(240px, 36${unit}, 380px)` }
})

// 根据可视范围自动选择时间刻度单位
const pickTimeUnit = (min?: Date, max?: Date) => {
  if (!min || !max) return 'month' as const
  const days = (max.getTime() - min.getTime()) / 86400000
  // prefer day up to ~90 days for better readability on short ranges
  if (days <= 90) return 'day'
  // Cap at week for larger spans
  return 'week'
}

// 生成累计曲线的渐变填充（使用 CSS 变量）
const makeAreaGradient = (chart: ChartJS, isDark: boolean) => {
  const { ctx, chartArea } = chart as any
  if (!chartArea) return 'transparent'
  const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
  const cs = getComputedStyle(document.documentElement)
  const toRGB = (s: string) => (s || '').trim().split(/\s+/).join(',')
  const accent = toRGB(cs.getPropertyValue('--accent')) || '16,185,129'
  const accentStrong = toRGB(cs.getPropertyValue('--accent-strong')) || '5,150,105'
  g.addColorStop(0, isDark ? `rgba(${accent},0.25)` : `rgba(${accentStrong},0.25)`)
  g.addColorStop(1, isDark ? `rgba(${accent},0.03)` : `rgba(${accentStrong},0.03)`)
  return g
}

// 负值区域的淡红色填充（使用 CSS 变量）
const makeAreaGradientRed = (chart: ChartJS, isDark: boolean) => {
  const { ctx, chartArea } = chart as any
  if (!chartArea) return 'transparent'
  const g = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
  const cs = getComputedStyle(document.documentElement)
  const toRGB = (s: string) => (s || '').trim().split(/\s+/).join(',')
  const danger = toRGB(cs.getPropertyValue('--danger')) || '239,68,68'
  const dangerStrong = toRGB(cs.getPropertyValue('--danger-strong')) || '220,38,38'
  g.addColorStop(0, isDark ? `rgba(${danger},0.25)` : `rgba(${dangerStrong},0.25)`)
  g.addColorStop(1, isDark ? `rgba(${danger},0.03)` : `rgba(${dangerStrong},0.03)`)
  return g
}

// 按 0 轴拆分的双色填充（上方淡绿、下方淡红）
const makeSplitGradientByZero = (chart: ChartJS, isDark: boolean) => {
  const anyChart: any = chart
  const { ctx, chartArea } = anyChart
  if (!chartArea) return 'transparent'
  const yScale = anyChart.scales?.y1
  if (!yScale) return makeAreaGradient(chart, isDark)
  const zeroY = yScale.getPixelForValue(0)
  const top = chartArea.top
  const bottom = chartArea.bottom
  const span = bottom - top
  if (span <= 0) return makeAreaGradient(chart, isDark)
  let t = (zeroY - top) / span
  if (!isFinite(t)) t = 0.5
  t = Math.max(0, Math.min(1, t))

  const cs = getComputedStyle(document.documentElement)
  const toRGB = (s: string) => (s || '').trim().split(/\s+/).join(',')
  const accent = toRGB(cs.getPropertyValue('--accent')) || '16,185,129'
  const accentStrong = toRGB(cs.getPropertyValue('--accent-strong')) || '5,150,105'
  const danger = toRGB(cs.getPropertyValue('--danger')) || '239,68,68'
  const dangerStrong = toRGB(cs.getPropertyValue('--danger-strong')) || '220,38,38'
  const g = ctx.createLinearGradient(0, top, 0, bottom)
  const greenStrong = isDark ? `rgba(${accent},0.25)` : `rgba(${accentStrong},0.25)`
  const greenNearZero = isDark ? `rgba(${accent},0.06)` : `rgba(${accentStrong},0.06)`
  const redStrong = isDark ? `rgba(${danger},0.25)` : `rgba(${dangerStrong},0.25)`
  const redLight = isDark ? `rgba(${danger},0.03)` : `rgba(${dangerStrong},0.03)`

  if (t <= 0) {
    // 全部在 0 之上 → 仅绿色
    g.addColorStop(0, greenStrong)
    g.addColorStop(1, greenNearZero)
    return g
  }
  if (t >= 1) {
    // 全部在 0 之下 → 仅红色
    g.addColorStop(0, redStrong)
    g.addColorStop(1, redLight)
    return g
  }
  // 上半段：绿色从顶部渐变到接近 0
  g.addColorStop(0, greenStrong)
  g.addColorStop(t, greenNearZero)
  // 在 0 处切换到红色（双重 stop 制造清晰分界）
  g.addColorStop(t, redStrong)
  // 下半段：红色向底部变浅
  g.addColorStop(1, redLight)
  return g
}

// 简单整数格式化
const formatInt = (v: number) => Math.round(Number(v || 0)).toString()

// 柱状数值显示（仅在可读时）
const barValueLabelPlugin: Plugin<'bar'> = {
  id: 'barValueLabelPlugin',
  afterDatasetsDraw(chart) {
    const { ctx } = chart as any
    chart.data.datasets.forEach((ds, dsIndex) => {
      // 仅处理柱状
      if ((ds as any).type && (ds as any).type !== 'bar') return
      const meta = chart.getDatasetMeta(dsIndex)
      meta.data.forEach((elem: any, i: number) => {
        const y = elem.y
        const h = Math.abs(elem.base - y)
        if (h < 18) return
        const raw = (ds.data as any)[i]
        if (!raw || raw.y == null) return
        const value = formatInt(raw.y)
        ctx.save()
        ctx.font = '11px system-ui, -apple-system, Segoe UI, Roboto'
        ctx.textAlign = 'center'
        ctx.textBaseline = raw.y >= 0 ? 'bottom' : 'top'
        ctx.fillStyle = '#111827'
        const dy = raw.y >= 0 ? -3 : 3
        ctx.fillText(value, elem.x, y + dy)
        ctx.restore()
      })
    })
  }
}

// （移除）悬停竖向参考线

// 不再显示右上角“累计：xxxx”徽章（移除插件）

type Ext = { pos: number; neg: number } // neg 是“负侧幅度”的绝对值

const getExt = (arr: number[]): Ext => {
  let pos = 0, neg = 0
  for (const v of arr) {
    if (v > 0) pos = Math.max(pos, v)
    else if (v < 0) neg = Math.max(neg, -v)
  }
  return { pos, neg }
}

// 在给定比值 r=pos/neg 条件下，覆盖数据所需的最小范围（min,max）
const alignedFor = (e: Ext, r: number) => {
  if (e.pos === 0 && e.neg === 0) return { min: -1, max: 1 }
  // 方案A：以正侧为主
  const posA = Math.max(e.pos, r * e.neg)
  const negA = posA / r
  const spanA = posA + negA
  // 方案B：以负侧为主
  const negB = Math.max(e.neg, e.pos / r)
  const posB = r * negB
  const spanB = posB + negB
  const useA = spanA <= spanB
  const pos = useA ? posA : posB
  const neg = useA ? negA : negB
  return { min: -neg, max: pos }
}

const linkZeroRanges = (
  barVals: number[],
  lineVals: number[],
  opts = { rMax: 10, padBar: 0.12, padLine: 0.08 }
) => {
  const extB = getExt(barVals)
  const extL = getExt(lineVals)
  const natSpanB = (extB.pos + extB.neg) || 1
  const natSpanL = (extL.pos + extL.neg) || 1

  const safeRatio = (e: Ext) => {
    if (e.neg === 0 && e.pos === 0) return 1
    if (e.neg === 0) return 1e6
    if (e.pos === 0) return 1e-6
    return e.pos / e.neg
  }

  const rBar = safeRatio(extB)
  const rLine = safeRatio(extL)
  const gm = Math.sqrt(rBar * rLine)
  const clamp = (r: number) => Math.min(opts.rMax, Math.max(1 / opts.rMax, r))

  // 一组候选比值（可按需增减）
  const candidates = Array.from(new Set([gm, rBar, rLine, 1, 2, 0.5, 3, 1 / 3].map(clamp)))

  let bestR = candidates[0], bestScore = Number.POSITIVE_INFINITY
  for (const r of candidates) {
    const br = alignedFor(extB, r)
    const lr = alignedFor(extL, r)
    const spanB = br.max - br.min
    const spanL = lr.max - lr.min
    // “扩张成本” = 对两轴各自天然跨度的放大倍数之和
    const expansion = (spanB / natSpanB) + (spanL / natSpanL)
    // 负侧过度膨胀惩罚（避免把负半边拉成空白）
    const NEG_CAP = 4
    const negPenalty =
      ((-br.min) / Math.max(extB.neg || 1, 1) > NEG_CAP ? 0.7 : 0) +
      ((-lr.min) / Math.max(extL.neg || 1, 1) > NEG_CAP ? 0.7 : 0)
    const score = expansion + negPenalty

    if (score < bestScore) { bestScore = score; bestR = r }
  }

  // 用最优 r 得到最终范围，并加一点 padding
  const br = alignedFor(extB, bestR)
  const lr = alignedFor(extL, bestR)
  const pad = (range: { min: number; max: number }, p: number) => {
    const span = range.max - range.min
    return { min: range.min - span * p, max: range.max + span * p }
  }
  const b = pad(br, opts.padBar)
  const l = pad(lr, opts.padLine)

  return { barMin: b.min, barMax: b.max, lineMin: l.min, lineMax: l.max }
}

const createChart = () => {
  chartError.value = null
  debugInfo.value = ''
  if (!chartCanvas.value || !props.data || props.data.length === 0) return
  
  // 销毁旧图表实例
  if (chartInstance) {
    chartInstance.destroy()
    chartInstance = null
  }

  const root = document.documentElement
  const isDark = root.classList.contains('dark')
  const cs = getComputedStyle(root)
  const toRGB = (s: string) => (s || '').trim().split(/\s+/).join(',')
  const accent = toRGB(cs.getPropertyValue('--accent')) || '16,185,129'
  const accentStrong = toRGB(cs.getPropertyValue('--accent-strong')) || '5,150,105'
  const success = toRGB(cs.getPropertyValue('--success')) || '34,197,94'
  const successStrong = toRGB(cs.getPropertyValue('--success-strong')) || '22,163,74'
  const danger = toRGB(cs.getPropertyValue('--danger')) || '239,68,68'
  const dangerStrong = toRGB(cs.getPropertyValue('--danger-strong')) || '220,38,38'
  const slate400 = toRGB(cs.getPropertyValue('--slate-400')) || '148,163,184'
  const slate500 = toRGB(cs.getPropertyValue('--slate-500')) || '100,116,139'
  const fg = toRGB(cs.getPropertyValue('--fg')) || '23,23,23'
  const muted = toRGB(cs.getPropertyValue('--muted')) || '110,118,129'
  const mutedStrong = toRGB(cs.getPropertyValue('--muted-strong')) || '55,65,81'
  const panel = toRGB(cs.getPropertyValue('--panel')) || '255,255,255'
  const panelBorder = toRGB(cs.getPropertyValue('--panel-border')) || '224,231,240'
  const gridBase = toRGB(cs.getPropertyValue(isDark ? '--chart-grid-dark' : '--chart-grid-light')) || (isDark ? '255,255,255' : '0,0,0')
  const gridColor = `rgba(${gridBase},0.08)`
  const zeroLineColor = `rgba(${muted},0.6)`
  const tickColor = `rgb(${muted})`
  const axisTitleColor = `rgb(${mutedStrong})`
  const legendColor = `rgb(${mutedStrong})`
  const tooltipBackground = `rgba(${panel},${isDark ? 0.96 : 0.93})`
  const tooltipTitleColor = `rgb(${fg})`
  const tooltipBodyColor = `rgb(${muted})`
  const tooltipBorderColor = `rgba(${panelBorder},0.55)`
  
  // 准备数据 - 使用实际日期作为x轴
  let chartData = props.data.map(item => {
    const rawDate = new Date(item.date)
    // Normalize to UTC midnight to avoid DST/timezone drift and ensure exact alignment per day
    const date = new Date(Date.UTC(rawDate.getUTCFullYear(), rawDate.getUTCMonth(), rawDate.getUTCDate()))
    return {
      x: date,
      upvotes: Number(item.upvotes),
      downvotes: -Number(item.downvotes),
      cumulative: Number(item.cumulative_rating),
      originalUpvotes: item.upvotes,
      originalDownvotes: item.downvotes,
      pages: item.pages || []
    } as any
  })
  // 过滤无效数据点（无效日期或非有限数值）
  const rawCount = chartData.length
  chartData = chartData.filter((d: any) => {
    const t = (d.x instanceof Date) ? d.x.getTime() : NaN
    return Number.isFinite(t) && Number.isFinite(d.upvotes) && Number.isFinite(d.downvotes) && Number.isFinite(d.cumulative)
  })
  const filteredCount = chartData.length
  if (!chartData || chartData.length === 0) {
    chartError.value = '暂无可绘制数据'
    if (props.debug) {
      console.warn('[RatingHistoryChart] no drawable data', { rawCount, filteredCount, data: props.data?.slice?.(0, 5) })
    }
    return
  }
  
  // 首个真实投票出现的时间索引（用于全部历史模式下的连接线与标记投影）
  const firstVoteIndex = chartData.findIndex(d => Number((d as any).originalUpvotes) > 0 || Number((d as any).originalDownvotes) > 0)
  
  // 计算连接线与首个投票点信息
  let connectionLine: any[] = []
  let connectionStartDate: Date | undefined
  let firstDataDateGlobal: Date | undefined
  let firstCumulativeRaw = 0
  let connectionSlope: number | undefined

  if (firstVoteIndex >= 0) {
    firstDataDateGlobal = new Date(chartData[firstVoteIndex].x)
    firstCumulativeRaw = Number((chartData[firstVoteIndex] as any).cumulative) || 0
  } else if (chartData.length > 0) {
    firstDataDateGlobal = new Date(chartData[0].x)
    firstCumulativeRaw = Number((chartData[0] as any).cumulative) || 0
  }
  if (props.firstActivityDate && firstDataDateGlobal) {
    const firstActivity = new Date(props.firstActivityDate)
    if (firstActivity < firstDataDateGlobal) {
      connectionStartDate = firstActivity
    }
  }

  const displayData = chartData
  // 用可见范围（或数据本身范围）选择时间单位，短到天，长到年
  let visibleMin: Date | undefined = displayData.length > 0 ? new Date(Math.min(...displayData.map(d => (d.x as Date).getTime()))) : undefined
  let visibleMax: Date | undefined = displayData.length > 0 ? new Date(Math.max(...displayData.map(d => (d.x as Date).getTime()))) : undefined
  if (connectionStartDate) {
    if (!visibleMin || connectionStartDate.getTime() < visibleMin.getTime()) {
      visibleMin = new Date(connectionStartDate)
    }
  }
  // 如果只有单个点，扩展时间范围，避免时间轴 min==max 导致渲染/刻度异常
  let singlePointExpanded = false
  if (visibleMin && visibleMax && visibleMin.getTime() === visibleMax.getTime()) {
    const center = visibleMin.getTime()
    const DAY = 86400000
    visibleMin = new Date(center - DAY)
    visibleMax = new Date(center + DAY)
    singlePointExpanded = true
  }
  const timeUnit = pickTimeUnit(visibleMin, visibleMax)
  // 若提供目标总分，按差值平移累计曲线，使末端累计与目标一致
  const lastCumulative = displayData.length > 0 ? Number(displayData[displayData.length - 1].cumulative) : 0
  const offset = typeof props.targetTotal === 'number' && !Number.isNaN(props.targetTotal)
    ? Number(props.targetTotal) - lastCumulative
    : 0
  // 为 X 轴增加极小左右留白
  const spanMs = (visibleMax && visibleMin) ? (visibleMax.getTime() - visibleMin.getTime()) : 0
  const padMs = spanMs > 0 ? Math.max(1, Math.round(spanMs * 0.01)) : 0
  const paddedMin = visibleMin ? (visibleMin.getTime() - padMs) : undefined
  const paddedMax = visibleMax ? (visibleMax.getTime() + padMs) : undefined

  // 分别计算bar和line的范围
  const barValues = displayData.flatMap(d => [d.upvotes, d.downvotes])
  const lineValues = displayData.map(d => d.cumulative + offset)
  
  // 使用“带上限的零对齐”算法来计算两轴范围
  const { barMin: adjustedBarMin, barMax: adjustedBarMax, lineMin: adjustedLineMin, lineMax: adjustedLineMax } =
    linkZeroRanges(barValues, lineValues, { rMax: 10, padBar: 0.12, padLine: 0.08 })
  
  const datasets: any[] = [
    {
      label: '支持票',
      data: displayData.map(d => ({ x: d.x, y: d.upvotes })),
      backgroundColor: isDark ? `rgba(${success},0.85)` : `rgba(${successStrong},0.85)`,
      borderColor: isDark ? `rgb(${success})` : `rgb(${successStrong})`,
      borderWidth: 1,
      barPercentage: 0.8,
      categoryPercentage: 0.9,
      borderSkipped: false,
      maxBarThickness: Math.max(2, Math.floor(28 - Math.min(20, displayData.length / 20))),
      // Overlay bars for up/down at the same X center instead of grouping side-by-side
      grouped: false,
      order: 1
    },
    {
      label: '反对票',
      data: displayData.map(d => ({ x: d.x, y: d.downvotes })),
      backgroundColor: isDark ? `rgba(${danger},0.8)` : `rgba(${dangerStrong},0.8)`,
      borderColor: isDark ? `rgb(${danger})` : `rgb(${dangerStrong})`,
      borderWidth: 1,
      barPercentage: 0.8,
      categoryPercentage: 0.9,
      borderSkipped: false,
      maxBarThickness: Math.max(2, Math.floor(28 - Math.min(20, displayData.length / 20))),
      grouped: false,
      order: 1
    },
    {
      label: '累计评分',
      type: 'line' as const,
      // 使用内置 above/below 相对 origin 的填充，确保与 0 轴像素级对齐
      fill: {
        target: 'origin',
        above: (ctx: any) => makeAreaGradient(ctx.chart, isDark),
        below: (ctx: any) => makeAreaGradientRed(ctx.chart, isDark)
      } as any,
      backgroundColor: 'transparent',
      data: displayData.map(d => {
        // 在全部历史模式下，在首个真实投票之前隐藏绿色累计线，以避免与灰色虚线重复
        if (firstDataDateGlobal && (d.x as Date) < firstDataDateGlobal) {
          return { x: d.x, y: null as any }
        }
        return { x: d.x, y: d.cumulative + offset }
      }),
      borderColor: isDark ? `rgb(${accent})` : `rgb(${accentStrong})`,
      segment: {
        borderColor: (ctx: any) => {
          const dy = (ctx.p1?.parsed?.y ?? 0) - (ctx.p0?.parsed?.y ?? 0)
          return dy >= 0
            ? (isDark ? `rgb(${accent})` : `rgb(${accentStrong})`)
            : (isDark ? `rgb(${danger})` : `rgb(${dangerStrong})`)
        }
      },
      tension: 0.2,
      // 页面标记模式下，隐藏累计评分的点，避免非标记日期出现圆点浮现
      pointRadius: (ctx: any) => displayData.length > 140 ? 0 : (showPages.value ? 0 : 2),
      pointBackgroundColor: isDark ? `rgb(${accent})` : `rgb(${accentStrong})`,
      pointHoverRadius: 4,
      yAxisID: 'y1',
      order: 2
    }
  ]
  
  // 生成灰色虚线（从 firstActivity 的0 到首个投票数据点的累计值，考虑offset以贴合显示的累计曲线）
  if (connectionStartDate && firstDataDateGlobal) {
    const yStart = 0
    const yEnd = firstCumulativeRaw + offset
    connectionLine = [
      { x: connectionStartDate, y: yStart },
      { x: firstDataDateGlobal, y: yEnd }
    ]
    const t0 = connectionStartDate.getTime()
    const t1 = firstDataDateGlobal.getTime()
    connectionSlope = t1 > t0 ? (yEnd - yStart) / (t1 - t0) : undefined
  }
  
  // 如果有连接线，添加虚线数据集
  if (connectionLine.length > 0) {
    datasets.push({
      label: '起始连接',
      type: 'line' as const,
      data: connectionLine,
      borderColor: isDark ? `rgba(${slate400},0.5)` : `rgba(${slate500},0.5)`,
      borderDash: [5, 5],
      backgroundColor: 'transparent',
      pointRadius: 0,
      yAxisID: 'y1',
      showLine: true,
      order: 2,
    })
  }

  // 添加页面标记点（在首个投票数据点之前，沿灰色虚线做线性插值）
  if (showPages.value) {
    const pagePoints = displayData
      .map(d => {
        let y = d.cumulative + offset
        if (connectionStartDate && firstDataDateGlobal && connectionSlope !== undefined) {
          const t = (d.x as Date).getTime()
          const t0 = connectionStartDate.getTime()
          const t1 = firstDataDateGlobal.getTime()
          if (t < t1) {
            const clampedT = Math.max(t0, Math.min(t, t1))
            y = 0 + connectionSlope * (clampedT - t0)
          }
        }
        return { x: d.x, y, pages: d.pages }
      })
      .filter(d => d.pages && d.pages.length > 0)

    if (pagePoints.length > 0) {
      datasets.push({
        label: '',
        type: 'line' as const,
        data: pagePoints as any,
        parsing: false,
        borderColor: 'transparent',
        backgroundColor: isDark ? '#3b82f6' : '#2563eb',
        pointRadius: 4,
        pointHoverRadius: 6,
        pointHitRadius: 10,
        pointBorderColor: isDark ? '#ffffff' : '#ffffff',
        pointBorderWidth: 2,
        pointStyle: 'circle',
        showLine: false,
        yAxisID: 'y1',
        order: 3,
      })
    }
  }

  const chartConfig = { datasets: datasets }

  const options: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    resizeDelay: 120,
    layout: { padding: { top: 6, right: 8, bottom: 2, left: 6 } },
    // 页面标记模式下仅在标记点上触发 tooltip，其余情况使用 index 联动
    interaction: (showPages.value
      ? { mode: 'nearest' as const, intersect: true, axis: 'x' as const }
      : { mode: 'index' as const, intersect: false, axis: 'x' as const }
    ) as any,
    animation: { duration: 260, easing: 'easeOutCubic' },
    plugins: {
      legend: {
        display: true,
        position: 'top' as const,
        labels: {
          color: legendColor,
          font: { size: 11 },
          boxWidth: 10,
          filter: function(item) {
            // 隐藏"起始连接"和空标签（页面标记）
            return Boolean(item.text) && item.text !== '起始连接'
          }
        }
      },
      tooltip: {
        backgroundColor: tooltipBackground,
        titleColor: tooltipTitleColor,
        bodyColor: tooltipBodyColor,
        borderColor: tooltipBorderColor,
        borderWidth: 1,
        bodyFont: { size: 11 },
        titleFont: { size: 12 },
        displayColors: false,
        // 仅隐藏“起始连接”。当显示页面标记时：
        // - tooltip 仅在页面标记点触发（保留空 label 的点）
        // - 屏蔽所有分数数据（支持票/反对票/累计）
        filter: function(item) {
          const dsLabel = (item as any).dataset?.label ?? (item as any).chart?.data?.datasets?.[(item as any).datasetIndex]?.label
          if (dsLabel === '起始连接') return false
          if (showPages.value) return dsLabel === ''
          return true
        },
        callbacks: {
          title: function(context) {
            if (!context || context.length === 0) return ''
            const item: any = context[0]
            const raw = item.raw || {}
            const xVal = (raw.x != null) ? raw.x : (item.parsed && item.parsed.x)
            if (!xVal) return ''
            const date = new Date(xVal)
            return formatDateUtc8(date, { year: 'numeric', month: 'short', day: 'numeric' }) || ''
          },
          label: function(context) {
            if (showPages.value) return ''
            const dsLabel = (context as any).dataset?.label ?? (context as any).chart?.data?.datasets?.[(context as any).datasetIndex]?.label ?? ''
            if (!dsLabel || dsLabel === '起始连接') return ''
            let label = dsLabel + ': '
            const idx = context.dataIndex
            const dataPoint = displayData[idx]
            if (context.parsed && context.parsed.y !== null) {
              if (dsLabel.includes('支持票')) {
                label += dataPoint?.originalUpvotes ?? 0
              } else if (dsLabel.includes('反对票')) {
                label += dataPoint?.originalDownvotes ?? 0
              } else {
                label += Math.round(context.parsed.y).toString()
              }
            }
            return label
          },
          beforeBody: function(context) {
            if (!showPages.value) return
            const item: any = context && context[0]
            if (!item) return
            const raw = item.raw || {}
            const pages = Array.isArray(raw.pages) ? raw.pages : []
            if (pages.length > 0) {
              return pages.map((p: any) => `• ${p.title || 'Untitled'}`)
            }
            return ['（无页面标记）']
          }
        }
      }
    },
    scales: {
      x: {
        type: 'time' as const,
        time: {
          unit: timeUnit,
          round: 'day' as const,
          displayFormats: { day: 'M月d日', week: 'yy年M月', month: 'yy年M月', year: 'yyyy年' },
          tooltipFormat: 'yyyy年MM月dd日'
        },
        offset: false,
        bounds: 'ticks',
        // 统一使用刻度边界以保持留白
        adapters: {
          date: {
            locale: zhCN
          }
        },
        min: paddedMin,
        max: paddedMax,
        grid: {
          color: () => gridColor,
        },
        ticks: {
          // Ensure exact daily alignment (UTC) and centered bars at day ticks
          source: 'data' as any,
          color: tickColor,
          maxRotation: 45,
          minRotation: 0,
          autoSkip: true,
          maxTicksLimit: 14,
          font: { size: 10 }
        }
      },
      y: {
        type: 'linear' as const,
        display: true,
        position: 'left' as const,
        title: {
          display: true,
          text: '投票数',
          color: axisTitleColor,
        },
        // 使用固定的min/max确保0点对齐
        min: adjustedBarMin,
        max: adjustedBarMax,
        grid: {
          color: (ctx: any) => (ctx.tick.value === 0 ? zeroLineColor : gridColor),
          lineWidth: (ctx: any) => ctx.tick.value === 0 ? 2 : 1,
        },
        ticks: {
          color: tickColor,
          stepSize: (adjustedBarMax - adjustedBarMin) <= 20 ? 1 : undefined,
          callback: function(value) {
            // 只显示整数刻度
            if (Number.isInteger(value)) {
              return Math.abs(Number(value)).toString()
            }
            return  // 跳过非整数，返回undefined
          },
          font: { size: 10 }
        }
      },
      y1: {
        type: 'linear' as const,
        display: true,
        position: 'right' as const,
        title: {
          display: true,
          text: '累计评分',
          color: axisTitleColor,
        },
        // 使用固定的min/max确保0点对齐
        min: adjustedLineMin,
        max: adjustedLineMax,
        grid: {
          drawOnChartArea: false,
          color: (ctx: any) => (ctx.tick.value === 0 ? zeroLineColor : gridColor),
          lineWidth: (ctx: any) => ctx.tick.value === 0 ? 2 : 1,
        },
        ticks: {
          color: tickColor,
          stepSize: (adjustedLineMax - adjustedLineMin) <= 20 ? 1 : undefined,
          callback: function(value) {
            // 只显示整数刻度
            if (Number.isInteger(value)) {
              return value.toString()
            }
            return  // 跳过非整数，返回undefined
          },
          font: { size: 10 }
        }
      }
    }
  }

  const ctx = chartCanvas.value.getContext('2d')
  try {
    if (ctx) {
      chartInstance = new ChartJS(ctx, {
        type: 'bar',
        data: chartConfig,
        options: options as any
      })
    }
    // 调试输出：覆盖和控制台
    if (props.debug) {
      const toIso = (d?: Date) => d ? new Date(d).toISOString() : 'n/a'
      debugInfo.value = [
        `raw=${rawCount} filtered=${filteredCount} display=${displayData.length}`,
        `firstVoteIndex=${firstVoteIndex} firstActivity=${props.firstActivityDate || 'n/a'}`,
        `visibleMin=${toIso(visibleMin)} visibleMax=${toIso(visibleMax)} unit=${timeUnit}`,
        `singlePointExpanded=${singlePointExpanded}`,
        `bar[min,max]=[${adjustedBarMin.toFixed(2)},${adjustedBarMax.toFixed(2)}]`,
        `line[min,max]=[${adjustedLineMin.toFixed(2)},${adjustedLineMax.toFixed(2)}]`,
        `offset=${offset} lastCum=${lastCumulative}`,
      ].join('\n')
      console.groupCollapsed('[RatingHistoryChart] debug')
      console.log('counts', { rawCount, filteredCount, display: displayData.length })
      console.log('firstVoteIndex', firstVoteIndex, 'firstActivityDate', props.firstActivityDate)
      console.log('range', { visibleMin: visibleMin && toIso(visibleMin), visibleMax: visibleMax && toIso(visibleMax), timeUnit, singlePointExpanded })
      console.log('scales', { adjustedBarMin, adjustedBarMax, adjustedLineMin, adjustedLineMax })
      console.log('offset/lastCum', { offset, lastCumulative })
      console.log('sample displayData (first 5)', displayData.slice(0, 5).map((d:any) => ({ x: toIso(d.x), up: d.upvotes, down: d.downvotes, cum: d.cumulative })))
      console.groupEnd()
    }
  } catch (e: any) {
    if (chartInstance) {
      chartInstance.destroy()
      chartInstance = null
    }
    chartError.value = '图表渲染失败'
    if (props.debug) {
      console.error('[RatingHistoryChart] render error', e)
    }
  }
}

// 监听数据、页面标记开关、以及起始日期/目标总分变化
watch([() => props.data, () => showPages.value, () => props.firstActivityDate, () => props.targetTotal], () => {
  createChart()
}, { deep: true })

// 监听主题变化
const observeTheme = () => {
  const observer = new MutationObserver(() => {
    createChart()
  })
  
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class']
  })
  
  return observer
}

let themeObserver: MutationObserver | null = null

onMounted(() => {
  createChart()
  themeObserver = observeTheme()
  // 交给 Chart.js 自身的 responsive 处理尺寸变化，不再额外绑定 ResizeObserver 以避免递归触发
})

onUnmounted(() => {
  if (chartInstance) {
    chartInstance.destroy()
  }
  if (themeObserver) {
    themeObserver.disconnect()
  }
})
</script>

<style scoped>
</style>
