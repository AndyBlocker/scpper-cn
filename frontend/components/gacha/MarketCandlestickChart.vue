<template>
  <div class="relative h-48 overflow-hidden rounded-lg border border-neutral-200/80 bg-white/75 sm:h-56 lg:h-64 dark:border-neutral-700/70 dark:bg-neutral-950/75">
    <div ref="containerRef" class="h-full w-full" />
    <div
      v-if="candles.length === 0"
      class="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-neutral-500 dark:text-neutral-400"
    >
      暂无走势数据
    </div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import type {
  CandlestickData,
  CandlestickSeriesPartialOptions,
  AreaData,
  IChartApi,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  TickMarkFormatter,
  TickMarkType,
  SeriesMarker,
  Time,
  UTCTimestamp
} from 'lightweight-charts'
import type { MarketCandle, MarketPositionSide, MarketPositionMarker } from '~/types/gacha'

type MarketTimeframe = '24H' | '7D' | '30D'

const props = withDefaults(defineProps<{
  candles: MarketCandle[]
  markers?: MarketPositionMarker[]
  timeframe: MarketTimeframe
  asOfTs?: string | null
}>(), {
  markers: () => [],
  asOfTs: null
})

type LwcModule = typeof import('lightweight-charts')

const containerRef = ref<HTMLDivElement | null>(null)
const chartRef = shallowRef<IChartApi | null>(null)
const candleSeriesRef = shallowRef<ISeriesApi<'Candlestick'> | null>(null)
const areaSeriesRef = shallowRef<ISeriesApi<'Area'> | null>(null)
const markerApiRef = shallowRef<ISeriesMarkersPluginApi<Time> | null>(null)
const areaMarkerApiRef = shallowRef<ISeriesMarkersPluginApi<Time> | null>(null)
const resizeObserverRef = shallowRef<ResizeObserver | null>(null)
const themeObserverRef = shallowRef<MutationObserver | null>(null)
let lwcModule: LwcModule | null = null
const UTC8_TIME_ZONE = 'Asia/Shanghai'
const axisTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: UTC8_TIME_ZONE,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false
})
const axisTimeWithSecondsFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: UTC8_TIME_ZONE,
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})
const axisDayFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: UTC8_TIME_ZONE,
  month: '2-digit',
  day: '2-digit'
})
const axisMonthFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: UTC8_TIME_ZONE,
  month: '2-digit'
})
const axisYearFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: UTC8_TIME_ZONE,
  year: 'numeric'
})
const crosshairTimeFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: UTC8_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false
})

function timeframeHours(timeframe: MarketTimeframe) {
  if (timeframe === '7D') return 24 * 7
  if (timeframe === '30D') return 24 * 30
  return 24
}

function timeframeBucketSeconds(timeframe: MarketTimeframe) {
  if (timeframe === '7D') return 4 * 60 * 60
  if (timeframe === '30D') return 12 * 60 * 60
  return 60 * 60
}

function clampNumber(value: number, minValue: number, maxValue: number) {
  return Math.max(minValue, Math.min(maxValue, value))
}

function resolveBarSpacing(timeframe: MarketTimeframe, candleCount: number) {
  const width = containerRef.value?.clientWidth || 0
  const fallback = timeframe === '24H' ? 10 : timeframe === '7D' ? 7 : 6
  if (width <= 0 || candleCount <= 0) return fallback
  const ratio = timeframe === '24H' ? 0.52 : timeframe === '7D' ? 0.46 : 0.42
  const target = (width / candleCount) * ratio
  const minSpacing = timeframe === '24H' ? 5 : 4
  const maxSpacing = timeframe === '24H' ? 14 : timeframe === '7D' ? 11 : 9
  return clampNumber(target, minSpacing, maxSpacing)
}

function parseUnixSeconds(raw: string | null | undefined) {
  const ts = new Date(raw || '').getTime()
  if (!Number.isFinite(ts)) return null
  return Math.floor(ts / 1000)
}

