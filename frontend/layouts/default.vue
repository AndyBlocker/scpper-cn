<template>
  <div class="relative min-h-screen overflow-x-hidden app-shell">
    <!-- Accessible skip link for keyboard users -->
    <a href="#main-content" class="skip-link">跳到主内容</a>
    <div
      aria-hidden="true"
      class="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top,_rgb(var(--hero-glow)_/_0.18),_transparent_60%)] dark:bg-[radial-gradient(circle_at_top,_rgb(var(--hero-glow)_/_0.24),_rgba(11,13,18,0.92)_62%)]"
    ></div>
    <div class="relative z-10 flex min-h-screen flex-col">
      <header ref="appHeaderRef" class="sticky top-0 z-50 app-header border-b border-[rgb(var(--nav-border)_/_0.45)] bg-[rgb(var(--nav-bg)_/_0.86)] shadow-[0_12px_40px_rgba(15,23,42,0.08)] backdrop-blur-2xl safe-pt safe-px">
        <div class="max-w-7xl mx-auto flex items-center gap-3 px-4 py-4 sm:gap-6">
          <div class="flex items-center gap-3">
            <!-- Mobile menu button (sidebar) -->
            <button
              type="button"
              class="inline-flex items-center justify-center sm:hidden h-10 w-10 rounded-full border border-[rgb(var(--panel-border)_/_0.45)] bg-[rgb(var(--panel)_/_0.88)] text-[rgb(var(--muted-strong))] shadow-[0_10px_24px_rgba(15,23,42,0.12)] transition hover:border-[rgb(var(--accent)_/_0.45)] hover:text-[rgb(var(--accent))]"
              aria-label="打开菜单"
              title="打开菜单"
              @click="openSidebar"
            >
              <LucideIcon name="Menu" class="w-5 h-5" />
            </button>

            <!-- Mobile brand/logo + title link -->
            <NuxtLink to="/" class="sm:hidden inline-flex items-center gap-2 group" aria-label="返回主页" title="返回主页">
              <BrandIcon class="w-7 h-7 text-[rgb(var(--fg))] group-hover:text-[rgb(var(--accent))] transition-colors" />
              <span class="font-bold text-base text-[rgb(var(--fg))] group-hover:text-[rgb(var(--accent))]">SCPPER-CN</span>
            </NuxtLink>

            <!-- Desktop brand + primary nav -->
            <div class="hidden sm:flex items-center gap-4 whitespace-nowrap">
            <NuxtLink to="/" class="flex items-center gap-2 group">
              <BrandIcon class="w-8 h-8 text-[rgb(var(--fg))] group-hover:text-[rgb(var(--accent))] transition-colors" />
              <span class="hidden sm:inline font-bold text-lg text-[rgb(var(--fg))] group-hover:text-[rgb(var(--accent))]">SCPPER-CN</span>
            </NuxtLink>
            <NuxtLink to="/ranking" class="inline-flex items-center gap-1 text-sm text-[rgb(var(--muted-strong))] hover:text-[rgb(var(--accent))] whitespace-nowrap">
              <LucideIcon name="ChartBar" class="w-5 h-5 sm:w-4 sm:h-4" />
              <span class="hidden sm:inline">排行</span>
            </NuxtLink>
            <NuxtLink to="/tools" class="inline-flex items-center gap-1 text-sm text-[rgb(var(--muted-strong))] hover:text-[rgb(var(--accent))] whitespace-nowrap">
              <LucideIcon name="Hammer" class="w-5 h-5 sm:w-4 sm:h-4" />
              <span class="hidden sm:inline">工具</span>
            </NuxtLink>
            <NuxtLink to="/about" class="inline-flex items-center gap-1 text-sm text-[rgb(var(--muted-strong))] hover:text-[rgb(var(--accent))] whitespace-nowrap">
              <LucideIcon name="Info" class="w-5 h-5 sm:w-4 sm:h-4" />
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
              <LucideIcon name="Search" class="w-5 h-5" />
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
                aria-label="站内搜索"
                class="w-full rounded-full border border-[rgb(var(--panel-border)_/_0.4)] bg-[rgb(var(--panel)_/_0.92)] px-5 py-2.5 text-sm text-[rgb(var(--fg))] shadow-[0_12px_30px_rgba(15,23,42,0.08)] outline-none focus:border-transparent focus:ring-2 focus:ring-[rgb(var(--accent)_/_0.45)] transition-all backdrop-blur placeholder:text-[rgb(var(--muted)_/_0.68)]"
              />
              <button type="submit" class="absolute right-2.5 top-1/2 -translate-y-1/2 text-[rgb(var(--accent-strong))] hover:text-[rgb(var(--accent))] p-1">
                <LucideIcon name="Search" class="w-5 h-5" />
              </button>
              <div v-if="showSuggestions" class="absolute top-full left-0 right-0 mt-1 z-50 max-h-96 overflow-y-auto rounded-lg border border-[rgb(var(--panel-border)_/_0.45)] bg-[rgb(var(--panel)_/_0.98)] shadow-[0_26px_64px_rgba(15,23,42,0.18)] backdrop-blur">
                <div v-if="suggestionsLoading" class="p-3 text-sm text-[rgb(var(--muted))]">搜索中...</div>
                <div v-else-if="suggestions.length === 0 && q.length >= 2" class="p-3 text-sm text-[rgb(var(--muted))]">没有找到相关结果</div>
                <div v-else>
                  <div
                    v-for="group in suggestionGroups"
                    :key="group.type"
                    class="py-1 first:pt-0"
                  >
                    <div class="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--muted)_/_0.7)]">
                      {{ group.label }}
                    </div>
                    <a
                      v-for="entry in group.entries"
                      :key="entry.item.key"
                      :href="entry.item.href"
                      @click.prevent="selectSuggestion(entry.item)"
                      @mouseenter="selectedIndex = entry.index"
                      class="block px-4 py-2 hover:bg-[rgb(var(--accent)_/_0.12)] cursor-pointer transition-colors"
                      :class="{ 'bg-[rgb(var(--accent)_/_0.12)]': selectedIndex === entry.index }"
                    >
                      <div class="flex items-start justify-between gap-3">
                        <div class="min-w-0 flex-1">
                          <div class="font-medium text-sm text-[rgb(var(--fg))] truncate">
                            <span>{{ entry.item.title }}</span>
                            <span v-if="entry.item.subtitle" class="text-[rgb(var(--muted))]"> - {{ entry.item.subtitle }}</span>
                          </div>
                          <div
                            v-if="entry.item.snippet"
                            class="mt-1 text-xs leading-relaxed text-[rgb(var(--muted)_/_0.85)]"
                            v-html="entry.item.snippet"
                          ></div>
                        </div>
                        <span class="ml-2 shrink-0 rounded-full border border-[rgb(var(--accent)_/_0.28)] bg-[rgb(var(--accent)_/_0.1)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--accent-strong))]">
                          {{ entry.item.badge }}
                        </span>
                      </div>
                    </a>
                  </div>
                </div>
              </div>
            </form>
            <button
              type="button"
              :class="[iconButtonBaseClass, 'hidden sm:inline-flex']"
              :aria-label="themeToggleLabel"
              :title="themeToggleLabel"
              @click="toggleThemeMode"
            >
              <LucideIcon v-if="themeMode === 'dark'" name="Sun" class="h-5 w-5" stroke-width="1.8" />
              <LucideIcon v-else name="Moon" class="h-5 w-5" stroke-width="1.8" />
            </button>
            <!-- Theme toggle hidden on mobile, available via sidebar -->
            <div v-if="isAuthenticated && hasLinkedWikidot" class="relative">
              <button
                ref="alertsButtonRef"
                type="button"
                @click="toggleAlertsDropdown"
                :class="['relative', iconButtonBaseClass]"
                aria-label="查看提醒"
                aria-haspopup="menu"
                :aria-expanded="isAlertsDropdownOpen ? 'true' : 'false'"
                aria-controls="alerts-menu"
              >
                <LucideIcon name="Bell" class="h-5 w-5" stroke-width="1.8" />
                <span
                  v-if="totalUnreadCount > 0"
                  class="absolute -top-0.5 -right-0.5 inline-flex min-w-[18px] justify-center rounded-full bg-[rgb(var(--accent))] px-1 text-[10px] font-semibold leading-5 text-white shadow"
                >{{ totalUnreadCount > 99 ? '99+' : totalUnreadCount }}</span>
              </button>
              <transition name="fade">
                <div
                  v-if="isAlertsDropdownOpen"
                  ref="alertsDropdownRef"
                  class="absolute right-0 mt-3 w-80 max-w-[80vw] max-h-[70dvh] overflow-y-auto overscroll-contain rounded-2xl border border-[rgb(var(--panel-border)_/_0.45)] bg-[rgb(var(--panel)_/_0.96)] p-4 shadow-xl backdrop-blur"
                  role="menu"
                  id="alerts-menu"
                  aria-live="polite"
                  @keydown.stop.prevent="handleAlertsKeydown"
                >
                  <div class="flex items-center justify-between gap-3">
                    <h3 class="text-sm font-semibold text-[rgb(var(--fg))]">信息提醒</h3>
                    <button
                      v-if="currentScopeUnread > 0"
                      type="button"
                      class="text-xs font-medium text-[rgb(var(--accent))] hover:underline"
                      @click="handleMarkAllAlerts"
                    >全部已读</button>
                  </div>
                  <!-- Dropdown unified view: show aggregated feed only; per-metric details go to account page -->
                  <div v-if="alertsLoading && isMetricTab" class="py-6 text-center text-xs text-[rgb(var(--muted))]">加载中…</div>
                  <div v-else-if="(isAllTab ? alertsAllItems.length : alertItems.length) === 0" class="py-6 text-center text-xs text-[rgb(var(--muted))]">暂无提醒</div>
                  <ul v-else class="mt-3 space-y-3">
                    <li
                      v-for="(item, idx) in (isAllTab ? alertsAllItems : alertItems)"
                      :key="(item as any).id + '-' + (isAllTab ? (item as any).sourceMetric : 'cur')"
                      class="rounded-xl border border-[rgb(var(--panel-border)_/_0.4)] bg-[rgb(var(--panel)_/_0.88)] transition hover:border-[rgb(var(--accent)_/_0.35)] hover:bg-[rgb(var(--panel)_/_0.95)]"
                    >
                      <button
                        type="button"
                        class="w-full px-3 py-3 text-left"
                        role="menuitem"
                        tabindex="-1"
                        :data-index="idx"
                        :class="{ 'opacity-70': !!item.acknowledgedAt }"
                        @click="handleAlertNavigate(item)"
                      >
                        <div class="flex items-center justify-between gap-2">
                          <span class="max-w-[70%] truncate text-sm font-medium text-[rgb(var(--fg))]">
                            {{ item.pageTitle || '未知页面' }}
                          </span>
                          <span class="shrink-0 text-[10px] text-[rgb(var(--muted)_/_0.85)]">
                            {{ formatAlertTime(item.detectedAt) }}
                          </span>
                        </div>
                        <div class="mt-1 text-xs text-[rgb(var(--muted))]">
                          <template v-if="isAllTab">
                            <span class="mr-1 rounded px-1 py-0.5 text-[10px] border border-[rgb(var(--panel-border)_/_0.45)]">{{ metricLabel(item.metric) }}</span>
                          </template>
                          {{ metricLabel(item.metric) }}变动
                          <span
                            v-if="formatAlertDelta(item)"
                            class="ml-1 font-semibold"
                            :class="{
                              'text-[rgb(var(--success-strong))]': (item.diffValue || 0) > 0,
                              'text-[rgb(var(--danger-strong))]': (item.diffValue || 0) < 0
                            }"
                          >{{ formatAlertDelta(item) }}</span>
                          <span v-if="item.newValue != null" class="ml-2 text-[11px] text-[rgb(var(--muted)_/_0.8)]">当前：{{ Math.round(Number(item.newValue)) }}</span>
                        </div>
                        <div v-if="item.pageAlternateTitle" class="mt-1 text-[11px] text-[rgb(var(--muted)_/_0.8)] truncate">
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
                class="inline-flex h-10 items-center gap-2 rounded-full border border-[rgb(var(--panel-border)_/_0.4)] bg-[rgb(var(--panel)_/_0.9)] px-4 text-sm font-medium text-[rgb(var(--fg))] shadow-[0_12px_30px_rgba(15,23,42,0.1)] transition hover:border-[rgb(var(--accent)_/_0.35)] hover:text-[rgb(var(--accent))]"
              >
                <UserAvatar :wikidot-id="avatarIdHeader" :name="authUser?.displayName || authUser?.email || ''" :size="28" />
                <span class="hidden lg:inline">{{ authUser?.displayName || authUser?.email }}</span>
              </NuxtLink>
            </div>
            <div v-else class="hidden sm:flex items-center gap-2">
              <NuxtLink
                to="/auth/login"
                class="inline-flex h-10 items-center rounded-full border border-[rgb(var(--panel-border)_/_0.4)] bg-[rgb(var(--panel)_/_0.88)] px-4 text-sm font-semibold text-[rgb(var(--muted-strong))] shadow-[0_12px_30px_rgba(15,23,42,0.1)] transition hover:border-[rgb(var(--accent)_/_0.35)] hover:text-[rgb(var(--accent))]"
              >登录</NuxtLink>
            </div>
          </div>
        </div>
      </header>

      <!-- Mobile Sidebar -->
      <transition name="fade">
        <div v-if="isSidebarOpen" class="fixed inset-0 z-[70] safe-px safe-pt safe-pb">
          <div class="absolute inset-0 bg-neutral-950/60" @click="closeSidebar" />
          <div class="absolute left-0 top-0 h-full w-80 max-w-[85vw] safe-pl">
            <div ref="sidebarRef" class="h-full border-r border-[rgb(var(--sidebar-border)_/_0.55)] bg-[rgb(var(--sidebar-bg)_/_0.95)] backdrop-blur-xl shadow-2xl rounded-r-2xl overflow-hidden flex flex-col">
              <div class="px-4 py-4 flex items-center justify-between border-b border-[rgb(var(--sidebar-border)_/_0.45)] bg-[radial-gradient(circle_at_top,_rgb(var(--hero-glow)_/_0.12),_transparent_70%)]">
                <NuxtLink to="/" @click="closeSidebar" class="inline-flex items-center gap-2 group">
                  <BrandIcon class="w-7 h-7 text-[rgb(var(--fg))] group-hover:text-[rgb(var(--accent))]" />
                  <span class="font-bold text-[rgb(var(--fg))] group-hover:text-[rgb(var(--accent))]">SCPPER-CN</span>
                </NuxtLink>
                <button type="button" class="p-2 rounded-lg text-[rgb(var(--muted-strong))] hover:bg-[rgb(var(--panel)_/_0.18)]" @click="closeSidebar" aria-label="关闭菜单">
                  <LucideIcon name="X" class="w-5 h-5" />
                </button>
              </div>

              <nav class="flex-1 px-3 py-3 overflow-y-auto">
                <NuxtLink to="/ranking" @click="closeSidebar" class="nav-item">
                  <LucideIcon name="ChartBar" class="w-5 h-5" />
                  <span>排行</span>
                </NuxtLink>
                <NuxtLink to="/tools" @click="closeSidebar" class="nav-item">
                  <LucideIcon name="Hammer" class="w-5 h-5" />
                  <span>工具</span>
                </NuxtLink>
                <NuxtLink to="/about" @click="closeSidebar" class="nav-item">
                  <LucideIcon name="Info" class="w-5 h-5" />
                  <span>关于</span>
                </NuxtLink>
              </nav>

              <div class="px-4 py-3 border-t border-[rgb(var(--sidebar-border)_/_0.45)]">
                <div class="flex items-center justify-between gap-3">
                  <div class="min-w-0">
                    <template v-if="isAuthenticated">
                      <NuxtLink to="/account" @click="closeSidebar" class="inline-flex items-center gap-2">
                        <UserAvatar :wikidot-id="avatarIdHeader" :name="authUser?.displayName || authUser?.email || ''" :size="28" class="ring-1 ring-[rgb(var(--panel-border)_/_0.55)]" />
                        <span class="text-sm font-medium text-[rgb(var(--fg))] truncate max-w-[10rem]">{{ authUser?.displayName || authUser?.email }}</span>
                      </NuxtLink>
                    </template>
                    <template v-else>
                      <NuxtLink to="/auth/login" @click="closeSidebar" class="inline-flex items-center gap-2 text-sm font-medium text-[rgb(var(--accent))]">
                        登录
                      </NuxtLink>
                    </template>
                  </div>
                  <button
                    type="button"
                    :class="iconButtonBaseClass"
                    :aria-label="themeToggleLabel"
                    :title="themeToggleLabel"
                    @click="toggleThemeMode"
                  >
                    <LucideIcon v-if="themeMode === 'dark'" name="Sun" class="h-5 w-5" stroke-width="1.8" />
                    <LucideIcon v-else name="Moon" class="h-5 w-5" stroke-width="1.8" />
                  </button>
                </div>
              </div>

              <div class="px-4 py-3 text-[11px] text-[rgb(var(--muted)_/_0.75)] border-t border-[rgb(var(--sidebar-border)_/_0.45)]">© {{ new Date().getFullYear() }} SCPPER-CN</div>
            </div>
          </div>
        </div>
      </transition>

      <div v-if="isMobileSearchOpen" class="fixed inset-0 z-[70] safe-px safe-pt safe-pb">
        <div class="absolute inset-0 bg-neutral-950/60" @click="closeMobileSearch" />
        <div class="absolute inset-0 flex flex-col">
          <div class="border-b border-[rgb(var(--nav-border)_/_0.4)] bg-[rgb(var(--nav-bg)_/_0.9)] backdrop-blur">
            <div class="max-w-7xl mx-auto flex items-center gap-2 px-4 py-3">
              <form class="relative flex-1" @submit.prevent="onSearch">
                <input
                  ref="mobileInputRef"
                  v-model="q"
                  @input="handleInput"
                  @keydown="handleKeyDown"
                  placeholder="搜索页面 / 用户 / 标签…"
                  aria-label="站内搜索"
                  class="w-full rounded-full border border-[rgb(var(--panel-border)_/_0.4)] bg-[rgb(var(--panel)_/_0.92)] px-5 py-2.5 text-sm text-[rgb(var(--fg))] shadow-[0_12px_30px_rgba(15,23,42,0.12)] outline-none focus:border-transparent focus:ring-2 focus:ring-[rgb(var(--accent)_/_0.45)] transition-all backdrop-blur placeholder:text-[rgb(var(--muted)_/_0.68)]"
                />
                <button type="submit" class="absolute right-2 top-1/2 -translate-y-1/2 text-[rgb(var(--accent-strong))] hover:text-[rgb(var(--accent))] p-1">
                  <LucideIcon name="Search" class="w-5 h-5" />
                </button>
              </form>
              <button
                @click="closeMobileSearch"
                class="p-2 rounded-lg border border-[rgb(var(--panel-border)_/_0.4)] bg-[rgb(var(--panel)_/_0.9)] text-[rgb(var(--muted-strong))] shadow-[0_10px_26px_rgba(15,23,42,0.12)]"
                aria-label="关闭搜索"
                title="关闭搜索"
              >
                <LucideIcon name="X" class="w-5 h-5" />
              </button>
            </div>
          </div>
          <div class="flex-1 overflow-y-auto bg-[rgb(var(--nav-bg)_/_0.92)] backdrop-blur">
            <div class="max-w-7xl mx-auto px-4 py-2">
              <div v-if="suggestionsLoading" class="p-3 text-sm text-[rgb(var(--muted))]">搜索中...</div>
              <div v-else-if="suggestions.length === 0 && q.length >= 2" class="p-3 text-sm text-[rgb(var(--muted))]">没有找到相关结果</div>
              <div v-else>
                <div
                  v-for="group in suggestionGroups"
                  :key="group.type"
                  class="py-1 first:pt-0"
                >
                  <div class="px-4 py-1 text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--muted)_/_0.7)]">
                    {{ group.label }}
                  </div>
                  <a
                    v-for="entry in group.entries"
                    :key="entry.item.key"
                    :href="entry.item.href"
                    @click.prevent="selectSuggestion(entry.item)"
                    @mouseenter="selectedIndex = entry.index"
                    class="block px-4 py-3 border-b border-[rgb(var(--panel-border)_/_0.35)] hover:bg-[rgb(var(--accent)_/_0.12)] transition-colors"
                    :class="{ 'bg-[rgb(var(--accent)_/_0.12)]': selectedIndex === entry.index }"
                  >
                    <div class="flex items-start justify-between gap-3">
                      <div class="min-w-0 flex-1">
                        <div class="font-medium text-sm text-[rgb(var(--fg))] truncate">
                          <span>{{ entry.item.title }}</span>
                          <span v-if="entry.item.subtitle" class="text-[rgb(var(--muted))]"> - {{ entry.item.subtitle }}</span>
                        </div>
                        <div
                          v-if="entry.item.snippet"
                          class="mt-1 text-xs leading-relaxed text-[rgb(var(--muted)_/_0.85)]"
                          v-html="entry.item.snippet"
                        ></div>
                      </div>
                      <span class="ml-2 shrink-0 rounded-full border border-[rgb(var(--accent)_/_0.28)] bg-[rgb(var(--accent)_/_0.1)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[rgb(var(--accent-strong))]">
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

      <main id="main-content" class="w-full px-4 pt-10 pb-16 sm:px-6 md:px-8">
        <div class="max-w-7xl mx-auto">
          <slot />
        </div>
      </main>
      <footer class="mt-auto app-footer py-6 text-center text-xs backdrop-blur">© {{ new Date().getFullYear() }} AndyBlocker</footer>
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
import { useThemeSettings } from '~/composables/useThemeSettings'
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
const isClient = typeof window !== 'undefined'

