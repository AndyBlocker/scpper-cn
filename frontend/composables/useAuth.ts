import { useNuxtApp } from 'nuxt/app'
import { computed } from 'vue'

type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated'

export interface AuthUser {
  id: string
  email: string
  displayName: string | null
  linkedWikidotId: number | null
  lastLoginAt: string | null
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

function normalizeUser(payload: any): AuthUser {
  return {
    id: String(payload?.id || ''),
    email: String(payload?.email || ''),
    displayName: payload?.displayName ?? null,
    linkedWikidotId: payload?.linkedWikidotId != null ? Number(payload.linkedWikidotId) : null,
    lastLoginAt: payload?.lastLoginAt ? String(payload.lastLoginAt) : null
  }
}

export function useAuth() {
  const { $bff } = useNuxtApp()
  const { user, status, loading } = useAuthState()

  async function fetchCurrentUser(force = false) {
    if (status.value === 'authenticated' && !force) return user.value
    if (loading.value) return user.value
    loading.value = true
    try {
      const res = await $bff<ApiResponse<AuthUser>>('/auth/me', { method: 'GET' })
      if (res && res.ok && res.user) {
        user.value = normalizeUser(res.user)
        status.value = 'authenticated'
      } else {
        user.value = null
        status.value = 'unauthenticated'
      }
    } catch (error: any) {
      if (error?.status === 401) {
        user.value = null
        status.value = 'unauthenticated'
      } else {
        console.warn('[auth] failed to fetch current user:', error)
        user.value = null
        status.value = 'unauthenticated'
      }
    } finally {
      loading.value = false
    }
    return user.value
  }

  async function login(email: string, password: string) {
    loading.value = true
    try {
      const res = await $bff<ApiResponse<AuthUser>>('/auth/login', {
        method: 'POST',
        body: { email, password }
      })
      if (res && res.ok && res.user) {
        user.value = normalizeUser(res.user)
        status.value = 'authenticated'
        return { ok: true as const }
      }
      const message = res?.error || '登录失败'
      user.value = null
      status.value = 'unauthenticated'
      return { ok: false as const, error: message }
    } catch (error: any) {
      const message = error?.data?.error || error?.message || '登录失败'
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
        user.value = normalizeUser(res.user)
        status.value = 'authenticated'
        return { ok: true as const }
      }
      return { ok: false as const, error: res?.error || '更新失败' }
    } catch (error: any) {
      const message = error?.data?.error || error?.message || '更新失败'
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
    } catch (error: any) {
      const message = error?.data?.error || error?.message || '修改密码失败'
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
