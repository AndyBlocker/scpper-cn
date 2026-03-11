<script setup lang="ts">
/**
 * 抽卡面板（当前卡池模式）。
 * 仅展示当前卡池，不提供其他卡池切换入口。
 */
import type { GachaPool, TicketBalance } from '~/types/gacha'
import { computed } from 'vue'
import { poolStatusKey, formatTokens, tenDrawSavings } from '~/utils/gachaFormatters'
import {
  poolBadgeClassMap,
  poolCardClassMap,
  poolTextClassMap,
  poolStatusLabelMap
} from '~/utils/gachaConstants'
import { UiButton } from '~/components/ui/button'

const PURPLE_PITY_THRESHOLD = 60
const GOLD_PITY_THRESHOLD = 120

const props = defineProps<{
  pools: GachaPool[]
  currentPool: GachaPool | null
  drawing: boolean
  canDrawSingle: boolean
  canDrawTen: boolean
  tickets: TicketBalance
  purplePityCount: number
  goldPityCount: number
}>()

const emit = defineEmits<{
  draw: [count: number, poolId: string]
}>()

const displayPool = computed<GachaPool | null>(() => {
  if (props.currentPool) return props.currentPool
  const active = props.pools.find((pool) => pool.isActive)
  if (active) return active
  return props.pools[0] ?? null
})

const displayPoolStatusKey = computed(() => {
  if (!displayPool.value) return 'ended'
  return poolStatusKey(displayPool.value)
})

const purplePity = computed(() => {
  const raw = Number(props.purplePityCount ?? 0)
  const value = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0
  const clamped = Math.min(value, PURPLE_PITY_THRESHOLD - 1)
  const remaining = PURPLE_PITY_THRESHOLD - clamped
  const percent = (clamped / PURPLE_PITY_THRESHOLD) * 100
  return { count: clamped, threshold: PURPLE_PITY_THRESHOLD, remaining, percent }
})

const goldPity = computed(() => {
  const raw = Number(props.goldPityCount ?? 0)
  const value = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0
  const clamped = Math.min(value, GOLD_PITY_THRESHOLD - 1)
  const remaining = GOLD_PITY_THRESHOLD - clamped
  const percent = (clamped / GOLD_PITY_THRESHOLD) * 100
  return { count: clamped, threshold: GOLD_PITY_THRESHOLD, remaining, percent }
})
</script>

