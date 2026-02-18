<script setup lang="ts">
/**
 * 领取奖励成功后的浮动提示。
 * 从顶部滑入，3秒后自动消失，展示获得的奖励摘要。
 */
import { ref, watch, onUnmounted } from 'vue'

export interface ClaimToastItem {
  id: number
  kind: 'mission' | 'achievement'
  title: string
  rewardSummary: string
}

const props = defineProps<{
  items: ClaimToastItem[]
}>()

const emit = defineEmits<{
  dismiss: [id: number]
}>()

// Auto-dismiss timers
const timers = new Map<number, ReturnType<typeof setTimeout>>()

watch(() => props.items, (newItems) => {
  for (const item of newItems) {
    if (!timers.has(item.id)) {
      timers.set(item.id, setTimeout(() => {
        emit('dismiss', item.id)
        timers.delete(item.id)
      }, 3500))
    }
  }
}, { deep: true, immediate: true })

onUnmounted(() => {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
})
</script>

<template>
  <Teleport to="body">
    <div class="claim-toast-container" aria-live="polite">
      <TransitionGroup name="claim-toast">
        <div
          v-for="item in items"
          :key="item.id"
          class="claim-toast"
          :class="`claim-toast--${item.kind}`"
          @click="emit('dismiss', item.id)"
        >
          <div class="claim-toast__icon">
            <!-- Checkmark with circle -->
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="11" fill="currentColor" opacity="0.15" />
              <polyline points="8 12 11 15 16 9" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </div>
          <div class="claim-toast__body">
            <p class="claim-toast__title">{{ item.title }}</p>
            <p class="claim-toast__reward">{{ item.rewardSummary }}</p>
          </div>
          <button type="button" class="claim-toast__close" @click.stop="emit('dismiss', item.id)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
          <!-- Progress bar for auto-dismiss -->
          <div class="claim-toast__timer" :class="`claim-toast__timer--${item.kind}`" />
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<style scoped>
.claim-toast-container {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
  max-width: min(380px, calc(100vw - 24px));
}

.claim-toast {
  pointer-events: auto;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border-radius: var(--g-radius-md, 12px);
  border: 1px solid var(--g-border, rgba(0,0,0,0.06));
  background: var(--g-surface-card, #fff);
  box-shadow: var(--g-shadow-lg, 0 8px 28px -4px rgba(0,0,0,0.1));
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: all 0.15s ease;
}

.claim-toast:hover {
  box-shadow: var(--g-shadow-xl, 0 20px 56px -8px rgba(0,0,0,0.14));
}

html.dark .claim-toast {
  border-color: var(--g-border-strong, rgba(255,255,255,0.12));
}

/* Kind-specific accent bar */
.claim-toast--mission {
  border-left: 3px solid #059669;
}

html.dark .claim-toast--mission {
  border-left-color: #34d399;
}

.claim-toast--achievement {
  border-left: 3px solid #0891b2;
}

html.dark .claim-toast--achievement {
  border-left-color: #22d3ee;
}

.claim-toast__icon {
  flex-shrink: 0;
  margin-top: 1px;
}

.claim-toast--mission .claim-toast__icon {
  color: #059669;
}

html.dark .claim-toast--mission .claim-toast__icon {
  color: #6ee7b7;
}

.claim-toast--achievement .claim-toast__icon {
  color: #0891b2;
}

html.dark .claim-toast--achievement .claim-toast__icon {
  color: #67e8f9;
}

.claim-toast__body {
  flex: 1;
  min-width: 0;
}

.claim-toast__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--g-text-primary, #1d1d1f);
  line-height: 1.3;
}

.claim-toast__reward {
  font-size: 12px;
  color: var(--g-text-secondary, #6e6e73);
  margin-top: 2px;
  line-height: 1.3;
}

.claim-toast__close {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: none;
  background: transparent;
  color: var(--g-text-quaternary, #aeaeb2);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.1s ease;
}

.claim-toast__close:hover {
  color: var(--g-text-secondary, #6e6e73);
  background: var(--g-surface-recessed, #f0f1f3);
}

/* Auto-dismiss progress bar */
.claim-toast__timer {
  position: absolute;
  bottom: 0;
  left: 0;
  height: 2px;
  width: 100%;
  animation: claim-timer 3.5s linear forwards;
  opacity: 0.6;
}

.claim-toast__timer--mission {
  background: #059669;
}

html.dark .claim-toast__timer--mission {
  background: #34d399;
}

.claim-toast__timer--achievement {
  background: #0891b2;
}

html.dark .claim-toast__timer--achievement {
  background: #22d3ee;
}

@keyframes claim-timer {
  from { width: 100%; }
  to { width: 0%; }
}

/* TransitionGroup animations */
.claim-toast-enter-active {
  transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
}

.claim-toast-leave-active {
  transition: all 0.2s ease;
}

.claim-toast-enter-from {
  opacity: 0;
  transform: translateX(40px) scale(0.95);
}

.claim-toast-leave-to {
  opacity: 0;
  transform: translateX(20px) scale(0.95);
}

.claim-toast-move {
  transition: transform 0.25s ease;
}

@media (prefers-reduced-motion: reduce) {
  .claim-toast__timer {
    animation: none;
    width: 0;
  }
}
</style>
