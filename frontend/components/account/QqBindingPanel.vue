<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useQqBinding } from '~/composables/useQqBinding'

const props = withDefaults(defineProps<{
  summaryBound?: boolean
  summaryAddressMask?: string | null
  summaryPendingChallenge?: boolean
  allowNewBinding?: boolean
  featureEnabled?: boolean
  deliveryEnabled?: boolean
  active?: boolean
}>(), {
  summaryBound: false,
  summaryAddressMask: null,
  summaryPendingChallenge: false,
  allowNewBinding: false,
  featureEnabled: false,
  deliveryEnabled: false,
  active: true
})

const {
  binding,
  botQq,
  plainCode,
  loading,
  refreshing,
  statusKnown,
  error,
  isBound,
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
const showUnbind = ref(false)
const unbindPassword = ref('')
const unbindError = ref<string | null>(null)
const resolvedMessage = ref<string | null>(null)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

/**
 * `/auth/me` 的摘要是管理入口的兜底。只有状态接口成功返回后，才由局部状态
 * 取代摘要；这样状态接口 503 时不会把已绑定用户的解绑入口一起藏掉。
 */
const effectiveBound = computed(() => (
  isBound.value || (!statusKnown.value && props.summaryBound)
))
const effectivePendingChallenge = computed(() => (
  hasActiveChallenge.value || (!statusKnown.value && props.summaryPendingChallenge)
))
const effectiveAddressMask = computed(() => (
  binding.value?.addressMask || props.summaryAddressMask || '已绑定的 QQ 账号'
))
const shouldRender = computed(() => (
  props.allowNewBinding
  || effectiveBound.value
  || effectivePendingChallenge.value
  || Boolean(resolvedMessage.value)
))

const codeGroups = computed(() => {
  const raw = plainCode.value
  if (!raw) return []
  const body = raw.replace(/^SCPPER-/, '')
  return [body.slice(0, 4), body.slice(4, 8), body.slice(8, 12)].filter(Boolean)
})

async function handleCopy() {
  const ok = await copyCode()
  if (!ok) {
    error.value = '复制失败，请手动选择验证码复制。'
    return
  }
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copied.value = false
  }, 2000)
}

async function handleUnbind() {
  unbindError.value = null
  if (!unbindPassword.value) {
    unbindError.value = '请输入登录密码。'
    return
  }
  const ok = await unbind(unbindPassword.value)
  if (ok) {
    showUnbind.value = false
    unbindPassword.value = ''
    resolvedMessage.value = 'QQ 连接已解绑。若其他区域没有立即更新，重新打开本页即可。'
  } else {
    unbindError.value = error.value || '解绑失败，请稍后重试。'
  }
}

async function handleCancel() {
  const ok = await cancel()
  if (ok) {
    resolvedMessage.value = '未完成的 QQ 绑定已取消。若其他区域没有立即更新，重新打开本页即可。'
  }
}

function closeUnbind() {
  showUnbind.value = false
  unbindPassword.value = ''
  unbindError.value = null
}

function syncPolling() {
  if (
    props.active
    && props.featureEnabled
    && hasActiveChallenge.value
    && !isBound.value
    && !document.hidden
  ) {
    startPolling()
  } else {
    stopPolling()
  }
}

function handleVisibilityChange() {
  syncPolling()
  if (
    props.active
    && props.featureEnabled
    && !document.hidden
    && hasActiveChallenge.value
  ) {
    void fetchStatus()
  }
}

watch(
  [hasActiveChallenge, isBound, () => props.active, () => props.featureEnabled],
  syncPolling
)

onMounted(() => {
  if (shouldRender.value) {
    void fetchStatus()
  }
  document.addEventListener('visibilitychange', handleVisibilityChange)
})

onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', handleVisibilityChange)
  if (copiedTimer) clearTimeout(copiedTimer)
  stopPolling()
})
</script>

