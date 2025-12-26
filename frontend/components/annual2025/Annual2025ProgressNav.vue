<template>
  <div class="fixed top-0 left-0 right-0 h-1 bg-[rgb(var(--panel-border))] z-50">
    <div
      class="h-full bg-gradient-to-r from-[rgb(var(--accent))] to-[rgb(var(--accent-strong))] transition-all duration-500 ease-out"
      :style="{ width: `${progressPercent}%` }"
    />
  </div>

  <div class="hidden sm:flex fixed right-2 md:right-4 top-1/2 -translate-y-1/2 z-50 flex-col gap-1.5 md:gap-2">
    <button
      v-for="(slide, idx) in slideLabels"
      :key="idx"
      @click="emit('scroll-to-slide', idx)"
      class="w-2 h-2 md:w-2.5 md:h-2.5 rounded-full transition-all hover:scale-125"
      :class="currentSlideIndex === idx
        ? 'bg-[rgb(var(--accent))] scale-125'
        : 'bg-[rgb(var(--muted))] opacity-40 hover:opacity-70'"
      :title="slide"
    />
  </div>

  <div class="sm:hidden fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 bg-[rgba(var(--bg),0.9)] backdrop-blur-md px-3 py-1.5 rounded-full border border-[rgb(var(--panel-border))]">
    <span class="text-xs text-[rgb(var(--muted))]">{{ currentSlideIndex + 1 }}/{{ totalSlides }}</span>
    <span class="text-[10px] text-[rgb(var(--accent))]">{{ slideLabels[currentSlideIndex] }}</span>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  progressPercent: number
  slideLabels: string[]
  currentSlideIndex: number
  totalSlides: number
}>()

const emit = defineEmits<{
  (e: 'scroll-to-slide', index: number): void
}>()
</script>
