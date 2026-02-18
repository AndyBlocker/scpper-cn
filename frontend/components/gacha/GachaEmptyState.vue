<script setup lang="ts">
/**
 * 精致的空状态组件，替代所有 `<p class="gacha-empty">`。
 */
withDefaults(defineProps<{
  icon?: string
  title?: string
  description?: string
  actionLabel?: string
}>(), {
  icon: '📭',
  title: '暂无内容',
  description: '',
  actionLabel: ''
})

const emit = defineEmits<{
  action: []
}>()
</script>

<template>
  <div class="gacha-empty-state">
    <span class="gacha-empty-state__icon" aria-hidden="true">{{ icon }}</span>
    <p class="gacha-empty-state__title">{{ title }}</p>
    <p v-if="description" class="gacha-empty-state__desc">{{ description }}</p>
    <button
      v-if="actionLabel"
      class="gacha-empty-state__action"
      @click="emit('action')"
    >
      {{ actionLabel }}
    </button>
  </div>
</template>

<style scoped>
.gacha-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 48px 24px;
  min-height: 180px;
  border: 1px dashed var(--g-border-strong);
  border-radius: var(--g-radius-lg);
  background: var(--g-surface-recessed);
  text-align: center;
}

.gacha-empty-state__icon {
  font-size: 32px;
  line-height: 1;
  opacity: 0.6;
}

.gacha-empty-state__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--g-text-secondary);
}

.gacha-empty-state__desc {
  font-size: 13px;
  color: var(--g-text-tertiary);
  max-width: 280px;
  line-height: 1.5;
}

.gacha-empty-state__action {
  margin-top: 8px;
  height: 36px;
  padding: 0 20px;
  border-radius: 999px;
  font-size: 13px;
  font-weight: 600;
  color: var(--g-text-primary);
  background: var(--g-surface-card);
  border: 1px solid var(--g-border-strong);
  transition:
    background-color var(--g-duration-fast) var(--g-ease),
    box-shadow var(--g-duration-fast) var(--g-ease);
}

.gacha-empty-state__action:hover {
  box-shadow: var(--g-shadow-sm);
  background: var(--g-surface-card);
}
</style>
