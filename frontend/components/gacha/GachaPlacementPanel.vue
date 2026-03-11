<script setup lang="ts">
import { computed } from 'vue'
import type { PlacementComboBonus, PlacementOverview } from '~/types/gacha'
import { formatTokens, formatTokenDecimal, formatPlacementPercent } from '~/utils/gachaFormatters'
import GachaCard from '~/components/gacha/GachaCard.vue'
import { UiButton } from '~/components/ui/button'

const props = defineProps<{
  placement: PlacementOverview | null
  loading: boolean
  claiming: boolean
  unlocking: boolean
  slotUpdating: number | null
  addonUpdating: boolean
}>()

const emit = defineEmits<{
  refresh: [force: boolean]
  claim: []
  'unlock-slot': []
  'open-picker': [slotIndex: number]
  'clear-slot': [slotIndex: number]
  'open-addon-picker': []
  'clear-addon': []
}>()

const colorlessAddon = computed(() =>
  (props.placement?.addons ?? []).find((addon) => addon.kind === 'COLORLESS') ?? null
)

const unlockedSlots = computed(() => {
  const slotCount = Math.max(0, Number(props.placement?.slotCount ?? 0))
  return (props.placement?.slots ?? []).filter((slot) => slot.slotIndex <= slotCount)
})

const filledSlotCount = computed(() =>
  unlockedSlots.value.filter((slot) => Boolean(slot.card)).length
)

function storagePercent(snapshot: PlacementOverview | null | undefined) {
  const cap = Number(snapshot?.cap ?? 0)
  if (!Number.isFinite(cap) || cap <= 0) return 0
  const pending = Number(snapshot?.pendingToken ?? 0)
  if (!Number.isFinite(pending) || pending <= 0) return 0
  return Math.max(0, Math.min(100, (pending / cap) * 100))
}

const storageUsagePercent = computed(() => storagePercent(props.placement))
const remainingStorage = computed(() => {
  const cap = Number(props.placement?.cap ?? 0)
  const pending = Number(props.placement?.pendingToken ?? 0)
  if (!Number.isFinite(cap) || cap <= 0) return 0
  if (!Number.isFinite(pending) || pending <= 0) return cap
  return Math.max(0, cap - pending)
})

const estimatedStorageFullHours = computed(() => {
  const yieldPerHour = Number(props.placement?.estimatedYieldPerHour ?? 0)
  if (!Number.isFinite(yieldPerHour) || yieldPerHour <= 0) return null
  return remainingStorage.value / yieldPerHour
})

function formatEtaLabel(hours: number | null) {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return '--'
  if (hours < 1) return `${formatTokenDecimal(hours * 60, 0)} 分钟`
  if (hours < 24) return `${formatTokenDecimal(hours, 1)} 小时`
  return `${formatTokenDecimal(hours / 24, 1)} 天`
}

function yieldShare(yieldPerHour: number | null | undefined) {
  const total = Number(props.placement?.estimatedYieldPerHour ?? 0)
  const current = Number(yieldPerHour ?? 0)
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(current) || current <= 0) return '0%'
  return formatPlacementPercent(current / total, 1)
}

const anyBusy = computed(() =>
  props.loading || props.claiming || props.slotUpdating != null || props.addonUpdating || props.unlocking
)

const hasSameTagCombo = computed(() =>
  (props.placement?.comboBonuses ?? []).some((bonus) => String(bonus.key || '').startsWith('SAME_TAG_'))
)

const hasSameAuthorCombo = computed(() =>
  (props.placement?.comboBonuses ?? []).some((bonus) => String(bonus.key || '').startsWith('SAME_AUTHOR_'))
)

const hasCappedComboRules = computed(() => hasSameTagCombo.value || hasSameAuthorCombo.value)

type PlacementComboDisplayBonus = PlacementComboBonus & {
  inlineSummary?: boolean
}

function parseComboGroupType(key: string): 'SAME_AUTHOR' | 'SAME_TAG' | null {
  if (key.startsWith('SAME_AUTHOR_')) return 'SAME_AUTHOR'
  if (key.startsWith('SAME_TAG_')) return 'SAME_TAG'
  return null
}

