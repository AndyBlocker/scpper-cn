#!/usr/bin/env node

/**
 * Text Analysis Pipeline
 *
 * Reads the neologism CSV vocabulary + scans PageVersion.textContent
 * to produce 13 JSON files for the text-analysis visualization page.
 *
 * All database operations are READ-ONLY — no data is modified.
 *
 * Usage:
 *   cd backend
 *   node --import tsx/esm scripts/text-analysis-pipeline.ts [--csv path] [--limit N]
 */

import { Command } from 'commander'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUTPUT_DIR = path.resolve(__dirname, '../../bff/data/text-analysis')
const DEFAULT_CSV = path.resolve(__dirname, '../../tmp/neologism-candidates-len2-7.csv')

// ─── Types ──────────────────────────────────────
interface VocabEntry {
  word: string
  freq: number
  length: number
  minPmi: number
  leftEntropy: number
  rightEntropy: number
}

interface PageScanResult {
  pageVersionId: number
  pageId: number
  title: string
  rating: number
  tags: string[]
  category: string
  firstPublishedAt: Date | null
  wordFreq: Map<string, number>
  totalWords: number
  uniqueWords: number
}

// ─── CSV Loading ────────────────────────────────
async function loadVocabulary(csvPath: string, maxEntries: number): Promise<{ entries: VocabEntry[]; dictSet: Set<string>; maxWordLen: number }> {
  const raw = await fs.readFile(csvPath, 'utf8')
  const lines = raw.split(/\r?\n/).filter(l => l.trim())
  // Skip header
  const entries: VocabEntry[] = []
  const dictSet = new Set<string>()
  let maxWordLen = 2

  for (let i = 1; i < lines.length && entries.length < maxEntries; i++) {
    const parts = lines[i].split(',')
    if (parts.length < 8) continue
    // CSV: rank, "word", freq, length, min_pmi, left_entropy, right_entropy, neighbor_variety
    const word = parts[1].replace(/^"|"$/g, '').replace(/""/g, '"')
    const freq = parseInt(parts[2], 10)
    const length = parseInt(parts[3], 10)
    const minPmi = parseFloat(parts[4])
    const leftEntropy = parseFloat(parts[5])
    const rightEntropy = parseFloat(parts[6])

    if (!word || !Number.isFinite(freq)) continue
    entries.push({ word, freq, length, minPmi, leftEntropy, rightEntropy })
    dictSet.add(word)
    if (length > maxWordLen) maxWordLen = length
  }

  return { entries, dictSet, maxWordLen }
}

// ─── Forward Maximum Match Tokenizer ────────────
const RE_HAN_SEGMENT = /[\p{Script=Han}]{2,}/gu

function forwardMaxMatch(text: string, dictSet: Set<string>, maxLen: number): Map<string, number> {
  const freq = new Map<string, number>()
  const segments = text.match(RE_HAN_SEGMENT) ?? []

  for (const seg of segments) {
    const chars = Array.from(seg)
    let i = 0
    while (i < chars.length) {
      let matched = false
      for (let len = Math.min(maxLen, chars.length - i); len >= 2; len--) {
        const word = chars.slice(i, i + len).join('')
        if (dictSet.has(word)) {
          freq.set(word, (freq.get(word) ?? 0) + 1)
          i += len
          matched = true
          break
        }
      }
      if (!matched) i++ // skip single char
    }
  }

  return freq
}

// ─── Category Classifier ───────────────────────
function classifyCategory(tags: string[], category: string): string {
  if (tags.includes('原创') && tags.includes('scp')) return 'scp'
  if (tags.includes('原创') && tags.includes('goi格式')) return 'goi'
  if (tags.includes('原创') && tags.includes('故事')) return 'story'
  if (tags.includes('原创') && tags.includes('wanderers')) return 'wanderers'
  if (tags.includes('原创') && tags.includes('艺术作品')) return 'art'
  if (category === 'short-stories') return '三句话外围'
  if (category === 'log-of-anomalous-items-cn') return '异常物品'
  if (!tags.includes('原创') && !tags.includes('作者') && !tags.includes('掩盖页') &&
    !tags.includes('段落') && !tags.includes('补充材料') &&
    category !== 'log-of-anomalous-items-cn' && category !== 'short-stories') {
    return 'translation'
  }
  return 'other'
}

