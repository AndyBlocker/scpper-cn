<script setup lang="ts">
import { ref, onMounted, watch, computed } from 'vue'
import { useWikidotBinding } from '~/composables/useWikidotBinding'
import { normalizeBffBase, resolveAssetUrl } from '~/utils/assetUrl'

const {
  currentTask,
  instructions,
  loading,
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
let resolveTimer: ReturnType<typeof setTimeout> | null = null

const copied = ref(false)

onMounted(() => {
  fetchStatus()
})

watch(query, (value) => {
  const trimmed = value.trim()
  resolveError.value = null
  selectedUser.value = null
  candidates.value = []

  if (resolveTimer) {
    clearTimeout(resolveTimer)
    resolveTimer = null
  }

  if (!trimmed) {
    resolving.value = false
    return
  }

  resolveTimer = setTimeout(async () => {
    resolving.value = true
    const res = await resolveUsers(trimmed, 8)
    if (res.ok) {
      candidates.value = res.users
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

function copyCode() {
  if (!currentTask.value?.verificationCode) return
  navigator.clipboard.writeText(currentTask.value.verificationCode)
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}

function selectCandidate(user: { wikidotId: number; displayName: string | null; username: string | null }) {
  selectedUser.value = user
  candidates.value = []
  resolveError.value = null
}

function clearSelection() {
  selectedUser.value = null
}
</script>

<template>
  <div class="rounded-lg border border-neutral-200 bg-neutral-50 p-4 space-y-4 dark:border-neutral-700 dark:bg-neutral-800">
    <!-- No task: Show start form -->
    <template v-if="!hasTask">
      <form @submit.prevent="handleStartBinding" class="space-y-3">
        <div>
          <label class="text-xs font-semibold text-neutral-600 dark:text-neutral-400">Wikidot 用户</label>
          <input
            v-model="query"
            type="text"
            placeholder="输入 Wikidot 用户名/昵称，或 Wikidot ID（数字）"
            class="w-full mt-1 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-600 dark:bg-neutral-700"
            :disabled="loading || resolving"
          />
          <div class="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
            建议从下方选单选择（可通过头像判断），并使用 Wikidot ID 绑定更准确。
          </div>
        </div>

        <div v-if="resolveError" class="rounded-xl bg-red-50 border border-red-200 p-3 dark:bg-red-900/20 dark:border-red-800">
          <div class="text-sm text-red-700 dark:text-red-300">{{ resolveError }}</div>
        </div>

        <div v-if="selectedUser" class="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900/20">
          <div class="flex items-center gap-3">
            <img
              :src="avatarUrlFor(selectedUser.wikidotId)"
              :alt="selectedLabel"
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
              class="ml-auto text-xs text-neutral-500 hover:underline dark:text-neutral-400"
              @click="clearSelection"
            >
              清除
            </button>
          </div>
        </div>

        <div v-else-if="candidates.length" class="rounded-xl border border-neutral-200 bg-white p-2 dark:border-neutral-700 dark:bg-neutral-900/20">
          <div class="text-xs font-semibold text-neutral-600 dark:text-neutral-400 px-2 pb-2">请选择匹配用户</div>
          <div class="max-h-52 overflow-auto">
            <button
              v-for="user in candidates"
              :key="user.wikidotId"
              type="button"
              class="w-full flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800/50"
              @click="selectCandidate(user)"
            >
              <img
                :src="avatarUrlFor(user.wikidotId)"
                :alt="user.displayName || user.username || `User ${user.wikidotId}`"
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
            </button>
          </div>
        </div>

        <!-- Error message with better styling -->
        <div v-if="error" class="rounded-xl bg-red-50 border border-red-200 p-3 dark:bg-red-900/20 dark:border-red-800">
          <div class="flex items-start gap-2">
            <svg class="w-4 h-4 text-red-500 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div class="text-sm text-red-700 dark:text-red-300">{{ error }}</div>
          </div>
        </div>
        <button
          type="submit"
          :disabled="(!query.trim() && !selectedUser) || loading || resolving"
          class="rounded-full bg-[var(--g-accent)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ loading ? '处理中...' : (resolving ? '搜索中...' : '开始绑定') }}
        </button>
      </form>
    </template>

    <!-- Pending task: Show verification code and instructions -->
    <template v-else-if="isPending">
      <div class="space-y-4">
        <div class="flex items-center justify-between">
          <span class="text-sm font-semibold dark:text-neutral-200">验证进行中</span>
          <span class="text-xs text-neutral-500">
            {{ getTimeRemaining() }} 后过期
          </span>
        </div>

        <div class="rounded-xl bg-amber-50 border border-amber-200 p-4 space-y-2 dark:bg-amber-900/20 dark:border-amber-700">
          <div class="text-sm font-medium text-amber-800 dark:text-amber-300">验证码</div>
          <div class="font-mono text-lg font-bold text-amber-900 select-all dark:text-amber-200">
            {{ currentTask?.verificationCode }}
          </div>
          <button @click="copyCode" class="text-xs text-amber-700 hover:underline dark:text-amber-400">
            {{ copied ? '已复制!' : '点击复制' }}
          </button>
        </div>

        <div class="text-sm text-neutral-600 dark:text-neutral-400 space-y-2">
          <p class="font-semibold">操作步骤：</p>
          <ol class="list-decimal list-inside space-y-1 text-xs">
            <li>
              访问
              <a
                href="https://scp-wiki-cn.wikidot.com/andyblocker"
                target="_blank"
                rel="noopener"
                class="text-[var(--g-accent)] hover:underline"
              >
                验证页面
              </a>
            </li>
            <li>点击页面右下角的「编辑」按钮</li>
            <li>
              在「本次编辑的简要说明:」框中填入验证码，注意需要在源代码中做一定修改。请按照页面指令修改内容。
              <code class="bg-neutral-200 dark:bg-neutral-600 px-1 rounded">{{ currentTask?.verificationCode }}</code>
            </li>
            <li>保存页面</li>
            <li>等待系统自动验证（通常需要数小时，最长 48 小时）</li>
          </ol>
        </div>

        <div class="flex items-center justify-between pt-2 border-t border-neutral-200 dark:border-neutral-700">
          <span class="text-xs text-neutral-500">
            已检查 {{ currentTask?.checkCount || 0 }} 次
            <span v-if="currentTask?.lastCheckedAt">
              · 上次：{{ formatLastChecked() }}
            </span>
          </span>
          <button
            @click="handleCancel"
            :disabled="loading"
            class="text-xs text-red-500 hover:underline disabled:opacity-50"
          >
            取消绑定
          </button>
        </div>
      </div>
    </template>

    <!-- Expired task -->
    <template v-else-if="isExpired">
      <div class="text-center py-4">
        <div class="text-amber-600 dark:text-amber-400 mb-2">验证任务已过期</div>
        <button
          @click="handleRetry"
          :disabled="loading"
          class="text-[var(--g-accent)] hover:underline text-sm"
        >
          重新发起绑定
        </button>
      </div>
    </template>
  </div>
</template>
