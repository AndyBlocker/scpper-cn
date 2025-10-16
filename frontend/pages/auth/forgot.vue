<template>
  <div class="mx-auto flex max-w-xl flex-col gap-8 px-4 py-12">
    <div class="space-y-2">
      <h1 class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50">找回密码</h1>
      <p class="text-sm text-neutral-600 dark:text-neutral-400">
        输入绑定邮箱获取验证码。若邮箱存在且正常，将发送验证码至您的邮箱。
      </p>
    </div>

    <div class="rounded-3xl border border-white/60 bg-white/75 p-6 shadow-[0_22px_55px_rgba(15,23,42,0.12)] backdrop-blur-xl sm:p-8 dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_36px_80px_rgba(0,0,0,0.55)]">
      <form class="space-y-6" @submit.prevent="handleSend">
        <div class="space-y-2">
          <label for="email" class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">绑定邮箱</label>
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

        <div v-if="errorMessage" class="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-600 dark:bg-red-500/10 dark:text-red-300">
          {{ errorMessage }}
        </div>
        <div v-if="successMessage" class="rounded-xl bg-green-50 px-4 py-3 text-sm text-green-600 dark:bg-emerald-500/10 dark:text-emerald-300">
          {{ successMessage }}
        </div>

        <div class="flex flex-col gap-3 sm:flex-row">
          <button
            type="submit"
            class="inline-flex items-center justify-center rounded-xl border border-[rgba(var(--accent),0.4)] bg-[rgb(var(--accent))] px-4 py-3 text-sm font-semibold text-white shadow-[0_16px_32px_rgba(10,132,255,0.25)] transition hover:-translate-y-0.5 hover:shadow-[0_26px_48px_rgba(10,132,255,0.35)] focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[rgba(var(--accent),0.4)] disabled:cursor-not-allowed disabled:opacity-60 dark:bg-[rgb(var(--accent-strong))] dark:text-neutral-100 sm:w-auto w-full"
            :disabled="!isEmailValid || isSubmitting || cooldown > 0"
          >
            <span v-if="isSubmitting">发送中…</span>
            <span v-else-if="cooldown>0">重新发送 ({{ cooldown }}s)</span>
            <span v-else>发送验证码</span>
          </button>

          <NuxtLink
            to="/auth/reset"
            class="inline-flex items-center justify-center rounded-xl border border-neutral-300 bg-white px-4 py-3 text-sm font-medium text-neutral-700 transition hover:bg-neutral-50 focus:outline-none focus:ring-2 focus:ring-neutral-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900/80 dark:text-neutral-200 dark:hover:bg-neutral-900 sm:w-auto w-full text-center"
          >
            已有验证码？前往重置
          </NuxtLink>
        </div>
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

const email = ref('');
const errorMessage = ref('');
const successMessage = ref('');
const isSubmitting = ref(false);
const cooldown = ref(0);
let cooldownTimer: ReturnType<typeof setInterval> | null = null;

const isEmailValid = computed(() => /.+@.+\..+/.test(email.value.trim()));

function startCooldown(seconds: number) {
  cooldown.value = seconds;
  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    if (cooldown.value <= 1) {
      cooldown.value = 0;
      if (cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = null; }
    } else {
      cooldown.value -= 1;
    }
  }, 1000);
}

async function handleSend() {
  if (!isEmailValid.value || isSubmitting.value) return;
  errorMessage.value = '';
  successMessage.value = '';
  isSubmitting.value = true;
  try {
    await $fetch(`${apiBase.value}/auth/password/reset/start`, {
      method: 'POST',
      body: { email: email.value.trim() }
    });
    startCooldown(60);
    successMessage.value = '如果邮箱存在，我们已发送验证码。请在 10 分钟内完成重置。';
  } catch (error: any) {
    // 后端会隐藏不存在的邮箱，这里统一提示
    startCooldown(60);
    successMessage.value = '如果邮箱存在，我们已发送验证码。请在 10 分钟内完成重置。';
  } finally {
    isSubmitting.value = false;
  }
}

onBeforeUnmount(() => {
  if (cooldownTimer) clearInterval(cooldownTimer);
});
</script>

