<script setup lang="ts">
import type { Rarity } from '~/types/gacha'

const props = withDefaults(defineProps<{
  rarity: Rarity
  compact?: boolean
}>(), {
  compact: false
})

const rarityStarCountMap: Record<Rarity, number> = {
  WHITE: 1,
  GREEN: 2,
  BLUE: 3,
  PURPLE: 4,
  GOLD: 5
}

const rarityClassMap: Record<Rarity, string> = {
  WHITE: 'rarity-stars--white',
  GREEN: 'rarity-stars--green',
  BLUE: 'rarity-stars--blue',
  PURPLE: 'rarity-stars--purple',
  GOLD: 'rarity-stars--gold'
}
</script>

<template>
  <span
    class="rarity-stars inline-flex items-center rounded-full border px-2 py-0.5"
    :class="[
      rarityClassMap[props.rarity],
      props.compact ? 'text-[9px]' : 'text-[10px]'
    ]"
    :aria-label="`${props.rarity} 星级`"
  >
    <span
      v-for="idx in rarityStarCountMap[props.rarity]"
      :key="`rarity-star-${props.rarity}-${idx}`"
      class="rarity-stars__icon"
    >
      ✦
    </span>
  </span>
</template>

<style scoped>
.rarity-stars {
  gap: 0.1rem;
  font-weight: 700;
  letter-spacing: 0.02em;
  line-height: 1;
  backdrop-filter: blur(4px);
}

.rarity-stars__icon {
  display: inline-flex;
  transform: translateY(-0.02rem);
}

.rarity-stars--white {
  border-color: rgba(148, 163, 184, 0.4);
  background: linear-gradient(130deg, rgba(226, 232, 240, 0.76), rgba(203, 213, 225, 0.38));
  color: rgb(100 116 139);
}

.rarity-stars--green {
  border-color: rgba(16, 185, 129, 0.46);
  background: linear-gradient(130deg, rgba(110, 231, 183, 0.36), rgba(16, 185, 129, 0.16));
  color: rgb(5 150 105);
}

.rarity-stars--blue {
  border-color: rgba(59, 130, 246, 0.46);
  background: linear-gradient(130deg, rgba(147, 197, 253, 0.36), rgba(59, 130, 246, 0.16));
  color: rgb(29 78 216);
}

.rarity-stars--purple {
  border-color: rgba(168, 85, 247, 0.5);
  background: linear-gradient(130deg, rgba(216, 180, 254, 0.4), rgba(168, 85, 247, 0.18));
  color: rgb(126 34 206);
  box-shadow: 0 0 18px -12px rgba(168, 85, 247, 0.95);
  animation: rarityPulsePurple 2.6s ease-in-out infinite;
}

.rarity-stars--gold {
  border-color: rgba(245, 158, 11, 0.5);
  background: linear-gradient(130deg, rgba(253, 224, 71, 0.42), rgba(245, 158, 11, 0.2));
  color: rgb(180 83 9);
  box-shadow: 0 0 20px -12px rgba(245, 158, 11, 0.95);
  animation: rarityPulseGold 2.2s ease-in-out infinite;
}

html.dark .rarity-stars--white {
  border-color: rgba(148, 163, 184, 0.4);
  background: linear-gradient(130deg, rgba(100, 116, 139, 0.46), rgba(51, 65, 85, 0.34));
  color: rgb(203 213 225);
}

html.dark .rarity-stars--green {
  border-color: rgba(16, 185, 129, 0.46);
  background: linear-gradient(130deg, rgba(16, 185, 129, 0.36), rgba(5, 150, 105, 0.24));
  color: rgb(110 231 183);
}

html.dark .rarity-stars--blue {
  border-color: rgba(59, 130, 246, 0.48);
  background: linear-gradient(130deg, rgba(59, 130, 246, 0.36), rgba(29, 78, 216, 0.24));
  color: rgb(147 197 253);
}

html.dark .rarity-stars--purple {
  border-color: rgba(168, 85, 247, 0.5);
  background: linear-gradient(130deg, rgba(168, 85, 247, 0.36), rgba(126, 34, 206, 0.24));
  color: rgb(216 180 254);
}

html.dark .rarity-stars--gold {
  border-color: rgba(245, 158, 11, 0.5);
  background: linear-gradient(130deg, rgba(245, 158, 11, 0.38), rgba(217, 119, 6, 0.24));
  color: rgb(253 230 138);
}

@keyframes rarityPulsePurple {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(168, 85, 247, 0.12);
  }
  50% {
    box-shadow: 0 0 16px -4px rgba(168, 85, 247, 0.4);
  }
}

@keyframes rarityPulseGold {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.14);
  }
  50% {
    box-shadow: 0 0 18px -4px rgba(245, 158, 11, 0.48);
  }
}

@media (prefers-reduced-motion: reduce) {
  .rarity-stars--purple,
  .rarity-stars--gold {
    animation: none !important;
  }
}
</style>
