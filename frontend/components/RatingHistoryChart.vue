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
          <svg class="w-4 h-4 inline mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          页面标记
        </button>
      </div>
      <div class="flex gap-2">
        <button 
          @click="viewMode = 'full'" 
          :class="['px-3 py-1 text-xs rounded', viewMode === 'full' ? 'bg-emerald-600 text-white' : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300']"
        >
          全部历史
        </button>
        <button 
          @click="viewMode = 'compact'" 
          :class="['px-3 py-1 text-xs rounded', viewMode === 'compact' ? 'bg-emerald-600 text-white' : 'bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300']"
        >
          紧凑视图
        </button>
      </div>
    </div>
    <canvas ref="chartCanvas"></canvas>
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
  type ChartOptions
} from 'chart.js'
import { ref, watch, onMounted, onUnmounted, computed } from 'vue'
import 'chartjs-adapter-date-fns'
import { zhCN } from 'date-fns/locale'

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

// Earliest start date for compact view
const COMPACT_EARLIEST = new Date('2022-05-01')

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
  compact?: boolean
  allowPageMarkers?: boolean
  targetTotal?: number
}

const props = withDefaults(defineProps<Props>(), {
  title: '评分历史趋势',
  compact: false,
  allowPageMarkers: false,
  targetTotal: undefined
})

const chartCanvas = ref<HTMLCanvasElement | null>(null)
let chartInstance: ChartJS | null = null
const viewMode = ref<'full' | 'compact'>(props.compact ? 'compact' : 'full')
const showPages = ref(false)
// no-op

// 硬编码需要隐藏柱状图的日期范围
const HIDDEN_DATE_RANGES = [
  { start: new Date('2022-05-01'), end: new Date('2022-05-31') },
  { start: new Date('2022-06-15'), end: new Date('2022-06-15') }
]

// 检查日期是否应该隐藏柱状图
const shouldHideBar = (date: Date): boolean => {
  return HIDDEN_DATE_RANGES.some(range => date >= range.start && date <= range.end)
}

