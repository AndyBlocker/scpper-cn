<template>
  <div class="relative min-h-screen overflow-x-hidden bg-[#f6f7fb] dark:bg-[#0b0d12] text-neutral-900 dark:text-neutral-100">
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgba(10,132,255,0.18),_transparent_58%)] dark:bg-[radial-gradient(circle_at_top,_rgba(64,156,255,0.25),_rgba(11,13,18,0.92)_62%)]"
    ></div>
    <div class="relative z-10 flex min-h-screen flex-col">
      <header ref="appHeaderRef" class="sticky top-0 z-50 border border-white/60 bg-white/70 shadow-[0_12px_40px_rgba(15,23,42,0.08)] backdrop-blur-2xl dark:border-white/5 dark:bg-neutral-900/65 dark:shadow-[0_14px_40px_rgba(0,0,0,0.45)]">
        <div class="max-w-7xl mx-auto flex items-center gap-3 px-4 py-4 sm:gap-6">
          <div class="flex items-center gap-3">
            <!-- Mobile menu button (sidebar) -->
            <button
              type="button"
              class="inline-flex items-center justify-center sm:hidden h-10 w-10 rounded-full border border-neutral-200/80 bg-white/80 text-neutral-600 shadow-sm transition hover:border-[rgba(var(--accent),0.4)] hover:text-[rgb(var(--accent))] dark:border-neutral-700/70 dark:bg-neutral-800/70 dark:text-neutral-300"
              aria-label="打开菜单"
              title="打开菜单"
              @click="openSidebar"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>

            <!-- Mobile brand/logo + title link -->
            <NuxtLink to="/" class="sm:hidden inline-flex items-center gap-2 group" aria-label="返回主页" title="返回主页">
              <BrandIcon class="w-7 h-7 text-neutral-900 dark:text-neutral-100 group-hover:text-[rgb(var(--accent))] transition-colors" />
              <span class="font-bold text-base text-neutral-800 dark:text-neutral-100 group-hover:text-[rgb(var(--accent))]">SCPPER-CN</span>
            </NuxtLink>

            <!-- Desktop brand + primary nav -->
            <div class="hidden sm:flex items-center gap-4 whitespace-nowrap">
            <NuxtLink to="/" class="flex items-center gap-2 group">
              <BrandIcon class="w-8 h-8 text-neutral-900 dark:text-neutral-100 group-hover:text-[rgb(var(--accent))] transition-colors" />
              <span class="hidden sm:inline font-bold text-lg text-neutral-800 dark:text-neutral-100 group-hover:text-[rgb(var(--accent))]">SCPPER-CN</span>
            </NuxtLink>
            <NuxtLink to="/ranking" class="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300 hover:text-[rgb(var(--accent))] whitespace-nowrap">
              <svg class="w-5 h-5 sm:w-4 sm:h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 13h4v7H4v-7zm6-6h4v13h-4V7zm6 3h4v10h-4V10z" />
              </svg>
              <span class="hidden sm:inline">排行</span>
            </NuxtLink>
            <NuxtLink to="/tools" class="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300 hover:text-[rgb(var(--accent))] whitespace-nowrap">
              <svg class="w-5 h-5 sm:w-4 sm:h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h4v4H4zM10 6h4v4h-4zM16 6h4v4h-4zM4 12h4v4H4zM10 12h4v4h-4zM16 12h4v4h-4z" />
              </svg>
              <span class="hidden sm:inline">工具</span>
            </NuxtLink>
            <NuxtLink to="/about" class="inline-flex items-center gap-1 text-sm text-neutral-600 dark:text-neutral-300 hover:text-[rgb(var(--accent))] whitespace-nowrap">
              <svg class="w-5 h-5 sm:w-4 sm:h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor">
                <circle cx="12" cy="12" r="9" stroke-width="2" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8h.01" />
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 12v4" />
              </svg>
              <span class="hidden sm:inline">关于</span>
            </NuxtLink>
            </div>
          </div>
          <div class="ml-auto flex w-auto items-center gap-2 sm:w-full sm:justify-end">
            <button
              @click="openMobileSearch"
              :class="[iconButtonBaseClass, 'sm:hidden']"
              type="button"
              aria-label="打开搜索"
              title="打开搜索"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </button>
            <form class="relative hidden flex-1 max-w-md sm:block" @submit.prevent="onSearch">
              <input
                ref="desktopInputRef"
                v-model="q"
                @input="handleInput"
                @focus="handleFocus"
                @blur="handleBlur"
                @keydown="handleKeyDown"
                placeholder="搜索页面 / 用户 / 标签…"
                class="w-full bg-white/80 dark:bg-neutral-900/70 border border-neutral-200 dark:border-neutral-800 rounded-full px-5 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] focus:border-transparent transition-all backdrop-blur placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
              />
              <button type="submit" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-[rgb(var(--accent-strong))] hover:text-[rgb(var(--accent))] p-1">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </button>
              <div v-if="showSuggestions" class="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg shadow-lg z-50 max-h-96 overflow-y-auto">
                <div v-if="suggestionsLoading" class="p-3 text-sm text-neutral-500 dark:text-neutral-400">搜索中...</div>
                <div v-else-if="suggestions.length === 0 && q.length >= 2" class="p-3 text-sm text-neutral-500 dark:text-neutral-400">没有找到相关结果</div>
                <div v-else>
                  <div
                    v-for="group in suggestionGroups"
                    :key="group.type"
                    class="py-1 first:pt-0"
                  >
                    <div class="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                      {{ group.label }}
                    </div>
                    <a
                      v-for="entry in group.entries"
                      :key="entry.item.key"
                      :href="entry.item.href"
                      @click.prevent="selectSuggestion(entry.item)"
                      @mouseenter="selectedIndex = entry.index"
                      class="block px-4 py-2 hover:bg-[rgba(var(--accent),0.08)] dark:hover:bg-[rgba(var(--accent),0.20)] cursor-pointer transition-colors"
                      :class="{ 'bg-[rgba(var(--accent),0.08)] dark:bg-[rgba(var(--accent),0.20)]': selectedIndex === entry.index }"
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0 flex-1">
                          <div class="font-medium text-sm text-neutral-800 dark:text-neutral-200 truncate">
                            <span>{{ entry.item.title }}</span>
                            <span v-if="entry.item.subtitle" class="text-neutral-500 dark:text-neutral-400"> - {{ entry.item.subtitle }}</span>
                          </div>
                          <div
                            v-if="entry.item.snippet"
                            class="mt-1 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400"
                            v-html="entry.item.snippet"
                          ></div>
                        </div>
                        <span class="ml-2 shrink-0 rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.08)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--accent-strong))] dark:border-[rgba(var(--accent),0.35)] dark:bg-[rgba(var(--accent),0.18)]">
                          {{ entry.item.badge }}
                        </span>
                      </div>
                    </a>
                  </div>
                </div>
              </div>
            </form>
            <!-- Theme toggle hidden on mobile, moved to sidebar -->
            <button
              @click="toggleTheme"
              :class="[iconButtonBaseClass, 'hidden sm:inline-flex']"
              type="button"
              aria-label="切换主题"
              title="切换主题"
            >
              <svg v-if="currentTheme === 'dark'" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v2m0 14v2m4.22-12.22l1.42-1.42M6.34 17.66l-1.42 1.42M21 12h-2M5 12H3m12.66 5.66l1.42 1.42M6.34 6.34L4.92 4.92M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
              </svg>
              <svg v-else class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
              </svg>
            </button>
            <div v-if="isAuthenticated && hasLinkedWikidot" class="relative">
              <button
                ref="alertsButtonRef"
                type="button"
                @click="toggleAlertsDropdown"
                :class="['relative', iconButtonBaseClass]"
                aria-label="查看提醒"
              >
                <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M15 17h5l-1.4-1.4A2 2 0 0118 14.172V11a6 6 0 10-12 0v3.172a2 2 0 01-.6 1.428L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
                <span
                  v-if="alertsHasUnread"
                  class="absolute -top-0.5 -right-0.5 inline-flex min-w-[18px] justify-center rounded-full bg-[rgb(var(--accent))] px-1 text-[10px] font-semibold leading-5 text-white shadow"
                >{{ alertsUnreadCount > 99 ? '99+' : alertsUnreadCount }}</span>
              </button>
              <transition name="fade">
                <div
                  v-if="isAlertsDropdownOpen"
                  ref="alertsDropdownRef"
                  class="absolute right-0 mt-3 w-80 max-w-[80vw] max-h-[70vh] overflow-y-auto overscroll-contain rounded-2xl border border-neutral-200/80 bg-white/95 p-4 shadow-xl backdrop-blur dark:border-neutral-700/60 dark:bg-neutral-900/95"
                >
                  <div class="flex items-center justify-between gap-3">
                    <h3 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">信息提醒</h3>
                    <button
                      v-if="alertsHasUnread"
                      type="button"
                      class="text-xs font-medium text-[rgb(var(--accent))] hover:underline"
                      @click="handleMarkAllAlerts"
                    >全部已读</button>
                  </div>
                  <div v-if="alertsLoading" class="py-6 text-center text-xs text-neutral-500 dark:text-neutral-400">加载中…</div>
                  <div v-else-if="alertItems.length === 0" class="py-6 text-center text-xs text-neutral-500 dark:text-neutral-400">暂无提醒</div>
                  <ul v-else class="mt-3 space-y-3">
                    <li
                      v-for="item in alertItems"
                      :key="item.id"
                      class="rounded-xl border border-neutral-200/70 bg-neutral-50/80 transition hover:border-[rgba(var(--accent),0.35)] hover:bg-white dark:border-neutral-700/60 dark:bg-neutral-800/70 dark:hover:border-[rgba(var(--accent),0.4)]"
                    >
                      <button
                        type="button"
                        class="w-full px-3 py-3 text-left"
                        :class="{ 'opacity-70': !!item.acknowledgedAt }"
                        @click="handleAlertNavigate(item)"
                      >
                        <div class="flex items-center justify-between gap-2">
                          <span class="max-w-[70%] truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
                            {{ item.pageTitle || '未知页面' }}
                          </span>
                          <span class="shrink-0 text-[10px] text-neutral-500 dark:text-neutral-400">
                            {{ formatAlertTime(item.detectedAt) }}
                          </span>
                        </div>
                        <div class="mt-1 text-xs text-neutral-600 dark:text-neutral-300">
                          {{ metricLabel(item.metric) }}变动
                          <span
                            v-if="formatAlertDelta(item)"
                            class="ml-1 font-semibold"
                            :class="{
                              'text-green-600 dark:text-green-400': (item.diffValue || 0) > 0,
                              'text-red-500 dark:text-red-400': (item.diffValue || 0) < 0
                            }"
                          >{{ formatAlertDelta(item) }}</span>
                          <span v-if="item.newValue != null" class="ml-2 text-[11px] text-neutral-500 dark:text-neutral-400">当前：{{ Math.round(Number(item.newValue)) }}</span>
                        </div>
                        <div v-if="item.pageAlternateTitle" class="mt-1 text-[11px] text-neutral-500 dark:text-neutral-400 truncate">
                          {{ item.pageAlternateTitle }}
                        </div>
                      </button>
                    </li>
                  </ul>
                  <NuxtLink
                    to="/account"
                    class="mt-4 block text-center text-xs font-medium text-[rgb(var(--accent))] hover:underline"
                    @click="isAlertsDropdownOpen = false"
                  >前往账户中心查看全部</NuxtLink>
                </div>
              </transition>
            </div>
           <div v-if="isAuthenticated" class="hidden sm:flex items-center gap-2">
              <NuxtLink
                to="/account"
                class="inline-flex h-10 items-center gap-2 rounded-full border border-neutral-200/80 bg-white/80 px-4 text-sm font-medium text-neutral-700 shadow-sm transition hover:border-[rgba(var(--accent),0.4)] hover:text-[rgb(var(--accent))] dark:border-neutral-700/70 dark:bg-neutral-800/70 dark:text-neutral-200"
              >
                <UserAvatar :wikidot-id="avatarIdHeader" :name="authUser?.displayName || authUser?.email || ''" :size="28" />
                <span class="hidden lg:inline">{{ authUser?.displayName || authUser?.email }}</span>
              </NuxtLink>
            </div>
            <div v-else class="hidden sm:flex items-center gap-2">
              <NuxtLink
                to="/auth/login"
                class="inline-flex h-10 items-center rounded-full border border-neutral-200/80 bg-white/80 px-4 text-sm font-semibold text-neutral-600 shadow-sm transition hover:border-[rgba(var(--accent),0.3)] hover:text-[rgb(var(--accent))] dark:border-neutral-700/70 dark:bg-neutral-800/70 dark:text-neutral-300"
              >登录</NuxtLink>
            </div>
          </div>
        </div>
      </header>

      <!-- Mobile Sidebar -->
      <transition name="fade">
        <div v-if="isSidebarOpen" class="fixed inset-0 z-[70]">
          <div class="absolute inset-0 bg-neutral-950/60" @click="closeSidebar" />
          <div class="absolute left-0 top-0 h-full w-80 max-w-[85vw]">
            <div ref="sidebarRef" class="h-full border-r border-white/60 dark:border-white/10 bg-white/90 dark:bg-neutral-900/95 backdrop-blur-xl shadow-2xl rounded-r-2xl overflow-hidden flex flex-col">
              <div class="px-4 py-4 flex items-center justify-between border-b border-neutral-200/70 dark:border-neutral-800/60 bg-[radial-gradient(circle_at_top,_rgba(10,132,255,0.10),_transparent_70%)] dark:bg-[radial-gradient(circle_at_top,_rgba(64,156,255,0.18),_transparent_70%)]">
                <NuxtLink to="/" @click="closeSidebar" class="inline-flex items-center gap-2 group">
                  <BrandIcon class="w-7 h-7 text-neutral-900 dark:text-neutral-100 group-hover:text-[rgb(var(--accent))]" />
                  <span class="font-bold text-neutral-800 dark:text-neutral-100 group-hover:text-[rgb(var(--accent))]">SCPPER-CN</span>
                </NuxtLink>
                <button type="button" class="p-2 rounded-lg text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100/60 dark:hover:bg-neutral-800/60" @click="closeSidebar" aria-label="关闭菜单">
                  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <nav class="flex-1 px-3 py-3 overflow-y-auto">
                <NuxtLink to="/ranking" @click="closeSidebar" class="nav-item">
                  <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 13h4v7H4v-7zm6-6h4v13h-4V7zm6 3h4v10h-4V10z"/></svg>
                  <span>排行</span>
                </NuxtLink>
                <NuxtLink to="/tools" @click="closeSidebar" class="nav-item">
                  <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h4v4H4zM10 6h4v4h-4zM16 6h4v4h-4zM4 12h4v4H4zM10 12h4v4h-4zM16 12h4v4h-4z"/></svg>
                  <span>工具</span>
                </NuxtLink>
                <NuxtLink to="/about" @click="closeSidebar" class="nav-item">
                  <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9" stroke-width="2"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8h.01"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 12v4"/></svg>
                  <span>关于</span>
                </NuxtLink>
              </nav>

              <!-- Sidebar bottom controls: account + theme -->
              <div class="px-4 py-3 border-t border-neutral-200/70 dark:border-neutral-800/60">
                <div class="flex items-center justify-between gap-3">
                  <div class="min-w-0">
                    <template v-if="isAuthenticated">
                      <NuxtLink to="/account" @click="closeSidebar" class="inline-flex items-center gap-2">
                <UserAvatar :wikidot-id="avatarIdHeader" :name="authUser?.displayName || authUser?.email || ''" :size="28" class="ring-1 ring-neutral-200 dark:ring-neutral-700" />
                        <span class="text-sm font-medium text-neutral-800 dark:text-neutral-100 truncate max-w-[10rem]">{{ authUser?.displayName || authUser?.email }}</span>
                      </NuxtLink>
                    </template>
                    <template v-else>
                      <NuxtLink to="/auth/login" @click="closeSidebar" class="inline-flex items-center gap-2 text-sm font-medium text-[rgb(var(--accent))]">
                        登录
                      </NuxtLink>
                    </template>
                  </div>
                  <button type="button" @click="toggleTheme" :class="iconButtonBaseClass" aria-label="切换主题" title="切换主题">
                    <svg v-if="currentTheme === 'dark'" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v2m0 14v2m4.22-12.22l1.42-1.42M6.34 17.66l-1.42 1.42M21 12h-2M5 12H3m12.66 5.66l1.42 1.42M6.34 6.34L4.92 4.92M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                    </svg>
                    <svg v-else class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z" />
                    </svg>
                  </button>
                </div>
                <div class="mt-3">
                  <div class="text-[10px] uppercase tracking-wide text-neutral-500 dark:text-neutral-400">配色方案</div>
                  <div class="mt-2 grid grid-cols-2 gap-2">
                    <button
                      v-for="scheme in colorSchemes"
                      :key="scheme.key"
                      type="button"
                      @click="setColorScheme(scheme.key)"
                      :aria-pressed="currentScheme === scheme.key"
                      :class="[
                        'flex items-center gap-2 rounded-full border px-2 py-1 text-xs font-medium transition shadow-sm',
                        currentScheme === scheme.key
                          ? 'border-[rgba(var(--accent),0.45)] bg-white/90 text-[rgb(var(--accent))] dark:border-[rgba(var(--accent),0.45)] dark:bg-neutral-900/70'
                          : 'border-neutral-200 bg-white/70 text-neutral-600 hover:border-[rgba(var(--accent),0.35)] hover:text-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-900/60 dark:text-neutral-300'
                      ]"
                      :title="scheme.name"
                    >
                      <span
                        class="inline-flex h-4 w-4 rounded-full border border-white/70 shadow-inner"
                        :style="{ background: scheme.gradient }"
                        aria-hidden="true"
                      ></span>
                      <span class="truncate">{{ scheme.name }}</span>
                    </button>
                  </div>
                </div>
              </div>

              <div class="px-4 py-3 text-[11px] text-neutral-500 dark:text-neutral-400 border-t border-neutral-200/70 dark:border-neutral-800/60">© {{ new Date().getFullYear() }} SCPPER-CN</div>
            </div>
          </div>
        </div>
      </transition>

      <div v-if="isMobileSearchOpen" class="fixed inset-0 z-[70]">
        <div class="absolute inset-0 bg-neutral-950/60" @click="closeMobileSearch" />
        <div class="absolute inset-0 flex flex-col">
          <div class="border-b border-white/50 bg-white/80 backdrop-blur dark:border-white/10 dark:bg-neutral-900/80">
            <div class="max-w-7xl mx-auto flex items-center gap-2 px-4 py-3">
              <form class="relative flex-1" @submit.prevent="onSearch">
                <input
                  ref="mobileInputRef"
                  v-model="q"
                  @input="handleInput"
                  @keydown="handleKeyDown"
                  placeholder="搜索页面 / 用户 / 标签…"
                  class="w-full bg-white/85 dark:bg-neutral-900/70 border border-neutral-200 dark:border-neutral-800 rounded-full px-5 py-2.5 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] focus:border-transparent transition-all backdrop-blur placeholder:text-neutral-400 dark:placeholder:text-neutral-500"
                />
                <button type="submit" class="absolute right-2 top-1/2 -translate-y-1/2 text-[rgb(var(--accent-strong))] hover:text-[rgb(var(--accent))] p-1">
                  <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </button>
              </form>
              <button
                @click="closeMobileSearch"
                class="p-2 bg-white/80 dark:bg-neutral-800/80 border border-white/60 dark:border-white/10 rounded-lg text-neutral-700 dark:text-neutral-300"
                aria-label="关闭搜索"
                title="关闭搜索"
              >
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
          <div class="flex-1 overflow-y-auto bg-white/85 backdrop-blur dark:bg-neutral-900/85">
            <div class="max-w-7xl mx-auto px-4 py-2">
              <div v-if="suggestionsLoading" class="p-3 text-sm text-neutral-500 dark:text-neutral-400">搜索中...</div>
              <div v-else-if="suggestions.length === 0 && q.length >= 2" class="p-3 text-sm text-neutral-500 dark:text-neutral-400">没有找到相关结果</div>
              <div v-else>
                <div
                  v-for="group in suggestionGroups"
                  :key="group.type"
                  class="py-1 first:pt-0"
                >
                  <div class="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">
                    {{ group.label }}
                  </div>
                  <a
                    v-for="entry in group.entries"
                    :key="entry.item.key"
                    :href="entry.item.href"
                    @click.prevent="selectSuggestion(entry.item)"
                    @mouseenter="selectedIndex = entry.index"
                    class="block px-4 py-3 border-b border-neutral-200/70 dark:border-neutral-800/70 hover:bg-[rgba(var(--accent),0.08)] dark:hover:bg-[rgba(var(--accent),0.20)] transition-colors"
                    :class="{ 'bg-[rgba(var(--accent),0.08)] dark:bg-[rgba(var(--accent),0.20)]': selectedIndex === entry.index }"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0 flex-1">
                        <div class="font-medium text-sm text-neutral-800 dark:text-neutral-200 truncate">
                          <span>{{ entry.item.title }}</span>
                          <span v-if="entry.item.subtitle" class="text-neutral-500 dark:text-neutral-400"> - {{ entry.item.subtitle }}</span>
                        </div>
                        <div
                          v-if="entry.item.snippet"
                          class="mt-1 text-xs leading-relaxed text-neutral-600 dark:text-neutral-400"
                          v-html="entry.item.snippet"
                        ></div>
                      </div>
                      <span class="ml-2 shrink-0 rounded-full border border-[rgba(var(--accent),0.25)] bg-[rgba(var(--accent),0.08)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--accent-strong))] dark:border-[rgba(var(--accent),0.35)] dark:bg-[rgba(var(--accent),0.18)]">
                        {{ entry.item.badge }}
                      </span>
                    </div>
                  </a>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <main class="w-full px-4 pt-10 pb-16 sm:px-6 md:px-8">
        <div class="max-w-7xl mx-auto">
          <slot />
        </div>
      </main>
      <footer class="mt-auto border-t border-white/60 bg-white/60 py-6 text-center text-xs text-neutral-500 backdrop-blur dark:border-white/10 dark:bg-neutral-900/60">© {{ new Date().getFullYear() }} SCPPER-CN</footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import BrandIcon from '../components/BrandIcon.vue'
