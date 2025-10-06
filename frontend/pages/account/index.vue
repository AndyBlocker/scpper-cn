<template>
  <div class="space-y-10 py-10">
    <section class="flex flex-col gap-4 rounded-3xl border border-white/60 bg-white/80 p-8 shadow-[0_22px_55px_rgba(15,23,42,0.10)] backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_32px_70px_rgba(0,0,0,0.55)]">
      <header class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">个人资料</h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">查看绑定邮箱、用户名与 Wikidot 账号。</p>
        </div>
        <div class="flex items-start gap-3">
          <UserAvatar
            :wikidot-id="avatarId"
            :name="user?.displayName || user?.email || ''"
            :size="64"
            class="shrink-0 ring-1 ring-inset ring-neutral-200 dark:ring-neutral-800"
          />
          <div class="text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
            <div>头像来源：{{ avatarSourceLabel }}</div>
            <div v-if="user?.linkedWikidotId">Wikidot ID：{{ user.linkedWikidotId }}</div>
            <button
              type="button"
              class="mt-2 inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-neutral-600 hover:border-[rgba(var(--accent),0.3)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-300"
              @click="handleLogout"
            >退出登录</button>
          </div>
        </div>
      </header>

      <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div class="space-y-4">
          <div>
            <div class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">绑定邮箱</div>
            <div class="mt-1 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm font-medium text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-200">
              {{ user?.email || '—' }}
            </div>
          </div>

          <form class="space-y-3" @submit.prevent="handleDisplayNameUpdate">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">昵称</div>
                <p class="text-[11px] text-neutral-500 dark:text-neutral-500">将在站内展示，可随时修改。</p>
              </div>
              <button
                type="submit"
                class="inline-flex items-center gap-1 rounded-full bg-[rgb(var(--accent))] px-4 py-1.5 text-xs font-semibold text-white shadow-[0_12px_30px_rgba(10,132,255,0.3)] hover:-translate-y-0.5 transition disabled:opacity-60 disabled:cursor-not-allowed"
                :disabled="displayNameSaving || displayNameValue.trim().length === 0"
              >
                <svg v-if="displayNameSaving" class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v4m0 8v4m8-8h-4M8 12H4m12.364-6.364l-2.828 2.828M9.172 14.828l-2.828 2.828m0-11.656l2.828 2.828m8.486 8.486l2.828 2.828" />
                </svg>
                <span>{{ displayNameSaving ? '保存中…' : '保存' }}</span>
              </button>
            </div>
            <input
              v-model="displayNameValue"
              type="text"
              maxlength="64"
              class="w-full rounded-2xl border border-neutral-200 bg-white/90 px-4 py-3 text-sm text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-100"
              placeholder="输入新的昵称"
            >
            <p v-if="displayNameMessage" :class="displayNameMessageClass" class="text-xs">{{ displayNameMessage }}</p>
          </form>
        </div>

        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Wikidot 绑定</div>
              <p class="text-[11px] text-neutral-500 dark:text-neutral-500">暂不支持自助绑定，如需修改请联系管理员。</p>
            </div>
            <div v-if="user?.linkedWikidotId" class="rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.1)] px-3 py-1 text-xs font-semibold text-[rgb(var(--accent))]">
              已绑定
            </div>
            <div v-else class="rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              未绑定
            </div>
          </div>
          <div class="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-4 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
            <template v-if="user?.linkedWikidotId">
              <div>Wikidot ID：{{ user.linkedWikidotId }}</div>
              <div class="mt-2">
                <NuxtLink :to="`/user/${user.linkedWikidotId}`" class="text-[rgb(var(--accent))] hover:text-[rgb(var(--accent-strong))]">
                  查看在 SCPPER-CN 的作者页
                </NuxtLink>
              </div>
            </template>
            <template v-else>
              <div>当前账号尚未绑定 Wikidot 用户。</div>
            </template>
          </div>
        </div>
      </div>
    </section>

    <section class="rounded-3xl border border-white/60 bg-white/80 p-8 shadow-[0_22px_55px_rgba(15,23,42,0.10)] backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_32px_70px_rgba(0,0,0,0.55)]">
      <div class="flex items-center justify-between">
        <div>
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">修改密码</h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">修改后将退出当前登录，需要重新登录。</p>
        </div>
      </div>

      <form class="mt-6 grid grid-cols-1 gap-5 md:grid-cols-3" @submit.prevent="handlePasswordChange">
        <input
          v-model="passwordCurrent"
          type="password"
          autocomplete="current-password"
          placeholder="当前密码"
          class="rounded-2xl border border-neutral-200 bg-white/90 px-4 py-3 text-sm text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-100"
          required
        >
        <input
          v-model="passwordNew"
          type="password"
          autocomplete="new-password"
          placeholder="新密码（至少 8 位）"
          minlength="8"
          class="rounded-2xl border border-neutral-200 bg-white/90 px-4 py-3 text-sm text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-100"
          required
        >
        <input
          v-model="passwordConfirm"
          type="password"
          autocomplete="new-password"
          placeholder="确认新密码"
          minlength="8"
          class="rounded-2xl border border-neutral-200 bg-white/90 px-4 py-3 text-sm text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-100"
          required
        >
        <div class="md:col-span-3 flex items-center justify-between pt-2">
          <p v-if="passwordMessage" :class="passwordMessageClass" class="text-sm">{{ passwordMessage }}</p>
          <button
            type="submit"
            class="inline-flex items-center gap-2 rounded-full bg-neutral-900 px-5 py-2 text-sm font-semibold text-white transition hover:-translate-y-0.5 hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-neutral-900 disabled:opacity-60 disabled:cursor-not-allowed dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
            :disabled="passwordSaving || !passwordsValid"
          >
            <svg v-if="passwordSaving" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v4m0 8v4m8-8h-4M8 12H4m12.364-6.364l-2.828 2.828M9.172 14.828l-2.828 2.828m0-11.656l2.828 2.828m8.486 8.486l2.828 2.828" />
            </svg>
            <span>{{ passwordSaving ? '修改中…' : '修改密码' }}</span>
          </button>
        </div>
      </form>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { navigateTo } from 'nuxt/app'
