<template>
  <div class="space-y-8 py-10">
    <!-- 无障碍 tablist：旧版是一排裸 button，屏幕阅读器读不出这是一组标签页，
         切换时也不做焦点管理。role/aria-selected/aria-controls + 方向键导航是标配。 -->
    <div
      class="flex flex-wrap items-center gap-2"
      role="tablist"
      aria-label="账号设置"
      @keydown="onTabKeydown"
    >
      <button
        v-for="(tab, i) in accountTabs"
        :id="`tab-${tab.key}`"
        :key="tab.key"
        ref="tabButtons"
        type="button"
        role="tab"
        :aria-selected="activeTab === tab.key"
        :aria-controls="`panel-${tab.key}`"
        :tabindex="activeTab === tab.key ? 0 : -1"
        class="inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-semibold transition"
        :class="activeTab === tab.key
          ? 'border-[var(--g-accent-border)] bg-[var(--g-accent-soft)] text-[var(--g-accent)] shadow-sm'
          : 'border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] text-[rgb(var(--muted))] hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)]'"
        @click="selectTab(tab.key, i)"
      >
        <span>{{ tab.label }}</span>
        <span
          v-if="tab.key === 'alerts' && alertsBadgeCount > 0"
          class="inline-flex min-w-[1.6rem] justify-center rounded-full bg-[var(--g-accent)] px-2 py-0.5 text-[11px] font-semibold text-white"
        >{{ alertsBadgeCount > 99 ? '99+' : alertsBadgeCount }}</span>
      </button>
    </div>

    <!-- 概览面板用 v-show 而非 v-if：QqBindingPanel 里的明文验证码只存在于组件内存
         （服务端只有哈希），组件一销毁就找不回来，而挑战仍是 PENDING —— 用户切个 tab
         回来就得重新生成，可能让已经发出去的好友申请作废。其余面板仍用 v-if。 -->
    <div v-show="activeTab === 'overview'" id="panel-overview" role="tabpanel" aria-labelledby="tab-overview" class="space-y-10">
    <section class="flex flex-col gap-4 rounded-lg border border-white/60 bg-white/80 p-8 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/65 dark:shadow">
      <header class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">个人资料</h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">查看绑定邮箱、用户名与 Wikidot 账号。</p>
        </div>
        <div class="flex items-start gap-3">
          <UserAvatar
            :wikidot-id="avatarId"
            :name="user?.displayName || user?.email || ''"
            :size="64"
            :eager="true"
            class="shrink-0 ring-1 ring-neutral-200 dark:ring-neutral-800"
          />
          <div class="text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
            <div>头像来源：{{ avatarSourceLabel }}</div>
            <div v-if="user?.linkedWikidotId">Wikidot ID：{{ user.linkedWikidotId }}</div>
            <button
              type="button"
              class="mt-2 inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-neutral-600 hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-300"
              @click="handleLogout"
            >退出登录</button>
          </div>
        </div>
      </header>

      <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div class="space-y-4">
          <div>
            <div class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">绑定邮箱</div>
            <div class="mt-1 rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm font-medium text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-200">
              {{ user?.email || '—' }}
            </div>
          </div>

          <form class="space-y-3" @submit.prevent="handleDisplayNameUpdate">
            <div class="flex items-center justify-between">
              <div>
                <div class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">昵称</div>
                <p class="text-[11px] text-neutral-500 dark:text-neutral-500">将在站内展示，可随时修改。</p>
              </div>
              <button
                type="submit"
                class="inline-flex items-center gap-1 rounded-full bg-[var(--g-accent)] px-4 py-1.5 text-xs font-semibold text-white shadow-sm hover:-translate-y-0.5 transition disabled:opacity-60 disabled:cursor-not-allowed"
                :disabled="displayNameSaving || displayNameValue.trim().length === 0"
              >
                <LucideIcon v-if="displayNameSaving" name="Loader2" class="h-3.5 w-3.5 animate-spin" stroke-width="2" />
                <span>{{ displayNameSaving ? '保存中…' : '保存' }}</span>
              </button>
            </div>
            <input
              v-model="displayNameValue"
              type="text"
              maxlength="64"
              class="w-full rounded-lg border border-neutral-200 bg-white/90 px-4 py-3 text-sm text-neutral-900 shadow-sm transition focus:border-[var(--g-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)] dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-100"
              placeholder="输入新的昵称"
            >
            <p v-if="displayNameMessage" :class="displayNameMessageClass" class="text-xs">{{ displayNameMessage }}</p>
          </form>
        </div>

        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Wikidot 绑定</div>
              <p class="text-[11px] text-neutral-500 dark:text-neutral-500">绑定 Wikidot 账号后可使用页面提醒、关注作者等功能。</p>
            </div>
            <div v-if="user?.linkedWikidotId" class="rounded-full border border-[var(--g-accent-border)] bg-[var(--g-accent-soft)] px-3 py-1 text-xs font-semibold text-[var(--g-accent)]">
              已绑定
            </div>
            <div v-else class="rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              未绑定
            </div>
          </div>
          <!-- Already linked: show info -->
          <div v-if="user?.linkedWikidotId" class="rounded-lg border border-neutral-200 bg-neutral-50 px-4 py-4 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
            <div>Wikidot ID：{{ user.linkedWikidotId }}</div>
            <div class="mt-2">
              <NuxtLink :to="`/user/${user.linkedWikidotId}`" class="text-[var(--g-accent)] hover:text-[rgb(var(--accent-strong))]">
                查看在 SCPPER-CN 的作者页
              </NuxtLink>
            </div>
          </div>
          <!-- Not linked: show binding panel -->
          <WikidotBindingPanel v-else />

          <!-- QQ 通知渠道绑定。与 Wikidot 绑定并列，同属「账号绑定」一栏：
               用户找绑定入口一定先来「资料」页，放这里比塞进提醒设置里好找。 -->
          <div class="flex items-center justify-between pt-2">
            <div>
              <div class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">QQ 绑定</div>
              <p class="text-[11px] text-neutral-500 dark:text-neutral-500">绑定后可通过 QQ 私信接收站点通知。</p>
            </div>
            <div v-if="user?.qqBinding?.bound" class="rounded-full border border-[var(--g-accent-border)] bg-[var(--g-accent-soft)] px-3 py-1 text-xs font-semibold text-[var(--g-accent)]">
              已绑定
            </div>
            <div v-else class="rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              未绑定
            </div>
          </div>
          <QqBindingPanel />
        </div>
      </div>
    </section>


    <!-- <section class="rounded-lg border border-white/60 bg-white/80 p-8 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/65 dark:shadow">
      <header class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div class="space-y-1">
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">我的收藏</h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">快速访问常看的页面，记录来自本站的灵感。</p>
        </div>
        <div class="flex items-center gap-4 text-xs text-neutral-500 dark:text-neutral-400">
          <span>页面 {{ favoritePageCards.length }}</span>
        </div>
      </header>
      <div v-if="!hasFavorites" class="mt-6 rounded-lg border border-dashed border-neutral-300 bg-neutral-50/70 px-6 py-12 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
        还没有收藏内容。浏览页面时，点击右上角的星标即可收藏。
      </div>
      <div v-else class="mt-6">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">页面收藏</h3>
          <span v-if="favoritePageOverflow > 0" class="text-xs text-neutral-400 dark:text-neutral-500">
            另有 {{ favoritePageOverflow }} 篇收藏可在本地继续浏览
          </span>
        </div>
        <div v-if="favoritePagePreview.length === 0" class="mt-3 rounded-lg border border-dashed border-neutral-300 bg-neutral-50/70 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
          暂无页面收藏。
        </div>
        <div v-else class="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2">
          <div v-for="page in favoritePagePreview" :key="`fav-page-${page.wikidotId}`" class="relative">
            <PageCard :p="page" size="md" />
            <button
              type="button"
              class="absolute -top-2 -right-2 inline-flex h-8 w-8 items-center justify-center rounded-full border border-white bg-white text-neutral-400 shadow dark:border-neutral-800 dark:bg-neutral-900/90 dark:text-neutral-500 hover:text-rose-500 dark:hover:text-rose-400"
              @click.prevent.stop="handleRemoveFavoritePage(page.wikidotId)"
              aria-label="取消收藏"
            >
              <LucideIcon name="X" class="h-4 w-4" stroke-width="1.8" />
            </button>
          </div>
        </div>
      </div>
    </section> -->

    </div>

    <section v-if="activeTab === 'collections'" id="panel-collections" role="tabpanel" aria-labelledby="tab-collections" class="space-y-4">
      <div
        v-if="hasFavorites"
        class="rounded-lg border border-amber-200/70 bg-amber-50/80 px-5 py-4 text-sm text-amber-700 shadow-sm dark:border-amber-800/70 dark:bg-amber-900/25 dark:text-amber-200"
      >
        检测到你曾使用本地收藏功能。新版“收藏夹”支持云端同步与公开展示，可在下方快速整理；如需查看旧收藏，可在“资料”页的提示中继续访问。
      </div>
      <CollectionManager />
    </section>

    <div v-if="activeTab === 'appearance'" id="panel-appearance" role="tabpanel" aria-labelledby="tab-appearance">
      <AppearanceSettings />
    </div>

    <section v-if="activeTab === 'alerts'" :id="`panel-alerts`" role="tabpanel" aria-labelledby="tab-alerts" class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-6 shadow-sm">
      <div class="mb-4">
        <h2 class="text-base font-semibold text-[rgb(var(--fg))]">提醒</h2>
        <p class="mt-0.5 text-xs text-[rgb(var(--muted))]">
          站点上与你有关的动态。要调整接收哪些内容，请到
          <button type="button" class="text-[var(--g-accent)] hover:underline" @click="activeTab = 'notifications'">通知设置</button>。
        </p>
      </div>
      <div v-if="!hasLinkedWikidot" class="rounded-lg border border-dashed border-[rgb(var(--panel-border))] px-4 py-6 text-sm text-[rgb(var(--muted))]">
        绑定 Wikidot 账号后，即可接收自己页面的评论/投票/编辑提醒，以及关注与论坛动态。
      </div>
      <AlertsFeedPanel v-else />
    </section>

    <section v-if="activeTab === 'notifications'" :id="`panel-notifications`" role="tabpanel" aria-labelledby="tab-notifications" class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-6 shadow-sm">
      <div class="mb-4">
        <h2 class="text-base font-semibold text-[rgb(var(--fg))]">通知设置</h2>
        <p class="mt-0.5 text-xs text-[rgb(var(--muted))]">控制接收哪些提醒、什么条件下触发、以及通过哪些渠道送达。</p>
      </div>
      <div v-if="!hasLinkedWikidot" class="rounded-lg border border-dashed border-[rgb(var(--panel-border))] px-4 py-6 text-sm text-[rgb(var(--muted))]">
        绑定 Wikidot 账号后即可配置提醒偏好。QQ 推送同样依赖该绑定 ——
        所有提醒都按你的 Wikidot 身份产生。
      </div>
      <NotificationSettingsPanel v-else />
    </section>

    <section v-if="activeTab === 'follows'" :id="`panel-follows`" role="tabpanel" aria-labelledby="tab-follows" class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-6 shadow-sm">
      <div class="mb-4">
        <h2 class="text-base font-semibold text-[rgb(var(--fg))]">关注</h2>
        <p class="mt-0.5 text-xs text-[rgb(var(--muted))]">关注作者后，他们发布或编辑页面时会出现在「提醒」里。</p>
      </div>
      <div v-if="!hasLinkedWikidot" class="rounded-lg border border-dashed border-[rgb(var(--panel-border))] px-4 py-6 text-sm text-[rgb(var(--muted))]">
        绑定 Wikidot 账号后，即可关注作者并接收他们的更新提醒。
      </div>
      <FollowsPanel v-else />
    </section>

    <section v-if="activeTab === 'security'" id="panel-security" role="tabpanel" aria-labelledby="tab-security" class="rounded-lg border border-white/60 bg-white/80 p-8 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/65 dark:shadow">
      <header class="space-y-1">
        <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">安全设置</h2>
        <p class="text-sm text-neutral-600 dark:text-neutral-400">修改密码后需要重新登录，请妥善保管账户信息。</p>
      </header>
      <form class="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3" @submit.prevent="handlePasswordChange">
        <input v-model="passwordCurrent" type="password" autocomplete="current-password" placeholder="当前密码" class="rounded-lg border border-neutral-200 bg-white/90 px-4 py-3 text-sm text-neutral-900 shadow-sm transition focus:border-[var(--g-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)] dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-100" required />
        <input v-model="passwordNew" type="password" autocomplete="new-password" placeholder="新密码（至少 8 位）" minlength="8" class="rounded-lg border border-neutral-200 bg-white/90 px-4 py-3 text-sm text-neutral-900 shadow-sm transition focus:border-[var(--g-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)] dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-100" required />
        <input v-model="passwordConfirm" type="password" autocomplete="new-password" placeholder="确认新密码" minlength="8" class="rounded-lg border border-neutral-200 bg-white/90 px-4 py-3 text-sm text-neutral-900 shadow-sm transition focus:border-[var(--g-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--g-accent-border)] dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-100" required />
        <div class="md:col-span-3 flex items-center justify-between pt-1">
          <p v-if="passwordMessage" :class="passwordMessageClass" class="text-xs">{{ passwordMessage }}</p>
          <button type="submit" class="inline-flex items-center gap-2 rounded-full bg-neutral-900 px-4 py-2 text-xs font-semibold text-white transition hover:-translate-y-0.5 hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-neutral-900 disabled:opacity-60 disabled:cursor-not-allowed dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200" :disabled="passwordSaving || !passwordsValid">
            <LucideIcon v-if="passwordSaving" name="Loader2" class="h-4 w-4 animate-spin" stroke-width="2" />
            <span>{{ passwordSaving ? '修改中…' : '修改密码' }}</span>
          </button>
        </div>
      </form>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { navigateTo } from 'nuxt/app'