function parseComboDetailItem(type: 'SAME_AUTHOR' | 'SAME_TAG', label: string): string | null {
  const match = type === 'SAME_AUTHOR'
    ? label.match(/^同作者 x(\d+)（(.+)）$/)
    : label.match(/^同标签 x(\d+)（(.+)）$/)
  if (!match) return null
  const tierCount = Number(match[1] ?? 0)
  const name = String(match[2] ?? '').trim()
  if (!Number.isFinite(tierCount) || tierCount <= 0 || !name) return null
  return `${name}*${tierCount}`
}

const groupedComboBonuses = computed<PlacementComboDisplayBonus[]>(() => {
  const rawBonuses = props.placement?.comboBonuses ?? []
  if (rawBonuses.length <= 1) {
    return rawBonuses as PlacementComboDisplayBonus[]
  }

  const groupedData = new Map<'SAME_AUTHOR' | 'SAME_TAG', { total: number; details: string[] }>()
  for (const bonus of rawBonuses) {
    const key = String(bonus.key || '')
    const type = parseComboGroupType(key)
    if (!type) continue
    if (!groupedData.has(type)) {
      groupedData.set(type, { total: 0, details: [] })
    }
    const group = groupedData.get(type)!
    group.total += Number(bonus.yieldBoostPercent ?? 0)
    const detail = parseComboDetailItem(type, String(bonus.label || ''))
    if (detail && !group.details.includes(detail)) {
      group.details.push(detail)
    }
  }

  const mergedTypes = new Set<'SAME_AUTHOR' | 'SAME_TAG'>()
  const displayBonuses: PlacementComboDisplayBonus[] = []
  for (const bonus of rawBonuses) {
    const key = String(bonus.key || '')
    const type = parseComboGroupType(key)
    if (!type) {
      displayBonuses.push(bonus as PlacementComboDisplayBonus)
      continue
    }
    if (mergedTypes.has(type)) continue
    mergedTypes.add(type)
    const group = groupedData.get(type)
    if (!group) {
      displayBonuses.push(bonus as PlacementComboDisplayBonus)
      continue
    }
    const detailText = group.details.join('，')
    const totalText = formatPlacementPercent(group.total)
    const label = type === 'SAME_AUTHOR'
      ? `同作者（${detailText ? `${detailText}，` : ''}总计 +${totalText}）`
      : `同标签（${detailText ? `${detailText}，` : ''}总计 +${totalText}）`
    displayBonuses.push({
      key: `${type}_GROUPED`,
      label,
      yieldBoostPercent: group.total,
      inlineSummary: true
    })
  }

  return displayBonuses
})
</script>

