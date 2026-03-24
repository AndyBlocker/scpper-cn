<template>
  <section id="page-source" class="border border-neutral-200 dark:border-neutral-800 rounded-lg bg-white dark:bg-neutral-900 shadow-sm">
    <header class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-6 pt-6">
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">页面源码</h3>
        <button
          type="button"
          class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-[var(--g-accent)] hover:border-[var(--g-accent-border)] dark:text-neutral-400 dark:hover:text-[var(--g-accent)]"
          @click="$emit('copy-anchor', 'page-source')"
          :title="copiedAnchorId === 'page-source' ? '已复制链接' : '复制该段落链接'"
        >
          <LucideIcon v-if="copiedAnchorId === 'page-source'" name="Check" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
          <LucideIcon v-else name="Link" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
        </button>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <button @click="toggleDiffMode"
                class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700">
          {{ diffMode ? '退出对比' : '对比版本' }}
        </button>

        <div v-if="!diffMode" class="flex items-center gap-2">
          <label class="text-xs text-neutral-500 dark:text-neutral-400">页面版本:</label>
          <select v-model="localSelectedVersion" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">
            <option v-for="v in pageVersions" :key="v.pageVersionId" :value="v.pageVersionId">
              {{ v.validTo ? '历史' : '当前' }} · {{ formatDate(v.createdAt) }} · {{ v.title || '' }}
            </option>
          </select>
        </div>

        <div v-else class="diff-toolbar flex flex-col gap-2 text-xs text-neutral-600 dark:text-neutral-400 sm:flex-row sm:flex-wrap sm:items-stretch sm:gap-3">
          <div class="diff-chip flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-100/70 dark:bg-neutral-800/60 shadow-sm sm:flex-[1_1_220px]">
            <span class="diff-label text-neutral-500 dark:text-neutral-300">基准</span>
            <select
              v-model="baseVersionId"
              class="diff-select flex-1 min-w-0 px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)]"
            >
              <option v-for="v in orderedVersions" :key="`b-${v.pageVersionId}`" :value="v.pageVersionId">
                {{ v.validTo ? '历史' : '当前' }} · {{ formatDate(v.createdAt) }} · {{ v.title || '' }}
              </option>
            </select>
          </div>
          <div class="diff-chip flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-100/70 dark:bg-neutral-800/60 shadow-sm sm:flex-[1_1_220px]">
            <span class="diff-label text-neutral-500 dark:text-neutral-300">对比</span>
            <select
              v-model="compareVersionId"
              class="diff-select flex-1 min-w-0 px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)]"
            >
              <option v-for="v in orderedVersions" :key="`c-${v.pageVersionId}`" :value="v.pageVersionId">
                {{ v.validTo ? '历史' : '当前' }} · {{ formatDate(v.createdAt) }} · {{ v.title || '' }}
              </option>
            </select>
          </div>
          <div class="diff-chip flex items-center gap-3 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-100/70 dark:bg-neutral-800/60 shadow-sm sm:flex-[1_1_200px]">
            <span class="diff-label text-neutral-500 dark:text-neutral-300">视图</span>
            <div class="diff-view-toggle inline-flex items-center rounded-full bg-neutral-200/60 dark:bg-neutral-800/70 p-[3px]">
              <button
                type="button"
                :class="[
                  'diff-view-toggle__btn px-3 py-1 rounded-full text-[11px] font-medium transition-colors',
                  diffViewMode === 'unified'
                    ? 'bg-white text-[var(--g-accent)] shadow-sm dark:bg-neutral-700'
                    : 'text-neutral-600 hover:text-neutral-800 dark:text-neutral-300 dark:hover:text-neutral-100'
                ]"
                @click="diffViewMode = 'unified'"
              >
                合并
              </button>
              <button
                type="button"
                :class="[
                  'diff-view-toggle__btn px-3 py-1 rounded-full text-[11px] font-medium transition-colors',
                  diffViewMode === 'split'
                    ? 'bg-white text-[var(--g-accent)] shadow-sm dark:bg-neutral-700'
                    : 'text-neutral-600 hover:text-neutral-800 dark:text-neutral-300 dark:hover:text-neutral-100'
                ]"
                @click="diffViewMode = 'split'"
              >
                并排
              </button>
            </div>
          </div>
          <div class="diff-chip diff-chip--context flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-100/70 dark:bg-neutral-800/60 shadow-sm sm:flex-[0_1_150px]">
            <span class="diff-label text-neutral-500 dark:text-neutral-300">上下文</span>
            <select
              v-model.number="diffContextLines"
              class="diff-select diff-select--narrow flex-none px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)]"
            >
              <option :value="1">1</option>
              <option :value="2">2</option>
              <option :value="3">3</option>
              <option :value="5">5</option>
            </select>
          </div>
          <div class="diff-chip diff-chip--toggles flex gap-2 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-100/70 dark:bg-neutral-800/60 shadow-sm sm:flex-[1_1_220px]">
            <span class="diff-label text-neutral-500 dark:text-neutral-300">显示</span>
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
              <label class="inline-flex items-center gap-2">
                <input type="checkbox" v-model="ignoreWhitespace" class="rounded">
                <span class="text-neutral-600 dark:text-neutral-300">忽略空白</span>
              </label>
              <label class="inline-flex items-center gap-2">
                <input type="checkbox" v-model="diffCollapseUnchanged" class="rounded">
                <span class="text-neutral-600 dark:text-neutral-300">折叠未变化</span>
              </label>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-2">
          <button @click="copySource" :disabled="diffMode" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-50">
            复制源码
          </button>
          <button @click="downloadSource" :disabled="diffMode" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-50">
            下载源码
          </button>
        </div>
      </div>
    </header>

    <div class="mt-4 border-t border-neutral-100 dark:border-neutral-800"></div>

    <div v-if="!diffMode" class="px-6 pb-6">
      <div class="mb-2 text-[11px] text-neutral-500 dark:text-neutral-400 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>源码字符数 {{ sourceCharacterCount }}</span>
        <span aria-hidden="true">·</span>
        <span>文字字数 {{ textContentCharacterCount }}</span>
      </div>
      <pre class="source-code-block border border-neutral-200 dark:border-neutral-700 rounded bg-neutral-50 dark:bg-neutral-800 p-3 max-h-96 overflow-auto text-xs font-mono whitespace-pre-wrap select-text"
           aria-label="页面源码内容">{{ displayedSource }}</pre>
    </div>

    <div v-else class="px-6 pb-6">
      <div class="source-code-block border border-neutral-200 dark:border-neutral-700 rounded bg-neutral-50 dark:bg-neutral-800 overflow-hidden text-xs font-mono select-text">
        <div v-if="diffLoading" class="px-3 py-4 text-neutral-500 dark:text-neutral-400">计算对比中…</div>
        <div v-else-if="diffError" class="px-3 py-4 text-red-600 dark:text-red-400">{{ diffError }}</div>
        <div v-else-if="!diffData" class="px-3 py-4 text-neutral-500 dark:text-neutral-400">尚未生成对比</div>
        <template v-else>
          <div class="flex flex-wrap items-center gap-3 px-3 py-2 text-[11px] text-neutral-600 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-700 bg-white/60 dark:bg-neutral-900/40">
            <span>变化 {{ diffSummary.blocks }} 处 · +{{ diffSummary.added }} / -{{ diffSummary.removed }}</span>
            <span v-if="!diffHasChanges" class="text-neutral-500 dark:text-neutral-400">两个版本内容一致</span>
          </div>
          <div v-if="diffViewMode === 'unified'" class="diff-viewer-unified max-h-[28rem] overflow-auto">
            <template v-for="row in diffUnifiedRows" :key="row.kind === 'fold' ? `fold-${row.id}` : row.key">
              <div v-if="row.kind === 'fold'" class="border-b border-neutral-200 dark:border-neutral-700 bg-neutral-100/60 dark:bg-neutral-800/60 px-3 py-2">
                <button type="button" @click="toggleDiffFold(row.id)"
                        class="inline-flex items-center gap-1 text-[11px] text-neutral-600 dark:text-neutral-300">
                  <span>{{ row.isExpanded ? '折叠' : '展开' }} {{ row.skipped }} 行未变化</span>
                  <span v-if="row.oldRange || row.newRange" class="opacity-60">
                    (旧 {{ formatRange(row.oldRange) }} / 新 {{ formatRange(row.newRange) }})
                  </span>
                </button>
              </div>
              <div v-else
                   :class="['grid grid-cols-[56px_56px_1fr] gap-2 px-3 py-1 border-b border-neutral-200 dark:border-neutral-800 whitespace-pre-wrap',
                     row.type === 'added' ? 'bg-[var(--g-accent-soft)] dark:bg-[var(--g-accent-strong)] text-[var(--g-accent)]' :
                     row.type === 'removed' ? 'bg-red-100/60 dark:bg-red-900/30 text-red-700 dark:text-red-300' :
                     'text-neutral-800 dark:text-neutral-200']">
                <span class="text-right text-[10px] text-neutral-400">
                  {{ row.oldLine ?? '' }}
                </span>
                <span class="text-right text-[10px] text-neutral-400">
                  {{ row.newLine ?? '' }}
                </span>
                <span>{{ row.text || ' ' }}</span>
              </div>
            </template>
          </div>
          <div v-else class="diff-viewer-split max-h-[28rem] overflow-auto">
            <template v-for="row in diffSplitRows" :key="row.kind === 'fold' ? `fold-${row.id}` : row.key">
              <div v-if="row.kind === 'fold'" class="border-b border-neutral-200 dark:border-neutral-700 bg-neutral-100/60 dark:bg-neutral-800/60 px-3 py-2">
                <button type="button" @click="toggleDiffFold(row.id)"
                        class="inline-flex items-center gap-1 text-[11px] text-neutral-600 dark:text-neutral-300">
                  <span>{{ row.isExpanded ? '折叠' : '展开' }} {{ row.skipped }} 行未变化</span>
                  <span v-if="row.oldRange || row.newRange" class="opacity-60">
                    (旧 {{ formatRange(row.oldRange) }} / 新 {{ formatRange(row.newRange) }})
                  </span>
                </button>
              </div>
              <div v-else class="grid gap-2 px-3 py-1 border-b border-neutral-200 dark:border-neutral-800 text-neutral-800 dark:text-neutral-200 sm:grid-cols-[56px_minmax(0,1fr)_56px_minmax(0,1fr)]">
                <div class="flex items-baseline justify-between sm:block text-[10px] text-neutral-400">
                  <span class="sm:hidden text-neutral-500 mr-2">基准</span>
                  <span>{{ row.left.line ?? '' }}</span>
                </div>
                <span :class="[
                    'block whitespace-pre-wrap',
                    row.changeType === 'removed' || row.changeType === 'modified'
                      ? 'bg-red-100/60 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded'
                      : '']">
                  {{ row.left.text || ' ' }}
                </span>
                <div class="flex items-baseline justify-between sm:block text-[10px] text-neutral-400">
                  <span class="sm:hidden text-neutral-500 mr-2">对比</span>
                  <span>{{ row.right.line ?? '' }}</span>
                </div>
                <span :class="[
                    'block whitespace-pre-wrap',
                    row.changeType === 'added' || row.changeType === 'modified'
                      ? 'bg-[var(--g-accent-soft)] dark:bg-[var(--g-accent-strong)] text-[var(--g-accent)] rounded'
                      : '']">
                  {{ row.right.text || ' ' }}
                </span>
              </div>
            </template>
          </div>
        </template>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { useNuxtApp } from '#imports'