import { useRoute } from 'vue-router'
import UserAvatar from '~/components/UserAvatar.vue'
import PageCard from '~/components/PageCard.vue'
import AppearanceSettings from '~/components/account/AppearanceSettings.vue'
import CollectionManager from '~/components/collections/CollectionManager.vue'
import { useAuth } from '~/composables/useAuth'
import { useAlerts, type AlertItem, type AlertMetric } from '~/composables/useAlerts'
import { useAlertSettings, type RevisionFilterOption } from '~/composables/useAlertSettings'
import { useFollowAlerts, type FollowAlertItem, type FollowAlertType, type FollowCombinedGroup } from '~/composables/useFollowAlerts'
import { useForumInteractionAlerts, type ForumInteractionAlertType, type ForumInteractionAlertItem } from '~/composables/useForumInteractionAlerts'
import { useCombinedAlerts, type CombinedAlertGroup } from '~/composables/useCombinedAlerts'
import { useFavorites } from '~/composables/useFavorites'
import { useFollows } from '~/composables/useFollows'
import { useViewerVotes } from '~/composables/useViewerVotes'
import { orderTags } from '~/composables/useTagOrder'

const { user, fetchCurrentUser, updateProfile, changePassword, status, logout } = useAuth()

const { favoritePages, removePageFavorite } = useFavorites()
const { hydratePages: hydrateViewerVotes } = useViewerVotes()
const isClient = typeof window !== 'undefined'

