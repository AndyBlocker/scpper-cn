<template>
  <div class="space-y-8 py-10">
    <div class="flex flex-wrap items-center gap-2">
      <button
        v-for="tab in accountTabs"
        :key="tab.key"
        type="button"
        class="inline-flex items-center gap-2 rounded-full border px-4 py-1.5 text-sm font-semibold transition"
        :class="activeTab === tab.key
          ? 'border-[rgba(var(--accent),0.35)] bg-[rgba(var(--accent),0.12)] text-[rgb(var(--accent))] shadow-sm'
          : 'border-neutral-200 bg-white/70 text-neutral-600 hover:border-[rgba(var(--accent),0.3)] hover:text-[rgb(var(--accent))] dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-300'"
        @click="activeTab = tab.key"
      >
        <span>{{ tab.label }}</span>
        <span
          v-if="tab.key === 'alerts' && alertsBadgeCount > 0"
          class="inline-flex min-w-[1.6rem] justify-center rounded-full bg-[rgb(var(--accent))] px-2 py-0.5 text-[11px] font-semibold text-white"
        >{{ alertsBadgeCount > 99 ? '99+' : alertsBadgeCount }}</span>
        <span
          v-else-if="tab.key === 'follows' && followBadgeCount > 0"
          class="inline-flex min-w-[1.6rem] justify-center rounded-full bg-[rgb(var(--accent))] px-2 py-0.5 text-[11px] font-semibold text-white"
        >{{ followBadgeCount > 99 ? '99+' : followBadgeCount }}</span>
      </button>
    </div>

    <div v-show="activeTab === 'overview'" class="space-y-10">
    <section class="flex flex-col gap-4 rounded-3xl border border-white/60 bg-white/80 p-8 shadow-[0_22px_55px_rgba(15,23,42,0.10)] backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_32px_70px_rgba(0,0,0,0.55)]">
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
              class="mt-2 inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-neutral-600 hover:border-[rgba(var(--accent),0.3)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-300"
              @click="handleLogout"
            >退出登录</button>
          </div>
        </div>
      </header>

      <div class="grid grid-cols-1 gap-6 md:grid-cols-2">
        <div class="space-y-4">
          <div>
            <div class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">绑定邮箱</div>
            <div class="mt-1 rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm font-medium text-neutral-800 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-200">
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
                class="inline-flex items-center gap-1 rounded-full bg-[rgb(var(--accent))] px-4 py-1.5 text-xs font-semibold text-white shadow-[0_12px_30px_rgba(10,132,255,0.3)] hover:-translate-y-0.5 transition disabled:opacity-60 disabled:cursor-not-allowed"
                :disabled="displayNameSaving || displayNameValue.trim().length === 0"
              >
                <svg v-if="displayNameSaving" class="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v4m0 8v4m8-8h-4M8 12H4m12.364-6.364l-2.828 2.828M9.172 14.828l-2.828 2.828m0-11.656l2.828 2.828m8.486 8.486l2.828 2.828" />
                </svg>
                <span>{{ displayNameSaving ? '保存中…' : '保存' }}</span>
              </button>
            </div>
            <input
              v-model="displayNameValue"
              type="text"
              maxlength="64"
              class="w-full rounded-2xl border border-neutral-200 bg-white/90 px-4 py-3 text-sm text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-100"
              placeholder="输入新的昵称"
            >
            <p v-if="displayNameMessage" :class="displayNameMessageClass" class="text-xs">{{ displayNameMessage }}</p>
          </form>
        </div>

        <div class="space-y-4">
          <div class="flex items-center justify-between">
            <div>
              <div class="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Wikidot 绑定</div>
              <p class="text-[11px] text-neutral-500 dark:text-neutral-500">暂不支持自助绑定，如需修改请联系管理员。</p>
            </div>
            <div v-if="user?.linkedWikidotId" class="rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.1)] px-3 py-1 text-xs font-semibold text-[rgb(var(--accent))]">
              已绑定
            </div>
            <div v-else class="rounded-full border border-neutral-200 px-3 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              未绑定
            </div>
          </div>
          <div class="rounded-2xl border border-neutral-200 bg-neutral-50 px-4 py-4 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
            <template v-if="user?.linkedWikidotId">
              <div>Wikidot ID：{{ user.linkedWikidotId }}</div>
              <div class="mt-2">
                <NuxtLink :to="`/user/${user.linkedWikidotId}`" class="text-[rgb(var(--accent))] hover:text-[rgb(var(--accent-strong))]">
                  查看在 SCPPER-CN 的作者页
                </NuxtLink>
              </div>
            </template>
            <template v-else>
              <div>当前账号尚未绑定 Wikidot 用户。</div>
            </template>
          </div>
        </div>
      </div>
    </section>


    <!-- <section class="rounded-3xl border border-white/60 bg-white/80 p-8 shadow-[0_22px_55px_rgba(15,23,42,0.10)] backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_32px_70px_rgba(0,0,0,0.55)]">
      <header class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div class="space-y-1">
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">我的收藏</h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">快速访问常看的页面，记录来自本站的灵感。</p>
        </div>
        <div class="flex items-center gap-4 text-xs text-neutral-500 dark:text-neutral-400">
          <span>页面 {{ favoritePageCards.length }}</span>
        </div>
      </header>
      <div v-if="!hasFavorites" class="mt-6 rounded-2xl border border-dashed border-neutral-300 bg-neutral-50/70 px-6 py-12 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
        还没有收藏内容。浏览页面时，点击右上角的星标即可收藏。
      </div>
      <div v-else class="mt-6">
        <div class="flex items-center justify-between">
          <h3 class="text-sm font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">页面收藏</h3>
          <span v-if="favoritePageOverflow > 0" class="text-xs text-neutral-400 dark:text-neutral-500">
            另有 {{ favoritePageOverflow }} 篇收藏可在本地继续浏览
          </span>
        </div>
        <div v-if="favoritePagePreview.length === 0" class="mt-3 rounded-2xl border border-dashed border-neutral-300 bg-neutral-50/70 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
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
              <svg class="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </section> -->

    </div>

    <section v-show="activeTab === 'alerts'" class="rounded-3xl border border-white/60 bg-white/80 p-8 shadow-[0_22px_55px_rgba(15,23,42,0.10)] backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_32px_70px_rgba(0,0,0,0.55)]">
      <header class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div class="space-y-1">
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">提醒</h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">查看拥有页面与关注作者的最新动态提醒。</p>
        </div>
        <div class="flex items-center gap-3">
          <!-- source toggle -->
          <div class="inline-flex rounded-full border border-neutral-200 bg-white/80 p-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-900/70">
            <button
              type="button"
              class="rounded-full px-3 py-1 font-semibold transition"
              :class="alertSource === 'page' ? 'bg-[rgba(var(--accent),0.12)] text-[rgb(var(--accent))]' : 'text-neutral-600 dark:text-neutral-300'"
              @click="alertSource = 'page'"
            >
              页面
              <span
                v-if="combinedTotalUnread > 0"
                class="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-[rgb(var(--accent))] align-middle"
                aria-label="页面有未读"
              />
            </button>
            <button
              type="button"
              class="rounded-full px-3 py-1 font-semibold transition"
              :class="alertSource === 'follow' ? 'bg-[rgba(var(--accent),0.12)] text-[rgb(var(--accent))]' : 'text-neutral-600 dark:text-neutral-300'"
              @click="handleSwitchToFollow"
            >
              关注
              <span
                v-if="followCombinedUnread > 0"
                class="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-[rgb(var(--accent))] align-middle"
                aria-label="关注有未读"
              />
            </button>
          </div>
          <!-- page view mode toggle -->
          <div
            v-if="alertSource === 'page'"
            class="inline-flex rounded-full border border-neutral-200 bg-white/80 p-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-900/70"
          >
            <button
              type="button"
              class="rounded-full px-3 py-1 font-semibold transition"
              :class="viewMode === 'metric' ? 'bg-[rgba(var(--accent),0.12)] text-[rgb(var(--accent))]' : 'text-neutral-600 dark:text-neutral-300'"
              @click="viewMode = 'metric'"
            >按指标</button>
            <button
              type="button"
              class="rounded-full px-3 py-1 font-semibold transition"
              :class="viewMode === 'combined' ? 'bg-[rgba(var(--accent),0.12)] text-[rgb(var(--accent))]' : 'text-neutral-600 dark:text-neutral-300'"
              @click="handleSwitchToCombined"
            >按页面</button>
          </div>
          <!-- unread counters based on source -->
          <div
            v-if="alertSource === 'page' && alertsHasUnread && viewMode === 'metric'"
            class="inline-flex items-center rounded-full bg-[rgba(var(--accent),0.12)] px-3 py-1 text-xs font-semibold text-[rgb(var(--accent))]"
          >未读 {{ alertsUnreadCount > 99 ? '99+' : alertsUnreadCount }}</div>
          <div
            v-else-if="alertSource === 'page' && combinedTotalUnread > 0 && viewMode === 'combined'"
            class="inline-flex items-center rounded-full bg-[rgba(var(--accent),0.12)] px-3 py-1 text-xs font-semibold text-[rgb(var(--accent))]"
          >未读 {{ combinedTotalUnread > 99 ? '99+' : combinedTotalUnread }}</div>
          <div
            v-else-if="alertSource === 'follow' && followCombinedUnread > 0"
            class="inline-flex items-center rounded-full bg-[rgba(var(--accent),0.12)] px-3 py-1 text-xs font-semibold text-[rgb(var(--accent))]"
          >未读 {{ followCombinedUnread > 99 ? '99+' : followCombinedUnread }}</div>
        </div>
      </header>
      <div v-if="!hasLinkedWikidot" class="mt-4 rounded-2xl border border-dashed border-neutral-200 bg-white/70 px-4 py-6 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300">
        {{ alertSource === 'page' ? '绑定 Wikidot 账号后，即可自动跟踪自己页面的评论变动并接收提醒。' : '绑定 Wikidot 账号后，即可关注作者并接收提醒。' }}
      </div>
      <div v-else class="mt-4 space-y-5">
        <!-- Follow alerts view -->
        <template v-if="alertSource === 'follow'">
          <div class="flex items-center justify-between gap-3">
            <div class="text-xs text-neutral-500 dark:text-neutral-400">按页面聚合最近未读提醒</div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-neutral-600 hover:border-[rgba(var(--accent),0.35)] hover:text-[rgb(var(--accent))] disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-300"
                :disabled="followCombinedLoading"
                @click="() => fetchFollowCombined(true,20,0)"
              >{{ followCombinedLoading ? '刷新中…' : '刷新' }}</button>
              <button
                v-if="followCombinedUnread > 0"
                type="button"
                class="inline-flex items-center gap-1 rounded-full bg-[rgb(var(--accent))] px-3 py-1.5 text-xs font-semibold text-white shadow-[0_12px_30px_rgba(10,132,255,0.3)] hover:-translate-y-0.5 transition disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="followCombinedLoading"
                @click="markAllFollowRead"
              >全部已读</button>
            </div>
          </div>
          <div v-if="followCombinedLoading" class="rounded-2xl border border-neutral-200 bg-white/80 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300">
            正在加载提醒…
          </div>
          <ul v-else-if="followCombined.length > 0" class="space-y-4">
            <li
              v-for="group in followCombined"
              :key="group.pageId"
              class="rounded-2xl border border-neutral-200 bg-white/80 p-4 shadow-sm transition hover:border-[rgba(var(--accent),0.35)] hover:shadow-[0_15px_35px_rgba(15,23,42,0.12)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:hover:border-[rgba(var(--accent),0.45)]"
            >
              <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div class="space-y-1">
                  <div class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                    {{ group.pageTitle || '未知页面' }}
                  </div>
                  <div v-if="group.pageAlternateTitle" class="text-[11px] text-neutral-500 dark:text-neutral-400">
                    {{ group.pageAlternateTitle }}
                  </div>
                  <div class="mt-2 flex flex-wrap gap-2">
                    <span
                      v-for="alert in group.alerts"
                      :key="alert.id"
                      class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/70 px-2 py-1 text-[11px] font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300"
                    >
                      <span>
                        {{ alert.type === 'REVISION' ? '修订' : (alert.type === 'ATTRIBUTION_REMOVED' ? '署名移除' : '署名') }}
                      </span>
                    </span>
                  </div>
                </div>
                <div class="text-right text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
                  <div>{{ formatAlertTime(group.updatedAt) }}</div>
          <div class="inline-flex items-center justify-center rounded-full bg-[rgba(var(--accent),0.12)] px-2 py-0.5 text-[10px] font-semibold text-[rgb(var(--accent))]">
            未读 {{ group.alerts.filter(a => !a.acknowledgedAt).length }}
          </div>
                </div>
              </div>
              <div class="mt-3 flex items-center justify-between text-xs">
                <NuxtLink
                  v-if="group.pageWikidotId"
                  :to="`/page/${group.pageWikidotId}`"
                  class="inline-flex items-center gap-1 font-medium text-[rgb(var(--accent))] hover:underline"
                >查看页面</NuxtLink>
                <span v-else class="text-neutral-500 dark:text-neutral-400">—</span>
              </div>
            </li>
          </ul>
          <div v-else class="rounded-2xl border border-neutral-200 bg-white/80 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300">
            暂无提醒，去关注喜欢的作者吧～
          </div>
        </template>
        <!-- Metric-based view -->
        <template v-else-if="alertSource === 'page' && viewMode === 'metric'">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex flex-wrap gap-2">
            <button
              v-for="option in availableAlertMetrics"
              :key="option.metric"
              type="button"
              @click="handleMetricChange(option.metric)"
              class="inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold transition"
              :class="alertsActiveMetric === option.metric
                ? 'border-[rgba(var(--accent),0.5)] bg-white/90 text-[rgb(var(--accent))] dark:border-[rgba(var(--accent),0.5)] dark:bg-neutral-900/80'
                : 'border-neutral-200 bg-white/60 text-neutral-600 hover:border-[rgba(var(--accent),0.35)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-900/50 dark:text-neutral-300'"
            >
              <span>{{ option.label }}</span>
              <span
                v-if="(unreadByMetric[option.metric] ?? 0) > 0"
                class="inline-flex min-w-[1.75rem] justify-center rounded-full bg-[rgb(var(--accent))] px-2 py-0.5 text-[10px] font-semibold text-white"
              >
                {{ (unreadByMetric[option.metric] ?? 0) > 99 ? '99+' : unreadByMetric[option.metric] }}
              </span>
            </button>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
            <span>展示最近 20 条提醒</span>
            <span
              v-if="alertsTotalUnread > 0"
              class="inline-flex items-center rounded-full bg-[rgba(var(--accent),0.12)] px-2 py-0.5 font-semibold text-[rgb(var(--accent))]"
            >全部未读 {{ alertsTotalUnread > 99 ? '99+' : alertsTotalUnread }}</span>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-full border px-3 py-1.5 font-semibold transition"
                :class="activeMetricMuted
                  ? 'border-neutral-200 bg-white/60 text-neutral-500 hover:border-neutral-300 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-400'
                  : 'border-[rgba(var(--accent),0.35)] bg-[rgba(var(--accent),0.12)] text-[rgb(var(--accent))] hover:border-[rgba(var(--accent),0.55)] dark:border-[rgba(var(--accent),0.4)] dark:bg-neutral-900/70 dark:text-[rgb(var(--accent))]'"
                :disabled="alertPreferencesLoading || alertPreferencesSaving || metricMutePending"
                @click="handleToggleMetricMute"
              >{{ metricMutePending ? '处理中…' : (activeMetricMuted ? '开启提醒' : '关闭提醒') }}</button>
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 font-semibold text-neutral-600 hover:border-[rgba(var(--accent),0.35)] hover:text-[rgb(var(--accent))] disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-300"
                :disabled="alertsLoading"
                @click="handleRefreshAlerts"
              >{{ alertsLoading ? '刷新中…' : '刷新' }}</button>
              <button
                v-if="alertsHasUnread"
                type="button"
                class="inline-flex items-center gap-1 rounded-full bg-[rgb(var(--accent))] px-3 py-1.5 font-semibold text-white shadow-[0_12px_30px_rgba(10,132,255,0.3)] hover:-translate-y-0.5 transition disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="alertsLoading"
                @click="handleMarkAllAlerts"
              >全部已读</button>
            </div>
          </div>
        </div>
        <p class="text-sm text-neutral-600 dark:text-neutral-400">{{ activeMetricOption.description }}</p>
        <p
          v-if="activeMetricMuted"
          class="text-xs text-amber-600 dark:text-amber-400"
        >当前提醒已关闭，重新开启后才会生成新的提醒。</p>

        <div
          v-if="alertSource === 'page' && (alertsActiveMetric === 'VOTE_COUNT' || alertsActiveMetric === 'REVISION_COUNT')"
          class="rounded-2xl border border-dashed border-neutral-200 bg-white/70 p-4 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
        >
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">提醒设置</h3>
            <span v-if="alertPreferencesLoading" class="text-xs text-neutral-500 dark:text-neutral-400">加载设置中…</span>
          </div>
          <p v-if="alertPreferencesError" class="mt-2 text-xs text-red-500 dark:text-red-400">{{ alertPreferencesError }}</p>
          <div class="mt-4 grid gap-4 md:grid-cols-2">
            <!-- vote threshold only for VOTE_COUNT -->
            <form v-if="alertsActiveMetric === 'VOTE_COUNT'" class="space-y-2" @submit.prevent="handleSaveVoteThreshold">
              <label class="text-xs font-semibold text-neutral-600 dark:text-neutral-300">投票阈值</label>
              <div class="flex items-center gap-2">
                <input
                  v-model.number="voteThresholdInput"
                  type="number"
                  min="1"
                  max="1000"
                  class="w-full rounded-full border border-neutral-200 bg-white/85 px-4 py-2 text-sm text-neutral-800 shadow-sm focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-100"
                  :disabled="voteSaving || alertPreferencesLoading"
                >
                <button
                  type="submit"
                  class="inline-flex items-center rounded-full bg-neutral-900 px-4 py-2 text-xs font-semibold text-white transition hover:-translate-y-0.5 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
                  :disabled="voteSaving || alertPreferencesLoading"
                >{{ voteSaving ? '保存中…' : '保存' }}</button>
              </div>
              <p class="text-xs text-neutral-500 dark:text-neutral-400">仅当投票数变化达到或超过该值时触发提醒（范围 1–1000）。</p>
            </form>
            <!-- revision filter only for REVISION_COUNT -->
            <form v-if="alertsActiveMetric === 'REVISION_COUNT'" class="space-y-2" @submit.prevent="handleSaveRevisionFilter">
              <label class="text-xs font-semibold text-neutral-600 dark:text-neutral-300">修订提醒范围</label>
              <div class="flex items-center gap-2">
                <select
                  v-model="revisionFilterValue"
                  class="w-full rounded-full border border-neutral-200 bg-white/85 px-4 py-2 text-sm text-neutral-800 shadow-sm focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-100"
                  :disabled="revisionSaving || alertPreferencesLoading"
                >
                  <option
                    v-for="option in revisionFilterOptions"
                    :key="option.value"
                    :value="option.value"
                  >{{ option.label }}</option>
                </select>
                <button
                  type="submit"
                  class="inline-flex items-center rounded-full bg-neutral-900 px-4 py-2 text-xs font-semibold text-white transition hover:-translate-y-0.5 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
                  :disabled="revisionSaving || alertPreferencesLoading"
                >{{ revisionSaving ? '保存中…' : '保存' }}</button>
              </div>
              <p class="text-xs text-neutral-500 dark:text-neutral-400">{{ revisionFilterHint }}</p>
            </form>
          </div>
        </div>

        <div v-if="alertsLoading" class="rounded-2xl border border-neutral-200 bg-white/80 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300">
          正在加载提醒…
        </div>
        <ul v-else-if="alertItems.length > 0" class="space-y-4">
          <li
            v-for="item in alertItems"
            :key="item.id"
            class="rounded-2xl border border-neutral-200 bg-white/80 p-4 shadow-sm transition hover:border-[rgba(var(--accent),0.35)] hover:shadow-[0_15px_35px_rgba(15,23,42,0.12)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:hover:border-[rgba(var(--accent),0.45)]"
          >
            <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div class="space-y-1">
                <div class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                  {{ item.pageTitle || '未知页面' }}
                </div>
                <div class="text-xs text-neutral-600 dark:text-neutral-300">
                  {{ metricLabel(item.metric) }}变动
                  <span
                    v-if="formatAlertDelta(item)"
                    class="ml-1 font-semibold"
                    :class="{
                      'text-green-600 dark:text-green-400': (item.diffValue || 0) > 0,
                      'text-red-500 dark:text-red-400': (item.diffValue || 0) < 0
                    }"
                  >{{ formatAlertDelta(item) }}</span>
                  <span v-if="item.newValue != null" class="ml-2">当前：{{ Math.round(Number(item.newValue)) }}</span>
                </div>
                <div v-if="item.pageAlternateTitle" class="text-[11px] text-neutral-500 dark:text-neutral-400">
                  {{ item.pageAlternateTitle }}
                </div>
              </div>
              <div class="text-right text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
                <div>{{ formatAlertTime(item.detectedAt) }}</div>
                <div v-if="!item.acknowledgedAt" class="inline-flex items-center justify-center rounded-full bg-[rgba(var(--accent),0.12)] px-2 py-0.5 text-[10px] font-semibold text-[rgb(var(--accent))]">
                  未读
                </div>
              </div>
            </div>
            <div class="mt-3 flex items-center justify-between text-xs">
              <button
                type="button"
                class="inline-flex items-center gap-1 font-medium text-[rgb(var(--accent))] hover:underline"
                @click="handleAlertNavigate(item)"
              >
                查看页面
              </button>
              <button
                v-if="!item.acknowledgedAt"
                type="button"
                class="text-neutral-500 hover:text-[rgb(var(--accent))] dark:text-neutral-400"
                @click="markAlertRead(item.id)"
              >标记已读</button>
            </div>
          </li>
        </ul>
        <div v-else class="rounded-2xl border border-neutral-200 bg-white/80 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300">
          暂无提醒，持续关注也许能带来惊喜～
        </div>
        </template>

        <!-- Combined view (page alerts) -->
        <template v-else>
          <div class="flex flex-wrap items-center justify-between gap-3">
            <div class="text-xs text-neutral-500 dark:text-neutral-400">按页面聚合最近未读提醒</div>
            <div class="flex items-center gap-2">
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-neutral-600 hover:border-[rgba(var(--accent),0.35)] hover:text-[rgb(var(--accent))] disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-300"
                :disabled="combinedLoading"
                @click="handleCombinedRefresh"
              >{{ combinedLoading ? '刷新中…' : '刷新' }}</button>
              <button
                v-if="combinedTotalUnread > 0"
                type="button"
                class="inline-flex items-center gap-1 rounded-full bg-[rgb(var(--accent))] px-3 py-1.5 text-xs font-semibold text-white shadow-[0_12px_30px_rgba(10,132,255,0.3)] hover:-translate-y-0.5 transition disabled:cursor-not-allowed disabled:opacity-60"
                :disabled="combinedLoading"
                @click="handleCombinedMarkAll"
              >全部已读</button>
            </div>
          </div>
          <div v-if="combinedLoading" class="rounded-2xl border border-neutral-200 bg-white/80 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300">
            正在加载提醒…
          </div>
          <ul v-else-if="combinedGroups.length > 0" class="space-y-4">
            <li
              v-for="group in combinedGroups"
              :key="group.pageId"
              class="rounded-2xl border border-neutral-200 bg-white/80 p-4 shadow-sm transition hover:border-[rgba(var(--accent),0.35)] hover:shadow-[0_15px_35px_rgba(15,23,42,0.12)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:hover:border-[rgba(var(--accent),0.45)]"
            >
              <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div class="space-y-1">
                  <div class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                    {{ group.pageTitle || '未知页面' }}
                  </div>
                  <div v-if="group.pageAlternateTitle" class="text-[11px] text-neutral-500 dark:text-neutral-400">
                    {{ group.pageAlternateTitle }}
                  </div>
                  <div class="mt-2 flex flex-wrap gap-2">
                    <span
                      v-for="alert in group.alerts"
                      :key="alert.id"
                      class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/70 px-2 py-1 text-[11px] font-medium text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300"
                    >
                      <span>{{ metricLabel(alert.metric as AlertMetric) }}</span>
                      <span v-if="formatAlertDelta(alert)" :class="{ 'text-green-600 dark:text-green-400': (alert.diffValue || 0) > 0, 'text-red-500 dark:text-red-400': (alert.diffValue || 0) < 0 }">{{ formatAlertDelta(alert) }}</span>
                      <span v-if="alert.newValue != null">当前：{{ Math.round(Number(alert.newValue)) }}</span>
                    </span>
                  </div>
                </div>
                <div class="text-right text-xs text-neutral-500 dark:text-neutral-400 space-y-1">
                  <div>{{ formatAlertTime(group.updatedAt) }}</div>
                  <div class="inline-flex items-center justify-center rounded-full bg-[rgba(var(--accent),0.12)] px-2 py-0.5 text-[10px] font-semibold text-[rgb(var(--accent))]">
                    未读 {{ group.alerts.filter(a => !a.acknowledgedAt).length }}
                  </div>
                </div>
              </div>
              <div class="mt-3 flex items-center justify-between text-xs">
                <button
                  type="button"
                  class="inline-flex items-center gap-1 font-medium text-[rgb(var(--accent))] hover:underline"
                  @click="handleCombinedNavigate(group)"
                >
                  查看页面
                </button>
                <button
                  type="button"
                  class="text-neutral-500 hover:text-[rgb(var(--accent))] dark:text-neutral-400"
                  @click="handleCombinedMarkGroup(group)"
                >标记已读</button>
              </div>
            </li>
          </ul>
          <div v-else class="rounded-2xl border border-neutral-200 bg-white/80 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300">
            暂无提醒，持续关注也许能带来惊喜～
          </div>
        </template>
      </div>
    </section>

    <section v-show="activeTab === 'follows'" class="rounded-3xl border border-white/60 bg-white/80 p-8 shadow-[0_22px_55px_rgba(15,23,42,0.10)] backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_32px_70px_rgba(0,0,0,0.55)]">
      <header class="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div class="space-y-1">
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">关注作者</h2>
          <p class="text-sm text-neutral-600 dark:text-neutral-400">管理已关注的 Wikidot 作者，及时查看他们的最新动态。</p>
        </div>
        <div class="flex items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
          <span v-if="hasFollowEntries">已关注 {{ totalFollows }} 位作者</span>
          <span v-else-if="followsLoaded">暂未关注任何作者</span>
        </div>
      </header>
      <div v-if="!hasLinkedWikidot" class="mt-4 rounded-2xl border border-dashed border-neutral-200 bg-white/70 px-4 py-6 text-sm text-neutral-600 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300">
        绑定 Wikidot 账号后即可关注作者并在此管理关注列表。
      </div>
      <div v-else class="mt-4 space-y-4">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p class="text-xs text-neutral-500 dark:text-neutral-400">刷新即可同步最新的关注列表，取消关注后可随时再次添加。</p>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-neutral-600 transition hover:border-[rgba(var(--accent),0.35)] hover:text-[rgb(var(--accent))] disabled:cursor-not-allowed disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-300"
              :disabled="followsLoading"
              @click="handleRefreshFollows"
            >{{ followsLoading ? '刷新中…' : '刷新' }}</button>
          </div>
        </div>
        <div v-if="followsInitialLoading" class="rounded-2xl border border-neutral-200 bg-white/80 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300">
          正在加载关注列表…
        </div>
        <ul v-else-if="hasFollowEntries" class="space-y-3">
          <li
            v-for="follow in followsDisplayList"
            :key="follow.id"
            class="rounded-2xl border border-neutral-200 bg-white/80 p-4 shadow-sm transition hover:border-[rgba(var(--accent),0.35)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:hover:border-[rgba(var(--accent),0.45)]"
          >
            <div class="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <component
                :is="follow.wikidotId ? 'NuxtLink' : 'div'"
                v-bind="follow.wikidotId ? { to: `/user/${follow.wikidotId}` } : {}"
                class="flex items-center gap-3 min-w-0"
              >
                <UserAvatar
                  :wikidot-id="follow.wikidotId"
                  :name="follow.displayName || `作者 #${follow.wikidotId ?? follow.targetUserId}`"
                  :size="44"
                  class="ring-1 ring-neutral-200 dark:ring-neutral-800"
                />
                <div class="min-w-0 space-y-1">
                  <div class="truncate text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                    {{ follow.displayName || `作者 #${follow.wikidotId ?? follow.targetUserId}` }}
                  </div>
                  <div class="text-xs text-neutral-500 dark:text-neutral-400">
                    <span v-if="follow.wikidotId">Wikidot ID：{{ follow.wikidotId }}</span>
                    <span v-else>内部 ID：{{ follow.targetUserId }}</span>
                  </div>
                </div>
              </component>
              <div class="flex items-center gap-2 shrink-0">
                <NuxtLink
                  v-if="follow.wikidotId"
                  :to="`/user/${follow.wikidotId}`"
                  class="inline-flex items-center gap-1 rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-semibold text-neutral-600 transition hover:border-[rgba(var(--accent),0.35)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800/80 dark:text-neutral-300"
                >查看主页</NuxtLink>
                <span
                  v-else
                  class="inline-flex items-center justify-center rounded-full border border-dashed border-neutral-300 px-3 py-1.5 text-[11px] font-medium text-neutral-500 dark:border-neutral-700 dark:text-neutral-400"
                >暂无法跳转</span>
                <button
                  type="button"
                  class="inline-flex items-center gap-1 rounded-full bg-rose-500/90 px-3 py-1.5 text-xs font-semibold text-white transition hover:-translate-y-0.5 hover:bg-rose-500 disabled:cursor-not-allowed disabled:opacity-60"
                  :disabled="followsLoading || !follow.wikidotId"
                  @click="handleUnfollowFromAccount(follow.wikidotId)"
                >取消关注</button>
              </div>
            </div>
          </li>
        </ul>
        <div v-else-if="showFollowsEmpty" class="rounded-2xl border border-dashed border-neutral-300 bg-neutral-50/70 px-4 py-12 text-center text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
          关注作者后可在此快速管理，去用户页面点击“关注”试试看～
        </div>
      </div>
    </section>

    <section v-show="activeTab === 'security'" class="rounded-3xl border border-white/60 bg-white/80 p-8 shadow-[0_22px_55px_rgba(15,23,42,0.10)] backdrop-blur-xl dark:border-white/10 dark:bg-neutral-950/65 dark:shadow-[0_32px_70px_rgba(0,0,0,0.55)]">
      <header class="space-y-1">
        <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-100">安全设置</h2>
        <p class="text-sm text-neutral-600 dark:text-neutral-400">修改密码后需要重新登录，请妥善保管账户信息。</p>
      </header>
      <form class="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3" @submit.prevent="handlePasswordChange">
        <input v-model="passwordCurrent" type="password" autocomplete="current-password" placeholder="当前密码" class="rounded-2xl border border-neutral-200 bg-white/90 px-4 py-3 text-sm text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-100" required />
        <input v-model="passwordNew" type="password" autocomplete="new-password" placeholder="新密码（至少 8 位）" minlength="8" class="rounded-2xl border border-neutral-200 bg-white/90 px-4 py-3 text-sm text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-100" required />
        <input v-model="passwordConfirm" type="password" autocomplete="new-password" placeholder="确认新密码" minlength="8" class="rounded-2xl border border-neutral-200 bg-white/90 px-4 py-3 text-sm text-neutral-900 shadow-sm transition focus:border-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-100" required />
        <div class="md:col-span-3 flex items-center justify-between pt-1">
          <p v-if="passwordMessage" :class="passwordMessageClass" class="text-xs">{{ passwordMessage }}</p>
          <button type="submit" class="inline-flex items-center gap-2 rounded-full bg-neutral-900 px-4 py-2 text-xs font-semibold text-white transition hover:-translate-y-0.5 hover:bg-neutral-800 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-neutral-900 disabled:opacity-60 disabled:cursor-not-allowed dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200" :disabled="passwordSaving || !passwordsValid">
            <svg v-if="passwordSaving" class="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v4m0 8v4m8-8h-4M8 12H4m12.364-6.364l-2.828 2.828M9.172 14.828l-2.828 2.828m0-11.656l2.828 2.828m8.486 8.486l2.828 2.828" /></svg>
            <span>{{ passwordSaving ? '修改中…' : '修改密码' }}</span>
          </button>
        </div>
      </form>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { navigateTo } from 'nuxt/app'
