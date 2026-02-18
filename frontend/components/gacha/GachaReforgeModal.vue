<template>
  <UiDialogRoot :open="props.open" @update:open="(v) => { if (!v) emit('close') }">
    <UiDialogPortal>
      <UiDialogOverlay class="!z-[58] !bg-black/50 !backdrop-blur-sm" />
      <UiDialogContent
        class="reforge-modal z-[61] mx-2 flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-white/40 bg-white/92 p-0 shadow-[0_42px_120px_-62px_rgba(15,23,42,0.95)] backdrop-blur-xl max-h-[calc(100dvh-2rem)] dark:border-neutral-700/70 dark:bg-neutral-950/88 sm:mx-0 sm:rounded-[26px]"
      >
        <!-- Glow layers -->
        <div class="reforge-modal__glow reforge-modal__glow--a" />
        <div class="reforge-modal__glow reforge-modal__glow--b" />

        <!-- Header -->
        <header class="relative z-[2] flex items-start justify-between gap-3 border-b border-neutral-200/70 px-4 py-3 dark:border-neutral-800/70">
          <div class="space-y-1">
            <p class="inline-flex w-fit items-center rounded-full border border-cyan-500/30 bg-cyan-500/10 px-3 py-0.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-600 dark:text-cyan-400">
              {{ phase === 'confirm' ? 'Reforge · 确认' : 'Reforge · 完成' }}
            </p>
            <h2 class="text-base font-semibold text-neutral-900 dark:text-neutral-50">
              {{ phase === 'confirm' ? '词条改造' : '改造结果' }}
            </h2>
          </div>
          <UiDialogClose as-child>
            <UiButton
              variant="ghost"
              size="sm"
              class="h-8 w-8 rounded-full border border-neutral-200/70 p-0 text-neutral-500 hover:text-neutral-900 dark:border-neutral-700/70 dark:text-neutral-400 dark:hover:text-neutral-100"
              aria-label="关闭改造弹窗"
            >
              <LucideIcon name="X" class="h-4 w-4" />
            </UiButton>
          </UiDialogClose>
        </header>

        <!-- Body -->
        <div class="relative z-[2] flex-1 overflow-y-auto px-4 py-4">
          <Transition name="fade" mode="out-in">
            <!-- Confirm Phase -->
            <div v-if="phase === 'confirm'" key="confirm" class="flex flex-col items-center gap-4">
              <!-- Card preview or random placeholder -->
              <div class="reforge-preview-wrap">
                <template v-if="selectedCard">
                  <GachaCard
                    :title="selectedCard.title"
                    :rarity="selectedCard.rarity"
                    :tags="selectedCard.tags ?? []"
                    :wikidot-id="selectedCard.wikidotId"
                    :authors="selectedCard.authors"
                    :image-url="selectedCard.imageUrl || undefined"
                    :affix-signature="selectedCard.affixSignature"
                    :affix-styles="selectedCard.affixStyles"
                    :affix-style-counts="selectedCard.affixStyleCounts"
                    variant="mini"
                  />
                </template>
                <template v-else>
                  <div class="reforge-random-placeholder">
                    <LucideIcon name="Shuffle" class="h-8 w-8 text-neutral-400 dark:text-neutral-500" />
                    <span class="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">随机选择</span>
                  </div>
                </template>
              </div>

              <!-- Cost detail -->
              <div class="flex items-center gap-2 rounded-lg border border-neutral-200/70 bg-neutral-50/80 px-3 py-2 text-xs text-neutral-600 dark:border-neutral-700/60 dark:bg-neutral-900/60 dark:text-neutral-300">
                <LucideIcon name="Ticket" class="h-3.5 w-3.5 flex-shrink-0 text-cyan-500" />
                <span>消耗 <strong class="font-semibold text-neutral-900 dark:text-neutral-100">1</strong> 张改造券</span>
              </div>

              <p class="text-center text-[11px] text-neutral-500 dark:text-neutral-400">
                改造将随机更换目标卡片的词条样式，此操作不可撤销。
              </p>
            </div>

            <!-- Result Phase -->
            <div v-else key="result" class="flex flex-col items-center gap-4">
              <div class="reforge-result-row">
                <!-- Before card -->
                <div class="reforge-result-slot reforge-card-reveal">
                  <span class="reforge-result-label">改造前</span>
                  <div class="reforge-result-card-wrap">
                    <GachaCard
                      v-if="result"
                      :title="result.title"
                      :rarity="beforeCardRarity"
                      :tags="beforeCardTags"
                      :wikidot-id="resultCardWikidotId"
                      :authors="resultCardAuthors"
                      :image-url="beforeCardImageUrl"
                      :affix-signature="result.before.affixSignature"
                      :affix-visual-style="result.before.affixVisualStyle"
                      :affix-label="result.before.affixLabel"
                      variant="mini"
                    />
                  </div>
                </div>

                <!-- Arrow -->
                <div class="reforge-arrow reforge-arrow-reveal">
                  <div class="reforge-arrow-circle">
                    <LucideIcon name="ArrowRight" class="h-4 w-4" />
                  </div>
                </div>

                <!-- After card -->
                <div class="reforge-result-slot reforge-card-reveal reforge-card-reveal--after">
                  <span class="reforge-result-label">改造后</span>
                  <div class="reforge-result-card-wrap">
                    <GachaCard
                      v-if="result"
                      :title="result.title"
                      :rarity="afterCardRarity"
                      :tags="afterCardTags"
                      :wikidot-id="resultCardWikidotId"
                      :authors="resultCardAuthors"
                      :image-url="afterCardImageUrl"
                      :affix-signature="result.after.affixSignature"
                      :affix-visual-style="result.after.affixVisualStyle"
                      :affix-label="result.after.affixLabel"
                      variant="mini"
                    />
                  </div>
                </div>
              </div>

              <!-- Affix change summary -->
              <div v-if="result" class="reforge-affix-summary reforge-card-reveal reforge-card-reveal--summary">
                <div class="reforge-affix-before">
                  <span class="reforge-affix-tag">{{ result.before.affixLabel }}</span>
                </div>
                <LucideIcon name="ArrowRight" class="h-3.5 w-3.5 flex-shrink-0 text-cyan-500" />
                <div class="reforge-affix-after">
                  <span class="reforge-affix-tag reforge-affix-tag--new">{{ result.after.affixLabel }}</span>
                </div>
              </div>
            </div>
          </Transition>
        </div>

        <!-- Footer -->
        <footer class="relative z-[2] flex gap-2 border-t border-neutral-200/70 bg-white/65 px-4 py-3 dark:border-neutral-800/70 dark:bg-neutral-950/72">
          <template v-if="phase === 'confirm'">
            <UiButton variant="outline" class="flex-1" @click="emit('close')">
              取消
            </UiButton>
            <UiButton class="flex-1" :disabled="confirming" @click="emit('confirm')">
              <span v-if="confirming">改造中...</span>
              <span v-else>确认改造</span>
            </UiButton>
          </template>
          <template v-else>
            <UiButton class="flex-1" @click="emit('close')">
              关闭
            </UiButton>
          </template>
        </footer>
      </UiDialogContent>
    </UiDialogPortal>
  </UiDialogRoot>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import LucideIcon from '~/components/LucideIcon.vue'
