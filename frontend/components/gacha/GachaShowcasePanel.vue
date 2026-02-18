<script setup lang="ts">
/**
 * 展示柜管理面板。
 * 展示柜列表 + 每个展示柜的槽位网格 + 创建/删除/命名操作。
 */
import { ref, computed } from 'vue'
import type { Showcase, ShowcaseMeta } from '~/composables/api/gachaShowcase'
import type { ShowcasePickerOption } from '~/components/gacha/GachaShowcaseSlotPicker.vue'
import GachaShowcaseSlotPicker from '~/components/gacha/GachaShowcaseSlotPicker.vue'
import GachaCard from '~/components/gacha/GachaCard.vue'
import GachaEmptyState from '~/components/gacha/GachaEmptyState.vue'
import GachaSkeleton from '~/components/gacha/GachaSkeleton.vue'
import GachaConfirmDialog from '~/components/gacha/GachaConfirmDialog.vue'
import { UiButton } from '~/components/ui/button'
import { UiInput } from '~/components/ui/input'
import { formatTokens } from '~/utils/gachaFormatters'

const props = defineProps<{
  showcases: Showcase[]
  meta: ShowcaseMeta
  loading: boolean
  busy: boolean
  pickerOptions: ShowcasePickerOption[]
  pickerLoading: boolean
  walletBalance: number
}>()

const emit = defineEmits<{
  create: [name: string]
  rename: [id: string, name: string]
  delete: [id: string]
  setSlot: [showcaseId: string, slotIndex: number, instanceId: string]
  clearSlot: [showcaseId: string, slotIndex: number]
  refresh: []
  loadPicker: []
}>()

// Create showcase
const showCreateInput = ref(false)
const newShowcaseName = ref('')

function handleCreate() {
  const name = newShowcaseName.value.trim()
  if (!name) return
  emit('create', name)
  newShowcaseName.value = ''
  showCreateInput.value = false
}

// Rename
const renamingId = ref<string | null>(null)
const renameValue = ref('')

function startRename(sc: Showcase) {
  renamingId.value = sc.id
  renameValue.value = sc.name
}

function confirmRename(id: string) {
  const name = renameValue.value.trim()
  if (name) emit('rename', id, name)
  renamingId.value = null
}

// Delete confirmation
const deleteConfirmId = ref<string | null>(null)
const deleteConfirmName = ref('')

function askDelete(sc: Showcase) {
  deleteConfirmId.value = sc.id
  deleteConfirmName.value = sc.name
}

function handleDelete() {
  if (deleteConfirmId.value) {
    emit('delete', deleteConfirmId.value)
    deleteConfirmId.value = null
  }
}

// Picker
const pickerOpen = ref(false)
const pickerShowcaseId = ref<string | null>(null)
const pickerSlotIndex = ref<number | null>(null)

function openPicker(showcaseId: string, slotIndex: number) {
  pickerShowcaseId.value = showcaseId
  pickerSlotIndex.value = slotIndex
  pickerOpen.value = true
  emit('loadPicker')
}

function handlePickerSelect(instanceId: string) {
  if (pickerShowcaseId.value && pickerSlotIndex.value != null) {
    emit('setSlot', pickerShowcaseId.value, pickerSlotIndex.value, instanceId)
  }
  pickerOpen.value = false
}

const canCreateFree = computed(() => props.showcases.length < props.meta.freeCount)
const canCreatePaid = computed(() => !canCreateFree.value && props.showcases.length < props.meta.maxCount)
const needPayToCreate = computed(() => canCreatePaid.value)
</script>

