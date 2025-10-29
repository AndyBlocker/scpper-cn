<template>
  <div class="rounded-lg border border-[rgba(var(--panel-border),0.55)] bg-[rgba(var(--panel),0.9)] shadow-sm">
    <div class="flex items-center justify-between border-b border-[rgba(var(--panel-border),0.45)] px-3 py-2">
      <NuxtLink
        :to="`/tag/${encodeURIComponent(tag)}`"
        class="text-sm font-semibold text-[rgb(var(--fg))] hover:text-[rgb(var(--accent))]"
      >
        #{{ tag }}
      </NuxtLink>
      <div class="text-xs text-[rgba(var(--muted),0.85)]" v-if="lovers && haters">共 {{ Math.max(lovers.total, haters.total) }} 人</div>
    </div>
    <div class="p-3">
      <div v-if="pending" class="text-sm text-[rgb(var(--muted))]">加载中...</div>
      <div v-else-if="error" class="text-sm text-red-500">{{ error }}</div>
      <div v-else class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div>
          <div class="mb-2 text-xs font-medium text-[rgb(var(--success))]">Lovers（↑最多）</div>
          <ul class="divide-y divide-[rgba(var(--panel-border),0.35)]">
            <li v-for="(u, idx) in (lovers?.rows || [])" :key="`${tag}-lov-${idx}-${u.wikidotId}`" class="flex items-center justify-between gap-3 py-2">
              <div class="flex items-center gap-2 min-w-0">
                <UserAvatar :wikidot-id="u.wikidotId" :name="u.displayName || String(u.wikidotId)" :size="24" class="ring-1 ring-[rgba(var(--panel-border),0.55)]" />
                <NuxtLink :to="`/user/${u.wikidotId}`" class="truncate text-sm font-medium text-[rgb(var(--fg))] hover:text-[rgb(var(--accent))]">
                  {{ u.displayName || '未知用户' }}
                </NuxtLink>
              </div>
              <div class="text-xs shrink-0 inline-flex items-center gap-1">
                <span class="tag-chip success">+{{ u.up }}</span>
                <span class="tag-chip danger">-{{ u.down }}</span>
              </div>
            </li>
          </ul>
          <div class="flex items-center justify-between mt-2" v-if="lovers">
            <button
              class="px-2 py-1 text-xs rounded border border-[rgba(var(--input-border),0.55)] bg-[rgba(var(--input-bg),0.96)] text-[rgb(var(--muted-strong))] transition hover:border-[rgba(var(--accent),0.35)] disabled:opacity-50"
              :disabled="(lovers.offset || 0) <= 0"
              @click="emit('update:offset-lovers', Math.max(0, (lovers.offset || 0) - limit))"
            >上一页</button>
            <button
              class="px-2 py-1 text-xs rounded border border-[rgba(var(--input-border),0.55)] bg-[rgba(var(--input-bg),0.96)] text-[rgb(var(--muted-strong))] transition hover:border-[rgba(var(--accent),0.35)] disabled:opacity-50"
              :disabled="(lovers.offset || 0) + (lovers.limit || 0) >= (lovers.total || 0)"
              @click="emit('update:offset-lovers', (lovers.offset || 0) + limit)"
            >下一页</button>
          </div>
        </div>

        <div>
          <div class="mb-2 text-xs font-medium text-[rgb(var(--danger))]">Haters（↓最多）</div>
          <ul class="divide-y divide-[rgba(var(--panel-border),0.35)]">
            <li v-for="(u, idx) in (haters?.rows || [])" :key="`${tag}-hat-${idx}-${u.wikidotId}`" class="flex items-center justify-between gap-3 py-2">
              <div class="flex items-center gap-2 min-w-0">
                <UserAvatar :wikidot-id="u.wikidotId" :name="u.displayName || String(u.wikidotId)" :size="24" class="ring-1 ring-[rgba(var(--panel-border),0.55)]" />
                <NuxtLink :to="`/user/${u.wikidotId}`" class="truncate text-sm font-medium text-[rgb(var(--fg))] hover:text-[rgb(var(--accent))]">
                  {{ u.displayName || '未知用户' }}
                </NuxtLink>
              </div>
              <div class="text-xs shrink-0 inline-flex items-center gap-1">
                <span class="tag-chip danger">-{{ u.down }}</span>
                <span class="tag-chip success">+{{ u.up }}</span>
              </div>
            </li>
          </ul>
          <div class="flex items-center justify-between mt-2" v-if="haters">
            <button
              class="px-2 py-1 text-xs rounded border border-[rgba(var(--input-border),0.55)] bg-[rgba(var(--input-bg),0.96)] text-[rgb(var(--muted-strong))] transition hover:border-[rgba(var(--accent),0.35)] disabled:opacity-50"
              :disabled="(haters.offset || 0) <= 0"
              @click="emit('update:offset-haters', Math.max(0, (haters.offset || 0) - limit))"
            >上一页</button>
            <button
              class="px-2 py-1 text-xs rounded border border-[rgba(var(--input-border),0.55)] bg-[rgba(var(--input-bg),0.96)] text-[rgb(var(--muted-strong))] transition hover:border-[rgba(var(--accent),0.35)] disabled:opacity-50"
              :disabled="(haters.offset || 0) + (haters.limit || 0) >= (haters.total || 0)"
              @click="emit('update:offset-haters', (haters.offset || 0) + limit)"
            >下一页</button>
          </div>
        </div>
      </div>

      <div v-if="!pending && (!lovers || lovers.rows.length === 0) && (!haters || haters.rows.length === 0)" class="text-sm text-[rgb(var(--muted))]">暂无足够数据（需要≥3次投票）。</div>
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
.tag-chip {
  display: inline-flex;
  align-items: center;
  padding: 0.25rem 0.5rem;
  border-radius: 9999px;
  font-weight: 600;
  background-color: rgba(var(--tag-bg), 0.32);
  color: rgb(var(--tag-text));
  border: 1px solid rgba(var(--tag-border), 0.5);
}
.tag-chip.success {
  background-color: rgba(var(--success), 0.18);
  color: rgb(var(--success-strong));
  border-color: rgba(var(--success), 0.4);
}
.tag-chip.danger {
  background-color: rgba(var(--danger), 0.18);
  color: rgb(var(--danger-strong));
  border-color: rgba(var(--danger), 0.4);
}
</style>