import { ref, onMounted, onBeforeUnmount, watch, nextTick, computed } from 'vue'
import { useNuxtApp, navigateTo, useHead } from 'nuxt/app'
import { useRoute } from 'vue-router'
import UserAvatar from '~/components/UserAvatar.vue'
import { useAuth } from '~/composables/useAuth'
import { useAlerts, type AlertItem, type AlertMetric } from '~/composables/useAlerts'
const GA_ID = 'G-QCYZ6ZEF46'
useHead({
  script: [
    { src: `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`, async: true },
    { innerHTML: `window.dataLayer = window.dataLayer || [];\nfunction gtag(){dataLayer.push(arguments);}\ngtag('js', new Date());\n\ngtag('config', '${GA_ID}');` }
  ]
})
const q = ref('');
const appHeaderRef = ref<HTMLElement | null>(null)

function updateHeaderOffset() {
  if (!process.client) return
  const h = appHeaderRef.value?.offsetHeight || 0
  document.documentElement.style.setProperty('--app-header-h', `${h}px`)
}
const isMobileSearchOpen = ref(false);
const isSidebarOpen = ref(false);
const sidebarRef = ref<HTMLDivElement | null>(null);
const desktopInputRef = ref<HTMLInputElement | null>(null);
const mobileInputRef = ref<HTMLInputElement | null>(null);
const showSuggestions = ref(false);
type SearchPreviewType = 'page' | 'user'

