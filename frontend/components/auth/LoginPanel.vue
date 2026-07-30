<template>
  <div class="mx-auto flex max-w-xl flex-col gap-8 px-4 py-12">
    <div class="space-y-2">
      <h1 class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">账号登录</h1>
      <p class="text-sm text-neutral-600 dark:text-neutral-400">
        使用邮箱和密码登录 SCPPER-CN。仅支持邮箱密码登录。
      </p>
    </div>

    <div
      v-if="reasonNotice"
      class="flex items-start gap-3 rounded-xl border px-4 py-3 text-sm"
      :class="reasonNotice.tone === 'success'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200'
        : reasonNotice.tone === 'warning'
          ? 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100'
          : 'border-neutral-200 bg-neutral-100 text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200'"
      :role="reasonNotice.tone === 'warning' ? 'alert' : 'status'"
      :aria-live="reasonNotice.tone === 'warning' ? 'assertive' : 'polite'"
      aria-atomic="true"
    >
      <LucideIcon
        :name="reasonNotice.tone === 'success'
          ? 'CheckCircle'
          : reasonNotice.tone === 'warning'
            ? 'AlertTriangle'
            : 'Info'"
        class="mt-0.5 h-4 w-4 shrink-0"
        stroke-width="2"
        aria-hidden="true"
      />
      <span>{{ reasonNotice.message }}</span>
    </div>

    <div class="rounded-lg border border-white/60 bg-white/75 p-6 shadow-sm backdrop-blur-xl sm:p-8 dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-lg">
      <form class="space-y-6" @submit.prevent="handleLogin">
        <div class="space-y-2">
          <label for="login-email" class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">邮箱</label>
          <input
            id="login-email"
            v-model="email"
            type="email"
            autocomplete="email"
            class="w-full rounded-xl border border-neutral-200 bg-white/90 px-4 py-3 text-neutral-900 shadow-sm transition focus:border-[var(--g-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)] dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100"
            placeholder="you@example.com"
            required
            :disabled="isSubmitting"
          >
        </div>

        <div class="space-y-2">
          <label for="login-password" class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">密码</label>
          <input
            id="login-password"
            v-model="password"
            type="password"
            autocomplete="current-password"
            class="w-full rounded-xl border border-neutral-200 bg-white/90 px-4 py-3 text-neutral-900 shadow-sm transition focus:border-[var(--g-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)] dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100"
            placeholder="请输入密码"
            required
            :disabled="isSubmitting"
          >
        </div>

        <div
          v-if="errorMessage"
          class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 dark:border-red-800/60 dark:bg-red-900/30 dark:text-red-300"
          role="alert"
          aria-live="assertive"
        >
          {{ errorMessage }}
        </div>

        <button
          type="submit"
          class="flex w-full items-center justify-center gap-2 rounded-xl bg-neutral-900 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:-translate-y-0.5 hover:bg-neutral-800 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-neutral-500 focus:ring-offset-2 focus:ring-offset-white disabled:cursor-not-allowed disabled:bg-neutral-400 disabled:text-white dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white dark:focus:ring-neutral-300 dark:focus:ring-offset-neutral-950 dark:disabled:bg-neutral-700 dark:disabled:text-neutral-300"
          :disabled="!canSubmit || isSubmitting"
        >
          <LucideIcon v-if="isSubmitting" name="Loader2" class="h-4 w-4 animate-spin" stroke-width="2" />
          <span>{{ isSubmitting ? '登录中…' : '登录' }}</span>
        </button>

        <div class="text-center text-sm text-neutral-500 dark:text-neutral-400">
          还没有账号？
          <NuxtLink to="/auth/register" class="text-[var(--g-accent)] hover:text-[rgb(var(--accent-strong))]">
            立即注册
          </NuxtLink>
          <span class="mx-2">·</span>
          <NuxtLink to="/auth/forgot" class="text-[var(--g-accent)] hover:text-[rgb(var(--accent-strong))]">
            忘记密码？
          </NuxtLink>
        </div>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAuth } from '~/composables/useAuth'

const router = useRouter()
const route = useRoute()
const { login } = useAuth()

const email = ref('')
const password = ref('')
const isSubmitting = ref(false)
const errorMessage = ref('')

const canSubmit = computed(() => email.value.trim().length > 0 && password.value.length > 0)
const reasonNotice = computed(() => {
  const reason = typeof route.query.reason === 'string' ? route.query.reason : ''
  if (reason === 'password-changed') {
    return {
      tone: 'success' as const,
      message: '密码已修改，请使用新密码重新登录。'
    }
  }
  if (reason === 'logged-out') {
    return {
      tone: 'status' as const,
      message: '你已安全退出登录。'
    }
  }
  if (reason === 'password-result-uncertain') {
    return {
      tone: 'warning' as const,
      message: '当前登录已失效，无法确认密码修改结果。请先尝试使用新密码登录；如果失败，再使用原密码或重置密码。'
    }
  }
  if (reason === 'profile-session-expired') {
    return {
      tone: 'warning' as const,
      message: '保存资料时登录已失效，无法确认昵称是否更新。重新登录后请检查个人资料。'
    }
  }
  return null
})

function safeRedirectTarget(value: unknown): string {
  if (typeof value !== 'string') return '/account'
  const target = value.trim()
  const hasControlCharacter = Array.from(target).some((character) => {
    const code = character.charCodeAt(0)
    return code <= 31 || code === 127
  })
  if (
    !target.startsWith('/')
    || target.startsWith('//')
    || target.includes('\\')
    || hasControlCharacter
  ) {
    return '/account'
  }
  return target
}

const redirectTarget = computed(() => safeRedirectTarget(route.query.redirect))

async function handleLogin() {
  if (!canSubmit.value || isSubmitting.value) return
  errorMessage.value = ''
  isSubmitting.value = true
  try {
    const result = await login(email.value.trim(), password.value)
    if (result.ok) {
      // login DTO 已包含完整用户快照；无需再强制请求 /auth/me。
      await router.replace(redirectTarget.value)
      return
    }
    errorMessage.value = result.error || '登录失败'
  } finally {
    isSubmitting.value = false
  }
}
</script>
