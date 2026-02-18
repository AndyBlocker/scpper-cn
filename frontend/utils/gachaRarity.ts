import type { Rarity } from '~/types/gacha'

export function rarityLabel(rarity: Rarity): string {
  switch (rarity) {
    case 'WHITE': return '白色'
    case 'GREEN': return '绿色'
    case 'BLUE': return '蓝色'
    case 'PURPLE': return '紫色'
    case 'GOLD': return '金色'
    default: return rarity
  }
}

export const raritySortWeight: Record<Rarity, number> = {
  GOLD: 0,
  PURPLE: 1,
  BLUE: 2,
  GREEN: 3,
  WHITE: 4
}

export function sortByRarity<T extends { rarity: Rarity }>(a: T, b: T): number {
  return (raritySortWeight[a.rarity] ?? 99) - (raritySortWeight[b.rarity] ?? 99)
}

export const rarityChipClassMap: Record<Rarity, string> = {
  GOLD: 'border-amber-300 bg-amber-50/80 text-amber-700 dark:border-amber-400/60 dark:bg-amber-500/10 dark:text-amber-200',
  PURPLE: 'border-purple-300 bg-purple-50/80 text-purple-700 dark:border-purple-400/60 dark:bg-purple-500/10 dark:text-purple-200',
  BLUE: 'border-blue-300 bg-blue-50/80 text-blue-700 dark:border-blue-400/60 dark:bg-blue-500/10 dark:text-blue-200',
  GREEN: 'border-emerald-300 bg-emerald-50/80 text-emerald-700 dark:border-emerald-400/60 dark:bg-emerald-500/10 dark:text-emerald-200',
  WHITE: 'border-neutral-200 bg-white/80 text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300'
}

export const rarityChipDotClassMap: Record<Rarity, string> = {
  GOLD: 'bg-amber-400',
  PURPLE: 'bg-purple-400',
  BLUE: 'bg-blue-400',
  GREEN: 'bg-emerald-400',
  WHITE: 'bg-neutral-400'
}

export const placementBaseYieldByRarity: Record<Rarity, number> = {
  WHITE: 0.5,
  GREEN: 0.7,
  BLUE: 1.0,
  PURPLE: 1.5,
  GOLD: 2.0
}
