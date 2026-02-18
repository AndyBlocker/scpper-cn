<template>
  <GachaPageShell
    :auth-pending="authPending"
    :show-binding-block="showBindingBlock"
    :wallet-balance="walletBalance"
    feature-name="放置"
    page="placement"
  >
    <div class="gacha-page-flow">
      <GachaErrorBanner :error="errorBanner" />

      <Transition name="fade" mode="out-in">
        <GachaActivationBlock
          v-if="!activated"
          key="placement-activation"
          :activating="activating"
          :activation-error="activationError"
          @activate="onActivate"
        />

        <div v-else key="placement-main" class="gacha-page-flow gacha-page-enter">
          <section class="gacha-kpi-grid">
            <GachaMetricCard label="已解锁槽位" :value="slotCount" />
            <GachaMetricCard label="已放置卡片" :value="filledSlotCount" />
            <GachaMetricCard label="每小时产能" :value="formatTokenDecimal(estimatedYieldPerHour, 2)" tone="success" />
            <GachaMetricCard label="总收益加成" :value="formatPlacementPercent(yieldBoostPercent, 1)" tone="accent" />
          </section>

          <GachaPlacementPanel
            :placement="placement"
            :loading="placementLoading"
            :claiming="placementClaiming"
            :unlocking="placementUnlocking"
            :slot-updating="placementSlotUpdating"
            :addon-updating="placementAddonUpdating"
            @refresh="refreshPlacementPanel"
            @claim="handlePlacementClaim"
            @unlock-slot="handlePlacementSlotUnlock"
            @open-picker="openPlacementPicker"
            @clear-slot="handlePlacementClear"
            @open-addon-picker="openPlacementAddonPicker"
            @clear-addon="handlePlacementColorlessClear"
          />
        </div>
      </Transition>
    </div>
  </GachaPageShell>

  <GachaPlacementPickerDialog
    :slot-index="placementPickerSlot"
    :current-card-title="placementPickerCurrentSlot?.card ? displayCardTitle(placementPickerCurrentSlot.card.title) : null"
    :current-card-stack-key="placementPickerCurrentStackKey"
    :has-current-card="!!placementPickerCurrentSlot?.card"
    :options="placementPickerOptions"
    :loading="placementOptionsLoading"
    :busy="placementSlotUpdating != null || placementClaiming || placementAddonUpdating || placementUnlocking"
    @close="closePlacementPicker"
    @select="selectPlacementCard"
    @clear="clearPlacementFromPicker"
  />

  <GachaAddonPickerDialog
    :open="placementAddonPickerOpen"
    :current-card-title="placementColorlessAddon?.card ? displayCardTitle(placementColorlessAddon.card.title) : null"
    :has-current-card="!!placementColorlessAddon?.card"
    :options="placementColorlessPickerOptions"
    :busy="placementAddonUpdating || placementClaiming || placementSlotUpdating != null || placementUnlocking"
    @close="closePlacementAddonPicker"
    @select="selectPlacementAddonCard"
    @clear="handlePlacementColorlessClear"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import GachaPageShell from '~/components/gacha/GachaPageShell.vue'
import GachaErrorBanner from '~/components/gacha/GachaErrorBanner.vue'
import GachaActivationBlock from '~/components/gacha/GachaActivationBlock.vue'
import GachaMetricCard from '~/components/gacha/GachaMetricCard.vue'
import GachaPlacementPanel from '~/components/gacha/GachaPlacementPanel.vue'
import GachaPlacementPickerDialog from '~/components/gacha/GachaPlacementPickerDialog.vue'
import GachaAddonPickerDialog from '~/components/gacha/GachaAddonPickerDialog.vue'
import { useGachaPage } from '~/composables/useGachaPage'
import { useGachaPlacement } from '~/composables/useGachaPlacement'
import { useGachaPageLifecycle } from '~/composables/useGachaPageLifecycle'
import { formatPlacementPercent, formatTokenDecimal } from '~/utils/gachaFormatters'

const page = useGachaPage({ pageName: 'placement' })
const {
  authPending, showBindingBlock,
  errorBanner, activated, activating, activationError,
  handleActivate
} = page

const idx = useGachaPlacement(page)
const {
  placement, history,
  placementLoading, placementOptionsLoading, placementClaiming, placementUnlocking,
  placementSlotUpdating, placementAddonUpdating,
  placementPickerSlot, placementAddonPickerOpen,
  placementPickerCurrentSlot, placementPickerCurrentStackKey,
  placementPickerOptions, placementColorlessPickerOptions,
  placementColorlessAddon,
  refreshPlacementPanel,
  handlePlacementClaim, handlePlacementSlotUnlock,
  handlePlacementClear, handlePlacementColorlessClear,
  openPlacementPicker, closePlacementPicker,
  openPlacementAddonPicker, closePlacementAddonPicker,
  selectPlacementCard, clearPlacementFromPicker, selectPlacementAddonCard,
  loadInitial, displayCardTitle
} = idx

const slotCount = computed(() => Math.max(0, Number(placement.value?.slotCount ?? 0)))
const filledSlotCount = computed(() =>
  (placement.value?.slots ?? []).filter((slot) => slot.slotIndex <= slotCount.value && Boolean(slot.card)).length
)
const estimatedYieldPerHour = computed(() => Number(placement.value?.estimatedYieldPerHour ?? 0))
const yieldBoostPercent = computed(() => Number(placement.value?.yieldBoostPercent ?? 0))

const { walletBalance, onActivate } = useGachaPageLifecycle({
  page: {
    showBindingBlock,
    handleActivate,
    gacha: page.gacha
  },
  tag: 'gacha-placement',
  loadInitial
})
</script>
