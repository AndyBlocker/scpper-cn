<template>
  <div class="max-w-7xl mx-auto w-full py-8 px-4 sm:px-6 space-y-6">
    <TextAnalysisHeader />

    <div v-if="activeTab === 'vocabulary'" class="space-y-6">
      <ClientOnly>
        <VocabularyScatter />
        <template #fallback><LoadingPlaceholder label="PMI×熵散点图" /></template>
      </ClientOnly>
      <ClientOnly>
        <ZipfDeviation />
        <template #fallback><LoadingPlaceholder label="Zipf偏差分析" /></template>
      </ClientOnly>
    </div>

    <div v-else-if="activeTab === 'tags'" class="space-y-6">
      <ClientOnly>
        <TagVocabularyHeatmap />
        <template #fallback><LoadingPlaceholder label="标签词汇热力图" /></template>
      </ClientOnly>
      <ClientOnly>
        <DialectComparison />
        <template #fallback><LoadingPlaceholder label="方言对比" /></template>
      </ClientOnly>
    </div>

    <div v-else-if="activeTab === 'evolution'" class="space-y-6">
      <ClientOnly>
        <VocabularyEvolution />
        <template #fallback><LoadingPlaceholder label="词汇演化" /></template>
      </ClientOnly>
      <ClientOnly>
        <MemeWordSpread />
        <template #fallback><LoadingPlaceholder label="模因词传播" /></template>
      </ClientOnly>
    </div>

    <div v-else-if="activeTab === 'authors'" class="space-y-6">
      <ClientOnly>
        <AuthorFingerprints />
        <template #fallback><LoadingPlaceholder label="作者指纹" /></template>
      </ClientOnly>
    </div>

    <div v-else-if="activeTab === 'quality'" class="space-y-6">
      <ClientOnly>
        <QualityRichness />
        <template #fallback><LoadingPlaceholder label="质量丰富度" /></template>
      </ClientOnly>
      <ClientOnly>
        <CreativityRanking />
        <template #fallback><LoadingPlaceholder label="创意密度排行" /></template>
      </ClientOnly>
    </div>

    <div v-else-if="activeTab === 'emotion'" class="space-y-6">
      <ClientOnly>
        <EmotionTemperature />
        <template #fallback><LoadingPlaceholder label="情绪温度" /></template>
      </ClientOnly>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TextAnalysisTab } from '~/types/text-analysis'
import { useQueryTab } from '~/composables/useQueryTab'

const { activeTab } = useQueryTab<TextAnalysisTab>({ defaultTab: 'vocabulary' })

// Simple fallback component for loading state
const LoadingPlaceholder = defineComponent({
  props: { label: { type: String, default: '图表' } },
  setup(props) {
    return () => h('div', {
      class: 'h-64 flex items-center justify-center text-neutral-500 dark:text-neutral-400 border border-neutral-200 dark:border-neutral-800 rounded-xl bg-white dark:bg-neutral-900'
    }, `${props.label}加载中...`)
  }
})
</script>
