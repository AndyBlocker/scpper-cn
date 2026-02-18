<script setup lang="ts">
/**
 * GachaErrorBanner — 错误/成功消息横幅。
 * v2: 添加图标 + 可选关闭按钮。
 */
defineProps<{
  error: string | null
  success?: string | null
  dismissible?: boolean
}>()

const emit = defineEmits<{
  dismiss: []
}>()
</script>

<template>
  <Transition name="fade">
    <div
      v-if="error"
      class="gacha-banner gacha-banner--error"
      role="alert"
    >
      <span class="gacha-banner__icon">⚠</span>
      <span class="gacha-banner__text">{{ error }}</span>
      <button
        v-if="dismissible"
        class="gacha-banner__close"
        aria-label="关闭"
        @click="emit('dismiss')"
      >
        ✕
      </button>
    </div>
  </Transition>
  <Transition name="fade">
    <div
      v-if="success"
      class="gacha-banner gacha-banner--success"
      role="status"
    >
      <span class="gacha-banner__icon">✓</span>
      <span class="gacha-banner__text">{{ success }}</span>
      <button
        v-if="dismissible"
        class="gacha-banner__close"
        aria-label="关闭"
        @click="emit('dismiss')"
      >
        ✕
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.gacha-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-radius: var(--g-radius-md);
  font-size: 14px;
  line-height: 1.5;
}

.gacha-banner--error {
  color: #be123c;
  background: rgba(255, 228, 230, 0.6);
  border: 1px solid rgba(251, 113, 133, 0.25);
}

html.dark .gacha-banner--error {
  color: #fda4af;
  background: rgba(159, 18, 57, 0.15);
  border-color: rgba(251, 113, 133, 0.2);
}

.gacha-banner--success {
  color: #047857;
  background: rgba(209, 250, 229, 0.6);
  border: 1px solid rgba(52, 211, 153, 0.25);
}

html.dark .gacha-banner--success {
  color: #6ee7b7;
  background: rgba(6, 78, 59, 0.15);
  border-color: rgba(52, 211, 153, 0.2);
}

.gacha-banner__icon {
  flex-shrink: 0;
  font-size: 14px;
  line-height: 1;
  opacity: 0.8;
}

.gacha-banner__text {
  flex: 1;
  min-width: 0;
}

.gacha-banner__close {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  font-size: 11px;
  color: inherit;
  opacity: 0.5;
  background: transparent;
  border: none;
  cursor: pointer;
  transition: opacity var(--g-duration-fast) var(--g-ease);
}

.gacha-banner__close:hover {
  opacity: 1;
}
</style>