<template>
  <div
    v-if="shouldRender"
    class="space-y-4"
    :aria-busy="refreshing"
  >
    <div class="flex min-h-10 items-center justify-between gap-3">
      <p class="text-sm text-[rgb(var(--muted))]">
        <template v-if="!featureEnabled">
          新绑定与消息投递均已暂停。
        </template>
        <template v-else>
          当前连接状态会在此处更新。
        </template>
      </p>
      <button
        type="button"
        class="inline-flex min-h-10 shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-[rgb(var(--muted-strong))] transition hover:bg-[rgb(var(--panel))] hover:text-[rgb(var(--fg))] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)] disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="refreshing"
        @click="fetchStatus()"
      >
        <LucideIcon
          :name="refreshing ? 'LoaderCircle' : 'RefreshCw'"
          class="h-4 w-4"
          :class="{ 'animate-spin': refreshing }"
          aria-hidden="true"
        />
        {{ refreshing ? '检查中…' : '检查状态' }}
      </button>
    </div>

    <div
      v-if="error"
      class="flex items-start gap-3 rounded-lg border border-red-300/70 bg-red-50/90 p-3 text-sm text-red-800 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-200"
      role="alert"
    >
      <LucideIcon
        name="CircleAlert"
        class="mt-0.5 h-4 w-4 shrink-0"
        aria-hidden="true"
      />
      <span>{{ error }}</span>
    </div>

    <div
      v-if="!statusKnown && !error && !effectiveBound && !effectivePendingChallenge"
      class="flex items-center gap-2 py-3 text-sm text-[rgb(var(--muted))]"
      role="status"
    >
      <LucideIcon
        name="LoaderCircle"
        class="h-4 w-4 animate-spin"
        aria-hidden="true"
      />
      正在确认连接状态…
    </div>

    <template v-if="resolvedMessage">
      <div
        class="flex items-start gap-3 rounded-lg border border-emerald-300/70 bg-emerald-50/90 p-4 text-sm leading-6 text-emerald-900 dark:border-emerald-800/70 dark:bg-emerald-950/35 dark:text-emerald-100"
        role="status"
      >
        <LucideIcon
          name="CircleCheck"
          class="mt-0.5 h-4 w-4 shrink-0"
          aria-hidden="true"
        />
        <span>{{ resolvedMessage }}</span>
      </div>
    </template>

    <template v-else-if="effectiveBound">
      <div
        v-if="!featureEnabled"
        class="rounded-lg border border-amber-300/70 bg-amber-50/90 p-3 text-sm leading-6 text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-100"
      >
        现有绑定仍会保留，但目前不会发送消息。功能恢复后无需重新绑定；你也可以在这里解绑。
      </div>
      <div
        v-else-if="!deliveryEnabled"
        class="rounded-lg border border-amber-300/70 bg-amber-50/90 p-3 text-sm leading-6 text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-100"
      >
        当前连接未处于可投递状态，暂时不会发送消息。你可以稍后重新检查，或在这里解绑。
      </div>

      <div class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-4">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div class="min-w-0">
            <p class="text-xs font-medium text-[rgb(var(--muted))]">已保存的 QQ 连接</p>
            <p class="mt-1 break-all font-mono text-sm font-semibold text-[rgb(var(--fg))]">
              {{ effectiveAddressMask }}
            </p>
            <p class="mt-1 text-xs text-[rgb(var(--muted))]">为保护隐私，仅显示部分号码。</p>
          </div>
          <button
            type="button"
            class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-[rgb(var(--panel-border))] px-4 py-2 text-sm font-medium text-[rgb(var(--fg))] transition hover:border-red-300 hover:bg-red-50 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-300/60 dark:hover:border-red-800 dark:hover:bg-red-950/35 dark:hover:text-red-200"
            :aria-expanded="showUnbind"
            aria-controls="qq-unbind-form"
            @click="showUnbind = !showUnbind"
          >
            解绑 QQ
          </button>
        </div>

        <form
          v-if="showUnbind"
          id="qq-unbind-form"
          class="mt-4 border-t border-[rgb(var(--panel-border))] pt-4"
          @submit.prevent="handleUnbind"
        >
          <label
            for="qq-unbind-password"
            class="block text-sm font-medium text-[rgb(var(--fg))]"
          >
            登录密码
          </label>
          <p
            id="qq-unbind-password-hint"
            class="mt-1 text-xs leading-5 text-[rgb(var(--muted))]"
          >
            解绑会移除这条 QQ 连接，需要当前登录密码确认。
          </p>
          <input
            id="qq-unbind-password"
            v-model="unbindPassword"
            type="password"
            autocomplete="current-password"
            required
            aria-describedby="qq-unbind-password-hint qq-unbind-error"
            :aria-invalid="unbindError ? 'true' : undefined"
            class="mt-2 min-h-11 w-full rounded-lg border border-[rgb(var(--input-border))] bg-[rgb(var(--input-bg))] px-3 py-2 text-sm text-[rgb(var(--fg))] outline-none transition focus:border-[var(--g-accent-border)] focus:ring-2 focus:ring-[var(--g-accent-border)] disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="loading"
          >
          <p
            id="qq-unbind-error"
            class="mt-2 min-h-5 text-sm text-red-700 dark:text-red-300"
            role="alert"
          >
            {{ unbindError }}
          </p>
          <div class="mt-3 flex flex-wrap justify-end gap-3">
            <button
              type="button"
              class="inline-flex min-h-11 items-center justify-center rounded-lg border border-[rgb(var(--panel-border))] px-4 py-2 text-sm font-medium text-[rgb(var(--muted-strong))] hover:bg-[rgb(var(--bg))] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)]"
              :disabled="loading"
              @click="closeUnbind"
            >
              保留连接
            </button>
            <button
              type="submit"
              class="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-red-700 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-red-600 dark:hover:bg-red-500 dark:focus:ring-offset-neutral-950"
              :disabled="loading"
            >
              <LucideIcon
                v-if="loading"
                name="LoaderCircle"
                class="h-4 w-4 animate-spin"
                aria-hidden="true"
              />
              {{ loading ? '正在解绑…' : '确认解绑' }}
            </button>
          </div>
        </form>
      </div>
    </template>

    <template v-else-if="effectivePendingChallenge && !featureEnabled">
      <div class="rounded-lg border border-amber-300/70 bg-amber-50/90 p-4 text-sm leading-6 text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-100">
        检测到一项未完成的 QQ 绑定。由于功能已暂停，这项任务无法继续，你可以安全地取消它。
      </div>
      <button
        type="button"
        class="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-4 py-2 text-sm font-semibold text-[rgb(var(--fg))] transition hover:bg-[rgb(var(--bg))] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)] disabled:cursor-not-allowed disabled:opacity-60"
        :disabled="loading"
        @click="handleCancel"
      >
        <LucideIcon
          v-if="loading"
          name="LoaderCircle"
          class="h-4 w-4 animate-spin"
          aria-hidden="true"
        />
        {{ loading ? '正在取消…' : '取消未完成的绑定' }}
      </button>
    </template>

    <template v-else-if="plainCode && hasActiveChallenge && !isExpired">
      <div class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-4">
        <p class="text-sm font-medium text-[rgb(var(--fg))]">一次性验证码</p>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <span
            v-for="(group, index) in codeGroups"
            :key="`${group}-${index}`"
            class="rounded-md bg-[rgb(var(--bg))] px-2.5 py-1.5 font-mono text-lg font-semibold tracking-[0.16em] text-[rgb(var(--fg))]"
          >
            {{ group }}
          </span>
          <button
            type="button"
            class="inline-flex min-h-10 items-center rounded-lg border border-[rgb(var(--panel-border))] px-3 py-2 text-sm font-medium text-[rgb(var(--fg))] hover:bg-[rgb(var(--bg))]"
            @click="handleCopy"
          >
            {{ copied ? '已复制' : '复制' }}
          </button>
          <span class="ml-auto font-mono text-sm text-[rgb(var(--muted))]" aria-live="polite">
            {{ countdown }}
          </span>
        </div>
        <p class="mt-2 text-xs text-[rgb(var(--muted))]">
          验证码只显示一次，刷新后无法再次查看。
        </p>
      </div>

      <ol class="space-y-2 text-sm leading-6 text-[rgb(var(--muted-strong))]">
        <li>1. 在 QQ 中添加 <span class="font-mono font-semibold text-[rgb(var(--fg))]">{{ botQq || '机器人账号' }}</span> 为好友。</li>
        <li>2. 将上方验证码填写到好友申请的验证信息。</li>
        <li>3. 验证通过后，本页会自动更新连接状态。</li>
      </ol>

      <button
        type="button"
        class="inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-[rgb(var(--panel-border))] px-4 py-2 text-sm font-medium text-[rgb(var(--muted-strong))] hover:bg-[rgb(var(--panel))] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)] disabled:opacity-60"
        :disabled="loading"
        @click="handleCancel"
      >
        取消绑定
      </button>
    </template>

    <template v-else-if="effectivePendingChallenge || isExpired">
      <div class="rounded-lg border border-amber-300/70 bg-amber-50/90 p-4 text-sm leading-6 text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-100">
        上一次验证码已过期或无法再次显示。你可以取消任务后重新开始。
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          class="inline-flex min-h-11 items-center justify-center rounded-lg border border-[rgb(var(--panel-border))] px-4 py-2 text-sm font-medium text-[rgb(var(--fg))] hover:bg-[rgb(var(--panel))] disabled:opacity-60"
          :disabled="loading"
          @click="handleCancel"
        >
          取消旧任务
        </button>
        <button
          v-if="allowNewBinding"
          type="button"
          class="inline-flex min-h-11 items-center justify-center rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white"
          :disabled="loading"
          @click="start()"
        >
          生成新验证码
        </button>
      </div>
    </template>

    <template v-else-if="allowNewBinding && statusKnown">
      <p class="text-sm leading-6 text-[rgb(var(--muted))]">
        尚未连接 QQ。开始后会生成一个只能使用一次的验证码。
      </p>
      <button
        type="button"
        class="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white dark:focus:ring-neutral-100 dark:focus:ring-offset-neutral-950"
        :disabled="loading"
        @click="start()"
      >
        <LucideIcon
          v-if="loading"
          name="LoaderCircle"
          class="h-4 w-4 animate-spin"
          aria-hidden="true"
        />
        {{ loading ? '正在生成…' : '开始绑定' }}
      </button>
    </template>
  </div>
</template>
