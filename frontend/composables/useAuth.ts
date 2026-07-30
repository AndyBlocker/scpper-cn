import { useNuxtApp } from 'nuxt/app'
import { computed } from 'vue'
import { getErrorMessage, getErrorStatus } from '~/utils/httpError'

export type AuthStatus = 'unknown' | 'authenticated' | 'unauthenticated'
export type AuthState = 'loading' | 'ready' | 'unauthenticated' | 'error'

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
    pendingChallenge: boolean
    capabilities: {
      featureEnabled: boolean
      createBinding: boolean
      deliverNotifications: boolean
      manageExistingBinding: boolean
    }
  }
}

interface ApiResponse<T> {
  ok: boolean
  user?: T
  error?: string
}

interface AuthFetchInflight {
  epoch: number
  promise: Promise<AuthUser | null>
}

interface AuthRuntime {
  epoch: number
  activeRequestsByEpoch: Map<number, number>
  fetchInflight: AuthFetchInflight | null
}

/**
 * 请求控制不能放在 useAuth() 的函数作用域里：页面、布局和子组件各调用一次
 * useAuth() 时会各自得到一份 inflight，仍然同时请求 /auth/me。
 *
 * 这里按 Nuxt 应用实例存放非序列化运行时。浏览器内所有调用共享一份；SSR 的
 * 每个请求有独立 NuxtApp，因此不会把某位访客的 Promise 或世代号泄露给另一位。
 */
const authRuntimes = new WeakMap<object, AuthRuntime>()

function getAuthRuntime(nuxtApp: object): AuthRuntime {
  const existing = authRuntimes.get(nuxtApp)
  if (existing) return existing

  const runtime: AuthRuntime = {
    epoch: 0,
    activeRequestsByEpoch: new Map(),
    fetchInflight: null
  }
  authRuntimes.set(nuxtApp, runtime)
  return runtime
}

function useAuthState() {
  const user = useState<AuthUser | null>('auth-user', () => null)
  const status = useState<AuthStatus>('auth-status', () => 'unknown')
  const loading = useState<boolean>('auth-loading', () => false)
  const error = useState<string | null>('auth-error', () => null)
  return { user, status, loading, error }
}

const EMPTY_QQ_BINDING: AuthUser['qqBinding'] = {
  bound: false,
  addressMask: null,
  status: null,
  pendingChallenge: false,
  capabilities: {
    featureEnabled: false,
    createBinding: false,
    deliverNotifications: false,
    manageExistingBinding: false
  }
}

function normalizeQqBinding(payload: any): AuthUser['qqBinding'] {
  const bound = Boolean(payload?.bound)
  const pendingChallenge = Boolean(payload?.pendingChallenge)
  return {
    bound,
    addressMask: payload?.addressMask ?? null,
    status: payload?.status ?? null,
    pendingChallenge,
    capabilities: {
      featureEnabled: Boolean(
        payload?.capabilities?.featureEnabled
        ?? payload?.capabilities?.createBinding
        ?? payload?.capabilities?.deliverNotifications
      ),
      // 缺字段表示仍在和旧 user-backend 通信；默认拒绝新建/投递是安全失败方向。
      createBinding: Boolean(payload?.capabilities?.createBinding),
      deliverNotifications: Boolean(payload?.capabilities?.deliverNotifications),
      manageExistingBinding: payload?.capabilities?.manageExistingBinding == null
        ? bound || pendingChallenge
        : Boolean(payload.capabilities.manageExistingBinding)
    }
  }
}

function normalizeUser(payload: any, previous?: AuthUser | null): AuthUser {
  const id = String(payload?.id || '')
  // 只有当这份 payload 说的还是**同一个账号**时，才允许沿用上一份 qqBinding 快照。
  // 否则 A 已登录时直接 login 到 B，B 的 payload 不含 qqBinding，
  // 就会把 A 的掩码 QQ 号和绑定状态复制到 B 的界面上 —— 跨账号信息泄露，
  // 且要等下一次强制 /auth/me 才会被纠正。
  const sameAccount = Boolean(previous?.id) && previous?.id === id
  return {
    id,
    email: String(payload?.email || ''),
    displayName: payload?.displayName ?? null,
    linkedWikidotId: payload?.linkedWikidotId != null ? Number(payload.linkedWikidotId) : null,
    lastLoginAt: payload?.lastLoginAt ? String(payload.lastLoginAt) : null,
    // 新版 /auth/login、/auth/profile、/auth/me 都返回 qqBinding；和旧服务滚动升级
    // 期间仍可能收到缺字段的 payload。同一账号才允许沿用快照，既避免绑定状态闪烁，
    // 也不能把 A 的掩码 QQ 摘要复制到随后登录的 B。
    qqBinding: payload?.qqBinding
      ? normalizeQqBinding(payload.qqBinding)
      : (sameAccount ? (previous?.qqBinding ?? EMPTY_QQ_BINDING) : EMPTY_QQ_BINDING)
  }
}

