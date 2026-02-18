<script setup lang="ts">
/**
 * 任务/成就目标列表面板 v2。
 * 重新设计：状态图标 + 奖励 pill + 进度百分比 + 可领取脉冲高亮。
 */
import { computed } from 'vue'
import type { MissionItem, AchievementItem } from '~/types/gacha'
import { formatTokens, formatRewardSummary } from '~/utils/gachaFormatters'
import { UiButton } from '~/components/ui/button'
import { UiProgress } from '~/components/ui/progress'

type GoalItem = MissionItem | AchievementItem

const props = withDefaults(defineProps<{
  items: GoalItem[]
  loading: boolean
  claiming: string | 'ALL' | null
  claimableCount: number
  kind: 'mission' | 'achievement'
  viewMode?: 'daily' | 'all'
}>(), {
  viewMode: 'all'
})

const emit = defineEmits<{
  claim: [goalKey: string]
  'claim-all': []
  'update:viewMode': [value: 'daily' | 'all']
}>()

const panelTitle = computed(() =>
  props.kind === 'mission' ? '每日任务' : '成就里程碑'
)

const panelSubtitle = computed(() =>
  props.kind === 'mission' ? '完成任务获取票券奖励' : '长期目标，达成即可领取'
)

const loadingText = computed(() =>
  props.kind === 'mission' ? '任务同步中...' : '成就同步中...'
)

const emptyText = computed(() =>
  props.kind === 'mission' ? '暂无可显示任务' : '暂无成就数据'
)

const progressColor = computed(() =>
  props.kind === 'mission' ? 'emerald' : 'cyan'
)

const isMission = computed(() => props.kind === 'mission')

function progressPercent(progress: number, target: number) {
  if (!target || target <= 0) return 0
  const ratio = (Number(progress || 0) / target) * 100
  return Math.max(0, Math.min(100, Number.isFinite(ratio) ? ratio : 0))
}

function goalKey(item: GoalItem) {
  return isMission.value
    ? (item as MissionItem).missionKey
    : (item as AchievementItem).achievementKey
}

function goalStatus(item: GoalItem): 'claimable' | 'claimed' | 'pending' {
  if (item.claimed) return 'claimed'
  if (item.claimable) return 'claimable'
  return 'pending'
}

function isHiddenUndiscovered(item: GoalItem): boolean {
  if (!('hidden' in item)) return false
  const a = item as AchievementItem
  return Boolean(a.hidden) && a.progress <= 0 && !a.claimed
}

function isHiddenRevealed(item: GoalItem): boolean {
  if (!('hidden' in item)) return false
  const a = item as AchievementItem
  return Boolean(a.hidden) && (a.progress > 0 || a.claimed)
}

function rewardParts(item: GoalItem) {
  const parts: { label: string; tone: string }[] = []
  const tokens = Number(item.reward?.tokens ?? 0)
  if (tokens > 0) parts.push({ label: `${formatTokens(tokens)}T`, tone: 'token' })
  const draw = Number(item.reward?.tickets?.drawTicket ?? 0)
  if (draw > 0) parts.push({ label: `${draw}单抽`, tone: 'draw' })
  const draw10 = Number(item.reward?.tickets?.draw10Ticket ?? 0)
  if (draw10 > 0) parts.push({ label: `${draw10}十连`, tone: 'draw10' })
  const reforge = Number(item.reward?.tickets?.affixReforgeTicket ?? 0)
  if (reforge > 0) parts.push({ label: `${reforge}改造`, tone: 'reforge' })
  return parts
}
</script>

