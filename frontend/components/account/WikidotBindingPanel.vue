<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useWikidotBinding } from '~/composables/useWikidotBinding'

const {
  currentTask,
  instructions,
  loading,
  error,
  isPending,
  isExpired,
  hasTask,
  fetchStatus,
  startBinding,
  cancelBinding,
  getTimeRemaining,
  formatLastChecked
} = useWikidotBinding()

const wikidotUsername = ref('')
const copied = ref(false)

onMounted(() => {
  fetchStatus()
})

async function handleStartBinding() {
  if (!wikidotUsername.value.trim()) return
  const result = await startBinding(wikidotUsername.value.trim())
  if (result.ok) {
    wikidotUsername.value = ''
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
</script>

<template>
  <div class="rounded-2xl border border-neutral-200 bg-neutral-50 p-4 space-y-4 dark:border-neutral-700 dark:bg-neutral-800">
    <!-- No task: Show start form -->
    <template v-if="!hasTask">
      <form @submit.prevent="handleStartBinding" class="space-y-3">
        <div>
          <label class="text-xs font-semibold text-neutral-600 dark:text-neutral-400">Wikidot 用户名</label>
          <input
            v-model="wikidotUsername"
            type="text"
            placeholder="输入你的 Wikidot 用户名"
            class="w-full mt-1 rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-600 dark:bg-neutral-700"
            :disabled="loading"
          />
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
          :disabled="!wikidotUsername.trim() || loading"
          class="rounded-full bg-[rgb(var(--accent))] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {{ loading ? '处理中...' : '开始绑定' }}
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
                class="text-[rgb(var(--accent))] hover:underline"
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
          class="text-[rgb(var(--accent))] hover:underline text-sm"
        >
          重新发起绑定
        </button>
      </div>
    </template>
  </div>
</template>
