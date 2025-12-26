<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div v-if="!hasUserData" class="max-w-md w-full mx-auto px-4 text-center">
        <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-2xl p-8 md:p-12">
          <div class="w-20 h-20 mx-auto mb-6 bg-[rgba(var(--fg),0.1)] rounded-full flex items-center justify-center">
            <LucideIcon name="Vote" class="w-10 h-10 text-[rgb(var(--muted))]" />
          </div>
          <h2 class="text-xl md:text-2xl font-bold text-[rgb(var(--fg))] mb-3">投票风格</h2>
          <p class="text-[rgb(var(--muted))] text-sm">输入用户名查看投票分析</p>
        </div>
      </div>
      <div v-else class="max-w-4xl w-full mx-auto px-2">
        <div class="flex items-center gap-2 md:gap-3 mb-6 md:mb-8 justify-center">
          <div class="p-1.5 md:p-2 bg-emerald-600 rounded-lg">
            <LucideIcon name="Vote" class="w-5 h-5 md:w-6 md:h-6 text-white" />
          </div>
          <h2 class="text-2xl md:text-3xl font-bold">投票风格</h2>
        </div>

        <div class="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
          <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-xl md:rounded-2xl p-4 md:p-6 relative overflow-hidden">
            <div class="absolute top-0 right-0 p-8 md:p-16 opacity-5">
              <LucideIcon name="ThumbsUp" class="w-24 md:w-48 h-24 md:h-48 text-[rgb(var(--fg))]" />
            </div>
            <div class="relative z-10">
              <div class="text-[rgb(var(--accent))] font-bold text-base md:text-lg mb-2">{{ userData.preferences.votingStyle.label }}</div>
              <p class="text-[rgb(var(--muted))] text-xs md:text-sm mb-4 md:mb-6 leading-relaxed">{{ userData.preferences.votingStyle.desc }}</p>

              <div class="space-y-3 md:space-y-4">
                <div>
                  <div class="flex justify-between text-xs md:text-sm mb-1.5 md:mb-2">
                    <span class="text-[rgb(var(--muted))]">UpVote</span>
                    <span class="text-[rgb(var(--success))] font-bold">{{ userData.preferences.votingStyle.up }}</span>
                  </div>
                  <div class="bar-track h-2 md:h-3 w-full">
                    <div
                      class="bar-fill-x h-full bg-[rgb(var(--success))]"
                      :style="{ width: `${userData.overview.votesCast.total > 0 ? (userData.preferences.votingStyle.up / userData.overview.votesCast.total * 100) : 0}%`, '--bar-delay': '0ms' }"
                    />
                  </div>
                </div>
                <div>
                  <div class="flex justify-between text-xs md:text-sm mb-1.5 md:mb-2">
                    <span class="text-[rgb(var(--muted))]">DownVote</span>
                    <span class="text-red-400 font-bold">{{ userData.preferences.votingStyle.down }}</span>
                  </div>
                  <div class="bar-track h-2 md:h-3 w-full">
                    <div
                      class="bar-fill-x h-full bg-red-500"
                      :style="{ width: `${userData.overview.votesCast.total > 0 ? (userData.preferences.votingStyle.down / userData.overview.votesCast.total * 100) : 0}%`, '--bar-delay': '80ms' }"
                    />
                  </div>
                </div>
              </div>

              <div class="mt-4 md:mt-6 pt-4 md:pt-6 border-t border-[rgb(var(--panel-border))] grid grid-cols-2 gap-3 md:gap-4">
                <div class="text-center">
                  <div class="text-2xl md:text-3xl font-black text-[rgb(var(--fg))]">{{ userData.overview.votesCast.total }}</div>
                  <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">总投票数</div>
                </div>
                <div class="text-center">
                  <div class="text-2xl md:text-3xl font-black text-[rgb(var(--fg))]">{{ (userData.overview.votesCast.upRate * 100).toFixed(0) }}%</div>
                  <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">UpVote 率</div>
                </div>
              </div>
            </div>
          </div>

          <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-xl md:rounded-2xl p-4 md:p-6">
            <div class="flex items-center gap-2 mb-4 md:mb-6">
              <LucideIcon name="Hash" class="w-4 h-4 md:w-5 md:h-5 text-[rgb(var(--accent))]" />
              <span class="font-bold text-sm md:text-base text-[rgb(var(--fg))]">最常投票的标签</span>
            </div>
            <div class="space-y-2 md:space-y-3">
              <div
                v-for="(tag, i) in userData.preferences.votingTopTags"
                :key="i"
                class="flex items-center gap-2 md:gap-3"
              >
                <span class="text-base md:text-lg w-5 md:w-6 text-center font-bold text-[rgb(var(--muted))]">{{ i + 1 }}</span>
                <div class="flex-1">
                  <div class="flex justify-between text-xs md:text-sm mb-1">
                    <span class="text-[rgb(var(--fg))] font-medium">#{{ tag.tag }}</span>
                    <span class="text-[rgb(var(--success))]">{{ tag.upRate }}% UpVote</span>
                  </div>
                  <div class="bar-track h-1.5 md:h-2 w-full">
                    <div
                      :class="tag.bgClass"
                      class="bar-fill-x h-full"
                      :style="{ width: `${tag.upRate}%`, '--bar-delay': `${i * 60}ms` }"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-xl md:rounded-2xl p-4 md:p-6 md:col-span-2">
            <div class="bento-header">
              <span class="text-xs md:text-sm font-medium text-[rgb(var(--muted))]">投票数量分布</span>
              <span class="text-[10px] md:text-xs text-[rgb(var(--muted))]">共 {{ siteData.distributions.votesCast.total }} 位读者</span>
            </div>
            <div v-if="siteData.distributions.votesCast.buckets.length" class="mt-3">
              <div class="relative h-16 md:h-20">
                <svg width="100%" height="70" viewBox="0 0 300 60" preserveAspectRatio="none">
                  <defs>
                    <linearGradient id="votes-dist-gradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stop-color="#22c55e" stop-opacity="0.35" />
                      <stop offset="100%" stop-color="#22c55e" stop-opacity="0.05" />
                    </linearGradient>
                  </defs>
                  <polyline :points="voteDistributionSpark.area" fill="url(#votes-dist-gradient)" stroke="none" />
                  <polyline :points="voteDistributionSpark.line" fill="none" stroke="#22c55e" stroke-width="1.5" stroke-linecap="round" />
                </svg>
                <div
                  v-if="votePercentilePosition !== null"
                  class="absolute bottom-1 -translate-x-1/2"
                  :style="{ left: `${votePercentilePosition}%` }"
                >
                  <div class="w-2 h-2 bg-green-400 rounded-full ring-2 ring-[rgb(var(--bg))]" />
                </div>
              </div>
              <div class="flex justify-between text-[9px] text-[rgb(var(--muted))]">
                <span>少</span>
                <span>多</span>
              </div>
            </div>
            <div v-else class="text-[10px] text-[rgb(var(--muted))] mt-3">暂无分布数据</div>
            <div class="mt-2 text-[10px] text-[rgb(var(--muted))]">
              <div v-if="userData.percentiles.votesCast" class="flex items-center justify-between gap-2">
                <span>
                  你的投票数 {{ formatNumber(userData.percentiles.votesCast.value) }}，{{ userData.percentiles.votesCast.percentileLabel }}
                </span>
                <span
                  v-if="votePercentileBadge"
                  class="inline-flex items-center px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300"
                >
                  {{ votePercentileBadge }}
                </span>
              </div>
              <span v-else>暂无投票分位数据</span>
            </div>
          </div>
        </div>

        <div class="mt-4 md:mt-6 grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
          <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-lg md:rounded-xl p-2.5 md:p-4 text-center">
            <div class="text-lg md:text-2xl font-black text-[rgb(var(--fg))]">{{ userData.overview.votesCast.activeDays }}</div>
            <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">投票活跃天数</div>
          </div>
          <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-lg md:rounded-xl p-2.5 md:p-4 text-center">
            <div class="text-lg md:text-2xl font-black text-[rgb(var(--fg))]">{{ userData.overview.votesCast.activeDays > 0 ? (userData.overview.votesCast.total / userData.overview.votesCast.activeDays).toFixed(1) : 0 }}</div>
            <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">日均投票</div>
          </div>
          <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-lg md:rounded-xl p-2.5 md:p-4 text-center">
            <div class="text-lg md:text-2xl font-black text-[rgb(var(--success))]">{{ userData.overview.votesReceived.up }}</div>
            <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">获得 UpVotes</div>
          </div>
          <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-lg md:rounded-xl p-2.5 md:p-4 text-center">
            <div class="text-lg md:text-2xl font-black text-red-400">{{ userData.overview.votesReceived.down }}</div>
            <div class="text-[10px] md:text-xs text-[rgb(var(--muted))]">获得 DownVotes</div>
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
import { computed } from 'vue'
import type { AnnualSiteData, AnnualUserData } from '~/types/annual2025'
import { buildSparkLine, formatNumber, getPercentilePosition } from '~/utils/annual2025'

const props = defineProps<{
  isActive: boolean
  hasUserData: boolean
  userData: AnnualUserData
  siteData: AnnualSiteData
}>()

const voteDistributionSpark = computed(() => {
  const counts = props.siteData.distributions.votesCast.buckets.map(b => b.count)
  return buildSparkLine(counts)
})

const votePercentilePosition = computed(() => getPercentilePosition(props.userData.percentiles.votesCast))

const votePercentileBadge = computed(() => {
  const percentile = props.userData.percentiles.votesCast?.percentile
  if (percentile === undefined || percentile === null) return ''
  const exceed = Math.max(0, Math.round((1 - percentile) * 100))
  return `超过 ${exceed}% 的读者`
})
</script>
