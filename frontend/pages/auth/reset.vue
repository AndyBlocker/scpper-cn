<template>
  <div class="mx-auto flex max-w-xl flex-col gap-8 px-4 py-12">
    <div class="space-y-2">
      <h1 class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">重置密码</h1>
      <p class="text-sm text-neutral-600 dark:text-neutral-400">
        输入邮箱、验证码与新密码完成重置。
      </p>
    </div>

    <div class="rounded-3xl border border-white/60 bg-white/75 p-6 shadow-[0_22px_55px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:p-8 dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_36px_80px_rgba(0,0,0,0.55)]">
      <form class="space-y-6" @submit.prevent="handleReset">
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
          <label for="code" class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">验证码</label>
          <input
            id="code"
            v-model="code"
            type="text"
            inputmode="numeric"
            maxlength="6"
            class="w-full rounded-xl border border-neutral-200 bg-white/90 px-4 py-3 text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100"
            placeholder="6 位数字验证码"
            :disabled="isSubmitting"
            required
          >
        </div>

        <div class="space-y-2">
          <label for="password" class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">新密码</label>
          <input
            id="password"
            v-model="password"
            type="password"
            autocomplete="new-password"
            minlength="8"
            class="w-full rounded-xl border border-neutral-200 bg-white/90 px-4 py-3 text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-100"
            placeholder="至少 8 位"
            :disabled="isSubmitting"
            required
          >
        </div>

        <div class="space-y-2">
          <label for="passwordConfirm" class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">确认新密码</label>
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
          :disabled="!canSubmit || isSubmitting"
        >
          <span v-if="isSubmitting">提交中…</span>
          <span v-else>完成重置</span>
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
const router = useRouter();
const config = useRuntimeConfig();
const apiBase = computed(() => {
  const base = (config.public as Record<string, any> | undefined)?.bffBase;
  if (typeof base === 'string' && base.length > 0) return base;
  return '/api';
});

const email = ref('');
const code = ref('');
const password = ref('');
const passwordConfirm = ref('');
const isSubmitting = ref(false);
const errorMessage = ref('');
const successMessage = ref('');

const isEmailValid = computed(() => /.+@.+\..+/.test(email.value.trim()));
const passwordsMatch = computed(() => password.value.length >= 8 && password.value === passwordConfirm.value);
const canSubmit = computed(() => isEmailValid.value && code.value.trim().length === 6 && passwordsMatch.value);

async function handleReset() {
  if (!canSubmit.value || isSubmitting.value) return;
  errorMessage.value = '';
  successMessage.value = '';
  isSubmitting.value = true;
  try {
    await $fetch(`${apiBase.value}/auth/password/reset/complete`, {
      method: 'POST',
      body: {
        email: email.value.trim(),
        code: code.value.trim(),
        password: password.value
      }
    });
    successMessage.value = '密码已重置，请使用新密码登录。';
    setTimeout(() => router.push('/auth/login'), 800);
  } catch (error: any) {
    const message = error?.data?.error || error?.message || '重置失败，请检查验证码是否正确或已过期';
    errorMessage.value = message;
  } finally {
    isSubmitting.value = false;
  }
}
</script>