import { formatDateUtc8 } from '~/utils/timezone'

const props = defineProps<{
  wikidotId: string
  pageDisplayTitle: string
  copiedAnchorId: string | null
  pageVersions: any[] | null
  displayedSource: string
  sourceCharacterCount: number
  textContentCharacterCount: number
}>()

const emit = defineEmits<{
  'copy-anchor': [sectionId: string]
  'version-change': [versionId: number | null]
}>()

const { $bff } = useNuxtApp()

const localSelectedVersion = ref<number | null>(null)

watch(() => props.pageVersions, (list) => {
  if (Array.isArray(list) && list.length > 0) {
    const current = list.find((v: any) => !v.validTo)
    localSelectedVersion.value = (current || list[0]).pageVersionId
  } else {
    localSelectedVersion.value = null
  }
}, { immediate: true })

watch(localSelectedVersion, (ver) => {
  emit('version-change', ver)
})

function formatDate(dateStr: string) {
  if (!dateStr) return 'N/A'
  return formatDateUtc8(dateStr, { year: 'numeric', month: 'short', day: 'numeric' }) || 'N/A'
}

// ===== Diff mode state =====
const diffMode = ref(false)
const baseVersionId = ref<number | null>(null)
const compareVersionId = ref<number | null>(null)
const ignoreWhitespace = ref(true)
const diffLoading = ref(false)
const diffError = ref<string | null>(null)
const diffViewMode = ref<'unified' | 'split'>('unified')
const diffCollapseUnchanged = ref(true)
const diffContextLines = ref(3)
const diffExpandedFoldIds = ref<string[]>([])
let diffJobSeq = 0
let diffScheduleHandle: ReturnType<typeof setTimeout> | null = null