<template>
  <section class="surface-card placement-lab p-3 sm:p-4">
    <header class="placement-hero rounded-lg border border-neutral-200/75 bg-gradient-to-br from-cyan-50 via-white to-emerald-50 p-4 dark:border-neutral-700/70 dark:from-cyan-500/10 dark:via-neutral-900/75 dark:to-emerald-500/10">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="space-y-1.5">
          <p class="text-[11px] font-semibold uppercase tracking-[0.2em] text-cyan-700 dark:text-cyan-200">Idle Engine</p>
          <h3 class="gacha-panel-title text-xl">放置产出面板</h3>
          <p class="text-xs text-neutral-500 dark:text-neutral-400">
            {{ placement ? `${placement.slotCount} / ${placement.slotMaxCount || 10} 槽位 + 无色词条槽` : '可解锁 5~10 槽位 + 无色词条槽' }}
          </p>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <UiButton
            variant="outline"
            size="sm"
            class="bg-white/80 dark:bg-neutral-900/70"
            :disabled="anyBusy"
            @click="emit('refresh', true)"
          >
            刷新
          </UiButton>
          <UiButton
            variant="outline"
            size="sm"
            class="border-cyan-200 bg-cyan-50/70 text-cyan-700 hover:border-cyan-300 hover:text-cyan-900 dark:border-cyan-500/45 dark:bg-cyan-500/12 dark:text-cyan-200 dark:hover:border-cyan-400 dark:hover:text-cyan-100"
            :disabled="!placement?.nextUnlockCost || anyBusy"
            @click="emit('unlock-slot')"
          >
            <span v-if="unlocking">解锁中...</span>
            <span v-else-if="placement?.nextUnlockCost">解锁槽位（{{ formatTokens(placement.nextUnlockCost) }} Token）</span>
            <span v-else>槽位已满</span>
          </UiButton>
          <UiButton
            size="sm"
            :disabled="claiming || anyBusy || !placement || placement.claimableToken <= 0"
            @click="emit('claim')"
          >
            <span v-if="claiming">领取中...</span>
            <span v-else>领取 {{ formatTokenDecimal(placement?.claimableToken || 0, 2) }} Token</span>
          </UiButton>
        </div>
      </div>

      <div v-if="placement" class="mt-3 space-y-2.5">
        <div class="rounded-xl border border-neutral-200/70 bg-white/80 p-3 dark:border-neutral-700/70 dark:bg-neutral-900/70">
          <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span>缓存池占用</span>
            <strong class="text-sm text-neutral-900 dark:text-neutral-100">{{ formatTokenDecimal(placement.pendingToken, 3) }} / {{ formatTokens(placement.cap) }} Token</strong>
          </div>
          <div class="mt-2 h-2 overflow-hidden rounded-full bg-neutral-200/70 dark:bg-neutral-800/75">
            <div
              class="h-full rounded-full bg-gradient-to-r from-cyan-400 via-sky-400 to-emerald-400 transition-all duration-500"
              :style="{ width: `${storageUsagePercent}%` }"
            />
          </div>
          <div class="mt-2 grid gap-2 text-[11px] text-neutral-600 sm:grid-cols-3 dark:text-neutral-300">
            <div class="placement-brief-pill">可领 {{ formatTokenDecimal(placement.claimableToken, 2) }} Token</div>
            <div class="placement-brief-pill">剩余 {{ formatTokenDecimal(remainingStorage, 2) }} Token</div>
            <div class="placement-brief-pill">预计满仓 {{ formatEtaLabel(estimatedStorageFullHours) }}</div>
          </div>
        </div>

        <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <div class="placement-metric-pill">每小时产能 {{ formatTokenDecimal(placement.estimatedYieldPerHour, 2) }}</div>
          <div class="placement-metric-pill">总收益加成 {{ formatPlacementPercent(placement.yieldBoostPercent) }}</div>
          <div class="placement-metric-pill">离线缓冲 +{{ formatTokens(placement.offlineBufferBonus || 0) }}</div>
          <div class="placement-metric-pill">槽位 {{ filledSlotCount }} / {{ placement.slotCount }}</div>
        </div>
      </div>
    </header>

    <div v-if="placement" class="mt-4 space-y-4">
      <div v-if="placement.comboBonuses?.length" class="rounded-lg border border-amber-200/70 bg-amber-50/80 p-3 text-xs text-amber-800 dark:border-amber-500/35 dark:bg-amber-500/12 dark:text-amber-100">
        <p class="font-semibold">已触发挂机组合</p>
        <p v-if="hasCappedComboRules" class="mt-1 text-[11px] text-amber-700/90 dark:text-amber-100/85">
          同作者/同标签规则：额外组合按强度递减，同类型总加成上限为 +25%。
        </p>
        <div class="mt-2 flex flex-wrap gap-2">
          <span
            v-for="bonus in groupedComboBonuses"
            :key="bonus.key"
            class="inline-flex items-center rounded-full border border-amber-300/70 bg-white/70 px-2.5 py-1 text-[11px] font-semibold text-amber-700 dark:border-amber-500/45 dark:bg-neutral-900/50 dark:text-amber-200"
          >
            {{ bonus.label }}<template v-if="!bonus.inlineSummary"> · +{{ formatPlacementPercent(bonus.yieldBoostPercent) }}</template>
          </span>
        </div>
      </div>

      <div class="placement-slot-grid">
        <article class="placement-slot">
          <div class="placement-slot-head">
            <p class="placement-slot-label">无色槽</p>
            <div class="placement-slot-head-metrics">
              <span v-if="colorlessAddon" class="placement-slot-yield" :title="`${formatTokenDecimal(colorlessAddon.yieldPerHour || 0, 2)} Token/h`">
                +{{ formatTokenDecimal(colorlessAddon.yieldPerHour || 0, 2) }}/h
              </span>
              <span v-else class="placement-slot-share">未挂载</span>
            </div>
          </div>

          <div v-if="colorlessAddon" class="mt-2 placement-card-only placement-card-only--slot">
            <GachaCard
              :title="colorlessAddon.card.title"
              :rarity="colorlessAddon.card.rarity"
              :tags="colorlessAddon.card.tags ?? []"
              :authors="colorlessAddon.card.authors"
              :image-url="colorlessAddon.card.imageUrl || undefined"
              :wikidot-id="colorlessAddon.card.wikidotId"
              :locked="colorlessAddon.card.isLocked"
              :retired="colorlessAddon.card.isRetired"
              variant="mini"
              :hide-footer="true"
              :affix-visual-style="colorlessAddon.card.affixVisualStyle"
              :affix-signature="colorlessAddon.card.affixSignature"
              :affix-styles="colorlessAddon.card.affixStyles"
              :affix-style-counts="colorlessAddon.card.affixStyleCounts"
              :affix-label="colorlessAddon.card.affixLabel"
            />
          </div>
          <div v-else class="gacha-empty mt-2 text-center text-xs">
            尚未挂载无色词条卡。
          </div>

          <div class="placement-slot-actions mt-3">
            <UiButton
              type="button"
              variant="outline"
              size="sm"
              class="flex-1 h-8 rounded-lg"
              :disabled="anyBusy"
              @click="emit('open-addon-picker')"
            >
              {{ colorlessAddon ? '更换卡片' : '选择卡片' }}
            </UiButton>
            <UiButton
              type="button"
              variant="outline"
              size="sm"
              class="h-8 rounded-lg px-2.5"
              :disabled="anyBusy || !colorlessAddon"
              @click="emit('clear-addon')"
            >
              清空
            </UiButton>
          </div>
        </article>

        <article
          v-for="slot in unlockedSlots"
          :key="`placement-slot-${slot.slotIndex}`"
          class="placement-slot"
        >
          <div class="placement-slot-head">
            <p class="placement-slot-label">Slot {{ slot.slotIndex }}</p>
            <div class="placement-slot-head-metrics">
              <span class="placement-slot-yield" :title="`${formatTokenDecimal(slot.yieldPerHour, 2)} Token/h`">
                +{{ formatTokenDecimal(slot.yieldPerHour, 2) }}/h
              </span>
              <span class="placement-slot-share">占比 {{ yieldShare(slot.yieldPerHour) }}</span>
            </div>
          </div>

          <div v-if="slot.card" class="mt-2 placement-card-only placement-card-only--slot">
            <GachaCard
              :title="slot.card.title"
              :rarity="slot.card.rarity"
              :tags="slot.card.tags ?? []"
              :authors="slot.card.authors"
              :image-url="slot.card.imageUrl || undefined"
              :wikidot-id="slot.card.wikidotId"
              :locked="slot.card.isLocked"
              :retired="slot.card.isRetired"
              variant="mini"
              :hide-footer="true"
              :affix-visual-style="slot.card.affixVisualStyle"
              :affix-signature="slot.card.affixSignature"
              :affix-styles="slot.card.affixStyles"
              :affix-style-counts="slot.card.affixStyleCounts"
              :affix-label="slot.card.affixLabel"
            />
          </div>
          <div v-else class="gacha-empty mt-2 text-center text-xs">
            当前为空槽，放入卡片后立即开始产出。
          </div>

          <div class="placement-slot-actions mt-3">
            <UiButton
              type="button"
              variant="outline"
              size="sm"
              class="flex-1 h-8 rounded-lg"
              :disabled="slotUpdating === slot.slotIndex || anyBusy"
              @click="emit('open-picker', slot.slotIndex)"
            >
              {{ slot.card ? '更换卡片' : '选择卡片' }}
            </UiButton>
            <UiButton
              type="button"
              variant="outline"
              size="sm"
              class="h-8 rounded-lg px-2.5"
              :disabled="slotUpdating === slot.slotIndex || anyBusy || !slot.card"
              @click="emit('clear-slot', slot.slotIndex)"
            >
              清空
            </UiButton>
          </div>
        </article>
      </div>
    </div>

    <p v-else class="mt-4 rounded-lg border border-dashed border-neutral-200/70 px-4 py-4 text-sm text-neutral-500 dark:border-neutral-800/70 dark:text-neutral-400">
      正在加载放置信息...
    </p>
  </section>
