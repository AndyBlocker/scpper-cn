import { computed, ref } from 'vue'

/**
 * 通知偏好：类型 × 渠道矩阵 + 渠道级设置。
 *
 * 与 useAlertSettings 的分工：那个管「触发条件」（票数阈值、修订过滤），
 * 这个管「收不收、走哪个渠道、什么节奏」。两者都在通知设置页，
 * 但存储与语义完全不同，混在一个 composable 里会让人分不清改的是哪层。
 */

export const NOTIFY_TYPES = [
  'PAGE_COMMENT', 'PAGE_VOTE', 'PAGE_REVISION', 'FOLLOW_ACTIVITY', 'FORUM_INTERACTION'
] as const
export type NotifyType = (typeof NOTIFY_TYPES)[number]

export type DeliveryMode = 'REALTIME' | 'DAILY_DIGEST'

export interface NotifyMatrixRow {
  type: NotifyType
  siteEnabled: boolean
  qqEnabled: boolean
}

export interface NotifyChannelSetting {
  qqDailyLimit: number
  qqMode: DeliveryMode
  qqDigestHour: number
  /** 实际生效上限 = min(用户设置, 运维全局上限)。填得比它大不会生效。 */
  effectiveDailyLimit: number
  globalDailyLimit: number
}

interface NotifyPrefsResponse {
  ok: boolean
  matrix: NotifyMatrixRow[]
  channel: NotifyChannelSetting
}

const DEFAULT_CHANNEL: NotifyChannelSetting = {
  qqDailyLimit: 20, qqMode: 'REALTIME', qqDigestHour: 21,
  effectiveDailyLimit: 20, globalDailyLimit: 40
}

export function useNotifyPreferences() {
  const { $bff } = useNuxtApp()

  const matrix = useState<NotifyMatrixRow[]>('notifyPrefs/matrix', () =>
    NOTIFY_TYPES.map((type) => ({ type, siteEnabled: true, qqEnabled: true }))
  )
  const channel = useState<NotifyChannelSetting>('notifyPrefs/channel', () => ({ ...DEFAULT_CHANNEL }))
  const loading = useState<boolean>('notifyPrefs/loading', () => false)
  const saving = useState<boolean>('notifyPrefs/saving', () => false)
  const error = ref<string | null>(null)

  /**
   * 身份世代号。与三个 alerts composable 同款守卫：
   * A 的请求在飞时换成 B 登录，A 的响应不得写进 B 看到的共享状态。
   */
  const identityEpoch = useState<number>('notifyPrefs/epoch', () => 0)
  const requestGeneration = useState<number>('notifyPrefs/reqGen', () => 0)

  async function fetchPreferences(force = false) {
    if (loading.value && !force) return
    loading.value = true
    error.value = null
    const myEpoch = identityEpoch.value
    const myReq = requestGeneration.value + 1
    requestGeneration.value = myReq
    try {
      const res = await $bff<NotifyPrefsResponse>('/alerts/notify-preferences', { method: 'GET' })
      if (identityEpoch.value !== myEpoch || requestGeneration.value !== myReq) return
      if (res?.ok) {
        matrix.value = Array.isArray(res.matrix) && res.matrix.length ? res.matrix : matrix.value
        channel.value = { ...DEFAULT_CHANNEL, ...(res.channel ?? {}) }
      }
    } catch (e) {
      console.warn('[notify-prefs] fetch failed', e)
      if (identityEpoch.value === myEpoch && requestGeneration.value === myReq) {
        error.value = '加载通知偏好失败'
      }
    } finally {
      if (requestGeneration.value === myReq) loading.value = false
    }
  }

  /** 提交部分改动。matrix 只需传被改过的行。 */
  async function save(payload: { matrix?: NotifyMatrixRow[]; channel?: Partial<NotifyChannelSetting> }) {
    saving.value = true
    error.value = null
    const myEpoch = identityEpoch.value
    try {
      const res = await $bff<NotifyPrefsResponse>('/alerts/notify-preferences', { method: 'POST', body: payload })
      if (identityEpoch.value !== myEpoch) return false
      if (res?.ok) {
        // 以服务端返回的权威值为准，而不是把本地乐观值留下 ——
        // 服务端会对日限额做钳制（不得超过全局上限），本地值可能被改小
        matrix.value = res.matrix ?? matrix.value
        channel.value = { ...DEFAULT_CHANNEL, ...(res.channel ?? {}) }
        return true
      }
      error.value = '保存失败，请稍后重试'
      return false
    } catch (e) {
      console.warn('[notify-prefs] save failed', e)
      if (identityEpoch.value === myEpoch) error.value = '保存失败，请稍后重试'
      return false
    } finally {
      if (identityEpoch.value === myEpoch) saving.value = false
    }
  }

  function resetState() {
    identityEpoch.value += 1
    requestGeneration.value += 1
    matrix.value = NOTIFY_TYPES.map((type) => ({ type, siteEnabled: true, qqEnabled: true }))
    channel.value = { ...DEFAULT_CHANNEL }
    loading.value = false
    saving.value = false
    error.value = null
  }

  const byType = computed(() => new Map(matrix.value.map((r) => [r.type, r])))

  return { matrix, byType, channel, loading, saving, error, fetchPreferences, save, resetState }
}
