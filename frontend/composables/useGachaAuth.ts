import { computed, ref, watch, onMounted } from 'vue'
import { navigateTo } from 'nuxt/app'
import { useAuth } from '~/composables/useAuth'
import { useGacha } from '~/composables/useGacha'

/**
 * 共享的 gacha 认证/绑定守卫逻辑。
 * 4 个 gacha 页面都需要：检查登录状态、检查 Wikidot 绑定、处理激活流程。
 */
export function useGachaAuth() {
  const { status, user, loading: authLoading, fetchCurrentUser } = useAuth()
  const gacha = useGacha()

  const authPending = computed(() => status.value === 'unknown' || authLoading.value)
  const showBindingBlock = computed(() =>
    status.value === 'authenticated' && !user.value?.linkedWikidotId
  )

  const activating = ref(false)
  const activationError = ref<string | null>(null)

  watch(status, (next) => {
    if (next === 'unauthenticated') {
      navigateTo('/auth/login', { replace: true })
    }
  })

  onMounted(() => {
    if (status.value === 'unknown') {
      fetchCurrentUser().catch((error) => {
        console.warn('[gacha] fetchCurrentUser failed', error)
      })
    } else if (status.value === 'unauthenticated') {
      navigateTo('/auth/login', { replace: true })
    }
  })

  async function handleActivate() {
    if (activating.value) return { ok: false as const, error: '正在激活中' }
    activating.value = true
    activationError.value = null
    try {
      const result = await gacha.activate()
      if (!result.ok) {
        activationError.value = result.error || '激活失败'
      }
      return result
    } catch (error: any) {
      activationError.value = error?.message || '激活失败'
      return { ok: false as const, error: activationError.value }
    } finally {
      activating.value = false
    }
  }

  return {
    status,
    user,
    authPending,
    showBindingBlock,
    activating,
    activationError,
    handleActivate,
    gacha
  }
}
