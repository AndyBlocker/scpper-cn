// Sort page tags according to custom category rules
// Usage: import { orderTags } from '~/composables/useTagOrder'

export function orderTags(rawTags: string[] | null | undefined): string[] {
  const tags = Array.isArray(rawTags) ? [...rawTags] : []
  if (tags.length === 0) return []

  // Keep original case for output; use lowercased copy for matching
  const lowerMap = new Map<string, string>()
  for (const t of tags) lowerMap.set(t, toKey(t))

  // Fixed-order categories
  const langOrder = [
    '原创', 'int', 'ru', 'ko', 'fr', 'pl', 'es', 'th', 'jp', 'de', 'it', 'ua',
    'pt', 'cs', 'vn', 'cy', 'el', 'eo', 'et', 'he', 'hu', 'id', 'la',
    'nd-da', 'nd-fo', 'nd-no', 'nd-sv', 'nl', 'ro', 'sl', 'tr'
  ]
  const qualityOrder = ['精品', '主题精品']
  const contentOrder = ['scp', 'goif', 'wanderers', '故事', '文章', '中心页']
  const adultOrder = ['成人内容', '搞笑']
  const proposalOrder = ['001提案']
  const classOrder = [
    'safe', 'euclid', 'keter', 'thaumiel', 'apollyon', 'archon', 'ticonderoga',
    '无效化', '被废除', '等待分级'
  ]

  const picked = new Set<number>()
  const result: string[] = []

  // Helper: pick tags present in given order (case-insensitive for ASCII)
  const pickByFixedOrder = (order: string[]) => {
    for (const key of order) {
      const target = toKey(key)
      for (let i = 0; i < tags.length; i++) {
        if (picked.has(i)) continue
        if (toKey(tags[i]) === target) {
          result.push(tags[i])
          picked.add(i)
        }
      }
    }
  }

  // Helper: pick tags matching predicate while preserving original order
  const pickByPredicate = (pred: (t: string) => boolean) => {
    for (let i = 0; i < tags.length; i++) {
      if (picked.has(i)) continue
      const t = tags[i]
      if (pred(t)) {
        result.push(t)
        picked.add(i)
      }
    }
  }

  // 1) Language tags
  pickByFixedOrder(langOrder)
  // 2) Quality tags
  pickByFixedOrder(qualityOrder)
  // 3) Event- or special-number-like tags
  pickByPredicate(isEventLikeTag)
  // 4) Content type tags
  pickByFixedOrder(contentOrder)
  // 5) Mature/fun tags
  pickByFixedOrder(adultOrder)
  // 6) 001 proposals
  pickByFixedOrder(proposalOrder)
  // 7) Object class and related status tags
  pickByFixedOrder(classOrder)

  // 8) Anything else in original order
  for (let i = 0; i < tags.length; i++) {
    if (!picked.has(i)) result.push(tags[i])
  }

  return result
}

export function isEventLikeTag(tag: string): boolean {
  const t = String(tag || '')
  if (!t) return false
  // 结尾为 竞赛 / 征文 / 大赛
  if (t.endsWith('竞赛') || t.endsWith('征文') || t.endsWith('大赛')) return true
  // 结构为 看图说话-*
  if (/^看图说话-/u.test(t)) return true
  // 包含 1000、2000 或 >2008 的数字，且不包含 site
  const key = toKey(t)
  if (key.includes('site')) return false
  const nums = t.match(/\d+/g) || []
  for (const n of nums) {
    const v = Number(n)
    if (!Number.isFinite(v)) continue
    if (v === 1000 || v === 2000 || v > 2008) return true
  }
  return false
}

function toKey(s: string): string {
  return String(s || '')
    .trim()
    .normalize('NFKC')
    .toLowerCase()
}

