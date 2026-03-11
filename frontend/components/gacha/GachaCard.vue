<template>
  <article
    ref="cardRef"
    class="gacha-card"
    :class="[
      `gacha-card--${effectiveVariant}`,
      rarityClass,
      { 'is-coated': affix.isCoated.value }
    ]"
    :style="{ ...affix.toneStyle.value, ...tiltStyle }"
    @mousemove="onMouseMove"
    @mouseleave="onMouseLeave"
  >
    <component :is="linkComponent" v-bind="linkAttrs" class="gacha-card__body">
      <!-- Media area -->
      <div class="gacha-card__media" :class="affix.frameClass.value">
        <img
          v-if="props.imageUrl"
          :src="props.imageUrl"
          :alt="displayTitle"
          class="gacha-card__img"
          :style="{ filter: affix.mediaFilter.value }"
          loading="lazy"
          decoding="async"
        >
        <div v-else class="gacha-card__fallback">
          <img
            src="/icons/favicon-light.svg"
            alt=""
            class="gacha-card__fallback-icon"
            aria-hidden="true"
          >
        </div>

        <!-- Affix overlay (gradient) -->
        <div v-if="affix.overlayClass.value" class="gacha-card__overlay" :class="affix.overlayClass.value" />

        <!-- Holographic foil layer (hover-only) -->
        <div
          v-if="affix.isCoated.value && affix.foilGradient.value"
          class="gacha-card__foil"
          :style="foilStyle"
        />

        <!-- Rarity bottom band -->
        <div class="gacha-card__rarity-band" />

        <!-- Top badge row -->
        <div class="gacha-card__top">
          <div class="gacha-card__top-left">
            <UiBadge
              :variant="props.rarity"
              :class="effectiveVariant === 'mini' ? 'gacha-card__badge--mini' : ''"
            >
              {{ rarityLabel(props.rarity) }}
            </UiBadge>
            <div v-if="props.retired" class="gacha-card__retired-indicator">绝版</div>
          </div>
          <UiTooltipProvider v-if="affix.isCoated.value" :delay-duration="180">
            <UiTooltip>
              <UiTooltipTrigger as-child>
                <span class="gacha-card__coating-chip" :class="affix.chipClass.value">
                  {{ effectiveVariant === 'mini' ? affix.chipTextMini.value : affix.chipText.value }}
                </span>
              </UiTooltipTrigger>
              <UiTooltipContent>{{ affix.tooltipText.value }}</UiTooltipContent>
            </UiTooltip>
          </UiTooltipProvider>
        </div>

        <!-- Lock indicator -->
        <div
          v-if="props.locked"
          class="gacha-card__lock-indicator"
          :class="{ 'gacha-card__lock-indicator--with-retired': props.retired }"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1s3.1 1.39 3.1 3.1v2z"/></svg>
        </div>

        <div class="gacha-card__media-bottom">
          <span class="gacha-card__major-type gacha-card__major-type--media" :class="majorTypeClass">{{ majorTypeLabel }}</span>
        </div>
      </div>

      <!-- Content -->
      <div class="gacha-card__content">
        <div v-if="resolvedAuthors.length > 0" class="gacha-card__meta" :title="authorTooltip">
          <div class="gacha-card__author">
            <UserAvatar
              class="gacha-card__author-avatar"
              :wikidot-id="primaryAuthor.wikidotId"
              :name="primaryAuthor.name"
              :size="authorAvatarSize"
            />
            <div class="gacha-card__author-text">
              <span class="gacha-card__author-name">{{ primaryAuthor.name }}</span>
              <span v-if="primaryAuthorIdText" class="gacha-card__author-id">{{ primaryAuthorIdText }}</span>
              <span v-if="extraAuthorCount > 0" class="gacha-card__author-extra">+{{ extraAuthorCount }}</span>
            </div>
          </div>
        </div>
        <h3 class="gacha-card__title">{{ displayTitle }}</h3>
        <div v-if="effectiveVariant === 'large' && visibleTags.length" class="gacha-card__tags">
          <span v-for="tag in visibleTags" :key="tag" class="gacha-card__tag">#{{ tag }}</span>
        </div>
      </div>
    </component>

    <!-- Footer -->
    <footer
      v-if="!props.hideFooter && (props.count != null || $slots.meta || $slots.actions)"
      class="gacha-card__footer"
    >
      <span v-if="props.count != null" class="gacha-card__count">x{{ props.count }}</span>
      <slot name="meta" />
      <slot name="actions" />
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { NuxtLink } from '#components'
import { orderTags } from '~/composables/useTagOrder'
import { usePageAuthors } from '~/composables/usePageAuthors'
import { useCardAffix, type AffixSource } from '~/composables/useCardAffix'
import type { Rarity, AffixVisualStyle } from '~/types/gacha'
import { stripLegacyGachaTitleSuffix } from '~/utils/gachaTitle'
import { rarityLabel } from '~/utils/gachaRarity'
import UserAvatar from '~/components/UserAvatar.vue'
import { UiBadge } from '~/components/ui/badge'
import {
  UiTooltipProvider, UiTooltip, UiTooltipTrigger, UiTooltipContent
} from '~/components/ui/tooltip'