<template>
  <article class="goal-panel" :class="`goal-panel--${kind}`">
    <!-- Header -->
    <header class="goal-panel__header">
      <div class="goal-panel__header-left">
        <div class="goal-panel__icon-wrap" :class="`goal-panel__icon-wrap--${kind}`">
          <!-- Mission: target icon -->
          <svg v-if="isMission" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />
          </svg>
          <!-- Achievement: trophy icon -->
          <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
            <path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20 7 22" />
            <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20 17 22" />
            <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
          </svg>
        </div>
        <div>
          <h4 class="goal-panel__title">{{ panelTitle }}</h4>
          <p class="goal-panel__subtitle">{{ panelSubtitle }}</p>
        </div>
      </div>
      <div class="goal-panel__header-actions">
        <template v-if="isMission">
          <button
            type="button"
            class="goal-panel__tab-btn"
            :class="{ 'is-active': viewMode === 'daily' }"
            @click="emit('update:viewMode', 'daily')"
          >
            每日
          </button>
          <button
            type="button"
            class="goal-panel__tab-btn"
            :class="{ 'is-active': viewMode === 'all' }"
            @click="emit('update:viewMode', 'all')"
          >
            全部
          </button>
        </template>
        <button
          type="button"
          class="goal-panel__claim-all-btn"
          :class="{ 'is-active': claimableCount > 0 && claiming == null }"
          :disabled="loading || claiming != null || claimableCount <= 0"
          @click="emit('claim-all')"
        >
          <template v-if="claiming === 'ALL'">
            <span class="goal-panel__spinner" />领取中
          </template>
          <template v-else>
            全部领取
            <span v-if="claimableCount > 0" class="goal-panel__claim-badge">{{ claimableCount }}</span>
          </template>
        </button>
      </div>
    </header>

    <!-- Loading -->
    <div v-if="loading" class="goal-panel__placeholder">
      <div class="goal-skeleton" />
      <div class="goal-skeleton" />
      <div class="goal-skeleton goal-skeleton--short" />
    </div>

    <!-- Empty -->
    <div v-else-if="!items.length" class="goal-panel__empty">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.35">
        <path d="M12 2L2 7l10 5 10-5-10-5Z" /><path d="m2 17 10 5 10-5" /><path d="m2 12 10 5 10-5" />
      </svg>
      <span>{{ emptyText }}</span>
    </div>

    <!-- Goal List -->
    <TransitionGroup v-else name="goal-item" tag="ul" class="goal-panel__list">
      <li
        v-for="(item, idx) in items"
        :key="`goal-${goalKey(item)}`"
        class="goal-item"
        :class="[
          `goal-item--${goalStatus(item)}`,
          { 'goal-item--hidden-undiscovered': isHiddenUndiscovered(item) }
        ]"
        :style="{ '--stagger': idx }"
      >
        <!-- Status indicator -->
        <div class="goal-item__status-icon" :class="`goal-item__status-icon--${isHiddenUndiscovered(item) ? 'hidden' : goalStatus(item)}`">
          <!-- Hidden undiscovered: question mark -->
          <svg v-if="isHiddenUndiscovered(item)" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <!-- Claimable: sparkle -->
          <svg v-else-if="goalStatus(item) === 'claimable'" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2l2.09 6.26L20.18 10l-6.09 1.74L12 18l-2.09-6.26L3.82 10l6.09-1.74L12 2z" />
          </svg>
          <!-- Claimed: check -->
          <svg v-else-if="goalStatus(item) === 'claimed'" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <!-- Pending: progress ring -->
          <svg v-else width="16" height="16" viewBox="0 0 24 24" class="goal-item__progress-ring">
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.5" opacity="0.15" />
            <circle
              cx="12" cy="12" r="9"
              fill="none" stroke="currentColor" stroke-width="2.5"
              stroke-linecap="round"
              :stroke-dasharray="`${progressPercent(item.progress, item.target) * 0.565} 56.5`"
              transform="rotate(-90 12 12)"
            />
          </svg>
        </div>

        <!-- Content -->
        <div class="goal-item__body">
          <div class="goal-item__top">
            <div class="goal-item__info">
              <div class="goal-item__title-row">
                <p class="goal-item__title">{{ item.title }}</p>
                <span v-if="isHiddenRevealed(item)" class="goal-item__hidden-badge">隐藏</span>
              </div>
              <p class="goal-item__desc">{{ item.description }}</p>
            </div>
            <button
              type="button"
              class="goal-item__claim-btn"
              :class="{
                'goal-item__claim-btn--ready': goalStatus(item) === 'claimable',
                [`goal-item__claim-btn--${kind}`]: goalStatus(item) === 'claimable'
              }"
              :disabled="claiming != null || !item.claimable || item.claimed"
              @click="emit('claim', goalKey(item))"
            >
              <span v-if="claiming === goalKey(item)" class="goal-panel__spinner goal-panel__spinner--sm" />
              <span v-else-if="item.claimed">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              </span>
              <span v-else>领取</span>
            </button>
          </div>

          <!-- Progress row -->
          <div class="goal-item__progress-row">
            <UiProgress
              class="goal-item__progress-bar"
              :model-value="progressPercent(item.progress, item.target)"
              :color="progressColor"
            />
            <span class="goal-item__progress-text">{{ formatTokens(item.progress) }}/{{ formatTokens(item.target) }}</span>
          </div>

          <!-- Reward pills -->
          <div class="goal-item__rewards">
            <span
              v-for="(part, i) in rewardParts(item)"
              :key="i"
              class="reward-pill"
              :class="`reward-pill--${part.tone}`"
            >
              {{ part.label }}
            </span>
          </div>
        </div>
      </li>
    </TransitionGroup>
  </article>