import UserAvatar from '~/components/UserAvatar.vue'
import PageCard from '~/components/PageCard.vue'
import { useAuth } from '~/composables/useAuth'
import { useAlerts, type AlertItem, type AlertMetric } from '~/composables/useAlerts'
import { useAlertSettings, type RevisionFilterOption } from '~/composables/useAlertSettings'
import { useFollowAlerts, type FollowCombinedGroup } from '~/composables/useFollowAlerts'
import { useCombinedAlerts, type CombinedAlertGroup } from '~/composables/useCombinedAlerts'
import { useFavorites } from '~/composables/useFavorites'
import { useFollows } from '~/composables/useFollows'
import { useViewerVotes } from '~/composables/useViewerVotes'
import { orderTags } from '~/composables/useTagOrder'

const { user, fetchCurrentUser, updateProfile, changePassword, status, logout } = useAuth()
const {
  alerts: alertItems,
  unreadCount: alertsUnreadCount,
  unreadByMetric,
  loading: alertsLoading,
  hasUnread: alertsHasUnread,
  totalUnread: alertsTotalUnread,
  activeMetric: alertsActiveMetric,
  fetchAlerts,
  markAlertRead,
  markAllAlertsRead,
  setActiveMetric: setAlertsMetric
} = useAlerts()