type AccountTab = 'overview' | 'collections' | 'appearance' | 'alerts' | 'notifications' | 'follows' | 'security'
// 「提醒」与「通知设置」刻意拆成两个 tab：旧版把阈值、修订过滤这些偏好控件
// 直接嵌在提醒列表中间，且只在选中特定指标时才出现 —— 消息和设置混在一起，
// 两边都难用。
const accountTabs: Array<{ key: AccountTab; label: string }> = [
  { key: 'overview', label: '资料' },
  { key: 'alerts', label: '提醒' },
  { key: 'notifications', label: '通知设置' },
  { key: 'follows', label: '关注' },
  { key: 'collections', label: '收藏夹' },
  { key: 'appearance', label: '主题' },
  { key: 'security', label: '安全' }
]
const activeTab = ref<AccountTab>('overview')

/**
 * 这些面板的数据全部按主库 User.id 索引，而 User 由 wikidotId 定义。
 * 没绑 Wikidot 的账号在 BFF 侧会被判为未鉴权，面板挂上去只会一片报错横幅
 * 加一堆点不动的控件 —— 旧版账号页本来有这个守卫，重做时漏掉了。
 */
const hasLinkedWikidot = computed(() => Boolean(user.value?.linkedWikidotId))
const tabButtons = ref<HTMLButtonElement[]>([])