interface SearchPreviewItem {
  key: string;
  type: SearchPreviewType;
  title: string;
  subtitle: string | null;
  snippet: string | null;
  href: string;
  badge: string;
}

const TYPE_BADGE_LABELS: Record<SearchPreviewType, string> = {
  page: '页面',
  user: '用户'
};

const suggestions = ref<SearchPreviewItem[]>([]);
const suggestionGroups = computed(() => {
  const order: SearchPreviewType[] = ['page', 'user']
  const buckets: Record<SearchPreviewType, Array<{ item: SearchPreviewItem; index: number }>> = {
    page: [],
    user: []
  }
  suggestions.value.forEach((item, index) => {
    buckets[item.type].push({ item, index })
  })
  return order
    .map((type) => ({
      type,
      label: type === 'page' ? '页面' : '用户',
      entries: buckets[type]
    }))
    .filter((group) => group.entries.length > 0)
})
const suggestionsLoading = ref(false);
const selectedIndex = ref(-1);
type BffFetcher = <T = any>(url: string, options?: any) => Promise<T>
const {$bff} = useNuxtApp() as unknown as { $bff: BffFetcher };

const { user: authUser, isAuthenticated, fetchCurrentUser, status: authStatus } = useAuth()
const {
  alerts: alertItems,
  unreadCount: alertsUnreadCount,
  loading: alertsLoading,
  hasUnread: alertsHasUnread,
  fetchAlerts,
  markAlertRead,
  markAllAlertsRead,
  resetState: resetAlertsState,
  setActiveMetric: setAlertsMetric
} = useAlerts()

