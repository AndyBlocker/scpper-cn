import { ref, computed } from 'vue'
import { useAuth } from '~/composables/useAuth'

export interface WikidotBindingTask {
  id: string
  wikidotUserId: number
  wikidotUsername: string | null
  verificationCode: string
  status: 'PENDING' | 'VERIFIED' | 'EXPIRED' | 'CANCELLED'
  expiresAt: string
  lastCheckedAt: string | null
  checkCount: number
  failureReason: string | null
}

export interface ResolvedWikidotUser {
  wikidotId: number
  displayName: string | null
  username: string | null
}

export interface StartBindingResponse {
  ok: boolean
  task?: WikidotBindingTask
  instructions?: {
    targetPage: string
    step1: string
    step2: string
    step3: string
    step4: string
    step5?: string
  }
  error?: string
}

export interface StatusResponse {
  ok: boolean
  task: WikidotBindingTask | null
  error?: string
}

export interface ResolveUsersResponse {
  ok: boolean
  users: ResolvedWikidotUser[]
  error?: string
}

export interface StartBindingPayload {
  wikidotUsername?: string
  wikidotId?: number
}

export function useWikidotBinding() {
  const { $bff } = useNuxtApp()
  const { fetchCurrentUser } = useAuth()

  const currentTask = ref<WikidotBindingTask | null>(null)
  const instructions = ref<StartBindingResponse['instructions'] | null>(null)
  const loading = ref(false)
  const refreshing = ref(false)
  const statusKnown = ref(false)
  const error = ref<string | null>(null)
  let statusRequest: Promise<void> | null = null
  let statusEpoch = 0

  const isPending = computed(() => currentTask.value?.status === 'PENDING')
  const isExpired = computed(() => currentTask.value?.status === 'EXPIRED')
  const hasTask = computed(() => currentTask.value !== null)

  function getErrorStatus(errorValue: unknown): number | null {
    if (!errorValue || typeof errorValue !== 'object') return null
    const fetchError = errorValue as {
      status?: number
      statusCode?: number
      response?: { status?: number }
    }
    const status = fetchError.status ?? fetchError.statusCode ?? fetchError.response?.status
    return Number.isFinite(Number(status)) ? Number(status) : null
  }

  function getErrorMessage(errorValue: unknown, fallback: string): string {
    if (!errorValue || typeof errorValue !== 'object') return fallback
    const fetchError = errorValue as { data?: { error?: string }; message?: string }
    if (fetchError.data?.error) return fetchError.data.error
    if (fetchError.message) return fetchError.message
    return fallback
  }

  function fetchStatus(): Promise<void> {
    if (statusRequest) return statusRequest

    statusRequest = (async () => {
      refreshing.value = true
      const requestEpoch = statusEpoch
      try {
        const res = await $bff<StatusResponse>('/wikidot-binding/status', {
          method: 'GET',
          headers: { 'cache-control': 'no-cache', pragma: 'no-cache' }
        })
        if (!res.ok) {
          if (requestEpoch === statusEpoch) {
            error.value = res.error || '暂时无法刷新绑定状态，请稍后重试'
          }
          return
        }

        // A mutation may have completed while this status request was in flight.
        // Never let its older snapshot overwrite the mutation result.
        if (requestEpoch !== statusEpoch) return

        // A verified task is no longer returned by the status endpoint. Revalidate
        // even on the first empty response: verification may have completed in a
        // background tab before this panel mounted.
        if (res.task === null) {
          await fetchCurrentUser(true)
          if (requestEpoch !== statusEpoch) return
        }

        statusKnown.value = true
        error.value = null
        currentTask.value = res.task
      } catch (e: unknown) {
        if (getErrorStatus(e) === 401) {
          if (requestEpoch !== statusEpoch) return
          statusKnown.value = false
          currentTask.value = null
          instructions.value = null
          error.value = '登录状态已失效，请重新登录'
          await fetchCurrentUser(true)
          return
        }

        // Keep the last trustworthy task on transient network/upstream errors.
        if (requestEpoch === statusEpoch) {
          error.value = getErrorMessage(e, '暂时无法刷新绑定状态，请稍后重试')
        }
      } finally {
        refreshing.value = false
        statusRequest = null
      }
    })()

    return statusRequest
  }

  async function startBinding(payload: StartBindingPayload): Promise<{ ok: boolean; error?: string }> {
    statusEpoch++
    loading.value = true
    error.value = null
    try {
      const res = await $bff<StartBindingResponse>('/wikidot-binding/start', {
        method: 'POST',
        body: payload
      })
      if (res.ok && res.task) {
        statusKnown.value = true
        currentTask.value = res.task
        instructions.value = res.instructions || null
        return { ok: true }
      }
      error.value = res.error || 'Failed to start binding'
      return { ok: false, error: error.value }
    } catch (e: unknown) {
      const msg = getErrorMessage(e, '请求失败')
      error.value = msg
      return { ok: false, error: msg }
    } finally {
      loading.value = false
    }
  }

  async function resolveUsers(query: string, limit = 8): Promise<{ ok: boolean; users: ResolvedWikidotUser[]; error?: string }> {
    try {
      const res = await $bff<ResolveUsersResponse>('/wikidot-binding/resolve', {
        method: 'GET',
        query: { query, limit }
      })
      if (!res.ok) {
        return { ok: false, users: [], error: res.error || 'Failed to resolve user' }
      }
      return { ok: true, users: Array.isArray(res.users) ? res.users : [] }
    } catch (e: unknown) {
      const msg = getErrorMessage(e, '请求失败')
      return { ok: false, users: [], error: msg }
    }
  }

  async function cancelBinding(): Promise<{ ok: boolean; error?: string }> {
    statusEpoch++
    loading.value = true
    error.value = null
    try {
      await $bff('/wikidot-binding/cancel', { method: 'DELETE' })
      statusKnown.value = true
      currentTask.value = null
      instructions.value = null
      return { ok: true }
    } catch (e: unknown) {
      const statusCode = getErrorStatus(e)
      const msg = getErrorMessage(e, '取消绑定失败')

      // Expired task can already be absent on server; allow client to continue retry flow.
      if (statusCode === 404) {
        statusKnown.value = true
        currentTask.value = null
        instructions.value = null
        return { ok: true }
      }

      error.value = msg
      return { ok: false, error: msg }
    } finally {
      loading.value = false
    }
  }

  function getTimeRemaining(nowMs = Date.now()): string {
    if (!currentTask.value?.expiresAt) return ''
    const expires = new Date(currentTask.value.expiresAt)
    const diff = expires.getTime() - nowMs
    if (diff <= 0) return '已过期'
    const hours = Math.floor(diff / (1000 * 60 * 60))
    const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60))
    if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
    return `${minutes} 分钟`
  }

  function formatLastChecked(): string {
    if (!currentTask.value?.lastCheckedAt) return '尚未检查'
    const date = new Date(currentTask.value.lastCheckedAt)
    return date.toLocaleString('zh-CN', {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    })
  }

  return {
    currentTask,
    instructions,
    loading,
    refreshing,
    statusKnown,
    error,
    isPending,
    isExpired,
    hasTask,
    fetchStatus,
    startBinding,
    resolveUsers,
    cancelBinding,
    getTimeRemaining,
    formatLastChecked
  }
}
