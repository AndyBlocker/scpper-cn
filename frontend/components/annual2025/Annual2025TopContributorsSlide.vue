<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div class="max-w-6xl w-full mx-auto px-2">
        <div class="flex items-center gap-2 md:gap-3 mb-6 md:mb-8 justify-center">
          <div class="p-1.5 md:p-2 bg-yellow-600 rounded-lg">
            <LucideIcon name="Crown" class="w-5 h-5 md:w-6 md:h-6 text-white" />
          </div>
          <h2 class="text-2xl md:text-3xl font-bold">年度贡献者</h2>
        </div>

        <div class="grid grid-cols-2 md:grid-cols-3 gap-3 md:gap-6">
          <NuxtLink
            :to="siteData.topContributors.mostRating.wikidotId ? `/user/${siteData.topContributors.mostRating.wikidotId}` : undefined"
            target="_blank"
            class="contributor-card-mini border-amber-500/20 block hover:scale-[1.02] transition-transform"
          >
            <div class="absolute top-0 left-0 w-full h-1 bg-amber-500 rounded-t-xl" />
            <div class="flex items-center gap-2 md:gap-3 mb-2 md:mb-3">
              <UserAvatar
                :wikidot-id="siteData.topContributors.mostRating.wikidotId"
                :name="siteData.topContributors.mostRating.user"
                :size="36"
                class="ring-2 ring-amber-500/30 w-9 h-9 md:w-12 md:h-12"
              />
              <div class="flex-1 min-w-0">
                <div class="text-amber-500 text-[10px] md:text-xs font-bold uppercase tracking-wider">{{ siteData.topContributors.mostRating.label }}</div>
                <h3 class="text-sm md:text-lg font-bold text-[rgb(var(--fg))] truncate">{{ siteData.topContributors.mostRating.user }}</h3>
              </div>
            </div>
            <div class="text-2xl md:text-3xl font-black text-[rgb(var(--fg))]">
              {{ formatNumber(siteData.topContributors.mostRating.count) }}
              <span class="text-xs md:text-sm text-[rgb(var(--muted))] font-normal">{{ siteData.topContributors.mostRating.unit }}</span>
            </div>
          </NuxtLink>

          <NuxtLink
            :to="siteData.topContributors.mostOriginals.wikidotId ? `/user/${siteData.topContributors.mostOriginals.wikidotId}` : undefined"
            target="_blank"
            class="contributor-card-mini border-yellow-500/20 block hover:scale-[1.02] transition-transform"
          >
            <div class="absolute top-0 left-0 w-full h-1 bg-yellow-500 rounded-t-xl" />
            <div class="flex items-center gap-2 md:gap-3 mb-2 md:mb-3">
              <UserAvatar
                :wikidot-id="siteData.topContributors.mostOriginals.wikidotId"
                :name="siteData.topContributors.mostOriginals.user"
                :size="36"
                class="ring-2 ring-yellow-500/30 w-9 h-9 md:w-12 md:h-12"
              />
              <div class="flex-1 min-w-0">
                <div class="text-yellow-500 text-[10px] md:text-xs font-bold uppercase tracking-wider">{{ siteData.topContributors.mostOriginals.label }}</div>
                <h3 class="text-sm md:text-lg font-bold text-[rgb(var(--fg))] truncate">{{ siteData.topContributors.mostOriginals.user }}</h3>
              </div>
            </div>
            <div class="text-2xl md:text-3xl font-black text-[rgb(var(--fg))]">
              {{ siteData.topContributors.mostOriginals.count }}
              <span class="text-xs md:text-sm text-[rgb(var(--muted))] font-normal">{{ siteData.topContributors.mostOriginals.unit }}</span>
            </div>
          </NuxtLink>

          <NuxtLink
            :to="siteData.topContributors.mostTranslations.wikidotId ? `/user/${siteData.topContributors.mostTranslations.wikidotId}` : undefined"
            target="_blank"
            class="contributor-card-mini border-blue-500/20 block hover:scale-[1.02] transition-transform"
          >
            <div class="absolute top-0 left-0 w-full h-1 bg-blue-500 rounded-t-xl" />
            <div class="flex items-center gap-2 md:gap-3 mb-2 md:mb-3">
              <UserAvatar
                :wikidot-id="siteData.topContributors.mostTranslations.wikidotId"
                :name="siteData.topContributors.mostTranslations.user"
                :size="36"
                class="ring-2 ring-blue-500/30 w-9 h-9 md:w-12 md:h-12"
              />
              <div class="flex-1 min-w-0">
                <div class="text-blue-500 text-[10px] md:text-xs font-bold uppercase tracking-wider">{{ siteData.topContributors.mostTranslations.label }}</div>
                <h3 class="text-sm md:text-lg font-bold text-[rgb(var(--fg))] truncate">{{ siteData.topContributors.mostTranslations.user }}</h3>
              </div>
            </div>
            <div class="text-2xl md:text-3xl font-black text-[rgb(var(--fg))]">
              {{ siteData.topContributors.mostTranslations.count }}
              <span class="text-xs md:text-sm text-[rgb(var(--muted))] font-normal">{{ siteData.topContributors.mostTranslations.unit }}</span>
            </div>
          </NuxtLink>

          <NuxtLink
            :to="siteData.topContributors.mostWords.wikidotId ? `/user/${siteData.topContributors.mostWords.wikidotId}` : undefined"
            target="_blank"
            class="contributor-card-mini border-purple-500/20 block hover:scale-[1.02] transition-transform"
          >
            <div class="absolute top-0 left-0 w-full h-1 bg-purple-500 rounded-t-xl" />
            <div class="flex items-center gap-2 md:gap-3 mb-2 md:mb-3">
              <UserAvatar
                :wikidot-id="siteData.topContributors.mostWords.wikidotId"
                :name="siteData.topContributors.mostWords.user"
                :size="36"
                class="ring-2 ring-purple-500/30 w-9 h-9 md:w-12 md:h-12"
              />
              <div class="flex-1 min-w-0">
                <div class="text-purple-500 text-[10px] md:text-xs font-bold uppercase tracking-wider">{{ siteData.topContributors.mostWords.label }}</div>
                <h3 class="text-sm md:text-lg font-bold text-[rgb(var(--fg))] truncate">{{ siteData.topContributors.mostWords.user }}</h3>
              </div>
            </div>
            <div class="text-2xl md:text-3xl font-black text-[rgb(var(--fg))]">
              {{ formatNumber(siteData.topContributors.mostWords.count) }}
              <span class="text-xs md:text-sm text-[rgb(var(--muted))] font-normal">{{ siteData.topContributors.mostWords.unit }}</span>
            </div>
          </NuxtLink>

          <NuxtLink
            :to="siteData.topContributors.mostVotes.wikidotId ? `/user/${siteData.topContributors.mostVotes.wikidotId}` : undefined"
            target="_blank"
            class="contributor-card-mini border-green-500/20 col-span-2 md:col-span-1 block hover:scale-[1.02] transition-transform"
          >
            <div class="absolute top-0 left-0 w-full h-1 bg-green-500 rounded-t-xl" />
            <div class="flex items-center gap-2 md:gap-3 mb-2 md:mb-3">
              <UserAvatar
                :wikidot-id="siteData.topContributors.mostVotes.wikidotId"
                :name="siteData.topContributors.mostVotes.user"
                :size="36"
                class="ring-2 ring-green-500/30 w-9 h-9 md:w-12 md:h-12"
              />
              <div class="flex-1 min-w-0">
                <div class="text-green-500 text-[10px] md:text-xs font-bold uppercase tracking-wider">{{ siteData.topContributors.mostVotes.label }}</div>
                <h3 class="text-sm md:text-lg font-bold text-[rgb(var(--fg))] truncate">{{ siteData.topContributors.mostVotes.user }}</h3>
              </div>
            </div>
            <div class="text-2xl md:text-3xl font-black text-[rgb(var(--fg))]">
              {{ formatNumber(siteData.topContributors.mostVotes.count) }}
              <span class="text-xs md:text-sm text-[rgb(var(--muted))] font-normal">{{ siteData.topContributors.mostVotes.unit }}</span>
            </div>
          </NuxtLink>
        </div>
      </div>
    </div>
    <div class="slide-bg">
      <div class="w-full h-full bg-[linear-gradient(rgba(var(--accent),0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(var(--accent),0.03)_1px,transparent_1px)] bg-[length:50px_50px]" />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AnnualSiteData } from '~/types/annual2025'
import { formatNumber } from '~/utils/annual2025'

defineProps<{
  isActive: boolean
  siteData: AnnualSiteData
}>()
</script>
