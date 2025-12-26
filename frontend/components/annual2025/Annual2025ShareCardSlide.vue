<template>
  <section class="slide bg-[rgb(var(--bg))]" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div v-if="!hasUserData" class="max-w-md w-full mx-auto px-4 text-center">
        <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-2xl p-8 md:p-12">
          <div class="w-20 h-20 mx-auto mb-6 bg-[rgba(var(--fg),0.1)] rounded-full flex items-center justify-center">
            <LucideIcon name="Share2" class="w-10 h-10 text-[rgb(var(--muted))]" />
          </div>
          <h2 class="text-xl md:text-2xl font-bold text-[rgb(var(--fg))] mb-3">分享报告</h2>
          <p class="text-[rgb(var(--muted))] text-sm mb-6">输入用户名查看并分享您的专属报告卡片</p>
          <p class="text-xs text-[rgb(var(--muted))] opacity-60">感谢您浏览 2025 年度总结！</p>
        </div>
      </div>
      <div v-else class="relative w-full max-w-sm md:max-w-md mx-auto px-4">
        <div id="share-card" class="bg-white text-black p-5 md:p-8 rounded-2xl md:rounded-[2rem] shadow-[0_0_50px_rgba(255,255,255,0.2)] relative z-10">
          <div class="flex items-center gap-3 md:gap-5 mb-4 md:mb-6">
            <UserAvatar
              :wikidot-id="userData.wikidotId"
              :name="userData.displayName"
              :size="64"
              class="w-12 h-12 md:w-16 md:h-16 rounded-xl md:rounded-2xl shadow-lg"
            />
            <div class="flex-1">
              <div class="font-black text-xl md:text-2xl tracking-tight">{{ userData.displayName }}</div>
              <div class="flex items-center gap-2 mt-1">
                <span class="text-[9px] md:text-[10px] font-bold text-gray-400 uppercase tracking-wider">2025 年度报告</span>
                <span
                  v-if="userData.rankings.overall.percentileLabel !== '活跃参与者'"
                  class="px-1.5 py-0.5 bg-yellow-100 text-yellow-700 text-[8px] md:text-[9px] font-bold rounded"
                >
                  {{ userData.rankings.overall.percentileLabel }}
                </span>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-3 gap-2 mb-3 md:mb-4">
            <div class="bg-gradient-to-br from-blue-50 to-blue-100 p-2.5 md:p-3 rounded-xl text-center">
              <div class="text-[8px] md:text-[9px] font-bold text-blue-400 uppercase mb-0.5">排名</div>
              <div class="text-lg md:text-xl font-black text-blue-600">#{{ userData.overview.rankChange.endRank }}</div>
            </div>
            <div class="bg-gradient-to-br from-purple-50 to-purple-100 p-2.5 md:p-3 rounded-xl text-center">
              <div class="text-[8px] md:text-[9px] font-bold text-purple-400 uppercase mb-0.5">作品</div>
              <div class="text-lg md:text-xl font-black text-purple-600">{{ userData.overview.creation.totalCount }}</div>
              <div class="text-[8px] md:text-[9px] text-purple-500">{{ userData.overview.creation.originals }}原创 {{ userData.overview.creation.translations }}译</div>
            </div>
            <div class="bg-gradient-to-br from-green-50 to-green-100 p-2.5 md:p-3 rounded-xl text-center">
              <div class="text-[8px] md:text-[9px] font-bold text-green-400 uppercase mb-0.5">UpVotes</div>
              <div class="text-lg md:text-xl font-black text-green-600">{{ userData.overview.votesReceived.up }}</div>
              <div class="text-[8px] md:text-[9px] text-green-500">{{ (userData.overview.votesReceived.upRate * 100).toFixed(0) }}% UpVote</div>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-2 mb-3 md:mb-4">
            <div class="bg-gray-100 p-2 md:p-2.5 rounded-xl flex items-center gap-2">
              <div class="w-7 h-7 md:w-8 md:h-8 bg-orange-100 rounded-lg flex items-center justify-center">
                <LucideIcon name="PenTool" class="w-3.5 h-3.5 md:w-4 md:h-4 text-orange-500" />
              </div>
              <div>
                <div class="text-[8px] md:text-[9px] text-gray-400 font-medium">总字数</div>
                <div class="text-sm md:text-base font-black">{{ formatNumber(userData.overview.creation.totalWords) }}</div>
              </div>
            </div>
            <div class="bg-gray-100 p-2 md:p-2.5 rounded-xl flex items-center gap-2">
              <div class="w-7 h-7 md:w-8 md:h-8 bg-cyan-100 rounded-lg flex items-center justify-center">
                <LucideIcon name="Vote" class="w-3.5 h-3.5 md:w-4 md:h-4 text-cyan-500" />
              </div>
              <div>
                <div class="text-[8px] md:text-[9px] text-gray-400 font-medium">投票参与</div>
                <div class="text-sm md:text-base font-black">{{ userData.overview.votesCast.total }}票</div>
              </div>
            </div>
          </div>

          <div
            class="bg-gradient-to-r from-gray-900 to-gray-800 text-white p-3 md:p-4 rounded-xl md:rounded-2xl mb-3 md:mb-4 relative group"
            :class="{ 'cursor-pointer': canSelectAchievements }"
            @click="canSelectAchievements && (showAchievementPicker = true)"
          >
            <div class="flex items-center justify-between mb-2">
              <div class="text-[8px] md:text-[9px] font-bold text-gray-400 uppercase">年度成就</div>
              <!-- 悬停时显示编辑提示，不会出现在截图中 -->
              <div
                v-if="canSelectAchievements"
                class="flex items-center gap-1 text-[8px] text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <LucideIcon name="Edit3" class="w-3 h-3" />
                <span>点击编辑</span>
              </div>
            </div>
            <div class="space-y-1.5">
              <div
                v-for="ach in displayedAchievements"
                :key="ach.id"
                class="flex items-start gap-2"
              >
                <span class="text-yellow-400 text-sm flex-shrink-0 mt-0.5">{{ ach.title.includes('第一') ? '🏆' : '⭐' }}</span>
                <span class="text-[10px] md:text-xs font-medium leading-relaxed">{{ ach.title }}</span>
              </div>
              <div v-if="userData.achievements.length === 0" class="text-[10px] md:text-xs text-gray-400">
                活跃参与者
              </div>
            </div>
          </div>

          <div v-if="userData.preferences.topTags.length > 0 && userData.preferences.topTags[0].tag !== '无数据'" class="mb-4">
            <div class="text-[8px] md:text-[9px] font-bold text-gray-400 uppercase mb-1.5">
              {{ userData.preferences.topTagsSource === 'voting' ? '投票标签' : '创作标签' }}
            </div>
            <div class="flex flex-wrap gap-1">
              <span
                v-for="(tag, idx) in userData.preferences.topTags.slice(0, 4)"
                :key="idx"
                class="px-2 py-0.5 bg-gray-100 text-gray-600 text-[9px] md:text-[10px] font-medium rounded-full"
              >
                #{{ tag.tag }}
              </span>
            </div>
          </div>

          <div class="border-t-2 border-gray-100 pt-3 md:pt-4 flex justify-between items-center">
            <div class="flex items-center gap-2">
              <div class="text-[8px] md:text-[9px] font-medium text-gray-400 leading-tight">
                活跃 <span class="text-gray-600 font-bold">{{ userData.overview.activity.activeDays }}</span> 天
              </div>
              <div class="w-1 h-1 bg-gray-300 rounded-full"></div>
              <div class="text-[8px] md:text-[9px] font-medium text-gray-400">SCPPER.CN</div>
            </div>
            <div class="w-8 h-8 md:w-10 md:h-10 bg-gradient-to-br from-gray-100 to-gray-200 rounded-lg flex items-center justify-center">
              <LucideIcon name="BarChart2" class="w-4 h-4 md:w-5 md:h-5 text-gray-600" />
            </div>
          </div>
        </div>

        <div class="absolute top-3 md:top-4 -right-3 md:-right-4 w-full h-full bg-[rgb(var(--accent))] rounded-2xl md:rounded-[2rem] -z-10 opacity-60" />
        <div class="absolute top-6 md:top-8 -right-6 md:-right-8 w-full h-full bg-[rgb(var(--accent-strong))] rounded-2xl md:rounded-[2rem] -z-20 opacity-40" />
      </div>

      <div class="mt-10 md:mt-16 text-center text-[rgb(var(--muted))] text-xs md:text-sm">
        感谢你在 2025 年的参与
      </div>

      <!-- 成就选择弹窗 -->
      <Teleport to="body">
        <div
          v-if="showAchievementPicker"
          class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          @click.self="showAchievementPicker = false"
        >
          <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-2xl p-5 md:p-6 max-w-md w-full shadow-2xl max-h-[80vh] overflow-y-auto">
            <div class="flex items-center justify-between mb-4">
              <h3 class="text-lg font-bold text-[rgb(var(--fg))]">选择展示的成就</h3>
              <button
                @click="showAchievementPicker = false"
                class="p-1.5 hover:bg-[rgba(var(--fg),0.1)] rounded-lg transition-colors"
              >
                <LucideIcon name="X" class="w-5 h-5 text-[rgb(var(--muted))]" />
              </button>
            </div>
            <p class="text-sm text-[rgb(var(--muted))] mb-4">选择最多 3 个成就显示在分享卡片上</p>
            <div class="space-y-2">
              <button
                v-for="(ach, idx) in userData.achievements"
                :key="ach.id"
                @click="toggleAchievement(idx)"
                class="w-full flex items-start gap-3 p-3 rounded-xl border transition-all text-left"
                :class="selectedIndices.includes(idx)
                  ? 'bg-[rgba(var(--accent),0.1)] border-[rgb(var(--accent))]'
                  : 'bg-[rgba(var(--fg),0.03)] border-transparent hover:border-[rgba(var(--fg),0.1)]'"
              >
                <div
                  class="w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 mt-0.5"
                  :class="selectedIndices.includes(idx)
                    ? 'border-[rgb(var(--accent))] bg-[rgb(var(--accent))]'
                    : 'border-[rgb(var(--muted))]'"
                >
                  <LucideIcon
                    v-if="selectedIndices.includes(idx)"
                    name="Check"
                    class="w-3 h-3 text-white"
                  />
                </div>
                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-2 mb-0.5">
                    <span class="text-yellow-500">{{ ach.title.includes('第一') ? '🏆' : '⭐' }}</span>
                    <span
                      v-if="selectedIndices.includes(idx)"
                      class="text-[10px] px-1.5 py-0.5 bg-[rgb(var(--accent))] text-white rounded font-medium"
                    >
                      #{{ selectedIndices.indexOf(idx) + 1 }}
                    </span>
                  </div>
                  <div class="text-sm text-[rgb(var(--fg))] leading-relaxed">{{ ach.title }}</div>
                  <div class="text-xs text-[rgb(var(--muted))] mt-1">{{ ach.description }}</div>
                </div>
              </button>
            </div>
            <div class="mt-4 pt-4 border-t border-[rgb(var(--panel-border))] flex justify-between items-center">
              <span class="text-sm text-[rgb(var(--muted))]">
                已选择 {{ selectedIndices.length }}/3
              </span>
              <button
                @click="showAchievementPicker = false"
                class="px-4 py-2 bg-[rgb(var(--accent))] hover:bg-[rgb(var(--accent-strong))] text-white rounded-lg font-medium transition-colors"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      </Teleport>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import type { AnnualUserData } from '~/types/annual2025'
