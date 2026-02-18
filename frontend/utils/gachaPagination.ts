/**
 * Parallel paginated loader for gacha inventory and similar endpoints.
 *
 * Strategy: fetch page 1 (with total), then remaining pages in parallel (skipTotal).
 * This turns N sequential roundtrips into 1 + 1 parallel batch.
 */

export interface PaginatedFetchResult<T> {
  items: T[]
  total: number
  pageRows: number
}

export interface PaginatedLoadOptions<T> {
  /** Fetch a single page. Return items, total (-1 if skipped), and pageRows (pre-expansion row count). */
  fetchPage: (offset: number, limit: number, skipTotal: boolean) => Promise<PaginatedFetchResult<T>>
  /** Items per page. Should match backend limit. */
  pageSize: number
  /** Max total pages to prevent runaway loops. Default 100. */
  maxPages?: number
  /** Max parallel requests in a single batch. Default 3. */
  maxParallel?: number
}

export async function paginatedLoadAll<T>(options: PaginatedLoadOptions<T>): Promise<T[]> {
  const { fetchPage, pageSize, maxPages = 100, maxParallel = 3 } = options

  // Phase 1: fetch first page with total
  const first = await fetchPage(0, pageSize, false)
  const allItems: T[] = [...first.items]

  const firstPageRows = Math.max(0, Math.floor(Number(first.pageRows ?? 0)))
  if (firstPageRows <= 0 || firstPageRows < pageSize) {
    // Only one page of data (or empty)
    return allItems
  }

  const total = Math.max(0, Math.floor(Number(first.total ?? 0)))
  if (total > 0 && firstPageRows >= total) {
    return allItems
  }

  // Phase 2: calculate remaining pages and fetch in parallel
  const remainingRows = total > 0 ? total - firstPageRows : Infinity
  const remainingPages = total > 0
    ? Math.min(Math.ceil(remainingRows / pageSize), maxPages - 1)
    : maxPages - 1

  if (remainingPages <= 0) return allItems

  // Batch parallel fetches to avoid overwhelming the server
  for (let batchStart = 0; batchStart < remainingPages; batchStart += maxParallel) {
    const batchSize = Math.min(maxParallel, remainingPages - batchStart)
    const promises = Array.from({ length: batchSize }, (_, i) => {
      const pageIndex = batchStart + i + 1 // +1 because page 0 is already fetched
      const offset = pageIndex * pageSize
      return fetchPage(offset, pageSize, true)
    })

    const results = await Promise.all(promises)

    let stopEarly = false
    for (const result of results) {
      allItems.push(...result.items)
      const pr = Math.max(0, Math.floor(Number(result.pageRows ?? 0)))
      if (pr <= 0 || pr < pageSize) {
        stopEarly = true
        break
      }
    }

    if (stopEarly) break
  }

  return allItems
}
