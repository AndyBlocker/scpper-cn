<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div class="max-w-5xl w-full mx-auto px-2">
        <div class="flex items-center gap-2 md:gap-3 mb-6 md:mb-8">
          <div class="p-1.5 md:p-2 bg-pink-600 rounded-lg">
            <LucideIcon name="Star" class="w-4 h-4 md:w-5 md:h-5 text-white" />
          </div>
          <h2 class="text-2xl md:text-3xl font-bold">分类最高分作品</h2>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-6">
          <div
            v-for="(item, idx) in siteData.categoryBest"
            :key="idx"
            class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-xl md:rounded-2xl p-4 md:p-6 flex items-start gap-3 md:gap-4 hover:bg-[rgba(var(--fg),0.03)] transition-colors"
          >
            <div class="p-2 md:p-3 rounded-lg md:rounded-xl" :class="item.iconBgClass">
              <LucideIcon :name="item.icon" class="w-5 h-5 md:w-6 md:h-6" :class="item.iconClass" />
            </div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between mb-2 md:mb-3">
                <span class="text-[10px] md:text-xs text-[rgb(var(--muted))] uppercase tracking-wider font-bold">{{ item.cat }}</span>
              </div>
              <div class="space-y-2 md:space-y-3">
                <NuxtLink
                  v-if="item.original"
                  :to="item.original.wikidotId ? `/page/${item.original.wikidotId}` : undefined"
                  target="_blank"
                  class="flex items-start justify-between gap-3 hover:bg-[rgba(var(--fg),0.05)] -mx-2 px-2 py-1 rounded-lg transition-colors"
                >
                  <div class="min-w-0">
                    <div class="text-[10px] md:text-xs text-green-400 font-bold uppercase tracking-wider">原创最高分</div>
                    <h3 class="text-sm md:text-base font-bold text-[rgb(var(--fg))] mb-0.5 line-clamp-1">{{ item.original.title }}</h3>
                    <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">作者: <span class="text-[rgb(var(--fg))]">{{ item.original.author }}</span></div>
                  </div>
                  <div class="flex items-center gap-1 text-yellow-500 font-bold text-sm md:text-base">
                    <LucideIcon name="Star" class="w-3 h-3 fill-yellow-500" /> +{{ item.original.rating }}
                  </div>
                </NuxtLink>
                <NuxtLink
                  v-if="item.translation"
                  :to="item.translation.wikidotId ? `/page/${item.translation.wikidotId}` : undefined"
                  target="_blank"
                  class="flex items-start justify-between gap-3 hover:bg-[rgba(var(--fg),0.05)] -mx-2 px-2 py-1 rounded-lg transition-colors"
                >
                  <div class="min-w-0">
                    <div class="text-[10px] md:text-xs text-blue-400 font-bold uppercase tracking-wider">翻译最高分</div>
                    <h3 class="text-sm md:text-base font-bold text-[rgb(var(--fg))] mb-0.5 line-clamp-1">{{ item.translation.title }}</h3>
                    <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">译者: <span class="text-[rgb(var(--fg))]">{{ item.translation.author }}</span></div>
                  </div>
                  <div class="flex items-center gap-1 text-yellow-500 font-bold text-sm md:text-base">
                    <LucideIcon name="Star" class="w-3 h-3 fill-yellow-500" /> +{{ item.translation.rating }}
                  </div>
                </NuxtLink>
                <div v-if="!item.original && !item.translation" class="text-xs text-[rgb(var(--muted))]">暂无数据</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AnnualSiteData } from '~/types/annual2025'

defineProps<{
  isActive: boolean
  siteData: AnnualSiteData
}>()
</script>