</template>

<style scoped>
.placement-hero {
  position: relative;
  overflow: hidden;
}

.placement-brief-pill,
.placement-metric-pill {
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 0.78rem;
  background: rgba(255, 255, 255, 0.74);
  padding: 0.35rem 0.55rem;
}

html.dark .placement-brief-pill,
html.dark .placement-metric-pill {
  border-color: rgba(100, 116, 139, 0.42);
  background: rgba(15, 23, 42, 0.6);
}

.placement-slot-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
}

.placement-slot {
  border: 1px solid rgba(148, 163, 184, 0.3);
  border-radius: 1rem;
  background: rgba(255, 255, 255, 0.76);
  padding: 0.78rem;
  display: flex;
  flex-direction: column;
  min-height: 100%;
  overflow: hidden;
}

html.dark .placement-slot {
  border-color: rgba(100, 116, 139, 0.42);
  background: rgba(15, 23, 42, 0.62);
}

.placement-slot-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.45rem;
}

.placement-slot-label {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: rgb(100 116 139);
  white-space: nowrap;
}

html.dark .placement-slot-label {
  color: rgb(148 163 184);
}

.placement-slot-head-metrics {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}

.placement-slot-yield {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid rgba(56, 189, 248, 0.4);
  background: rgba(34, 211, 238, 0.1);
  color: rgb(14 116 144);
  font-size: 9px;
  font-weight: 700;
  padding: 0.12rem 0.42rem;
  white-space: nowrap;
}

