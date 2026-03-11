<script setup lang="ts">
/**
 * 单个变体分解确认弹窗。
 * 从 album.vue 提取，用于确认分解某个卡片变体。
 */
import { ref, watch } from 'vue'
import { UiButton } from '~/components/ui/button'
import { UiInput } from '~/components/ui/input'
import {
  UiDialogRoot,
  UiDialogPortal,
  UiDialogOverlay,
  UiDialogContent,
  UiDialogHeader,
  UiDialogTitle,
  UiDialogDescription,
  UiDialogFooter,
  UiDialogClose
} from '~/components/ui/dialog'

const props = defineProps<{
  open: boolean
  title: string | null
  maxCount: number
  dismantling: boolean
  error: string | null
}>()

const emit = defineEmits<{
  close: []
  confirm: [count: number]
}>()

const count = ref(1)

watch(() => props.open, (val) => {
  if (val) count.value = 1
})

function handleConfirm() {
  emit('confirm', count.value)
}

function handleOpenChange(nextOpen: boolean) {
  if (!nextOpen) emit('close')
}
</script>

<template>
  <UiDialogRoot :open="open" @update:open="handleOpenChange">
    <UiDialogPortal>
      <UiDialogOverlay />
      <UiDialogContent class="max-w-md">
        <UiDialogHeader>
          <div>
            <UiDialogTitle>分解卡片变体</UiDialogTitle>
            <UiDialogDescription>
              分解会减少该变体数量并返还 Token。
            </UiDialogDescription>
          </div>
          <UiDialogClose as-child>
            <UiButton variant="ghost" size="sm" class="h-9 w-9 rounded-full p-0" aria-label="关闭分解弹窗">
              X
            </UiButton>
          </UiDialogClose>
        </UiDialogHeader>

        <div class="mt-4 space-y-3 text-sm text-neutral-600 dark:text-neutral-300">
          <div class="rounded-xl border border-neutral-200/70 bg-neutral-50/70 p-3 dark:border-neutral-800/70 dark:bg-neutral-900/60">
            <h4 class="font-semibold text-neutral-900 dark:text-neutral-100">{{ title }}</h4>
            <p class="text-xs text-neutral-500 dark:text-neutral-400">持有数量：{{ maxCount }}</p>
          </div>

          <label class="flex flex-col gap-1 text-sm text-neutral-500 dark:text-neutral-400">
            分解数量
            <UiInput
              v-model.number="count"
              type="number"
              min="1"
              :max="maxCount"
            />
          </label>

          <transition name="fade">
            <p
              v-if="error"
              class="rounded-xl border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200"
            >
              {{ error }}
            </p>
          </transition>
        </div>

        <UiDialogFooter>
          <UiDialogClose as-child>
            <UiButton variant="outline">取消</UiButton>
          </UiDialogClose>
          <UiButton variant="destructive" :disabled="dismantling" @click="handleConfirm">
            <span v-if="dismantling">处理中...</span>
            <span v-else>确认分解</span>
          </UiButton>
        </UiDialogFooter>
      </UiDialogContent>
    </UiDialogPortal>
  </UiDialogRoot>
</template>
