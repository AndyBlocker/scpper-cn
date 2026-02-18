<script setup lang="ts">
/**
 * 通用确认弹窗 — 用于股市开仓、交易购买、分解等需要二次确认的操作。
 * 支持自定义标题、描述、确认按钮文字和危险模式。
 */
import {
  UiDialogRoot,
  UiDialogPortal,
  UiDialogOverlay,
  UiDialogContent,
  UiDialogClose
} from '~/components/ui/dialog'
import { UiButton } from '~/components/ui/button'

const props = withDefaults(defineProps<{
  open: boolean
  title?: string
  description?: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
  busy?: boolean
  details?: Array<{ label: string; value: string | number; warn?: boolean }>
}>(), {
  title: '确认操作',
  confirmText: '确认',
  cancelText: '取消',
  danger: false,
  busy: false
})

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()

function handleConfirm() {
  if (props.busy) return
  emit('confirm')
}
</script>

<template>
  <UiDialogRoot :open="open" @update:open="(v: boolean) => !v && emit('cancel')">
    <UiDialogPortal>
      <UiDialogOverlay class="gacha-confirm-overlay" />
      <UiDialogContent class="gacha-confirm-dialog">
        <div class="gacha-confirm-dialog__body">
          <h3 class="gacha-confirm-dialog__title">{{ title }}</h3>
          <p v-if="description" class="gacha-confirm-dialog__desc">{{ description }}</p>

          <div v-if="details?.length" class="gacha-confirm-dialog__details">
            <div v-for="item in details" :key="item.label" class="gacha-confirm-dialog__detail-row">
              <span class="gacha-confirm-dialog__detail-label">{{ item.label }}</span>
              <span
                class="gacha-confirm-dialog__detail-value"
                :class="{ 'gacha-confirm-dialog__detail-value--warn': item.warn }"
              >{{ item.value }}</span>
            </div>
          </div>

          <slot />
        </div>

        <div class="gacha-confirm-dialog__actions">
          <UiDialogClose as-child>
            <UiButton variant="outline" size="sm" :disabled="busy" @click="emit('cancel')">
              {{ cancelText }}
            </UiButton>
          </UiDialogClose>
          <UiButton
            :variant="danger ? 'destructive' : 'default'"
            size="sm"
            :disabled="busy"
            @click="handleConfirm"
          >
            <template v-if="busy">
              <svg class="animate-spin -ml-1 mr-1.5 h-3.5 w-3.5" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" opacity="0.25" />
                <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor" opacity="0.75" />
              </svg>
              处理中...
            </template>
            <template v-else>{{ confirmText }}</template>
          </UiButton>
        </div>
      </UiDialogContent>
    </UiDialogPortal>
  </UiDialogRoot>
</template>

<style scoped>
.gacha-confirm-overlay {
  position: fixed;
  inset: 0;
  z-index: 99;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
}

.gacha-confirm-dialog {
  position: fixed;
  z-index: 100;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  box-sizing: border-box;
  width: calc(100vw - 16px);
  width: calc(100dvw - 16px);
  max-width: 400px;
  max-height: calc(100vh - 16px);
  max-height: calc(100dvh - 16px);
  overflow-y: auto;
  border-radius: var(--g-radius-xl);
  border: 1px solid var(--g-border);
  background: var(--g-surface-card);
  box-shadow: var(--g-shadow-xl);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.gacha-confirm-dialog__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.gacha-confirm-dialog__title {
  font-size: 16px;
  font-weight: 700;
  color: var(--g-text-primary);
  letter-spacing: -0.01em;
}

.gacha-confirm-dialog__desc {
  font-size: 14px;
  color: var(--g-text-secondary);
  line-height: 1.5;
}

.gacha-confirm-dialog__details {
  margin-top: 4px;
  padding: 12px;
  border-radius: var(--g-radius-md);
  background: var(--g-surface-recessed);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.gacha-confirm-dialog__detail-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
}

.gacha-confirm-dialog__detail-label {
  color: var(--g-text-tertiary);
}

.gacha-confirm-dialog__detail-value {
  color: var(--g-text-primary);
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.gacha-confirm-dialog__detail-value--warn {
  color: #e67e22;
}

.gacha-confirm-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