function updateHeaderOffset() {
  if (!isClient) return
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
  alertsByMetric,
  alertsAll: alertsAllItems,
  unreadCount: alertsUnreadCount,
  unreadByMetric: unreadByMetricVal,
  totalUnread: totalUnreadCount,
  loading: alertsLoading,
  hasUnread: alertsHasUnread,
  fetchAlerts,
  fetchAll,
  markAlertRead,
  markAllRead,
  markAllAlertsRead,
  resetState: resetAlertsState,
  setActiveMetric: setAlertsMetric,
  startRevalidateOnFocus,
  startRevalidateOnReconnect
} = useAlerts()

const isAlertsDropdownOpen = ref(false)
const alertsActiveTab = ref<'ALL' | AlertMetric>('ALL')
const isAllTab = computed(() => alertsActiveTab.value === 'ALL')
const isMetricTab = computed(() => alertsActiveTab.value !== 'ALL')
const currentScopeUnread = computed(() => isAllTab.value ? totalUnreadCount.value : (unreadByMetricVal.value?.[alertsActiveTab.value as AlertMetric] || 0))
const selectedAlertIndex = ref(-1)
const alertsButtonRef = ref<HTMLButtonElement | null>(null)
const alertsDropdownRef = ref<HTMLDivElement | null>(null)
const hasLinkedWikidot = computed(() => Boolean(authUser.value?.linkedWikidotId))

