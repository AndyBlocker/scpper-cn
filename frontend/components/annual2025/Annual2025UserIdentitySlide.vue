<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div v-if="!hasUserData" class="max-w-md w-full mx-auto px-4 text-center">
        <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-2xl p-8 md:p-12">
          <div class="w-20 h-20 mx-auto mb-6 bg-[rgba(var(--fg),0.1)] rounded-full flex items-center justify-center">
            <LucideIcon name="User" class="w-10 h-10 text-[rgb(var(--muted))]" />
          </div>
          <h2 class="text-xl md:text-2xl font-bold text-[rgb(var(--fg))] mb-3">个人年度报告</h2>
          <p class="text-[rgb(var(--muted))] text-sm mb-6">输入 Wikidot 用户名即可查看您的专属年度报告</p>
          <p class="text-xs text-[rgb(var(--muted))] opacity-60">继续浏览可查看更多站点数据</p>
        </div>
      </div>
      <div v-else class="max-w-4xl w-full mx-auto px-2">
        <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-2xl md:rounded-3xl p-5 md:p-12 relative overflow-hidden shadow-2xl">
          <div class="absolute top-0 right-0 p-8 md:p-12 opacity-5">
            <LucideIcon name="Star" class="w-32 md:w-64 h-32 md:h-64 text-[rgb(var(--fg))]" />
          </div>

          <div class="flex flex-col md:flex-row items-center gap-4 md:gap-8 relative z-10">
            <div
              class="rounded-full bg-gradient-to-tr from-[rgb(var(--accent))] to-[rgb(var(--accent-strong))] p-[3px] flex-shrink-0 flex items-center justify-center mx-auto md:mx-0"
              :class="isMobile ? 'w-24 h-24' : 'w-32 h-32'"
            >
              <div class="w-full h-full rounded-full overflow-hidden bg-[rgb(var(--bg))]">
                <UserAvatar
                  :wikidot-id="userData.wikidotId"
                  :name="userData.displayName"
                  :size="isMobile ? 96 : 128"
                  class="w-full h-full object-cover"
                />
              </div>
            </div>

            <div class="flex-1 text-center md:text-left w-full">
              <div class="flex flex-col md:flex-row items-center justify-center md:justify-start gap-2 md:gap-3 mb-2">
                <h1 class="text-2xl md:text-4xl font-bold text-[rgb(var(--fg))]">{{ userData.displayName }}</h1>
                <span class="px-2 md:px-3 py-1 rounded-full bg-[rgba(var(--success),0.2)] text-[rgb(var(--success))] text-[10px] md:text-xs font-bold border border-[rgba(var(--success),0.3)]">
                  {{ userData.rankings.overall.percentileLabel }}
                </span>
              </div>
              <p class="text-[rgb(var(--muted))] text-xs md:text-sm mb-4 md:mb-6">
                @{{ userData.userName }} · {{ userData.overview.activity.activeDays }} 天活跃
              </p>

              <div class="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3">
                <div class="text-center bg-[rgba(var(--fg),0.05)] p-2 md:p-3 rounded-lg md:rounded-xl border border-[rgba(var(--fg),0.05)]">
                  <div class="text-[10px] md:text-xs text-[rgb(var(--muted))] uppercase">全站排名</div>
                  <div class="text-lg md:text-2xl font-black text-[rgb(var(--fg))]">#{{ userData.overview.rankChange.endRank }}</div>
                </div>
                <div class="text-center bg-[rgba(var(--fg),0.05)] p-2 md:p-3 rounded-lg md:rounded-xl border border-[rgba(var(--fg),0.05)]">
                  <div class="text-[10px] md:text-xs text-[rgb(var(--muted))] uppercase">作品数</div>
                  <div class="text-lg md:text-2xl font-black text-[rgb(var(--fg))]">{{ userData.overview.creation.totalCount }}</div>
                  <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">原创{{ userData.overview.creation.originals }} 翻译{{ userData.overview.creation.translations }}</div>
                </div>
                <div class="text-center bg-[rgba(var(--fg),0.05)] p-2 md:p-3 rounded-lg md:rounded-xl border border-[rgba(var(--fg),0.05)]">
                  <div class="text-[10px] md:text-xs text-[rgb(var(--muted))] uppercase">获得 UpVotes</div>
                  <div class="text-lg md:text-2xl font-black text-[rgb(var(--fg))]">{{ userData.overview.votesReceived.up }}</div>
                  <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">UpVote 率 {{ (userData.overview.votesReceived.upRate * 100).toFixed(0) }}%</div>
                </div>
                <div class="text-center bg-[rgba(var(--fg),0.05)] p-2 md:p-3 rounded-lg md:rounded-xl border border-[rgba(var(--fg),0.05)]">
                  <div class="text-[10px] md:text-xs text-[rgb(var(--muted))] uppercase">总字数</div>
                  <div class="text-lg md:text-2xl font-black text-[rgb(var(--fg))]">{{ formatNumber(userData.overview.creation.totalWords) }}</div>
                  <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">{{ userData.overview.creation.totalCount > 0 ? Math.round(userData.overview.creation.totalWords / userData.overview.creation.totalCount).toLocaleString() : 0 }} 字/篇</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="slide-bg">
      <div class="w-full h-full bg-[radial-gradient(rgba(var(--fg),0.03)_1px,transparent_1px)] bg-[length:24px_24px]" />
    </div>
  </section>
</template>

<script setup lang="ts">
import type { AnnualUserData } from '~/types/annual2025'
import { formatNumber } from '~/utils/annual2025'

defineProps<{
  isActive: boolean
  hasUserData: boolean
  userData: AnnualUserData
  isMobile: boolean
}>()
</script>
