<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAuth, type AuthUser } from '~/composables/useAuth'

const props = defineProps<{
  user: AuthUser
}>()

const { changePassword, logout } = useAuth()
const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const passwordSaving = ref(false)
const logoutPending = ref(false)
const passwordMessage = ref<{ tone: 'error'; text: string } | null>(null)
const logoutError = ref<string | null>(null)

const passwordsMatch = computed(() => (
  confirmPassword.value.length === 0 || newPassword.value === confirmPassword.value
))

function validatePasswordForm(): string | null {
  if (!currentPassword.value) return '请输入当前密码。'
  if (newPassword.value.length < 8) return '新密码至少需要 8 个字符。'
  if (newPassword.value.length > 128) return '新密码不能超过 128 个字符。'
  if (newPassword.value === currentPassword.value) return '新密码不能与当前密码相同。'
  if (newPassword.value !== confirmPassword.value) return '两次输入的新密码不一致。'
  return null
}

async function handlePasswordChange() {
  if (passwordSaving.value) return
  const validationError = validatePasswordForm()
  if (validationError) {
    passwordMessage.value = { tone: 'error', text: validationError }
    return
  }

  passwordSaving.value = true
  passwordMessage.value = null
  const result = await changePassword({
    currentPassword: currentPassword.value,
    newPassword: newPassword.value
  })
  passwordSaving.value = false

  if (!result.ok) {
    passwordMessage.value = {
      tone: 'error',
      text: result.error || '修改密码失败，请稍后重试。'
    }
    return
  }

  currentPassword.value = ''
  newPassword.value = ''
  confirmPassword.value = ''
  await navigateTo({
    path: '/auth/login',
    query: { reason: 'password-changed' }
  }, { replace: true })
}

async function handleLogout() {
  if (logoutPending.value) return
  logoutPending.value = true
  logoutError.value = null
  try {
    const result = await logout()
    if (!result.ok) {
      logoutError.value = result.error || '退出失败，请稍后重试。'
      return
    }
    await navigateTo({
      path: '/auth/login',
      query: { reason: 'logged-out' }
    }, { replace: true })
  } finally {
    logoutPending.value = false
  }
}

function formatLastLogin(value: string | null): string {
  if (!value) return '暂无记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '暂无记录'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    dateStyle: 'long',
    timeStyle: 'short',
    hour12: false
  }).format(date)
}
</script>

