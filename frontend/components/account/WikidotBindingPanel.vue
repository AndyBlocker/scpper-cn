<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useWikidotBinding } from '~/composables/useWikidotBinding'
import { normalizeBffBase, resolveAssetUrl } from '~/utils/assetUrl'

const {
  currentTask,
  instructions,
  loading,
  refreshing,
  statusKnown,
  error,
  resolveUsers,
  isPending,
  isExpired,
  hasTask,
  fetchStatus,
  startBinding,
  cancelBinding,
  getTimeRemaining,
  formatLastChecked
} = useWikidotBinding()

const runtimeConfig = useRuntimeConfig()
const bffBase = normalizeBffBase((runtimeConfig.public as any)?.bffBase as string)

const query = ref('')
const candidates = ref<Array<{ wikidotId: number; displayName: string | null; username: string | null }>>([])
const selectedUser = ref<{ wikidotId: number; displayName: string | null; username: string | null } | null>(null)
const resolving = ref(false)
const resolveError = ref<string | null>(null)
const resolveComplete = ref(false)
const activeCandidateIndex = ref(-1)
let resolveTimer: ReturnType<typeof setTimeout> | null = null
let resolveRequestId = 0

const copied = ref(false)
const nowMs = ref(Date.now())
const STATUS_POLL_INTERVAL_MS = 30_000
const CLOCK_INTERVAL_MS = 30_000
let statusPollTimer: ReturnType<typeof setTimeout> | null = null
let clockTimer: ReturnType<typeof setInterval> | null = null
let copiedTimer: ReturnType<typeof setTimeout> | null = null
let componentMounted = false

const verificationPageUrl = computed(() => instructions.value?.targetPage || 'https://scp-wiki-cn.wikidot.com/andyblocker')
const timeRemainingLabel = computed(() => {
  const remaining = getTimeRemaining(nowMs.value)
  if (!remaining || remaining === '已过期') return remaining
  return `${remaining} 后过期`
})
const candidateListOpen = computed(() => !selectedUser.value && candidates.value.length > 0)
const activeCandidateId = computed(() => {
  if (!candidateListOpen.value || activeCandidateIndex.value < 0) return undefined
  return `wikidot-candidate-${candidates.value[activeCandidateIndex.value]?.wikidotId}`
})
const searchStatusLabel = computed(() => {
  if (resolving.value) return '正在搜索 Wikidot 用户'
  if (selectedUser.value) return `已选择 ${selectedLabel.value}`
  if (candidateListOpen.value) {
    return `找到 ${candidates.value.length} 个匹配用户。使用上下方向键浏览，按回车选择。`
  }
  if (resolveComplete.value && query.value.trim() && !resolveError.value) {
    return '没有找到匹配用户'
  }
  return ''
})

function clearStatusPoll() {
  if (!statusPollTimer) return
  clearTimeout(statusPollTimer)
  statusPollTimer = null
}

function scheduleStatusPoll() {
  clearStatusPoll()
  if (!componentMounted || !isPending.value || loading.value || document.hidden) return

  statusPollTimer = setTimeout(() => {
    statusPollTimer = null
    if (loading.value) return
    void refreshStatusAndSchedule()
  }, STATUS_POLL_INTERVAL_MS)
}

async function refreshStatusAndSchedule() {
  try {
    await fetchStatus()
  } finally {
    nowMs.value = Date.now()
    scheduleStatusPoll()
  }
}

async function handleRefreshStatus() {
  await refreshStatusAndSchedule()
}

function handleVisibilityChange() {
  if (document.hidden) {
    clearStatusPoll()
    return
  }
  if (isPending.value && !loading.value) {
    void refreshStatusAndSchedule()
  }
}

onMounted(() => {
  componentMounted = true
  clockTimer = setInterval(() => {
    nowMs.value = Date.now()
  }, CLOCK_INTERVAL_MS)
  document.addEventListener('visibilitychange', handleVisibilityChange)
  void refreshStatusAndSchedule()
})