</template>

<style scoped>
/* ── Panel Container ─────────────────────────── */
.goal-panel {
  border-radius: var(--g-radius-lg);
  border: 1px solid var(--g-border);
  background: var(--g-surface-card);
  box-shadow: var(--g-shadow-xs);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ── Header ──────────────────────────────────── */
.goal-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}

.goal-panel__header-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.goal-panel__icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--g-radius-sm);
  flex-shrink: 0;
}

.goal-panel__icon-wrap--mission {
  background: rgba(16, 185, 129, 0.1);
  color: #059669;
}

html.dark .goal-panel__icon-wrap--mission {
  background: rgba(52, 211, 153, 0.12);
  color: #6ee7b7;
}

.goal-panel__icon-wrap--achievement {
  background: rgba(6, 182, 212, 0.1);
  color: #0891b2;
}

html.dark .goal-panel__icon-wrap--achievement {
  background: rgba(34, 211, 238, 0.12);
  color: #67e8f9;
}

.goal-panel__title {
  font-size: 14px;
  font-weight: 700;
  color: var(--g-text-primary);
  letter-spacing: -0.01em;
  line-height: 1.3;
}

.goal-panel__subtitle {
  font-size: 11px;
  color: var(--g-text-tertiary);
  line-height: 1.3;
  margin-top: 1px;
}

.goal-panel__header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

/* Tab buttons */
.goal-panel__tab-btn {
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--g-border);
  background: transparent;
  font-size: 11px;
  font-weight: 500;
  color: var(--g-text-tertiary);
  cursor: pointer;
  transition: all var(--g-duration-fast) var(--g-ease);
}

.goal-panel__tab-btn:hover {
  color: var(--g-text-primary);
  border-color: var(--g-border-strong);
}

.goal-panel__tab-btn.is-active {
  color: rgb(var(--accent-strong));
  border-color: rgb(var(--accent-strong) / 0.35);
  background: rgb(var(--accent-strong) / 0.08);
  font-weight: 600;
}

/* Claim-all button */
.goal-panel__claim-all-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--g-border);
  background: transparent;
  font-size: 11px;
  font-weight: 600;
  color: var(--g-text-quaternary);
  cursor: pointer;
  transition: all var(--g-duration-fast) var(--g-ease);
}

.goal-panel__claim-all-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.goal-panel__claim-all-btn.is-active {
  color: #059669;
  border-color: rgba(16, 185, 129, 0.4);
  background: rgba(16, 185, 129, 0.08);
}

html.dark .goal-panel__claim-all-btn.is-active {
  color: #6ee7b7;
  border-color: rgba(52, 211, 153, 0.35);
  background: rgba(52, 211, 153, 0.1);
}

.goal-panel__claim-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 700;
  color: white;
  background: #059669;
}

html.dark .goal-panel__claim-badge {
  background: #34d399;
  color: #064e3b;
}

/* Spinner */
.goal-panel__spinner {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: goal-spin 0.6s linear infinite;
}

.goal-panel__spinner--sm {
  width: 10px;
  height: 10px;
  border-width: 1.5px;
}

@keyframes goal-spin {
  to { transform: rotate(360deg); }
}

/* ── Loading / Empty ─────────────────────────── */
.goal-panel__placeholder {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.goal-skeleton {
  height: 72px;
  border-radius: var(--g-radius-md);
  background: linear-gradient(90deg, var(--g-surface-recessed) 25%, var(--g-surface-deep) 37%, var(--g-surface-recessed) 63%);
  background-size: 200% 100%;
  animation: gacha-shimmer 1.6s ease infinite;
}

.goal-skeleton--short {
  width: 60%;
}

.goal-panel__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 28px 16px;
  color: var(--g-text-quaternary);
  font-size: 13px;
}

