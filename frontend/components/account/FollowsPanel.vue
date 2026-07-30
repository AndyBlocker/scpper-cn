<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import { useFollows } from '~/composables/useFollows'

const { follows, loading, error, fetchFollows, unfollowUser } = useFollows()

const panelRef = ref<HTMLElement | null>(null)
const searchInputRef = ref<HTMLInputElement | null>(null)
const pendingId = ref<number | null>(null)
const confirmId = ref<number | null>(null)
const actionError = ref<string | null>(null)
const liveMessage = ref('')
const query = ref('')

const isBusy = computed(() => loading.value || pendingId.value !== null)
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return follows.value
  return follows.value.filter((f) =>
    String(f.displayName ?? '').toLowerCase().includes(q) || String(f.wikidotId ?? '').includes(q)
  )
})

function authorName(displayName: string | null, wikidotId: number | null) {
  return displayName?.trim() || (wikidotId != null ? `用户 ${wikidotId}` : '未知作者')
}

function focusFollowAction(wikidotId: number) {
  panelRef.value
    ?.querySelector<HTMLButtonElement>(`[data-follow-action="${wikidotId}"]`)
    ?.focus()
}

function focusNearestFollowAction(previousIndex: number) {
  const actions = Array.from(
    panelRef.value?.querySelectorAll<HTMLButtonElement>('[data-follow-action]') ?? []
  )
  const nextAction = actions[Math.min(previousIndex, actions.length - 1)]
  if (nextAction) {
    nextAction.focus()
    return
  }
  searchInputRef.value?.focus()
}

async function openConfirmation(wikidotId: number) {
  if (pendingId.value !== null) return
  actionError.value = null
  confirmId.value = wikidotId
  await nextTick()
  panelRef.value
    ?.querySelector<HTMLButtonElement>(`[data-confirm-cancel="${wikidotId}"]`)
    ?.focus()
}

async function cancelConfirmation(wikidotId: number) {
  if (pendingId.value === wikidotId) return
  confirmId.value = null
  await nextTick()
  focusFollowAction(wikidotId)
}

async function loadFollows(force: boolean) {
  if (loading.value) return
  liveMessage.value = force ? '正在刷新关注列表' : '正在加载关注列表'
  await fetchFollows(force)
  if (error.value) {
    // 错误由 role="alert" 立即播报，避免 status 仍停留在“正在加载”。
    liveMessage.value = ''
    return
  }
  liveMessage.value = force
    ? `关注列表已刷新，共 ${follows.value.length} 位作者`
    : `关注列表加载完成，共 ${follows.value.length} 位作者`
}

async function handleUnfollow(
  wikidotId: number,
  displayName: string | null
) {
  if (pendingId.value !== null) return
  const name = authorName(displayName, wikidotId)
  const previousIndex = filtered.value.findIndex((follow) => follow.wikidotId === wikidotId)
  pendingId.value = wikidotId
  actionError.value = null
  liveMessage.value = `正在取消关注 ${name}`
  try {
    // unfollowUser 会在 DELETE 后同步一次列表；成功后不要再额外 fetch。
    const result = await unfollowUser(wikidotId)
    if (!result?.ok) throw new Error('unfollow_failed')
    confirmId.value = null
    liveMessage.value = `已取消关注 ${name}`
    await nextTick()
    focusNearestFollowAction(Math.max(previousIndex, 0))
  } catch {
    actionError.value = '取消关注失败，请稍后重试'
    liveMessage.value = `取消关注 ${name} 失败`
  } finally {
    pendingId.value = null
  }
}

onMounted(() => { void loadFollows(false) })
</script>