const {
  preferences: alertPreferences,
  loading: alertPreferencesLoading,
  saving: alertPreferencesSaving,
  error: alertPreferencesError,
  fetchPreferences: fetchAlertPreferences,
  updatePreferences: updateAlertPreferences,
  setMetricMuted: setAlertMetricMuted
} = useAlertSettings()

// Combined (page-aggregated) alerts
const { groups: combinedGroups, loading: combinedLoading, fetchCombined: fetchCombinedAlerts, markBatchRead: markCombinedBatch, totalUnread: combinedTotalUnread } = useCombinedAlerts()

// Follow alerts (author activity)
const { combined: followCombined, combinedLoading: followCombinedLoading, combinedUnread: followCombinedUnread, fetchCombined: fetchFollowCombined, markAllRead: markAllFollowRead } = useFollowAlerts()

const { favoritePages, removePageFavorite } = useFavorites()
const { hydratePages: hydrateViewerVotes } = useViewerVotes()
const { follows, loading: followsLoading, fetchFollows, unfollowUser } = useFollows()

type AccountTab = 'overview' | 'alerts' | 'follows' | 'security'
const accountTabs: Array<{ key: AccountTab; label: string }> = [
  { key: 'overview', label: '资料' },
  { key: 'alerts', label: '提醒' },
  { key: 'follows', label: '关注' },
  { key: 'security', label: '安全' }
]
const activeTab = ref<AccountTab>('overview')

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
const alertsBadgeCount = computed(() => Math.max(
  Number(alertsTotalUnread.value || 0),
  Number(combinedTotalUnread.value || 0),
  Number(followCombinedUnread.value || 0)
))
const followBadgeCount = computed(() => Math.max(0, Number(followCombinedUnread.value || 0)))
const followsLoaded = ref(false)
const followsDisplayList = computed(() => {
  const list = Array.isArray(follows.value) ? [...follows.value] : []
  return list.sort((a, b) => {
    const nameA = (a.displayName || '').trim()
    const nameB = (b.displayName || '').trim()
    if (nameA && nameB && nameA !== nameB) {
      return nameA.localeCompare(nameB, 'zh-Hans-CN', { sensitivity: 'base' })
    }
    if (nameA && !nameB) return -1
    if (!nameA && nameB) return 1
    const idA = Number(a.wikidotId ?? a.targetUserId ?? 0)
    const idB = Number(b.wikidotId ?? b.targetUserId ?? 0)
    return idA - idB
  })
})
const totalFollows = computed(() => followsDisplayList.value.length)
const hasFollowEntries = computed(() => totalFollows.value > 0)
const followsInitialLoading = computed(() => followsLoading.value && !followsLoaded.value)
const showFollowsEmpty = computed(() => followsLoaded.value && !followsLoading.value && !hasFollowEntries.value)

