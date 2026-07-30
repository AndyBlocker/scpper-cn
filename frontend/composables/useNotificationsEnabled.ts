import { computed, type ComputedRef } from 'vue'
import { useRuntimeConfig } from 'nuxt/app'

/**
 * 站内提醒功能总开关。
 *
 * Nuxt 的 public runtime config 可被 NUXT_PUBLIC_NOTIFICATIONS_ENABLED
 * 在启动时覆盖；覆盖值可能是字符串，因此不能直接使用 Boolean(value)。
 */
export function useNotificationsEnabled(): ComputedRef<boolean> {
  return computed(() => normalizeNotificationsFlag(
    useRuntimeConfig().public.notificationsEnabled
  ))
}

function normalizeNotificationsFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  if (typeof value === 'string') return /^(1|true|yes|on)$/i.test(value.trim())
  return false
}
