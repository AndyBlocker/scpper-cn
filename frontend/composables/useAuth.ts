import { useNuxtApp } from 'nuxt/app'
import { computed } from 'vue'
import { getErrorMessage, getErrorStatus } from '~/utils/httpError'
import { registerExpectedUserMismatchRecovery } from '~/utils/expectedUser'

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
  activeIdentityMutationEpoch: number | null
  activeIdentityMutationVerificationEpoch: number | null
  pendingIdentitySessionValidation: boolean
  pendingPassiveSessionValidation: boolean
  fetchInflight: AuthFetchInflight | null
  sessionRevalidation: Promise<AuthUser | null> | null
  sessionRevalidationInvalidatesSnapshot: boolean
  sessionValidationGeneration: number
  sessionSyncListenersInstalled: boolean
  sourceId: string
  lastForegroundValidationAt: number
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
    activeIdentityMutationEpoch: null,
    activeIdentityMutationVerificationEpoch: null,
    pendingIdentitySessionValidation: false,
    pendingPassiveSessionValidation: false,
    fetchInflight: null,
    sessionRevalidation: null,
    sessionRevalidationInvalidatesSnapshot: false,
    sessionValidationGeneration: 0,
    sessionSyncListenersInstalled: false,
    sourceId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    lastForegroundValidationAt: 0
  }
  authRuntimes.set(nuxtApp, runtime)
  return runtime
}

function useAuthState() {
  const user = useState<AuthUser | null>('auth-user', () => null)
  const status = useState<AuthStatus>('auth-status', () => 'unknown')
  const loading = useState<boolean>('auth-loading', () => false)
  const error = useState<string | null>('auth-error', () => null)
  const sessionVerifying = useState<boolean>('auth-session-verifying', () => false)
  return { user, status, loading, error, sessionVerifying }
}

const AUTH_SYNC_STORAGE_KEY = 'scpper:auth-session-version'
const FOREGROUND_VALIDATION_DEBOUNCE_MS = 1_000