function toDateByTimeInput(time: Time): Date | null {
  if (typeof time === 'number') {
    return new Date(Number(time) * 1000)
  }
  if (typeof time === 'string') {
    const ts = new Date(time).getTime()
    return Number.isFinite(ts) ? new Date(ts) : null
  }
  if (typeof time === 'object' && time != null && 'year' in time && 'month' in time && 'day' in time) {
    return new Date(Date.UTC(time.year, time.month - 1, time.day, 0, 0, 0))
  }
  return null
}

function formatUtc8ForCrosshair(time: Time): string {
  const date = toDateByTimeInput(time)
  if (!date) return ''
  return crosshairTimeFormatter.format(date)
}

const utc8TickMarkFormatter: TickMarkFormatter = (time: Time, tickMarkType: TickMarkType) => {
  const date = toDateByTimeInput(time)
  if (!date || !lwcModule) return null
  if (tickMarkType === lwcModule.TickMarkType.Year) return axisYearFormatter.format(date)
  if (tickMarkType === lwcModule.TickMarkType.Month) return axisMonthFormatter.format(date)
  if (tickMarkType === lwcModule.TickMarkType.DayOfMonth) return axisDayFormatter.format(date)
  if (tickMarkType === lwcModule.TickMarkType.TimeWithSeconds) return axisTimeWithSecondsFormatter.format(date)
  return axisTimeFormatter.format(date)
}

function asUtcTimestamp(value: number): UTCTimestamp {
  return Math.floor(value) as UTCTimestamp
}

