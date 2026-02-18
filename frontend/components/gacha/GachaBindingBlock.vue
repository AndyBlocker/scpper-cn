<script setup lang="ts">
/**
 * 共享的认证/绑定守卫块。
 * 4 个 gacha 页面都使用相同的 authPending + showBindingBlock 模式，
 * 唯一区别是描述文字中的功能名称。
 */
import { UiButton } from '~/components/ui/button'

defineProps<{
  authPending: boolean
  showBindingBlock: boolean
  /** 功能名称，用于描述文字，如 "抽卡玩法"、"图鉴功能" */
  featureName?: string
}>()
</script>

<template>
  <div
    v-if="authPending"
    class="gacha-binding-block relative z-[2] rounded-3xl border border-dashed border-neutral-200/80 bg-white/70 p-10 text-center text-neutral-500 dark:border-neutral-700/70 dark:bg-neutral-900/60 dark:text-neutral-400"
  >
    正在校验登录状态...
  </div>

  <div
    v-else-if="showBindingBlock"
    class="gacha-binding-block gacha-binding-block--warn relative z-[2] flex flex-col gap-6 rounded-3xl border border-amber-200/70 bg-amber-50/80 p-8 text-neutral-800 shadow-sm dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
  >
    <div class="space-y-2">
      <h2 class="text-2xl font-semibold">需要绑定 Wikidot 账户</h2>
      <p class="text-sm leading-relaxed">
        {{ featureName || '此功能' }}仅对已绑定 Wikidot 的用户开放。请联系管理员完成绑定或前往管理页处理绑定申请。
      </p>
    </div>
    <div class="flex flex-wrap gap-3">
      <UiButton as-child>
        <NuxtLink to="/admin">
          前往管理页
        </NuxtLink>
      </UiButton>
      <UiButton variant="outline" as-child>
        <NuxtLink to="/tools">
          返回工具页
        </NuxtLink>
      </UiButton>
    </div>
  </div>
</template>