type DiffLineType = 'context' | 'added' | 'removed'
interface DiffLine {
  kind: DiffLineType
  text: string
  oldLine: number | null
  newLine: number | null
}
interface DiffContextSegment {
  type: 'context'
  index: number
  lines: DiffLine[]
}
interface DiffChangeSegment {
  type: 'change'
  index: number
  removed: DiffLine[]
  added: DiffLine[]
}
type DiffSegment = DiffContextSegment | DiffChangeSegment

interface DiffPrepared {
  lines: DiffLine[]
  segments: DiffSegment[]
  stats: { added: number; removed: number; blocks: number }
}

interface DiffFoldRow {
  kind: 'fold'
  id: string
  skipped: number
  oldRange: [number, number] | null
  newRange: [number, number] | null
  isExpanded: boolean
}
interface DiffUnifiedLineRow {
  kind: 'line'
  key: string
  type: DiffLineType
  text: string
  oldLine: number | null
  newLine: number | null
}
type DiffUnifiedRow = DiffUnifiedLineRow | DiffFoldRow

interface DiffSplitCell {
  text: string
  line: number | null
}
interface DiffSplitLineRow {
  kind: 'line'
  key: string
  left: DiffSplitCell
  right: DiffSplitCell
  changeType: 'context' | 'added' | 'removed' | 'modified'
}
type DiffSplitRow = DiffSplitLineRow | DiffFoldRow

