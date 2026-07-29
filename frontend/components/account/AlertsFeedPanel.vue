<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useNotificationFeed, type FeedKind } from '~/composables/useNotificationFeed'

/**
 * 提醒时间线 —— **只有消息，没有任何设置**。
 *
 * 旧版把投票阈值、修订过滤这些偏好控件直接嵌在提醒列表中间（且只在选中特定指标时
 * 才出现），用户既找不到设置、也看不清消息。现在设置全部移到「通知设置」tab，
 * 这里专心做一件事：按时间倒序展示发生了什么。
 */

const feed = useNotificationFeed()
const {
  items, kindFilter, showRead, unreadByKind, totalUnread, hasHiddenUnread,
  loading, error, refresh, markRead, markAllRead
} = feed

const busy = ref(false)
const markingKey = ref<string | null>(null)

const KINDS: Array<{ key: FeedKind; label: string }> = [
  { key: 'page', label: '我的页面' },
  { key: 'follow', label: '关注的人' },
  { key: 'forum', label: '论坛' }
]

const isEmpty = computed(() => !loading.value && items.value.length === 0)

const emptyText = computed(() => {
  if (kindFilter.value === 'page') return showRead.value ? '还没有关于你页面的提醒' : '你的页面暂无未读提醒'
  if (kindFilter.value === 'follow') return showRead.value ? '关注的作者还没有新动态' : '关注的作者暂无未读动态'
  if (kindFilter.value === 'forum') return showRead.value ? '还没有论坛互动' : '暂无未读论坛互动'
  return showRead.value ? '还没有任何提醒' : '没有未读提醒'
})

async function handleRefresh() {
  if (busy.value) return
  busy.value = true
  try { await refresh(true) } finally { busy.value = false }
}

async function handleMarkAll() {
  if (busy.value) return
  busy.value = true
  try { await markAllRead() } finally { busy.value = false }
}

async function handleMarkOne(key: string, item: Parameters<typeof markRead>[0]) {
  if (markingKey.value) return
  markingKey.value = key
  try { await markRead(item) } finally { markingKey.value = null }
}

/**
 * 勾选「显示已读」要重新取数：首次请求带了 unreadOnly=1，
 * 本地状态里压根没有已读条目，只改本地过滤会什么都显示不出来。
 */

/**
 * 空态提示里的「加载更早的未读」。
 *
 * 这里**不能**切到「显示已读」口径：每个来源只返回最近 20 条，
 * 用户把这 20 条逐条读完之后，含已读那份查询返回的还是同样这 20 条
 * （只是现在都成了已读），更早的未读依旧看不到 —— 提示等于骗人。
 * 正确做法是按未读口径重新拉一次：刚读掉的已经不在未读结果里，
 * 更早的未读自然就补进这一页了。
 */
async function loadEarlierUnread() {
  if (busy.value) return
  busy.value = true
  try { await refresh(true) } finally { busy.value = false }
}

async function handleShowReadChange() {
  if (busy.value) return
  busy.value = true
  try { await refresh(true) } finally { busy.value = false }
}

/**
 * 点开通知即视为已读 —— 旧版账号页就是这个行为。
 * 不这么做的话，用户点进去看完回来，条目和铃铛计数都还是未读，
 * 必须再点一次那个小小的「已读」才行。
 * 不 await：跳转不该等这个请求。
 */
function handleOpen(item: Parameters<typeof markRead>[0]) {
  if (item.read) return
  void markRead(item)
}

let stopVis: (() => void) | null = null

onMounted(async () => {
  await refresh(false)
  const onVis = () => { if (!document.hidden) void refresh(false) }
  document.addEventListener('visibilitychange', onVis)
  stopVis = () => document.removeEventListener('visibilitychange', onVis)
})

onBeforeUnmount(() => { stopVis?.() })
</script>