const isAlertsDropdownOpen = ref(false)
const alertsButtonRef = ref<HTMLButtonElement | null>(null)
const alertsDropdownRef = ref<HTMLDivElement | null>(null)
const hasLinkedWikidot = computed(() => Boolean(authUser.value?.linkedWikidotId))

const avatarIdHeader = computed(() => {
  const id = authUser.value?.linkedWikidotId
  if (id && Number(id) > 0) return id
  return '0'
})

// 主题状态
const currentTheme = ref('dark');
const colorSchemes = [
  { key: 'aurora', name: 'Aurora 蓝', gradient: 'linear-gradient(135deg, #0A84FF, #40A4FF)' },
  { key: 'emerald', name: 'Fresh 绿', gradient: 'linear-gradient(135deg, #059669, #34D399)' },
  { key: 'indigo', name: 'Ocean 靛蓝', gradient: 'linear-gradient(135deg, #4F46E5, #6366F1)' },
  { key: 'rose', name: 'Sakura 粉', gradient: 'linear-gradient(135deg, #F43F5E, #FB7185)' },
  { key: 'amber', name: 'Sunset 琥珀', gradient: 'linear-gradient(135deg, #F59E0B, #FBBF24)' },
  { key: 'violet', name: 'Violet 紫', gradient: 'linear-gradient(135deg, #8B5CF6, #A78BFA)' }
] as const
const currentScheme = ref('aurora')

