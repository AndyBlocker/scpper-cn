<template>
  <GachaPageShell
    :auth-pending="authPending"
    :show-binding-block="showBindingBlock"
    :wallet-balance="walletBalance"
    feature-name="抽卡"
    page="index"
  >
    <div class="gacha-page-flow">
      <GachaErrorBanner :error="errorBanner" />

      <Transition name="fade" mode="out-in">
        <GachaActivationBlock
          v-if="!activated"
          key="index-activation"
          :activating="activating"
          :activation-error="activationError"
          @activate="onActivate"
        />

        <div v-else key="index-main" class="gacha-page-flow gacha-page-enter">
          <GachaWalletBar
            ref="balanceRef"
            mode="full"
            @updated="handleWalletUpdated"
            @claimed="handleWalletUpdated"
            @error="emitError"
          />

          <div class="flex items-center gap-2" role="tablist" @keydown="handleTabKeydown">
            <button
              type="button"
              role="tab"
              :aria-selected="activeTab === 'draw'"
              :tabindex="activeTab === 'draw' ? 0 : -1"
              class="gacha-tab-btn"
              :class="{ 'is-active': activeTab === 'draw' }"
              @click="setTab('draw')"
            >
              抽卡
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="activeTab === 'history'"
              :tabindex="activeTab === 'history' ? 0 : -1"
              class="gacha-tab-btn"
              :class="{ 'is-active': activeTab === 'history' }"
              @click="setTab('history')"
            >
              历史
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="activeTab === 'tickets'"
              :tabindex="activeTab === 'tickets' ? 0 : -1"
              class="gacha-tab-btn"
              :class="{ 'is-active': activeTab === 'tickets' }"
              @click="setTab('tickets')"
            >
              票券
              <span
                v-if="ticketTotal > 0"
                class="ml-1 inline-flex items-center justify-center rounded-full bg-[rgb(var(--accent-strong))] px-1.5 text-[10px] font-semibold text-white"
              >{{ ticketTotal }}</span>
            </button>
          </div>

          <Transition name="slide-fade" mode="out-in">
            <GachaDrawPanel
              v-if="activeTab === 'draw'"
              key="index-draw-tab"
              :pools="pools"
              :current-pool="currentPool"
              :drawing="drawing"
              :can-draw-single="canDrawSingle"
              :can-draw-ten="canDrawTen"
              :tickets="tickets"
              :purple-pity-count="purplePityCount"
              :gold-pity-count="goldPityCount"
              @draw="handleDraw"
            />

            <GachaHistoryPanel
              v-else-if="activeTab === 'history'"
              key="index-history-tab"
              :history="history"
              @refresh="refreshHistory"
            />

            <GachaMissionTicketPanel
              v-else-if="activeTab === 'tickets'"
              key="index-tickets-tab"
              :tickets="tickets"
              :loading="ticketsLoading"
              :ticket-action="ticketAction"
              :reforge-card-options="reforgeCardOptions"
              :reforge-options-loading="reforgeOptionsLoading"
              :reforge-options-fully-loaded="reforgeOptionsFullyLoaded"
              v-model:reforge-card-id="reforgeCardId"
              v-model:reforge-affix-filter="reforgeAffixFilter"
              @draw="handleTicketDraw"
              @reforge="openReforgeModal"
            />
          </Transition>
        </div>
      </Transition>
    </div>
  </GachaPageShell>

  <GachaDrawResultModal
    :open="resultModalOpen"
    :result="lastResult"
    :draw-again-disabled="!canDrawAgain"
    @close="closeResultModal"
    @view-album="handleViewAlbum"
    @draw-again="drawAgain"
  />

  <GachaReforgeModal
    :open="reforgeModalOpen"
    :phase="reforgeModalPhase"
    :selected-card="selectedReforgeCardOption"
    :result="lastReforgeResult"
    :result-card-visual="reforgeResultCardVisual"
    :confirming="reforgeConfirming"
    @close="closeReforgeModal"
    @confirm="confirmReforge"
    @reforge-again="reforgeAgain"
  />
</template>

<script setup lang="ts">
import { computed, watch, onBeforeUnmount } from 'vue'

useHead({ title: '扭蛋' })

