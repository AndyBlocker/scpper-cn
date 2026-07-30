<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useAuth } from '~/composables/useAuth'

const route = useRoute()
const {
  user,
  status,
  state,
  loading,
  error,
  fetchCurrentUser
} = useAuth()

const loginDestination = computed(() => ({
  path: '/auth/login',
  query: { redirect: route.fullPath }
}))

const isInitialLoading = computed(() => state.value === 'loading')
const hasReadySession = computed(() => state.value === 'ready' && Boolean(user.value))

function retry() {
  void fetchCurrentUser(true)
}

onMounted(() => {
  if (status.value === 'unknown') {
    void fetchCurrentUser()
  }
})
</script>

<template>
  <section
    v-if="isInitialLoading"
    class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-6 shadow-sm sm:p-8"
    aria-busy="true"
    aria-live="polite"
  >
    <div class="flex items-center gap-3 text-sm text-[rgb(var(--muted))]">
      <LucideIcon
        name="LoaderCircle"
        class="h-5 w-5 animate-spin"
        aria-hidden="true"
      />
      <span>正在确认登录状态…</span>
    </div>
    <div class="mt-6 space-y-3" aria-hidden="true">
      <div class="h-5 w-1/3 animate-pulse rounded bg-[rgb(var(--panel-border)_/_0.7)]" />
      <div class="h-11 w-full animate-pulse rounded-lg bg-[rgb(var(--panel-border)_/_0.45)]" />
      <div class="h-11 w-4/5 animate-pulse rounded-lg bg-[rgb(var(--panel-border)_/_0.35)]" />
    </div>
  </section>

  <section
    v-else-if="state === 'error'"
    class="rounded-lg border border-red-300/70 bg-red-50/90 p-6 shadow-sm dark:border-red-900/70 dark:bg-red-950/35 sm:p-8"
    role="alert"
  >
    <div class="flex items-start gap-3">
      <LucideIcon
        name="CircleAlert"
        class="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-300"
        aria-hidden="true"
      />
      <div>
        <h2 class="font-semibold text-red-900 dark:text-red-100">暂时无法读取账号信息</h2>
        <p class="mt-1 text-sm leading-6 text-red-700 dark:text-red-200">
          {{ error || '连接账号服务时出现问题。你的账号数据没有被修改。' }}
        </p>
        <button
          type="button"
          class="mt-4 inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white dark:focus:ring-neutral-100 dark:focus:ring-offset-neutral-950"
          :disabled="loading"
          @click="retry"
        >
          <LucideIcon
            :name="loading ? 'LoaderCircle' : 'RefreshCw'"
            class="h-4 w-4"
            :class="{ 'animate-spin': loading }"
            aria-hidden="true"
          />
          {{ loading ? '重新连接中…' : '重新连接' }}
        </button>
      </div>
    </div>
  </section>

  <section
    v-else-if="state === 'unauthenticated'"
    class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-6 shadow-sm sm:p-8"
  >
    <div class="flex items-start gap-3">
      <LucideIcon
        name="LogIn"
        class="mt-0.5 h-5 w-5 shrink-0 text-[var(--g-accent)]"
        aria-hidden="true"
      />
      <div>
        <h2 class="font-semibold text-[rgb(var(--fg))]">登录后继续</h2>
        <p class="mt-1 text-sm leading-6 text-[rgb(var(--muted))]">
          此区域包含你的账号和个人内容。登录成功后会返回当前页面。
        </p>
        <NuxtLink
          :to="loginDestination"
          class="mt-4 inline-flex min-h-11 items-center justify-center rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white dark:focus:ring-neutral-100 dark:focus:ring-offset-neutral-950"
        >
          前往登录
        </NuxtLink>
      </div>
    </div>
  </section>

  <template v-else-if="hasReadySession && user">
    <div
      v-if="error"
      class="mb-5 flex items-start gap-3 rounded-lg border border-amber-300/70 bg-amber-50/90 px-4 py-3 text-sm text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-100"
      role="status"
    >
      <LucideIcon
        name="WifiOff"
        class="mt-0.5 h-4 w-4 shrink-0"
        aria-hidden="true"
      />
      <span>当前显示最近一次成功读取的账号信息；刷新失败不会清空或伪造你的资料。</span>
      <button
        type="button"
        class="ml-auto shrink-0 font-medium underline underline-offset-2 disabled:opacity-60"
        :disabled="loading"
        @click="retry"
      >
        重试
      </button>
    </div>
    <slot :user="user" />
  </template>

  <section
    v-else
    class="rounded-lg border border-red-300/70 bg-red-50/90 p-6 text-sm text-red-800 dark:border-red-900/70 dark:bg-red-950/35 dark:text-red-200"
    role="alert"
  >
    账号状态不完整，请重新加载页面后再试。
  </section>
</template>
