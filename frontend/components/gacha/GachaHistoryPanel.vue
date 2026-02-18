<script setup lang="ts">
import type { HistoryItem } from '~/types/gacha'
import { formatDate } from '~/utils/gachaFormatters'
import { rarityLabel, rarityChipClassMap, rarityChipDotClassMap } from '~/utils/gachaRarity'
import { displayCardTitle } from '~/utils/gachaTitle'
import { UiButton } from '~/components/ui/button'

defineProps<{
  history: HistoryItem[]
}>()

const emit = defineEmits<{
  refresh: []
}>()
</script>

<template>
  <section class="surface-card p-3 sm:p-4">
    <header class="gacha-panel-head">
      <h3 class="gacha-panel-title">抽卡记录</h3>
      <UiButton variant="outline" size="sm" @click="emit('refresh')">刷新</UiButton>
    </header>

    <TransitionGroup v-if="history.length" name="gacha-list" tag="div" class="mt-3 space-y-2">
      <article
        v-for="record in history"
        :key="record.id"
        class="rounded-xl border border-neutral-200/70 bg-neutral-50/80 p-2 dark:border-neutral-800/70 dark:bg-neutral-900/60"
      >
        <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-300">
          <span>{{ formatDate(record.createdAt) }}</span>
          <span>{{ record.poolName || '卡池' }}</span>
          <span>{{ record.count }} / {{ record.tokensSpent }}T</span>
        </div>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <span
            v-for="(item, index) in record.items"
            :key="`${record.id}-${item.cardId}-${index}`"
            class="inline-flex items-center gap-1 rounded-full border px-2 py-1 text-xs font-semibold"
            :class="rarityChipClassMap[item.rarity] || rarityChipClassMap.WHITE"
          >
            <span class="h-2 w-2 rounded-full" :class="rarityChipDotClassMap[item.rarity] || rarityChipDotClassMap.WHITE" />
            <span class="max-w-[9rem] truncate">{{ displayCardTitle(item.title) }}</span>
            <span>{{ rarityLabel(item.rarity) }}</span>
          </span>
        </div>
      </article>
    </TransitionGroup>

    <p v-else class="gacha-empty mt-3">无记录</p>
  </section>
</template>
