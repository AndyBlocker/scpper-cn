<script setup lang="ts">
import { inject, ref } from 'vue'
import GachaBindingBlock from '~/components/gacha/GachaBindingBlock.vue'
import GachaNotificationPopup from '~/components/gacha/GachaNotificationPopup.vue'
import { GACHA_NOTIFICATION_KEY } from '~/composables/useGachaPage'
import { gachaNavItems, type GachaPageKey } from '~/utils/gachaNav'
import { formatTokens } from '~/utils/gachaFormatters'
import '~/assets/css/gacha-shared.css'

const props = defineProps<{
  authPending: boolean
  showBindingBlock: boolean
  featureName?: string
  page: GachaPageKey
  walletBalance?: number | null
}>()

const notifCtx = inject(GACHA_NOTIFICATION_KEY, {
  notifications: ref([]),
  showNotifications: ref(false),
  dismissNotifications: () => {}
})
</script>

<template>
  <div class="gacha-app-shell">
    <div class="gacha-app-shell__bg" />

    <Transition name="fade" mode="out-in">
      <GachaBindingBlock
        v-if="authPending || showBindingBlock"
        key="gacha-shell-binding"
        :auth-pending="authPending"
        :show-binding-block="showBindingBlock"
        :feature-name="featureName"
      />

      <div v-else key="gacha-shell-layout" class="gacha-layout">
        <!-- Desktop sidebar -->
        <aside class="gacha-sidebar" aria-label="Gacha 导航">
          <div class="gacha-sidebar__header">
            <div class="gacha-sidebar__title">Gacha</div>
            <div v-if="props.walletBalance != null" class="gacha-sidebar__wallet">
              <span class="gacha-sidebar__wallet-label">余额</span>
              <strong class="gacha-sidebar__wallet-value">{{ formatTokens(props.walletBalance) }}</strong>
              <span class="gacha-sidebar__wallet-unit">T</span>
            </div>
          </div>

          <nav class="gacha-sidebar__nav">
            <NuxtLink
              v-for="item in gachaNavItems"
              :key="item.key"
              :to="item.to"
              class="gacha-sidebar__link"
              :class="{ 'is-active': item.key === page }"
            >
              <svg class="gacha-sidebar__icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path :d="item.icon" />
              </svg>
              <span class="gacha-sidebar__link-text">{{ item.label }}</span>
            </NuxtLink>
          </nav>
        </aside>

        <!-- Main content area (with bottom padding on mobile for tab bar) -->
        <main class="gacha-main">
          <slot />
        </main>

        <!-- Mobile bottom tab bar -->
        <nav class="gacha-bottom-tabs" aria-label="Gacha 导航">
          <NuxtLink
            v-for="item in gachaNavItems"
            :key="`tab-${item.key}`"
            :to="item.to"
            class="gacha-bottom-tabs__item"
            :class="{ 'is-active': item.key === page }"
          >
            <svg class="gacha-bottom-tabs__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path :d="item.icon" />
            </svg>
            <span class="gacha-bottom-tabs__label">{{ item.label }}</span>
          </NuxtLink>
        </nav>
      </div>
    </Transition>

    <GachaNotificationPopup
      :open="notifCtx.showNotifications.value"
      :items="notifCtx.notifications.value"
      @dismiss="notifCtx.dismissNotifications()"
    />
  </div>
</template>