const iconButtonBaseClass =
  'inline-flex h-10 w-10 items-center justify-center rounded-full border border-neutral-200/80 bg-white/80 text-neutral-600 shadow-sm transition hover:border-[rgba(var(--accent),0.4)] hover:shadow-md hover:text-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)] focus:ring-offset-0 dark:border-neutral-700/70 dark:bg-neutral-800/70 dark:text-neutral-300 dark:hover:border-[rgba(var(--accent),0.4)] dark:hover:shadow-md dark:hover:text-[rgb(var(--accent))]';

const applyTheme = (mode: string) => {
  if (process.client) {
    const root = document.documentElement;
    if (mode === 'light') {
      root.classList.remove('dark');
      root.classList.add('light');
    } else {
      root.classList.remove('light');
      root.classList.add('dark');
    }
    localStorage.setItem('theme', mode);
    currentTheme.value = mode;
  }
};

function applyColorScheme(scheme: string, persist = true) {
  if (!process.client) return
  const available = colorSchemes.some((item) => item.key === scheme) ? scheme : 'aurora'
  const root = document.documentElement
  Array.from(root.classList).forEach((cls) => {
    if (cls && cls.startsWith('scheme-')) root.classList.remove(cls)
  })
  root.classList.add(`scheme-${available}`)
  if (persist) {
    try { localStorage.setItem('color-scheme', available) } catch (error) {
      console.warn('[layout] persist color scheme failed', error)
    }
  }
  currentScheme.value = available
}