const avatarIdHeader = computed(() => {
  const id = authUser.value?.linkedWikidotId
  if (id && Number(id) > 0) return id
  return '0'
})

// 主题设置
const { initialize: initializeThemeSettings, themeMode, toggleThemeMode } = useThemeSettings();

const themeToggleLabel = computed(() =>
  themeMode.value === 'dark' ? '切换到浅色模式' : '切换到深色模式'
);

const iconButtonBaseClass =
  'inline-flex h-10 w-10 items-center justify-center rounded-full border border-[rgb(var(--panel-border)_/_0.45)] bg-[rgb(var(--panel)_/_0.9)] text-[rgb(var(--muted-strong))] shadow-[0_10px_28px_rgba(15,23,42,0.12)] transition hover:border-[rgb(var(--accent)_/_0.45)] hover:shadow-[0_14px_32px_rgba(15,23,42,0.16)] hover:text-[rgb(var(--accent))] focus:outline-none focus:ring-2 focus:ring-[rgb(var(--accent)_/_0.35)] focus:ring-offset-0';

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
    // Decide initial tab
    alertsActiveTab.value = 'ALL';
    // Preload all metrics and revalidate
    void fetchAll(false);
    // reset keyboard index
    selectedAlertIndex.value = -1;
  }
};

const handleAlertNavigate = (item: AlertItem) => {
  void markAlertRead(item.id, (item as any).sourceMetric ?? item.metric);
  isAlertsDropdownOpen.value = false;
  if (item.pageWikidotId) {
    navigateTo(`/page/${item.pageWikidotId}`);
    return;
  }
  if (item.pageUrl && isClient) {
    window.open(item.pageUrl, '_blank', 'noopener');
    return;
  }
  navigateTo('/account');
};