function isDarkMode() {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

function buildCandles(): CandlestickData<UTCTimestamp>[] {
  return props.candles
    .map((item) => {
      const time = parseUnixSeconds(item.ts)
      const open = Number(item.open)
      const high = Number(item.high)
      const low = Number(item.low)
      const close = Number(item.close)
      if (
        time == null
        || !Number.isFinite(open)
        || !Number.isFinite(high)
        || !Number.isFinite(low)
        || !Number.isFinite(close)
      ) {
        return null
      }
      return {
        time: asUtcTimestamp(time),
        open,
        high,
        low,
        close
      }
    })
    .filter((item): item is CandlestickData<UTCTimestamp> => Boolean(item))
    .sort((a, b) => Number(a.time) - Number(b.time))
}

function buildAreaData(): AreaData<UTCTimestamp>[] {
  const points = props.candles
    .map((item) => {
      const time = parseUnixSeconds(item.ts)
      const close = Number(item.close)
      if (time == null || !Number.isFinite(close)) return null
      return { time: asUtcTimestamp(time), value: close }
    })
    .filter((item): item is AreaData<UTCTimestamp> => Boolean(item))
    .sort((a, b) => Number(a.time) - Number(b.time))

  // Prepend the first candle's open price so the area chart shows the
  // transition from opening price to current price. Without this, when a
  // price drop happens inside the first candle bucket the area chart only
  // sees the post-drop close and draws a flat line.
  if (points.length > 0 && props.candles.length > 0) {
    const sorted = [...props.candles].sort(
      (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
    )
    const firstCandle = sorted[0]!
    const openPrice = Number(firstCandle.open)
    if (Number.isFinite(openPrice) && Math.abs(openPrice - points[0]!.value) > 0.001) {
      // Use 1 second before the first candle's timestamp to maintain
      // strictly-increasing time ordering required by lightweight-charts.
      points.unshift({
        time: asUtcTimestamp(Number(points[0]!.time) - 1),
        value: openPrice
      })
    }
  }

  return points
}

function buildMarkers(): SeriesMarker<UTCTimestamp>[] {
  const markers: SeriesMarker<UTCTimestamp>[] = []
  for (const item of props.markers || []) {
    const time = parseUnixSeconds(item.ts)
    if (time == null) continue
    const isLong = item.side === 'LONG'
    if (item.kind === 'OPEN') {
      markers.push({
        time: asUtcTimestamp(time),
        position: isLong ? 'belowBar' : 'aboveBar',
        shape: isLong ? 'arrowUp' : 'arrowDown',
        color: isLong ? '#16a34a' : '#e11d48',
        text: isLong ? 'L' : 'S'
      })
      continue
    }
    markers.push({
      time: asUtcTimestamp(time),
      position: 'inBar',
      shape: 'circle',
      color: isLong ? '#059669' : '#be123c',
      text: item.kind === 'SETTLE' ? 'C' : 'E'
    })
  }
  return markers
}

async function loadLwc() {
  if (!lwcModule) {
    lwcModule = await import('lightweight-charts')
  }
  return lwcModule
}

async function initChart() {
  if (chartRef.value || !containerRef.value || typeof window === 'undefined') return
  const lwc = await loadLwc()
  const dark = isDarkMode()
  const chart = lwc.createChart(containerRef.value, {
    autoSize: true,
    layout: {
      background: { type: lwc.ColorType.Solid, color: 'transparent' },
      textColor: dark ? '#cbd5e1' : '#475569',
      fontSize: 11,
      fontFamily: 'Sora, Avenir Next, PingFang SC, Noto Sans CJK SC, sans-serif'
    },
    grid: {
      vertLines: {
        color: dark ? 'rgba(100,116,139,0.24)' : 'rgba(148,163,184,0.25)',
        style: lwc.LineStyle.Dotted
      },
      horzLines: {
        color: dark ? 'rgba(100,116,139,0.24)' : 'rgba(148,163,184,0.25)',
        style: lwc.LineStyle.Dotted
      }
    },
    rightPriceScale: {
      visible: true,
      borderColor: dark ? 'rgba(100,116,139,0.45)' : 'rgba(148,163,184,0.45)',
      scaleMargins: { top: 0.12, bottom: 0.1 }
    },
    leftPriceScale: {
      visible: false
    },
    crosshair: {
      mode: lwc.CrosshairMode.Normal,
      vertLine: {
        labelBackgroundColor: dark ? '#334155' : '#64748b'
      },
      horzLine: {
        labelBackgroundColor: dark ? '#334155' : '#64748b'
      }
    },
    handleScroll: {
      mouseWheel: true,
      pressedMouseMove: true,
      horzTouchDrag: true,
      vertTouchDrag: false
    },
    handleScale: {
      axisPressedMouseMove: true,
      mouseWheel: true,
      pinch: true
    },
    localization: {
      locale: 'zh-CN',
      timeFormatter: formatUtc8ForCrosshair
    },
    timeScale: {
      borderColor: dark ? 'rgba(100,116,139,0.45)' : 'rgba(148,163,184,0.45)',
      rightOffset: 1,
      timeVisible: true,
      secondsVisible: false,
      minBarSpacing: 3,
      tickMarkFormatter: utc8TickMarkFormatter
    }
  })

  const seriesOptions: CandlestickSeriesPartialOptions = {
    upColor: '#16a34a',
    downColor: '#e11d48',
    wickUpColor: '#16a34a',
    wickDownColor: '#e11d48',
    borderUpColor: '#15803d',
    borderDownColor: '#be123c',
    borderVisible: true,
    lastValueVisible: true,
    priceLineVisible: false,
    priceFormat: {
      type: 'price',
      precision: 2,
      minMove: 0.01
    }
  }
  const series = chart.addSeries(lwc.CandlestickSeries, seriesOptions)
  const markerApi = lwc.createSeriesMarkers(series, [])

  const areaSeries = chart.addSeries(lwc.AreaSeries, {
    lineColor: '#06b6d4',
    topColor: 'rgba(6,182,212,0.35)',
    bottomColor: 'rgba(6,182,212,0.02)',
    lineWidth: 2,
    lastValueVisible: true,
    priceLineVisible: false,
    crosshairMarkerVisible: true,
    crosshairMarkerRadius: 4,
    priceFormat: {
      type: 'price',
      precision: 2,
      minMove: 0.01
    }
  })
  const areaMarkerApi = lwc.createSeriesMarkers(areaSeries, [])

  chartRef.value = chart
  candleSeriesRef.value = series
  areaSeriesRef.value = areaSeries
  markerApiRef.value = markerApi
  areaMarkerApiRef.value = areaMarkerApi

  const resizeObserver = new ResizeObserver(() => {
    if (!containerRef.value || !chartRef.value) return
    chartRef.value.resize(containerRef.value.clientWidth, containerRef.value.clientHeight)
    updateChart()
  })
  resizeObserver.observe(containerRef.value)
  resizeObserverRef.value = resizeObserver

  const themeObserver = new MutationObserver(() => {
    applyTheme()
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  themeObserverRef.value = themeObserver
}

function applyTheme() {
  if (!chartRef.value || !lwcModule) return
  const dark = isDarkMode()
  chartRef.value.applyOptions({
    layout: {
      textColor: dark ? '#cbd5e1' : '#475569'
    },
    grid: {
      vertLines: {
        color: dark ? 'rgba(100,116,139,0.24)' : 'rgba(148,163,184,0.25)',
        style: lwcModule.LineStyle.Dotted
      },
      horzLines: {
        color: dark ? 'rgba(100,116,139,0.24)' : 'rgba(148,163,184,0.25)',
        style: lwcModule.LineStyle.Dotted
      }
    },
    rightPriceScale: {
      borderColor: dark ? 'rgba(100,116,139,0.45)' : 'rgba(148,163,184,0.45)'
    },
    timeScale: {
      borderColor: dark ? 'rgba(100,116,139,0.45)' : 'rgba(148,163,184,0.45)'
    },
    crosshair: {
      vertLine: { labelBackgroundColor: dark ? '#334155' : '#64748b' },
      horzLine: { labelBackgroundColor: dark ? '#334155' : '#64748b' }
    }
  })
}

function updateChart() {
  const chart = chartRef.value
  const series = candleSeriesRef.value
  const areaSeries = areaSeriesRef.value
  if (!chart || !series || !areaSeries) return

  const isAreaMode = props.timeframe === '24H'
  const candleData = buildCandles()
  const markers = buildMarkers()

  if (isAreaMode) {
    // 24H: use area chart
    series.applyOptions({ visible: false })
    areaSeries.applyOptions({ visible: true })
    areaSeries.setData(buildAreaData())
    series.setData([]) // clear candle data to avoid ghost rendering
    markerApiRef.value?.setMarkers([])
    areaMarkerApiRef.value?.setMarkers(markers)
  } else {
    // 7D/30D: use candlestick chart
    areaSeries.applyOptions({ visible: false })
    series.applyOptions({ visible: true })
    series.setData(candleData)
    areaSeries.setData([])
    markerApiRef.value?.setMarkers(markers)
    areaMarkerApiRef.value?.setMarkers([])
  }

  // lightweight-charts throws "Value is null" when setVisibleRange is called
  // on a chart with no data points — guard against empty series
  if (candleData.length === 0) return

  const asOf = parseUnixSeconds(props.asOfTs) ?? Math.floor(Date.now() / 1000)
  const windowFrom = asOf - timeframeHours(props.timeframe) * 60 * 60
  const bucketSeconds = timeframeBucketSeconds(props.timeframe)
  const firstCandleTime = Number(candleData[0]!.time)
  const lastCandleTime = Number(candleData[candleData.length - 1]!.time)
  const from = Math.max(windowFrom, firstCandleTime - bucketSeconds)
  const to = Math.max(asOf, lastCandleTime)

  chart.timeScale().applyOptions({
    barSpacing: resolveBarSpacing(props.timeframe, candleData.length),
    minBarSpacing: 3
  })
  chart.timeScale().setVisibleRange({
    from: asUtcTimestamp(from),
    to: asUtcTimestamp(to)
  })
}

onMounted(async () => {
  await nextTick()
  await initChart()
  applyTheme()
  updateChart()
})

watch(
  () => [props.candles, props.markers, props.timeframe, props.asOfTs],
  () => {
    updateChart()
  },
  { deep: true }
)

onUnmounted(() => {
  themeObserverRef.value?.disconnect()
  themeObserverRef.value = null
  resizeObserverRef.value?.disconnect()
  resizeObserverRef.value = null
  areaMarkerApiRef.value = null
  markerApiRef.value = null
  areaSeriesRef.value = null
  candleSeriesRef.value = null
  chartRef.value?.remove()
  chartRef.value = null
})
</script>