// ─── Emotion Lexicon ────────────────────────────
// Small built-in Chinese sentiment word lists (no external dependency)
const POSITIVE_WORDS = new Set([
  '美丽', '优秀', '快乐', '幸福', '温暖', '光明', '希望', '成功', '友善', '善良',
  '勇敢', '聪明', '安全', '保护', '和平', '信任', '喜欢', '欣赏', '感谢', '支持',
  '帮助', '救援', '治愈', '恢复', '胜利', '进步', '创造', '自由', '正义', '荣誉',
  '可爱', '温柔', '安宁', '纯洁', '力量', '坚强', '真诚', '忠诚', '智慧', '优雅',
  '珍贵', '宝贵', '快速', '敏捷', '灵活', '精确', '稳定', '完美', '杰出', '卓越'
])

const NEGATIVE_WORDS = new Set([
  '恐怖', '危险', '死亡', '毁灭', '邪恶', '痛苦', '悲伤', '恐惧', '愤怒', '仇恨',
  '黑暗', '绝望', '孤独', '疯狂', '残忍', '暴力', '杀害', '折磨', '威胁', '阴谋',
  '腐蚀', '感染', '异常', '失控', '崩溃', '混乱', '灾难', '末日', '战争', '牺牲',
  '恶意', '诅咒', '困难', '失败', '损坏', '破坏', '伤害', '攻击', '入侵', '扭曲',
  '恶心', '腐烂', '窒息', '溺水', '坠落', '爆炸', '焚烧', '冻结', '消失', '遗忘'
])

function computeSentiment(wordFreq: Map<string, number>): number {
  let pos = 0, neg = 0, total = 0
  for (const [word, count] of wordFreq) {
    total += count
    if (POSITIVE_WORDS.has(word)) pos += count
    if (NEGATIVE_WORDS.has(word)) neg += count
  }
  if (total === 0) return 0
  return (pos - neg) / Math.sqrt(total)
}

// ─── Helpers ────────────────────────────────────
function ttr(wordFreq: Map<string, number>): number {
  let total = 0
  for (const c of wordFreq.values()) total += c
  if (total === 0) return 0
  return wordFreq.size / total
}

function hapaxRatio(wordFreq: Map<string, number>): number {
  let hapax = 0, total = 0
  for (const c of wordFreq.values()) {
    total += c
    if (c === 1) hapax++
  }
  return total === 0 ? 0 : hapax / total
}

function avgWordLength(wordFreq: Map<string, number>): number {
  let totalLen = 0, totalCount = 0
  for (const [w, c] of wordFreq) {
    totalLen += Array.from(w).length * c
    totalCount += c
  }
  return totalCount === 0 ? 0 : totalLen / totalCount
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0, magA = 0, magB = 0
  for (const [k, v] of a) {
    magA += v * v
    const bv = b.get(k)
    if (bv) dot += v * bv
  }
  for (const v of b.values()) magB += v * v
  const denom = Math.sqrt(magA) * Math.sqrt(magB)
  return denom === 0 ? 0 : dot / denom
}

async function writeJSON(filename: string, data: any) {
  const filePath = path.join(OUTPUT_DIR, filename)
  await fs.writeFile(filePath, JSON.stringify(data), 'utf8')
  console.log(`  ✓ ${filename} (${(JSON.stringify(data).length / 1024).toFixed(0)} KB)`)
}

