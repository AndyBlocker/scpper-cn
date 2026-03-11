export function useForumsApi() {
  const { $bff } = useNuxtApp()

  async function getCategories() {
    return $bff<any[]>('/forums/categories')
  }

  async function getThreads(categoryId: number, page = 1, limit = 20) {
    return $bff<{
      category: { id: number; title: string; description: string | null }
      threads: any[]
      total: number
      page: number
      limit: number
    }>(`/forums/categories/${categoryId}/threads`, {
      params: { page, limit },
    })
  }

  async function getThread(threadId: number, page = 1, limit = 50, order: 'asc' | 'desc' = 'asc') {
    return $bff<{
      thread: {
        id: number
        title: string
        description: string | null
        createdByName: string | null
        createdByWikidotId: number | null
        createdAt: string | null
        postCount: number
        categoryId: number
        pageId: number | null
        pageWikidotId: number | null
        categoryTitle: string | null
        sourceThreadUrl: string | null
      }
      posts: Array<{
        id: number
        parentId: number | null
        title: string | null
        textHtml: string | null
        createdByName: string | null
        createdByWikidotId: number | null
        createdByType: string | null
        createdAt: string | null
        editedAt: string | null
        isDeleted: boolean
        sourceThreadUrl: string | null
        sourcePostUrl: string | null
      }>
      total: number
      page: number
      limit: number
    }>(`/forums/threads/${threadId}`, { params: { page, limit, order } })
  }

  async function getPageDiscussion(wikidotId: number) {
    return $bff<{
      threads: Array<{
        id: number
        title: string
        createdByName: string | null
        createdByWikidotId: number | null
        createdAt: string | null
        postCount: number
        categoryId: number
        categoryTitle: string | null
        sourceThreadUrl: string | null
      }>
    }>(`/forums/pages/${wikidotId}/discussion`)
  }

  async function getForumStats() {
    return $bff<{
      categoriesCount: number
      threadsCount: number
      postsCount: number
      lastPostAt: string | null
      topPosters: Array<{ name: string; wikidotId: number; postCount: number }>
    }>('/forums/stats')
  }

  async function getRecentThreads(limit = 20) {
    return $bff<any[]>('/forums/recent', { params: { limit } })
  }

  async function searchPosts(q: string, page = 1, limit = 20) {
    return $bff<{
      posts: any[]
      total: number
      page: number
      limit: number
    }>('/forums/search', { params: { q, page, limit } })
  }

  async function locatePost(postId: number, order: 'asc' | 'desc' = 'desc', limit = 50) {
    return $bff<{ threadId: number; postId: number; page: number }>(
      `/forums/posts/${postId}/locate`,
      { params: { order, limit } },
    )
  }

  async function getRecentPosts(page = 1, limit = 20) {
    return $bff<{
      posts: Array<{
        id: number
        title: string | null
        textHtml: string | null
        createdByName: string | null
        createdByWikidotId: number | null
        createdByType: string | null
        createdAt: string | null
        threadId: number
        threadTitle: string
        categoryId: number
        categoryTitle: string | null
        sourceThreadUrl: string | null
        sourcePostUrl: string | null
      }>
      total: number
      page: number
      limit: number
    }>('/forums/recent-posts', { params: { page, limit } })
  }

  return {
    getCategories,
    getThreads,
    getThread,
    getPageDiscussion,
    getForumStats,
    getRecentThreads,
    searchPosts,
    locatePost,
    getRecentPosts,
  }
}