const handleMarkAllAlerts = () => {
  if (isAllTab.value) {
    void markAllRead('ALL');
  } else {
    void markAllRead(alertsActiveTab.value as AlertMetric);
  }
};

function switchAlertsTab(tab: 'ALL' | AlertMetric) {
  alertsActiveTab.value = tab;
  if (tab !== 'ALL') {
    setAlertsMetric(tab as AlertMetric);
    void fetchAlerts(tab as AlertMetric, false);
  }
  selectedAlertIndex.value = -1;
}

function handleAlertsKeydown(e: KeyboardEvent) {
  const list = (isAllTab.value ? alertsAllItems.value : alertItems.value) as any[]
  if (!list || list.length === 0) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    selectedAlertIndex.value = Math.min(selectedAlertIndex.value + 1, list.length - 1)
    focusAlertByIndex(selectedAlertIndex.value)
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    selectedAlertIndex.value = Math.max(selectedAlertIndex.value - 1, 0)
    focusAlertByIndex(selectedAlertIndex.value)
    return
  }
  if (e.key === 'Enter' && selectedAlertIndex.value >= 0) {
    e.preventDefault()
    const item = list[selectedAlertIndex.value]
    if (item) handleAlertNavigate(item)
    return
  }
  if (e.key === 'Escape') {
    e.preventDefault()
    isAlertsDropdownOpen.value = false
    alertsButtonRef.value?.focus()
  }
}