<template>
  <div class="space-y-6">
    <section class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-5 shadow-sm sm:p-6">
      <header>
        <h2 class="text-lg font-semibold text-[rgb(var(--fg))]">修改密码</h2>
        <p class="mt-1 text-sm leading-6 text-[rgb(var(--muted))]">
          保存后所有旧登录状态都会失效，你需要使用新密码重新登录。
        </p>
      </header>

      <form
        class="mt-6 space-y-5"
        novalidate
        @submit.prevent="handlePasswordChange"
      >
        <div>
          <label
            for="account-current-password"
            class="block text-sm font-medium text-[rgb(var(--fg))]"
          >
            当前密码
          </label>
          <input
            id="account-current-password"
            v-model="currentPassword"
            type="password"
            autocomplete="current-password"
            required
            aria-describedby="account-password-message"
            class="mt-2 min-h-11 w-full rounded-lg border border-[rgb(var(--input-border))] bg-[rgb(var(--input-bg))] px-3 py-2 text-sm text-[rgb(var(--fg))] outline-none transition focus:border-[var(--g-accent-border)] focus:ring-2 focus:ring-[var(--g-accent-border)] disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="passwordSaving"
          >
        </div>

        <div>
          <label
            for="account-new-password"
            class="block text-sm font-medium text-[rgb(var(--fg))]"
          >
            新密码
          </label>
          <p
            id="account-new-password-hint"
            class="mt-1 text-xs leading-5 text-[rgb(var(--muted))]"
          >
            使用 8–128 个字符，并避免与当前密码相同。
          </p>
          <input
            id="account-new-password"
            v-model="newPassword"
            type="password"
            autocomplete="new-password"
            minlength="8"
            maxlength="128"
            required
            aria-describedby="account-new-password-hint account-password-message"
            class="mt-2 min-h-11 w-full rounded-lg border border-[rgb(var(--input-border))] bg-[rgb(var(--input-bg))] px-3 py-2 text-sm text-[rgb(var(--fg))] outline-none transition focus:border-[var(--g-accent-border)] focus:ring-2 focus:ring-[var(--g-accent-border)] disabled:cursor-not-allowed disabled:opacity-60"
            :disabled="passwordSaving"
          >
        </div>

        <div>
          <label
            for="account-confirm-password"
            class="block text-sm font-medium text-[rgb(var(--fg))]"
          >
            再次输入新密码
          </label>
          <input
            id="account-confirm-password"
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            minlength="8"
            maxlength="128"
            required
            :aria-invalid="!passwordsMatch ? 'true' : undefined"
            aria-describedby="account-password-match account-password-message"
            class="mt-2 min-h-11 w-full rounded-lg border bg-[rgb(var(--input-bg))] px-3 py-2 text-sm text-[rgb(var(--fg))] outline-none transition focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60"
            :class="passwordsMatch
              ? 'border-[rgb(var(--input-border))] focus:border-[var(--g-accent-border)] focus:ring-[var(--g-accent-border)]'
              : 'border-red-500 focus:border-red-500 focus:ring-red-300/60'"
            :disabled="passwordSaving"
          >
          <p
            id="account-password-match"
            class="mt-1 min-h-5 text-xs text-red-700 dark:text-red-300"
            aria-live="polite"
          >
            {{ passwordsMatch ? '' : '两次输入的新密码不一致。' }}
          </p>
        </div>

        <div class="flex flex-col gap-3 border-t border-[rgb(var(--panel-border))] pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p
            id="account-password-message"
            class="text-sm text-red-700 dark:text-red-300"
            role="alert"
          >
            {{ passwordMessage?.text }}
          </p>
          <button
            type="submit"
            class="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white dark:focus:ring-neutral-100 dark:focus:ring-offset-neutral-950"
            :disabled="passwordSaving"
          >
            <LucideIcon
              v-if="passwordSaving"
              name="LoaderCircle"
              class="h-4 w-4 animate-spin"
              aria-hidden="true"
            />
            {{ passwordSaving ? '正在修改…' : '修改密码' }}
          </button>
        </div>
      </form>
    </section>

    <section class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-5 shadow-sm sm:p-6">
      <header>
        <h2 class="text-lg font-semibold text-[rgb(var(--fg))]">当前登录</h2>
        <p class="mt-1 text-sm leading-6 text-[rgb(var(--muted))]">
          登录邮箱：<span class="break-all text-[rgb(var(--muted-strong))]">{{ props.user.email }}</span>
        </p>
        <p class="mt-1 text-sm leading-6 text-[rgb(var(--muted))]">
          上次登录：<span class="text-[rgb(var(--muted-strong))]">{{ formatLastLogin(props.user.lastLoginAt) }}</span>
        </p>
      </header>
      <div class="mt-5 border-t border-[rgb(var(--panel-border))] pt-5">
        <p
          v-if="logoutError"
          class="mb-3 text-sm text-red-700 dark:text-red-300"
          role="alert"
        >
          {{ logoutError }}
        </p>
        <button
          type="button"
          class="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-[rgb(var(--panel-border))] px-4 py-2 text-sm font-medium text-[rgb(var(--fg))] transition hover:border-red-300 hover:bg-red-50 hover:text-red-700 focus:outline-none focus:ring-2 focus:ring-red-300/60 disabled:cursor-not-allowed disabled:opacity-60 dark:hover:border-red-800 dark:hover:bg-red-950/35 dark:hover:text-red-200"
          :disabled="logoutPending"
          @click="handleLogout"
        >
          <LucideIcon
            :name="logoutPending ? 'LoaderCircle' : 'LogOut'"
            class="h-4 w-4"
            :class="{ 'animate-spin': logoutPending }"
            aria-hidden="true"
          />
          {{ logoutPending ? '正在退出…' : '退出当前登录' }}
        </button>
      </div>
    </section>
  </div>
</template>
