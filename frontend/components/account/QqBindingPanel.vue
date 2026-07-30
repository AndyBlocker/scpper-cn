<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useQqNotifyEnabled } from '~/composables/useQqNotifyEnabled'
import { useQqBinding } from '~/composables/useQqBinding'

// QQ 通知总开关（2026-07-30 暂时下线）。关闭时本面板只对**已绑定**用户显示，
// 且只保留解绑；发起新绑定的入口一律不给。
const qqNotifyEnabled = useQqNotifyEnabled()

const {
  binding,
  botQq,
  plainCode,
  loading,
  refreshing,
  statusKnown,
  error,
  isBound,
  isPaused,
  hasActiveChallenge,
  isExpired,
  countdown,
  fetchStatus,
  start,
  cancel,
  unbind,
  copyCode,
  startPolling,
  stopPolling
} = useQqBinding()

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

const showUnbind = ref(false)
const unbindPassword = ref('')
const unbindError = ref<string | null>(null)

// 验证码分成三段展示。12 位连排极难人眼校对，而这里打错的代价是
// 「好友申请被拒 → 得重新发一次申请」，QQ 对反复发申请还有频率限制。
const codeGroups = computed(() => {
  const raw = plainCode.value
  if (!raw) return []
  const body = raw.replace(/^SCPPER-/, '')
  return [body.slice(0, 4), body.slice(4, 8), body.slice(8, 12)]
})

async function handleCopy() {
  const ok = await copyCode()
  if (!ok) return
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => { copied.value = false }, 2000)
}

async function handleUnbind() {
  unbindError.value = null
  if (!unbindPassword.value) {
    unbindError.value = '请输入登录密码'
    return
  }
  const ok = await unbind(unbindPassword.value)
  if (ok) {
    showUnbind.value = false
    unbindPassword.value = ''
  } else {
    unbindError.value = error.value || '解绑失败'
  }
}

// 只在有进行中的绑定且页面可见时轮询：后台标签页轮询纯属浪费，
// 且 BFF 的每次鉴权都要打一次 user-backend。
function syncPolling() {
  if (hasActiveChallenge.value && !isBound.value && !document.hidden) startPolling()
  else stopPolling()
}

watch([hasActiveChallenge, isBound], syncPolling)

function onVisibility() {
  syncPolling()
  if (!document.hidden && hasActiveChallenge.value) void fetchStatus()
}

onMounted(() => {
  void fetchStatus()
  document.addEventListener('visibilitychange', onVisibility)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  if (copiedTimer) clearTimeout(copiedTimer)
  stopPolling()
})
</script>

