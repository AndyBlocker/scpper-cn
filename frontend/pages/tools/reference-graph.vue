<template>
  <div class="max-w-5xl mx-auto w-full py-12 space-y-8">
    <div class="space-y-2 text-center sm:text-left">
      <div class="inline-flex items-center gap-2 rounded-full border border-dashed border-[rgba(var(--accent),0.35)] bg-[rgba(var(--accent),0.08)] px-4 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--accent))]">
        <span>实验功能</span>
      </div>
      <h1 class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50 sm:text-4xl">引用网络实验工具</h1>
      <p class="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300 max-w-3xl">
        这是一个实验性工具，用图形化的方式展示页面之间的引用关系，帮助你理解作品之间的互联结构。
        数据仍在持续完善，欢迎在尝试后反馈体验。
      </p>
    </div>

    <ClientOnly>
      <ReferenceGraphTool />
      <template #fallback>
        <div class="rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white/80 dark:bg-neutral-900/70 p-6 text-sm text-neutral-500 dark:text-neutral-400">
          加载引用网络组件中…
        </div>
      </template>
    </ClientOnly>
  </div>
</template>

<script setup lang="ts">
import { defineAsyncComponent } from 'vue'
import { useHead } from 'nuxt/app'

const ReferenceGraphTool = defineAsyncComponent(() => import('~/legacy/reference-graph/PageReferenceGraphTool.vue'))

useHead({
  title: '引用网络实验 - SCPPER-CN'
})
</script>