import UserAvatar from '~/components/UserAvatar.vue'
import { useAuth } from '~/composables/useAuth'

const { user, fetchCurrentUser, updateProfile, changePassword, status, logout } = useAuth()

onMounted(() => {
  if (status.value === 'unknown') {
    fetchCurrentUser()
  } else if (status.value === 'unauthenticated') {
    navigateTo('/auth/login', { replace: true })
  }
})

watch(status, (next) => {
  if (next === 'unauthenticated') {
    navigateTo('/auth/login', { replace: true })
  }
})

const displayNameValue = ref('')
const displayNameSaving = ref(false)
const displayNameMessage = ref('')

watch(user, (next) => {
  displayNameValue.value = next?.displayName || ''
}, { immediate: true })

const displayNameMessageClass = computed(() => (
  displayNameMessage.value.startsWith('成功')
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400'
))

async function handleDisplayNameUpdate() {
  const input = displayNameValue.value.trim()
  if (!input) {
    displayNameMessage.value = '昵称不能为空'
    return
  }
  displayNameSaving.value = true
  displayNameMessage.value = ''
  const result = await updateProfile({ displayName: input })
  displayNameSaving.value = false
  if (result.ok) {
    displayNameMessage.value = '成功更新昵称'
  } else {
    displayNameMessage.value = result.error || '更新失败'
  }
}

const avatarId = computed(() => {
  if (user.value?.linkedWikidotId && Number(user.value.linkedWikidotId) > 0) {
    return user.value.linkedWikidotId
  }
  return '0'
})

const avatarSourceLabel = computed(() => (
  user.value?.linkedWikidotId ? 'Wikidot 头像' : '默认头像'
))

const passwordCurrent = ref('')
const passwordNew = ref('')
const passwordConfirm = ref('')
const passwordSaving = ref(false)
const passwordMessage = ref('')

const passwordsValid = computed(() => {
  return passwordCurrent.value.length >= 1 && passwordNew.value.length >= 8 && passwordNew.value === passwordConfirm.value
})

const passwordMessageClass = computed(() => (
  passwordMessage.value.startsWith('密码已修改')
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400'
))

async function handlePasswordChange() {
  if (!passwordsValid.value || passwordSaving.value) return
  passwordSaving.value = true
  passwordMessage.value = ''
  const result = await changePassword({ currentPassword: passwordCurrent.value, newPassword: passwordNew.value })
  passwordSaving.value = false
  if (result.ok) {
    passwordMessage.value = '密码已修改，请重新登录。'
    passwordCurrent.value = ''
    passwordNew.value = ''
    passwordConfirm.value = ''
  } else {
    passwordMessage.value = result.error || '修改失败'
  }
}

async function handleLogout() {
  await logout()
  navigateTo('/auth/login')
}
</script>