watch(
  () => favoritePageCards.value,
  (cards) => {
    if (!process.client) return
    if (!Array.isArray(cards) || cards.length === 0) return
    void hydrateViewerVotes(cards as any[])
  },
  { immediate: true, flush: 'post' }
)

const viewMode = ref<'metric' | 'combined'>('combined')
const alertSource = ref<'page' | 'follow'>('page')

const hasLinkedWikidot = computed(() => Boolean(user.value?.linkedWikidotId))
const metricLabelMap: Record<AlertMetric, string> = {
  COMMENT_COUNT: '评论数',
  VOTE_COUNT: '投票数',
  RATING: '评分',
  REVISION_COUNT: '修订数',
  SCORE: '得分'
}

const availableAlertMetrics: Array<{ metric: AlertMetric; label: string; description: string }> = [
  {
    metric: 'COMMENT_COUNT',
    label: '评论提醒',
    description: '追踪拥有页面的评论动态，任意评论变化都会触发提醒。'
  },
  {
    metric: 'VOTE_COUNT',
    label: '投票提醒',
    description: '监控投票总数的显著变化，可自定义阈值后再触发提醒。'
  },
  {
    metric: 'REVISION_COUNT',
    label: '修订提醒',
    description: '关注页面修订，可筛选他人或非署名修订以便及时响应。'
  }
]

