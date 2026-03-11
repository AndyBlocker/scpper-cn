<template>
  <div v-if="totalPages > 1" class="gacha-pagination">
    <button
      type="button"
      class="gacha-pagination__btn"
      :disabled="loading || current <= 1"
      @click="emit('change', current - 1)"
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4"><path fill-rule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clip-rule="evenodd" /></svg>
    </button>

    <template v-for="p in visiblePages" :key="p">
      <span v-if="p === -1" class="gacha-pagination__ellipsis">...</span>
      <button
        v-else
        type="button"
        class="gacha-pagination__btn"
        :class="{ 'gacha-pagination__btn--active': p === current }"
        :disabled="loading"
        @click="emit('change', p)"
      >
        {{ p }}
      </button>
    </template>

    <button
      type="button"
      class="gacha-pagination__btn"
      :disabled="loading || current >= totalPages"
      @click="emit('change', current + 1)"
    >
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" class="h-4 w-4"><path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd" /></svg>
    </button>

    <span class="gacha-pagination__info">
      {{ current }} / {{ totalPages }}
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  current: number
  total: number
  pageSize: number
  loading?: boolean
}>()

const emit = defineEmits<{
  change: [page: number]
}>()

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)))

const visiblePages = computed(() => {
  const tp = totalPages.value
  const cur = props.current
  if (tp <= 7) return Array.from({ length: tp }, (_, i) => i + 1)

  const pages: number[] = []
  pages.push(1)
  if (cur > 3) pages.push(-1) // ellipsis
  for (let i = Math.max(2, cur - 1); i <= Math.min(tp - 1, cur + 1); i++) {
    pages.push(i)
  }
  if (cur < tp - 2) pages.push(-1) // ellipsis
  pages.push(tp)
  return pages
})
</script>

<style scoped>
.gacha-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 12px 0 4px;
}

.gacha-pagination__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 32px;
  height: 32px;
  padding: 0 8px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--g-text-secondary, #6b7280);
  background: transparent;
  border: 1px solid var(--g-border, rgba(0,0,0,0.08));
  cursor: pointer;
  transition: all 0.15s ease;
}

.gacha-pagination__btn:hover:not(:disabled) {
  background: var(--g-surface-hover, rgba(0,0,0,0.04));
  color: var(--g-text-primary, #111827);
}

.gacha-pagination__btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.gacha-pagination__btn--active {
  background: var(--g-accent, rgb(var(--accent-strong)));
  color: #fff;
  border-color: transparent;
}

.gacha-pagination__btn--active:hover:not(:disabled) {
  background: var(--g-accent, rgb(var(--accent-strong)));
  color: #fff;
}

.gacha-pagination__ellipsis {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 32px;
  font-size: 12px;
  color: var(--g-text-tertiary, #9ca3af);
}

.gacha-pagination__info {
  margin-left: 8px;
  font-size: 11px;
  color: var(--g-text-tertiary, #9ca3af);
}
</style>
