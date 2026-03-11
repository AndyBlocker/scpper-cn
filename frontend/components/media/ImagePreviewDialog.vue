<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import LucideIcon from '~/components/LucideIcon.vue'
import {
  UiDialogRoot,
  UiDialogPortal,
  UiDialogOverlay,
  UiDialogContent,
  UiDialogClose
} from '~/components/ui/dialog'
import { copyTextWithFallback } from '~/utils/clipboard'

const props = withDefaults(defineProps<{
  open: boolean
  src: string
  alt?: string
  title?: string
  copyUrl?: string
  linkTo?: string | null
  linkLabel?: string
}>(), {
  alt: '图片预览',
  title: '图片预览',
  copyUrl: '',
  linkTo: null,
  linkLabel: '查看页面'
})

const emit = defineEmits<{
  'update:open': [value: boolean]
}>()

const copied = ref(false)
let copiedTimer: ReturnType<typeof setTimeout> | null = null

function handleOpenChange(nextOpen: boolean) {
  emit('update:open', nextOpen)
  if (!nextOpen) {
    copied.value = false
    if (copiedTimer) {
      clearTimeout(copiedTimer)
      copiedTimer = null
    }
  }
}

async function copyImageUrl() {
  const target = (props.copyUrl || props.src || '').trim()
  if (!target) return
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call
  const copiedNow = await copyTextWithFallback(target, '请复制图片 URL')
  if (!copiedNow) return
  copied.value = true
  if (copiedTimer) clearTimeout(copiedTimer)
  copiedTimer = setTimeout(() => {
    copied.value = false
  }, 1800)
}

onBeforeUnmount(() => {
  if (copiedTimer) {
    clearTimeout(copiedTimer)
    copiedTimer = null
  }
})
</script>

<template>
  <UiDialogRoot :open="open" @update:open="handleOpenChange">
    <UiDialogPortal>
      <UiDialogOverlay class="image-preview-overlay" />
      <UiDialogContent class="image-preview-content p-0">
        <div class="image-preview-shell">
          <header class="image-preview-header">
            <p class="image-preview-title truncate">{{ title }}</p>
            <div class="image-preview-actions">
              <button
                type="button"
                class="image-preview-action"
                :title="copied ? '已复制图片 URL' : '复制图片 URL'"
                @click="copyImageUrl"
              >
                <LucideIcon v-if="copied" name="Check" class="h-3.5 w-3.5" stroke-width="2" aria-hidden="true" />
                <LucideIcon v-else name="Copy" class="h-3.5 w-3.5" stroke-width="2" aria-hidden="true" />
                <span>{{ copied ? '已复制' : '复制 URL' }}</span>
              </button>
              <NuxtLink
                v-if="linkTo"
                :to="linkTo"
                class="image-preview-action"
              >
                <LucideIcon name="ExternalLink" class="h-3.5 w-3.5" stroke-width="2" aria-hidden="true" />
                <span>{{ linkLabel }}</span>
              </NuxtLink>
              <UiDialogClose as-child>
                <button type="button" class="image-preview-close" title="关闭图片预览">
                  <LucideIcon name="X" class="h-4 w-4" stroke-width="2" aria-hidden="true" />
                </button>
              </UiDialogClose>
            </div>
          </header>
          <div class="image-preview-body">
            <img :src="src" :alt="alt" class="image-preview-image">
          </div>
        </div>
      </UiDialogContent>
    </UiDialogPortal>
  </UiDialogRoot>
</template>

<style scoped>
.image-preview-overlay {
  background: rgba(2, 6, 23, 0.86);
}

.image-preview-content {
  width: min(96vw, 1200px);
  max-width: min(96vw, 1200px);
  border: 1px solid rgba(148, 163, 184, 0.35);
  border-radius: 1rem;
  background: rgba(2, 6, 23, 0.9);
  color: #f8fafc;
  box-shadow: 0 24px 48px rgba(2, 6, 23, 0.4);
}

.image-preview-shell {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem;
}

.image-preview-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.image-preview-title {
  flex: 1 1 12rem;
  min-width: 8rem;
  font-size: 0.875rem;
  color: rgba(226, 232, 240, 0.95);
}

.image-preview-actions {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
}

.image-preview-action {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.4);
  background: rgba(15, 23, 42, 0.7);
  padding: 0.35rem 0.65rem;
  font-size: 0.75rem;
  color: rgba(241, 245, 249, 0.95);
  transition: border-color 0.2s ease, color 0.2s ease, background-color 0.2s ease;
}

.image-preview-action:hover {
  border-color: rgba(125, 211, 252, 0.7);
  color: #7dd3fc;
  background: rgba(15, 23, 42, 0.9);
}

.image-preview-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 1.95rem;
  width: 1.95rem;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.42);
  background: rgba(15, 23, 42, 0.72);
  color: rgba(226, 232, 240, 0.92);
  transition: border-color 0.2s ease, color 0.2s ease, background-color 0.2s ease;
}

.image-preview-close:hover {
  border-color: rgba(125, 211, 252, 0.75);
  color: #7dd3fc;
  background: rgba(15, 23, 42, 0.92);
}

.image-preview-body {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 15rem;
  max-height: calc(100dvh - 10rem);
  overflow: auto;
  border-radius: 0.75rem;
  background: rgba(15, 23, 42, 0.72);
}

.image-preview-image {
  display: block;
  width: auto;
  max-width: 100%;
  max-height: calc(100dvh - 12rem);
  object-fit: contain;
}
</style>
