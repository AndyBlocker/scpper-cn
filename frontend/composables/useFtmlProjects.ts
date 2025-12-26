/**
 * useFtmlProjects - FTML Projects API composable
 *
 * Provides methods to interact with the FTML projects backend API.
 */

import { ref } from 'vue'

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

export function useFtmlProjects() {
  const config = useRuntimeConfig()
  const bffBase = config.public.bffBase || '/api'

  const isLoading = ref(false)
  const error = ref<string | null>(null)

  async function fetchApi<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
    try {
      const response = await fetch(`${bffBase}${path}`, {
        ...options,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers
        }
      })

      const json = await response.json()

      if (!response.ok) {
        return { ok: false, error: json.error || json.message || '请求失败' }
      }

      return { ok: true, data: json }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : '网络错误' }
    }
  }

  async function listProjects(includeArchived = false): Promise<FtmlProjectMeta[]> {
    isLoading.value = true
    error.value = null

    const result = await fetchApi<{ projects: FtmlProjectMeta[] }>(
      `/ftml-projects${includeArchived ? '?archived=true' : ''}`
    )

    isLoading.value = false

    if (!result.ok) {
      error.value = result.error
      return []
    }

    return result.data.projects
  }

  async function getProject(id: string): Promise<FtmlProject | null> {
    isLoading.value = true
    error.value = null

    const result = await fetchApi<{ project: FtmlProject }>(`/ftml-projects/${id}`)

    isLoading.value = false

    if (!result.ok) {
      error.value = result.error
      return null
    }

    return result.data.project
  }

  async function createProject(data: {
    title?: string
    source?: string
    pageTitle?: string
    pageTags?: string[]
    settings?: FtmlProjectSettings
  } = {}): Promise<FtmlProject | null> {
    isLoading.value = true
    error.value = null

    const result = await fetchApi<{ project: FtmlProject }>('/ftml-projects', {
      method: 'POST',
      body: JSON.stringify(data)
    })

    isLoading.value = false

    if (!result.ok) {
      error.value = result.error
      return null
    }

    return result.data.project
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
    isLoading.value = true
    error.value = null

    const result = await fetchApi<{ project: FtmlProject }>(`/ftml-projects/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data)
    })

    isLoading.value = false

    if (!result.ok) {
      error.value = result.error
      return null
    }

    return result.data.project
  }

  async function deleteProject(id: string): Promise<boolean> {
    isLoading.value = true
    error.value = null

    const result = await fetchApi<{ ok: true }>(`/ftml-projects/${id}`, {
      method: 'DELETE'
    })

    isLoading.value = false

    if (!result.ok) {
      error.value = result.error
      return false
    }

    return true
  }

  async function duplicateProject(id: string): Promise<FtmlProject | null> {
    isLoading.value = true
    error.value = null

    const result = await fetchApi<{ project: FtmlProject }>(`/ftml-projects/${id}/duplicate`, {
      method: 'POST'
    })

    isLoading.value = false

    if (!result.ok) {
      error.value = result.error
      return null
    }

    return result.data.project
  }

  return {
    isLoading,
    error,
    listProjects,
    getProject,
    createProject,
    updateProject,
    deleteProject,
    duplicateProject
  }
}