export function useAuth() {
  const nuxtApp = useNuxtApp()
  const { $bff } = nuxtApp
  const { user, status, loading, error: authError } = useAuthState()
  const runtime = getAuthRuntime(nuxtApp)

  function syncLoading() {
    loading.value = (runtime.activeRequestsByEpoch.get(runtime.epoch) ?? 0) > 0
  }

  function beginRequest(epoch = runtime.epoch) {
    runtime.activeRequestsByEpoch.set(
      epoch,
      (runtime.activeRequestsByEpoch.get(epoch) ?? 0) + 1
    )
    syncLoading()
  }

  function endRequest(epoch: number) {
    const remaining = Math.max(0, (runtime.activeRequestsByEpoch.get(epoch) ?? 0) - 1)
    if (remaining > 0) {
      runtime.activeRequestsByEpoch.set(epoch, remaining)
    } else {
      runtime.activeRequestsByEpoch.delete(epoch)
    }
    // 旧世代请求结束不能改变当前身份世代的 loading。
    syncLoading()
  }

  function supersedeCurrentEpoch() {
    runtime.epoch += 1
    runtime.fetchInflight = null
    // 旧世代已不再影响 UI；即使网络请求永久挂起，也不应在运行时 Map 中累积。
    // 它们若稍后结束，endRequest 对缺失计数同样是幂等的。
    runtime.activeRequestsByEpoch.clear()
    syncLoading()
    return runtime.epoch
  }

  /**
   * 任何会改变身份快照的写操作都开启新世代，并与旧 /auth/me 解除去重关系。
   * 已在网络中的旧请求仍可结束，但只有当前世代的响应能写入共享状态。
   */
  function beginIdentityMutation() {
    const epoch = supersedeCurrentEpoch()
    authError.value = null
    beginRequest(epoch)
    return epoch
  }

  function isCurrent(epoch: number) {
    return runtime.epoch === epoch
  }

  function markUnauthenticated() {
    user.value = null
    status.value = 'unauthenticated'
    authError.value = null
  }

  function markAuthResolutionError(cause: unknown) {
    authError.value = getErrorMessage(cause, '无法确认登录状态，请稍后重试')
    // 已认证快照仍是最后一份可信结果；临时网络错误不等于会话结束。
    if (status.value !== 'authenticated' || !user.value) {
      user.value = null
      status.value = 'unknown'
    }
  }

  function markSessionUnknown() {
    user.value = null
    status.value = 'unknown'
    authError.value = null
  }

  function isDefinitiveClientRejection(cause: unknown) {
    const responseStatus = getErrorStatus(cause)
    return responseStatus !== null && responseStatus >= 400 && responseStatus < 500
  }

  async function fetchCurrentUser(force = false) {
    if (status.value === 'authenticated' && !authError.value && !force) {
      console.debug('[auth] fetchCurrentUser skip (already authenticated)')
      return user.value
    }
    // 强制刷新用于绑定/资料变更后的重新读取。它必须开启新世代，而不是加入
    // 变更前已经在途的 /auth/me，否则“刷新”仍可能返回旧摘要。
    if (force) supersedeCurrentEpoch()
    const existing = runtime.fetchInflight
    if (existing && existing.epoch === runtime.epoch) {
      console.debug('[auth] fetchCurrentUser dedup (already in-flight)')
      return existing.promise
    }
    const requestEpoch = runtime.epoch
    authError.value = null
    beginRequest(requestEpoch)

    const requestPromise = (async () => {
      try {
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
        if (!isCurrent(requestEpoch)) {
          console.debug('[auth] fetchCurrentUser ignored (superseded)')
          return user.value
        }
        if (res && res.ok && res.user) {
          user.value = normalizeUser(res.user, user.value)
          status.value = 'authenticated'
          authError.value = null
          console.debug('[auth] fetchCurrentUser success', {
            id: user.value.id,
            linkedWikidotId: user.value.linkedWikidotId
          })
        } else {
          console.warn('[auth] fetchCurrentUser unexpected response', res)
          markAuthResolutionError(new Error(res?.error || '认证服务返回了无效响应'))
        }
      } catch (cause: unknown) {
        if (!isCurrent(requestEpoch)) {
          console.debug('[auth] fetchCurrentUser error ignored (superseded)')
          return user.value
        }
        if (getErrorStatus(cause) === 401) {
          markUnauthenticated()
          console.debug('[auth] fetchCurrentUser 401 (unauthenticated)')
        } else {
          console.warn('[auth] failed to fetch current user:', cause)
          markAuthResolutionError(cause)
        }
      } finally {
        endRequest(requestEpoch)
        if (runtime.fetchInflight?.epoch === requestEpoch) {
          runtime.fetchInflight = null
        }
      }
      return user.value
    })()
    runtime.fetchInflight = { epoch: requestEpoch, promise: requestPromise }
    return requestPromise
  }

  async function login(email: string, password: string) {
    const mutationEpoch = beginIdentityMutation()
    const hadAuthenticatedSnapshot = status.value === 'authenticated' && Boolean(user.value)
    const requestedEmail = email.trim().toLowerCase()
    try {
      const res = await $bff<ApiResponse<AuthUser>>('/auth/login', {
        method: 'POST',
        body: { email, password }
      })
      if (res && res.ok && res.user) {
        if (!isCurrent(mutationEpoch)) {
          return { ok: false as const, error: '登录请求已被后续账号操作取代' }
        }
        user.value = normalizeUser(res.user, user.value)
        status.value = 'authenticated'
        authError.value = null
        return { ok: true as const }
      }
      const message = res?.error || '登录失败'
      if (isCurrent(mutationEpoch) && !hadAuthenticatedSnapshot) {
        markUnauthenticated()
      }
      return { ok: false as const, error: message }
    } catch (cause: unknown) {
      const message = getErrorMessage(cause, '登录失败')
      if (!isCurrent(mutationEpoch)) {
        return { ok: false as const, error: '登录请求已被后续账号操作取代' }
      }

      if (isDefinitiveClientRejection(cause)) {
        if (!hadAuthenticatedSnapshot) markUnauthenticated()
        return { ok: false as const, error: message }
      }

      // 服务端可能已经 Set-Cookie 后才发生网络/解析失败。此时继续显示旧账号 A，
      // 后续请求却携带账号 B 的 cookie，会形成跨账号身份错配。清掉旧快照，再用
      // 一次不可复用旧 inflight 的 /auth/me 确认真实会话。
      markSessionUnknown()
      await fetchCurrentUser(true)
      if (
        status.value === 'authenticated'
        && user.value?.email.trim().toLowerCase() === requestedEmail
      ) {
        return { ok: true as const }
      }
      return {
        ok: false as const,
        error: status.value === 'unknown'
          ? '登录结果暂时无法确认，请检查网络后重试。'
          : message
      }
    } finally {
      endRequest(mutationEpoch)
    }
  }

  async function logout() {
    const mutationEpoch = beginIdentityMutation()
    try {
      const res = await $bff<{ ok?: boolean; error?: string }>('/auth/logout', { method: 'POST' })
      if (!isCurrent(mutationEpoch)) {
        return { ok: false as const, error: '退出请求已被后续账号操作取代' }
      }
      if (!res?.ok) {
        return { ok: false as const, error: res?.error || '退出失败，请稍后重试。' }
      }
      markUnauthenticated()
      return { ok: true as const }
    } catch (cause: unknown) {
      console.warn('[auth] logout failed', cause)
      if (!isCurrent(mutationEpoch)) {
        return { ok: false as const, error: '退出请求已被后续账号操作取代' }
      }

      const message = getErrorMessage(cause, '退出失败，请稍后重试。')
      if (getErrorStatus(cause) === 401) {
        markUnauthenticated()
        return { ok: true as const }
      }
      if (isDefinitiveClientRejection(cause)) {
        return { ok: false as const, error: message }
      }

      // 网络失败可能发生在服务端已经清 Cookie 之后，也可能发生在请求到达之前。
      // 登出不会把会话切换到另一个账号，因此可在重查期间保留当前可信快照，
      // 避免账号页面卸载后吞掉“退出失败”的可重试提示。
      await fetchCurrentUser(true)
      if (status.value === 'unauthenticated') {
        return { ok: true as const }
      }
      return {
        ok: false as const,
        error: status.value === 'authenticated' && !authError.value
          ? '退出未完成，你仍处于登录状态，请重试。'
          : '无法确认是否已退出，请恢复网络后重试。'
      }
    } finally {
      endRequest(mutationEpoch)
    }
  }

  async function updateProfile(payload: { displayName: string }) {
    const trimmed = payload.displayName?.trim()
    if (!trimmed) {
      return { ok: false as const, error: '昵称不能为空' }
    }
    const mutationEpoch = beginIdentityMutation()
    try {
      const res = await $bff<ApiResponse<AuthUser>>('/auth/profile', {
        method: 'PATCH',
        body: { displayName: trimmed }
      })
      if (res && res.ok && res.user) {
        if (!isCurrent(mutationEpoch)) {
          return { ok: false as const, error: '资料更新已被后续账号操作取代' }
        }
        user.value = normalizeUser(res.user, user.value)
        status.value = 'authenticated'
        authError.value = null
        return { ok: true as const }
      }
      return { ok: false as const, error: res?.error || '更新失败' }
    } catch (cause: unknown) {
      if (!isCurrent(mutationEpoch)) {
        return { ok: false as const, error: '资料更新已被后续账号操作取代' }
      }
      if (getErrorStatus(cause) === 401) {
        markUnauthenticated()
      } else if (!isDefinitiveClientRejection(cause)) {
        // 更新可能已落库但响应丢失；重新读取同一账号可避免展示旧昵称。
        await fetchCurrentUser(true)
        if (status.value === 'authenticated' && user.value?.displayName === trimmed) {
          return { ok: true as const }
        }
      }
      const message = getErrorMessage(cause, '更新失败')
      return { ok: false as const, error: message }
    } finally {
      endRequest(mutationEpoch)
    }
  }

  async function changePassword(payload: { currentPassword: string; newPassword: string }) {
    const mutationEpoch = beginIdentityMutation()
    try {
      const res = await $bff<{ ok?: boolean; error?: string }>('/auth/password', {
        method: 'PATCH',
        body: payload
      })
      if (!isCurrent(mutationEpoch)) {
        return { ok: false as const, error: '密码修改已被后续账号操作取代' }
      }
      if (!res?.ok) {
        return { ok: false as const, error: res?.error || '修改密码失败' }
      }
      markUnauthenticated()
      return { ok: true as const }
    } catch (cause: unknown) {
      if (!isCurrent(mutationEpoch)) {
        return { ok: false as const, error: '密码修改已被后续账号操作取代' }
      }
      if (getErrorStatus(cause) === 401) {
        markUnauthenticated()
      } else if (!isDefinitiveClientRejection(cause)) {
        // 服务端可能已修改密码并清 Cookie，但响应在途中丢失。重新解析会话，
        // 不在未确认时宣称“密码已修改”。
        markSessionUnknown()
        await fetchCurrentUser(true)
        if (status.value === 'unauthenticated') {
          return {
            ok: false as const,
            error: '无法确认密码修改结果；当前登录已失效，请尝试使用新密码重新登录。'
          }
        }
      }
      const message = getErrorMessage(cause, '修改密码失败')
      return { ok: false as const, error: message }
    } finally {
      endRequest(mutationEpoch)
    }
  }

  const isAuthenticated = computed(() => status.value === 'authenticated' && !!user.value)
  const state = computed<AuthState>(() => {
    // 强制刷新失败时，最后一份可信用户快照仍可继续使用；error 可用于非阻断提示。
    if (isAuthenticated.value) return 'ready'
    if (authError.value) return 'error'
    if (loading.value || status.value === 'unknown') return 'loading'
    return 'unauthenticated'
  })

  return {
    user,
    status,
    state,
    loading,
    error: authError,
    authError,
    isAuthenticated,
    fetchCurrentUser,
    login,
    logout,
    updateProfile,
    changePassword
  }
}
