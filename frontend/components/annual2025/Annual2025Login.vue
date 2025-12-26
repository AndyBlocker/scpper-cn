<template>
  <div class="h-screen w-full flex items-center justify-center p-6 overflow-hidden relative">
    <div class="absolute inset-0 bg-gradient-to-b from-[rgba(var(--accent),0.08)] to-transparent opacity-60" />
    <div class="w-full max-w-md z-10 animate-fade-in-up space-y-8">
      <div class="flex flex-col items-center">
        <div class="w-20 h-20 bg-gradient-to-br from-[rgb(var(--accent))] to-[rgb(var(--accent-strong))] rounded-2xl flex items-center justify-center shadow-2xl mb-6 ring-4 ring-[rgba(var(--accent),0.2)]">
          <LucideIcon name="BarChart2" class="w-10 h-10 text-white" />
        </div>
        <h1 class="text-4xl font-black text-center mb-2 tracking-tight">
          SCPPER CN <span class="text-[rgb(var(--accent))]">2025</span>
        </h1>
        <p class="text-center text-[rgb(var(--muted))] text-sm tracking-widest uppercase">年度数据报告</p>
      </div>

      <form @submit.prevent="emit('submit')" class="space-y-4 bg-[rgb(var(--panel))] p-6 rounded-3xl border border-[rgb(var(--panel-border))] backdrop-blur-xl">
        <div class="relative group">
          <LucideIcon name="Search" class="absolute left-4 top-1/2 -translate-y-1/2 text-[rgb(var(--muted))] w-5 h-5 group-focus-within:text-[rgb(var(--accent))] transition-colors" />
          <input
            :value="modelValue"
            type="text"
            placeholder="输入 Wikidot 用户名"
            class="w-full bg-[rgb(var(--bg))] border border-[rgb(var(--panel-border))] focus:border-[rgb(var(--accent))] text-[rgb(var(--fg))] py-4 pl-12 pr-4 rounded-xl outline-none transition-all placeholder:text-[rgb(var(--muted))]"
            :class="{ 'border-red-500': loadError }"
            autofocus
            @input="handleInput"
          />
        </div>
        <div v-if="loadError" class="text-red-400 text-sm px-2 flex items-center gap-2">
          <LucideIcon name="AlertCircle" class="w-4 h-4" />
          {{ loadError }}
        </div>
        <button
          type="submit"
          :disabled="isDisabled"
          class="w-full bg-[rgb(var(--accent))] text-white font-bold py-4 rounded-xl transition-all hover:bg-[rgb(var(--accent-strong))] hover:scale-[1.02] active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-lg"
        >
          <span v-if="isLoading">正在加载数据...</span>
          <span v-else>查看报告</span>
          <LucideIcon name="ArrowRight" class="w-4 h-4" />
        </button>
        <p class="text-xs text-center text-[rgb(var(--muted))]">
          共 {{ usersCount }} 位用户有年度数据
        </p>
        <div class="relative flex items-center justify-center gap-3 pt-2">
          <div class="h-px flex-1 bg-[rgb(var(--panel-border))]" />
          <span class="text-xs text-[rgb(var(--muted))]">或者</span>
          <div class="h-px flex-1 bg-[rgb(var(--panel-border))]" />
        </div>
        <button
          type="button"
          @click="emit('enter-site')"
          class="w-full bg-transparent border border-[rgb(var(--panel-border))] text-[rgb(var(--muted))] font-medium py-3 rounded-xl transition-all hover:border-[rgb(var(--accent))] hover:text-[rgb(var(--fg))] flex items-center justify-center gap-2"
        >
          <LucideIcon name="Globe" class="w-4 h-4" />
          <span>直接浏览站点数据</span>
        </button>
      </form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  modelValue: string
  isLoading: boolean
  loadError: string | null
  usersCount: number
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'submit'): void
  (e: 'enter-site'): void
  (e: 'clear-error'): void
}>()

const isDisabled = computed(() => !props.modelValue.trim() || props.isLoading)

const handleInput = (event: Event) => {
  const target = event.target as HTMLInputElement
  emit('update:modelValue', target.value)
  if (props.loadError) emit('clear-error')
}
</script>
