<template>
  <GachaPageShell
    :auth-pending="authPending"
    :show-binding-block="showBindingBlock"
    :wallet-balance="walletBalance"
    feature-name="股市"
    page="market"
  >
    <div class="gacha-page-flow">
      <GachaErrorBanner :error="errorBanner" />

      <Transition name="fade" mode="out-in">
        <GachaActivationBlock
          v-if="!activated"
          key="market-activation"
          :activating="activating"
          :activation-error="activationError"
          @activate="onActivate"
        />

        <div v-else key="market-main" class="gacha-page-flow gacha-page-enter">
          <GachaMarketPanel
            :contracts="marketContracts"
            :selected-contract-id="selectedMarketContractId"
            :timeframe="marketTimeframe"
            :ticks="marketTicks"
            :candles="marketCandles"
            :markers="marketMarkers"
            :tick-diagnostics="marketTickDiagnostics"
            :positions="marketPositions"
            :settlements="marketSettlements"
            :settlement-summary="marketSettlementSummary"
            :opponents="marketOpponents"
            :lock-tier-config="marketLockTierConfig"
            :loading="marketLoading"
            :opening="marketOpening"
            @select-contract="handleSelectMarketContractFromPanel"
            @change-timeframe="handleChangeMarketTimeframeFromPanel"
            @refresh="refreshMarketPanel"
            @open-position="handleOpenMarketPositionFromPanel"
          />
        </div>
      </Transition>
    </div>
  </GachaPageShell>
</template>

<script setup lang="ts">
import GachaPageShell from '~/components/gacha/GachaPageShell.vue'
import GachaErrorBanner from '~/components/gacha/GachaErrorBanner.vue'
import GachaActivationBlock from '~/components/gacha/GachaActivationBlock.vue'
import GachaMarketPanel from '~/components/gacha/GachaMarketPanel.vue'
import { useGachaPage } from '~/composables/useGachaPage'
import { useGachaMarket } from '~/composables/useGachaMarket'
import { useGachaPageLifecycle } from '~/composables/useGachaPageLifecycle'

const page = useGachaPage({ pageName: 'market' })
const {
  authPending, showBindingBlock,
  errorBanner, activated, activating, activationError,
  handleActivate
} = page

const idx = useGachaMarket(page)
const {
  placement,
  marketContracts, selectedMarketContractId, marketTimeframe,
  marketTicks, marketCandles, marketMarkers, marketTickDiagnostics,
  marketPositions, marketSettlements, marketSettlementSummary, marketOpponents,
  marketLockTierConfig, marketLoading, marketOpening,
  refreshMarketPanel,
  handleSelectMarketContractFromPanel, handleChangeMarketTimeframeFromPanel,
  handleOpenMarketPositionFromPanel,
  loadInitial
} = idx

const { walletBalance, onActivate } = useGachaPageLifecycle({
  page: {
    showBindingBlock,
    handleActivate,
    gacha: page.gacha
  },
  tag: 'gacha-market',
  loadInitial,
  afterLoad: refreshMarketPanel
})
</script>
