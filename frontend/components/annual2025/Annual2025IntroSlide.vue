<template>
  <section class="slide" :class="{ 'slide-active': isActive }">
    <div class="slide-content text-center relative">
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[20vw] font-black text-[rgb(var(--fg))] opacity-5 select-none pointer-events-none">2025</div>
      <h1 class="text-5xl md:text-7xl font-black text-[rgb(var(--fg))] mb-6 tracking-tight leading-none">
        SCP中文站<br />
        <span class="text-[rgb(var(--accent))]">年度总结</span>
      </h1>
      <p class="text-lg text-[rgb(var(--muted))] font-light max-w-lg mx-auto leading-relaxed">
        2025年1月1日 - 2025年12月25日<br />
        全站数据统计与个人报告
      </p>
      <div class="mt-12 animate-bounce opacity-50">
        <LucideIcon name="ChevronDown" class="w-8 h-8 mx-auto" />
      </div>
    </div>
    <div class="slide-bg">
      <div class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-[rgba(var(--accent),0.1)] blur-[120px] rounded-full" />
    </div>
  </section>
</template>

<script setup lang="ts">
defineProps<{
  isActive: boolean
}>()
</script>
