<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useFollows } from '~/composables/useFollows'

/**
 * 关注管理。
 *
 * 修掉旧版三个问题：
 *  1. 取消关注没有二次确认、没有单行 loading、失败只 console.warn ——
 *     误点即生效且看不出发生了什么；
 *  2. `:disabled="followsLoading"` 会在刷新期间禁用**整列表**的按钮；
 *  3. 一次取消发三个请求（unfollowUser 内部已 fetchFollows(true)，外层又调一次）。
 */

const { follows, loading, error, fetchFollows, unfollowUser } = useFollows()

const pendingId = ref<number | null>(null)
const confirmId = ref<number | null>(null)
const actionError = ref<string | null>(null)
const query = ref('')

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return follows.value
  return follows.value.filter((f) =>
    String(f.displayName ?? '').toLowerCase().includes(q) || String(f.wikidotId ?? '').includes(q)
  )
})

async function handleUnfollow(wikidotId: number) {
  if (pendingId.value) return
  pendingId.value = wikidotId
  actionError.value = null
  try {
    // unfollowUser 内部已经 fetchFollows(true)，这里不再重复拉
    await unfollowUser(wikidotId)
    confirmId.value = null
  } catch {
    actionError.value = '取消关注失败，请稍后重试'
  } finally {
    pendingId.value = null
  }
}

onMounted(() => { void fetchFollows(false) })
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
      <input
        v-model="query"
        type="search"
        placeholder="搜索已关注的作者"
        aria-label="搜索已关注的作者"
        class="min-w-0 flex-1 rounded-lg border border-[rgb(var(--input-border))] bg-[rgb(var(--input-bg))] px-3 py-1.5 text-sm"
      >
      <button
        type="button"
        class="shrink-0 text-xs text-[rgb(var(--muted))] hover:underline disabled:opacity-50"
        :disabled="loading"
        @click="fetchFollows(true)"
      >
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </div>

    <!-- 加载失败时保留已有列表并给出重试。旧版失败后三个渲染分支全不命中，
         卡片里什么都不显示，也没有重试入口。 -->
    <div
      v-if="error"
      class="flex items-center gap-3 rounded-lg border border-[rgb(var(--warning))]/30 bg-[rgb(var(--warning))]/10 px-3 py-2"
      role="alert"
    >
      <span class="text-sm text-[rgb(var(--warning-strong))]">{{ error }}</span>
      <button type="button" class="ml-auto shrink-0 text-xs underline text-[rgb(var(--warning-strong))]" @click="fetchFollows(true)">重试</button>
    </div>
    <div v-if="actionError" class="rounded-lg border border-[rgb(var(--danger))]/30 bg-[rgb(var(--danger))]/10 px-3 py-2 text-sm text-[rgb(var(--danger-strong))]" role="alert">
      {{ actionError }}
    </div>

    <div v-if="loading && follows.length === 0" class="py-10 text-center text-sm text-[rgb(var(--muted))]">
      正在加载关注列表…
    </div>
    <div v-else-if="follows.length === 0" class="py-10 text-center text-sm text-[rgb(var(--muted))]">
      还没有关注任何作者。在作者页点击星标即可关注。
    </div>
    <div v-else-if="filtered.length === 0" class="py-10 text-center text-sm text-[rgb(var(--muted))]">
      没有匹配「{{ query }}」的作者
    </div>

    <ul v-else class="divide-y divide-[rgb(var(--panel-border))]">
      <li v-for="f in filtered" :key="f.id" class="flex items-center gap-3 py-2.5">
        <NuxtLink
          :to="`/user/${f.wikidotId}`"
          class="min-w-0 flex-1 truncate text-sm text-[rgb(var(--fg))] hover:text-[var(--g-accent)]"
        >
          {{ f.displayName || `用户 ${f.wikidotId}` }}
        </NuxtLink>

        <template v-if="confirmId === f.wikidotId">
          <span class="shrink-0 text-xs text-[rgb(var(--muted))]">确定取消关注？</span>
          <button
            type="button"
            class="shrink-0 rounded-lg bg-[rgb(var(--danger))] px-2.5 py-1 text-xs text-white disabled:opacity-50"
            :disabled="pendingId === f.wikidotId"
            @click="handleUnfollow(f.wikidotId!)"
          >
            {{ pendingId === f.wikidotId ? '处理中…' : '确定' }}
          </button>
          <button
            type="button"
            class="shrink-0 text-xs text-[rgb(var(--muted))] hover:underline"
            @click="confirmId = null"
          >
            取消
          </button>
        </template>
        <button
          v-else
          type="button"
          class="shrink-0 rounded-lg border border-[rgb(var(--panel-border))] px-2.5 py-1 text-xs text-[rgb(var(--muted))] hover:text-[rgb(var(--danger-strong))]"
          :aria-label="`取消关注 ${f.displayName || f.wikidotId}`"
          @click="confirmId = f.wikidotId ?? null"
        >
          取消关注
        </button>
      </li>
    </ul>
  </div>
</template>
