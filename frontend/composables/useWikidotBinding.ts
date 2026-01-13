import { ref, computed } from 'vue'

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

export interface StartBindingResponse {
  ok: boolean
  task?: WikidotBindingTask
  instructions?: {
    targetPage: string
    step1: string
    step2: string
    step3: string
    step4: string
    step5: string
  }
  error?: string
}

export interface StatusResponse {
  ok: boolean
  task: WikidotBindingTask | null
  error?: string
}

export function useWikidotBinding() {
  const { $bff } = useNuxtApp()

  const currentTask = ref<WikidotBindingTask | null>(null)
  const instructions = ref<StartBindingResponse['instructions'] | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  const isPending = computed(() => currentTask.value?.status === 'PENDING')
  const isExpired = computed(() => currentTask.value?.status === 'EXPIRED')
  const hasTask = computed(() => currentTask.value !== null)

  async function fetchStatus(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await $bff<StatusResponse>('/wikidot-binding/status', {
        method: 'GET',
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' }
      })
      if (res.ok) {
        currentTask.value = res.task
      } else {
        error.value = res.error || 'Failed to fetch status'
      }
    } catch (e: unknown) {
      // Not logged in or other error
      currentTask.value = null
    } finally {
      loading.value = false
    }
  }

  async function startBinding(wikidotUsername: string): Promise<{ ok: boolean; error?: string }> {
    loading.value = true
    error.value = null
    try {
      const res = await $bff<StartBindingResponse>('/wikidot-binding/start', {
        method: 'POST',
        body: { wikidotUsername }
      })
      if (res.ok && res.task) {
        currentTask.value = res.task
        instructions.value = res.instructions || null
        return { ok: true }
      }
      error.value = res.error || 'Failed to start binding'
      return { ok: false, error: error.value }
    } catch (e: unknown) {
      // Extract error message from FetchError response data
      let msg = '请求失败'
      if (e && typeof e === 'object') {
        const fetchError = e as { data?: { error?: string }; message?: string }
        if (fetchError.data?.error) {
          msg = fetchError.data.error
        } else if (fetchError.message) {
          msg = fetchError.message
        }
      }
      error.value = msg
      return { ok: false, error: msg }
    } finally {
      loading.value = false
    }
  }

  async function cancelBinding(): Promise<{ ok: boolean }> {
    loading.value = true
    error.value = null
    try {
      await $bff('/wikidot-binding/cancel', { method: 'DELETE' })
      currentTask.value = null
      instructions.value = null
      return { ok: true }
    } catch {
      return { ok: false }
    } finally {
      loading.value = false
    }
  }

  function getTimeRemaining(): string {
    if (!currentTask.value?.expiresAt) return ''
    const expires = new Date(currentTask.value.expiresAt)
    const now = new Date()
    const diff = expires.getTime() - now.getTime()
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
    error,
    isPending,
    isExpired,
    hasTask,
    fetchStatus,
    startBinding,
    cancelBinding,
    getTimeRemaining,
    formatLastChecked
  }
}
