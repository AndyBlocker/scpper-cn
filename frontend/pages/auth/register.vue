<template>
  <div class="mx-auto flex max-w-xl flex-col gap-8 px-4 py-12">
    <div class="space-y-2">
      <h1 class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">邮箱注册</h1>
      <p class="text-sm text-neutral-600 dark:text-neutral-400">
        使用邮箱注册 SCPPER-CN 账号，需完成邮箱验证码验证。
      </p>
    </div>

    <div class="rounded-3xl border border-white/60 bg-white/75 p-6 shadow-[0_22px_55px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:p-8 dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_36px_80px_rgba(0,0,0,0.55)]">
      <form class="space-y-6" @submit.prevent="handleComplete">
        <div class="space-y-2">
          <label for="email" class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">邮箱</label>
          <input
            id="email"
            v-model="email"
            type="email"
            autocomplete="email"
            class="w-full rounded-xl border border-neutral-200 bg-white/90 px-4 py-3 text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100"
            placeholder="your@email.com"
            :disabled="isSubmitting"
            required
          >
        </div>

        <div class="space-y-2">
          <label for="displayName" class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">昵称（可选）</label>
          <input
            id="displayName"
            v-model="displayName"
            type="text"
            autocomplete="nickname"
            maxlength="64"
            class="w-full rounded-xl border border-neutral-200 bg-white/90 px-4 py-3 text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100"
            placeholder="在站内展示的昵称"
            :disabled="isSubmitting"
          >
        </div>

        <div class="space-y-2">
          <label for="code" class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">验证码</label>
          <div class="flex flex-col gap-3 sm:flex-row">
            <input
              id="code"
              v-model="code"
              type="text"
              inputmode="numeric"
              :maxlength="CODE_LENGTH"
              class="flex-1 rounded-xl border border-neutral-200 bg-white/90 px-4 py-3 text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100"
              :placeholder="`${CODE_LENGTH} 位数字验证码`"
              :disabled="isSubmitting"
              required
            >
            <button
              type="button"
              class="inline-flex items-center justify-center rounded-xl border border-[rgba(var(--accent),0.28)] bg-[rgba(var(--accent),0.12)] px-4 py-3 text-sm font-medium text-[rgb(var(--accent))] transition hover:bg-[rgba(var(--accent),0.2)] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.4)] disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto w-full"
              :disabled="isSendingCode || isSubmitting || !isEmailValid || cooldown > 0"
              @click="handleSendCode"
            >
              <span v-if="cooldown > 0">重新发送 ({{ cooldown }}s)</span>
              <span v-else>发送验证码</span>
            </button>
          </div>
          <p class="text-xs text-neutral-500 dark:text-neutral-400">
            验证码将发送至邮箱，10 分钟内有效。
          </p>
        </div>

        <div class="space-y-2">
          <label for="password" class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">密码</label>
          <input
            id="password"
            v-model="password"
            type="password"
            autocomplete="new-password"
            minlength="8"
            class="w-full rounded-xl border border-neutral-200 bg-white/90 px-4 py-3 text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100"
            placeholder="至少 8 位，建议包含字母数字"
            :disabled="isSubmitting"
            required
          >
        </div>

        <div class="space-y-2">
          <label for="passwordConfirm" class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">确认密码</label>
          <input
            id="passwordConfirm"
            v-model="passwordConfirm"
            type="password"
            autocomplete="new-password"
            minlength="8"
            class="w-full rounded-xl border border-neutral-200 bg-white/90 px-4 py-3 text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100"
            placeholder="再次输入密码"
            :disabled="isSubmitting"
            required
          >
        </div>

        <div v-if="errorMessage" class="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-500/10 dark:text-red-300">
          {{ errorMessage }}
        </div>
        <div v-if="successMessage" class="rounded-xl bg-green-50 px-4 py-3 text-sm text-green-600 dark:bg-emerald-500/10 dark:text-emerald-300">
          {{ successMessage }}
        </div>

        <button
          type="submit"
          class="inline-flex w-full items-center justify-center rounded-xl border border-[rgba(var(--accent),0.4)] bg-[rgb(var(--accent))] px-4 py-3 text-sm font-semibold text-white shadow-[0_16px_32px_rgba(10,132,255,0.25)] transition hover:-translate-y-0.5 hover:shadow-[0_26px_48px_rgba(10,132,255,0.35)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[rgba(var(--accent),0.4)] disabled:cursor-not-allowed disabled:opacity-60 dark:bg-[rgb(var(--accent-strong))] dark:text-neutral-100"
          :disabled="isSubmitting || !canSubmit"
        >
          <span v-if="isSubmitting">正在注册...</span>
          <span v-else>完成注册</span>
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
const config = useRuntimeConfig();
const apiBase = computed(() => {
  const base = (config.public as Record<string, any> | undefined)?.bffBase;
  if (typeof base === 'string' && base.length > 0) {
    return base;
  }
  return '/api';
});
const CODE_LENGTH = 6;