import GachaPageShell from '~/components/gacha/GachaPageShell.vue'
import GachaWalletBar from '~/components/gacha/GachaWalletBar.vue'
import GachaErrorBanner from '~/components/gacha/GachaErrorBanner.vue'
import GachaActivationBlock from '~/components/gacha/GachaActivationBlock.vue'
import GachaDrawPanel from '~/components/gacha/GachaDrawPanel.vue'
import GachaHistoryPanel from '~/components/gacha/GachaHistoryPanel.vue'
import GachaDrawResultModal from '~/components/gacha/GachaDrawResultModal.vue'
import GachaReforgeModal from '~/components/gacha/GachaReforgeModal.vue'
import GachaMissionTicketPanel from '~/components/gacha/GachaMissionTicketPanel.vue'
import { useGachaPage } from '~/composables/useGachaPage'
import { useGachaDraw } from '~/composables/useGachaDraw'
import { useGachaPageLifecycle } from '~/composables/useGachaPageLifecycle'
import { useQueryTab } from '~/composables/useQueryTab'
import { useRouter } from 'vue-router'

const page = useGachaPage({ pageName: 'index' })
const {
  authPending, showBindingBlock,
  errorBanner, activated, activating, activationError, emitError
} = page

const idx = useGachaDraw(page)
const {
  pools, currentPool,
  drawing, lastResult, resultModalOpen,
  canDrawSingle, canDrawTen, canDrawAgain,
  handleDraw, drawAgain, closeResultModal,
  history, refreshHistory,
  tickets, ticketsLoading, ticketAction, reforgeCardId,
  reforgeCardOptions, reforgeOptionsLoading, reforgeOptionsFullyLoaded, reforgeAffixFilter, lastReforgeResult,
  handleTicketDraw,
  refreshReforgeCardOptions,
  reforgeModalOpen, reforgeModalPhase, reforgeConfirming,
  selectedReforgeCardOption, openReforgeModal, closeReforgeModal, reforgeAgain, confirmReforge,
  loadInitial, handleWalletUpdated,
  cleanup: cleanupDraw
} = idx

onBeforeUnmount(() => {
  cleanupDraw()
})

const { state } = page.gacha
const purplePityCount = computed(() => Number(state.value.wallet?.purplePityCount ?? 0))
const goldPityCount = computed(() => Number(state.value.wallet?.goldPityCount ?? 0))

const router = useRouter()
const { activeTab, setTab } = useQueryTab<'draw' | 'history' | 'tickets'>({ defaultTab: 'draw' })

const indexTabs: Array<'draw' | 'history' | 'tickets'> = ['draw', 'history', 'tickets']
function handleTabKeydown(e: KeyboardEvent) {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
  e.preventDefault()
  const idx = indexTabs.indexOf(activeTab.value)
  const next = e.key === 'ArrowRight'
    ? indexTabs[(idx + 1) % indexTabs.length]
    : indexTabs[(idx - 1 + indexTabs.length) % indexTabs.length]
  setTab(next)
  const tablist = (e.currentTarget as HTMLElement)
  const nextBtn = tablist?.querySelector<HTMLElement>('[aria-selected="true"]')
  nextBtn?.focus()
}

const ticketTotal = computed(() =>
  tickets.value.drawTicket + tickets.value.draw10Ticket + tickets.value.affixReforgeTicket
)

const reforgeResultCardVisual = computed(() => {
  if (!lastReforgeResult.value) return null
  const option = reforgeCardOptions.value.find((o) => o.cardId === lastReforgeResult.value!.cardId)
  if (!option) return null
  return {
    rarity: option.rarity,
    imageUrl: option.imageUrl,
    tags: option.tags,
    isRetired: !!option.isRetired,
    wikidotId: option.wikidotId ?? null,
    authors: option.authors ?? null
  }
})

watch(activeTab, (tab) => {
  if (tab !== 'tickets') return
  refreshReforgeCardOptions().catch(() => {})
}, { immediate: true })

function handleViewAlbum() {
  router.push('/gachas/album')
}

const { walletBalance, onActivate } = useGachaPageLifecycle({
  page: {
    showBindingBlock,
    handleActivate: page.handleActivate,
    gacha: page.gacha
  },
  tag: 'gacha-index',
  loadInitial
})
</script>