const props = defineProps<{
  title: string
  rarity: Rarity
  tags: string[]
  count?: number
  imageUrl?: string | null
  pageUrl?: string | null
  wikidotId?: number | null
  authors?: Array<{ name: string; wikidotId: number | null }> | null
  affixVisualStyle?: AffixVisualStyle | null
  affixLabel?: string | null
  affixSignature?: string | null
  affixStyles?: AffixVisualStyle[] | null
  affixStyleCounts?: Partial<Record<AffixVisualStyle, number>> | null
  variant?: 'mini' | 'large' | 'featured'
  density?: 'default' | 'compact'
  hideFooter?: boolean
  locked?: boolean
  retired?: boolean
}>()

type MajorType = 'SCP' | 'TALE' | 'GOIF' | 'ART' | 'WANDERERS' | 'OTHER'
type CardAuthor = { name: string; wikidotId: number | null }

const majorTypeAliasMap = {
  SCP: ['scp', 'scpi', 'scp-cn', 'scpcn'],
  TALE: ['故事', 'tale', 'tales'],
  GOIF: ['goif', 'goi', 'goi格式', 'goiformat'],
  ART: ['艺术作品', '艺术', 'art', 'artwork'],
  WANDERERS: ['wanderers', '图书馆', '流浪者图书馆']
} as const satisfies Record<Exclude<MajorType, 'OTHER'>, readonly string[]>

const majorTypeMetaMap: Record<MajorType, { label: string; className: string }> = {
  SCP: { label: 'SCP', className: 'gacha-card__major-type--scp' },
  TALE: { label: 'TALE', className: 'gacha-card__major-type--tale' },
  GOIF: { label: 'GOIF', className: 'gacha-card__major-type--goif' },
  ART: { label: 'ART', className: 'gacha-card__major-type--art' },
  WANDERERS: { label: 'WANDERERS', className: 'gacha-card__major-type--wanderers' },
  OTHER: { label: 'OTHER', className: 'gacha-card__major-type--other' }
}

const authorTagPrefix = /^(?:作者|author|authors|by|译者|translator|translators?)[\s:：_\-－/\\|]+(.+)$/i
const authorTagPrefixCompact = /^(?:作者|author|authors|by|译者|translator|translators?)(.+)$/i
const authorGenericKeys = new Set([
  'unknown',
  'unknownauthor',
  'anonymous',
  'anon',
  '匿名',
  '佚名',
  '多人',
  '多位作者',
  'collective'
])

const cardRef = ref<HTMLElement | null>(null)
const pageAuthors = usePageAuthors()

