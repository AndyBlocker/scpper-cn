import { computed, onScopeDispose, ref } from 'vue'
import { useAuth } from '~/composables/useAuth'
import { getErrorMessage } from '~/utils/httpError'

export interface QqBindingInfo {
  /** 只有掩码（1234***7）。完整号不出 user-backend，前端永远拿不到。 */
  addressMask: string
  displayName: string | null
  status: 'ACTIVE' | 'PAUSED' | 'REVOKED'
  verifiedAt: string
  suspendedUntil: string | null
}

export interface QqChallengeInfo {
  /** 明文码只在 start 那一次返回，这里只有末 4 位，用于「屏幕上那个码是不是这个」 */
  codeHint: string
  expiresAt: string
  createdAt: string
}

interface StatusResponse {
  ok: boolean
  botQq: string | null
  binding: QqBindingInfo | null
  challenge: QqChallengeInfo | null
  error?: string
}

interface StartResponse {
  ok: boolean
  code: string
  expiresAt: string
  ttlMinutes: number
  botQq: string | null
  instructions: {
    step1: string
    step2: string
    step3: string
    note: string
  }
  error?: string
}

export function useQqBinding() {
  const { $bff } = useNuxtApp()
  const { fetchCurrentUser } = useAuth()

  const binding = ref<QqBindingInfo | null>(null)
  const challenge = ref<QqChallengeInfo | null>(null)
  const botQq = ref<string | null>(null)

  /**
   * 明文验证码。刻意只放在内存里、不进 useState、不落 localStorage ——
   * 服务端只存哈希，这里是它在系统中唯一的明文副本，页面一刷新就该消失，
   * 让「验证码只显示一次」这句提示是真的。
   */
  const plainCode = ref<string | null>(null)
  const instructions = ref<StartResponse['instructions'] | null>(null)

  const loading = ref(false)
  const refreshing = ref(false)
  const statusKnown = ref(false)
  const error = ref<string | null>(null)
  /** 与 useWikidotBinding 相同的防竞态手法：在途的旧状态请求不得覆盖新的变更结果 */
  let statusEpoch = 0
  let statusRequest: Promise<void> | null = null
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const isBound = computed(() => binding.value !== null && binding.value.status !== 'REVOKED')
  const isPaused = computed(() => binding.value?.status === 'PAUSED')
  const hasActiveChallenge = computed(() => challenge.value !== null)

  const now = ref(Date.now())
  let clockTimer: ReturnType<typeof setInterval> | null = null

  /** 剩余秒数，用于倒计时展示 */
  const secondsLeft = computed(() => {
    if (!challenge.value) return 0
    const ms = new Date(challenge.value.expiresAt).getTime() - now.value
    return Math.max(0, Math.floor(ms / 1000))
  })

  const countdown = computed(() => {
    const s = secondsLeft.value
    const m = Math.floor(s / 60)
    return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  })

  const isExpired = computed(() => hasActiveChallenge.value && secondsLeft.value <= 0)

  function startClock() {
    if (clockTimer) return
    clockTimer = setInterval(() => { now.value = Date.now() }, 1000)
  }

  function stopClock() {
    if (clockTimer) { clearInterval(clockTimer); clockTimer = null }
  }

  async function fetchStatus(): Promise<void> {
    if (statusRequest) return statusRequest
    statusRequest = (async () => {
      refreshing.value = true
      const epoch = statusEpoch
      try {
        const res = await $bff<StatusResponse>('/qq-binding/status', {
          method: 'GET',
          headers: { 'cache-control': 'no-cache', pragma: 'no-cache' }
        })
        if (epoch !== statusEpoch) return
        if (!res.ok) {
          error.value = res.error || '暂时无法刷新绑定状态，请稍后重试'
          return
        }
        const becameBound = res.binding !== null && binding.value === null
        binding.value = res.binding
        challenge.value = res.challenge
        botQq.value = res.botQq
        statusKnown.value = true
        error.value = null
        if (res.challenge) startClock()
        if (becameBound) {
          // 绑定刚刚完成：清掉屏幕上的明文码，并刷新登录态让导航栏等处同步
          plainCode.value = null
          instructions.value = null
          stopPolling()
          await fetchCurrentUser(true)
        }
      } catch (e) {
        if (epoch === statusEpoch) {
          // 保留已有数据，只提示错误 —— 网络抖动不该让界面看起来像「绑定没了」
          error.value = getErrorMessage(e, '暂时无法刷新绑定状态，请稍后重试')
        }
      } finally {
        refreshing.value = false
        statusRequest = null
      }
    })()
    return statusRequest
  }

  /** 绑定进行中时轮询，绑定完成或没有进行中的挑战时停止 */
  function startPolling(intervalMs = 5000) {
    if (pollTimer) return
    pollTimer = setInterval(() => { void fetchStatus() }, intervalMs)
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  async function start(): Promise<boolean> {
    loading.value = true
    error.value = null
    statusEpoch += 1
    try {
      const res = await $bff<StartResponse>('/qq-binding/start', { method: 'POST' })
      if (!res.ok) {
        error.value = res.error || '发起绑定失败，请稍后重试'
        return false
      }
      plainCode.value = res.code
      instructions.value = res.instructions
      botQq.value = res.botQq
      challenge.value = {
        codeHint: res.code.slice(-4),
        expiresAt: res.expiresAt,
        createdAt: new Date().toISOString()
      }
      now.value = Date.now()
      startClock()
      startPolling()
      return true
    } catch (e) {
      error.value = getErrorMessage(e, '发起绑定失败，请稍后重试')
      return false
    } finally {
      loading.value = false
    }
  }

  async function cancel(): Promise<boolean> {
    loading.value = true
    error.value = null
    statusEpoch += 1
    try {
      await $bff('/qq-binding/cancel', { method: 'DELETE' })
      plainCode.value = null
      instructions.value = null
      challenge.value = null
      stopPolling()
      stopClock()
      return true
    } catch (e) {
      // 404 = 本来就没有进行中的绑定，对用户而言与取消成功等价
      const status = (e as { status?: number; statusCode?: number })?.status
        ?? (e as { statusCode?: number })?.statusCode
      if (status === 404) {
        plainCode.value = null
        instructions.value = null
        challenge.value = null
        stopPolling()
        stopClock()
        return true
      }
      error.value = getErrorMessage(e, '取消失败，请稍后重试')
      return false
    } finally {
      loading.value = false
    }
  }

  async function unbind(password: string): Promise<boolean> {
    loading.value = true
    error.value = null
    statusEpoch += 1
    try {
      await $bff('/qq-binding/unbind', { method: 'POST', body: { password } })
      binding.value = null
      await fetchCurrentUser(true)
      return true
    } catch (e) {
      error.value = getErrorMessage(e, '解绑失败，请稍后重试')
      return false
    } finally {
      loading.value = false
    }
  }

  async function copyCode(): Promise<boolean> {
    if (!plainCode.value) return false
    try {
      await navigator.clipboard.writeText(plainCode.value)
      return true
    } catch {
      return false
    }
  }

  onScopeDispose(() => {
    stopPolling()
    stopClock()
  })

  return {
    binding,
    challenge,
    botQq,
    plainCode,
    instructions,
    loading,
    refreshing,
    statusKnown,
    error,
    isBound,
    isPaused,
    hasActiveChallenge,
    isExpired,
    countdown,
    secondsLeft,
    fetchStatus,
    start,
    cancel,
    unbind,
    copyCode,
    startPolling,
    stopPolling
  }
}