<template>
  <section
    ref="panelRef"
    class="space-y-5"
    aria-labelledby="following-list-title"
    :aria-busy="isBusy ? 'true' : 'false'"
  >
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="following-list-title" class="text-lg font-semibold text-[rgb(var(--fg))]">
          关注的作者
        </h2>
        <p class="mt-1 text-sm text-[rgb(var(--muted))]">
          查看你关注的作者，或从列表中取消关注。
        </p>
      </div>
      <span
        v-if="follows.length > 0"
        class="rounded-full border border-[rgb(var(--panel-border))] px-2.5 py-1 text-xs text-[rgb(var(--muted))]"
      >
        {{ follows.length }} 位
      </span>
    </div>

    <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {{ liveMessage }}
    </p>

    <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
      <div class="min-w-0 flex-1">
        <label for="following-search" class="sr-only">搜索已关注的作者</label>
        <input
          id="following-search"
          ref="searchInputRef"
          v-model="query"
          type="search"
          autocomplete="off"
          placeholder="搜索已关注的作者"
          class="min-h-11 w-full rounded-lg border border-[rgb(var(--input-border))] bg-[rgb(var(--input-bg))] px-3 py-2 text-sm"
          @input="confirmId = null"
        >
      </div>
      <button
        type="button"
        class="inline-flex min-h-11 w-full shrink-0 items-center justify-center rounded-lg border border-[rgb(var(--panel-border))] px-4 py-2 text-sm font-medium text-[rgb(var(--muted-strong))] transition hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] disabled:cursor-wait disabled:opacity-50 sm:w-auto"
        :disabled="loading"
        aria-controls="following-list"
        @click="loadFollows(true)"
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
      <button
        type="button"
        class="ml-auto inline-flex min-h-10 shrink-0 items-center rounded-lg px-3 text-sm font-medium text-[rgb(var(--warning-strong))] underline disabled:cursor-wait disabled:opacity-50"
        :disabled="loading"
        @click="loadFollows(true)"
      >
        重试
      </button>
    </div>
    <div v-if="actionError" class="rounded-lg border border-[rgb(var(--danger))]/30 bg-[rgb(var(--danger))]/10 px-3 py-2 text-sm text-[rgb(var(--danger-strong))]" role="alert">
      {{ actionError }}
    </div>

    <div v-if="loading && follows.length === 0" class="py-10 text-center text-sm text-[rgb(var(--muted))]">
      正在加载关注列表…
    </div>
    <div v-else-if="follows.length === 0" class="py-10 text-center text-sm text-[rgb(var(--muted))]">
      还没有关注任何作者。浏览作者页面时，可以随时将感兴趣的作者加入这里。
    </div>
    <div v-else-if="filtered.length === 0" class="py-10 text-center text-sm text-[rgb(var(--muted))]">
      没有匹配「{{ query }}」的作者
    </div>

    <ul
      v-else
      id="following-list"
      class="divide-y divide-[rgb(var(--panel-border))]"
      aria-label="已关注的作者"
    >
      <li
        v-for="f in filtered"
        :key="f.id"
        class="flex flex-col items-stretch gap-3 py-3 sm:flex-row sm:items-center"
      >
        <NuxtLink
          v-if="f.wikidotId != null"
          :to="`/user/${f.wikidotId}`"
          class="min-w-0 flex-1 truncate py-2 text-sm font-medium text-[rgb(var(--fg))] hover:text-[var(--g-accent)]"
        >
          {{ authorName(f.displayName, f.wikidotId) }}
        </NuxtLink>
        <span v-else class="min-w-0 flex-1 py-2 text-sm font-medium text-[rgb(var(--fg))]">
          {{ authorName(f.displayName, f.wikidotId) }}
        </span>

        <div
          v-if="f.wikidotId != null && confirmId === f.wikidotId"
          class="w-full rounded-xl border border-[rgb(var(--danger))]/25 bg-[rgb(var(--danger))]/5 p-3 sm:w-auto"
          @keydown.esc.stop.prevent="cancelConfirmation(f.wikidotId)"
        >
          <p
            :id="`unfollow-question-${f.wikidotId}`"
            class="text-sm text-[rgb(var(--fg))]"
          >
            确定取消关注“{{ authorName(f.displayName, f.wikidotId) }}”？
          </p>
          <div class="mt-3 grid grid-cols-1 gap-2 sm:flex sm:justify-end">
            <button
              type="button"
              class="inline-flex min-h-11 items-center justify-center rounded-lg border border-[rgb(var(--panel-border))] px-3 py-2 text-sm font-medium text-[rgb(var(--muted-strong))] disabled:cursor-wait disabled:opacity-50"
              :data-confirm-cancel="f.wikidotId"
              :disabled="pendingId === f.wikidotId"
              :aria-describedby="`unfollow-question-${f.wikidotId}`"
              @click="cancelConfirmation(f.wikidotId)"
            >
              保留关注
            </button>
            <button
              type="button"
              class="inline-flex min-h-11 items-center justify-center rounded-lg bg-[rgb(var(--danger))] px-3 py-2 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-50"
              :disabled="pendingId === f.wikidotId"
              :aria-describedby="`unfollow-question-${f.wikidotId}`"
              @click="handleUnfollow(f.wikidotId, f.displayName)"
            >
              {{ pendingId === f.wikidotId ? '处理中…' : '取消关注' }}
            </button>
          </div>
        </div>
        <button
          v-else-if="f.wikidotId != null"
          type="button"
          class="inline-flex min-h-11 w-full shrink-0 items-center justify-center rounded-lg border border-[rgb(var(--panel-border))] px-3 py-2 text-sm font-medium text-[rgb(var(--muted))] transition hover:border-[rgb(var(--danger))]/40 hover:text-[rgb(var(--danger-strong))] sm:w-auto"
          :data-follow-action="f.wikidotId"
          :aria-label="`取消关注 ${authorName(f.displayName, f.wikidotId)}`"
          @click="openConfirmation(f.wikidotId)"
        >
          取消关注
        </button>
      </li>
    </ul>
  </section>
</template>
