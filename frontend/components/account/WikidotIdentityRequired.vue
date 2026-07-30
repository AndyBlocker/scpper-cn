<script setup lang="ts">
withDefaults(defineProps<{
  featureName?: string
}>(), {
  featureName: '此功能'
})
</script>

<template>
  <section class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-6 shadow-sm sm:p-8">
    <div class="flex items-start gap-3">
      <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--g-accent-soft)] text-[var(--g-accent)]">
        <LucideIcon
          name="Link2"
          class="h-5 w-5"
          aria-hidden="true"
        />
      </span>
      <div>
        <h2 class="font-semibold text-[rgb(var(--fg))]">
          连接 Wikidot 身份后使用{{ featureName }}
        </h2>
        <p class="mt-1 text-sm leading-6 text-[rgb(var(--muted))]">
          这能让站内个人内容稳定归属于同一位 Wikidot 作者，并避免不同账号间的数据混淆。
        </p>
        <NuxtLink
          to="/account/connections"
          class="mt-4 inline-flex min-h-11 items-center justify-center gap-1 rounded-lg bg-neutral-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-900 focus:ring-offset-2 dark:bg-neutral-100 dark:text-neutral-950 dark:hover:bg-white dark:focus:ring-neutral-100 dark:focus:ring-offset-neutral-950"
        >
          前往账号连接
          <LucideIcon
            name="ArrowRight"
            class="h-4 w-4"
            aria-hidden="true"
          />
        </NuxtLink>
      </div>
    </div>
  </section>
</template>