<template>
  <!-- 功能下线时只对「还有事要收尾」的人渲染：已绑定的要能解绑，
       绑定进行中的要能取消。其余人整块不渲染（连边框都不留）。
       条件放在根元素而不是外层页面：组件照常挂载，onMounted 的
       /qq-binding/status 仍会执行 —— 「绑定进行中」只有它知道，
       上层的 /auth/me 此时报的是 bound=false。 -->
  <div
    v-if="qqNotifyEnabled || isBound || hasActiveChallenge"
    class="rounded-lg border border-neutral-200 bg-neutral-50 p-4 space-y-4 dark:border-neutral-700 dark:bg-neutral-800"
  >
    <div class="flex items-center justify-between gap-3">
      <div>
        <h3 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">QQ 通知</h3>
        <p class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          绑定后可通过 QQ 私信接收站点通知
        </p>
      </div>
      <button
        type="button"
        class="shrink-0 text-xs text-neutral-500 hover:underline disabled:opacity-50 dark:text-neutral-400"
        :disabled="refreshing"
        @click="fetchStatus()"
      >
        {{ refreshing ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <div v-if="error" class="rounded-xl border border-red-200 bg-red-50 p-3 dark:border-red-800 dark:bg-red-900/20">
      <div class="text-sm text-red-700 dark:text-red-300">{{ error }}</div>
    </div>

    <div v-if="!statusKnown" class="py-4 text-center text-sm text-neutral-500 dark:text-neutral-400">
      正在加载绑定状态…
    </div>

    <!-- 已绑定 -->
    <template v-else-if="isBound">
      <!-- 功能下线期间要说清楚：绑定还在，但不会再推送。
           不说的话用户会以为推送仍在正常工作，只是没有新动态。 -->
      <p v-if="!qqNotifyEnabled" class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
        QQ 通知功能已暂时关闭，目前不会推送任何消息。绑定仍保留，功能恢复后无需重新绑定；也可以在下方解绑。
      </p>
      <div class="rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-900/30">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="flex items-center gap-2">
              <span
                class="inline-block h-2 w-2 rounded-full"
                :class="isPaused ? 'bg-amber-500' : 'bg-emerald-500'"
                aria-hidden="true"
              />
              <span class="font-mono text-sm text-neutral-800 dark:text-neutral-100">
                {{ binding?.addressMask }}
              </span>
              <span v-if="isPaused" class="text-xs text-amber-600 dark:text-amber-400">已暂停</span>
            </div>
            <div class="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
              出于隐私考虑只显示部分号码
            </div>
          </div>
          <button
            type="button"
            class="shrink-0 rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-700"
            @click="showUnbind = !showUnbind"
          >
            解绑
          </button>
        </div>

        <div v-if="showUnbind" class="mt-3 border-t border-neutral-200 pt-3 dark:border-neutral-700">
          <!-- 解绑要求密码：没有它，拿到会话的人可以静默把推送目标改成自己的 QQ，
               持续窃取你的站点活动情报，而你只会以为「通知坏了」。 -->
          <label class="text-xs font-semibold text-neutral-600 dark:text-neutral-400">
            请输入登录密码以确认
          </label>
          <input
            v-model="unbindPassword"
            type="password"
            autocomplete="current-password"
            class="mt-1 w-full rounded-xl border border-neutral-200 bg-white px-3 py-2 text-sm dark:border-neutral-600 dark:bg-neutral-700"
            @keyup.enter="handleUnbind"
          >
          <div v-if="unbindError" class="mt-1 text-xs text-red-600 dark:text-red-400">{{ unbindError }}</div>
          <div class="mt-2 flex gap-2">
            <button
              type="button"
              class="rounded-lg bg-red-600 px-3 py-1.5 text-xs text-white hover:bg-red-700 disabled:opacity-50"
              :disabled="loading"
              @click="handleUnbind"
            >
              {{ loading ? '处理中…' : '确认解绑' }}
            </button>
            <button
              type="button"
              class="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-600 dark:border-neutral-600 dark:text-neutral-300"
              @click="showUnbind = false; unbindPassword = ''; unbindError = null"
            >
              取消
            </button>
          </div>
        </div>
      </div>
    </template>

    <!-- 绑定进行中：显示验证码与引导 -->
    <template v-else-if="plainCode && !isExpired">
      <div class="rounded-xl border border-neutral-200 bg-white p-4 dark:border-neutral-700 dark:bg-neutral-900/30">
        <div class="text-xs font-semibold text-neutral-600 dark:text-neutral-400">你的验证码</div>
        <div class="mt-2 flex flex-wrap items-center gap-2">
          <div class="flex gap-1.5">
            <span
              v-for="(g, i) in codeGroups"
              :key="i"
              class="rounded-lg bg-neutral-100 px-2.5 py-1.5 font-mono text-lg font-semibold tracking-[0.2em] text-neutral-900 dark:bg-neutral-700 dark:text-neutral-50"
            >{{ g }}</span>
          </div>
          <button
            type="button"
            class="rounded-lg border border-neutral-200 px-3 py-1.5 text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-700"
            @click="handleCopy"
          >
            {{ copied ? '已复制' : '复制' }}
          </button>
          <span class="ml-auto font-mono text-sm text-neutral-500 dark:text-neutral-400" aria-live="polite">
            {{ countdown }}
          </span>
        </div>
        <p class="mt-2 text-[11px] text-amber-600 dark:text-amber-400">
          验证码只显示这一次，刷新页面后需要重新生成
        </p>
      </div>

      <ol class="space-y-2 text-sm text-neutral-700 dark:text-neutral-300">
        <li class="flex gap-2">
          <span class="shrink-0 font-semibold text-neutral-400">1.</span>
          <span>
            在 QQ 里添加
            <span class="font-mono font-semibold text-neutral-900 dark:text-neutral-100">{{ botQq || '机器人账号' }}</span>
            为好友
          </span>
        </li>
        <li class="flex gap-2">
          <span class="shrink-0 font-semibold text-neutral-400">2.</span>
          <span>
            <strong class="text-neutral-900 dark:text-neutral-100">把上面的验证码填进「验证信息」</strong>
            再发送申请
          </span>
        </li>
        <li class="flex gap-2">
          <span class="shrink-0 font-semibold text-neutral-400">3.</span>
          <span>通过后本页会自动确认，无需再发消息</span>
        </li>
      </ol>

      <div class="flex items-center gap-2">
        <span class="text-xs text-neutral-500 dark:text-neutral-400">
          {{ refreshing ? '正在检查…' : '等待验证中' }}
        </span>
        <button
          type="button"
          class="ml-auto text-xs text-neutral-500 hover:underline disabled:opacity-50 dark:text-neutral-400"
          :disabled="loading"
          @click="cancel()"
        >
          取消绑定
        </button>
      </div>
    </template>

    <!-- 码已过期 -->
    <template v-else-if="isExpired || (hasActiveChallenge && !plainCode)">
      <div class="rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
        <template v-if="isExpired">验证码已过期，请重新生成。</template>
        <template v-else>
          上次生成的验证码没有显示在本页（可能是在其他设备或刷新前生成的）。请重新生成一个。
        </template>
      </div>
      <button
        type="button"
        class="w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        :disabled="loading"
        @click="start()"
      >
        {{ loading ? '生成中…' : '重新生成验证码' }}
      </button>
    </template>


    <!-- 未绑定 -->
    <template v-else>
      <p class="text-sm text-neutral-600 dark:text-neutral-300">
        绑定 QQ 后，页面评分变化、评论、被关注作者的动态等通知可以直接发到你的 QQ。
      </p>
      <button
        type="button"
        class="w-full rounded-lg bg-neutral-900 px-4 py-2 text-sm text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        :disabled="loading"
        @click="start()"
      >
        {{ loading ? '生成中…' : '开始绑定' }}
      </button>
    </template>
  </div>
</template>
