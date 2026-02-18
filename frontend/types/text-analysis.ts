// ===== Text Analysis Visualization Types =====

// --- Meta ---
export interface TextAnalysisMeta {
  generatedAt: string
  totalPages: number
  totalHanChars: number
  vocabularySize: number
  csvSource: string
}

// --- #1 Vocabulary Scatter (PMI x Entropy) ---
export interface VocabScatterPoint {
  word: string
  freq: number
  length: number
  minPmi: number
  leftEntropy: number
  rightEntropy: number
  avgEntropy: number
}

// --- #2 Zipf Deviation ---
export interface ZipfPoint {
  rank: number
  freq: number
  logRank: number
  logFreq: number
  expectedLogFreq: number
  word: string
}

export interface ZipfAnalysis {
  alpha: number
  intercept: number
  points: ZipfPoint[]
}

// --- #3 Vocabulary Evolution ---
export interface VocabEvolutionBucket {
  period: string // e.g. "2020-H1"
  newWords: number
  totalWords: number
  topNew: string[]
}

// --- #4 Author Fingerprints ---
export interface AuthorFingerprint {
  userId: number
  displayName: string
  pageCount: number
  topWords: { word: string; tfidf: number }[]
  avgWordLength: number
  ttr: number // type-token ratio
}

// --- #5 Author Similarity ---
export interface AuthorSimilarityNode {
  id: number
  displayName: string
  pageCount: number
}

export interface AuthorSimilarityEdge {
  source: number
  target: number
  similarity: number
}

export interface AuthorSimilarityData {
  nodes: AuthorSimilarityNode[]
  edges: AuthorSimilarityEdge[]
}

// --- #6 Quality Richness ---
export interface QualityRichnessPoint {
  pageId: number
  title: string
  rating: number
  ttr: number
  hapaxRatio: number
  avgWordLength: number
  wordCount: number
}

// --- #7 Creativity Ranking ---
export interface CreativityEntry {
  pageId: number
  title: string
  rating: number
  rareWordDensity: number
  uniqueRareWords: number
  wordCount: number
}

// --- #8 Cooccurrence Network ---
export interface CooccurrenceNode {
  id: string // word
  freq: number
  community: number
}

export interface CooccurrenceEdge {
  source: string
  target: string
  weight: number
}

export interface CooccurrenceData {
  nodes: CooccurrenceNode[]
  edges: CooccurrenceEdge[]
}

// --- #9 Tag Vocabulary Heatmap ---
export interface TagVocabHeatmapData {
  tags: string[]
  words: string[]
  matrix: number[][] // [tagIndex][wordIndex] = chi-square or TF-IDF
}

// --- #10 Intertextuality Network ---
export interface IntertextNode {
  id: number // pageVersionId
  title: string
  rating: number
}

export interface IntertextEdge {
  source: number
  target: number
  sharedWords: number
  jaccard: number
}

export interface IntertextualityData {
  nodes: IntertextNode[]
  edges: IntertextEdge[]
}

// --- #11 Dialect Comparison ---
export interface DialectGroup {
  label: string
  stats: {
    avgWordLength: number
    avgTtr: number
    topWords: { word: string; freq: number }[]
    totalPages: number
  }
}

// --- #12 Meme Word Spread ---
export interface MemeWordSeries {
  word: string
  points: { month: string; cumulative: number }[]
}

// --- #13 Emotion Temperature ---
export interface EmotionPoint {
  pageId: number
  title: string
  rating: number
  sentimentScore: number
  category: string
}

export interface EmotionSummary {
  category: string
  avgSentiment: number
  avgRating: number
  count: number
}

export interface EmotionData {
  points: EmotionPoint[]
  summary: EmotionSummary[]
}

// --- Tab definitions ---
export type TextAnalysisTab =
  | 'vocabulary'
  | 'tags'
  | 'evolution'
  | 'authors'
  | 'quality'
  | 'emotion'

export const TEXT_ANALYSIS_TABS: { key: TextAnalysisTab; label: string }[] = [
  { key: 'vocabulary', label: '词汇总览' },
  { key: 'tags', label: '标签/分类' },
  { key: 'evolution', label: '时间演化' },
  { key: 'authors', label: '作者分析' },
  { key: 'quality', label: '文章质量' },
  { key: 'emotion', label: '情绪温度' },
]