const activeMetricOption = computed(() => availableAlertMetrics.find(item => item.metric === alertsActiveMetric.value) ?? availableAlertMetrics[0])
const activeMetricMuted = computed(() => Boolean(alertPreferences.value.mutedMetrics?.[alertsActiveMetric.value]))

const voteThresholdInput = ref(alertPreferences.value.voteCountThreshold)
const revisionFilterValue = ref<RevisionFilterOption>(alertPreferences.value.revisionFilter)
const voteSaving = ref(false)
const revisionSaving = ref(false)
const metricMutePending = ref(false)

watch(alertPreferences, (next) => {
  voteThresholdInput.value = next.voteCountThreshold || 1
  revisionFilterValue.value = next.revisionFilter || 'ANY'
}, { immediate: true })

const alertTimeFormatter = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  : null

function metricLabel(metric: AlertMetric): string {
  return metricLabelMap[metric] ?? '指标'
}

function formatAlertDelta(item: AlertItem): string | null {
  if (item.diffValue == null) return null
  const diff = Number(item.diffValue)
  if (!Number.isFinite(diff)) return null
  const rounded = Math.round(diff)
  if (rounded === 0) return '0'
  const sign = rounded > 0 ? '+' : ''
  return `${sign}${rounded}`
}

function formatAlertTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  if (alertTimeFormatter) return alertTimeFormatter.format(date)
  return date.toISOString()
}

