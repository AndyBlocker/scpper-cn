<template>
  <div class="mx-auto flex max-w-xl flex-col gap-8 px-4 py-12">
    <div class="space-y-2">
      <h1 class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">账号登录</h1>
      <p class="text-sm text-neutral-600 dark:text-neutral-400">
        使用邮箱和密码登录 SCPPER-CN。仅支持邮箱密码登录。
      </p>
    </div>

    <div class="rounded-3xl border border-white/60 bg-white/75 p-6 shadow-[0_22px_55px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:p-8 dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_36px_80px_rgba(0,0,0,0.55)]">
      <form class="space-y-6" @submit.prevent="handleLogin">
        <div class="space-y-2">
          <label for="login-email" class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">邮箱</label>
          <input
            id="login-email"
            v-model="email"
            type="email"
            autocomplete="email"
            class="w-full rounded-xl border border-neutral-200 bg-white/90 px-4 py-3 text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100"
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
            class="w-full rounded-xl border border-neutral-200 bg-white/90 px-4 py-3 text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100"
            placeholder="请输入密码"
            required
            :disabled="isSubmitting"
          >
        </div>

        <div v-if="errorMessage" class="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600 dark:border-red-800/60 dark:bg-red-900/30 dark:text-red-300">
          {{ errorMessage }}
        </div>

        <button
          type="submit"
          class="flex w-full items-center justify-center gap-2 rounded-xl bg-[rgb(var(--accent))] px-4 py-3 text-sm font-semibold text-white shadow-[0_16px_45px_rgba(10,132,255,0.35)] transition-all hover:-translate-y-0.5 hover:shadow-[0_22px_55px_rgba(10,132,255,0.45)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[rgba(var(--accent),0.6)] disabled:opacity-60 disabled:cursor-not-allowed dark:focus:ring-offset-neutral-950"
          :disabled="!canSubmit || isSubmitting"
        >
          <svg v-if="isSubmitting" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v4m0 8v4m8-8h-4M8 12H4m12.364-6.364l-2.828 2.828M9.172 14.828l-2.828 2.828m0-11.656l2.828 2.828m8.486 8.486l2.828 2.828" />
          </svg>
          <span>{{ isSubmitting ? '登录中…' : '登录' }}</span>
        </button>

        <div class="text-center text-sm text-neutral-500 dark:text-neutral-400">
          还没有账号？
          <NuxtLink to="/auth/register" class="text-[rgb(var(--accent))] hover:text-[rgb(var(--accent-strong))]">
            立即注册
          </NuxtLink>
          <span class="mx-2">·</span>
          <NuxtLink to="/auth/forgot" class="text-[rgb(var(--accent))] hover:text-[rgb(var(--accent-strong))]">
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
const { login, fetchCurrentUser } = useAuth()

const email = ref('')
const password = ref('')
const isSubmitting = ref(false)
const errorMessage = ref('')

const canSubmit = computed(() => email.value.trim().length > 0 && password.value.length > 0)

async function handleLogin() {
  if (!canSubmit.value || isSubmitting.value) return
  errorMessage.value = ''
  isSubmitting.value = true
  const result = await login(email.value.trim(), password.value)
  isSubmitting.value = false
  if (result.ok) {
    await fetchCurrentUser(true)
    router.push('/account')
  } else {
    errorMessage.value = result.error || '登录失败'
  }
}
</script>
