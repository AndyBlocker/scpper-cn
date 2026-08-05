<script setup lang="ts">
import { computed } from 'vue'
import { useNuxtApp, useAsyncData } from 'nuxt/app'
import UserAvatar from '~/components/UserAvatar.vue'
import type { AuthUser } from '~/composables/useAuth'

const props = defineProps<{
  user: AuthUser
  showNotificationsPausedNotice?: boolean
}>()

const { $bff } = useNuxtApp()

interface OverviewLink {
  title: string
  description: string
  icon: string
  to: string
  status?: string
}

const displayName = computed(() => props.user.displayName || '未设置昵称')
const linkedWikidotId = computed(() => {
  const id = Number(props.user.linkedWikidotId)
  return Number.isFinite(id) && id > 0 ? id : null
})
const avatarId = computed(() => linkedWikidotId.value ?? '0')

const wikidotStatus = computed(() => (
  props.user.linkedWikidotId ? '已连接' : '未连接'
))

// AuthUser 只带 linkedWikidotId，展示用户名需要回查 BFF 的公开用户资料
const { data: linkedWikidotProfile } = await useAsyncData(
  () => 'account-overview-wikidot-profile',
  async () => {
    if (!linkedWikidotId.value) return null
    try {
      return await $bff<{ displayName: string | null; username: string | null }>(
        '/users/by-wikidot-id',
        { params: { wikidotId: linkedWikidotId.value } }
      )
    } catch {
      return null
    }
  },
  { server: false, watch: [linkedWikidotId] }
)

const linkedWikidotName = computed(() => (
  linkedWikidotProfile.value?.displayName
  || linkedWikidotProfile.value?.username
  || null
))

const links = computed<OverviewLink[]>(() => [
  {
    title: '个人资料',
    description: '修改昵称，查看邮箱与头像来源',
    icon: 'UserRound',
    to: '/account/profile'
  },
  {
    title: '账号连接',
    description: '连接并管理 Wikidot 身份',
    icon: 'Link2',
    to: '/account/connections',
    status: wikidotStatus.value
  },
  {
    title: '账号安全',
    description: '修改密码或退出当前登录',
    icon: 'ShieldCheck',
    to: '/account/security'
  },
  {
    title: '外观',
    description: '选择主题模式与配色方案',
    icon: 'Palette',
    to: '/settings/appearance'
  },
  {
    title: '收藏夹',
    description: '整理、批注并管理收藏页面',
    icon: 'Bookmark',
    to: '/collections'
  },
  {
    title: '关注',
    description: '查看和管理已关注的作者',
    icon: 'UsersRound',
    to: '/following'
  }
])

function formatLastLogin(value: string | null): string {
  if (!value) return '暂无记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '暂无记录'
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date)
}
</script>

<template>
  <div class="space-y-6">
    <section
      v-if="showNotificationsPausedNotice"
      class="flex items-start gap-3 rounded-lg border border-amber-300/70 bg-amber-50/90 px-4 py-4 text-sm text-amber-950 dark:border-amber-800/70 dark:bg-amber-950/35 dark:text-amber-100"
      role="status"
    >
      <LucideIcon
        name="BellOff"
        class="mt-0.5 h-5 w-5 shrink-0"
        aria-hidden="true"
      />
      <div>
        <h2 class="font-semibold">站内通知功能暂时关闭</h2>
        <p class="mt-1 leading-6">
          提醒与通知设置入口已暂时隐藏。已有数据会保留，你现在无需进行任何操作。
        </p>
      </div>
    </section>

    <section class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-5 shadow-sm sm:p-6">
      <div class="flex flex-col gap-5 sm:flex-row sm:items-center">
        <UserAvatar
          :wikidot-id="avatarId"
          :name="user.displayName || user.email"
          :size="72"
          :eager="true"
          class="shrink-0 ring-1 ring-[rgb(var(--panel-border))]"
        />
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-xl font-semibold text-[rgb(var(--fg))]">
            {{ displayName }}
          </h2>
          <p class="mt-1 truncate text-sm text-[rgb(var(--muted))]">
            {{ user.email }}
          </p>
          <div class="mt-3 flex flex-wrap gap-2 text-xs">
            <NuxtLink
              v-if="linkedWikidotId"
              :to="`/user/${linkedWikidotId}`"
              class="inline-flex items-center gap-1.5 rounded-md border border-emerald-300/70 bg-emerald-50 px-2.5 py-1 text-emerald-800 transition hover:border-emerald-400 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-400/60 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200 dark:hover:border-emerald-700 dark:hover:bg-emerald-900/50"
              :aria-label="`查看已绑定的 Wikidot 用户${linkedWikidotName ? ` ${linkedWikidotName} ` : ''}的用户页`"
            >
              <LucideIcon
                name="CircleCheck"
                class="h-3.5 w-3.5"
                aria-hidden="true"
              />
              Wikidot {{ wikidotStatus }}
              <span
                v-if="linkedWikidotName"
                class="font-semibold"
              >
                {{ linkedWikidotName }}
              </span>
              <LucideIcon
                name="ArrowUpRight"
                class="h-3 w-3"
                aria-hidden="true"
              />
            </NuxtLink>
            <span
              v-else
              class="inline-flex items-center gap-1.5 rounded-md border border-[rgb(var(--panel-border))] bg-[rgb(var(--bg))] px-2.5 py-1 text-[rgb(var(--muted))]"
            >
              <LucideIcon
                name="CircleDashed"
                class="h-3.5 w-3.5"
                aria-hidden="true"
              />
              Wikidot {{ wikidotStatus }}
            </span>
          </div>
        </div>
        <dl class="shrink-0 border-t border-[rgb(var(--panel-border))] pt-4 text-sm sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
          <dt class="text-xs text-[rgb(var(--muted))]">上次登录</dt>
          <dd class="mt-1 font-medium text-[rgb(var(--fg))]">
            {{ formatLastLogin(user.lastLoginAt) }}
          </dd>
        </dl>
      </div>
    </section>

    <section aria-labelledby="account-overview-actions">
      <h2
        id="account-overview-actions"
        class="mb-3 text-sm font-semibold text-[rgb(var(--fg))]"
      >
        管理账号
      </h2>
      <ul class="grid gap-3 sm:grid-cols-2">
        <li
          v-for="item in links"
          :key="item.to"
        >
          <NuxtLink
            :to="item.to"
            class="group flex min-h-28 h-full items-start gap-4 rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-[var(--g-accent-border)] hover:shadow focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)]"
          >
            <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--g-accent-soft)] text-[var(--g-accent)]">
              <LucideIcon
                :name="item.icon"
                class="h-5 w-5"
                stroke-width="1.8"
                aria-hidden="true"
              />
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center justify-between gap-2">
                <span class="font-semibold text-[rgb(var(--fg))]">{{ item.title }}</span>
                <span
                  v-if="item.status"
                  class="text-xs text-[rgb(var(--muted))]"
                >
                  {{ item.status }}
                </span>
              </span>
              <span class="mt-1 block text-sm leading-5 text-[rgb(var(--muted))]">
                {{ item.description }}
              </span>
            </span>
            <LucideIcon
              name="ArrowRight"
              class="mt-1 h-4 w-4 shrink-0 text-[rgb(var(--muted))] transition group-hover:translate-x-0.5 group-hover:text-[var(--g-accent)]"
              aria-hidden="true"
            />
          </NuxtLink>
        </li>
      </ul>
    </section>
  </div>
</template>
