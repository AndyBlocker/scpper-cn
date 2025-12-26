<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content">
      <div class="max-w-lg w-full mx-auto px-4 text-center">
        <div class="bg-[rgb(var(--panel))] border border-[rgb(var(--panel-border))] rounded-2xl p-8 md:p-12">
          <div class="w-20 h-20 mx-auto mb-6 bg-[rgba(var(--fg),0.1)] rounded-full flex items-center justify-center">
            <LucideIcon name="PartyPopper" class="w-10 h-10 text-[rgb(var(--accent))]" />
          </div>
          <h2 class="text-xl md:text-2xl font-bold text-[rgb(var(--fg))] mb-3">2025 站点数据回顾完毕</h2>
          <p class="text-[rgb(var(--muted))] text-sm mb-6">
            感谢你的浏览！
          </p>
          <p class="text-[rgb(var(--muted))] text-xs mb-6">
            你今年没有创作或投票记录，无法生成个人年度报告。<br>
            期待明年能在报告中看到你的身影！
          </p>
          <button
            @click="$emit('restart')"
            class="px-6 py-2.5 bg-[rgb(var(--accent))] hover:bg-[rgb(var(--accent-strong))] text-white rounded-lg font-medium transition-colors"
          >
            重新开始
          </button>
        </div>
      </div>
    </div>
    <div class="slide-bg">
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[400px] h-[400px] bg-[rgb(var(--accent))]/10 blur-[100px] rounded-full" />
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  isActive: boolean
}>()

defineEmits<{
  restart: []
}>()
</script>
