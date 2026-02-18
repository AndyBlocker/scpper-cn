<script setup lang="ts">
import { UiButton } from '~/components/ui/button'

defineProps<{
  activating: boolean
  activationError: string | null
}>()

const emit = defineEmits<{
  activate: []
}>()
</script>

<template>
  <section class="surface-card flex flex-col gap-3 p-3 sm:p-4">
    <h3 class="text-base font-semibold text-neutral-900 dark:text-neutral-100">激活</h3>
    <div class="flex flex-wrap items-center gap-3">
      <UiButton :disabled="activating" @click="emit('activate')">
        <span v-if="activating">处理中</span>
        <span v-else>立即激活</span>
      </UiButton>
      <span v-if="activationError" class="text-sm font-medium text-rose-600 dark:text-rose-300">{{ activationError }}</span>
    </div>
  </section>
</template>