/* ── Goal List ───────────────────────────────── */
.goal-panel__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
  padding: 0;
  margin: 0;
}

/* ── Goal Item ───────────────────────────────── */
.goal-item {
  display: flex;
  gap: 10px;
  padding: 10px 12px;
  border-radius: var(--g-radius-md);
  border: 1px solid var(--g-border);
  background: var(--g-surface-card);
  transition: all var(--g-duration-fast) var(--g-ease);
}

.goal-item:hover {
  box-shadow: var(--g-shadow-xs);
}

/* Claimable: glow border */
.goal-item--claimable {
  border-color: rgba(16, 185, 129, 0.35);
  background: rgba(16, 185, 129, 0.03);
}

.goal-panel--achievement .goal-item--claimable {
  border-color: rgba(6, 182, 212, 0.35);
  background: rgba(6, 182, 212, 0.03);
}

html.dark .goal-item--claimable {
  border-color: rgba(52, 211, 153, 0.3);
  background: rgba(52, 211, 153, 0.04);
}

html.dark .goal-panel--achievement .goal-item--claimable {
  border-color: rgba(34, 211, 238, 0.3);
  background: rgba(34, 211, 238, 0.04);
}

/* Claimed: muted */
.goal-item--claimed {
  opacity: 0.55;
}

.goal-item--claimed:hover {
  opacity: 0.7;
}

/* Hidden undiscovered: mystery style */
.goal-item--hidden-undiscovered {
  border-style: dashed;
  border-color: var(--g-border-strong);
  background: var(--g-surface-recessed);
  opacity: 0.65;
}

.goal-item--hidden-undiscovered .goal-item__title,
.goal-item--hidden-undiscovered .goal-item__desc {
  font-style: italic;
}

/* ── Status Icon ─────────────────────────────── */
.goal-item__status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  flex-shrink: 0;
  margin-top: 2px;
  transition: all var(--g-duration-fast) var(--g-ease);
}

.goal-item__status-icon--claimable {
  background: rgba(16, 185, 129, 0.12);
  color: #059669;
  animation: goal-pulse 2s ease-in-out infinite;
}

.goal-panel--achievement .goal-item__status-icon--claimable {
  background: rgba(6, 182, 212, 0.12);
  color: #0891b2;
}

html.dark .goal-item__status-icon--claimable {
  background: rgba(52, 211, 153, 0.15);
  color: #6ee7b7;
}

html.dark .goal-panel--achievement .goal-item__status-icon--claimable {
  background: rgba(34, 211, 238, 0.15);
  color: #67e8f9;
}

.goal-item__status-icon--claimed {
  background: var(--g-surface-recessed);
  color: var(--g-text-quaternary);
}

.goal-item__status-icon--pending {
  background: var(--g-surface-recessed);
  color: var(--g-text-tertiary);
}

.goal-item__status-icon--hidden {
  background: var(--g-surface-deep);
  color: var(--g-text-quaternary);
}

.goal-item__progress-ring {
  display: block;
}

@keyframes goal-pulse {
  0%, 100% { transform: scale(1); }
  50% { transform: scale(1.08); }
}

/* ── Body ────────────────────────────────────── */
.goal-item__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.goal-item__top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.goal-item__info {
  min-width: 0;
}

.goal-item__title-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.goal-item__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--g-text-primary);
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.goal-item__hidden-badge {
  display: inline-flex;
  align-items: center;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: #7c3aed;
  background: rgba(124, 58, 237, 0.1);
  border: 1px solid rgba(124, 58, 237, 0.2);
  flex-shrink: 0;
  white-space: nowrap;
}

html.dark .goal-item__hidden-badge {
  color: #c4b5fd;
  background: rgba(167, 139, 250, 0.12);
  border-color: rgba(167, 139, 250, 0.25);
}

.goal-item__desc {
  font-size: 11px;
  color: var(--g-text-tertiary);
  line-height: 1.35;
  margin-top: 1px;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* ── Claim Button ────────────────────────────── */
.goal-item__claim-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 26px;
  min-width: 48px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--g-border);
  background: var(--g-surface-card);
  font-size: 11px;
  font-weight: 600;
  color: var(--g-text-quaternary);
  cursor: pointer;
  flex-shrink: 0;
  transition: all var(--g-duration-fast) var(--g-ease);
}

.goal-item__claim-btn:disabled {
  cursor: not-allowed;
}