function handleMetricChange(metric: AlertMetric) {
  setAlertsMetric(metric)
  fetchAlerts(metric).catch((err) => {
    console.warn('[account] alerts fetch on metric change failed', err)
  })
}

function handleRemoveFavoritePage(id: number) {
  removePageFavorite(id)
}

async function ensureFollows(force = false) {
  if (!hasLinkedWikidot.value) return
  if (followsLoaded.value && !force) return
  try {
    await fetchFollows(true)
    followsLoaded.value = true
  } catch (err) {
    console.warn('[account] fetch follows failed', err)
  }
}

async function handleRefreshFollows() {
  await ensureFollows(true)
}

async function handleUnfollowFromAccount(wikidotId?: number | null) {
  if (!wikidotId) return
  try {
    await unfollowUser(wikidotId)
    await ensureFollows(true)
  } catch (err) {
    console.warn('[account] unfollow failed', err)
  }
}

function handleRefreshAlerts() {
  fetchAlerts(alertsActiveMetric.value, true).catch((err) => {
    console.warn('[account] alerts refresh failed', err)
  })
}

function handleSwitchToCombined() {
  viewMode.value = 'combined'
  fetchCombinedAlerts(20, 0, true).catch((err) => {
    console.warn('[account] combined alerts fetch failed', err)
  })
}