<template>
  <div class="space-y-4">
    <!-- 头部：筛选 + 操作。窄屏用 flex-wrap，旧版这里没有 wrap，375px 下控件会被挤出卡片 -->
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex flex-wrap gap-1.5" role="group" aria-label="按类型筛选提醒">
        <button
          type="button"
          class="rounded-full border px-3 py-1 text-xs transition"
          :class="kindFilter === null
            ? 'border-[var(--g-accent-border)] bg-[var(--g-accent-soft)] text-[var(--g-accent)]'
            : 'border-[rgb(var(--panel-border))] text-[rgb(var(--muted))] hover:bg-[rgb(var(--panel-border))]/30'"
          :aria-pressed="kindFilter === null"
          @click="kindFilter = null"
        >
          全部
          <span v-if="totalUnread > 0" class="ml-1 font-semibold">{{ totalUnread }}</span>
        </button>
        <button
          v-for="k in KINDS"
          :key="k.key"
          type="button"
          class="rounded-full border px-3 py-1 text-xs transition"
          :class="kindFilter === k.key
            ? 'border-[var(--g-accent-border)] bg-[var(--g-accent-soft)] text-[var(--g-accent)]'
            : 'border-[rgb(var(--panel-border))] text-[rgb(var(--muted))] hover:bg-[rgb(var(--panel-border))]/30'"
          :aria-pressed="kindFilter === k.key"
          @click="kindFilter = k.key"
        >
          {{ k.label }}
          <span v-if="unreadByKind[k.key] > 0" class="ml-1 font-semibold">{{ unreadByKind[k.key] }}</span>
        </button>
      </div>

      <div class="ml-auto flex items-center gap-3">
        <label class="flex cursor-pointer items-center gap-1.5 text-xs text-[rgb(var(--muted))]">
          <input
            v-model="showRead"
            type="checkbox"
            class="h-3.5 w-3.5 rounded border-[rgb(var(--input-border))]"
            @change="handleShowReadChange"
          >
          显示已读
        </label>
        <button
          type="button"
          class="text-xs text-[rgb(var(--muted))] hover:underline disabled:opacity-50"
          :disabled="busy"
          @click="handleRefresh"
        >
          {{ busy || loading ? '刷新中…' : '刷新' }}
        </button>
        <button
          v-if="totalUnread > 0"
          type="button"
          class="text-xs text-[var(--g-accent)] hover:underline disabled:opacity-50"
          :disabled="busy"
          @click="handleMarkAll"
        >
          全部已读
        </button>
      </div>
    </div>

    <!-- 错误态：旧版任何失败都会把列表清空成「暂无提醒」，用户以为提醒被清掉了。
         现在保留已有数据，只在顶部提示并给出重试入口。 -->
    <div
      v-if="error"
      class="flex items-center gap-3 rounded-lg border border-[rgb(var(--warning))]/30 bg-[rgb(var(--warning))]/10 px-3 py-2"
      role="alert"
    >
      <span class="text-sm text-[rgb(var(--warning-strong))]">{{ error }}</span>
      <button
        type="button"
        class="ml-auto shrink-0 text-xs text-[rgb(var(--warning-strong))] underline disabled:opacity-50"
        :disabled="busy"
        @click="handleRefresh"
      >
        重试
      </button>
    </div>

    <div v-if="loading && items.length === 0" class="py-10 text-center text-sm text-[rgb(var(--muted))]">
      正在加载提醒…
    </div>

    <div v-else-if="isEmpty" class="py-10 text-center text-sm text-[rgb(var(--muted))]">
      <p>{{ emptyText }}</p>
      <!-- 每个来源只返回最近 20 条，未读过滤在截断之后。徽标有数字而这里为空时，
           说明未读条目在更早的位置，提示用户怎么看到它们，而不是让界面自相矛盾。 -->
      <p v-if="hasHiddenUnread" class="mt-2 text-xs">
        还有 {{ totalUnread }} 条未读在更早的记录里，
        <button type="button" class="text-[var(--g-accent)] hover:underline disabled:opacity-50" :disabled="busy" @click="loadEarlierUnread">
          {{ busy ? '加载中…' : '加载更早的未读' }}
        </button>
      </p>
    </div>

    <ul v-else class="divide-y divide-[rgb(var(--panel-border))]">
      <li
        v-for="item in items"
        :key="item.key"
        class="flex gap-3 py-3"
        :class="item.read ? 'opacity-60' : ''"
      >
        <!-- 未读标记不只用颜色：小圆点 + 文字标签，色觉障碍用户也能分辨。
             旧版只有一个纯装饰 span 挂 aria-label，多数辅助技术会忽略。 -->
        <span class="mt-1.5 shrink-0" aria-hidden="true">
          <span
            class="block h-2 w-2 rounded-full"
            :class="item.read ? 'bg-transparent' : 'bg-[var(--g-accent)]'"
          />
        </span>

        <div class="min-w-0 flex-1">
          <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span
              class="rounded px-1.5 py-0.5 text-[10px] font-medium"
              :class="{
                'bg-[var(--g-accent-soft)] text-[var(--g-accent)]': item.kind === 'page',
                'bg-[rgb(var(--success))]/10 text-[rgb(var(--success-strong))]': item.kind === 'follow',
                'bg-[rgb(var(--tag-bg))] text-[rgb(var(--tag-text))]': item.kind === 'forum'
              }"
            >{{ feed.KIND_LABEL[item.kind] }}</span>
            <span v-if="!item.read" class="sr-only">未读</span>
            <span class="text-xs text-[rgb(var(--muted))]">{{ item.timeLabel }}</span>
          </div>

          <component
            :is="item.href ? 'NuxtLink' : 'div'"
            v-bind="item.href ? { to: item.href } : {}"
            class="mt-1 block text-sm text-[rgb(var(--fg))]"
            :class="[item.read ? '' : 'font-medium', item.href ? 'hover:text-[var(--g-accent)]' : '']"
            @click="handleOpen(item)"
          >
            {{ item.title }}
          </component>

          <p v-if="item.detail" class="mt-0.5 line-clamp-2 text-xs text-[rgb(var(--muted))]">
            {{ item.detail }}
          </p>
        </div>

        <!-- 单条已读。旧版关注提醒完全没有这个按钮（markRead 是死代码），
             用户只能用「全部已读」一次性清空，无法逐条处理。 -->
        <button
          v-if="!item.read"
          type="button"
          class="shrink-0 self-start text-xs text-[rgb(var(--muted))] hover:text-[var(--g-accent)] disabled:opacity-50"
          :disabled="markingKey === item.key"
          :aria-label="`将「${item.title}」标记为已读`"
          @click="handleMarkOne(item.key, item)"
        >
          {{ markingKey === item.key ? '…' : '已读' }}
        </button>
      </li>
    </ul>

    <p v-if="items.length > 0" class="pt-1 text-[11px] text-[rgb(var(--muted))]">
      每类最多展示最近 20 条
    </p>
  </div>
</template>
