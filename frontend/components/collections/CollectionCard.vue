<template>
  <article
    :class="[
      'group relative overflow-hidden rounded-3xl border border-transparent shadow-[0_20px_60px_rgba(15,23,42,0.12)] transition hover:-translate-y-1 hover:shadow-[0_32px_80px_rgba(15,23,42,0.18)] dark:shadow-[0_32px_70px_rgba(0,0,0,0.55)]',
      clickable ? 'cursor-pointer focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)]' : ''
    ]"
    @click="$emit('select', collection)"
  >
    <div class="absolute inset-0" :class="accentGradient(collection.id)" />
    <div class="relative flex h-full flex-col overflow-hidden rounded-[26px] border border-white/70 bg-white/85 backdrop-blur-sm transition duration-300 dark:border-white/10 dark:bg-neutral-950/75">
      <div class="relative h-44 overflow-hidden">
        <div
          v-if="collection.coverImageUrl"
          class="absolute inset-0 bg-cover bg-center transition-transform duration-500 group-hover:scale-105"
          :style="{
            backgroundImage: `url(${collection.coverImageUrl})`,
            backgroundPosition: coverPosition(collection.coverImageOffsetX, collection.coverImageOffsetY),
            backgroundSize: coverSize(collection.coverImageScale)
          }"
        />
        <div class="absolute inset-0 bg-gradient-to-t from-neutral-950/70 via-neutral-900/35 to-transparent" />
        <div class="relative z-10 flex h-full flex-col justify-end gap-3 p-5">
          <div class="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 text-xs font-semibold text-white/90 backdrop-blur">
            <LucideIcon name="Bookmark" class="h-3.5 w-3.5" />
            {{ collection.itemCount }} 条目
          </div>
          <h3 class="text-xl font-semibold text-white drop-shadow-sm line-clamp-2">{{ collection.title }}</h3>
          <div class="flex flex-wrap items-center gap-2 text-xs text-white/80">
            <span
              v-if="showVisibility"
              class="inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-0.5 font-medium"
            >
              <LucideIcon :name="collection.visibility === 'PUBLIC' ? 'Globe2' : 'Lock'" class="h-3.5 w-3.5" />
              {{ collection.visibility === 'PUBLIC' ? '公开' : '私密' }}
            </span>
            <span class="inline-flex items-center gap-1">
              <LucideIcon name="Clock" class="h-3.5 w-3.5" />
              更新 {{ formatDate(collection.updatedAt) }}
            </span>
          </div>
        </div>
      </div>
      <div class="flex flex-1 flex-col gap-4 p-5">
        <p v-if="collection.description" class="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300 line-clamp-3">
          {{ collection.description }}
        </p>
        <p v-else class="text-sm text-neutral-400 dark:text-neutral-500">还没有简介，点击编辑补充一些介绍。</p>
        <div class="mt-auto flex items-center justify-between text-xs text-neutral-400 dark:text-neutral-500">
          <span class="inline-flex items-center gap-1">
            <LucideIcon name="Sparkle" class="h-3.5 w-3.5" />
            精选灵感
          </span>
          <slot name="footer" />
        </div>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { format } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import type { CollectionSummary } from '~/composables/useCollections'

defineProps<{
  collection: CollectionSummary
  clickable?: boolean
  showVisibility?: boolean
}>()

defineEmits<{ (e: 'select', collection: CollectionSummary): void }>()

const accentTokens = [
  'bg-gradient-to-br from-sky-500/30 via-blue-500/15 to-indigo-500/35 dark:from-sky-500/35 dark:via-blue-500/20 dark:to-indigo-500/40',
  'bg-gradient-to-br from-emerald-400/25 via-teal-400/15 to-cyan-500/30 dark:from-emerald-400/30 dark:via-teal-400/20 dark:to-cyan-500/35',
  'bg-gradient-to-br from-amber-400/25 via-orange-400/15 to-rose-400/25 dark:from-amber-400/30 dark:via-orange-400/20 dark:to-rose-400/30',
  'bg-gradient-to-br from-fuchsia-500/30 via-purple-500/15 to-blue-500/30 dark:from-fuchsia-500/35 dark:via-purple-500/20 dark:to-blue-500/35'
]

function accentGradient(id: number | null | undefined) {
  if (!Number.isFinite(Number(id))) return accentTokens[0]
  const index = Math.abs(Number(id)) % accentTokens.length
  return accentTokens[index]
}

function coverPosition(offsetX: number | null | undefined, offsetY: number | null | undefined): string {
  const clampedX = clamp(offsetX)
  const clampedY = clamp(offsetY)
  return `${50 - clampedX}% ${50 - clampedY}%`
}

function coverSize(scale: number | null | undefined): string {
  const value = clampScale(scale)
  return `${value * 100}% auto`
}

function clamp(value: number | null | undefined): number {
  if (!Number.isFinite(Number(value))) return 0
  const numeric = Number(value)
  if (Number.isNaN(numeric)) return 0
  return Math.min(60, Math.max(-60, numeric))
}

function clampScale(value: number | null | undefined): number {
  if (!Number.isFinite(Number(value))) return 1
  const numeric = Number(value)
  if (Number.isNaN(numeric)) return 1
  return Math.min(2.5, Math.max(0.75, numeric))
}

function formatDate(value: string | null): string {
  if (!value) return '—'
  try {
    return format(new Date(value), 'yyyy/MM/dd', { locale: zhCN })
  } catch {
    return value.slice(0, 10)
  }
}
</script>
