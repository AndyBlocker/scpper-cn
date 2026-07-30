import { computed, type ComputedRef } from 'vue'
import { useRuntimeConfig } from 'nuxt/app'

/**
 * QQ 通知与绑定的总开关（2026-07-30 起该功能暂时下线）。
 *
 * 【为什么不直接 Boolean(config.qqNotifyEnabled)】
 * 构建期它是布尔，但运行时用 NUXT_PUBLIC_QQ_NOTIFY_ENABLED 覆盖时，
 * Nuxt 给到的是**字符串**。于是 Boolean('false') === true ——
 * 想用运行时变量把一个已开启的构建关掉，反而会一直是开着的，
 * 而这恰恰是回滚时最需要它正确的时候。
 *
 * 三个用到开关的地方（账号页、QqBindingPanel、NotificationSettingsPanel）
 * 共用这里，避免各写一份解析而写歪。
 */
export function useQqNotifyEnabled(): ComputedRef<boolean> {
  return computed(() => normalizeFlag(useRuntimeConfig().public.qqNotifyEnabled))
}

/** 布尔按原样；字符串只认明确的真值词，其余（含 'false'、''）一律为假 */
export function normalizeFlag(value: unknown): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value === 1
  if (typeof value === 'string') return /^(1|true|yes|on)$/i.test(value.trim())
  return false
}