onBeforeUnmount(() => {
  componentMounted = false
  resolveRequestId++
  if (resolveTimer) clearTimeout(resolveTimer)
  if (clockTimer) clearInterval(clockTimer)
  if (copiedTimer) clearTimeout(copiedTimer)
  clearStatusPoll()
  document.removeEventListener('visibilitychange', handleVisibilityChange)
})

watch([isPending, loading], ([pending, busy]) => {
  if (pending && !busy) scheduleStatusPoll()
  else clearStatusPoll()
})

watch(query, (value) => {
  const requestId = ++resolveRequestId
  const trimmed = value.trim()
  resolveError.value = null
  resolveComplete.value = false
  selectedUser.value = null
  candidates.value = []
  activeCandidateIndex.value = -1

  if (resolveTimer) {
    clearTimeout(resolveTimer)
    resolveTimer = null
  }

  if (!trimmed) {
    resolving.value = false
    return
  }

  resolveTimer = setTimeout(async () => {
    resolveTimer = null
    resolving.value = true
    const res = await resolveUsers(trimmed, 8)
    if (requestId !== resolveRequestId) return

    resolveComplete.value = true
    if (res.ok) {
      candidates.value = res.users
      activeCandidateIndex.value = res.users.length > 0 ? 0 : -1
      if (res.users.length === 1) {
        selectedUser.value = res.users[0]
      }
    } else {
      resolveError.value = res.error || '搜索失败'
    }
    resolving.value = false
  }, 250)
})

const selectedLabel = computed(() => {
  if (!selectedUser.value) return ''
  const title = selectedUser.value.displayName || selectedUser.value.username || `User ${selectedUser.value.wikidotId}`
  const username = selectedUser.value.username ? `@${selectedUser.value.username}` : ''
  return `${title}${username ? ` (${username})` : ''}`
})

function avatarUrlFor(wikidotId: number): string {
  return resolveAssetUrl(`/avatar/${wikidotId}`, bffBase)
}

async function handleStartBinding() {
  const trimmed = query.value.trim()
  if (!trimmed && !selectedUser.value) return

  const payload = selectedUser.value
    ? { wikidotId: selectedUser.value.wikidotId }
    : (/^\d+$/.test(trimmed) ? { wikidotId: Number(trimmed) } : { wikidotUsername: trimmed })

  const result = await startBinding(payload)
  if (result.ok) {
    query.value = ''
    candidates.value = []
    selectedUser.value = null
  }
}

async function handleCancel() {
  await cancelBinding()
}

async function handleRetry() {
  await cancelBinding()
}

async function copyCode() {
  if (!currentTask.value?.verificationCode) return
  try {
    await navigator.clipboard.writeText(currentTask.value.verificationCode)
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false }, 2000)
  } catch {
    error.value = '复制失败，请手动选择验证码复制'
  }
}

function selectCandidate(user: { wikidotId: number; displayName: string | null; username: string | null }) {
  selectedUser.value = user
  candidates.value = []
  activeCandidateIndex.value = -1
  resolveError.value = null
}

function clearSelection() {
  selectedUser.value = null
  resolveComplete.value = false
}

function setActiveCandidate(index: number) {
  activeCandidateIndex.value = index
  void nextTick(() => {
    if (!activeCandidateId.value) return
    document.getElementById(activeCandidateId.value)?.scrollIntoView({ block: 'nearest' })
  })
}

function handleSearchKeydown(event: KeyboardEvent) {
  if (!candidateListOpen.value) return

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    setActiveCandidate((activeCandidateIndex.value + 1) % candidates.value.length)
    return
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault()
    setActiveCandidate(activeCandidateIndex.value <= 0
      ? candidates.value.length - 1
      : activeCandidateIndex.value - 1)
    return
  }
  if (event.key === 'Home') {
    event.preventDefault()
    setActiveCandidate(0)
    return
  }
  if (event.key === 'End') {
    event.preventDefault()
    setActiveCandidate(candidates.value.length - 1)
    return
  }
  if (event.key === 'Enter' && activeCandidateIndex.value >= 0) {
    event.preventDefault()
    const candidate = candidates.value[activeCandidateIndex.value]
    if (candidate) selectCandidate(candidate)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    candidates.value = []
    activeCandidateIndex.value = -1
    resolveComplete.value = false
  }
}
</script>