function initializeColorScheme() {
  if (!process.client) return
  let stored = 'aurora'
  try {
    const raw = localStorage.getItem('color-scheme')
    if (raw && colorSchemes.some((item) => item.key === raw)) {
      stored = raw
    }
  } catch (error) {
    console.warn('[layout] read stored color scheme failed', error)
  }
  applyColorScheme(stored, false)
}

const toggleTheme = () => {
  const newTheme = currentTheme.value === 'light' ? 'dark' : 'light';
  applyTheme(newTheme);
};

const setColorScheme = (scheme: string) => {
  applyColorScheme(scheme, true)
}

const metricLabelMap: Record<AlertMetric, string> = {
  COMMENT_COUNT: '评论数',
  VOTE_COUNT: '投票数',
  RATING: '评分',
  REVISION_COUNT: '修订数',
  SCORE: '得分'
};

const alertTimeFormatter = typeof Intl !== 'undefined'
  ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  : null;

function metricLabel(metric: AlertMetric): string {
  return metricLabelMap[metric] ?? '指标';
}

function formatAlertDelta(item: AlertItem): string | null {
  if (item.diffValue == null) return null;
  const diff = Number(item.diffValue);
  if (!Number.isFinite(diff)) return null;
  const rounded = Math.round(diff);
  if (rounded === 0) return '0';
  const sign = rounded > 0 ? '+' : '';
  return `${sign}${rounded}`;
}

function formatAlertTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  if (alertTimeFormatter) {
    return alertTimeFormatter.format(date);
  }
  return date.toISOString();
}

const toggleAlertsDropdown = () => {
  if (!isAuthenticated.value || !hasLinkedWikidot.value) return;
  const next = !isAlertsDropdownOpen.value;
  isAlertsDropdownOpen.value = next;
  if (next) {
    setAlertsMetric('COMMENT_COUNT');
    void fetchAlerts('COMMENT_COUNT', true);
  }
};

const handleAlertNavigate = (item: AlertItem) => {
  void markAlertRead(item.id);
  isAlertsDropdownOpen.value = false;
  if (item.pageWikidotId) {
    navigateTo(`/page/${item.pageWikidotId}`);
    return;
  }
  if (item.pageUrl && process.client) {
    window.open(item.pageUrl, '_blank', 'noopener');
    return;
  }
  navigateTo('/account');
};

const handleMarkAllAlerts = () => {
  void markAllAlertsRead('COMMENT_COUNT');
};

const handleAlertsDocumentClick = (event: MouseEvent) => {
  if (!isAlertsDropdownOpen.value) return;
  const target = event.target as Node | null;
  if (!target) return;
  if (alertsDropdownRef.value?.contains(target) || alertsButtonRef.value?.contains(target)) {
    return;
  }
  isAlertsDropdownOpen.value = false;
};

onMounted(() => {
  // 初始化主题
  const saved = localStorage.getItem('theme') || 'dark';
  
  // 确保HTML元素有正确的类
  const root = document.documentElement;
  root.classList.remove('light', 'dark');
  
  applyTheme(saved);
  initializeColorScheme();

  document.addEventListener('mousedown', handleAlertsDocumentClick);
  document.addEventListener('keydown', handleGlobalKeydown);
  updateHeaderOffset()
  window.addEventListener('resize', updateHeaderOffset, { passive: true })

  if (authStatus.value === 'unknown') {
    fetchCurrentUser().then(() => {
      if (authUser.value?.linkedWikidotId) {
        setAlertsMetric('COMMENT_COUNT')
        return fetchAlerts('COMMENT_COUNT', true).catch((err) => {
          console.warn('[layout] alerts fetch after auth load failed', err)
        })
      }
      return undefined
    }).catch((err) => {
      console.warn('[layout] fetchCurrentUser failed', err)
    })
  } else if (authStatus.value === 'authenticated' && authUser.value?.linkedWikidotId) {
    setAlertsMetric('COMMENT_COUNT')
    fetchAlerts('COMMENT_COUNT').catch((err) => {
      console.warn('[layout] initial alerts fetch failed', err)
    })
  }
});

const openMobileSearch = () => {
  isMobileSearchOpen.value = true;
  if (process.client) document.body.style.overflow = 'hidden';
  nextTick(() => {
    mobileInputRef.value?.focus();
  });
};

const closeMobileSearch = () => {
  isMobileSearchOpen.value = false;
  showSuggestions.value = false;
  if (process.client && !isSidebarOpen.value) document.body.style.overflow = '';
};


const openSearch = openMobileSearch; // backward alias if needed
const toggleMobileSearch = () => {
  if (isMobileSearchOpen.value) closeMobileSearch(); else openMobileSearch();
};

const openSidebar = () => {
  isSidebarOpen.value = true;
  if (process.client) document.body.style.overflow = 'hidden';
};
const closeSidebar = () => {
  isSidebarOpen.value = false;
  if (process.client && !isMobileSearchOpen.value) document.body.style.overflow = '';
};

const focusSearchField = () => {
  if (!process.client) return
  const prefersMobile = window.innerWidth < 640
  if (prefersMobile) {
    if (!isMobileSearchOpen.value) {
      openMobileSearch()
    } else {
      nextTick(() => {
        mobileInputRef.value?.focus()
      })
    }
  } else {
    desktopInputRef.value?.focus()
  }
}

function onSearch() {
  const term = q.value.trim();
  if (!term) {
    if (isMobileSearchOpen.value) closeMobileSearch();
    navigateTo('/search');
    return;
  }
  showSuggestions.value = false;
  if (isMobileSearchOpen.value) {
    closeMobileSearch();
  }
  navigateTo({ path: '/search', query: { q: term } });
}

// 搜索建议功能
let searchTimeout: NodeJS.Timeout | null = null;

const normalizeSuggestion = (raw: any): SearchPreviewItem | null => {
  if (!raw) return null;
  const type: SearchPreviewType = raw.type === 'user' ? 'user' : 'page';
  const primaryId = raw.wikidotId ?? raw.wikidotID ?? raw.id;
  if (primaryId === undefined || primaryId === null) return null;
  const key = String(primaryId);

  const rawTitle = typeof raw.title === 'string' ? raw.title.trim() : '';
  const rawDisplayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
  const rawAlternate = typeof raw.alternateTitle === 'string' ? raw.alternateTitle.trim() : '';

  const title = type === 'user'
    ? (rawDisplayName || rawTitle || key)
    : (rawTitle || rawDisplayName || rawAlternate || key);

  const subtitle = type === 'page' && rawAlternate && rawAlternate !== title ? rawAlternate : null;
  const snippet = typeof raw.snippet === 'string' && raw.snippet.trim().length > 0 ? raw.snippet : null;

  const href = type === 'user'
    ? `/user/${key}`
    : `/page/${key}`;

  return {
    key,
    type,
    title,
    subtitle,
    snippet,
    href,
    badge: TYPE_BADGE_LABELS[type]
  };
};

