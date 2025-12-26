<template>
  <span>{{ count.toLocaleString() }}</span>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch } from 'vue'

const props = withDefaults(defineProps<{
  end: number
  duration?: number
}>(), {
  duration: 2000
})

const count = ref(0)
let animationFrame: number | null = null
let startTime: number | null = null

const startAnimation = () => {
  startTime = Date.now()
  const animate = () => {
    if (!startTime) return
    const elapsed = Date.now() - startTime
    const progress = Math.min(elapsed / props.duration, 1)
    count.value = Math.floor(props.end * progress)

    if (progress < 1) {
      animationFrame = requestAnimationFrame(animate)
    } else {
      count.value = props.end
    }
  }
  animate()
}

onMounted(() => {
  startAnimation()
})

watch(() => props.end, () => {
  if (animationFrame) cancelAnimationFrame(animationFrame)
  startAnimation()
})

onUnmounted(() => {
  if (animationFrame) cancelAnimationFrame(animationFrame)
})
</script>