.goal-item__claim-btn--ready {
  color: white;
  border-color: transparent;
}

.goal-item__claim-btn--mission {
  background: #059669;
  box-shadow: 0 1px 3px rgba(5, 150, 105, 0.3);
}

.goal-item__claim-btn--mission:hover:not(:disabled) {
  background: #047857;
  box-shadow: 0 2px 6px rgba(5, 150, 105, 0.4);
}

html.dark .goal-item__claim-btn--mission {
  background: #34d399;
  color: #064e3b;
  box-shadow: 0 1px 3px rgba(52, 211, 153, 0.25);
}

html.dark .goal-item__claim-btn--mission:hover:not(:disabled) {
  background: #6ee7b7;
}

.goal-item__claim-btn--achievement {
  background: #0891b2;
  box-shadow: 0 1px 3px rgba(8, 145, 178, 0.3);
}

.goal-item__claim-btn--achievement:hover:not(:disabled) {
  background: #0e7490;
  box-shadow: 0 2px 6px rgba(8, 145, 178, 0.4);
}

html.dark .goal-item__claim-btn--achievement {
  background: #22d3ee;
  color: #164e63;
  box-shadow: 0 1px 3px rgba(34, 211, 238, 0.25);
}

html.dark .goal-item__claim-btn--achievement:hover:not(:disabled) {
  background: #67e8f9;
}

/* ── Progress Row ────────────────────────────── */
.goal-item__progress-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.goal-item__progress-bar {
  flex: 1;
  height: 4px !important;
}

.goal-item__progress-text {
  font-size: 10px;
  font-weight: 600;
  color: var(--g-text-tertiary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

/* ── Reward Pills ────────────────────────────── */
.goal-item__rewards {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.reward-pill {
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.01em;
}

.reward-pill--token {
  background: rgba(245, 158, 11, 0.1);
  color: #b45309;
  border: 1px solid rgba(245, 158, 11, 0.2);
}

html.dark .reward-pill--token {
  background: rgba(245, 158, 11, 0.12);
  color: #fbbf24;
  border-color: rgba(245, 158, 11, 0.25);
}

.reward-pill--draw {
  background: rgba(16, 185, 129, 0.1);
  color: #059669;
  border: 1px solid rgba(16, 185, 129, 0.2);
}

html.dark .reward-pill--draw {
  background: rgba(52, 211, 153, 0.12);
  color: #6ee7b7;
  border-color: rgba(52, 211, 153, 0.25);
}

.reward-pill--draw10 {
  background: rgba(99, 102, 241, 0.1);
  color: #4f46e5;
  border: 1px solid rgba(99, 102, 241, 0.2);
}

html.dark .reward-pill--draw10 {
  background: rgba(129, 140, 248, 0.12);
  color: #a5b4fc;
  border-color: rgba(129, 140, 248, 0.25);
}

.reward-pill--reforge {
  background: rgba(6, 182, 212, 0.1);
  color: #0891b2;
  border: 1px solid rgba(6, 182, 212, 0.2);
}

html.dark .reward-pill--reforge {
  background: rgba(34, 211, 238, 0.12);
  color: #67e8f9;
  border-color: rgba(34, 211, 238, 0.25);
}

/* ── TransitionGroup Animations ──────────────── */
.goal-item-enter-active {
  transition: all var(--g-duration-normal) var(--g-ease);
  transition-delay: calc(var(--stagger, 0) * 30ms);
}

.goal-item-leave-active {
  transition: all var(--g-duration-fast) var(--g-ease);
}

.goal-item-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.goal-item-leave-to {
  opacity: 0;
  transform: translateX(-8px);
}

.goal-item-move {
  transition: transform var(--g-duration-normal) var(--g-ease);
}

/* ── Responsive ──────────────────────────────── */
@media (max-width: 639px) {
  .goal-panel {
    padding: 12px;
  }

  .goal-panel__header {
    flex-direction: column;
    gap: 8px;
  }

  .goal-panel__header-actions {
    width: 100%;
    justify-content: flex-end;
  }

  .goal-item {
    padding: 8px 10px;
  }

  .goal-item__status-icon {
    width: 24px;
    height: 24px;
  }

  .goal-item__status-icon svg {
    width: 12px;
    height: 12px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .goal-item__status-icon--claimable {
    animation: none;
  }
}
</style>