import GachaCard from '~/components/gacha/GachaCard.vue'
import { UiButton } from '~/components/ui/button'
import {
  UiDialogRoot,
  UiDialogPortal,
  UiDialogOverlay,
  UiDialogContent,
  UiDialogClose
} from '~/components/ui/dialog'
import type { AffixVisualStyle, Rarity } from '~/types/gacha'

interface ReforgeCardOption {
  cardId: string
  title: string
  rarity: Rarity
  imageUrl: string | null
  wikidotId?: number | null
  tags: string[]
  authors?: Array<{ name: string; wikidotId: number | null }> | null
  count: number
  placedCount: number
  affixSignature?: string
  affixStyles?: AffixVisualStyle[]
  affixStyleCounts?: Partial<Record<AffixVisualStyle, number>>
}

const props = defineProps<{
  open: boolean
  phase: 'confirm' | 'result'
  selectedCard: ReforgeCardOption | null
  result: {
    cardId: string
    title: string
    before: { affixSignature?: string; affixVisualStyle: AffixVisualStyle; affixLabel: string }
    after: { affixSignature?: string; affixVisualStyle: AffixVisualStyle; affixLabel: string }
  } | null
  resultCardVisual: {
    rarity: Rarity
    imageUrl: string | null
    tags: string[]
    wikidotId: number | null
    authors: Array<{ name: string; wikidotId: number | null }> | null
  } | null
  confirming: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'confirm'): void
}>()

// Result card visual data — use resultCardVisual if available, else fallback
const beforeCardRarity = computed<Rarity>(() => props.resultCardVisual?.rarity ?? 'WHITE')
const beforeCardTags = computed<string[]>(() => props.resultCardVisual?.tags ?? [])
const beforeCardImageUrl = computed(() => props.resultCardVisual?.imageUrl || undefined)
const resultCardWikidotId = computed(() => props.resultCardVisual?.wikidotId ?? null)
const resultCardAuthors = computed(() => props.resultCardVisual?.authors ?? null)

const afterCardRarity = computed<Rarity>(() => props.resultCardVisual?.rarity ?? 'WHITE')
const afterCardTags = computed<string[]>(() => props.resultCardVisual?.tags ?? [])
const afterCardImageUrl = computed(() => props.resultCardVisual?.imageUrl || undefined)
</script>

<style scoped>
.reforge-modal::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.74), rgba(255, 255, 255, 0.22) 55%, rgba(15, 23, 42, 0.05)),
    radial-gradient(circle at 20% 25%, rgba(8, 145, 178, 0.18), transparent 50%),
    radial-gradient(circle at 80% 80%, rgba(14, 116, 144, 0.14), transparent 48%);
}