const diffData = ref<DiffPrepared | null>(null)

const diffSummary = computed(() => diffData.value?.stats ?? { added: 0, removed: 0, blocks: 0 })
const diffHasChanges = computed(() => diffSummary.value.blocks > 0)

watch(diffCollapseUnchanged, () => {
  diffExpandedFoldIds.value = []
})
watch(diffContextLines, (value) => {
  const numeric = Number(value)
  const normalized = Number.isFinite(numeric) ? Math.max(0, Math.min(20, Math.round(numeric))) : 0
  if (normalized !== diffContextLines.value) {
    diffContextLines.value = normalized
    return
  }
  diffExpandedFoldIds.value = []
})

const orderedVersions = computed<any[]>(() => {
  const list = Array.isArray(props.pageVersions) ? [...(props.pageVersions as any[])] : []
  return list.sort((a: any, b: any) => {
    const ta = new Date(a?.createdAt || 0).getTime()
    const tb = new Date(b?.createdAt || 0).getTime()
    return ta - tb
  })
})

interface BuildDiffViewOptions {
  collapse: boolean
  context: number
  expanded: Set<string>
  hasChanges: boolean
}

const diffUnifiedRows = computed<DiffUnifiedRow[]>(() => {
  if (!diffData.value) return []
  return buildUnifiedRows(diffData.value.segments, {
    collapse: diffCollapseUnchanged.value,
    context: Math.max(0, Math.min(20, Math.round(Number(diffContextLines.value) || 0))),
    expanded: new Set(diffExpandedFoldIds.value),
    hasChanges: diffHasChanges.value
  })
})

const diffSplitRows = computed<DiffSplitRow[]>(() => {
  if (!diffData.value) return []
  return buildSplitRows(diffData.value.segments, {
    collapse: diffCollapseUnchanged.value,
    context: Math.max(0, Math.min(20, Math.round(Number(diffContextLines.value) || 0))),
    expanded: new Set(diffExpandedFoldIds.value),
    hasChanges: diffHasChanges.value
  })
})

function resetDiffResults() {
  diffError.value = null
  diffData.value = null
  diffExpandedFoldIds.value = []
}