function selectTab(key: AccountTab, index?: number) {
  activeTab.value = key
  if (typeof index === 'number') {
    // 焦点跟随选中项，方向键导航才有意义
    void nextTick(() => tabButtons.value?.[index]?.focus())
  }
}

/** 方向键在标签间移动（WAI-ARIA tabs 模式），Home/End 跳首尾 */
function onTabKeydown(e: KeyboardEvent) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']
  if (!keys.includes(e.key)) return
  e.preventDefault()
  const cur = accountTabs.findIndex((t) => t.key === activeTab.value)
  let next = cur
  if (e.key === 'ArrowLeft') next = (cur - 1 + accountTabs.length) % accountTabs.length
  else if (e.key === 'ArrowRight') next = (cur + 1) % accountTabs.length
  else if (e.key === 'Home') next = 0
  else next = accountTabs.length - 1
  const target = accountTabs[next]
  if (target) selectTab(target.key, next)
}
const route = useRoute()

// 切 tab 时同步 ?tab=，否则刷新/复制链接/浏览器后退都会回到默认 tab。
// 这个 watch 在上一版清理生命周期时被连带删掉了，属于回归。
watch(activeTab, (tab) => {
  if (!isClient) return
  const current = resolveTabFromQuery(route.query.tab) ?? 'overview'
  if (current === tab) return
  const query: Record<string, string | string[]> = { ...route.query } as Record<string, string | string[]>
  if (tab === 'overview') delete query.tab
  else query.tab = tab
  void navigateTo({ path: route.path, query }, { replace: true })
})