function authDebug(...args: unknown[]) {
  if (import.meta.dev) console.debug(...args)
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

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function parseQqBinding(payload: unknown): ParseResult<AuthUser['qqBinding']> {
  if (!isRecord(payload)) {
    return { ok: false, reason: 'qqBinding 不是对象' }
  }
  if (typeof payload.bound !== 'boolean') {
    return { ok: false, reason: 'qqBinding.bound 不是布尔值' }
  }
  if (!isNullableString(payload.addressMask)) {
    return { ok: false, reason: 'qqBinding.addressMask 不是字符串或 null' }
  }
  if (!isNullableString(payload.status)) {
    return { ok: false, reason: 'qqBinding.status 不是字符串或 null' }
  }
  if (
    payload.pendingChallenge !== undefined
    && typeof payload.pendingChallenge !== 'boolean'
  ) {
    return { ok: false, reason: 'qqBinding.pendingChallenge 不是布尔值' }
  }

  const bound = payload.bound
  const pendingChallenge = payload.pendingChallenge ?? false
  if (payload.capabilities === undefined) {
    // 兼容旧版 user-backend 的 QQ 摘要。旧响应没有能力声明，因此一律禁止
    // 新建和投递；已有绑定仍允许管理，避免暂停期间失去解绑入口。
    return {
      ok: true,
      value: {
        bound,
        addressMask: payload.addressMask,
        status: payload.status,
        pendingChallenge,
        capabilities: {
          featureEnabled: false,
          createBinding: false,
          deliverNotifications: false,
          manageExistingBinding: bound || pendingChallenge
        }
      }
    }
  }

  const capabilities = payload.capabilities
  if (
    !isRecord(capabilities)
    || typeof capabilities.featureEnabled !== 'boolean'
    || typeof capabilities.createBinding !== 'boolean'
    || typeof capabilities.deliverNotifications !== 'boolean'
    || typeof capabilities.manageExistingBinding !== 'boolean'
  ) {
    return { ok: false, reason: 'qqBinding.capabilities 形状无效' }
  }

  return {
    ok: true,
    value: {
      bound,
      addressMask: payload.addressMask,
      status: payload.status,
      pendingChallenge,
      capabilities: {
        featureEnabled: capabilities.featureEnabled,
        createBinding: capabilities.createBinding,
        deliverNotifications: capabilities.deliverNotifications,
        manageExistingBinding: capabilities.manageExistingBinding
      }
    }
  }
}

function parseAuthUser(
  payload: unknown,
  previous?: AuthUser | null
): ParseResult<AuthUser> {
  if (!isRecord(payload)) {
    return { ok: false, reason: 'user 不是对象' }
  }
  if (typeof payload.id !== 'string' || !payload.id.trim()) {
    return { ok: false, reason: 'user.id 不是非空字符串' }
  }
  if (typeof payload.email !== 'string' || !payload.email.trim()) {
    return { ok: false, reason: 'user.email 不是非空字符串' }
  }
  if (!isNullableString(payload.displayName)) {
    return { ok: false, reason: 'user.displayName 不是字符串或 null' }
  }
  if (
    payload.linkedWikidotId !== null
    && (
      typeof payload.linkedWikidotId !== 'number'
      || !Number.isSafeInteger(payload.linkedWikidotId)
    )
  ) {
    return { ok: false, reason: 'user.linkedWikidotId 不是安全整数或 null' }
  }
  if (!isNullableString(payload.lastLoginAt)) {
    return { ok: false, reason: 'user.lastLoginAt 不是字符串或 null' }
  }

  const id = payload.id.trim()
  // 只有当这份 payload 说的还是**同一个账号**时，才允许沿用上一份 qqBinding 快照。
  // 否则 A 已登录时直接 login 到 B，B 的 payload 不含 qqBinding，
  // 就会把 A 的掩码 QQ 号和绑定状态复制到 B 的界面上 —— 跨账号信息泄露，
  // 且要等下一次强制 /auth/me 才会被纠正。
  const sameAccount = Boolean(previous?.id) && previous?.id === id

  let qqBinding: AuthUser['qqBinding']
  if (!Object.prototype.hasOwnProperty.call(payload, 'qqBinding')) {
    // 新版接口都会返回 qqBinding；字段完全缺失只用于和旧服务滚动升级兼容。
    // 同一账号才允许沿用快照，不能把 A 的掩码 QQ 摘要复制到随后登录的 B。
    qqBinding = sameAccount
      ? (previous?.qqBinding ?? EMPTY_QQ_BINDING)
      : EMPTY_QQ_BINDING
  } else {
    const parsedQqBinding = parseQqBinding(payload.qqBinding)
    if (!parsedQqBinding.ok) return parsedQqBinding
    qqBinding = parsedQqBinding.value
  }

  return {
    ok: true,
    value: {
      id,
      email: payload.email.trim(),
      displayName: payload.displayName,
      linkedWikidotId: payload.linkedWikidotId,
      lastLoginAt: payload.lastLoginAt,
      qqBinding
    }
  }
}

export function useAuth() {
  const nuxtApp = useNuxtApp()
  const { $bff } = nuxtApp
  const {
    user,
    status,
    loading,
    error: authError,
    sessionVerifying
  } = useAuthState()
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
   *
   * mutation 的优先级高于普通 focus/pageshow 验证：它开始时会同步撤销旧验证的
   * UI 所有权，避免已经被新世代忽略的慢 GET 继续让账号页保持 inert。
   */
  function beginIdentityMutation() {
    if (runtime.sessionRevalidation) {
      // 当前被接管的验证不会再拥有 UI。显式账号变更通知必须在 mutation
      // 结束后强制重读 Cookie；普通前台恢复检查则可降级为被动补验。
      if (runtime.sessionRevalidationInvalidatesSnapshot) {
        runtime.pendingIdentitySessionValidation = true
      } else {
        runtime.pendingPassiveSessionValidation = true
      }
    }
    runtime.sessionValidationGeneration += 1
    runtime.sessionRevalidation = null
    runtime.sessionRevalidationInvalidatesSnapshot = false
    sessionVerifying.value = false

    const epoch = supersedeCurrentEpoch()
    runtime.activeIdentityMutationEpoch = epoch
    runtime.activeIdentityMutationVerificationEpoch = null
    authError.value = null
    beginRequest(epoch)
    return epoch
  }

  function endIdentityMutation(epoch: number) {
    const ownsCurrentEpoch = runtime.activeIdentityMutationEpoch === epoch
      && (
        runtime.epoch === epoch
        || runtime.activeIdentityMutationVerificationEpoch === runtime.epoch
      )
    const wasSuperseded = !ownsCurrentEpoch
    endRequest(epoch)

    // 被跨标签通知或任何强制 /auth/me 读取抢占的 mutation 仍可能在响应阶段
    // 改写 HttpOnly Cookie。它结束后必须再读一次最终 Cookie，不能仅丢弃 DTO。
    if (wasSuperseded) {
      runtime.pendingIdentitySessionValidation = true
    }

    if (runtime.activeIdentityMutationEpoch === epoch) {
      runtime.activeIdentityMutationEpoch = null
      runtime.activeIdentityMutationVerificationEpoch = null
    }

    // 若另一个 mutation 已经接管，等待它结束再确认最终 Cookie；否则现在补验。
    if (runtime.activeIdentityMutationEpoch === null) {
      if (runtime.pendingIdentitySessionValidation) {
        runtime.pendingIdentitySessionValidation = false
        runtime.pendingPassiveSessionValidation = false
        void revalidateSession(true)
      } else if (runtime.pendingPassiveSessionValidation) {
        runtime.pendingPassiveSessionValidation = false
        void revalidateSession(false)
      }
    }
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

  async function fetchCurrentUser(force = false, identityMutationEpoch: number | null = null) {
    if (status.value === 'authenticated' && !authError.value && !force) {
      authDebug('[auth] fetchCurrentUser skip (already authenticated)')
      return user.value
    }
    // 强制刷新用于绑定/资料变更后的重新读取。它必须开启新世代，而不是加入
    // 变更前已经在途的 /auth/me，否则“刷新”仍可能返回旧摘要。
    if (force) {
      const mutationOwnsCurrentEpoch = identityMutationEpoch !== null
        && runtime.activeIdentityMutationEpoch === identityMutationEpoch
        && runtime.epoch === identityMutationEpoch
      const forcedEpoch = supersedeCurrentEpoch()
      // Mutation 内部用于确认不确定写入结果的 /auth/me 仍属于同一次操作。
      // 它可以开启新请求世代以避开旧 inflight，但不应被 endIdentityMutation
      // 误判成外部账号切换，否则会再次清空快照并卸载承载错误提示的表单。
      if (mutationOwnsCurrentEpoch) {
        runtime.activeIdentityMutationVerificationEpoch = forcedEpoch
      }
    }
    const existing = runtime.fetchInflight
    if (existing && existing.epoch === runtime.epoch) {
      authDebug('[auth] fetchCurrentUser dedup (already in-flight)')
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
        authDebug('[auth] fetchCurrentUser request', {
          force,
          status: status.value,
          params: requestOptions.params
        })
        const res = await $bff<ApiResponse<unknown>>('/auth/me', requestOptions)
        if (!isCurrent(requestEpoch)) {
          authDebug('[auth] fetchCurrentUser ignored (superseded)')
          return user.value
        }
        if (res?.ok === true) {
          const parsedUser = parseAuthUser(res.user, user.value)
          if (!parsedUser.ok) {
            console.warn('[auth] fetchCurrentUser received an invalid user payload')
            authDebug('[auth] invalid /auth/me user payload', parsedUser.reason)
            markAuthResolutionError(new Error('认证服务返回了无效的用户资料'))
            return user.value
          }
          user.value = parsedUser.value
          status.value = 'authenticated'
          authError.value = null
          authDebug('[auth] fetchCurrentUser success', {
            id: user.value.id,
            linkedWikidotId: user.value.linkedWikidotId
          })
        } else {
          console.warn('[auth] fetchCurrentUser received an unexpected response')
          markAuthResolutionError(new Error(res?.error || '认证服务返回了无效响应'))
        }
      } catch (cause: unknown) {
        if (!isCurrent(requestEpoch)) {
          authDebug('[auth] fetchCurrentUser error ignored (superseded)')
          return user.value
        }
        if (getErrorStatus(cause) === 401) {
          markUnauthenticated()
          authDebug('[auth] fetchCurrentUser 401 (unauthenticated)')
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

  /**
   * 重新验证浏览器当前 Cookie 对应的账号。
   *
   * 普通前台恢复会保留最后一次可信快照，但用 sessionVerifying 暂停账号页交互；
   * 收到其他标签页的身份变更通知时则立即清空快照，避免 A 的界面拿 B 的 Cookie
   * 发出写请求。新通知会开启新世代，旧验证响应无法覆盖最新身份。
   */
  async function revalidateSession(invalidateSnapshot = false) {
    if (!import.meta.client) return fetchCurrentUser(true)

    // focus/pageshow 是被动、可延后的安全网，不能打断用户已经发起的登录、退出、
    // 资料或密码写操作。mutation 自身会解析响应，并在结果不确定时强制读取
    // /auth/me，因此这里直接沿用当前可信快照即可。
    if (!invalidateSnapshot && runtime.activeIdentityMutationEpoch !== null) {
      authDebug('[auth] passive session validation skipped (identity mutation in-flight)')
      runtime.pendingPassiveSessionValidation = true
      return user.value
    }

    if (!invalidateSnapshot && runtime.sessionRevalidation) {
      return runtime.sessionRevalidation
    }

    // 来自其他标签页的显式身份变更通知仍然拥有最高安全优先级。它会让当前
    // mutation 的响应因 epoch 不匹配而失效，并接管会话验证。
    if (invalidateSnapshot) {
      runtime.activeIdentityMutationEpoch = null
      runtime.activeIdentityMutationVerificationEpoch = null
      runtime.pendingIdentitySessionValidation = false
      runtime.pendingPassiveSessionValidation = false
    }

    runtime.sessionValidationGeneration += 1
    const validationGeneration = runtime.sessionValidationGeneration
    if (invalidateSnapshot) markSessionUnknown()
    sessionVerifying.value = true

    const verification = fetchCurrentUser(true)
    runtime.sessionRevalidation = verification
    runtime.sessionRevalidationInvalidatesSnapshot = invalidateSnapshot
    try {
      return await verification
    } finally {
      if (runtime.sessionValidationGeneration === validationGeneration) {
        runtime.sessionRevalidation = null
        runtime.sessionRevalidationInvalidatesSnapshot = false
        sessionVerifying.value = false
      }
    }
  }

  function announceSessionChange(reason: 'login' | 'logout' | 'password' | 'profile') {
    if (!import.meta.client) return
    try {
      window.localStorage.setItem(AUTH_SYNC_STORAGE_KEY, JSON.stringify({
        sourceId: runtime.sourceId,
        reason,
        nonce: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
      }))
    } catch (cause) {
      // localStorage 可能被浏览器策略禁用；pageshow/focus 的强制验证仍是兜底。
      authDebug('[auth] unable to broadcast session change', cause)
    }
  }

  function installSessionSyncListeners() {
    if (!import.meta.client || runtime.sessionSyncListenersInstalled) return
    runtime.sessionSyncListenersInstalled = true

    const validateOnForeground = () => {
      if (document.hidden) return
      const now = Date.now()
      if (now - runtime.lastForegroundValidationAt < FOREGROUND_VALIDATION_DEBOUNCE_MS) {
        return
      }
      runtime.lastForegroundValidationAt = now
      void revalidateSession(false)
    }

    window.addEventListener('storage', (event) => {
      if (event.key !== AUTH_SYNC_STORAGE_KEY || !event.newValue) return
      try {
        const message = JSON.parse(event.newValue) as { sourceId?: string }
        if (message.sourceId === runtime.sourceId) return
      } catch {
        // 无法解析也按身份可能变化处理，安全失败方向是重新验证。
      }
      void revalidateSession(true)
    })
    window.addEventListener('pageshow', validateOnForeground)
    window.addEventListener('focus', validateOnForeground)
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) validateOnForeground()
    })
  }

  async function login(email: string, password: string) {
    const mutationEpoch = beginIdentityMutation()
    const hadAuthenticatedSnapshot = status.value === 'authenticated' && Boolean(user.value)
    const requestedEmail = email.trim().toLowerCase()
    try {
      const res = await $bff<ApiResponse<unknown>>('/auth/login', {
        method: 'POST',
        body: { email, password }
      })
      if (res?.ok === true) {
        if (!isCurrent(mutationEpoch)) {
          return { ok: false as const, error: '登录请求已被后续账号操作取代' }
        }
        const parsedUser = parseAuthUser(res.user, user.value)
        if (
          parsedUser.ok
          && parsedUser.value.email.trim().toLowerCase() === requestedEmail
        ) {
          user.value = parsedUser.value
          status.value = 'authenticated'
          authError.value = null
          announceSessionChange('login')
          return { ok: true as const }
        }

        // 登录接口可能已经写入账号 B 的 Cookie；畸形 DTO（或与请求邮箱不符的
        // DTO）绝不能覆盖可信快照，更不能继续让账号 A 的页面向账号 B 发写请求。
        // 清空可交互快照，再通过独立世代的 /auth/me 解析 Cookie 的真实身份。
        console.warn('[auth] login received an invalid user payload')
        if (!parsedUser.ok) {
          authDebug('[auth] invalid /auth/login user payload', parsedUser.reason)
        } else {
          authDebug('[auth] /auth/login user email did not match the requested account')
        }
        markSessionUnknown()
        await fetchCurrentUser(true, mutationEpoch)
        if (
          status.value === 'authenticated'
          && user.value?.email.trim().toLowerCase() === requestedEmail
        ) {
          announceSessionChange('login')
          return { ok: true as const }
        }
        return {
          ok: false as const,
          error: status.value === 'unknown'
            ? '登录结果暂时无法确认，请检查网络后重试。'
            : '登录结果与当前会话不一致，请重试。'
        }
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
      await fetchCurrentUser(true, mutationEpoch)
      if (
        status.value === 'authenticated'
        && user.value?.email.trim().toLowerCase() === requestedEmail
      ) {
        announceSessionChange('login')
        return { ok: true as const }
      }
      return {
        ok: false as const,
        error: status.value === 'unknown'
          ? '登录结果暂时无法确认，请检查网络后重试。'
          : message
      }
    } finally {
      endIdentityMutation(mutationEpoch)
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
      announceSessionChange('logout')
      return { ok: true as const }
    } catch (cause: unknown) {
      console.warn('[auth] logout failed', cause)
      if (!isCurrent(mutationEpoch)) {
        return { ok: false as const, error: '退出请求已被后续账号操作取代' }
      }

      const message = getErrorMessage(cause, '退出失败，请稍后重试。')
      if (getErrorStatus(cause) === 401) {
        markUnauthenticated()
        announceSessionChange('logout')
        return { ok: true as const }
      }
      if (isDefinitiveClientRejection(cause)) {
        return { ok: false as const, error: message }
      }

      // 网络失败可能发生在服务端已经清 Cookie 之后，也可能发生在请求到达之前。
      // 登出不会把会话切换到另一个账号，因此可在重查期间保留当前可信快照，
      // 避免账号页面卸载后吞掉“退出失败”的可重试提示。
      await fetchCurrentUser(true, mutationEpoch)
      if (status.value === 'unauthenticated') {
        announceSessionChange('logout')
        return { ok: true as const }
      }
      return {
        ok: false as const,
        error: status.value === 'authenticated' && !authError.value
          ? '退出未完成，你仍处于登录状态，请重试。'
          : '无法确认是否已退出，请恢复网络后重试。'
      }
    } finally {
      endIdentityMutation(mutationEpoch)
    }
  }

  async function updateProfile(payload: { displayName: string }) {
    const trimmed = payload.displayName?.trim()
    if (!trimmed) {
      return { ok: false as const, error: '昵称不能为空' }
    }
    const expectedUserId = user.value?.id ?? null
    const expectedEmail = user.value?.email.trim().toLowerCase() ?? null
    const mutationEpoch = beginIdentityMutation()
    try {
      const res = await $bff<ApiResponse<unknown>>('/auth/profile', {
        method: 'PATCH',
        body: { displayName: trimmed }
      })
      if (res?.ok === true) {
        if (!isCurrent(mutationEpoch)) {
          return { ok: false as const, error: '资料更新已被后续账号操作取代' }
        }
        const parsedUser = parseAuthUser(res.user, user.value)
        if (
          parsedUser.ok
          && (!expectedUserId || parsedUser.value.id === expectedUserId)
          && (
            !expectedEmail
            || parsedUser.value.email.trim().toLowerCase() === expectedEmail
          )
          && parsedUser.value.displayName === trimmed
        ) {
          user.value = parsedUser.value
          status.value = 'authenticated'
          authError.value = null
          announceSessionChange('profile')
          return { ok: true as const }
        }

        // profile 不应改变账号身份，返回的昵称也应是刚保存的值。畸形或语义
        // 不一致的 DTO 不写共享快照；保留最后一份可信用户，并强制读取服务端
        // 最终状态来判断更新是否实际落库。
        console.warn('[auth] updateProfile received an invalid user payload')
        if (!parsedUser.ok) {
          authDebug('[auth] invalid /auth/profile user payload', parsedUser.reason)
        } else {
          authDebug('[auth] /auth/profile returned an inconsistent user payload')
        }
        await fetchCurrentUser(true, mutationEpoch)
        if (
          status.value === 'authenticated'
          && !authError.value
          && user.value?.id === expectedUserId
          && user.value.email.trim().toLowerCase() === expectedEmail
          && user.value.displayName === trimmed
        ) {
          announceSessionChange('profile')
          return { ok: true as const }
        }
        return {
          ok: false as const,
          error: authError.value
            ? '资料更新结果暂时无法确认，请检查网络后重试。'
            : '资料更新未生效，请重试。'
        }
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
        await fetchCurrentUser(true, mutationEpoch)
        if (
          status.value === 'authenticated'
          && !authError.value
          && user.value?.id === expectedUserId
          && user.value.email.trim().toLowerCase() === expectedEmail
          && user.value.displayName === trimmed
        ) {
          announceSessionChange('profile')
          return { ok: true as const }
        }
      }
      const message = getErrorMessage(cause, '更新失败')
      return { ok: false as const, error: message }
    } finally {
      endIdentityMutation(mutationEpoch)
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
      announceSessionChange('password')
      return { ok: true as const }
    } catch (cause: unknown) {
      if (!isCurrent(mutationEpoch)) {
        return { ok: false as const, error: '密码修改已被后续账号操作取代' }
      }
      if (getErrorStatus(cause) === 401) {
        markUnauthenticated()
        announceSessionChange('password')
      } else if (!isDefinitiveClientRejection(cause)) {
        // 服务端可能已修改密码并清 Cookie，但响应在途中丢失。重新解析会话，
        // 不在未确认时宣称“密码已修改”。
        markSessionUnknown()
        await fetchCurrentUser(true, mutationEpoch)
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
      endIdentityMutation(mutationEpoch)
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

  registerExpectedUserMismatchRecovery(nuxtApp, () => revalidateSession(true))
  installSessionSyncListeners()

  return {
    user,
    status,
    state,
    loading,
    sessionVerifying,
    error: authError,
    authError,
    isAuthenticated,
    fetchCurrentUser,
    revalidateSession,
    login,
    logout,
    updateProfile,
    changePassword
  }
}
