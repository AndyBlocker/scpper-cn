<script setup lang="ts">
/**
 * 快速分解弹窗 — 按稀有度批量分解，预览后确认。
 * 利用后端 batch/preview（dry-run）和 batch（执行）两个端点。
 */
import type { Rarity, DismantleBatchSummary, DismantleKeepScope } from '~/types/gacha'
import { computed, ref, watch } from 'vue'
import { formatTokens } from '~/utils/gachaFormatters'
import { rarityLabel } from '~/utils/gachaRarity'
import { UiButton } from '~/components/ui/button'
import { UiInput } from '~/components/ui/input'
import {
  UiDialogRoot,
  UiDialogPortal,
  UiDialogOverlay,
  UiDialogContent,
  UiDialogClose
} from '~/components/ui/dialog'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  close: []
  preview: [maxRarity: Rarity, keepAtLeast: number, keepScope: DismantleKeepScope]
  confirm: [maxRarity: Rarity, keepAtLeast: number, keepScope: DismantleKeepScope]
}>()

const maxRarity = ref<Rarity>('WHITE')
const keepAtLeast = ref(1)
const keepScope = ref<DismantleKeepScope>('CARD')
const previewData = ref<DismantleBatchSummary | null>(null)
const previewLoading = ref(false)
const previewError = ref<string | null>(null)
const confirming = ref(false)
const confirmError = ref<string | null>(null)

const rarityOptions: Rarity[] = ['WHITE', 'GREEN', 'BLUE']
const keepScopeOptions: Array<{ value: DismantleKeepScope; label: string }> = [
  { value: 'CARD', label: '按卡片保留' },
  { value: 'VARIANT', label: '按变体保留' }
]
const keepTargetLabel = computed(() => keepScope.value === 'VARIANT' ? '每变体至少保留' : '每卡片至少保留')

function handlePreview() {
  emit('preview', maxRarity.value, Math.max(0, Math.floor(Number(keepAtLeast.value || 0))), keepScope.value)
}

function handleConfirm() {
  emit('confirm', maxRarity.value, Math.max(0, Math.floor(Number(keepAtLeast.value || 0))), keepScope.value)
}

watch(() => props.open, (val) => {
  if (val) {
    maxRarity.value = 'WHITE'
    keepAtLeast.value = 1
    keepScope.value = 'CARD'
    previewData.value = null
    previewError.value = null
    confirmError.value = null
    confirming.value = false
  }
})

defineExpose({ previewData, previewLoading, previewError, confirming, confirmError })
</script>

<template>
  <UiDialogRoot :open="open" @update:open="(nextOpen) => { if (!nextOpen) emit('close') }">
    <UiDialogPortal>
      <UiDialogOverlay />
      <UiDialogContent class="max-w-lg">
        <header class="flex items-start justify-between gap-3">
          <div>
            <h3 class="text-base font-semibold text-neutral-900 dark:text-neutral-50">快速分解</h3>
            <p class="text-xs text-neutral-500 dark:text-neutral-400">
              按稀有度一键分解低价值卡片。锁定/展示柜中的卡片不会被分解。
            </p>
          </div>
          <UiDialogClose as-child>
            <UiButton variant="ghost" size="sm" class="h-9 w-9 rounded-full p-0" aria-label="关闭">X</UiButton>
          </UiDialogClose>
        </header>

        <div class="mt-3 space-y-3 text-sm">
          <!-- Settings -->
          <div class="grid gap-3 sm:grid-cols-3">
            <label class="flex flex-col gap-1 text-sm text-neutral-500 dark:text-neutral-400">
              最高分解稀有度
              <select
                v-model="maxRarity"
                class="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              >
                <option v-for="r in rarityOptions" :key="r" :value="r">{{ rarityLabel(r) }}</option>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-sm text-neutral-500 dark:text-neutral-400">
              {{ keepTargetLabel }}
              <UiInput v-model.number="keepAtLeast" type="number" min="0" max="999" />
            </label>
            <label class="flex flex-col gap-1 text-sm text-neutral-500 dark:text-neutral-400">
              保留维度
              <select
                v-model="keepScope"
                class="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-900 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              >
                <option v-for="item in keepScopeOptions" :key="item.value" :value="item.value">{{ item.label }}</option>
              </select>
            </label>
          </div>

          <UiButton variant="outline" size="sm" :disabled="previewLoading || confirming" @click="handlePreview">
            {{ previewLoading ? '计算中...' : '预览' }}
          </UiButton>

          <!-- Preview Result -->
          <div v-if="previewError" class="rounded-xl border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
            {{ previewError }}
          </div>

          <div v-if="previewData" class="rounded-2xl border border-neutral-200/70 bg-neutral-50/70 p-4 dark:border-neutral-700/70 dark:bg-neutral-900/60">
            <h4 class="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500 dark:text-neutral-400">预览结果</h4>
            <div class="mt-3 space-y-1.5">
              <div
                v-for="entry in previewData.byRarity.filter((e) => e.count > 0)"
                :key="entry.rarity"
                class="flex items-center justify-between text-xs"
              >
                <span class="text-neutral-700 dark:text-neutral-200">{{ rarityLabel(entry.rarity) }}</span>
                <span class="font-mono text-neutral-600 dark:text-neutral-300">{{ entry.count }} 张 → {{ formatTokens(entry.reward) }} Token</span>
              </div>
              <div class="border-t border-neutral-200/70 pt-2 dark:border-neutral-700/70">
                <div class="flex items-center justify-between text-sm font-semibold">
                  <span class="text-neutral-900 dark:text-neutral-50">总计</span>
                  <span class="text-cyan-700 dark:text-cyan-200">{{ previewData.totalCount }} 张, {{ formatTokens(previewData.totalReward) }} Token</span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="confirmError" class="rounded-xl border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-sm text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
            {{ confirmError }}
          </div>
        </div>

        <footer class="mt-3 flex items-center justify-end gap-3">
          <UiDialogClose as-child>
            <UiButton variant="outline">取消</UiButton>
          </UiDialogClose>
          <UiButton
            variant="destructive"
            :disabled="!previewData || previewData.totalCount <= 0 || confirming || previewLoading"
            @click="handleConfirm"
          >
            <span v-if="confirming">处理中...</span>
            <span v-else>确认分解</span>
          </UiButton>
        </footer>
      </UiDialogContent>
    </UiDialogPortal>
  </UiDialogRoot>
</template>