const resolveTabFromQuery = (value: unknown): AccountTab | null => {
  const raw = Array.isArray(value) ? value[0] : value
  if (typeof raw !== 'string') return null
  return accountTabs.some((tab) => tab.key === raw) ? raw as AccountTab : null
}

const initialTab = resolveTabFromQuery(route.query.tab)
if (initialTab && initialTab !== activeTab.value) {
  activeTab.value = initialTab
}

watch(() => route.query.tab, (next) => {
  // query 消失（浏览器后退到 /account）时要回落到 overview，
  // 否则 URL 显示默认页而界面仍停在「提醒」面板。
  const resolved = resolveTabFromQuery(next) ?? 'overview'
  if (resolved !== activeTab.value) {
    activeTab.value = resolved
  }
})

const favoritePageCards = computed(() => favoritePages.value.map((p) => ({
  wikidotId: p.id,
  title: p.title,
  alternateTitle: p.alternateTitle,
  rating: p.rating ?? undefined,
  commentCount: p.commentCount ?? undefined,
  controversy: p.controversy ?? undefined,
  tags: orderTags(p.tags || []),
  snippetHtml: p.snippet ?? null
})))

const hasFavorites = computed(() => favoritePageCards.value.length > 0)
const favoritePagePreview = computed(() => favoritePageCards.value.slice(0, 9))
const favoritePageOverflow = computed(() => Math.max(0, favoritePageCards.value.length - favoritePagePreview.value.length))
// 求和而非 Math.max：旧版取三者最大值，3 条页面提醒 + 2 条论坛 + 1 条关注
// 会显示成 3 而不是 6，系统性少报。
// 另外「关注」tab 不再挂未读徽标 —— 它现在只管关注列表，提醒统一在「提醒」tab，
// 旧版两个 tab 对同一批未读重复计数。
const notificationFeed = useNotificationFeed()
const alertsBadgeCount = computed(() => Number(notificationFeed.totalUnread.value) || 0)