function normalizeTagToken(raw: unknown) {
  return String(raw ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-')
}

function compactTagToken(raw: string) {
  return String(raw || '').toLowerCase().replace(/[\s_:\-/\\：；，、|]+/g, '')
}

function normalizeAuthorLabel(raw: string) {
  return String(raw || '')
    .trim()
    .replace(/^[：:、，;；\-－\s]+/, '')
    .replace(/^[#@]+/, '')
    .replace(/[_]+/g, ' ')
}

function normalizeAuthorKey(raw: string) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^[#@]+/, '')
    .replace(/[\s_:\-/\\.\u3000：；，、|]+/g, '')
}

function hasTagAlias(
  lookup: { normalized: Set<string>; compact: Set<string> },
  aliases: readonly string[]
) {
  for (const alias of aliases) {
    const normalized = normalizeTagToken(alias)
    if (!normalized) continue
    if (lookup.normalized.has(normalized)) return true
    if (lookup.compact.has(compactTagToken(normalized))) return true
  }
  return false
}

function normalizeAuthors(entries: Array<{ name?: string | null; wikidotId?: number | null }> | null | undefined) {
  const list = Array.isArray(entries) ? entries : []
  const dedupe = new Set<string>()
  const normalized: CardAuthor[] = []
  for (const entry of list) {
    const name = String(entry?.name ?? '').trim()
    if (!name) continue
    const rawId = Number(entry?.wikidotId)
    const wikidotId = Number.isFinite(rawId) && rawId > 0 ? rawId : null
    const key = wikidotId != null ? `id:${wikidotId}` : `name:${normalizeAuthorKey(name)}`
    if (dedupe.has(key)) continue
    dedupe.add(key)
    normalized.push({ name, wikidotId })
  }
  return normalized
}

function extractAuthorsFromTags(tags: string[] | null | undefined): CardAuthor[] {
  const map = new Map<string, string>()
  for (const rawTag of tags ?? []) {
    const source = String(rawTag ?? '').trim()
    if (!source) continue
    let payload = source.match(authorTagPrefix)?.[1] ?? ''
    if (!payload) {
      const compact = compactTagToken(source)
      payload = compact.match(authorTagPrefixCompact)?.[1] ?? ''
    }
    if (!payload) continue
    const labels = String(payload)
      .split(/[,&+、|/，;；]/g)
      .map((item) => item.trim())
      .filter(Boolean)
    for (const rawLabel of labels) {
      const label = normalizeAuthorLabel(rawLabel)
      const key = normalizeAuthorKey(label)
      if (!key || authorGenericKeys.has(key)) continue
      if (!map.has(key)) map.set(key, label || key)
    }
  }
  return Array.from(map.values()).map((name) => ({ name, wikidotId: null }))
}

// Variant
const effectiveVariant = computed<'mini' | 'large' | 'featured'>(() => {
  if (props.variant) return props.variant
  return props.density === 'compact' ? 'mini' : 'large'
})

// Rarity class
const rarityClassMap: Record<Rarity, string> = {
  WHITE: 'is-white',
  GREEN: 'is-green',
  BLUE: 'is-blue',
  PURPLE: 'is-purple',
  GOLD: 'is-gold'
}
const rarityClass = computed(() => rarityClassMap[props.rarity] || 'is-white')

// Link
const linkComponent = computed(() => (props.pageUrl ? NuxtLink : 'div'))
const linkAttrs = computed(() => (props.pageUrl ? { to: props.pageUrl } : {}))

// Title
const displayTitle = computed(() => stripLegacyGachaTitleSuffix(props.title) || '未命名')

// Tags
const visibleTags = computed(() => {
  const base = orderTags((props.tags || []).filter((tag) => tag && !tag.startsWith('_')))
  return effectiveVariant.value === 'mini' ? base.slice(0, 1) : base.slice(0, 4)
})

// --- Merged: tag lookup + major type (single computed instead of 4) ---
const majorTypeMeta = computed(() => {
  const normalized = new Set<string>()
  const compact = new Set<string>()
  for (const raw of props.tags ?? []) {
    const token = normalizeTagToken(raw)
    if (!token) continue
    normalized.add(token)
    compact.add(compactTagToken(token))
  }
  const lookup = { normalized, compact }
  let type: MajorType = 'OTHER'
  if (hasTagAlias(lookup, majorTypeAliasMap.SCP)) type = 'SCP'
  else if (hasTagAlias(lookup, majorTypeAliasMap.TALE)) type = 'TALE'
  else if (hasTagAlias(lookup, majorTypeAliasMap.GOIF)) type = 'GOIF'
  else if (hasTagAlias(lookup, majorTypeAliasMap.ART)) type = 'ART'
  else if (hasTagAlias(lookup, majorTypeAliasMap.WANDERERS)) type = 'WANDERERS'
  return majorTypeMetaMap[type]
})

const majorTypeLabel = computed(() => majorTypeMeta.value.label)
const majorTypeClass = computed(() => majorTypeMeta.value.className)

// --- Merged: author resolution (single computed instead of 4) ---
const resolvedAuthors = computed<CardAuthor[]>(() => {
  // Priority 1: explicit prop authors
  const fromProps = normalizeAuthors(props.authors)
  if (fromProps.length) return fromProps
  // Priority 2: cached page authors (by wikidotId)
  const wikidotId = Number(props.wikidotId)
  if (Number.isFinite(wikidotId) && wikidotId > 0) {
    const fromCache = normalizeAuthors(pageAuthors.getAuthors(wikidotId))
    if (fromCache.length) return fromCache
  }
  // Priority 3: extract from tags
  return extractAuthorsFromTags(props.tags)
})
const primaryAuthor = computed<CardAuthor>(() => (
  resolvedAuthors.value[0] ?? { name: '未知作者', wikidotId: null }
))
const extraAuthorCount = computed(() => Math.max(0, resolvedAuthors.value.length - 1))
const showAuthorId = computed(() => effectiveVariant.value !== 'mini' && primaryAuthor.value.wikidotId != null)
const primaryAuthorIdText = computed(() => (
  showAuthorId.value ? `#${primaryAuthor.value.wikidotId}` : ''
))
const authorTooltip = computed(() => {
  const list = resolvedAuthors.value.length ? resolvedAuthors.value : [primaryAuthor.value]
  return list
    .map((author) => (
      author.wikidotId != null
        ? `${author.name} (#${author.wikidotId})`
        : author.name
    ))
    .join('、')
})
const authorAvatarSize = computed(() => effectiveVariant.value === 'mini' ? 12 : 14)

// Affix composable
const affixSource = computed<AffixSource>(() => ({
  affixSignature: props.affixSignature,
  affixStyles: props.affixStyles,
  affixStyleCounts: props.affixStyleCounts,
  affixVisualStyle: props.affixVisualStyle
}))
const affixLabelRef = computed(() => props.affixLabel)
const affix = useCardAffix(affixSource, affixLabelRef)

// 3D Tilt + Foil angle (mouse tracking) with RAF throttle
const tiltX = ref(0)
const tiltY = ref(0)
const foilAngle = ref(0)
const isHovering = ref(false)

// Skip 3D tilt on touch devices (no hover capability)
const supportsHover = ref(true)
if (import.meta.client) {
  supportsHover.value = window.matchMedia('(hover: hover)').matches
}

const maxTilt = computed(() => effectiveVariant.value === 'mini' ? 2 : 4)

let tiltRafId: number | null = null

function onMouseMove(e: MouseEvent) {
  if (!supportsHover.value || !cardRef.value) return
  if (tiltRafId != null) return // skip if RAF pending
  tiltRafId = requestAnimationFrame(() => {
    tiltRafId = null
    if (!cardRef.value) return
    const rect = cardRef.value.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    tiltX.value = (y - 0.5) * -maxTilt.value
    tiltY.value = (x - 0.5) * maxTilt.value
    foilAngle.value = Math.atan2(y - 0.5, x - 0.5) * (180 / Math.PI) + 180
    isHovering.value = true
  })
}

function onMouseLeave() {
  if (tiltRafId != null) {
    cancelAnimationFrame(tiltRafId)
    tiltRafId = null
  }
  tiltX.value = 0
  tiltY.value = 0
  isHovering.value = false
}

const tiltStyle = computed(() => {
  if (!isHovering.value) return {}
  return {
    '--tilt-x': `${tiltX.value}deg`,
    '--tilt-y': `${tiltY.value}deg`,
    '--foil-angle': `${foilAngle.value}deg`
  }
})

const foilStyle = computed(() => {
  if (!affix.foilGradient.value) return {}
  return {
    background: `conic-gradient(from var(--foil-angle, 0deg), ${affix.foilGradient.value})`
  }
})
</script>

<style scoped>
.gacha-card {
  --tilt-x: 0deg;
  --tilt-y: 0deg;
  --foil-angle: 0deg;

  position: relative;
  border: 1px solid var(--g-border);
  border-radius: var(--g-radius-md);
  background: var(--g-surface-card);
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-width: 0;
  overflow: hidden;
  transform-style: preserve-3d;
  contain: layout style paint;
  will-change: auto;
  transition:
    transform var(--g-duration-fast) var(--g-ease),
    box-shadow var(--g-duration-fast) var(--g-ease),
    border-color var(--g-duration-fast) var(--g-ease);
}

.gacha-card__body {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  text-decoration: none;
  color: inherit;
}

/* ── Media ── */

.gacha-card__media {
  position: relative;
  overflow: hidden;
  isolation: isolate;
}

.gacha-card--mini .gacha-card__media {
  aspect-ratio: 3 / 4;
}

.gacha-card--large .gacha-card__media {
  aspect-ratio: 16 / 10;
}

.gacha-card--featured .gacha-card__media {
  aspect-ratio: 4 / 5;
}

.gacha-card__img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.gacha-card__fallback {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background:
    linear-gradient(135deg, var(--g-surface-recessed) 0%, var(--g-surface-deep) 100%);
}

.gacha-card__fallback-icon {
  width: 36%;
  height: 36%;
  object-fit: contain;
  opacity: 0.1;
  pointer-events: none;
  user-select: none;
}

html.dark .gacha-card__fallback-icon {
  filter: invert(1);
  opacity: 0.12;
}

.gacha-card__overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}

/* ── Foil (holographic, hover-only on pointer devices) ── */

.gacha-card__foil {
  position: absolute;
  inset: 0;
  pointer-events: none;
  mix-blend-mode: overlay;
  opacity: 0;
  transition: opacity 0.4s ease;
  z-index: 1;
  will-change: opacity;
}

/* Foil sweep animation on hover entrance */
@keyframes foil-sweep-in {
  0% { opacity: 0; filter: brightness(1); }
  30% { opacity: 0.65; filter: brightness(1.15); }
  100% { opacity: 0.45; filter: brightness(1); }
}

@media (hover: hover) {
  .gacha-card:hover .gacha-card__foil {
    animation: foil-sweep-in 0.8s ease-out forwards;
  }
}

/* ── Rarity bottom band + glow ── */

.gacha-card__rarity-band {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 3px;
  z-index: 1;
}

.gacha-card.is-gold .gacha-card__rarity-band {
  background: var(--g-rarity-gold);
  box-shadow: 0 -4px 12px -2px rgba(217, 119, 6, 0.35), 0 -1px 4px rgba(217, 119, 6, 0.2);
}

.gacha-card.is-purple .gacha-card__rarity-band {
  background: var(--g-rarity-purple);
  box-shadow: 0 -4px 10px -2px rgba(124, 58, 237, 0.3), 0 -1px 3px rgba(124, 58, 237, 0.15);
}

.gacha-card.is-blue .gacha-card__rarity-band {
  background: var(--g-rarity-blue);
  box-shadow: 0 -3px 8px -2px rgba(37, 99, 235, 0.25);
}

.gacha-card.is-green .gacha-card__rarity-band {
  background: var(--g-rarity-green);
  box-shadow: 0 -2px 6px -2px rgba(5, 150, 105, 0.2);
}

.gacha-card.is-white .gacha-card__rarity-band {
  background: var(--g-rarity-white);
  opacity: 0.35;
}

/* ── Top badge row ── */

.gacha-card__top {
  position: absolute;
  top: 6px;
  left: 6px;
  right: 6px;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 4px;
}

.gacha-card__top-left {
  display: inline-flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}

.gacha-card--mini .gacha-card__top {
  top: 4px;
  left: 4px;
  right: 4px;
}

/* ── Lock indicator ── */

.gacha-card__lock-indicator {
  position: absolute;
  top: 28px;
  left: 6px;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  color: rgba(255, 255, 255, 0.85);
  pointer-events: none;
}

.gacha-card__lock-indicator--with-retired {
  top: 52px;
}

.gacha-card__lock-indicator svg {
  width: 12px;
  height: 12px;
}

.gacha-card__retired-indicator {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 38px;
  height: 18px;
  padding: 0 7px;
  border-radius: 999px;
  border: 1px solid rgba(190, 24, 93, 0.28);
  background: linear-gradient(135deg, rgba(255, 241, 242, 0.92), rgba(255, 228, 230, 0.82));
  color: rgb(159 18 57);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  pointer-events: none;
  box-shadow: 0 8px 18px -12px rgba(159, 18, 57, 0.45);
}

html.dark .gacha-card__retired-indicator {
  border-color: rgba(251, 113, 133, 0.28);
  background: linear-gradient(135deg, rgba(76, 5, 25, 0.88), rgba(136, 19, 55, 0.72));
  color: rgb(255 228 230);
}

.gacha-card--mini .gacha-card__lock-indicator {
  top: 20px;
  left: 4px;
  width: 16px;
  height: 16px;
  border-radius: 4px;
}

.gacha-card--mini .gacha-card__lock-indicator--with-retired {
  top: 34px;
}

.gacha-card--mini .gacha-card__lock-indicator svg {
  width: 10px;
  height: 10px;
}

.gacha-card--mini .gacha-card__retired-indicator {
  min-width: 34px;
  height: 16px;
  padding: 0 6px;
  font-size: 8px;
}

.gacha-card__media-bottom {
  position: absolute;
  left: 50%;
  bottom: 7px;
  transform: translateX(-50%);
  display: inline-flex;
  justify-content: center;
  max-width: calc(100% - 12px);
  pointer-events: none;
  z-index: 2;
}

.gacha-card--mini .gacha-card__media-bottom {
  bottom: 6px;
  max-width: calc(100% - 8px);
}

.gacha-card__badge--mini {
  padding: 1px 6px !important;
  font-size: 9px !important;
  line-height: 1.2 !important;
}

.gacha-card__coating-chip {
  max-width: 56%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  padding: 2px 10px;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.gacha-card--mini .gacha-card__coating-chip {
  max-width: calc(100% - 36px);
  font-size: 9px;
  padding: 1.5px 6px;
  line-height: 1.3;
}

/* ── Content ── */

.gacha-card__content {
  padding: 8px 10px;
  min-width: 0;
}

.gacha-card--mini .gacha-card__content {
  padding: 4px 6px;
}

.gacha-card__meta {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  margin-bottom: 6px;
  min-width: 0;
}

.gacha-card--mini .gacha-card__meta {
  gap: 4px;
  margin-bottom: 4px;
}

.gacha-card__author {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  flex: 1 1 auto;
}

.gacha-card__author-avatar {
  flex: 0 0 auto;
  border: 1px solid var(--g-border);
}

.gacha-card__author-text {
  display: flex;
  align-items: baseline;
  gap: 4px;
  min-width: 0;
  flex: 1 1 auto;
}

.gacha-card__author-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--g-text-secondary);
}

.gacha-card--mini .gacha-card__author-name {
  font-size: 10px;
}

.gacha-card__author-id,
.gacha-card__author-extra {
  flex: 0 0 auto;
  font-size: 9px;
  line-height: 1.2;
  color: var(--g-text-tertiary);
}

.gacha-card--mini .gacha-card__author-id,
.gacha-card--mini .gacha-card__author-extra {
  font-size: 8px;
}

.gacha-card__author-extra {
  font-weight: 700;
}

.gacha-card__major-type {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid transparent;
  padding: 1px 6px;
  font-size: 9px;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}

.gacha-card__major-type--media {
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  box-shadow: 0 1px 5px rgba(15, 23, 42, 0.24);
}

.gacha-card--mini .gacha-card__major-type {
  font-size: 8px;
  padding: 1px 5px;
}

.gacha-card--large .gacha-card__major-type,
.gacha-card--featured .gacha-card__major-type {
  font-size: 10px;
  padding: 2px 8px;
}

.gacha-card__major-type--scp {
  color: #b91c1c;
  border-color: rgba(239, 68, 68, 0.35);
  background: rgba(239, 68, 68, 0.12);
}

.gacha-card__major-type--tale {
  color: #075985;
  border-color: rgba(14, 165, 233, 0.35);
  background: rgba(14, 165, 233, 0.12);
}

.gacha-card__major-type--goif {
  color: #92400e;
  border-color: rgba(245, 158, 11, 0.38);
  background: rgba(245, 158, 11, 0.14);
}

.gacha-card__major-type--art {
  color: #0f766e;
  border-color: rgba(20, 184, 166, 0.35);
  background: rgba(20, 184, 166, 0.12);
}

.gacha-card__major-type--wanderers {
  color: #166534;
  border-color: rgba(34, 197, 94, 0.35);
  background: rgba(34, 197, 94, 0.12);
}

.gacha-card__major-type--other {
  color: var(--g-text-secondary);
  border-color: var(--g-border);
  background: var(--g-surface-recessed);
}

html.dark .gacha-card__major-type--scp {
  color: #fca5a5;
  border-color: rgba(248, 113, 113, 0.45);
  background: rgba(239, 68, 68, 0.2);
}

html.dark .gacha-card__major-type--tale {
  color: #7dd3fc;
  border-color: rgba(56, 189, 248, 0.45);
  background: rgba(14, 165, 233, 0.2);
}

html.dark .gacha-card__major-type--goif {
  color: #fcd34d;
  border-color: rgba(245, 158, 11, 0.48);
  background: rgba(245, 158, 11, 0.2);
}

html.dark .gacha-card__major-type--art {
  color: #5eead4;
  border-color: rgba(20, 184, 166, 0.48);
  background: rgba(20, 184, 166, 0.2);
}

html.dark .gacha-card__major-type--wanderers {
  color: #86efac;
  border-color: rgba(34, 197, 94, 0.45);
  background: rgba(34, 197, 94, 0.2);
}

.gacha-card__title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--g-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.gacha-card--large .gacha-card__title,
.gacha-card--featured .gacha-card__title {
  font-size: 15px;
}

.gacha-card__tags {
  margin-top: 6px;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.gacha-card__tag {
  border-radius: 999px;
  border: 1px solid var(--g-border);
  padding: 2px 8px;
  font-size: 12px;
  color: var(--g-text-secondary);
}

/* ── Footer ── */

.gacha-card__footer {
  border-top: 1px solid var(--g-border);
  padding: 6px 10px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: nowrap;
  gap: 6px;
  margin-top: auto;
  min-height: 36px;
}

.gacha-card__footer > * {
  min-width: 0;
}

.gacha-card--mini .gacha-card__footer {
  padding: 3px 6px;
  min-height: 28px;
  height: 28px;
  max-height: 28px;
  overflow: hidden;
}

.gacha-card__count {
  font-size: 12px;
  font-weight: 700;
  color: var(--g-text-secondary);
  white-space: nowrap;
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}

/* ── Rarity glow (subtle outer shadow) ── */

.gacha-card.is-gold {
  box-shadow:
    0 0 0 1px rgba(217, 119, 6, 0.2),
    0 4px 20px -8px rgba(217, 119, 6, 0.25);
}

.gacha-card.is-gold::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 40%;
  pointer-events: none;
  background: linear-gradient(to top, rgba(217, 119, 6, 0.08), transparent);
  border-radius: inherit;
}

.gacha-card.is-purple {
  box-shadow:
    0 0 0 1px rgba(124, 58, 237, 0.15),
    0 4px 16px -8px rgba(124, 58, 237, 0.2);
}

.gacha-card.is-purple::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 35%;
  pointer-events: none;
  background: linear-gradient(to top, rgba(124, 58, 237, 0.06), transparent);
  border-radius: inherit;
}