function toggleDiffMode() {
  diffMode.value = !diffMode.value
  if (diffMode.value) {
    const list = orderedVersions.value
    if (list.length === 0) {
      baseVersionId.value = null
      compareVersionId.value = null
    } else {
      const currentId = localSelectedVersion.value
      const idx = currentId != null ? list.findIndex((v: any) => v.pageVersionId === currentId) : list.length - 1
      const prevIdx = Math.max(0, Math.min(list.length - 1, idx - 1))
      const nextIdx = Math.max(0, Math.min(list.length - 1, idx))
      baseVersionId.value = list[prevIdx]?.pageVersionId ?? null
      compareVersionId.value = list[nextIdx]?.pageVersionId ?? null
    }
    resetDiffResults()
    scheduleDiff()
  } else {
    if (diffScheduleHandle) {
      clearTimeout(diffScheduleHandle)
      diffScheduleHandle = null
    }
    diffLoading.value = false
    resetDiffResults()
  }
}

watch([baseVersionId, compareVersionId, () => ignoreWhitespace.value], () => {
  if (!diffMode.value) return
  scheduleDiff()
})

const versionSourceCache = new Map<number, string | null>()

async function getSourceForVersion(verId: number): Promise<string> {
  if (versionSourceCache.has(verId)) {
    return String(versionSourceCache.get(verId) || '')
  }
  const resp = await $bff(`/pages/${props.wikidotId}/versions/${verId}/source`)
  const text = (resp && typeof resp.source === 'string') ? resp.source : ''
  versionSourceCache.set(verId, text)
  return text
}

async function runDiff() {
  if (!diffMode.value) return
  if (baseVersionId.value == null || compareVersionId.value == null) {
    diffLoading.value = false
    diffError.value = null
    diffData.value = null
    diffExpandedFoldIds.value = []
    return
  }
  const jobId = ++diffJobSeq
  diffLoading.value = true
  diffError.value = null
  diffData.value = null
  diffExpandedFoldIds.value = []
  try {
    const [baseText, compareText] = await Promise.all([
      getSourceForVersion(Number(baseVersionId.value)),
      getSourceForVersion(Number(compareVersionId.value))
    ])
    const diffLib: any = await import('diff')
    const parts = (diffLib?.diffLines || diffLib?.default?.diffLines)?.call(diffLib, String(baseText), String(compareText), {
      ignoreWhitespace: !!ignoreWhitespace.value
    }) || []
    if (jobId !== diffJobSeq) return
    diffData.value = Array.isArray(parts) ? prepareDiffData(parts) : { lines: [], segments: [], stats: { added: 0, removed: 0, blocks: 0 } }
  } catch {
    if (jobId !== diffJobSeq) return
    diffError.value = '对比失败'
  } finally {
    if (jobId === diffJobSeq) diffLoading.value = false
  }
}

function scheduleDiff(immediate = false) {
  if (!diffMode.value) return
  if (diffScheduleHandle) {
    clearTimeout(diffScheduleHandle)
    diffScheduleHandle = null
  }
  if (immediate) {
    runDiff()
    return
  }
  diffScheduleHandle = setTimeout(() => {
    diffScheduleHandle = null
    runDiff()
  }, 120)
}

function prepareDiffData(parts: Array<{ value: string; added?: boolean; removed?: boolean }>): DiffPrepared {
  let oldLine = 1
  let newLine = 1
  let added = 0
  let removed = 0
  const lines: DiffLine[] = []

  parts.forEach((part) => {
    const chunkLines = extractDiffLines(part)
    chunkLines.forEach((text) => {
      if (part?.added) {
        lines.push({ kind: 'added', text, oldLine: null, newLine })
        newLine += 1
        added += 1
      } else if (part?.removed) {
        lines.push({ kind: 'removed', text, oldLine, newLine: null })
        oldLine += 1
        removed += 1
      } else {
        lines.push({ kind: 'context', text, oldLine, newLine })
        oldLine += 1
        newLine += 1
      }
    })
  })

  const segments = buildSegments(lines)
  return {
    lines,
    segments,
    stats: {
      added,
      removed,
      blocks: segments.filter((seg) => seg.type === 'change').length
    }
  }
}

function extractDiffLines(part: { value?: string; added?: boolean; removed?: boolean; count?: number }): string[] {
  const raw = String(part?.value ?? '').replace(/\r/g, '')
  if (!raw) {
    return part?.added || part?.removed ? [''] : []
  }
  const lines = raw.split('\n')
  if (raw.endsWith('\n')) {
    lines.pop()
  }
  return lines.length ? lines : ['']
}

