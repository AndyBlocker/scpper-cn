import { useNuxtApp } from 'nuxt/app'
import { computed } from 'vue'
import { getErrorMessage, getErrorStatus } from '~/utils/httpError'

type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated'

export interface AuthUser {
  id: string
  email: string
  displayName: string | null
  linkedWikidotId: number | null
  lastLoginAt: string | null
  /**
   * QQ 通知渠道绑定摘要。addressMask 形如 1234***7 ——
   * user-backend 不会把完整 QQ 号发出来，前端拿不到也不需要它。
   */
  qqBinding: {
    bound: boolean
    addressMask: string | null
    status: string | null
  }
}

interface ApiResponse<T> {
  ok: boolean
  user?: T
  error?: string
}

function useAuthState() {
  const user = useState<AuthUser | null>('auth-user', () => null)
  const status = useState<AuthStatus>('auth-status', () => 'unknown')
  const loading = useState<boolean>('auth-loading', () => false)
  return { user, status, loading }
}

function normalizeUser(payload: any, previous?: AuthUser | null): AuthUser {
  return {
    id: String(payload?.id || ''),
    email: String(payload?.email || ''),
    displayName: payload?.displayName ?? null,
    linkedWikidotId: payload?.linkedWikidotId != null ? Number(payload.linkedWikidotId) : null,
    lastLoginAt: payload?.lastLoginAt ? String(payload.lastLoginAt) : null,
    // /auth/login 与 /auth/profile 返回的是 formatUser 的形状，**不含** qqBinding。
    // 直接取 payload 会把已绑定用户的状态抹成 bound:false，界面随即报「未绑定」，
    // 直到下一次强制 /auth/me 才恢复。字段缺失时保留上一份快照。
    qqBinding: payload?.qqBinding
      ? {
          bound: Boolean(payload.qqBinding.bound),
          addressMask: payload.qqBinding.addressMask ?? null,
          status: payload.qqBinding.status ?? null
        }
      : (previous?.qqBinding ?? { bound: false, addressMask: null, status: null })
  }
}

export function useAuth() {
  const { $bff } = useNuxtApp()
  const { user, status, loading } = useAuthState()

  let fetchInflight: Promise<AuthUser | null> | null = null

  async function fetchCurrentUser(force = false) {
    if (status.value === 'authenticated' && !force) {
      console.debug('[auth] fetchCurrentUser skip (already authenticated)')
      return user.value
    }
    if (fetchInflight) {
      console.debug('[auth] fetchCurrentUser dedup (already in-flight)')
      return fetchInflight
    }
    loading.value = true
    fetchInflight = (async () => { try {
      const requestOptions: Record<string, any> = {
        method: 'GET',
        headers: {
          'cache-control': 'no-cache',
          pragma: 'no-cache'
        }
      }
      if (force || status.value !== 'authenticated') {
        requestOptions.params = { _: Date.now().toString(36) }
      }
      console.debug('[auth] fetchCurrentUser request', {
        force,
        status: status.value,
        params: requestOptions.params
      })
      const res = await $bff<ApiResponse<AuthUser>>('/auth/me', requestOptions)
      if (res && res.ok && res.user) {
        user.value = normalizeUser(res.user, user.value)
        status.value = 'authenticated'
        console.debug('[auth] fetchCurrentUser success', {
          id: user.value.id,
          linkedWikidotId: user.value.linkedWikidotId
        })
      } else {
        user.value = null
        status.value = 'unauthenticated'
        console.warn('[auth] fetchCurrentUser unexpected response', res)
      }
    } catch (error: unknown) {
      if (getErrorStatus(error) === 401) {
        user.value = null
        status.value = 'unauthenticated'
        console.debug('[auth] fetchCurrentUser 401 (unauthenticated)')
      } else {
        console.warn('[auth] failed to fetch current user:', error)
        // A temporary BFF/network failure is not evidence that the session ended.
        // Keep the last trustworthy auth snapshot; only an explicit 401 clears it.
      }
    } finally {
      loading.value = false
      fetchInflight = null
    }
    return user.value
    })()
    return fetchInflight
  }

  async function login(email: string, password: string) {
    loading.value = true
    try {
      const res = await $bff<ApiResponse<AuthUser>>('/auth/login', {
        method: 'POST',
        body: { email, password }
      })
      if (res && res.ok && res.user) {
        user.value = normalizeUser(res.user, user.value)
        status.value = 'authenticated'
        return { ok: true as const }
      }
      const message = res?.error || '登录失败'
      user.value = null
      status.value = 'unauthenticated'
      return { ok: false as const, error: message }
    } catch (error: unknown) {
      const message = getErrorMessage(error, '登录失败')
      user.value = null
      status.value = 'unauthenticated'
      return { ok: false as const, error: message }
    } finally {
      loading.value = false
    }
  }

  async function logout() {
    try {
      await $bff('/auth/logout', { method: 'POST' })
    } catch (error) {
      console.warn('[auth] logout failed', error)
    } finally {
      user.value = null
      status.value = 'unauthenticated'
    }
  }

  async function updateProfile(payload: { displayName: string }) {
    const trimmed = payload.displayName?.trim()
    if (!trimmed) {
      return { ok: false as const, error: '昵称不能为空' }
    }
    try {
      const res = await $bff<ApiResponse<AuthUser>>('/auth/profile', {
        method: 'PATCH',
        body: { displayName: trimmed }
      })
      if (res && res.ok && res.user) {
        user.value = normalizeUser(res.user, user.value)
        status.value = 'authenticated'
        return { ok: true as const }
      }
      return { ok: false as const, error: res?.error || '更新失败' }
    } catch (error: unknown) {
      const message = getErrorMessage(error, '更新失败')
      return { ok: false as const, error: message }
    }
  }

  async function changePassword(payload: { currentPassword: string; newPassword: string }) {
    try {
      await $bff('/auth/password', {
        method: 'PATCH',
        body: payload
      })
      user.value = null
      status.value = 'unauthenticated'
      return { ok: true as const }
    } catch (error: unknown) {
      const message = getErrorMessage(error, '修改密码失败')
      return { ok: false as const, error: message }
    }
  }

  const isAuthenticated = computed(() => status.value === 'authenticated' && !!user.value)

  return {
    user,
    status,
    loading,
    isAuthenticated,
    fetchCurrentUser,
    login,
    logout,
    updateProfile,
    changePassword
  }
}