const email = ref('');
const displayName = ref('');
const code = ref('');
const password = ref('');
const passwordConfirm = ref('');
const errorMessage = ref('');
const successMessage = ref('');
const isSendingCode = ref(false);
const isSubmitting = ref(false);
const cooldown = ref(0);
let cooldownTimer: ReturnType<typeof setInterval> | null = null;

const isEmailValid = computed(() => /.+@.+\..+/.test(email.value.trim()));
const passwordsMatch = computed(() => password.value.length >= 8 && password.value === passwordConfirm.value);
const canSubmit = computed(() => isEmailValid.value && code.value.trim().length === CODE_LENGTH && passwordsMatch.value);

function startCooldown(seconds: number) {
  cooldown.value = seconds;
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
  }
  cooldownTimer = setInterval(() => {
    if (cooldown.value <= 1) {
      cooldown.value = 0;
      if (cooldownTimer) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
      }
    } else {
      cooldown.value -= 1;
    }
  }, 1000);
}

async function handleSendCode() {
  if (!isEmailValid.value || isSendingCode.value) return;
  errorMessage.value = '';
  successMessage.value = '';
  isSendingCode.value = true;
  try {
    await $fetch(`${apiBase.value}/auth/register/start`, {
      method: 'POST',
      body: {
        email: email.value.trim(),
        displayName: displayName.value.trim() || undefined
      }
    });
    startCooldown(60);
    successMessage.value = '验证码已发送，请查收邮箱。';
  } catch (error) {
    if (typeof error === 'object' && error && 'data' in error) {
      const data = (error as { data?: { error?: string } }).data;
      errorMessage.value = data?.error || '发送验证码失败';
    } else if (error instanceof Error) {
      errorMessage.value = error.message;
    } else {
      errorMessage.value = '发送验证码失败';
    }
  } finally {
    isSendingCode.value = false;
  }
}

async function handleComplete() {
  if (!canSubmit.value || isSubmitting.value) return;
  errorMessage.value = '';
  successMessage.value = '';
  isSubmitting.value = true;
  try {
    await $fetch(`${apiBase.value}/auth/register/complete`, {
      method: 'POST',
      body: {
        email: email.value.trim(),
        code: code.value.trim(),
        password: password.value,
        displayName: displayName.value.trim() || undefined
      }
    });
    successMessage.value = '注册成功，您现在可以使用该账号登录。';
  } catch (error) {
    if (typeof error === 'object' && error && 'data' in error) {
      const data = (error as { data?: { error?: string } }).data;
      errorMessage.value = data?.error || '注册失败';
    } else if (error instanceof Error) {
      errorMessage.value = error.message;
    } else {
      errorMessage.value = '注册失败';
    }
  } finally {
    isSubmitting.value = false;
  }
}

onBeforeUnmount(() => {
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
  }
});
</script>