watch(
  () => favoritePageCards.value,
  (cards) => {
    if (!isClient) return
    if (!Array.isArray(cards) || cards.length === 0) return
    void hydrateViewerVotes(cards as any[])
  },
  { immediate: true, flush: 'post' }
)



function handleRemoveFavoritePage(id: number) {
  removePageFavorite(id)
}

onMounted(() => {
  // 只负责登录态与重定向；各 tab 的数据由对应面板在挂载时自行获取。
  // 旧版在这里一次性预取 5 份数据（提醒偏好、指标提醒、聚合提醒、关注提醒、论坛提醒），
  // 而默认只有「资料」tab 可见，其余四份当场作废；status 与 linkedWikidotId 的两个
  // watch 还会各自再打一轮。
  if (status.value === 'unknown') {
    fetchCurrentUser().catch((err) => {
      console.warn('[account] fetchCurrentUser failed', err)
    })
  } else if (status.value === 'unauthenticated') {
    navigateTo('/auth/login', { replace: true })
  }
})

watch(status, (next) => {
  if (next === 'unauthenticated') {
    navigateTo('/auth/login', { replace: true })
  }
})

const displayNameValue = ref('')
const displayNameSaving = ref(false)
const displayNameMessage = ref('')

watch(user, (next) => {
  displayNameValue.value = next?.displayName || ''
}, { immediate: true })

const displayNameMessageClass = computed(() => (
  displayNameMessage.value.startsWith('成功')
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400'
))

async function handleDisplayNameUpdate() {
  const input = displayNameValue.value.trim()
  if (!input) {
    displayNameMessage.value = '昵称不能为空'
    return
  }
  displayNameSaving.value = true
  displayNameMessage.value = ''
  const result = await updateProfile({ displayName: input })
  displayNameSaving.value = false
  if (result.ok) {
    displayNameMessage.value = '成功更新昵称'
  } else {
    displayNameMessage.value = result.error || '更新失败'
  }
}

const avatarId = computed(() => {
  if (user.value?.linkedWikidotId && Number(user.value.linkedWikidotId) > 0) {
    return user.value.linkedWikidotId
  }
  return '0'
})

const avatarSourceLabel = computed(() => (
  user.value?.linkedWikidotId ? 'Wikidot 头像' : '默认头像'
))

const passwordCurrent = ref('')
const passwordNew = ref('')
const passwordConfirm = ref('')
const passwordSaving = ref(false)
const passwordMessage = ref('')

const passwordsValid = computed(() => {
  return passwordCurrent.value.length >= 1 && passwordNew.value.length >= 8 && passwordNew.value === passwordConfirm.value
})

const passwordMessageClass = computed(() => (
  passwordMessage.value.startsWith('密码已修改')
    ? 'text-green-600 dark:text-green-400'
    : 'text-red-600 dark:text-red-400'
))

async function handlePasswordChange() {
  if (!passwordsValid.value || passwordSaving.value) return
  passwordSaving.value = true
  passwordMessage.value = ''
  const result = await changePassword({ currentPassword: passwordCurrent.value, newPassword: passwordNew.value })
  passwordSaving.value = false
  if (result.ok) {
    passwordMessage.value = '密码已修改，请重新登录。'
    passwordCurrent.value = ''
    passwordNew.value = ''
    passwordConfirm.value = ''
  } else {
    passwordMessage.value = result.error || '修改失败'
  }
}

async function handleLogout() {
  await logout()
  navigateTo('/auth/login')
}

// Advanced panel (less-frequently-used settings)
</script>