<template>
  <!-- 当前卡池 -->
  <section class="surface-card draw-deck mx-auto w-full max-w-[760px] space-y-1.5 p-1.5 sm:p-2">
    <header class="gacha-panel-head lg:flex-row lg:items-end lg:justify-between">
      <div class="space-y-1.5">
        <h3 class="gacha-panel-title">当前卡池</h3>
      </div>
      <div class="flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
        <span v-if="pools.length > 1" class="inline-flex items-center rounded-full border border-neutral-200/80 bg-white/75 px-2.5 py-1 dark:border-neutral-700/70 dark:bg-neutral-900/70">
          已隐藏其他 {{ pools.length - 1 }} 个卡池
        </span>
      </div>
    </header>

    <div v-if="displayPool" class="grid gap-3">
      <article
        :key="displayPool.id"
        class="pool-deck-card group relative overflow-hidden rounded-xl border p-2 text-sm shadow-sm transition duration-200 sm:p-2.5"
        :class="[
          poolCardClassMap[displayPoolStatusKey],
          'pool-deck-card--active ring-2 ring-[rgb(var(--accent-strong))]/60 ring-offset-2 ring-offset-white dark:ring-offset-neutral-900'
        ]"
      >
        <div class="pool-deck-card__grain" />
        <div class="pool-deck-card__foil" />

        <div class="relative space-y-2.5">
          <div class="flex flex-wrap items-center gap-2">
            <span class="pool-pack-label">Card Pack</span>
            <h4 class="min-w-0 flex-1 truncate text-sm font-semibold text-neutral-900 dark:text-neutral-100 sm:text-base">{{ displayPool.name }}</h4>
            <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase" :class="poolBadgeClassMap[displayPoolStatusKey]">
              {{ poolStatusLabelMap[displayPoolStatusKey] }}
            </span>
            <span class="inline-flex items-center rounded-full bg-[rgb(var(--accent-strong))]/12 px-1.5 py-0.5 text-[10px] font-semibold text-[rgb(var(--accent-strong))]">
              主卡池
            </span>
          </div>

          <p class="line-clamp-2 text-[12px] leading-relaxed" :class="poolTextClassMap[displayPoolStatusKey]">
            {{ displayPool.description || '此卡池暂无补充描述。' }}
          </p>

          <!-- 保底进度条 -->
          <div class="pity-progress-group space-y-2">
            <div class="pity-progress-item">
              <div class="flex items-center justify-between text-[11px]">
                <span class="font-medium text-purple-600 dark:text-purple-300">紫色保底</span>
                <span class="text-neutral-500 dark:text-neutral-400">{{ purplePity.count }}/{{ purplePity.threshold }} · 还差{{ purplePity.remaining }}抽</span>
              </div>
              <div class="pity-progress-track mt-1">
                <div
                  class="pity-progress-fill pity-progress-fill--purple"
                  :style="{ width: `${purplePity.percent}%` }"
                />
              </div>
            </div>
            <div class="pity-progress-item">
              <div class="flex items-center justify-between text-[11px]">
                <span class="font-medium text-amber-600 dark:text-amber-300">金色保底</span>
                <span class="text-neutral-500 dark:text-neutral-400">{{ goldPity.count }}/{{ goldPity.threshold }} · 还差{{ goldPity.remaining }}抽</span>
              </div>
              <div class="pity-progress-track mt-1">
                <div
                  class="pity-progress-fill pity-progress-fill--gold"
                  :style="{ width: `${goldPity.percent}%` }"
                />
              </div>
            </div>
          </div>

          <div class="pool-action-row space-y-1.5 text-sm">
            <div class="draw-action-grid grid gap-2 sm:grid-cols-2">
            <UiButton
              class="draw-action-btn draw-action-btn--single w-full min-h-[4.35rem] flex-col px-4 py-2 font-semibold"
              :disabled="drawing || !displayPool.isActive || !canDrawSingle"
              @click.stop="emit('draw', 1, displayPool.id)"
            >
              <span class="text-sm">立即抽卡</span>
              <span class="text-[11px] text-white/80">
                <template v-if="tickets.drawTicket > 0">优先消耗单抽券（{{ formatTokens(tickets.drawTicket) }}）</template>
                <template v-else>消耗 {{ formatTokens(displayPool.tokenCost) }} Token</template>
              </span>
            </UiButton>
            <UiButton
              variant="outline"
              class="draw-action-btn draw-action-btn--ten w-full min-h-[4.35rem] flex-col bg-white/85 px-4 py-2 font-semibold dark:bg-neutral-900/70"
              :disabled="drawing || !displayPool.isActive || !canDrawTen"
              @click.stop="emit('draw', 10, displayPool.id)"
            >
              <span class="text-sm">十连抽</span>
              <span class="text-[11px] text-neutral-500 dark:text-neutral-400">
                <template v-if="tickets.draw10Ticket > 0">优先消耗十连券（{{ formatTokens(tickets.draw10Ticket) }}）</template>
                <template v-else>消耗 {{ formatTokens(displayPool.tenDrawCost) }} Token</template>
                <span v-if="tenDrawSavings(displayPool) > 0" class="ml-1 text-emerald-600 dark:text-emerald-300">省 {{ formatTokens(tenDrawSavings(displayPool)) }}</span>
              </span>
            </UiButton>
            </div>
            <p v-if="drawing || !displayPool.isActive || (!canDrawSingle && !canDrawTen)" class="text-center text-xs text-neutral-500 dark:text-neutral-400">
              {{ drawing ? '抽卡进行中，请稍候...' : (!displayPool.isActive ? '卡池未开放，暂不可抽取。' : 'Token 不足，当前无法抽取。') }}
            </p>
          </div>
        </div>
      </article>
    </div>

    <p v-else class="rounded-lg border border-dashed border-neutral-200/70 px-4 py-4 text-sm text-neutral-500 dark:border-neutral-800/70 dark:text-neutral-400">
      暂无可用卡池，请稍后再试。
    </p>
  </section>
