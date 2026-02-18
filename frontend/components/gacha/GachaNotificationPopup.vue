<script setup lang="ts">
import {
  UiDialogRoot,
  UiDialogPortal,
  UiDialogOverlay,
  UiDialogContent,
  UiDialogClose
} from '~/components/ui/dialog'
import { UiButton } from '~/components/ui/button'
import { formatTokens } from '~/utils/gachaFormatters'

export interface GachaNotification {
  id: string
  delta: number
  message: string
  reason: string | null
  createdAt: string
}

const props = defineProps<{
  open: boolean
  items: GachaNotification[]
}>()

const emit = defineEmits<{
  dismiss: []
}>()

function formatTime(iso: string) {
  try {
    const d = new Date(iso)
    const pad = (n: number) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return iso
  }
}
</script>

<template>
  <UiDialogRoot :open="open" @update:open="(v: boolean) => !v && emit('dismiss')">
    <UiDialogPortal>
      <UiDialogOverlay class="gacha-notif-overlay" />
      <UiDialogContent class="gacha-notif-dialog">
        <div class="gacha-notif-dialog__header">
          <svg class="gacha-notif-dialog__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.73 21a2 2 0 0 1-3.46 0" />
          </svg>
          <h3 class="gacha-notif-dialog__title">系统通知</h3>
        </div>

        <div class="gacha-notif-dialog__list">
          <div
            v-for="item in items"
            :key="item.id"
            class="gacha-notif-dialog__item"
          >
            <div class="gacha-notif-dialog__item-header">
              <span
                class="gacha-notif-dialog__delta"
                :class="item.delta > 0 ? 'is-positive' : 'is-negative'"
              >
                {{ item.delta > 0 ? '+' : '' }}{{ formatTokens(item.delta) }} T
              </span>
              <span class="gacha-notif-dialog__time">{{ formatTime(item.createdAt) }}</span>
            </div>
            <p class="gacha-notif-dialog__message">{{ item.message }}</p>
          </div>
        </div>

        <div class="gacha-notif-dialog__actions">
          <UiDialogClose as-child>
            <UiButton variant="default" size="sm" @click="emit('dismiss')">
              知道了
            </UiButton>
          </UiDialogClose>
        </div>
      </UiDialogContent>
    </UiDialogPortal>
  </UiDialogRoot>
</template>

<style scoped>
.gacha-notif-overlay {
  position: fixed;
  inset: 0;
  z-index: 99;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.gacha-notif-dialog {
  position: fixed;
  z-index: 100;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  box-sizing: border-box;
  width: calc(100vw - 16px);
  width: calc(100dvw - 16px);
  max-width: 420px;
  max-height: calc(100vh - 48px);
  max-height: calc(100dvh - 48px);
  overflow-y: auto;
  border-radius: var(--g-radius-xl);
  border: 1px solid var(--g-border);
  background: var(--g-surface-card);
  box-shadow: var(--g-shadow-xl);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.gacha-notif-dialog__header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.gacha-notif-dialog__icon {
  color: rgb(var(--accent-strong, 99 102 241));
  flex-shrink: 0;
}

.gacha-notif-dialog__title {
  font-size: 16px;
  font-weight: 700;
  color: var(--g-text-primary);
  letter-spacing: -0.01em;
}

.gacha-notif-dialog__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: min(60vh, 480px);
  overflow-y: auto;
}

.gacha-notif-dialog__item {
  padding: 12px;
  border-radius: var(--g-radius-md);
  background: var(--g-surface-recessed);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.gacha-notif-dialog__item-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.gacha-notif-dialog__delta {
  font-size: 14px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.gacha-notif-dialog__delta.is-positive {
  color: rgb(34 197 94);
}

.gacha-notif-dialog__delta.is-negative {
  color: rgb(239 68 68);
}

.gacha-notif-dialog__time {
  font-size: 11px;
  color: var(--g-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.gacha-notif-dialog__message {
  font-size: 14px;
  color: var(--g-text-secondary);
  line-height: 1.6;
  white-space: pre-line;
  word-break: break-word;
}

.gacha-notif-dialog__actions {
  display: flex;
  justify-content: flex-end;
}
</style>