function handleSwitchToFollow() {
  alertSource.value = 'follow'
  fetchFollowCombined(true, 20, 0).catch((err) => {
    console.warn('[account] follow combined alerts fetch on switch failed', err)
  })
}

function handleCombinedRefresh() {
  fetchCombinedAlerts(20, 0, true).catch((err) => {
    console.warn('[account] combined alerts refresh failed', err)
  })
}

function handleCombinedMarkGroup(group: CombinedAlertGroup) {
  const ids = group.alerts.map(a => a.id)
  if (ids.length === 0) return
  markCombinedBatch(ids).catch((err) => {
    console.warn('[account] combined mark group read failed', err)
  })
}

function handleCombinedMarkAll() {
  const ids = combinedGroups.value.flatMap(g => g.alerts.map(a => a.id))
  if (ids.length === 0) return
  markCombinedBatch(ids).catch((err) => {
    console.warn('[account] combined mark all read failed', err)
  })
}

function handleCombinedNavigate(group: CombinedAlertGroup) {
  if (group.pageWikidotId) {
    navigateTo(`/page/${group.pageWikidotId}`)
  } else if (group.pageUrl && process.client) {
    window.open(group.pageUrl, '_blank', 'noopener')
  }
}

function handleToggleMetricMute() {
  if (!hasLinkedWikidot.value) return
  if (alertPreferencesLoading.value || alertPreferencesSaving.value || metricMutePending.value) return
  metricMutePending.value = true
  setAlertMetricMuted(alertsActiveMetric.value, !activeMetricMuted.value).catch((err) => {
    console.warn('[account] toggle alert mute failed', err)
  }).finally(() => {
    metricMutePending.value = false
  })
}