html.dark .placement-slot-yield {
  border-color: rgba(56, 189, 248, 0.45);
  background: rgba(14, 116, 144, 0.2);
  color: rgb(125 211 252);
}

.placement-slot-share {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.34);
  background: rgba(248, 250, 252, 0.75);
  color: rgb(71 85 105);
  font-size: 9px;
  font-weight: 700;
  padding: 0.12rem 0.42rem;
  white-space: nowrap;
}

html.dark .placement-slot-share {
  border-color: rgba(100, 116, 139, 0.45);
  background: rgba(15, 23, 42, 0.7);
  color: rgb(203 213 225);
}

.placement-card-only {
  display: flex;
  justify-content: center;
  overflow: hidden;
}

.placement-card-only :deep(.gacha-card) {
  width: 100%;
  max-width: 120px;
  overflow: hidden;
}

.placement-card-only :deep(.gacha-card__content) {
  min-height: 66px;
}

.placement-card-only :deep(.gacha-card__title) {
  min-height: calc(1.35em * 2);
}

.placement-card-only :deep(.gacha-card__top) {
  top: 2px;
  left: 2px;
  right: 2px;
  gap: 2px;
}

.placement-card-only :deep(.gacha-card__badge--mini) {
  padding: 0px 4px !important;
  font-size: 8px !important;
}

.placement-card-only :deep(.gacha-card__coating-chip) {
  max-width: calc(100% - 28px);
  font-size: 7px;
  padding: 1px 4px;
}

.placement-slot-actions {
  margin-top: auto;
  display: flex;
  gap: 0.5rem;
}

.placement-slot-actions > * {
  min-width: 0;
}

@media (min-width: 640px) {
  .placement-slot-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.7rem;
  }
}

@media (min-width: 900px) {
  .placement-slot-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (min-width: 1200px) {
  .placement-slot-grid {
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 0.68rem;
  }

  .placement-slot {
    padding: 0.64rem;
  }

  .placement-card-only--slot :deep(.gacha-card) {
    max-width: 140px;
  }
}

@media (max-width: 640px) {
  .placement-card-only :deep(.gacha-card) {
    max-width: 100px;
  }
}
</style>