function buildSegments(lines: DiffLine[]): DiffSegment[] {
  type PendingSegment = { type: 'context'; lines: DiffLine[] } | { type: 'change'; removed: DiffLine[]; added: DiffLine[] }
  const segments: PendingSegment[] = []
  let contextBuffer: DiffLine[] = []
  let removedBuffer: DiffLine[] = []
  let addedBuffer: DiffLine[] = []

  const pushContext = () => {
    if (contextBuffer.length) {
      segments.push({ type: 'context', lines: contextBuffer })
      contextBuffer = []
    }
  }
  const pushChange = () => {
    if (removedBuffer.length || addedBuffer.length) {
      segments.push({ type: 'change', removed: removedBuffer, added: addedBuffer })
      removedBuffer = []
      addedBuffer = []
    }
  }

  lines.forEach((line) => {
    if (line.kind === 'context') {
      pushChange()
      contextBuffer.push(line)
    } else if (line.kind === 'removed') {
      pushContext()
      removedBuffer.push(line)
    } else if (line.kind === 'added') {
      pushContext()
      addedBuffer.push(line)
    }
  })

  pushChange()
  pushContext()

  return segments.map((seg, idx) => seg.type === 'context'
    ? { type: 'context', index: idx, lines: seg.lines }
    : { type: 'change', index: idx, removed: seg.removed, added: seg.added })
}

function buildUnifiedRows(segments: DiffSegment[], options: BuildDiffViewOptions): DiffUnifiedRow[] {
  const rows: DiffUnifiedRow[] = []
  if (!segments.length) return rows

  const { collapse, context, expanded, hasChanges } = options
  const changeAfter: boolean[] = new Array(segments.length).fill(false)
  let seenChangeAhead = false
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    changeAfter[i] = seenChangeAhead
    if (segments[i].type === 'change') {
      seenChangeAhead = true
    }
  }

  let seenChange = false
  let keyCounter = 0
  const pushLine = (line: DiffLine, override?: DiffLineType) => {
    rows.push({
      kind: 'line',
      key: `u-${keyCounter++}`,
      type: override ?? line.kind,
      text: line.text,
      oldLine: line.oldLine,
      newLine: line.newLine
    })
  }

  segments.forEach((segment) => {
    if (segment.type === 'change') {
      seenChange = true
      segment.removed.forEach((line) => pushLine(line, 'removed'))
      segment.added.forEach((line) => pushLine(line, 'added'))
      return
    }

    const lines = segment.lines
    if (!collapse || !hasChanges) {
      lines.forEach((line) => pushLine(line, 'context'))
      return
    }

    const keepBefore = seenChange ? context : 0
    const keepAfter = changeAfter[segment.index] ? context : 0
    if (keepBefore + keepAfter >= lines.length) {
      lines.forEach((line) => pushLine(line, 'context'))
      return
    }

    const head = keepBefore > 0 ? lines.slice(0, keepBefore) : []
    const tail = keepAfter > 0 ? lines.slice(lines.length - keepAfter) : []
    const hidden = lines.slice(keepBefore, lines.length - keepAfter)

    head.forEach((line) => pushLine(line, 'context'))
    if (hidden.length) {
      const foldRow = createFoldRow(`context-${segment.index}`, hidden, expanded)
      rows.push(foldRow)
      if (foldRow.isExpanded) {
        hidden.forEach((line) => pushLine(line, 'context'))
      }
    }
    tail.forEach((line) => pushLine(line, 'context'))
  })

  return rows
}