.gacha-card.is-blue {
  box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.1);
}

.gacha-card.is-blue::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 25%;
  pointer-events: none;
  background: linear-gradient(to top, rgba(37, 99, 235, 0.04), transparent);
  border-radius: inherit;
}

.gacha-card.is-green {
  box-shadow: 0 0 0 1px rgba(5, 150, 105, 0.08);
}

.gacha-card.is-green::after {
  content: '';
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  height: 20%;
  pointer-events: none;
  background: linear-gradient(to top, rgba(5, 150, 105, 0.03), transparent);
  border-radius: inherit;
}

/* ── Coating effects ── */

.gacha-card.is-coated {
  border-color: transparent;
  background-image:
    linear-gradient(var(--g-surface-card), var(--g-surface-card)),
    linear-gradient(
      135deg,
      var(--coating-edge, #94a3b8),
      transparent 40%,
      transparent 60%,
      var(--coating-edge, #94a3b8)
    );
  background-origin: border-box;
  background-clip: padding-box, border-box;
}

.gacha-card.is-coated::before {
  content: '';
  position: absolute;
  inset: -1px;
  pointer-events: none;
  border-radius: inherit;
  box-shadow:
    inset 0 0 0 1px var(--coating-glow, rgba(148, 163, 184, 0.2)),
    0 0 12px -4px var(--coating-glow, rgba(148, 163, 184, 0.1));
  z-index: 2;
  opacity: 0.8;
  transition: opacity 0.3s ease;
}

.gacha-card.is-coated:hover::before {
  opacity: 1;
}

html.dark .gacha-card.is-coated {
  background-image:
    linear-gradient(var(--g-surface-card), var(--g-surface-card)),
    linear-gradient(
      135deg,
      var(--coating-edge, #94a3b8),
      transparent 40%,
      transparent 60%,
      var(--coating-edge, #94a3b8)
    );
}

/* ── Hover: 3D tilt + lift ── */

@media (hover: hover) {
  .gacha-card:hover {
    will-change: transform;
    transform: perspective(800px) rotateX(var(--tilt-x)) rotateY(var(--tilt-y)) translateY(-3px);
    box-shadow: var(--g-shadow-lg);
  }
}

/* Touch devices: simpler lift */
@media (hover: none) {
  .gacha-card:active {
    transform: translateY(-1px);
  }
}

/* ── Featured variant extras ── */

.gacha-card--featured {
  border-radius: var(--g-radius-lg);
  box-shadow: var(--g-shadow-md);
}

.gacha-card--featured .gacha-card__content {
  padding: 12px 14px;
}

.gacha-card--featured .gacha-card__coating-chip {
  font-size: 12px;
  padding: 3px 10px;
}

/* ── Gold pulse animation ── */
@keyframes gold-pulse {
  0%, 100% { box-shadow: 0 0 0 1px rgba(217, 119, 6, 0.2), 0 4px 20px -8px rgba(217, 119, 6, 0.25); }
  50% { box-shadow: 0 0 0 1px rgba(217, 119, 6, 0.3), 0 4px 28px -6px rgba(217, 119, 6, 0.35); }
}

.gacha-card--featured.is-gold {
  animation: gold-pulse 2.5s ease-in-out infinite;
}

/* ── Reduced motion ── */

@media (prefers-reduced-motion: reduce) {
  .gacha-card {
    transition: none !important;
    animation: none !important;
  }

  .gacha-card:hover {
    transform: none !important;
  }

  .gacha-card__foil {
    display: none !important;
  }
}
</style>
