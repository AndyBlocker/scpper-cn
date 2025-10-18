<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg bg-white dark:bg-neutral-900">
    <div class="px-3 py-2 border-b border-neutral-100 dark:border-neutral-800 flex items-center justify-between">
      <div class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">{{ tag }}</div>
      <div class="text-xs text-neutral-500 dark:text-neutral-400" v-if="lovers && haters">共 {{ Math.max(lovers.total, haters.total) }} 人</div>
    </div>
    <div class="p-3">
      <div v-if="pending" class="text-sm text-neutral-500 dark:text-neutral-400">加载中...</div>
      <div v-else-if="error" class="text-sm text-red-500">{{ error }}</div>
      <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div class="text-xs font-medium mb-2 text-green-600 dark:text-green-400">Lovers（↑最多）</div>
          <ul class="divide-y divide-neutral-100 dark:divide-neutral-800">
            <li v-for="(u, idx) in (lovers?.rows || [])" :key="`${tag}-lov-${idx}-${u.wikidotId}`" class="py-2 flex items-center justify-between gap-3">
              <div class="flex items-center gap-2 min-w-0">
                <UserAvatar :wikidot-id="u.wikidotId" :name="u.displayName || String(u.wikidotId)" :size="24" class="ring-1 ring-neutral-200 dark:ring-neutral-800" />
                <NuxtLink :to="`/user/${u.wikidotId}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-[rgb(var(--accent))] truncate">
                  {{ u.displayName || '未知用户' }}
                </NuxtLink>
              </div>
              <div class="text-xs shrink-0 inline-flex items-center gap-1">
                <span class="px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">+{{ u.up }}</span>
                <span class="px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">-{{ u.down }}</span>
              </div>
            </li>
          </ul>
          <div class="flex items-center justify-between mt-2" v-if="lovers">
            <button
              class="px-2 py-1 text-xs rounded border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 disabled:opacity-50"
              :disabled="(lovers.offset || 0) <= 0"
              @click="emit('update:offset-lovers', Math.max(0, (lovers.offset || 0) - limit))"
            >上一页</button>
            <button
              class="px-2 py-1 text-xs rounded border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 disabled:opacity-50"
              :disabled="(lovers.offset || 0) + (lovers.limit || 0) >= (lovers.total || 0)"
              @click="emit('update:offset-lovers', (lovers.offset || 0) + limit)"
            >下一页</button>
          </div>
        </div>

        <div>
          <div class="text-xs font-medium mb-2 text-rose-600 dark:text-rose-400">Haters（↓最多）</div>
          <ul class="divide-y divide-neutral-100 dark:divide-neutral-800">
            <li v-for="(u, idx) in (haters?.rows || [])" :key="`${tag}-hat-${idx}-${u.wikidotId}`" class="py-2 flex items-center justify-between gap-3">
              <div class="flex items-center gap-2 min-w-0">
                <UserAvatar :wikidot-id="u.wikidotId" :name="u.displayName || String(u.wikidotId)" :size="24" class="ring-1 ring-neutral-200 dark:ring-neutral-800" />
                <NuxtLink :to="`/user/${u.wikidotId}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-[rgb(var(--accent))] truncate">
                  {{ u.displayName || '未知用户' }}
                </NuxtLink>
              </div>
              <div class="text-xs shrink-0 inline-flex items-center gap-1">
                <span class="px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">-{{ u.down }}</span>
                <span class="px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">+{{ u.up }}</span>
              </div>
            </li>
          </ul>
          <div class="flex items-center justify-between mt-2" v-if="haters">
            <button
              class="px-2 py-1 text-xs rounded border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 disabled:opacity-50"
              :disabled="(haters.offset || 0) <= 0"
              @click="emit('update:offset-haters', Math.max(0, (haters.offset || 0) - limit))"
            >上一页</button>
            <button
              class="px-2 py-1 text-xs rounded border border-neutral-200 dark:border-neutral-700 text-neutral-700 dark:text-neutral-200 disabled:opacity-50"
              :disabled="(haters.offset || 0) + (haters.limit || 0) >= (haters.total || 0)"
              @click="emit('update:offset-haters', (haters.offset || 0) + limit)"
            >下一页</button>
          </div>
        </div>
      </div>

      <div v-if="!pending && (!lovers || lovers.rows.length === 0) && (!haters || haters.rows.length === 0)" class="text-sm text-neutral-500 dark:text-neutral-400">暂无足够数据（需要≥3次投票）。</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { useNuxtApp } from 'nuxt/app'

type BffFetcher = <T=any>(url: string, options?: any) => Promise<T>
const { $bff } = useNuxtApp()
const bff = $bff as BffFetcher

const props = defineProps<{
  tag: string
  limit: number
  offsetLovers?: number
  offsetHaters?: number
}>()

const emit = defineEmits<{
  (e: 'update:offset-lovers', v: number): void
  (e: 'update:offset-haters', v: number): void
}>()

const lovers = ref<{ rows: any[]; total: number; limit: number; offset: number } | null>(null)
const haters = ref<{ rows: any[]; total: number; limit: number; offset: number } | null>(null)
const pending = ref<boolean>(false)
const error = ref<string | null>(null)

function upRatio(u: any) {
  const up = Math.max(0, Number(u?.up || 0))
  const down = Math.max(0, Number(u?.down || 0))
  const total = Math.max(1, up + down)
  return ((up / total) * 100).toFixed(0) + '%'
}

function downRatio(u: any) {
  const up = Math.max(0, Number(u?.up || 0))
  const down = Math.max(0, Number(u?.down || 0))
  const total = Math.max(1, up + down)
  return ((down / total) * 100).toFixed(0) + '%'
}

async function fetchData() {
  if (!props.tag) return
  try {
    pending.value = true
    error.value = null
    const data = await bff<{
      tag: string
      lovers: { rows: any[]; total: number; limit: number; offset: number }
      haters: { rows: any[]; total: number; limit: number; offset: number }
    }>(`/analytics/tags/${encodeURIComponent(props.tag)}/users`, {
      params: {
        limit: props.limit,
        offsetLovers: props.offsetLovers ?? 0,
        offsetHaters: props.offsetHaters ?? 0,
      }
    })
    lovers.value = data.lovers
    haters.value = data.haters
  } catch (e: any) {
    error.value = e?.message || '加载失败'
  } finally {
    pending.value = false
  }
}

watch(() => [props.tag, props.limit, props.offsetLovers, props.offsetHaters], fetchData, { immediate: true })
</script>

<style scoped>
</style>

