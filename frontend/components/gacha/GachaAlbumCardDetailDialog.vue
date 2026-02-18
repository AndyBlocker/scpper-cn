<script setup lang="ts">
import { computed } from 'vue'
import type { AlbumPageVariant } from '~/types/gacha'
import GachaCard from '~/components/gacha/GachaCard.vue'
import GachaAffixChip from '~/components/gacha/GachaAffixChip.vue'
import { UiButton } from '~/components/ui/button'
import {
  UiDialogRoot,
  UiDialogPortal,
  UiDialogOverlay,
  UiDialogContent,
  UiDialogClose
} from '~/components/ui/dialog'
import {
  resolveAffixParts,
  formatAffixPartsLabel,
  resolvePrimaryAffixStyleFromSource,
  resolveAffixPerkSummary
} from '~/utils/gachaAffix'
import { formatPlacementPercent, formatTokenDecimal, formatTokens } from '~/utils/gachaFormatters'
import { rarityLabel } from '~/utils/gachaRarity'
import { estimateVariantDismantlePerCard } from '~/utils/gachaAffix'
import { displayCardTitle } from '~/utils/gachaTitle'

const props = defineProps<{
  open: boolean
  card: AlbumPageVariant | null
  pageUrl: string | null
  lockBusy?: boolean
  dismantleBusy?: boolean
}>()

const emit = defineEmits<{
  close: []
  lock: [cardId: string, affixSignature: string]
  unlock: [cardId: string, affixSignature: string]
  dismantleOne: []
}>()

const affixParts = computed(() => {
  if (!props.card) return []
  return resolveAffixParts(props.card).filter((part) => part.style !== 'NONE')
})

const affixLabel = computed(() => {
  if (!props.card) return '标准'
  return formatAffixPartsLabel(props.card)
})

const primaryStyle = computed(() => {
  if (!props.card) return 'NONE'
  return resolvePrimaryAffixStyleFromSource(props.card)
})

const affixPerkSummary = computed(() => {
  if (!props.card) return '标准词条：当前无额外挂机加成'
  return resolveAffixPerkSummary(props.card, primaryStyle.value)
})

const visibleDetailTags = computed(() =>
  (props.card?.tags ?? []).filter((tag) => {
    const normalized = String(tag || '').trim()
    return normalized.length > 0 && !normalized.startsWith('_')
  })
)

const dismantleRewardPerCard = computed(() =>
  props.card ? estimateVariantDismantlePerCard(props.card) : 0
)

const dismantleRewardStack = computed(() =>
  dismantleRewardPerCard.value * Math.max(0, Number(props.card?.count || 0))
)

const ownedDisplay = computed(() => {
  const total = Math.max(0, Number(props.card?.count || 0))
  return `${total} 张`
})

const freeCount = computed(() => {
  const total = Math.max(0, Number(props.card?.count || 0))
  const locked = Math.max(0, Number(props.card?.lockedCount || 0))
  return Math.max(0, total - locked)
})

const actionBusy = computed(() => !!props.lockBusy || !!props.dismantleBusy)
const canDismantleOne = computed(() => !!props.card && freeCount.value > 0 && !actionBusy.value)

const isAlternateArt = computed(() => props.card?.isAlternateArt ?? false)
const imageIndex = computed(() => props.card?.imageIndex ?? 0)

const displayTitleText = computed(() =>
  props.card ? displayCardTitle(props.card.title) : '--'
)
</script>

