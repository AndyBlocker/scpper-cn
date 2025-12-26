<template>
  <div class="clock-plot">
    <svg viewBox="0 0 200 200" class="w-full h-full" aria-hidden="true">
      <circle class="clock-ring" cx="100" cy="100" r="86" />
      <circle class="clock-core" cx="100" cy="100" r="52" />
      <g v-for="bar in bars" :key="bar.hour">
        <line
          class="clock-bar"
          :x1="bar.x1"
          :y1="bar.y1"
          :x2="bar.x2"
          :y2="bar.y2"
          :stroke="bar.color"
          :style="{ '--clock-length': bar.length, '--bar-delay': `${bar.delay}ms`, strokeOpacity: bar.opacity }"
        >
          <title>{{ bar.label }}</title>
        </line>
      </g>
      <g>
        <text
          v-for="label in labels"
          :key="label.text"
          class="clock-label"
          :x="label.x"
          :y="label.y"
          text-anchor="middle"
          dominant-baseline="middle"
        >
          {{ label.text }}
        </text>
      </g>
    </svg>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

type HourItem = {
  hour: number
  count: number
}

const props = defineProps<{
  hours: HourItem[]
}>()

const CENTER = { x: 100, y: 100 }
const INNER_RADIUS = 52
const BASE_LENGTH = 8
const MAX_EXTRA = 34

const hourMap = computed(() => {
  return new Map(props.hours.map(hour => [hour.hour, hour]))
})

const maxCount = computed(() => {
  const counts = props.hours.map(hour => hour.count || 0)
  return Math.max(...counts, 1)
})

const COLOR_STOPS = [
  { hour: 0, color: [30, 58, 138] },
  { hour: 5, color: [14, 165, 233] },
  { hour: 9, color: [56, 189, 248] },
  { hour: 12, color: [250, 204, 21] },
  { hour: 15, color: [249, 115, 22] },
  { hour: 18, color: [168, 85, 247] },
  { hour: 21, color: [99, 102, 241] },
  { hour: 24, color: [30, 58, 138] }
]

const mix = (start: number, end: number, ratio: number) => {
  return Math.round(start + (end - start) * ratio)
}

const getHourColor = (hour: number) => {
  const h = ((hour % 24) + 24) % 24
  let start = COLOR_STOPS[0]
  let end = COLOR_STOPS[COLOR_STOPS.length - 1]
  for (let i = 0; i < COLOR_STOPS.length - 1; i++) {
    if (h >= COLOR_STOPS[i].hour && h <= COLOR_STOPS[i + 1].hour) {
      start = COLOR_STOPS[i]
      end = COLOR_STOPS[i + 1]
      break
    }
  }
  const span = end.hour - start.hour || 1
  const ratio = (h - start.hour) / span
  const r = mix(start.color[0], end.color[0], ratio)
  const g = mix(start.color[1], end.color[1], ratio)
  const b = mix(start.color[2], end.color[2], ratio)
  return `rgb(${r}, ${g}, ${b})`
}

const bars = computed(() => {
  const max = maxCount.value || 1

  return Array.from({ length: 24 }, (_, hour) => {
    const data = hourMap.value.get(hour)
    const count = data?.count || 0
    const ratio = max > 0 ? count / max : 0
    const length = BASE_LENGTH + ratio * MAX_EXTRA
    const angle = (hour / 24) * 360 - 90
    const rad = (angle * Math.PI) / 180
    const inner = INNER_RADIUS
    const outer = INNER_RADIUS + length
    const x1 = CENTER.x + inner * Math.cos(rad)
    const y1 = CENTER.y + inner * Math.sin(rad)
    const x2 = CENTER.x + outer * Math.cos(rad)
    const y2 = CENTER.y + outer * Math.sin(rad)
    const color = getHourColor(hour)
    const opacity = 0.35 + ratio * 0.65
    const lengthValue = Math.hypot(x2 - x1, y2 - y1)

    return {
      hour,
      count,
      x1,
      y1,
      x2,
      y2,
      color,
      length: lengthValue,
      delay: hour * 18,
      opacity: Number(opacity.toFixed(2)),
      label: `${hour}:00 - ${count}`
    }
  })
})

const labels = computed(() => {
  const labelHours = [0, 6, 12, 18]
  const radius = 92

  return labelHours.map(hour => {
    const angle = (hour / 24) * 360 - 90
    const rad = (angle * Math.PI) / 180
    return {
      text: `${hour}`,
      x: CENTER.x + radius * Math.cos(rad),
      y: CENTER.y + radius * Math.sin(rad)
    }
  })
})
</script>