// ─── Main Pipeline ──────────────────────────────
async function main() {
  const program = new Command()
  program
    .option('--csv <path>', 'Path to neologism CSV', DEFAULT_CSV)
    .option('--dict-size <n>', 'Max vocabulary entries to load', '200000')
    .option('--batch-size <n>', 'DB scan batch size', '200')
    .option('--limit <n>', 'Limit pages scanned (0=all)', '0')
    .option('--meme-words <words>', 'Comma-separated meme words to track', '基金会,异常,收容,特工,机动,模因,认知,末日,反熵,叙事')
    .parse(process.argv)

  const opts = program.opts()
  const csvPath = opts.csv as string
  const dictSize = parseInt(opts.dictSize, 10)
  const batchSize = parseInt(opts.batchSize, 10)
  const limitPages = parseInt(opts.limit, 10)
  const memeWords = (opts.memeWords as string).split(',').map(w => w.trim()).filter(Boolean)

  console.log('=== Text Analysis Pipeline ===')
  console.log(`CSV: ${csvPath}`)
  console.log(`Dict size: ${dictSize}`)

  // Step 1: Load vocabulary
  console.log('\n[1/6] Loading vocabulary...')
  const { entries, dictSet, maxWordLen } = await loadVocabulary(csvPath, dictSize)
  console.log(`  Loaded ${entries.length} words, max length=${maxWordLen}`)

  // Step 2: Scan all active non-deleted PageVersions (READ-ONLY)
  console.log('\n[2/6] Scanning PageVersion text content (READ-ONLY)...')
  const prisma = getPrismaClient()

  const pages: PageScanResult[] = []
  let lastId = 0
  let scanned = 0

  while (true) {
    const rows = await prisma.pageVersion.findMany({
      where: {
        validTo: null,
        isDeleted: false,
        textContent: { not: null },
        id: { gt: lastId }
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: {
        id: true,
        pageId: true,
        title: true,
        rating: true,
        tags: true,
        category: true,
        textContent: true,
        page: {
          select: { firstPublishedAt: true }
        }
      }
    })

    if (rows.length === 0) break
    lastId = rows[rows.length - 1].id

    for (const row of rows) {
      const text = row.textContent ?? ''
      const wordFreq = forwardMaxMatch(text, dictSet, maxWordLen)

      let totalWords = 0
      for (const c of wordFreq.values()) totalWords += c

      if (totalWords < 5) continue // skip very short pages

      pages.push({
        pageVersionId: row.id,
        pageId: row.pageId,
        title: row.title ?? '(untitled)',
        rating: row.rating ?? 0,
        tags: row.tags ?? [],
        category: classifyCategory(row.tags ?? [], row.category ?? ''),
        firstPublishedAt: row.page?.firstPublishedAt ?? null,
        wordFreq,
        totalWords,
        uniqueWords: wordFreq.size
      })
    }

    scanned += rows.length
    if (scanned % 2000 === 0) console.log(`  scanned ${scanned} rows, ${pages.length} valid pages`)
    if (limitPages > 0 && pages.length >= limitPages) break
    if (rows.length < batchSize) break
  }

  console.log(`  Total: ${scanned} rows scanned, ${pages.length} valid pages`)

  // Step 3: Compute all analyses
  console.log('\n[3/6] Computing vocabulary analyses...')

  // --- #1 Vocabulary Scatter ---
  const vocabScatter = entries.slice(0, 2000).map(e => ({
    word: e.word,
    freq: e.freq,
    length: e.length,
    minPmi: Number(e.minPmi.toFixed(3)),
    leftEntropy: Number(e.leftEntropy.toFixed(3)),
    rightEntropy: Number(e.rightEntropy.toFixed(3)),
    avgEntropy: Number(((e.leftEntropy + e.rightEntropy) / 2).toFixed(3))
  }))

  // --- #2 Zipf Analysis ---
  const sortedByFreq = [...entries].sort((a, b) => b.freq - a.freq)
  const zipfPoints = sortedByFreq.slice(0, 3000).map((e, i) => {
    const rank = i + 1
    return {
      rank,
      freq: e.freq,
      logRank: Number(Math.log10(rank).toFixed(4)),
      logFreq: Number(Math.log10(e.freq).toFixed(4)),
      expectedLogFreq: 0,
      word: e.word
    }
  })
  // Fit Zipf: log(f) = -alpha * log(r) + C via linear regression
  {
    const n = zipfPoints.length
    let sx = 0, sy = 0, sxy = 0, sx2 = 0
    for (const p of zipfPoints) {
      sx += p.logRank; sy += p.logFreq
      sxy += p.logRank * p.logFreq; sx2 += p.logRank * p.logRank
    }
    const alpha = -(n * sxy - sx * sy) / (n * sx2 - sx * sx)
    const intercept = (sy + alpha * sx) / n
    for (const p of zipfPoints) {
      p.expectedLogFreq = Number((intercept - alpha * p.logRank).toFixed(4))
    }
    console.log(`  Zipf alpha = ${alpha.toFixed(4)}`)
    await writeJSON('zipf-analysis.json', { alpha: Number(alpha.toFixed(4)), intercept: Number(intercept.toFixed(4)), points: zipfPoints })
  }

  await writeJSON('vocabulary-scatter.json', vocabScatter)

  // Step 4: Tag/category, dialect, evolution
  console.log('\n[4/6] Computing tag, dialect, and evolution analyses...')

  // --- #9 Tag Vocabulary Heatmap ---
  const TOP_TAGS = ['scp', '故事', 'goi格式', 'wanderers', '原创', '艺术作品', '搞笑', '恐怖',
    '科幻', '超自然', '合作', '已归档', '精品', '补充材料', '段落', '模因',
    '认知危害', '生物性', '机械', '信息']
  const tagWordFreq = new Map<string, Map<string, number>>()
  for (const tag of TOP_TAGS) tagWordFreq.set(tag, new Map())

  for (const page of pages) {
    for (const tag of page.tags) {
      const tagMap = tagWordFreq.get(tag)
      if (!tagMap) continue
      for (const [w, c] of page.wordFreq) {
        tagMap.set(w, (tagMap.get(w) ?? 0) + c)
      }
    }
  }

  // Pick top 30 discriminating words across tags (by TF-IDF-like measure)
  const globalWordFreq = new Map<string, number>()
  for (const page of pages) {
    for (const [w, c] of page.wordFreq) {
      globalWordFreq.set(w, (globalWordFreq.get(w) ?? 0) + c)
    }
  }

  // Chi-square-like: for each tag-word pair, (observed - expected)^2 / expected
  const topWordsSet = new Set<string>()
  const chiSquares: { tag: string; word: string; chi: number }[] = []
  let globalTotal = 0
  for (const c of globalWordFreq.values()) globalTotal += c

  for (const [tag, wf] of tagWordFreq) {
    let tagTotal = 0
    for (const c of wf.values()) tagTotal += c
    if (tagTotal === 0) continue

    for (const [word, observed] of wf) {
      const globalFrac = (globalWordFreq.get(word) ?? 0) / globalTotal
      const expected = globalFrac * tagTotal
      if (expected < 1) continue
      const chi = Math.pow(observed - expected, 2) / expected
      chiSquares.push({ tag, word, chi })
    }
  }

  chiSquares.sort((a, b) => b.chi - a.chi)
  for (const item of chiSquares) {
    if (topWordsSet.size >= 30) break
    topWordsSet.add(item.word)
  }
  const topWords = [...topWordsSet]
  const activeTags = TOP_TAGS.filter(t => {
    const m = tagWordFreq.get(t)
    if (!m) return false
    let total = 0; for (const c of m.values()) total += c
    return total > 100
  })

  const heatmapMatrix = activeTags.map(tag => {
    const wf = tagWordFreq.get(tag)!
    let tagTotal = 0
    for (const c of wf.values()) tagTotal += c
    return topWords.map(word => {
      const observed = wf.get(word) ?? 0
      const globalFrac = (globalWordFreq.get(word) ?? 0) / globalTotal
      const expected = globalFrac * tagTotal
      if (expected < 1) return 0
      return Number((Math.pow(observed - expected, 2) / expected).toFixed(2))
    })
  })

  await writeJSON('tag-vocabulary-heatmap.json', { tags: activeTags, words: topWords, matrix: heatmapMatrix })

  // --- #11 Dialect Comparison ---
  function groupStats(groupPages: PageScanResult[]) {
    const merged = new Map<string, number>()
    let totalTtr = 0
    let totalAvgWl = 0
    for (const p of groupPages) {
      totalTtr += ttr(p.wordFreq)
      totalAvgWl += avgWordLength(p.wordFreq)
      for (const [w, c] of p.wordFreq) merged.set(w, (merged.get(w) ?? 0) + c)
    }
    const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1])
    return {
      avgWordLength: Number((totalAvgWl / (groupPages.length || 1)).toFixed(3)),
      avgTtr: Number((totalTtr / (groupPages.length || 1)).toFixed(4)),
      topWords: sorted.slice(0, 20).map(([word, freq]) => ({ word, freq })),
      totalPages: groupPages.length
    }
  }

  const originalPages = pages.filter(p => p.tags.includes('原创'))
  const translationPages = pages.filter(p => p.category === 'translation')
  const cutoffYear = 2022
  const earlyPages = pages.filter(p => p.firstPublishedAt && p.firstPublishedAt.getFullYear() < cutoffYear)
  const recentPages = pages.filter(p => p.firstPublishedAt && p.firstPublishedAt.getFullYear() >= cutoffYear)

  await writeJSON('dialect-comparison.json', [
    { label: '原创', stats: groupStats(originalPages) },
    { label: '翻译', stats: groupStats(translationPages) },
    { label: `早期 (<${cutoffYear})`, stats: groupStats(earlyPages) },
    { label: `近期 (≥${cutoffYear})`, stats: groupStats(recentPages) }
  ])

  // --- Pre-compute word document frequency (used by evolution + author sections) ---
  const wordDocFreq = new Map<string, number>()
  for (const page of pages) {
    for (const w of page.wordFreq.keys()) {
      wordDocFreq.set(w, (wordDocFreq.get(w) ?? 0) + 1)
    }
  }

  // --- Build entropy lookup from CSV entries (for name filtering) ---
  const entryMap = new Map<string, VocabEntry>()
  for (const e of entries) entryMap.set(e.word, e)

  // --- #3 Vocabulary Evolution ---
  function halfYear(d: Date): string {
    const y = d.getFullYear()
    const h = d.getMonth() < 6 ? 'H1' : 'H2'
    return `${y}-${h}`
  }

  const periodWords = new Map<string, Map<string, number>>()
  const periodsOrdered: string[] = []

  // Sort pages by date
  const datedPages = pages.filter(p => p.firstPublishedAt).sort((a, b) => a.firstPublishedAt!.getTime() - b.firstPublishedAt!.getTime())
  const allSeenWords = new Set<string>()

  for (const p of datedPages) {
    const period = halfYear(p.firstPublishedAt!)
    if (!periodWords.has(period)) {
      periodWords.set(period, new Map())
      periodsOrdered.push(period)
    }
    const periodMap = periodWords.get(period)!
    for (const [w, c] of p.wordFreq) {
      periodMap.set(w, (periodMap.get(w) ?? 0) + c)
    }
  }

  // Filter out likely person names / proper nouns:
  // - avgEntropy < 2.5 → rigid context (typical of names)
  // - docFreq <= 5 → appears in very few pages
  // - length 2-3 with low entropy → very likely a person name
  // Either entropy OR docFreq condition triggers filtering.
  function isLikelyName(word: string): boolean {
    const entry = entryMap.get(word)
    if (!entry) return false
    const avgEntropy = (entry.leftEntropy + entry.rightEntropy) / 2
    const df = wordDocFreq.get(word) ?? 0
    // Short words (2-3 chars) with low entropy are almost certainly names
    if (entry.length <= 3 && avgEntropy < 3.0 && df <= 10) return true
    // Any word with very low entropy and low doc freq
    if (avgEntropy < 2.0 && df <= 5) return true
    // Any word appearing in very few pages with moderate entropy
    if (df <= 2 && avgEntropy < 3.5) return true
    return false
  }

  const evolution: { period: string; newWords: number; totalWords: number; topNew: string[] }[] = []
  for (const period of periodsOrdered) {
    const words = periodWords.get(period)!
    const newWords: string[] = []
    for (const w of words.keys()) {
      if (!allSeenWords.has(w)) {
        newWords.push(w)
        allSeenWords.add(w)
      }
    }
    // Pick top new words by period-local frequency, excluding likely names
    // and requiring minimum document frequency to ensure representativeness
    const MIN_DOC_FREQ_FOR_TOP = 5
    const newWithFreq = newWords
      .filter(w => !isLikelyName(w) && (wordDocFreq.get(w) ?? 0) >= MIN_DOC_FREQ_FOR_TOP)
      .map(w => ({ word: w, freq: words.get(w) ?? 0 }))
    newWithFreq.sort((a, b) => b.freq - a.freq)
    evolution.push({
      period,
      newWords: newWords.length,
      totalWords: allSeenWords.size,
      topNew: newWithFreq.slice(0, 8).map(x => x.word)
    })
  }

  await writeJSON('vocabulary-evolution.json', evolution)

  // --- #12 Meme Word Spread ---
  function yearMonth(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }

  const memeData = memeWords.map(word => {
    const monthCounts = new Map<string, number>()
    for (const p of datedPages) {
      const count = p.wordFreq.get(word) ?? 0
      if (count > 0) {
        const ym = yearMonth(p.firstPublishedAt!)
        monthCounts.set(ym, (monthCounts.get(ym) ?? 0) + count)
      }
    }

    const months = [...monthCounts.keys()].sort()
    let cum = 0
    const points = months.map(m => {
      cum += monthCounts.get(m)!
      return { month: m, cumulative: cum }
    })

    return { word, points }
  }).filter(s => s.points.length > 0)

  await writeJSON('meme-word-spread.json', memeData)

  // Step 5: Author analyses
  console.log('\n[5/6] Computing author and quality analyses...')

  // Load attributions (READ-ONLY)
  // Use AUTHOR first, then SUBMITTER as fallback — AUTHOR only covers ~2K pages,
  // while SUBMITTER covers ~31K (the "who posted this page" record).
  const attributions = await prisma.attribution.findMany({
    where: { type: { in: ['AUTHOR', 'SUBMITTER'] }, userId: { not: null } },
    select: {
      pageVerId: true,
      type: true,
      userId: true,
      user: { select: { displayName: true } }
    },
    orderBy: { type: 'asc' } // AUTHOR sorts before SUBMITTER
  })

  const pvToAuthor = new Map<number, { userId: number; displayName: string }>()
  for (const a of attributions) {
    if (a.userId && a.user?.displayName) {
      // AUTHOR takes priority over SUBMITTER for the same pageVersionId
      if (!pvToAuthor.has(a.pageVerId) || a.type === 'AUTHOR') {
        pvToAuthor.set(a.pageVerId, { userId: a.userId, displayName: a.user.displayName })
      }
    }
  }
  console.log(`  Loaded ${pvToAuthor.size} page→author mappings (from ${attributions.length} attributions)`)

  // --- #4 Author Fingerprints (TF-IDF) ---
  const authorPages = new Map<number, { displayName: string; pages: PageScanResult[] }>()

  for (const page of pages) {
    const author = pvToAuthor.get(page.pageVersionId)
    if (!author) continue
    if (!authorPages.has(author.userId)) {
      authorPages.set(author.userId, { displayName: author.displayName, pages: [] })
    }
    authorPages.get(author.userId)!.pages.push(page)
  }

  // IDF: log(N / df) — wordDocFreq already computed above
  const N = pages.length

  const fingerprints: any[] = []
  const authorVectors = new Map<number, Map<string, number>>()

  // License/boilerplate words that appear in CC-BY-SA attribution blocks —
  // these are not indicative of authorial style and should be excluded.
  const LICENSE_STOPWORDS = new Set([
    '图像名', '文件名', '图像作者', '授权协议', '来源链接',
    '发布日期', '标题', '原作者', '著作信息', '图像来源',
    '创作年份', '版权所有', '来源', '许可协议', '创建于',
    '创作者', '最新编辑', '显示图片', '总字数', '评论数',
    '发生日期', '好评率', '总评分'
  ])
  for (const [userId, data] of authorPages) {
    if (data.pages.length < 3) continue // need at least 3 pages

    // Per-document normalized TF: normalize each page's word freq to a probability
    // distribution first, then average across pages. This prevents long articles
    // from dominating the fingerprint.
    const normalizedSum = new Map<string, number>()
    // Also track per-author document frequency: how many of this author's pages
    // contain each word. A true "signature word" should appear across multiple works.
    const authorDocFreq = new Map<string, number>()
    let totalTtrSum = 0
    let totalAvgWlSum = 0
    for (const p of data.pages) {
      totalTtrSum += ttr(p.wordFreq)
      totalAvgWlSum += avgWordLength(p.wordFreq)

      // Normalize this page's word freq to sum=1
      let pageTotal = 0
      for (const c of p.wordFreq.values()) pageTotal += c
      if (pageTotal === 0) continue

      for (const [w, c] of p.wordFreq) {
        normalizedSum.set(w, (normalizedSum.get(w) ?? 0) + c / pageTotal)
      }
      // Count in how many of this author's docs each word appears
      for (const w of p.wordFreq.keys()) {
        authorDocFreq.set(w, (authorDocFreq.get(w) ?? 0) + 1)
      }
    }

    // TF = average normalized frequency across all pages
    // Filter: word must appear in >= 20% of the author's pages (min 2 pages)
    // to qualify as a "signature word" — prevents one-off long-doc words
    const numPages = data.pages.length
    const minAuthorDocs = Math.max(2, Math.ceil(numPages * 0.2))
    const tfidfMap = new Map<string, number>()

    for (const [word, sumNormFreq] of normalizedSum) {
      if (LICENSE_STOPWORDS.has(word)) continue // skip license boilerplate
      const adf = authorDocFreq.get(word) ?? 0
      if (adf < minAuthorDocs) continue // skip words only in a few pages
      const tf = sumNormFreq / numPages
      const df = wordDocFreq.get(word) ?? 1
      const idf = Math.log(N / df)
      tfidfMap.set(word, tf * idf)
    }

    const sortedWords = [...tfidfMap.entries()].sort((a, b) => b[1] - a[1])

    fingerprints.push({
      userId,
      displayName: data.displayName,
      pageCount: data.pages.length,
      topWords: sortedWords.slice(0, 15).map(([word, tfidf]) => ({ word, tfidf: Number(tfidf.toFixed(5)) })),
      avgWordLength: Number((totalAvgWlSum / data.pages.length).toFixed(3)),
      ttr: Number((totalTtrSum / data.pages.length).toFixed(4))
    })

    // Store top-100 TF-IDF vector for similarity
    const vec = new Map<string, number>()
    for (const [word, score] of sortedWords.slice(0, 100)) vec.set(word, score)
    authorVectors.set(userId, vec)
  }

  fingerprints.sort((a, b) => b.pageCount - a.pageCount)
  await writeJSON('author-fingerprints.json', fingerprints)

  // --- #5 Author Similarity Network ---
  const authorIds = [...authorVectors.keys()].slice(0, 80) // top 80 authors
  const simNodes = authorIds.map(id => {
    const data = authorPages.get(id)!
    return { id, displayName: data.displayName, pageCount: data.pages.length }
  })
  const simEdges: { source: number; target: number; similarity: number }[] = []

  for (let i = 0; i < authorIds.length; i++) {
    for (let j = i + 1; j < authorIds.length; j++) {
      const sim = cosineSimilarity(authorVectors.get(authorIds[i])!, authorVectors.get(authorIds[j])!)
      if (sim > 0.15) {
        simEdges.push({ source: authorIds[i], target: authorIds[j], similarity: Number(sim.toFixed(4)) })
      }
    }
  }

  await writeJSON('author-similarity.json', { nodes: simNodes, edges: simEdges })

  // --- #6 Quality Richness ---
  const qualityData = pages
    .filter(p => p.totalWords >= 20)
    .map(p => ({
      pageId: p.pageId,
      title: p.title,
      rating: p.rating,
      ttr: Number(ttr(p.wordFreq).toFixed(4)),
      hapaxRatio: Number(hapaxRatio(p.wordFreq).toFixed(4)),
      avgWordLength: Number(avgWordLength(p.wordFreq).toFixed(3)),
      wordCount: p.totalWords
    }))
    .sort((a, b) => b.rating - a.rating)

  await writeJSON('quality-richness.json', qualityData.slice(0, 1000))

  // --- #7 Creativity Ranking ---
  // Rare words: those in bottom 50% of global frequency
  const globalFreqSorted = [...globalWordFreq.entries()].sort((a, b) => a[1] - b[1])
  const medianIdx = Math.floor(globalFreqSorted.length / 2)
  const rareThreshold = globalFreqSorted[medianIdx]?.[1] ?? 10
  const rareWords = new Set(globalFreqSorted.filter(([, f]) => f <= rareThreshold).map(([w]) => w))

  const creativityData = pages
    .filter(p => p.totalWords >= 30)
    .map(p => {
      let rareCount = 0
      let uniqueRare = 0
      for (const [w, c] of p.wordFreq) {
        if (rareWords.has(w)) {
          rareCount += c
          uniqueRare++
        }
      }
      return {
        pageId: p.pageId,
        title: p.title,
        rating: p.rating,
        rareWordDensity: Number((rareCount / p.totalWords).toFixed(4)),
        uniqueRareWords: uniqueRare,
        wordCount: p.totalWords
      }
    })
    .sort((a, b) => b.rareWordDensity - a.rareWordDensity)

  await writeJSON('creativity-ranking.json', creativityData.slice(0, 500))

  // Step 6: Networks + Emotion
  console.log('\n[6/6] Computing networks and emotion...')

  // --- #8 Cooccurrence Network ---
  // Build cooccurrence from top-200 words
  const top200Words = [...globalWordFreq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200)
    .map(([w]) => w)
  const top200Set = new Set(top200Words)

  const coocMatrix = new Map<string, Map<string, number>>()
  for (const w of top200Words) coocMatrix.set(w, new Map())

  for (const page of pages) {
    const pageWords = [...page.wordFreq.keys()].filter(w => top200Set.has(w))
    for (let i = 0; i < pageWords.length; i++) {
      for (let j = i + 1; j < pageWords.length; j++) {
        const a = pageWords[i], b = pageWords[j]
        const map = coocMatrix.get(a)!
        map.set(b, (map.get(b) ?? 0) + 1)
      }
    }
  }

  // Simple community detection: greedy modularity (simplified Louvain)
  const communityMap = new Map<string, number>()
  let communityId = 0
  const visited = new Set<string>()

  for (const word of top200Words) {
    if (visited.has(word)) continue
    // BFS to find connected component, then assign community
    const queue = [word]
    const component: string[] = []
    visited.add(word)

    while (queue.length > 0) {
      const curr = queue.shift()!
      component.push(curr)
      const neighbors = coocMatrix.get(curr)
      if (neighbors) {
        for (const [nb, weight] of neighbors) {
          if (!visited.has(nb) && weight > 5) {
            visited.add(nb)
            queue.push(nb)
          }
        }
      }
    }

    for (const w of component) communityMap.set(w, communityId)
    communityId++
  }

  const coocNodes = top200Words.map(w => ({
    id: w,
    freq: globalWordFreq.get(w) ?? 0,
    community: communityMap.get(w) ?? 0
  }))

  const coocEdges: { source: string; target: string; weight: number }[] = []
  for (const [src, neighbors] of coocMatrix) {
    for (const [tgt, weight] of neighbors) {
      if (weight > 10) {
        coocEdges.push({ source: src, target: tgt, weight })
      }
    }
  }
  coocEdges.sort((a, b) => b.weight - a.weight)

  await writeJSON('cooccurrence-network.json', { nodes: coocNodes, edges: coocEdges.slice(0, 500) })

  // --- #10 Intertextuality Network ---
  // Load page references (READ-ONLY)
  const refs = await prisma.pageReference.findMany({
    where: {
      linkType: { in: ['TRIPLE', 'SHORT', 'DIRECT'] },
      pageVersion: { validTo: null, isDeleted: false }
    },
    select: {
      pageVersionId: true,
      targetPath: true
    },
    take: 50000
  })

  // Build page ref graph + Jaccard from shared words
  const pvIdToPage = new Map<number, PageScanResult>()
  for (const p of pages) pvIdToPage.set(p.pageVersionId, p)

  // Group refs by source pvId
  const refsBySource = new Map<number, Set<string>>()
  for (const r of refs) {
    if (!refsBySource.has(r.pageVersionId)) refsBySource.set(r.pageVersionId, new Set())
    refsBySource.get(r.pageVersionId)!.add(r.targetPath)
  }

  // Build nodes from pages that have refs
  const interNodes: { id: number; title: string; rating: number }[] = []
  const interEdges: { source: number; target: number; sharedWords: number; jaccard: number }[] = []

  // Only consider top-rated pages with refs to keep graph manageable
  const refPages = pages
    .filter(p => refsBySource.has(p.pageVersionId) && p.rating >= 10)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 100)

  for (const p of refPages) {
    interNodes.push({ id: p.pageVersionId, title: p.title, rating: p.rating })
  }

  // Compute Jaccard similarity between pairs of ref-connected pages
  for (let i = 0; i < refPages.length; i++) {
    for (let j = i + 1; j < refPages.length; j++) {
      const wordsA = new Set(refPages[i].wordFreq.keys())
      const wordsB = new Set(refPages[j].wordFreq.keys())
      let intersection = 0
      for (const w of wordsA) if (wordsB.has(w)) intersection++
      const union = wordsA.size + wordsB.size - intersection
      const jaccard = union === 0 ? 0 : intersection / union

      if (jaccard > 0.15) {
        interEdges.push({
          source: refPages[i].pageVersionId,
          target: refPages[j].pageVersionId,
          sharedWords: intersection,
          jaccard: Number(jaccard.toFixed(4))
        })
      }
    }
  }

  interEdges.sort((a, b) => b.jaccard - a.jaccard)
  await writeJSON('intertextuality-network.json', { nodes: interNodes, edges: interEdges.slice(0, 300) })

  // --- #13 Emotion Temperature ---
  const emotionPoints = pages
    .filter(p => p.totalWords >= 20)
    .map(p => ({
      pageId: p.pageId,
      title: p.title,
      rating: p.rating,
      sentimentScore: Number(computeSentiment(p.wordFreq).toFixed(4)),
      category: p.category
    }))

  // Summary by category
  const catSentiment = new Map<string, { sum: number; ratingSum: number; count: number }>()
  for (const pt of emotionPoints) {
    if (pt.category === 'other') continue
    if (!catSentiment.has(pt.category)) catSentiment.set(pt.category, { sum: 0, ratingSum: 0, count: 0 })
    const cs = catSentiment.get(pt.category)!
    cs.sum += pt.sentimentScore
    cs.ratingSum += pt.rating
    cs.count++
  }

  const emotionSummary = [...catSentiment.entries()]
    .filter(([, v]) => v.count >= 5)
    .map(([category, v]) => ({
      category,
      avgSentiment: Number((v.sum / v.count).toFixed(4)),
      avgRating: Number((v.ratingSum / v.count).toFixed(2)),
      count: v.count
    }))
    .sort((a, b) => b.avgSentiment - a.avgSentiment)

  await writeJSON('emotion-temperature.json', { points: emotionPoints.slice(0, 1000), summary: emotionSummary })

  // --- Meta ---
  await writeJSON('meta.json', {
    generatedAt: new Date().toISOString(),
    totalPages: pages.length,
    totalHanChars: pages.reduce((s, p) => s + p.totalWords, 0),
    vocabularySize: entries.length,
    csvSource: path.basename(csvPath)
  })

  console.log(`\n=== Done! ${14} JSON files written to ${OUTPUT_DIR} ===`)
  await disconnectPrisma()
}

main().catch(async (err) => {
  console.error('Pipeline failed:', err)
  try { await disconnectPrisma() } catch {}
  process.exitCode = 1
})
