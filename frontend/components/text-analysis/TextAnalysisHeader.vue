<template>
  <div class="space-y-5">
    <div class="space-y-2">
      <div class="inline-flex items-center gap-2 rounded-full border border-[var(--g-accent-border)] bg-[var(--g-accent-soft)] px-4 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--g-accent)]">
        <span>Text Lab</span>
      </div>
      <h1 class="text-2xl font-semibold text-neutral-900 dark:text-neutral-50 sm:text-3xl">
        文本分析实验室
      </h1>
      <p class="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300 max-w-2xl">
        基于全站 {{ meta?.totalPages?.toLocaleString() || '—' }} 篇页面的文本内容，
        从词汇统计、作者指纹、语义网络等维度探索 SCP 中文站的文字特征。
      </p>
    </div>

    <!-- Tab bar -->
    <nav class="flex flex-wrap gap-1 border-b border-neutral-200 dark:border-neutral-800">
      <button
        v-for="tab in TEXT_ANALYSIS_TABS"
        :key="tab.key"
        @click="setTab(tab.key)"
        class="relative px-4 py-2.5 text-sm font-medium transition-colors"
        :class="activeTab === tab.key
          ? 'text-[var(--g-accent)]'
          : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-200'"
      >
        {{ tab.label }}
        <span
          v-if="activeTab === tab.key"
          class="absolute bottom-0 left-0 right-0 h-0.5 bg-[var(--g-accent)] rounded-full"
        />
      </button>
    </nav>
  </div>
</template>

<script setup lang="ts">
import type { TextAnalysisTab, TextAnalysisMeta } from '~/types/text-analysis'
import { TEXT_ANALYSIS_TABS } from '~/types/text-analysis'
import { useQueryTab } from '~/composables/useQueryTab'

const { activeTab, setTab } = useQueryTab<TextAnalysisTab>({ defaultTab: 'vocabulary' })
const textAnalysisMetaEndpoint: string = '/api/text-analysis/meta'

const { data: meta } = useAsyncData<TextAnalysisMeta>('text-analysis-meta', () =>
  $fetch<TextAnalysisMeta>(textAnalysisMetaEndpoint)
)
</script>