html.dark .reforge-modal::before {
  background:
    linear-gradient(135deg, rgba(15, 23, 42, 0.82), rgba(15, 23, 42, 0.28) 55%, rgba(15, 23, 42, 0.1)),
    radial-gradient(circle at 20% 25%, rgba(8, 145, 178, 0.22), transparent 52%),
    radial-gradient(circle at 80% 80%, rgba(14, 116, 144, 0.18), transparent 50%);
}

.reforge-modal__glow {
  position: absolute;
  border-radius: 999px;
  filter: blur(42px);
  opacity: 0.6;
  pointer-events: none;
}

.reforge-modal__glow--a {
  left: -4rem;
  top: -3rem;
  width: 11rem;
  height: 11rem;
  background: rgba(8, 145, 178, 0.25);
}

.reforge-modal__glow--b {
  right: -3rem;
  bottom: -3rem;
  width: 9rem;
  height: 9rem;
  background: rgba(14, 116, 144, 0.22);
}

/* ── Card Preview ──────────────────────── */

.reforge-preview-wrap {
  width: min(140px, 40vw);
}

.reforge-random-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  aspect-ratio: 3 / 4;
  border-radius: 0.75rem;
  border: 2px dashed rgba(148, 163, 184, 0.45);
  background: rgba(248, 250, 252, 0.6);
}

html.dark .reforge-random-placeholder {
  border-color: rgba(100, 116, 139, 0.45);
  background: rgba(15, 23, 42, 0.5);
}

/* ── Result Row ────────────────────────── */

.reforge-result-row {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  gap: 0.5rem;
  width: 100%;
}

.reforge-result-slot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.35rem;
  flex: 1;
  min-width: 0;
  max-width: 160px;
}

.reforge-result-card-wrap {
  width: 100%;
}

.reforge-result-label {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: rgb(100, 116, 139);
}

html.dark .reforge-result-label {
  color: rgb(148, 163, 184);
}

/* ── Affix Change Summary ─────────────── */

.reforge-affix-summary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.625rem 0.75rem;
  border-radius: 0.75rem;
  border: 1px solid rgba(148, 163, 184, 0.25);
  background: rgba(248, 250, 252, 0.7);
}

html.dark .reforge-affix-summary {
  border-color: rgba(100, 116, 139, 0.3);
  background: rgba(15, 23, 42, 0.5);
}

.reforge-affix-before,
.reforge-affix-after {
  display: flex;
  align-items: center;
  min-width: 0;
}

.reforge-affix-tag {
  display: inline-block;
  font-size: 12px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
  background: rgba(148, 163, 184, 0.15);
  color: rgb(100, 116, 139);
  border: 1px solid rgba(148, 163, 184, 0.2);
}

html.dark .reforge-affix-tag {
  background: rgba(100, 116, 139, 0.2);
  color: rgb(148, 163, 184);
  border-color: rgba(100, 116, 139, 0.3);
}

.reforge-affix-tag--new {
  background: rgba(8, 145, 178, 0.12);
  color: rgb(8, 145, 178);
  border-color: rgba(8, 145, 178, 0.3);
}

html.dark .reforge-affix-tag--new {
  background: rgba(34, 211, 238, 0.12);
  color: rgb(34, 211, 238);
  border-color: rgba(34, 211, 238, 0.3);
}

/* ── Arrow ─────────────────────────────── */

.reforge-arrow {
  display: flex;
  align-items: center;
  justify-content: center;
  padding-top: 1.5rem;
  flex-shrink: 0;
}

.reforge-arrow-circle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border-radius: 999px;
  background: rgba(8, 145, 178, 0.12);
  color: rgb(8, 145, 178);
  border: 1px solid rgba(8, 145, 178, 0.25);
}

html.dark .reforge-arrow-circle {
  background: rgba(34, 211, 238, 0.12);
  color: rgb(34, 211, 238);
  border-color: rgba(34, 211, 238, 0.25);
}

/* ── Animations ────────────────────────── */

.reforge-card-reveal {
  animation: reforgeCardReveal 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275) both;
}

.reforge-card-reveal--after {
  animation-delay: 0.15s;
}

.reforge-card-reveal--summary {
  animation-delay: 0.3s;
}

.reforge-arrow-reveal {
  animation: reforgeArrowReveal 0.4s ease-out 0.1s both;
}

@keyframes reforgeCardReveal {
  0% {
    opacity: 0;
    transform: scale(0.88) translateY(10px);
  }
  60% {
    opacity: 1;
    transform: scale(1.04) translateY(-2px);
  }
  100% {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

@keyframes reforgeArrowReveal {
  0% {
    opacity: 0;
    transform: scale(0.5);
  }
  100% {
    opacity: 1;
    transform: scale(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .reforge-card-reveal,
  .reforge-arrow-reveal {
    animation: none !important;
  }
}
</style>
