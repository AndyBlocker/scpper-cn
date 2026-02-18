export interface SearchAuthorEntry {
  name?: string | null
  wikidotId?: number | null
}

function normalizeAuthorNameKey(raw: string) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
}

function appendAuthorNames(
  target: string[],
  dedupe: Set<string>,
  authors: SearchAuthorEntry[] | null | undefined
) {
  for (const entry of authors ?? []) {
    const name = String(entry?.name || '').trim()
    if (!name) continue
    const id = Number(entry?.wikidotId)
    const key = Number.isFinite(id) && id > 0
      ? `id:${Math.floor(id)}`
      : `name:${normalizeAuthorNameKey(name)}`
    if (dedupe.has(key)) continue
    dedupe.add(key)
    target.push(name)
  }
}

export function resolveAuthorSearchText(
  explicitAuthors: SearchAuthorEntry[] | null | undefined,
  cachedAuthors?: SearchAuthorEntry[] | null | undefined
) {
  const names: string[] = []
  const dedupe = new Set<string>()
  appendAuthorNames(names, dedupe, explicitAuthors)
  appendAuthorNames(names, dedupe, cachedAuthors)
  return names.join(' ')
}
