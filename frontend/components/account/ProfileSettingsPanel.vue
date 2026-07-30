<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import UserAvatar from '~/components/UserAvatar.vue'
import { useAuth, type AuthUser } from '~/composables/useAuth'

const props = defineProps<{
  user: AuthUser
}>()

const { updateProfile } = useAuth()
const displayName = ref('')
const saving = ref(false)
const message = ref<{ tone: 'success' | 'error'; text: string } | null>(null)

watch(
  () => props.user.displayName,
  value => {
    displayName.value = value || ''
  },
  { immediate: true }
)

const normalizedDisplayName = computed(() => displayName.value.trim())
const isDirty = computed(() => normalizedDisplayName.value !== (props.user.displayName || ''))
const canSave = computed(() => (
  normalizedDisplayName.value.length >= 1
  && normalizedDisplayName.value.length <= 64
  && isDirty.value
  && !saving.value
))
const avatarId = computed(() => {
  const id = Number(props.user.linkedWikidotId)
  return Number.isFinite(id) && id > 0 ? id : '0'
})

function resetDisplayName() {
  displayName.value = props.user.displayName || ''
  message.value = null
}

async function handleSubmit() {
  if (!canSave.value) return
  saving.value = true
  message.value = null
  const result = await updateProfile({ displayName: normalizedDisplayName.value })
  saving.value = false
  message.value = result.ok
    ? { tone: 'success', text: '昵称已保存。' }
    : { tone: 'error', text: result.error || '保存失败，请稍后重试。' }
}
</script>

<template>
  <div class="space-y-6">
    <section class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-5 shadow-sm sm:p-6">
      <div class="flex flex-col gap-5 sm:flex-row sm:items-center">
        <UserAvatar
          :wikidot-id="avatarId"
          :name="user.displayName || user.email"
          :size="72"
          :eager="true"
          class="shrink-0 ring-1 ring-[rgb(var(--panel-border))]"
        />
        <div class="min-w-0">
          <h2 class="text-lg font-semibold text-[rgb(var(--fg))]">头像</h2>
          <p class="mt-1 text-sm leading-6 text-[rgb(var(--muted))]">
            <template v-if="user.linkedWikidotId">
              当前使用已连接 Wikidot 账号的头像。
            </template>
            <template v-else>
              当前使用默认头像。连接 Wikidot 账号后会自动同步对应头像。
            </template>
          </p>
          <NuxtLink
            to="/account/connections"
            class="mt-2 inline-flex min-h-10 items-center gap-1 text-sm font-medium text-[var(--g-accent)] underline-offset-4 hover:underline"
          >
            管理账号连接
            <LucideIcon
              name="ArrowRight"
              class="h-4 w-4"
              aria-hidden="true"
            />
          </NuxtLink>
        </div>
      </div>
    </section>

    <section class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-5 shadow-sm sm:p-6">
      <header>
        <h2 class="text-lg font-semibold text-[rgb(var(--fg))]">基本资料</h2>
        <p class="mt-1 text-sm leading-6 text-[rgb(var(--muted))]">
          邮箱用于登录，昵称会在站内需要显示账号身份的位置使用。
        </p>
      </header>

      <dl class="mt-6">
        <div class="border-b border-[rgb(var(--panel-border))] pb-5">
          <dt class="text-sm font-medium text-[rgb(var(--fg))]">登录邮箱</dt>
          <dd class="mt-2 break-all text-sm text-[rgb(var(--muted-strong))]">
            {{ user.email }}
          </dd>
          <p class="mt-1 text-xs text-[rgb(var(--muted))]">当前暂不支持自行更换邮箱。</p>
        </div>
      </dl>

      <form
        class="mt-5"
        @submit.prevent="handleSubmit"
      >
        <label
          for="account-display-name"
          class="block text-sm font-medium text-[rgb(var(--fg))]"
        >
          昵称
        </label>
        <p
          id="account-display-name-hint"
          class="mt-1 text-xs leading-5 text-[rgb(var(--muted))]"
        >
          1–64 个字符。保存后会立即更新当前账号资料。
        </p>
        <input
          id="account-display-name"
          v-model="displayName"
          type="text"
          autocomplete="nickname"
          minlength="1"
          maxlength="64"
          required
          :aria-invalid="message?.tone === 'error' ? 'true' : undefined"
          aria-describedby="account-display-name-hint account-display-name-count account-display-name-message"
          class="mt-2 min-h-11 w-full rounded-lg border border-[rgb(var(--input-border))] bg-[rgb(var(--input-bg))] px-3 py-2 text-sm text-[rgb(var(--fg))] outline-none transition focus:border-[var(--g-accent-border)] focus:ring-2 focus:ring-[var(--g-accent-border)] disabled:cursor-not-allowed disabled:opacity-60"
          :disabled="saving"
        >
        <div class="mt-2 flex items-start justify-between gap-4">
          <p
            id="account-display-name-message"
            class="min-h-5 text-sm"
            :class="message?.tone === 'success'
              ? 'text-emerald-700 dark:text-emerald-300'
              : 'text-red-700 dark:text-red-300'"
            aria-live="polite"
          >
            {{ message?.text }}
          </p>
          <span
            id="account-display-name-count"
            class="shrink-0 text-xs text-[rgb(var(--muted))]"
          >
            {{ displayName.length }}/64
          </span>
        </div>

        <div class="mt-5 flex flex-wrap justify-end gap-3">
          <button
            v-if="isDirty"
            type="button"
            class="inline-flex min-h-11 items-center justify-center rounded-lg border border-[rgb(var(--panel-border))] px-4 py-2 text-sm font-medium text-[rgb(var(--muted-strong))] transition hover:bg-[rgb(var(--bg))] hover:text-[rgb(var(--fg))] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)]"
            :disabled="saving"
            @click="resetDisplayName"
          >
            撤销更改
          </button>
          <button
            type="submit"
            class="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white dark:focus:ring-neutral-100 dark:focus:ring-offset-neutral-950"
            :disabled="!canSave"
          >
            <LucideIcon
              v-if="saving"
              name="LoaderCircle"
              class="h-4 w-4 animate-spin"
              aria-hidden="true"
            />
            {{ saving ? '保存中…' : '保存昵称' }}
          </button>
        </div>
      </form>
    </section>
  </div>
</template>
