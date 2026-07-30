/**
 * useFtmlProjects - FTML Projects API composable
 *
 * Provides methods to interact with the FTML projects backend API.
 */

import type { FetchOptions } from 'ofetch'
import { readonly, ref, watch } from 'vue'
import { useAuth } from '~/composables/useAuth'
import { getErrorMessage } from '~/utils/httpError'

export interface FtmlProjectMeta {
  id: string
  title: string
  pageTitle: string | null
  pageTags: string[]
  isArchived: boolean
  createdAt: string
  updatedAt: string
}

export interface FtmlProject extends FtmlProjectMeta {
  source: string
  settings: Record<string, unknown> | null
}

export interface FtmlProjectSettings {
  mode?: string
  layout?: string
  includeMode?: string
  uiLayout?: string
  previewDevice?: string
}

export interface FtmlIdentityToken {
  ownerId: string | null
  epoch: number
}

export function useFtmlProjects() {
  const { $bff } = useNuxtApp()
  const { user: authUser, status: authStatus } = useAuth()

  const isLoading = ref(false)
  const error = ref<string | null>(null)
  const identityOwnerId = ref<string | null>(currentOwnerId())
  const identityEpoch = ref(0)
  const activeRequestsByEpoch = new Map<number, number>()

  function currentOwnerId(): string | null {
    if (authStatus.value !== 'authenticated') return null
    const id = authUser.value?.id?.trim()
    return id || null
  }

  /**
   * FTML 项目都是账号私有数据。身份变化时同步开启新世代并撤销旧请求对
   * loading/error 的所有权；旧网络请求可以自然结束，但不能再影响新账号 UI。
   */
  function synchronizeIdentity() {
    const ownerId = currentOwnerId()
    if (identityOwnerId.value === ownerId) return

    identityOwnerId.value = ownerId
    identityEpoch.value += 1
    activeRequestsByEpoch.clear()
    isLoading.value = false
    error.value = null
  }

  function captureIdentity(): FtmlIdentityToken {
    // watch 在 Vue 调度前也可能被命令式调用抢先一步，入口再同步一次可封住窗口。
    synchronizeIdentity()
    return {
      ownerId: identityOwnerId.value,
      epoch: identityEpoch.value
    }
  }

  function isIdentityCurrent(token: FtmlIdentityToken): boolean {
    synchronizeIdentity()
    return token.epoch === identityEpoch.value
      && token.ownerId === identityOwnerId.value
      && token.ownerId === currentOwnerId()
  }

  function beginRequest(): FtmlIdentityToken {
    const token = captureIdentity()
    activeRequestsByEpoch.set(
      token.epoch,
      (activeRequestsByEpoch.get(token.epoch) ?? 0) + 1
    )
    if (isIdentityCurrent(token)) {
      isLoading.value = true
      error.value = null
    }
    return token
  }

  function endRequest(token: FtmlIdentityToken) {
    const remaining = Math.max(
      0,
      (activeRequestsByEpoch.get(token.epoch) ?? 0) - 1
    )
    if (remaining > 0) {
      activeRequestsByEpoch.set(token.epoch, remaining)
    } else {
      activeRequestsByEpoch.delete(token.epoch)
    }
    if (isIdentityCurrent(token)) {
      isLoading.value = (activeRequestsByEpoch.get(token.epoch) ?? 0) > 0
    }
  }

  function setRequestError(token: FtmlIdentityToken, message: string) {
    if (isIdentityCurrent(token)) {
      error.value = message
    }
  }

  watch(
    () => currentOwnerId(),
    () => synchronizeIdentity(),
    { flush: 'sync' }
  )

  async function fetchApi<T>(
    path: string,
    options: FetchOptions<'json'> = {}
  ): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    try {
      const json = await $bff<T>(path, options)
      return { ok: true, data: json }
    } catch (cause: unknown) {
      return { ok: false, error: getErrorMessage(cause, '网络错误') }
    }
  }

  async function listProjects(includeArchived = false): Promise<FtmlProjectMeta[]> {
    const token = beginRequest()
    try {
      const result = await fetchApi<{ projects: FtmlProjectMeta[] }>(
        `/ftml-projects${includeArchived ? '?archived=true' : ''}`
      )

      if (!isIdentityCurrent(token)) return []
      if (!result.ok) {
        setRequestError(token, result.error)
        return []
      }

      return result.data.projects
    } finally {
      endRequest(token)
    }
  }

  async function getProject(id: string): Promise<FtmlProject | null> {
    const token = beginRequest()
    try {
      const result = await fetchApi<{ project: FtmlProject }>(`/ftml-projects/${id}`)

      if (!isIdentityCurrent(token)) return null
      if (!result.ok) {
        setRequestError(token, result.error)
        return null
      }

      return result.data.project
    } finally {
      endRequest(token)
    }
  }

  async function createProject(data: {
    title?: string
    source?: string
    pageTitle?: string
    pageTags?: string[]
    settings?: FtmlProjectSettings
  } = {}): Promise<FtmlProject | null> {
    const token = beginRequest()
    try {
      const result = await fetchApi<{ project: FtmlProject }>('/ftml-projects', {
        method: 'POST',
        body: data
      })

      if (!isIdentityCurrent(token)) return null
      if (!result.ok) {
        setRequestError(token, result.error)
        return null
      }

      return result.data.project
    } finally {
      endRequest(token)
    }
  }

  async function updateProject(
    id: string,
    data: {
      title?: string
      source?: string
      pageTitle?: string | null
      pageTags?: string[]
      settings?: FtmlProjectSettings | null
      isArchived?: boolean
    }
  ): Promise<FtmlProject | null> {
    const token = beginRequest()
    try {
      const result = await fetchApi<{ project: FtmlProject }>(`/ftml-projects/${id}`, {
        method: 'PATCH',
        body: data
      })

      if (!isIdentityCurrent(token)) return null
      if (!result.ok) {
        setRequestError(token, result.error)
        return null
      }

      return result.data.project
    } finally {
      endRequest(token)
    }
  }

  async function deleteProject(id: string): Promise<boolean> {
    const token = beginRequest()
    try {
      const result = await fetchApi<{ ok: true }>(`/ftml-projects/${id}`, {
        method: 'DELETE'
      })

      if (!isIdentityCurrent(token)) return false
      if (!result.ok) {
        setRequestError(token, result.error)
        return false
      }

      return true
    } finally {
      endRequest(token)
    }
  }

  async function duplicateProject(id: string): Promise<FtmlProject | null> {
    const token = beginRequest()
    try {
      const result = await fetchApi<{ project: FtmlProject }>(`/ftml-projects/${id}/duplicate`, {
        method: 'POST'
      })

      if (!isIdentityCurrent(token)) return null
      if (!result.ok) {
        setRequestError(token, result.error)
        return null
      }

      return result.data.project
    } finally {
      endRequest(token)
    }
  }

  return {
    isLoading,
    error,
    identityOwnerId: readonly(identityOwnerId),
    identityEpoch: readonly(identityEpoch),
    captureIdentity,
    isIdentityCurrent,
    listProjects,
    getProject,
    createProject,
    updateProject,
    deleteProject,
    duplicateProject
  }
}
