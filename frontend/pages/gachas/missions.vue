<template>
  <GachaPageShell
    :auth-pending="authPending"
    :show-binding-block="showBindingBlock"
    :wallet-balance="walletBalance"
    feature-name="任务"
    page="missions"
  >
    <div class="gacha-page-flow">
      <GachaErrorBanner :error="errorBanner" />

      <Transition name="fade" mode="out-in">
        <GachaActivationBlock
          v-if="!activated"
          key="missions-activation"
          :activating="activating"
          :activation-error="activationError"
          @activate="onActivate"
        />

        <div v-else key="missions-main" class="gacha-page-flow gacha-page-enter">
          <section class="gacha-kpi-grid">
            <GachaMetricCard label="任务可领" :value="missionClaimableCount" />
            <GachaMetricCard label="成就可领" :value="achievementClaimableCount" />
            <GachaMetricCard label="单抽券" :value="formatTokens(tickets.drawTicket)" tone="success" />
            <GachaMetricCard label="十连券" :value="formatTokens(tickets.draw10Ticket)" tone="accent" />
          </section>

          <section class="surface-card p-5">
            <header class="gacha-panel-head">
              <div>
                <h3 class="gacha-panel-title">任务工作台</h3>
                <p class="gacha-panel-subtitle">完成任务获取奖励，前往抽卡页使用票券</p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <UiButton
                  variant="outline"
                  size="sm"
                  :disabled="missionLoading || achievementLoading"
                  @click="refreshPanels"
                >
                  刷新
                </UiButton>
                <NuxtLink to="/gachas/album?tab=progress">
                  <UiButton variant="outline" size="sm">查看收集进度</UiButton>
                </NuxtLink>
              </div>
            </header>

            <div class="mt-4 grid gap-4 lg:grid-cols-2">
              <GachaGoalListPanel
                kind="mission"
                :items="missionItemsActive"
                :loading="missionLoading"
                :claiming="missionClaiming"
                :claimable-count="missionClaimableCount"
                v-model:view-mode="missionViewMode"
                @claim="handleClaimMission"
                @claim-all="handleClaimAllMissions"
              />
              <GachaGoalListPanel
                kind="achievement"
                :items="achievementItemsForDisplay"
                :loading="achievementLoading"
                :claiming="achievementClaiming"
                :claimable-count="achievementClaimableCount"
                @claim="handleClaimAchievement"
                @claim-all="handleClaimAllAchievements"
              />
            </div>
          </section>
        </div>
      </Transition>
    </div>

    <!-- Claim success toast -->
    <GachaClaimToast :items="claimToasts" @dismiss="dismissClaimToast" />
  </GachaPageShell>
</template>

<script setup lang="ts">
import { computed } from 'vue'

useHead({ title: '扭蛋 - 任务' })

import GachaPageShell from '~/components/gacha/GachaPageShell.vue'
import GachaErrorBanner from '~/components/gacha/GachaErrorBanner.vue'
import GachaActivationBlock from '~/components/gacha/GachaActivationBlock.vue'
import GachaMetricCard from '~/components/gacha/GachaMetricCard.vue'
import GachaGoalListPanel from '~/components/gacha/GachaGoalListPanel.vue'
import GachaClaimToast from '~/components/gacha/GachaClaimToast.vue'
import { UiButton } from '~/components/ui/button'
import { useGachaPage } from '~/composables/useGachaPage'
import { useGachaMissions } from '~/composables/useGachaMissions'
import { useGachaPageLifecycle } from '~/composables/useGachaPageLifecycle'
import { formatTokens } from '~/utils/gachaFormatters'

const page = useGachaPage({ pageName: 'missions' })
const {
  authPending, showBindingBlock,
  errorBanner,
  activated, activating, activationError,
  handleActivate
} = page

const mis = useGachaMissions(page)
const {
  tickets, ticketsLoading,
  missionLoading, missionClaiming, missionViewMode, missionItemsActive, missionClaimableCount,
  achievementLoading, achievementClaiming, achievementItemsForDisplay, achievementClaimableCount,
  refreshPanels, loadInitial,
  handleClaimMission, handleClaimAllMissions,
  handleClaimAchievement, handleClaimAllAchievements,
  claimToasts, dismissClaimToast
} = mis

const taskClaimableTotal = computed(() => missionClaimableCount.value + achievementClaimableCount.value)

const { walletBalance, onActivate } = useGachaPageLifecycle({
  page: {
    showBindingBlock,
    handleActivate,
    gacha: page.gacha
  },
  tag: 'gacha-missions',
  loadInitial,
  requireActivated: activated
})
</script>