<template>
  <UiDialogRoot :open="open" @update:open="(nextOpen) => { if (!nextOpen) emit('close') }">
    <UiDialogPortal>
      <UiDialogOverlay />
      <UiDialogContent class="max-w-4xl p-0">
        <header class="flex flex-wrap items-start justify-between gap-3 border-b border-neutral-200/60 px-5 py-4 dark:border-neutral-800/70">
          <div class="min-w-0">
            <p class="text-[11px] font-semibold uppercase tracking-[0.14em] text-cyan-700 dark:text-cyan-200">Card Detail</p>
            <h3 class="mt-1 truncate text-lg font-semibold text-neutral-900 dark:text-neutral-50">
              {{ displayTitleText }}
              <span
                v-if="isAlternateArt"
                class="ml-1.5 inline-flex items-center rounded-full bg-violet-100 px-2 py-0.5 text-[10px] font-semibold text-violet-700 dark:bg-violet-500/20 dark:text-violet-200"
              >
                异画 #{{ imageIndex + 1 }}
              </span>
            </h3>
            <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              {{ props.card ? `${rarityLabel(props.card.rarity)} · 持有 ${ownedDisplay} · 可分解 ${freeCount} 张` : '' }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <button
              v-if="props.card"
              type="button"
              class="inline-flex items-center justify-center rounded-xl border px-3 py-1.5 text-xs font-medium transition"
              :class="actionBusy
                ? 'cursor-not-allowed border-neutral-200 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500'
                : 'border-amber-300 bg-amber-50 text-amber-700 hover:border-amber-400 hover:bg-amber-100 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200 dark:hover:border-amber-400/60'"
              :disabled="actionBusy"
              @click="emit('lock', props.card!.cardId, props.card!.affixSignature || 'NONE')"
            >
              {{ actionBusy ? '...' : '锁定全部' }}
            </button>
            <button
              v-if="props.card"
              type="button"
              class="inline-flex items-center justify-center rounded-xl border px-3 py-1.5 text-xs font-medium transition"
              :class="actionBusy
                ? 'cursor-not-allowed border-neutral-200 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500'
                : 'border-neutral-200 text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50'"
              :disabled="actionBusy"
              @click="emit('unlock', props.card!.cardId, props.card!.affixSignature || 'NONE')"
            >
              {{ actionBusy ? '...' : '解锁全部' }}
            </button>
            <button
              v-if="props.card"
              type="button"
              class="inline-flex items-center justify-center rounded-xl border px-3 py-1.5 text-xs font-medium transition"
              :class="canDismantleOne
                ? 'border-rose-300 bg-rose-50 text-rose-700 hover:border-rose-400 hover:bg-rose-100 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200 dark:hover:border-rose-400/60'
                : 'cursor-not-allowed border-neutral-200 text-neutral-400 dark:border-neutral-700 dark:text-neutral-500'"
              :disabled="!canDismantleOne"
              @click="emit('dismantleOne')"
            >
              {{ props.dismantleBusy ? '分解中...' : '分解一张' }}
            </button>
            <NuxtLink
              v-if="pageUrl"
              :to="pageUrl"
              class="inline-flex items-center justify-center rounded-xl border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50"
            >
              查看页面
            </NuxtLink>
            <UiDialogClose as-child>
              <UiButton variant="ghost" size="sm" class="h-9 w-9 rounded-full p-0" aria-label="关闭卡片详情">
                X
              </UiButton>
            </UiDialogClose>
          </div>
        </header>

        <div class="max-h-[calc(100vh-5rem)] max-h-[calc(100dvh-5rem)] overflow-y-auto px-5 pb-5 pt-4">
          <div v-if="props.card" class="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)] lg:items-start">
            <GachaCard
              :title="props.card.title"
              :rarity="props.card.rarity"
              :tags="props.card.tags"
              :authors="props.card.authors"
              :wikidot-id="props.card.wikidotId"
              :image-url="props.card.imageUrl || undefined"
              variant="large"
              :affix-visual-style="props.card.affixVisualStyle"
              :affix-signature="props.card.affixSignature"
              :affix-styles="props.card.affixStyles"
              :affix-style-counts="props.card.affixStyleCounts"
              :affix-label="props.card.affixLabel"
            />

            <section class="space-y-3 rounded-2xl border border-neutral-200/70 bg-white/80 p-3 dark:border-neutral-700/70 dark:bg-neutral-900/60">
              <div class="flex flex-wrap gap-1.5 text-[11px]">
                <GachaAffixChip
                  v-for="part in affixParts"
                  :key="`detail-affix-${part.style}-${part.count}`"
                  :style="part.style"
                  :count="part.count"
                />
                <span
                  v-if="!affixParts.length"
                  class="inline-flex items-center rounded-full border border-neutral-200 bg-neutral-100 px-2 py-0.5 text-[10px] font-semibold text-neutral-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                >
                  标准
                </span>
              </div>

              <div class="space-y-1.5 text-xs text-neutral-600 dark:text-neutral-300">
                <p>词条：{{ affixLabel }}</p>
                <p>{{ affixPerkSummary }}</p>
              </div>

              <dl class="grid gap-1.5 text-xs sm:grid-cols-2">
                <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                  <dt class="text-neutral-500 dark:text-neutral-400">卡片 ID</dt>
                  <dd class="mt-0.5 font-mono text-neutral-800 dark:text-neutral-100">{{ props.card.cardId }}</dd>
                </div>
                <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                  <dt class="text-neutral-500 dark:text-neutral-400">单张分解返还</dt>
                  <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">{{ formatTokens(dismantleRewardPerCard) }} Token</dd>
                </div>
                <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                  <dt class="text-neutral-500 dark:text-neutral-400">该变体总返还（{{ props.card.count }} 张）</dt>
                  <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">{{ formatTokens(dismantleRewardStack) }} Token</dd>
                </div>
                <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                  <dt class="text-neutral-500 dark:text-neutral-400">挂机构成加成</dt>
                  <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">
                    收益 +{{ formatPlacementPercent(props.card.affixYieldBoostPercent || 0) }}
                    · 缓冲 +{{ formatTokens(props.card.affixOfflineBufferBonus || 0) }}
                    · 分解 +{{ formatPlacementPercent(props.card.affixDismantleBonusPercent || 0) }}
                  </dd>
                </div>
                <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                  <dt class="text-neutral-500 dark:text-neutral-400">基础返还</dt>
                  <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">{{ formatTokenDecimal(props.card.rewardTokens || 0, 0) }} Token</dd>
                </div>
                <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/90 px-2.5 py-2 dark:border-neutral-700/70 dark:bg-neutral-800/70">
                  <dt class="text-neutral-500 dark:text-neutral-400">页面编号</dt>
                  <dd class="mt-0.5 font-semibold text-neutral-800 dark:text-neutral-100">
                    {{ props.card.wikidotId != null ? `wikidot #${props.card.wikidotId}` : (props.card.pageId != null ? `page #${props.card.pageId}` : '--') }}
                  </dd>
                </div>
              </dl>

              <div v-if="visibleDetailTags.length" class="flex flex-wrap gap-1.5 text-[11px]">
                <span
                  v-for="tag in visibleDetailTags"
                  :key="`detail-tag-${tag}`"
                  class="inline-flex items-center rounded-full border border-neutral-200 bg-white/90 px-2 py-0.5 font-medium text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                >
                  #{{ tag }}
                </span>
              </div>
            </section>
          </div>
        </div>
      </UiDialogContent>
    </UiDialogPortal>
  </UiDialogRoot>
</template>