function buildSplitRows(segments: DiffSegment[], options: BuildDiffViewOptions): DiffSplitRow[] {
  const rows: DiffSplitRow[] = []
  if (!segments.length) return rows

  const { collapse, context, expanded, hasChanges } = options
  const changeAfter: boolean[] = new Array(segments.length).fill(false)
  let seenChangeAhead = false
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    changeAfter[i] = seenChangeAhead
    if (segments[i].type === 'change') {
      seenChangeAhead = true
    }
  }

  let seenChange = false
  let keyCounter = 0
  const pushContextRow = (line: DiffLine) => {
    rows.push({
      kind: 'line',
      key: `s-${keyCounter++}`,
      left: { text: line.text, line: line.oldLine },
      right: { text: line.text, line: line.newLine },
      changeType: 'context'
    })
  }

  segments.forEach((segment) => {
    if (segment.type === 'change') {
      seenChange = true
      const maxLen = Math.max(segment.removed.length, segment.added.length)
      for (let idx = 0; idx < maxLen; idx += 1) {
        const leftLine = segment.removed[idx]
        const rightLine = segment.added[idx]
        const changeType: 'added' | 'removed' | 'modified' = leftLine && rightLine
          ? 'modified'
          : leftLine
            ? 'removed'
            : 'added'
        rows.push({
          kind: 'line',
          key: `s-${keyCounter++}`,
          left: { text: leftLine ? leftLine.text : '', line: leftLine?.oldLine ?? null },
          right: { text: rightLine ? rightLine.text : '', line: rightLine?.newLine ?? null },
          changeType
        })
      }
      return
    }

    const lines = segment.lines
    if (!collapse || !hasChanges) {
      lines.forEach((line) => pushContextRow(line))
      return
    }

    const keepBefore = seenChange ? context : 0
    const keepAfter = changeAfter[segment.index] ? context : 0
    if (keepBefore + keepAfter >= lines.length) {
      lines.forEach((line) => pushContextRow(line))
      return
    }

    const head = keepBefore > 0 ? lines.slice(0, keepBefore) : []
    const tail = keepAfter > 0 ? lines.slice(lines.length - keepAfter) : []
    const hidden = lines.slice(keepBefore, lines.length - keepAfter)

    head.forEach((line) => pushContextRow(line))
    if (hidden.length) {
      const foldRow = createFoldRow(`context-${segment.index}`, hidden, expanded)
      rows.push(foldRow)
      if (foldRow.isExpanded) {
        hidden.forEach((line) => pushContextRow(line))
      }
    }
    tail.forEach((line) => pushContextRow(line))
  })

  return rows
}

function createFoldRow(id: string, lines: DiffLine[], expanded: Set<string>): DiffFoldRow {
  return {
    kind: 'fold',
    id,
    skipped: lines.length,
    oldRange: rangeFromLines(lines, 'oldLine'),
    newRange: rangeFromLines(lines, 'newLine'),
    isExpanded: expanded.has(id)
  }
}

function rangeFromLines(lines: DiffLine[], key: 'oldLine' | 'newLine'): [number, number] | null {
  const values = lines
    .map((line) => line[key])
    .filter((value): value is number => typeof value === 'number')
  if (!values.length) return null
  return [values[0], values[values.length - 1]]
}

function toggleDiffFold(id: string) {
  if (!id) return
  if (diffExpandedFoldIds.value.includes(id)) {
    diffExpandedFoldIds.value = diffExpandedFoldIds.value.filter((item) => item !== id)
  } else {
    diffExpandedFoldIds.value = [...diffExpandedFoldIds.value, id]
  }
}

function formatRange(range: [number, number] | null): string {
  if (!range) return '--'
  const [start, end] = range
  if (start == null || end == null) return '--'
  return start === end ? String(start) : `${start}-${end}`
}

function copySource() {
  const text = props.displayedSource || ''
  if (!text || text === '加载中...' || text === '暂无源码') return
  navigator.clipboard?.writeText(text).catch(() => {})
}

function downloadSource() {
  const text = props.displayedSource || ''
  if (!text || text === '加载中...' || text === '暂无源码') return
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${props.pageDisplayTitle || 'source'}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch {
    // Blob downloads can fail in restricted environments.
  }
}

onBeforeUnmount(() => {
  if (diffScheduleHandle) {
    clearTimeout(diffScheduleHandle)
    diffScheduleHandle = null
  }
})
</script>

<style scoped>
.source-code-block,
.source-code-block * {
  user-select: text;
  -webkit-user-select: text;
}

.diff-label {
  white-space: nowrap;
}

.diff-chip {
  transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.diff-chip--toggles {
  align-items: flex-start;
}

@media (min-width: 640px) {
  .diff-chip--toggles {
    align-items: center;
  }
}

.diff-view-toggle__btn {
  border: none;
  cursor: pointer;
}

.diff-view-toggle__btn:focus-visible {
  outline: 2px solid var(--g-accent-border);
  outline-offset: 1px;
}

.diff-select--narrow {
  max-width: 5.5rem;
}

@media (min-width: 640px) {
  .diff-select--narrow {
    max-width: 4.5rem;
  }
}
</style>