const handleInput = () => {
  selectedIndex.value = -1;
  
  if (searchTimeout) {
    clearTimeout(searchTimeout);
  }
  
  const query = q.value.trim();
  
  if (query.length < 2) {
    suggestions.value = [];
    showSuggestions.value = false;
    return;
  }
  
  searchTimeout = setTimeout(async () => {
    suggestionsLoading.value = true;
    showSuggestions.value = true;
    
    try {
      const data = await $bff('/search/all', { params: { query, limit: 10 } });
      const normalized = (data?.results ?? [])
        .map(normalizeSuggestion)
        .filter((item): item is SearchPreviewItem => !!item);
      const seen = new Set<string>();
      const unique: SearchPreviewItem[] = [];
      for (const item of normalized) {
        if (seen.has(item.key)) continue;
        seen.add(item.key);
        unique.push(item);
      }
      suggestions.value = unique;
    } catch (error) {
      console.error('获取搜索建议失败:', error);
      suggestions.value = [];
    } finally {
      suggestionsLoading.value = false;
    }
  }, 300); // 300ms 防抖
};

const handleFocus = () => {
  if (q.value.length >= 2 && suggestions.value.length > 0) {
    showSuggestions.value = true;
  }
};

const handleBlur = () => {
  // 延迟关闭，以便点击建议
  setTimeout(() => {
    showSuggestions.value = false;
  }, 200);
};

const handleKeyDown = (e: KeyboardEvent) => {
  if (!showSuggestions.value || suggestions.value.length === 0) return;
  
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedIndex.value = Math.min(selectedIndex.value + 1, suggestions.value.length - 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedIndex.value = Math.max(selectedIndex.value - 1, -1);
  } else if (e.key === 'Enter' && selectedIndex.value >= 0) {
    e.preventDefault();
    selectSuggestion(suggestions.value[selectedIndex.value]);
  } else if (e.key === 'Escape') {
    if (isMobileSearchOpen.value) {
      e.preventDefault();
      closeMobileSearch();
    } else {
      showSuggestions.value = false;
    }
  }
};

const selectSuggestion = (item: SearchPreviewItem) => {
  const path = item.href;
  showSuggestions.value = false;
  q.value = '';
  if (isMobileSearchOpen.value) {
    closeMobileSearch();
  }
  navigateTo(path);
};

// 监听全局 ESC 关闭移动搜索浮层
const handleGlobalKeydown = (e: KeyboardEvent) => {
  const target = e.target as HTMLElement | null
  const tagName = target?.tagName || ''
  const isEditable = target?.isContentEditable
  const isTypingContext = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tagName) || Boolean(isEditable)

  if (!isTypingContext) {
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      focusSearchField()
      return
    }
    if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      focusSearchField()
      return
    }
  }

  if (e.key === 'Escape') {
    if (isMobileSearchOpen.value) {
      e.preventDefault();
      closeMobileSearch();
    }
    if (isSidebarOpen.value) {
      e.preventDefault();
      closeSidebar();
    }
  }
};

onBeforeUnmount(() => {
  if (!process.client) return;
  document.removeEventListener('keydown', handleGlobalKeydown);
  document.removeEventListener('mousedown', handleAlertsDocumentClick);
  window.removeEventListener('resize', updateHeaderOffset)
});

watch([
  () => authStatus.value,
  () => authUser.value?.linkedWikidotId
], ([nextStatus, nextLinked]) => {
  if (nextStatus === 'authenticated' && nextLinked) {
    setAlertsMetric('COMMENT_COUNT')
    fetchAlerts('COMMENT_COUNT', true).catch((err) => {
      console.warn('[layout] alerts fetch on auth change failed', err)
    })
  } else {
    resetAlertsState()
    isAlertsDropdownOpen.value = false
  }
});

// GA: route change page_view
const route = useRoute()
watch(() => route.fullPath, (path) => {
  if (!process.client) return
  const w = window as unknown as { gtag?: (...args: any[]) => void }
  if (typeof w.gtag === 'function') {
    w.gtag('config', GA_ID, { page_path: path })
  }
  isAlertsDropdownOpen.value = false
})
</script>

<style scoped>
/* Sidebar nav items */
.nav-item {
  display: flex;
  align-items: center;
  gap: .5rem;
  padding: .625rem .75rem;
  border-radius: .5rem;
  color: rgb(51 65 85);
}
.dark .nav-item { color: rgb(209 213 219); }
.nav-item:hover { background-color: rgba(2,6,23,0.06); }
.dark .nav-item:hover { background-color: rgba(255,255,255,0.06); }
</style>
