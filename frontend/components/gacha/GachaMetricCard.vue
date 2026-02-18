<script setup lang="ts">
type MetricTone = 'default' | 'accent' | 'success' | 'danger'
type MetricDensity = 'default' | 'compact'

withDefaults(defineProps<{
  label: string
  value?: string | number
  tone?: MetricTone
  density?: MetricDensity
  note?: string | null
  loading?: boolean
}>(), {
  value: '',
  tone: 'default',
  density: 'compact',
  note: null,
  loading: false
})
</script>

<template>
  <article class="gacha-metric" :class="[`gacha-metric--${tone}`, `gacha-metric--${density}`]">
    <p class="gacha-metric__label">{{ label }}</p>
    <template v-if="loading">
      <div class="gacha-skeleton" style="height:24px;width:60%;margin-top:4px;border-radius:6px" />
    </template>
    <template v-else>
      <p class="gacha-metric__value">
        <slot>{{ value }}</slot>
      </p>
      <p v-if="note" class="gacha-metric__note">{{ note }}</p>
    </template>
  </article>
</template>

<style scoped>
.gacha-metric {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 12px 14px;
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-md);
  background: var(--g-surface-card);
  box-shadow: var(--g-shadow-xs);
  transition:
    box-shadow var(--g-duration-fast) var(--g-ease),
    transform var(--g-duration-fast) var(--g-ease);
}

.gacha-metric:hover {
  box-shadow: var(--g-shadow-sm);
}

.gacha-metric--compact {
  padding: 10px 14px;
}

.gacha-metric__label {
  font-size: 12px;
  font-weight: 500;
  color: var(--g-text-tertiary);
  letter-spacing: 0.02em;
}

.gacha-metric__value {
  font-size: clamp(1.25rem, 2.5vw, 1.5rem);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  color: var(--g-text-primary);
}

.gacha-metric__note {
  margin-top: 2px;
  font-size: 11px;
  color: var(--g-text-tertiary);
}

/* Tone: accent */
.gacha-metric--accent {
  border-color: rgb(var(--accent) / 0.15);
  background: rgb(var(--accent) / 0.03);
}

.gacha-metric--accent .gacha-metric__value {
  color: rgb(var(--accent-strong));
}

/* Tone: success */
.gacha-metric--success {
  border-color: rgba(5, 150, 105, 0.12);
  background: rgba(5, 150, 105, 0.03);
}

.gacha-metric--success .gacha-metric__value {
  color: #059669;
}

html.dark .gacha-metric--success .gacha-metric__value {
  color: #6ee7b7;
}

/* Tone: danger */
.gacha-metric--danger {
  border-color: rgba(190, 18, 93, 0.12);
  background: rgba(190, 18, 93, 0.03);
}

.gacha-metric--danger .gacha-metric__value {
  color: #be123c;
}

html.dark .gacha-metric--danger .gacha-metric__value {
  color: #fda4af;
}

@media (prefers-reduced-motion: reduce) {
  .gacha-metric {
    transition: none !important;
  }
}
</style>