function focusAlertByIndex(i: number) {
  if (i < 0) return
  const el = alertsDropdownRef.value?.querySelector(`[role="menuitem"][data-index="${i}"]`) as HTMLElement | null
  el?.focus()
}

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
  initializeThemeSettings();
  document.addEventListener('mousedown', handleAlertsDocumentClick);
  document.addEventListener('keydown', handleGlobalKeydown);
  updateHeaderOffset()
  window.addEventListener('resize', updateHeaderOffset, { passive: true })
  // SWR-like revalidation hooks for alerts
  const stopFocus = startRevalidateOnFocus();
  const stopOnline = startRevalidateOnReconnect();

  if (authStatus.value === 'unknown') {
    fetchCurrentUser().then(() => {
      if (authUser.value?.linkedWikidotId) {
        return fetchAll(true).catch((err) => {
          console.warn('[layout] alerts fetch after auth load failed', err)
        })
      }
      return undefined
    }).catch((err) => {
      console.warn('[layout] fetchCurrentUser failed', err)
    })
  } else if (authStatus.value === 'authenticated' && authUser.value?.linkedWikidotId) {
    fetchAll(false).catch((err) => {
      console.warn('[layout] initial alerts fetch failed', err)
    })
  }
});

const openMobileSearch = () => {
  isMobileSearchOpen.value = true;
  if (isClient) document.body.style.overflow = 'hidden';
  nextTick(() => {
    mobileInputRef.value?.focus();
  });
};