const createChart = () => {
  if (!chartCanvas.value || !props.data || props.data.length === 0) return
  
  // 销毁旧图表实例
  if (chartInstance) {
    chartInstance.destroy()
  }

  const isDark = document.documentElement.classList.contains('dark')
  
  // 准备数据 - 使用实际日期作为x轴
  let chartData = props.data.map(item => {
    const date = new Date(item.date)
    const hideBar = shouldHideBar(date)
    return {
      x: date,
      upvotes: Number(item.upvotes),
      downvotes: -Number(item.downvotes),
      cumulative: Number(item.cumulative_rating),
      originalUpvotes: item.upvotes,
      originalDownvotes: item.downvotes,
      hideBar: hideBar,
      pages: item.pages || []
    }
  })
  
  // 首个真实投票出现的时间索引（用于全部历史模式下的连接线与标记投影）
  const firstVoteIndex = chartData.findIndex(d => Number((d as any).originalUpvotes) > 0 || Number((d as any).originalDownvotes) > 0)
  
  // 根据视图模式调整数据范围
  let minDate: Date | undefined
  let maxDate: Date | undefined
  let connectionLine: any[] = []
  let connectionStartDate: Date | undefined
  let firstDataDateGlobal: Date | undefined
  let firstCumulativeRaw = 0
  let connectionSlope: number | undefined
  
  if (viewMode.value === 'compact' && chartData.length > 0) {
    // 紧凑模式：使用硬编码最早日期和首次活动日期的较晚者
    let earliest = COMPACT_EARLIEST
    if (props.firstActivityDate) {
      const fa = new Date(props.firstActivityDate)
      earliest = new Date(Math.max(earliest.getTime(), fa.getTime()))
    }
    let visibleData = chartData.filter(d => !d.hideBar && d.x >= earliest)
    if (visibleData.length === 0) {
      visibleData = chartData.filter(d => d.x >= earliest)
    }
    const baseList = visibleData.length > 0 ? visibleData : chartData
    const firstDataDate = new Date(baseList[0].x)
    firstDataDateGlobal = firstDataDate
    firstCumulativeRaw = Number((baseList[0] as any).cumulative) || 0
    const lastDataDate = new Date(baseList[baseList.length - 1].x)
    
    // 向前扩展3个月，向后扩展1个月
    minDate = new Date(firstDataDate)
    minDate.setMonth(minDate.getMonth() - 3)
    maxDate = new Date(lastDataDate)
    maxDate.setMonth(maxDate.getMonth() + 1)
    
    // 紧凑视图不显示灰色虚线
    connectionStartDate = undefined
  } else {
    // 全部历史模式：使用首个出现投票的数据点作为连接终点（若不存在投票，则退回到第一条数据）
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
  }
  
  // 紧凑模式下，仅使用范围内的数据进行绘制与轴范围计算
  const isInRange = (d: any) => !minDate || !maxDate ? true : (d.x >= minDate && d.x <= maxDate)
  const displayData = viewMode.value === 'compact' ? chartData.filter(isInRange) : chartData
  // 若提供目标总分，按差值平移累计曲线，使末端累计与目标一致
  const lastCumulative = displayData.length > 0 ? Number(displayData[displayData.length - 1].cumulative) : 0
  const offset = typeof props.targetTotal === 'number' && !Number.isNaN(props.targetTotal)
    ? Number(props.targetTotal) - lastCumulative
    : 0

  // 分别计算bar和line的范围
  const barValues = displayData.flatMap(d => [d.upvotes, d.downvotes])
  const lineValues = displayData.map(d => d.cumulative + offset)
  
  const maxBar = Math.max(...barValues, 0)
  const minBar = Math.min(...barValues, 0)
  const maxLine = Math.max(...lineValues, 0)
  const minLine = Math.min(...lineValues, 0)
  
  // 确保0点对齐的计算：两个轴的正负比例必须相同
  // 计算每个轴的正负范围
  const barPositiveRange = Math.abs(maxBar)
  const barNegativeRange = Math.abs(minBar)
  const linePositiveRange = Math.abs(maxLine)
  const lineNegativeRange = Math.abs(minLine)
  
  // 计算正负比例
  const barRatio = barNegativeRange > 0 ? barPositiveRange / barNegativeRange : 1
  const lineRatio = lineNegativeRange > 0 ? linePositiveRange / lineNegativeRange : 1
  
  // 使用最大的比例来确保两个轴都能显示完整数据
  const maxRatio = Math.max(barRatio, lineRatio)
  
  // 根据比例调整范围，确保0点对齐
  let adjustedBarMin = 0, adjustedBarMax = 0
  let adjustedLineMin = 0, adjustedLineMax = 0
  
  if (barNegativeRange > 0 || barPositiveRange > 0) {
    if (barNegativeRange === 0) {
      adjustedBarMax = barPositiveRange * 1.1
      adjustedBarMin = -adjustedBarMax / maxRatio
    } else if (barPositiveRange === 0) {
      adjustedBarMin = minBar * 1.1
      adjustedBarMax = -adjustedBarMin * maxRatio
    } else {
      // 有正有负，根据maxRatio调整
      if (barRatio >= maxRatio) {
        adjustedBarMax = maxBar * 1.1
        adjustedBarMin = -adjustedBarMax / barRatio
      } else {
        adjustedBarMin = minBar * 1.1
        adjustedBarMax = -adjustedBarMin * maxRatio
      }
    }
  }
  
  if (lineNegativeRange > 0 || linePositiveRange > 0) {
    if (lineNegativeRange === 0) {
      adjustedLineMax = linePositiveRange * 1.1
      adjustedLineMin = -adjustedLineMax / maxRatio
    } else if (linePositiveRange === 0) {
      adjustedLineMin = minLine * 1.1
      adjustedLineMax = -adjustedLineMin * maxRatio
    } else {
      // 有正有负，根据maxRatio调整
      if (lineRatio >= maxRatio) {
        adjustedLineMax = maxLine * 1.1
        adjustedLineMin = -adjustedLineMax / lineRatio
      } else {
        adjustedLineMin = minLine * 1.1
        adjustedLineMax = -adjustedLineMin * maxRatio
      }
    }
  }
  
  const datasets: any[] = [
    {
      label: '支持票',
      data: displayData.map(d => ({ x: d.x, y: d.hideBar ? null : d.upvotes })),
      backgroundColor: isDark ? 'rgba(34, 197, 94, 0.8)' : 'rgba(22, 163, 74, 0.8)',
      borderColor: isDark ? '#22c55e' : '#16a34a',
      borderWidth: 1,
      barPercentage: 0.8,
      categoryPercentage: 0.9,
    },
    {
      label: '反对票',
      data: displayData.map(d => ({ x: d.x, y: d.hideBar ? null : d.downvotes })),
      backgroundColor: isDark ? 'rgba(239, 68, 68, 0.8)' : 'rgba(220, 38, 38, 0.8)',
      borderColor: isDark ? '#ef4444' : '#dc2626',
      borderWidth: 1,
      barPercentage: 0.8,
      categoryPercentage: 0.9,
    },
    {
      label: '累计评分',
      type: 'line' as const,
      data: displayData.map(d => {
        // 在全部历史模式下，在首个真实投票之前隐藏绿色累计线，以避免与灰色虚线重复
        if (firstDataDateGlobal && (d.x as Date) < firstDataDateGlobal) {
          return { x: d.x, y: null as any }
        }
        return { x: d.x, y: d.cumulative + offset }
      }),
      borderColor: isDark ? '#10b981' : '#059669',
      backgroundColor: 'transparent',
      tension: 0.2,
      pointRadius: showPages.value ? 0 : 2,
      pointBackgroundColor: isDark ? '#10b981' : '#059669',
      pointHoverRadius: 4,
      yAxisID: 'y1',
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
      borderColor: isDark ? 'rgba(156, 163, 175, 0.5)' : 'rgba(107, 114, 128, 0.5)',
      borderDash: [5, 5],
      backgroundColor: 'transparent',
      pointRadius: 0,
      yAxisID: 'y1',
      showLine: true,
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
        pointBorderColor: isDark ? '#ffffff' : '#ffffff',
        pointBorderWidth: 2,
        pointStyle: 'circle',
        showLine: false,
        yAxisID: 'y1',
      })
    }
  }

  const chartConfig = { datasets: datasets }

  const options: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    interaction: showPages.value ? { mode: 'nearest' as const, intersect: true } : { mode: 'index' as const, intersect: false },
    plugins: {
      legend: {
        display: true,
        position: 'top' as const,
        labels: {
          color: isDark ? '#d1d5db' : '#374151',
          font: {
            size: 12
          },
          filter: function(item) {
            // 隐藏"起始连接"和空标签（页面标记）
            return Boolean(item.text) && item.text !== '起始连接'
          }
        }
      },
      tooltip: {
        backgroundColor: isDark ? '#1f2937' : '#ffffff',
        titleColor: isDark ? '#f3f4f6' : '#111827',
        bodyColor: isDark ? '#d1d5db' : '#4b5563',
        borderColor: isDark ? '#374151' : '#e5e7eb',
        borderWidth: 1,
        displayColors: false,
        filter: function(item) {
          // 当开启页面标记时，仅在页面标记点显示tooltip
          if (showPages.value) {
            const idx = (item as any).datasetIndex
            if (typeof idx === 'number') {
              const ds: any = (item.chart as any).data.datasets[idx]
              const isMarker = ds && ds.label === '' && ds.showLine === false && ds.pointRadius === 4
              return Boolean(isMarker)
            }
            return false
          }
          return true
        },
        callbacks: {
          title: function(context) {
            if (!context || context.length === 0) return ''
            const item: any = context[0]
            const xVal = (item.parsed && item.parsed.x) ? item.parsed.x : (item.raw && item.raw.x)
            if (!xVal) return ''
            const date = new Date(xVal)
            return date.toLocaleDateString('zh-CN', { 
              year: 'numeric', 
              month: 'short', 
              day: 'numeric' 
            })
          },
          label: function(context) {
            let label = context.dataset.label || ''
            if (label === '起始连接' || label === '') return ''
            
            const idx = context.dataIndex
            const dataPoint = displayData[idx]
            
            if (label) {
              label += ': '
            }
            
            if (context.parsed && context.parsed.y !== null) {
              if (label.includes('支持票')) {
                label += dataPoint.originalUpvotes
              } else if (label.includes('反对票')) {
                label += dataPoint.originalDownvotes
              } else {
                label += context.parsed.y.toFixed(0)
              }
            }
            
            return label
          },
          beforeBody: function(context) {
            if (!showPages.value) return
            const item = context && context[0]
            if (!item) return
            // 页面标记数据集识别：空label+圆点+不连线
            const dsIdx: any = (item as any).datasetIndex
            if (typeof dsIdx !== 'number') return
            const ds: any = (item.chart as any).data.datasets[dsIdx]
            const isMarker = ds && ds.label === '' && ds.showLine === false && ds.pointRadius === 4
            if (!isMarker) return
            const raw: any = (item.raw as any)
            const pages = raw && raw.pages
            if (pages && pages.length > 0) {
              return pages.map((p: any) => `• ${p.title || 'Untitled'}`)
            }
            return
          }
        }
      }
    },
    scales: {
      x: {
        type: 'time' as const,
        time: {
          unit: 'month',
          displayFormats: {
            month: 'yy年M月'
          },
          tooltipFormat: 'yyyy年MM月dd日'
        },
        adapters: {
          date: {
            locale: zhCN
          }
        },
        min: minDate?.getTime(),
        max: maxDate?.getTime(),
        grid: {
          color: isDark ? '#374151' : '#e5e7eb',
        },
        ticks: {
          color: isDark ? '#9ca3af' : '#6b7280',
          maxRotation: 45,
          minRotation: 0,
          autoSkip: true,
          maxTicksLimit: 20
        }
      },
      y: {
        type: 'linear' as const,
        display: true,
        position: 'left' as const,
        title: {
          display: true,
          text: '投票数',
          color: isDark ? '#9ca3af' : '#6b7280',
        },
        // 使用固定的min/max确保0点对齐
        min: adjustedBarMin,
        max: adjustedBarMax,
        grid: {
          color: isDark ? '#374151' : '#e5e7eb',
        },
        ticks: {
          color: isDark ? '#9ca3af' : '#6b7280',
          stepSize: 1,  // 强制步长为1，确保只显示整数
          callback: function(value) {
            // 只显示整数刻度
            if (Number.isInteger(value)) {
              return Math.abs(Number(value)).toString()
            }
            return  // 跳过非整数，返回undefined
          }
        }
      },
      y1: {
        type: 'linear' as const,
        display: true,
        position: 'right' as const,
        title: {
          display: true,
          text: '累计评分',
          color: isDark ? '#9ca3af' : '#6b7280',
        },
        // 使用固定的min/max确保0点对齐
        min: adjustedLineMin,
        max: adjustedLineMax,
        grid: {
          drawOnChartArea: false,
        },
        ticks: {
          color: isDark ? '#9ca3af' : '#6b7280',
          stepSize: 1,  // 强制步长为1，确保只显示整数
          callback: function(value) {
            // 只显示整数刻度
            if (Number.isInteger(value)) {
              return value.toString()
            }
            return  // 跳过非整数，返回undefined
          }
        }
      }
    }
  }

  const ctx = chartCanvas.value.getContext('2d')
  if (ctx) {
    chartInstance = new ChartJS(ctx, {
      type: 'bar',
      data: chartConfig,
      options: options as any
    })
  }
}

// 监听数据、视图模式和页面显示开关、以及起始日期/目标总分变化
watch([() => props.data, viewMode, showPages, () => props.firstActivityDate, () => props.targetTotal], () => {
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
canvas {
  max-height: 400px;
}
</style>