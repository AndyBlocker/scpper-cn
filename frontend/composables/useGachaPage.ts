import { provide, ref, watch, onMounted, type InjectionKey, type Ref } from 'vue'
import { useGachaAuth } from '~/composables/useGachaAuth'
import type { GachaFeatureStatus, Wallet } from '~/types/gacha'
import type { GachaNotification } from '~/components/gacha/GachaNotificationPopup.vue'

const NOTIF_LS_KEY = 'gacha_notif_read_at'

export interface GachaNotificationContext {
  notifications: Ref<GachaNotification[]>
  showNotifications: Ref<boolean>
  dismissNotifications: () => void
}

export const GACHA_NOTIFICATION_KEY: InjectionKey<GachaNotificationContext> = Symbol('gacha-notifications')

/**
 * 共享的 gacha 页面编排层。
 * 整合认证守卫 + feature status + 错误/成功 banner + 激活状态 + 钱包更新。
 * 替代 4 个页面中各自重复的 ~80 行样板逻辑。
 */
export function useGachaPage(options?: { pageName?: string }) {
  const tag = options?.pageName ? `[gacha-${options.pageName}]` : '[gacha]'
  const auth = useGachaAuth()
  const { gacha } = auth

  // ─── Feature Status ──────────────────────────────────
  const featureStatus = ref<GachaFeatureStatus | null>(null)

  async function refreshFeatureStatus() {
    try {
      const res = await gacha.getFeatures()
      if (res.ok && res.data) {
        featureStatus.value = res.data
      } else {
        console.warn(`${tag} load feature status failed`, res.error || '加载玩法状态失败')
      }
    } catch (error: any) {
      console.warn(`${tag} load feature status failed`, error?.message || '加载玩法状态失败')
    }
  }

  // ─── Error / Success Banners ─────────────────────────
  const errorBanner = ref<string | null>(null)
  const successBanner = ref<string | null>(null)

  function emitError(message: string) {
    if (!message) return
    errorBanner.value = message
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        if (errorBanner.value === message) errorBanner.value = null
      }, 5000)
    }
  }

  function emitSuccess(message: string) {
    if (!message) return
    successBanner.value = message
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        if (successBanner.value === message) successBanner.value = null
      }, 5000)
    }
  }

  // ─── Activation State ────────────────────────────────
  const activated = ref(false)

  async function refreshConfig(force = false) {
    try {
      const res = await gacha.getConfig(force)
      if (res.ok && res.data) {
        activated.value = !!res.data.activated
      }
    } catch (error) {
      console.warn(`${tag} load config failed`, error)
    }
  }

  async function handleActivate() {
    const result = await auth.handleActivate()
    if (result.ok) {
      activated.value = true
    }
    return result
  }

  // ─── Wallet Update ───────────────────────────────────
  const gachaState = gacha.state

  function handleWalletUpdated(wallet: Wallet | null) {
    if (!wallet) return
    gachaState.value.wallet = wallet
    gachaState.value.walletFetchedAt = new Date().toISOString()
  }

  // ─── Notifications ─────────────────────────────────────
  const notifications = ref<GachaNotification[]>([])
  const showNotifications = ref(false)

  async function fetchNotifications() {
    if (typeof window === 'undefined') return
    try {
      const since = localStorage.getItem(NOTIF_LS_KEY) || undefined
      const res = await gacha.fetchNotifications(since)
      if (res.ok && res.items.length > 0) {
        notifications.value = res.items
        showNotifications.value = true
      }
    } catch (error) {
      console.warn(`${tag} fetch notifications failed`, error)
    }
  }

  function dismissNotifications() {
    showNotifications.value = false
    if (typeof window !== 'undefined') {
      localStorage.setItem(NOTIF_LS_KEY, new Date().toISOString())
    }
    notifications.value = []
  }

  provide(GACHA_NOTIFICATION_KEY, {
    notifications,
    showNotifications,
    dismissNotifications
  })

  // ─── Auto-load on mount ──────────────────────────────
  watch(auth.showBindingBlock, (blocked) => {
    if (!blocked) {
      Promise.allSettled([refreshFeatureStatus(), refreshConfig(true), gacha.getWallet()]).catch((error) => {
        console.warn(`${tag} refresh after binding failed`, error)
      })
    }
  })

  // Notifications require auth — wait until authPending resolves
  let notifFetched = false
  watch(auth.authPending, (pending) => {
    if (!pending && !notifFetched && auth.status.value === 'authenticated') {
      notifFetched = true
      fetchNotifications()
    }
  }, { immediate: true })

  onMounted(() => {
    if (!auth.showBindingBlock.value) {
      Promise.allSettled([refreshFeatureStatus(), refreshConfig(false), gacha.getWallet()]).catch((error) => {
        console.warn(`${tag} initial load failed`, error)
      })
    }
  })

  return {
    // From auth
    status: auth.status,
    user: auth.user,
    authPending: auth.authPending,
    showBindingBlock: auth.showBindingBlock,
    activating: auth.activating,
    activationError: auth.activationError,
    gacha,

    // Feature status
    featureStatus,
    refreshFeatureStatus,

    // Banners
    errorBanner,
    successBanner,
    emitError,
    emitSuccess,

    // Activation
    activated,
    refreshConfig,
    handleActivate,

    // Wallet
    handleWalletUpdated,

    // Notifications
    notifications,
    showNotifications,
    dismissNotifications
  }
}

export type GachaPageContext = ReturnType<typeof useGachaPage>