<template>
  <div class="space-y-4">
    <!-- Header -->
    <div class="flex flex-wrap items-center gap-3">
      <UiButton variant="outline" size="sm" :disabled="loading || busy" @click="emit('refresh')">刷新</UiButton>

      <template v-if="!showCreateInput">
        <UiButton
          v-if="!props.showcases.length || canCreateFree || canCreatePaid"
          variant="outline"
          size="sm"
          :disabled="busy || props.showcases.length >= meta.maxCount"
          @click="showCreateInput = true"
        >
          {{ needPayToCreate ? `创建展示柜 (${formatTokens(meta.unlockCost)} Token)` : '创建展示柜' }}
        </UiButton>
      </template>
      <template v-else>
        <UiInput
          v-model.trim="newShowcaseName"
          type="text"
          placeholder="展示柜名称"
          maxlength="30"
          class="w-36 text-sm"
          @keydown.enter="handleCreate"
        />
        <UiButton variant="outline" size="sm" :disabled="!newShowcaseName.trim() || busy" @click="handleCreate">确定</UiButton>
        <UiButton variant="ghost" size="sm" @click="showCreateInput = false">取消</UiButton>
      </template>

      <span class="ml-auto text-xs text-neutral-500 dark:text-neutral-400">
        {{ props.showcases.length }} / {{ meta.maxCount }} 展示柜
        <template v-if="canCreateFree"> · 还可免费创建 {{ meta.freeCount - props.showcases.length }} 个</template>
        <template v-else-if="canCreatePaid"> · 解锁需 {{ formatTokens(meta.unlockCost) }} Token</template>
      </span>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="space-y-4">
      <GachaSkeleton variant="row" />
      <GachaSkeleton variant="row" />
    </div>

    <!-- Empty -->
    <GachaEmptyState v-else-if="!props.showcases.length" icon="🏛️" title="暂无展示柜" description="创建展示柜来展示你的珍藏卡片" />

    <!-- Showcase List -->
    <div v-else class="space-y-4">
      <article
        v-for="sc in props.showcases"
        :key="sc.id"
        class="surface-card overflow-hidden rounded-2xl border border-neutral-200/70 dark:border-neutral-700/70"
      >
        <!-- Showcase Header -->
        <header class="flex flex-wrap items-center gap-2 border-b border-neutral-200/50 px-4 py-3 dark:border-neutral-700/50">
          <template v-if="renamingId === sc.id">
            <UiInput
              v-model.trim="renameValue"
              class="w-40 text-sm"
              maxlength="30"
              @keydown.enter="confirmRename(sc.id)"
            />
            <UiButton variant="outline" size="sm" :disabled="busy" @click="confirmRename(sc.id)">保存</UiButton>
            <UiButton variant="ghost" size="sm" @click="renamingId = null">取消</UiButton>
          </template>
          <template v-else>
            <h3 class="text-sm font-semibold text-neutral-900 dark:text-neutral-50">{{ sc.name }}</h3>
            <span class="text-[10px] text-neutral-400 dark:text-neutral-500">
              {{ sc.slots.filter((s) => s.card).length }} / {{ meta.slotMax }} 张
            </span>
            <div class="ml-auto flex gap-1">
              <UiButton variant="ghost" size="sm" :disabled="busy" @click="startRename(sc)">重命名</UiButton>
              <UiButton variant="ghost" size="sm" class="text-rose-500" :disabled="busy" @click="askDelete(sc)">删除</UiButton>
            </div>
          </template>
        </header>

        <!-- Slots Grid -->
        <div class="grid grid-cols-2 gap-3 p-3 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-10">
          <div
            v-for="slot in sc.slots"
            :key="`slot-${sc.id}-${slot.slotIndex}`"
            class="showcase-slot"
            :class="{ 'showcase-slot--filled': slot.card }"
          >
            <template v-if="slot.card">
              <div class="showcase-slot__card">
                <GachaCard
                  :title="slot.card.title"
                  :rarity="slot.card.rarity"
                  :tags="slot.card.tags ?? []"
                  :authors="slot.card.authors"
                  :image-url="slot.card.imageUrl || undefined"
                  :wikidot-id="slot.card.wikidotId"
                  variant="mini"
                  :hide-footer="true"
                  :affix-visual-style="slot.card.affixVisualStyle"
                  :affix-signature="slot.card.affixSignature"
                  :affix-label="slot.card.affixLabel"
                />
              </div>
              <button
                type="button"
                class="showcase-slot__clear"
                :disabled="busy"
                @click.stop="emit('clearSlot', sc.id, slot.slotIndex)"
              >
                x
              </button>
            </template>
            <template v-else>
              <button
                type="button"
                class="showcase-slot__empty"
                :disabled="busy"
                @click="openPicker(sc.id, slot.slotIndex)"
              >
                <span class="text-lg leading-none">+</span>
                <span class="mt-1 text-[10px] font-medium">放入卡片</span>
              </button>
            </template>
          </div>
        </div>
      </article>
    </div>

    <!-- Picker Dialog -->
    <GachaShowcaseSlotPicker
      :open="pickerOpen"
      :options="pickerOptions"
      :loading="pickerLoading"
      :busy="busy"
      @close="pickerOpen = false"
      @select="handlePickerSelect"
    />

    <!-- Delete Confirm -->
    <GachaConfirmDialog
      :open="!!deleteConfirmId"
      title="确认删除展示柜"
      :description="`确定删除展示柜「${deleteConfirmName}」吗？展示柜内的卡片将被释放回库存。`"
      confirm-text="删除"
      :danger="true"
      :busy="busy"
      @cancel="deleteConfirmId = null"
      @confirm="handleDelete"
    />
  </div>
</template>

<style scoped>
.showcase-slot {
  position: relative;
  min-width: 0;
}

.showcase-slot--filled {
  cursor: default;
}

.showcase-slot__card {
  height: 100%;
}

.showcase-slot__card :deep(.gacha-card) {
  height: 100%;
}

.showcase-slot__empty {
  display: flex;
  height: 100%;
  min-height: 180px;
  width: 100%;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-radius: 0.9rem;
  border: 2px dashed rgb(229 229 229);
  color: rgb(163 163 163);
  transition: border-color .2s ease, color .2s ease, background-color .2s ease;
}

.showcase-slot__empty:hover {
  border-color: rgb(163 163 163);
  color: rgb(82 82 82);
  background: rgb(245 245 245 / 0.65);
}

html.dark .showcase-slot__empty {
  border-color: rgb(64 64 64);
  color: rgb(115 115 115);
}

html.dark .showcase-slot__empty:hover {
  border-color: rgb(115 115 115);
  color: rgb(212 212 212);
  background: rgb(23 23 23 / 0.8);
}

.showcase-slot__clear {
  position: absolute;
  right: 4px;
  top: 4px;
  z-index: 2;
  display: flex;
  height: 18px;
  width: 18px;
  align-items: center;
  justify-content: center;
  border-radius: 9999px;
  border: 1px solid rgb(255 255 255 / 0.2);
  background: rgb(0 0 0 / 0.5);
  color: white;
  font-size: 10px;
  line-height: 1;
  transition: background-color .15s ease;
}

.showcase-slot__clear:hover {
  background: rgb(244 63 94 / 0.9);
}
</style>