const closeMobileSearch = () => {
  isMobileSearchOpen.value = false;
  showSuggestions.value = false;
  if (isClient && !isSidebarOpen.value) document.body.style.overflow = '';
};


const openSearch = openMobileSearch; // backward alias if needed
const toggleMobileSearch = () => {
  if (isMobileSearchOpen.value) closeMobileSearch(); else openMobileSearch();
};

const openSidebar = () => {
  isSidebarOpen.value = true;
  if (isClient) document.body.style.overflow = 'hidden';
};
const closeSidebar = () => {
  isSidebarOpen.value = false;
  if (isClient && !isMobileSearchOpen.value) document.body.style.overflow = '';
};

const focusSearchField = () => {
  if (!isClient) return
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
  if (!isClient) return;
  document.removeEventListener('keydown', handleGlobalKeydown);
  document.removeEventListener('mousedown', handleAlertsDocumentClick);
  window.removeEventListener('resize', updateHeaderOffset)
  if (typeof stopFocus === 'function') stopFocus();
  if (typeof stopOnline === 'function') stopOnline();
});

watch([
  () => authStatus.value,
  () => authUser.value?.linkedWikidotId
], ([nextStatus, nextLinked]) => {
  if (nextStatus === 'authenticated' && nextLinked) {
    fetchAll(true).catch((err) => {
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
  if (!isClient) return
  const w = window as unknown as { gtag?: (...args: any[]) => void }
  if (typeof w.gtag === 'function') {
    w.gtag('config', GA_ID, { page_path: path })
  }
  isAlertsDropdownOpen.value = false
})
</script>

<style scoped>
.app-shell {
  background-color: rgb(var(--bg));
  color: rgb(var(--fg));
}
.app-header {
  border: 1px solid rgb(var(--nav-border) / 0.45);
  background-color: rgb(var(--nav-bg) / 0.86);
  color: inherit;
}
.app-footer {
  border-top: 1px solid rgb(var(--panel-border) / 0.45);
  background-color: rgb(var(--panel) / 0.6);
  color: rgb(var(--muted));
}

/* Sidebar nav items */
.nav-item {
  display: flex;
  align-items: center;
  gap: .5rem;
  padding: .625rem .75rem;
  border-radius: .5rem;
  color: rgb(var(--muted));
  transition: background-color .2s ease, color .2s ease;
}
.nav-item:hover {
  background-color: rgb(var(--accent) / 0.12);
  color: rgb(var(--accent));
}
</style>