const revisionFilterOptions: Array<{ value: RevisionFilterOption; label: string }> = [
  { value: 'ANY', label: '所有修订' },
  { value: 'NON_OWNER', label: '他人修订' },
  { value: 'NON_OWNER_NO_ATTR', label: '非本人且未署名修订' }
]

const revisionFilterDescriptions: Record<RevisionFilterOption, string> = {
  ANY: '包含任何人对页面的修订，包括你本人。',
  NON_OWNER: '仅提醒由他人发起的修订，便于第一时间查看变化。',
  NON_OWNER_NO_ATTR: '仅提醒既不是你，也不在页面署名中的用户发起的修订。'
}

const revisionFilterHint = computed(() => revisionFilterDescriptions[revisionFilterValue.value] ?? revisionFilterDescriptions.ANY)

async function handleSaveVoteThreshold() {
  if (voteSaving.value || alertPreferencesSaving.value) return
  const value = Number(voteThresholdInput.value)
  if (!Number.isFinite(value) || value <= 0) {
    voteThresholdInput.value = 1
    return
  }
  voteSaving.value = true
  try {
    const clamped = Math.max(1, Math.min(1000, Math.round(value)))
    voteThresholdInput.value = clamped
    await updateAlertPreferences({ voteCountThreshold: clamped })
    if (alertsActiveMetric.value === 'VOTE_COUNT') {
      await fetchAlerts('VOTE_COUNT', true)
    }
  } catch (err) {
    console.warn('[account] update vote threshold failed', err)
  } finally {
    voteSaving.value = false
  }
}

async function handleSaveRevisionFilter() {
  if (revisionSaving.value || alertPreferencesSaving.value) return
  revisionSaving.value = true
  try {
    await updateAlertPreferences({ revisionFilter: revisionFilterValue.value })
    await fetchAlerts('REVISION_COUNT', true)
  } catch (err) {
    console.warn('[account] update revision filter failed', err)
  } finally {
    revisionSaving.value = false
  }
}

function handleAlertNavigate(item: AlertItem) {
  markAlertRead(item.id).catch((err) => {
    console.warn('[account] mark alert read failed', err)
  })
  if (item.pageWikidotId) {
    navigateTo(`/page/${item.pageWikidotId}`)
  } else if (item.pageUrl && process.client) {
    window.open(item.pageUrl, '_blank', 'noopener')
  }
}

function handleMarkAllAlerts() {
  markAllAlertsRead(alertsActiveMetric.value).catch((err) => {
    console.warn('[account] mark all alerts failed', err)
  })
}

onMounted(() => {
  if (status.value === 'unknown') {
    fetchCurrentUser().then(() => {
      if (user.value?.linkedWikidotId) {
        fetchAlertPreferences(true).catch((err) => {
          console.warn('[account] initial alert preferences load failed', err)
        })
        fetchAlerts(alertsActiveMetric.value, true).catch((err) => {
          console.warn('[account] initial alerts fetch failed', err)
        })
        fetchCombinedAlerts(20, 0, true).catch((err) => {
          console.warn('[account] initial combined alerts fetch failed', err)
        })
        fetchFollowCombined(true, 20, 0).catch((err) => {
          console.warn('[account] initial follow combined alerts fetch failed', err)
        })
        void ensureFollows()
      } else if (activeTab.value === 'follows') {
        void ensureFollows()
      }
    }).catch((err) => {
      console.warn('[account] fetchCurrentUser failed', err)
    })
  } else if (status.value === 'unauthenticated') {
    navigateTo('/auth/login', { replace: true })
  } else if (status.value === 'authenticated') {
    if (user.value?.linkedWikidotId) {
      fetchAlertPreferences(true).catch((err) => {
        console.warn('[account] alert preferences load failed', err)
      })
      fetchAlerts(alertsActiveMetric.value, true).catch((err) => {
        console.warn('[account] initial alerts fetch failed', err)
      })
      fetchCombinedAlerts(20, 0, true).catch((err) => {
        console.warn('[account] initial combined alerts fetch failed', err)
      })
      fetchFollowCombined(true, 20, 0).catch((err) => {
        console.warn('[account] initial follow combined alerts fetch failed', err)
      })
      void ensureFollows()
    } else if (activeTab.value === 'follows') {
      void ensureFollows()
    }
  }
})

watch(status, (next) => {
  if (next === 'unauthenticated') {
    navigateTo('/auth/login', { replace: true })
  } else if (next === 'authenticated') {
    fetchFollowCombined(true, 20, 0).catch((err) => {
      console.warn('[account] follow combined alerts fetch on status change failed', err)
    })
    if (activeTab.value === 'follows') {
      void ensureFollows()
    }
  }
})

watch(() => user.value?.linkedWikidotId, (next, prev) => {
  if (next && next !== prev) {
    fetchAlertPreferences(true).catch((err) => {
      console.warn('[account] alert preferences reload failed', err)
    })
    fetchAlerts(alertsActiveMetric.value, true).catch((err) => {
      console.warn('[account] alerts fetch on link change failed', err)
    })
    fetchCombinedAlerts(20, 0, true).catch((err) => {
      console.warn('[account] combined alerts fetch on link change failed', err)
    })
    fetchFollowCombined(true, 20, 0).catch((err) => {
      console.warn('[account] follow combined alerts fetch on link change failed', err)
    })
    void ensureFollows(true)
  }
  if (!next) {
    followsLoaded.value = false
    follows.value = []
  }
})

watch(alertsActiveMetric, (metric, previous) => {
  if (!metric || metric === previous) return
  if (!hasLinkedWikidot.value) return
  fetchAlerts(metric).catch((err) => {
    console.warn('[account] alerts fetch on active metric change failed', err)
  })
})

watch(activeTab, (tab) => {
  if (tab === 'alerts' && hasLinkedWikidot.value) {
    fetchAlerts(alertsActiveMetric.value).catch((err) => {
      console.warn('[account] alerts fetch on tab change failed', err)
    })
    fetchCombinedAlerts(20, 0, true).catch((err) => {
      console.warn('[account] combined alerts fetch on tab change failed', err)
    })
  }
  if (tab === 'follows') {
    void ensureFollows()
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
