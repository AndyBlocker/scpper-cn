import { computed, ref } from 'vue'
import type { GachaPageContext } from '~/composables/useGachaPage'
import type {
  AffixVisualStyle,
  DrawResult,
  MissionItem,
  AchievementItem,
  TicketBalance,
  Wallet
} from '~/types/gacha'
import { normalizeTickets, emptyTickets, formatRewardSummary } from '~/utils/gachaFormatters'
import { missionStatusRank } from '~/utils/gachaConstants'
import type { ClaimToastItem } from '~/components/gacha/GachaClaimToast.vue'
import { normalizeError } from '~/composables/api/gachaCore'

/**
 * missions 页面的状态和逻辑。
 * 从 missions.vue 提取 ticket / mission / achievement 状态和所有 handler。
 */
export function useGachaMissions(page: GachaPageContext) {
  const { gacha, emitError, handleWalletUpdated } = page

  // ─── Tickets ─────────────────────────────────────────
  const tickets = ref<TicketBalance>(emptyTickets())
  const ticketsLoading = ref(false)
  const ticketAction = ref<'draw' | 'draw10' | 'reforge' | null>(null)
  const lastTicketDrawMode = ref<1 | 10>(10)
  const reforgeCardId = ref('')
  const lastReforgeResult = ref<{
    cardId: string
    title: string
    before: { affixSignature?: string; affixVisualStyle: AffixVisualStyle; affixLabel: string }
    after: { affixSignature?: string; affixVisualStyle: AffixVisualStyle; affixLabel: string }
  } | null>(null)

  // ─── Missions ────────────────────────────────────────
  const missions = ref<MissionItem[]>([])
  const missionLoading = ref(false)
  const missionClaiming = ref<string | 'ALL' | null>(null)
  const missionViewMode = ref<'daily' | 'all'>('daily')

  // ─── Achievements ────────────────────────────────────
  const achievements = ref<AchievementItem[]>([])
  const achievementLoading = ref(false)
  const achievementClaiming = ref<string | 'ALL' | null>(null)

  // ─── Draw Result Modal ───────────────────────────────
  const lastResult = ref<DrawResult | null>(null)
  const resultModalOpen = ref(false)

  // ─── Claim Toast ────────────────────────────────────
  const claimToasts = ref<ClaimToastItem[]>([])
  let toastIdCounter = 0

  function pushClaimToast(kind: 'mission' | 'achievement', title: string, reward: { tokens: number; tickets: TicketBalance }) {
    const id = ++toastIdCounter
    claimToasts.value.push({
      id,
      kind,
      title: `${kind === 'mission' ? '任务' : '成就'}完成：${title}`,
      rewardSummary: `获得 ${formatRewardSummary(reward)}`
    })
  }

  function pushBatchClaimToast(kind: 'mission' | 'achievement', count: number) {
    const id = ++toastIdCounter
    claimToasts.value.push({
      id,
      kind,
      title: `已领取 ${count} 个${kind === 'mission' ? '任务' : '成就'}奖励`,
      rewardSummary: '奖励已发放至账户'
    })
  }

  function dismissClaimToast(id: number) {
    claimToasts.value = claimToasts.value.filter(t => t.id !== id)
  }

  // ─── Computed ────────────────────────────────────────
  const missionItemsForDisplay = computed(() =>
    [...missions.value].sort((a, b) => {
      const statusA = a.claimed ? missionStatusRank.claimed : a.claimable ? missionStatusRank.claimable : missionStatusRank.pending
      const statusB = b.claimed ? missionStatusRank.claimed : b.claimable ? missionStatusRank.claimable : missionStatusRank.pending
      if (statusA !== statusB) return statusA - statusB
      if (a.progress !== b.progress) return b.progress - a.progress
      return a.title.localeCompare(b.title, 'zh-CN')
    })
  )

  const dailyMissionItems = computed(() => {
    const filtered = missionItemsForDisplay.value.filter((item) => {
      const source = `${item.missionKey} ${item.title} ${item.description}`.toLowerCase()
      return source.includes('daily') || source.includes('每日') || source.includes('当日')
    })
    return filtered.length ? filtered : missionItemsForDisplay.value
  })

  const missionItemsActive = computed(() =>
    missionViewMode.value === 'daily' ? dailyMissionItems.value : missionItemsForDisplay.value
  )

  const achievementItemsForDisplay = computed(() =>
    [...achievements.value].sort((a, b) => {
      const statusA = a.claimed ? missionStatusRank.claimed : a.claimable ? missionStatusRank.claimable : missionStatusRank.pending
      const statusB = b.claimed ? missionStatusRank.claimed : b.claimable ? missionStatusRank.claimable : missionStatusRank.pending
      if (statusA !== statusB) return statusA - statusB
      if (a.progress !== b.progress) return b.progress - a.progress
      return a.title.localeCompare(b.title, 'zh-CN')
    })
  )

  const missionClaimableCount = computed(() =>
    missions.value.filter((item) => item.claimable && !item.claimed).length
  )

  const achievementClaimableCount = computed(() =>
    achievements.value.filter((item) => item.claimable && !item.claimed).length
  )

  // ─── Refresh Handlers ────────────────────────────────
  async function refreshTicketsPanel() {
    if (!page.activated.value) {
      tickets.value = emptyTickets()
      return
    }
    ticketsLoading.value = true
    try {
      const res = await gacha.getTickets()
      if (!res.ok) {
        emitError(res.error || '加载票券失败')
        return
      }
      tickets.value = normalizeTickets(res.tickets)
    } catch (error: unknown) {
      emitError(normalizeError(error, '加载票券失败'))
    } finally {
      ticketsLoading.value = false
    }
  }

  async function refreshMissionsPanel() {
    if (!page.activated.value) {
      missions.value = []
      return
    }
    missionLoading.value = true
    try {
      const res = await gacha.getMissions()
      if (!res.ok) {
        emitError(res.error || '加载任务失败')
        return
      }
      missions.value = res.data ?? []
    } catch (error: unknown) {
      emitError(normalizeError(error, '加载任务失败'))
    } finally {
      missionLoading.value = false
    }
  }

  async function refreshAchievementsPanel() {
    if (!page.activated.value) {
      achievements.value = []
      return
    }
    achievementLoading.value = true
    try {
      const res = await gacha.getAchievements()
      if (!res.ok) {
        emitError(res.error || '加载成就失败')
        return
      }
      achievements.value = res.data ?? []
    } catch (error: unknown) {
      emitError(normalizeError(error, '加载成就失败'))
    } finally {
      achievementLoading.value = false
    }
  }

  async function refreshPanels() {
    await Promise.allSettled([
      refreshTicketsPanel(),
      refreshMissionsPanel(),
      refreshAchievementsPanel()
    ])
  }

  async function loadInitial() {
    await refreshPanels()
  }

  // ─── Ticket Handlers ─────────────────────────────────
  async function handleTicketDraw(mode: 1 | 10) {
    if (ticketAction.value) return
    ticketAction.value = mode === 1 ? 'draw' : 'draw10'
    lastTicketDrawMode.value = mode
    try {
      const res = mode === 1 ? await gacha.useDrawTicket() : await gacha.useDraw10Ticket()
      if (!res.ok || !res.data) {
        emitError(res.error || '使用票券失败')
        return
      }
      tickets.value = normalizeTickets(res.tickets)
      lastResult.value = res.data
      resultModalOpen.value = true
      if (res.data.wallet) {
        handleWalletUpdated(res.data.wallet)
      }
      await Promise.allSettled([refreshMissionsPanel(), refreshAchievementsPanel()])
    } catch (error: unknown) {
      emitError(normalizeError(error, '使用票券失败'))
    } finally {
      ticketAction.value = null
    }
  }

  async function handleAffixReforgeTicketUse() {
    if (ticketAction.value) return
    ticketAction.value = 'reforge'
    try {
      const targetCardId = reforgeCardId.value.trim()
      const res = await gacha.useAffixReforgeTicket(targetCardId || undefined)
      if (!res.ok) {
        emitError(res.error || '使用改造券失败')
        return
      }
      tickets.value = normalizeTickets(res.tickets)
      lastReforgeResult.value = res.result ?? null
      if (res.result?.cardId) {
        reforgeCardId.value = res.result.cardId
      }
    } catch (error: unknown) {
      emitError(normalizeError(error, '使用改造券失败'))
    } finally {
      ticketAction.value = null
    }
  }

  // ─── Mission Claim Handlers ──────────────────────────
  async function handleClaimMission(missionKey: string) {
    if (missionClaiming.value) return
    missionClaiming.value = missionKey
    try {
      const res = await gacha.claimMission(missionKey)
      if (!res.ok) {
        emitError(res.error || '领取任务奖励失败')
        return
      }
      if (res.wallet) handleWalletUpdated(res.wallet)
      tickets.value = normalizeTickets(res.tickets)
      const matched = missions.value.find(m => m.missionKey === missionKey)
      if (matched) pushClaimToast('mission', matched.title, matched.reward)
      await refreshMissionsPanel()
    } catch (error: unknown) {
      emitError(normalizeError(error, '领取任务奖励失败'))
    } finally {
      missionClaiming.value = null
    }
  }

  async function handleClaimAllMissions() {
    if (missionClaiming.value) return
    missionClaiming.value = 'ALL'
    try {
      const res = await gacha.claimAllMissions()
      if (!res.ok) {
        emitError(res.error || '领取任务奖励失败')
        return
      }
      if (res.wallet) handleWalletUpdated(res.wallet)
      tickets.value = normalizeTickets(res.tickets)
      const count = res.claimed ?? missionClaimableCount.value
      if (count > 0) pushBatchClaimToast('mission', count)
      await refreshMissionsPanel()
    } catch (error: unknown) {
      emitError(normalizeError(error, '领取任务奖励失败'))
    } finally {
      missionClaiming.value = null
    }
  }

  // ─── Achievement Claim Handlers ──────────────────────
  async function handleClaimAchievement(achievementKey: string) {
    if (achievementClaiming.value) return
    achievementClaiming.value = achievementKey
    try {
      const res = await gacha.claimAchievement(achievementKey)
      if (!res.ok) {
        emitError(res.error || '领取成就奖励失败')
        return
      }
      if (res.wallet) handleWalletUpdated(res.wallet)
      tickets.value = normalizeTickets(res.tickets)
      const matched = achievements.value.find(a => a.achievementKey === achievementKey)
      if (matched) pushClaimToast('achievement', matched.title, matched.reward)
      await refreshAchievementsPanel()
    } catch (error: unknown) {
      emitError(normalizeError(error, '领取成就奖励失败'))
    } finally {
      achievementClaiming.value = null
    }
  }

  async function handleClaimAllAchievements() {
    if (achievementClaiming.value) return
    achievementClaiming.value = 'ALL'
    try {
      const res = await gacha.claimAllAchievements()
      if (!res.ok) {
        emitError(res.error || '领取成就奖励失败')
        return
      }
      if (res.wallet) handleWalletUpdated(res.wallet)
      tickets.value = normalizeTickets(res.tickets)
      const count = res.claimed ?? achievementClaimableCount.value
      if (count > 0) pushBatchClaimToast('achievement', count)
      await refreshAchievementsPanel()
    } catch (error: unknown) {
      emitError(normalizeError(error, '领取成就奖励失败'))
    } finally {
      achievementClaiming.value = null
    }
  }

  // ─── Result Modal ────────────────────────────────────
  function closeResultModal() {
    resultModalOpen.value = false
  }

  function drawAgain() {
    resultModalOpen.value = false
    const mode = lastTicketDrawMode.value
    setTimeout(() => handleTicketDraw(mode), 260)
  }

  return {
    // Tickets
    tickets,
    ticketsLoading,
    ticketAction,
    reforgeCardId,
    lastReforgeResult,

    // Missions
    missions,
    missionLoading,
    missionClaiming,
    missionViewMode,
    missionItemsActive,
    missionClaimableCount,

    // Achievements
    achievements,
    achievementLoading,
    achievementClaiming,
    achievementItemsForDisplay,
    achievementClaimableCount,

    // Draw result
    lastResult,
    resultModalOpen,

    // Handlers
    refreshPanels,
    loadInitial,
    handleTicketDraw,
    handleAffixReforgeTicketUse,
    handleClaimMission,
    handleClaimAllMissions,
    handleClaimAchievement,
    handleClaimAllAchievements,
    closeResultModal,
    drawAgain,

    // Claim toast
    claimToasts,
    dismissClaimToast
  }
}