<template>
  <section
    class="space-y-5 rounded-lg border border-neutral-200 bg-neutral-50 p-5 dark:border-neutral-700 dark:bg-neutral-800"
    aria-labelledby="wikidot-identity-heading"
  >
    <header class="space-y-1">
      <h2 id="wikidot-identity-heading" class="text-base font-semibold text-neutral-900 dark:text-neutral-100">
        连接 Wikidot 身份
      </h2>
      <p class="text-sm leading-6 text-neutral-600 dark:text-neutral-400">
        将站内账户与 Wikidot 用户关联，用于确认你的社区身份和使用需要身份验证的功能。
      </p>
    </header>

    <div
      v-if="error"
      class="rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20"
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
    >
      <div class="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div class="flex items-start gap-2">
          <svg class="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div class="text-sm text-red-700 dark:text-red-300">{{ error }}</div>
        </div>
        <button
          v-if="!hasTask"
          type="button"
          :disabled="loading || refreshing"
          class="inline-flex min-h-11 shrink-0 items-center self-end rounded-md px-3 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-50 sm:self-auto dark:text-red-300 dark:hover:bg-red-900/30"
          @click="handleRefreshStatus"
        >
          {{ refreshing ? '检查中...' : '重新检查' }}
        </button>
      </div>
    </div>

    <template v-if="!hasTask && !statusKnown">
      <div class="py-4 text-center text-sm text-neutral-500 dark:text-neutral-400" role="status" aria-live="polite">
        {{ refreshing ? '正在检查现有连接任务...' : '尚未确认连接状态，请先重新检查。' }}
      </div>
    </template>

    <!-- No task: Show start form only after the server confirms there is no task. -->
    <template v-else-if="!hasTask">
      <form class="space-y-4" @submit.prevent="handleStartBinding">
        <div class="space-y-1.5">
          <label
            for="wikidot-identity-search"
            class="text-sm font-semibold text-neutral-700 dark:text-neutral-300"
          >
            Wikidot 用户名或 ID
          </label>
          <input
            id="wikidot-identity-search"
            v-model="query"
            type="text"
            role="combobox"
            autocomplete="off"
            spellcheck="false"
            aria-autocomplete="list"
            aria-describedby="wikidot-search-hint wikidot-search-status"
            :aria-controls="candidateListOpen ? 'wikidot-identity-results' : undefined"
            :aria-expanded="candidateListOpen"
            :aria-activedescendant="activeCandidateId"
            :aria-busy="resolving"
            placeholder="输入 Wikidot 用户名/昵称，或 Wikidot ID（数字）"
            class="min-h-11 w-full rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm focus:border-[var(--g-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-600 dark:bg-neutral-700"
            :disabled="loading || refreshing"
            @keydown="handleSearchKeydown"
          >
          <p id="wikidot-search-hint" class="text-xs leading-5 text-neutral-500 dark:text-neutral-400">
            优先从搜索结果中选择；使用数字 Wikidot ID 最准确。
          </p>
          <p id="wikidot-search-status" class="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {{ searchStatusLabel }}
          </p>
        </div>

        <div
          v-if="resolveError"
          class="rounded-md border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20"
          role="alert"
          aria-live="assertive"
          aria-atomic="true"
        >
          <div class="text-sm text-red-700 dark:text-red-300">{{ resolveError }}</div>
        </div>

        <div v-if="selectedUser" class="rounded-md border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900/20">
          <div class="flex items-center gap-3">
            <img
              :src="avatarUrlFor(selectedUser.wikidotId)"
              alt=""
              class="h-10 w-10 rounded-full border border-neutral-200 dark:border-neutral-700"
              loading="lazy"
              referrerpolicy="no-referrer"
            />
            <div class="min-w-0">
              <div class="text-sm font-semibold text-neutral-800 dark:text-neutral-100 truncate">
                已选择：{{ selectedLabel }}
              </div>
              <div class="text-xs text-neutral-500 dark:text-neutral-400">
                Wikidot ID: <span class="font-mono">{{ selectedUser.wikidotId }}</span>
              </div>
            </div>
            <button
              type="button"
              :aria-label="`清除已选择的 Wikidot 用户：${selectedLabel}`"
              class="ml-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded-md px-3 text-xs font-semibold text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
              @click="clearSelection"
            >
              清除
            </button>
          </div>
        </div>

        <div
          v-else-if="candidateListOpen"
          class="rounded-md border border-neutral-200 bg-white p-2 dark:border-neutral-700 dark:bg-neutral-900/20"
        >
          <div class="px-2 pb-2 text-xs font-semibold text-neutral-600 dark:text-neutral-400">请选择匹配用户</div>
          <ul
            id="wikidot-identity-results"
            class="max-h-52 overflow-auto"
            role="listbox"
            aria-label="Wikidot 用户搜索结果"
          >
            <li
              v-for="(user, index) in candidates"
              :key="user.wikidotId"
              :id="`wikidot-candidate-${user.wikidotId}`"
              role="option"
              :aria-selected="candidates[activeCandidateIndex]?.wikidotId === user.wikidotId"
              class="flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-md px-2 py-2"
              :class="candidates[activeCandidateIndex]?.wikidotId === user.wikidotId
                ? 'bg-[var(--g-accent-soft)] text-[var(--g-accent)]'
                : 'hover:bg-neutral-50 dark:hover:bg-neutral-800/50'"
              @mouseenter="activeCandidateIndex = index"
              @mousedown.prevent
              @click="selectCandidate(user)"
            >
              <img
                :src="avatarUrlFor(user.wikidotId)"
                alt=""
                class="h-8 w-8 rounded-full border border-neutral-200 dark:border-neutral-700 flex-shrink-0"
                loading="lazy"
                referrerpolicy="no-referrer"
              />
              <div class="min-w-0 text-left">
                <div class="text-sm font-medium text-neutral-800 dark:text-neutral-100 truncate">
                  {{ user.displayName || user.username || `User ${user.wikidotId}` }}
                </div>
                <div class="text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
                  <span v-if="user.username">@{{ user.username }}</span>
                  <span v-if="user.username"> · </span>
                  ID: <span class="font-mono">{{ user.wikidotId }}</span>
                </div>
              </div>
            </li>
          </ul>
        </div>

        <p
          v-else-if="resolveComplete && query.trim() && !resolving && !resolveError"
          class="rounded-md border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/20 dark:text-neutral-300"
        >
          没有找到匹配用户。请检查用户名，或直接输入准确的数字 ID。
        </p>

        <button
          type="submit"
          :disabled="(!query.trim() && !selectedUser) || loading || refreshing || resolving"
          class="inline-flex min-h-11 items-center justify-center rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white dark:focus:ring-neutral-100 dark:focus:ring-offset-neutral-950"
        >
          {{ refreshing ? '检查连接状态...' : (loading ? '处理中...' : (resolving ? '搜索中...' : '开始连接')) }}
        </button>
      </form>
    </template>

    <!-- Pending task: Show verification code and instructions -->
    <template v-else-if="isPending">
      <div class="space-y-4">
        <div class="flex items-start justify-between gap-3">
          <div>
            <div class="text-sm font-semibold dark:text-neutral-200">Wikidot 身份验证进行中</div>
            <div class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
              目标：{{ currentTask?.wikidotUsername || `Wikidot 用户 #${currentTask?.wikidotUserId}` }}
              <span class="font-mono">（ID: {{ currentTask?.wikidotUserId }}）</span>
            </div>
          </div>
          <span class="text-xs text-neutral-500">
            {{ timeRemainingLabel }}
          </span>
        </div>

        <div class="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-4 dark:border-amber-700 dark:bg-amber-900/20">
          <div class="text-sm font-medium text-amber-800 dark:text-amber-300">验证码</div>
          <div class="font-mono text-lg font-bold text-amber-900 select-all dark:text-amber-200">
            {{ currentTask?.verificationCode }}
          </div>
          <button
            type="button"
            class="inline-flex min-h-11 items-center rounded-md px-3 text-xs font-semibold text-amber-700 hover:bg-amber-100 dark:text-amber-300 dark:hover:bg-amber-900/30"
            @click="copyCode"
          >
            {{ copied ? '已复制!' : '点击复制' }}
          </button>
        </div>

        <div class="text-sm text-neutral-600 dark:text-neutral-400 space-y-2">
          <p class="font-semibold">操作步骤：</p>
          <ol class="list-decimal list-inside space-y-1 text-xs">
            <li>
              访问
              <a
                :href="verificationPageUrl"
                target="_blank"
                rel="noopener"
                class="text-[var(--g-accent)] hover:underline"
              >
                验证页面
              </a>
            </li>
            <li>点击页面右下角的「编辑」按钮</li>
            <li>按照验证页面的说明，仅在指定的隐藏 DIV 内小幅修改源码，以确保生成新的 Revision；不要把验证码写进源码</li>
            <li>在「本次编辑的简要说明:」框中填入验证码：<code class="rounded bg-neutral-200 px-1 dark:bg-neutral-600">{{ currentTask?.verificationCode }}</code></li>
            <li>保存页面</li>
            <li>等待系统自动验证（通常需要数小时，最长 48 小时）</li>
          </ol>
        </div>

        <div class="flex flex-col gap-2 border-t border-neutral-200 pt-2 sm:flex-row sm:items-center sm:justify-between dark:border-neutral-700">
          <span class="text-xs text-neutral-500">
            已检查 {{ currentTask?.checkCount || 0 }} 次
            <span v-if="currentTask?.lastCheckedAt">
              · 上次：{{ formatLastChecked() }}
            </span>
          </span>
          <div class="flex items-center gap-3">
            <button
              type="button"
              :disabled="loading || refreshing"
              class="inline-flex min-h-11 items-center rounded-md px-3 text-xs font-semibold text-[var(--g-accent)] hover:bg-[var(--g-accent-soft)] disabled:cursor-not-allowed disabled:opacity-50"
              @click="handleRefreshStatus"
            >
              {{ refreshing ? '刷新中...' : '立即刷新' }}
            </button>
            <button
              type="button"
              :disabled="loading || refreshing"
              class="inline-flex min-h-11 items-center rounded-md px-3 text-xs font-semibold text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:text-red-300 dark:hover:bg-red-900/20"
              @click="handleCancel"
            >
              取消连接
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- Expired task -->
    <template v-else-if="isExpired">
      <div class="text-center py-4">
        <div class="mb-2 text-amber-600 dark:text-amber-400">身份验证任务已过期</div>
        <div class="flex flex-wrap items-center justify-center gap-2">
          <button
            type="button"
            :disabled="loading || refreshing"
            class="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold text-neutral-600 hover:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-700"
            @click="handleRefreshStatus"
          >
            {{ refreshing ? '刷新中...' : '刷新状态' }}
          </button>
          <button
            type="button"
            :disabled="loading || refreshing"
            class="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold text-[var(--g-accent)] hover:bg-[var(--g-accent-soft)] disabled:cursor-not-allowed disabled:opacity-50"
            @click="handleRetry"
          >
            清除任务并重新连接
          </button>
        </div>
      </div>
    </template>

    <template v-else>
      <div class="space-y-3 py-3 text-center">
        <div class="text-sm text-neutral-600 dark:text-neutral-300">连接任务状态已更新，请刷新确认。</div>
        <button
          type="button"
          :disabled="loading || refreshing"
          class="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-semibold text-[var(--g-accent)] hover:bg-[var(--g-accent-soft)] disabled:cursor-not-allowed disabled:opacity-50"
          @click="handleRefreshStatus"
        >
          {{ refreshing ? '刷新中...' : '刷新状态' }}
        </button>
      </div>
    </template>
  </section>
</template>
