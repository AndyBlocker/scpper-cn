<script setup lang="ts">
import { formatTokenDecimal, formatTokens } from '~/utils/gachaFormatters'

withDefaults(defineProps<{
  walletBalance?: number | null
  claimableToken?: number
  pendingToken?: number
  missionClaimable?: number
  historyCount?: number
}>(), {
  walletBalance: null,
  claimableToken: 0,
  pendingToken: 0,
  missionClaimable: 0,
  historyCount: 0
})
</script>

<template>
  <section class="status-bar">
    <div class="status-bar__item">
      <p class="status-bar__label">余额</p>
      <p class="status-bar__value">{{ walletBalance == null ? '--' : `${formatTokens(walletBalance)} T` }}</p>
    </div>
    <div class="status-bar__sep" />
    <div class="status-bar__item">
      <p class="status-bar__label">可领</p>
      <p class="status-bar__value">{{ formatTokenDecimal(claimableToken, 2) }} T</p>
    </div>
    <div class="status-bar__sep" />
    <div class="status-bar__item">
      <p class="status-bar__label">缓冲</p>
      <p class="status-bar__value">{{ formatTokenDecimal(pendingToken, 2) }} T</p>
    </div>
    <div class="status-bar__sep hidden sm:block" />
    <div class="status-bar__item">
      <p class="status-bar__label">任务</p>
      <p class="status-bar__value">{{ missionClaimable }}</p>
    </div>
    <div class="status-bar__sep hidden lg:block" />
    <div class="status-bar__item">
      <p class="status-bar__label">记录</p>
      <p class="status-bar__value">{{ historyCount }}</p>
    </div>
  </section>
</template>

<style scoped>
.status-bar {
  display: grid;
  grid-template-columns: 1fr auto 1fr auto 1fr 1fr 1fr;
  align-items: center;
  gap: 0;
  border-radius: 16px;
  border: 1px solid var(--g-border, rgba(217, 226, 238, 1));
  background: var(--g-glass, rgba(255, 255, 255, 0.72));
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  padding: 4px 2px;
}

.status-bar__item {
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 4px 8px;
  min-height: 2.75rem;
}

.status-bar__label {
  font-size: 0.68rem;
  font-weight: 600;
  color: var(--g-muted, #475569);
  letter-spacing: 0.02em;
}

.status-bar__value {
  font-size: 0.82rem;
  font-weight: 800;
  color: var(--g-text, #0f172a);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-bar__sep {
  width: 1px;
  height: 60%;
  min-height: 18px;
  background: var(--g-border, rgba(217, 226, 238, 1));
  opacity: 0.6;
}

html.dark .status-bar {
  border-top-color: var(--g-glass-border, rgba(255, 255, 255, 0.06));
}

@media (max-width: 639px) {
  .status-bar {
    grid-template-columns: 1fr auto 1fr auto 1fr;
    gap: 0;
  }

  .status-bar__item:nth-child(n+8) {
    display: none;
  }
}

@media (min-width: 640px) {
  .status-bar {
    grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr 1fr;
  }
}

@media (min-width: 1024px) {
  .status-bar {
    grid-template-columns: 1fr auto 1fr auto 1fr auto 1fr auto 1fr;
  }
}
</style>