</template>

<style scoped>
.draw-deck {
  position: relative;
}

.pool-deck-card {
  isolation: isolate;
}

.pool-deck-card::before {
  content: '';
  pointer-events: none;
  position: absolute;
  inset: 0;
  z-index: 0;
  background:
    linear-gradient(132deg, rgba(255, 255, 255, 0.34), transparent 42%),
    radial-gradient(circle at 82% 12%, rgb(var(--accent-strong) / 0.16), transparent 42%);
}

html.dark .pool-deck-card::before {
  background:
    linear-gradient(132deg, rgba(148, 163, 184, 0.12), transparent 42%),
    radial-gradient(circle at 82% 12%, rgb(var(--accent-strong) / 0.22), transparent 44%);
}

.pool-deck-card > * {
  position: relative;
  z-index: 1;
}

.pool-deck-card__grain {
  pointer-events: none;
  position: absolute;
  inset: 0;
  opacity: 0.14;
  background-image: radial-gradient(rgba(148, 163, 184, 0.42) 0.8px, transparent 0.8px);
  background-size: 3px 3px;
}

.pool-deck-card__foil {
  pointer-events: none;
  position: absolute;
  inset: -14%;
  background:
    linear-gradient(118deg, transparent 26%, rgba(255, 255, 255, 0.46) 40%, transparent 54%),
    linear-gradient(34deg, rgba(255, 255, 255, 0.1), transparent 42%);
  opacity: 0.46;
  transform: translateX(-30%);
  transition: transform 640ms ease, opacity 320ms ease;
  mix-blend-mode: screen;
}

.pool-deck-card:hover .pool-deck-card__foil {
  opacity: 0.84;
  transform: translateX(24%);
}

.pool-pack-label {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  border: 1px solid rgb(var(--accent-strong) / 0.38);
  background: rgb(var(--accent-strong) / 0.1);
  padding: 0.16rem 0.52rem;
  font-size: 0.58rem;
  font-weight: 700;
  letter-spacing: 0.11em;
  text-transform: uppercase;
  color: rgb(var(--accent-strong));
}

.pity-progress-track {
  height: 6px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.18);
  overflow: hidden;
}

html.dark .pity-progress-track {
  background: rgba(100, 116, 139, 0.25);
}

.pity-progress-fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  min-width: 0;
}

.pity-progress-fill--purple {
  background: linear-gradient(90deg, #a78bfa, #8b5cf6);
}

.pity-progress-fill--gold {
  background: linear-gradient(90deg, #fbbf24, #f59e0b);
}

.draw-action-grid > * {
  height: 100%;
}

.draw-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 0.15rem;
  border-width: 1px;
  border-color: rgba(148, 163, 184, 0.32);
  transition: transform 0.16s ease, box-shadow 0.16s ease, border-color 0.16s ease;
}

.draw-action-btn:hover:not(:disabled) {
  transform: translateY(-1px);
}

.draw-action-btn--single {
  border-color: rgb(var(--accent-strong) / 0.44);
  background: linear-gradient(135deg, rgb(var(--accent-strong) / 0.88), rgb(var(--accent) / 0.88));
  box-shadow: 0 12px 24px -20px rgb(var(--accent-strong) / 0.68);
}

.draw-action-btn--single:hover:not(:disabled) {
  box-shadow: 0 18px 36px -20px rgb(var(--accent-strong) / 0.78);
}

.draw-action-btn--ten {
  border-color: rgba(148, 163, 184, 0.42);
}

@media (prefers-reduced-motion: reduce) {
  .pool-deck-card__foil,
  .draw-action-btn {
    transition: none !important;
  }
}
</style>