import { formatNumber } from '~/utils/annual2025'

const props = defineProps<{
  isActive: boolean
  hasUserData: boolean
  userData: AnnualUserData
}>()

// 成就选择状态
const showAchievementPicker = ref(false)
const selectedIndices = ref<number[]>([0, 1, 2]) // 默认选择前三个

// 当用户数据变化时，重置选择
watch(() => props.userData?.achievements, (newAchievements) => {
  if (newAchievements) {
    const maxIndex = Math.min(3, newAchievements.length)
    selectedIndices.value = Array.from({ length: maxIndex }, (_, i) => i)
  }
}, { immediate: true })

// 切换成就选择
function toggleAchievement(idx: number) {
  const currentIndex = selectedIndices.value.indexOf(idx)
  if (currentIndex >= 0) {
    // 已选中，取消选择
    selectedIndices.value.splice(currentIndex, 1)
  } else if (selectedIndices.value.length < 3) {
    // 未选中且未达上限，添加
    selectedIndices.value.push(idx)
  }
}

// 是否可以选择成就（超过3个时才能选择）
const canSelectAchievements = computed(() => {
  return props.userData?.achievements?.length > 3
})

// 显示的成就列表
const displayedAchievements = computed(() => {
  if (!props.userData?.achievements) return []
  return selectedIndices.value
    .filter(idx => idx < props.userData.achievements.length)
    .map(idx => props.userData.achievements[idx])
})
</script>
