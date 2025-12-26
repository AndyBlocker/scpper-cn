<template>
  <Teleport to="body">
    <div class="fixed bottom-6 right-6 z-50 flex flex-col gap-2 pointer-events-none">
      <TransitionGroup name="toast">
        <div
          v-for="toast in toasts"
          :key="toast.id"
          class="toast pointer-events-auto"
          :class="[toastTypeClass(toast.type)]"
        >
          <span class="toast-icon">{{ toastIcon(toast.type) }}</span>
          <span class="toast-message">{{ toast.message }}</span>
        </div>
      </TransitionGroup>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
defineProps<{
  toasts: Array<{
    id: number
    message: string
    type: 'success' | 'error' | 'warning' | 'info'
  }>
}>()

function toastIcon(type: string): string {
  const icons: Record<string, string> = {
    success: '✓',
    error: '✕',
    warning: '⚠',
    info: 'ℹ'
  }
  return icons[type] || icons.info
}

function toastTypeClass(type: string): string {
  const classes: Record<string, string> = {
    success: 'border-green-500 dark:border-green-400',
    error: 'border-red-500 dark:border-red-400',
    warning: 'border-yellow-500 dark:border-yellow-400',
    info: 'border-sky-500 dark:border-sky-400'
  }
  return classes[type] || classes.info
}
</script>

<style scoped>
.toast {
  @apply px-4 py-3 rounded-lg bg-white dark:bg-neutral-800 border shadow-lg;
  @apply text-neutral-800 dark:text-neutral-100 text-sm;
  @apply flex items-center gap-2 max-w-sm;
}

.toast-icon {
  @apply text-base flex-shrink-0;
}

.toast.border-green-500 .toast-icon,
.toast.border-green-400 .toast-icon {
  @apply text-green-500 dark:text-green-400;
}

.toast.border-red-500 .toast-icon,
.toast.border-red-400 .toast-icon {
  @apply text-red-500 dark:text-red-400;
}

.toast.border-yellow-500 .toast-icon,
.toast.border-yellow-400 .toast-icon {
  @apply text-yellow-500 dark:text-yellow-400;
}

.toast.border-sky-500 .toast-icon,
.toast.border-sky-400 .toast-icon {
  @apply text-sky-500 dark:text-sky-400;
}

/* Transitions */
.toast-enter-active {
  animation: toast-in 0.3s ease;
}

.toast-leave-active {
  animation: toast-out 0.2s ease forwards;
}

@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(1rem) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

@keyframes toast-out {
  from {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
  to {
    opacity: 0;
    transform: translateY(-0.5rem) scale(0.95);
  }
}
</style>
