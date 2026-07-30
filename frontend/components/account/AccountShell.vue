<script setup lang="ts">
import { computed } from 'vue'
import { useNotificationsEnabled } from '~/composables/useNotificationsEnabled'

interface NavigationItem {
  label: string
  description: string
  icon: string
  to: string
}

interface NavigationGroup {
  label: string
  items: NavigationItem[]
}

defineProps<{
  title: string
  description: string
}>()

const route = useRoute()
const notificationsEnabled = useNotificationsEnabled()

const navigationGroups = computed<NavigationGroup[]>(() => {
  const groups: NavigationGroup[] = [{
    label: '账号',
    items: [
      {
        label: '概览',
        description: '账号状态与常用入口',
        icon: 'LayoutDashboard',
        to: '/account'
      },
      {
        label: '个人资料',
        description: '昵称、邮箱与头像',
        icon: 'UserRound',
        to: '/account/profile'
      },
      {
        label: '账号连接',
        description: '管理 Wikidot 身份',
        icon: 'Link2',
        to: '/account/connections'
      },
      {
        label: '安全',
        description: '密码与登录状态',
        icon: 'ShieldCheck',
        to: '/account/security'
      }
    ]
  }]

  if (notificationsEnabled.value) {
    groups.push({
      label: '通知',
      items: [
        {
          label: '提醒收件箱',
          description: '查看与你有关的动态',
          icon: 'Bell',
          to: '/notifications'
        },
        {
          label: '通知设置',
          description: '控制提醒类型与条件',
          icon: 'SlidersHorizontal',
          to: '/settings/notifications'
        }
      ]
    })
  }

  groups.push({
    label: '偏好与内容',
    items: [
      {
        label: '外观',
        description: '主题模式与配色',
        icon: 'Palette',
        to: '/settings/appearance'
      },
      {
        label: '收藏夹',
        description: '整理收藏的页面',
        icon: 'Bookmark',
        to: '/collections'
      },
      {
        label: '关注',
        description: '管理关注的作者',
        icon: 'UsersRound',
        to: '/following'
      }
    ]
  })

  return groups
})

const navigationItems = computed(() => navigationGroups.value.flatMap(group => group.items))
const currentNavigationPath = computed(() => {
  return navigationItems.value.find(item => item.to === route.path)?.to ?? '/account'
})

const mobileNavigationPath = computed({
  get: () => currentNavigationPath.value,
  set: (destination: string) => {
    if (destination && destination !== route.path) {
      void navigateTo(destination)
    }
  }
})
</script>

<template>
  <div class="mx-auto w-full max-w-6xl pb-8">
    <header class="mb-6 border-b border-[rgb(var(--panel-border)_/_0.65)] pb-6 sm:mb-8 sm:pb-8">
      <p class="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--g-accent)]">
        账号中心
      </p>
      <h1 class="text-3xl font-semibold tracking-tight text-[rgb(var(--fg))] sm:text-4xl">
        {{ title }}
      </h1>
      <p class="mt-3 max-w-3xl text-sm leading-6 text-[rgb(var(--muted))] sm:text-base">
        {{ description }}
      </p>
    </header>

    <div class="mb-6 lg:hidden">
      <label
        for="account-section-navigation"
        class="mb-2 block text-sm font-medium text-[rgb(var(--fg))]"
      >
        当前区域
      </label>
      <p
        id="account-section-navigation-hint"
        class="mb-2 text-xs leading-5 text-[rgb(var(--muted))]"
      >
        选择后会立即前往对应页面。
      </p>
      <div class="relative">
        <select
          id="account-section-navigation"
          v-model="mobileNavigationPath"
          aria-describedby="account-section-navigation-hint"
          class="min-h-11 w-full appearance-none rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-4 py-2.5 pr-11 text-sm font-medium text-[rgb(var(--fg))] shadow-sm outline-none transition focus:border-[var(--g-accent-border)] focus:ring-2 focus:ring-[var(--g-accent-border)]"
        >
          <optgroup
            v-for="group in navigationGroups"
            :key="group.label"
            :label="group.label"
          >
            <option
              v-for="item in group.items"
              :key="item.to"
              :value="item.to"
            >
              {{ item.label }}
            </option>
          </optgroup>
        </select>
        <LucideIcon
          name="ChevronsUpDown"
          class="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[rgb(var(--muted))]"
          aria-hidden="true"
        />
      </div>
    </div>

    <div class="grid min-w-0 gap-8 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-10">
      <aside class="hidden lg:block">
        <nav
          class="sticky top-28 space-y-6"
          aria-label="账号中心导航"
        >
          <section
            v-for="group in navigationGroups"
            :key="group.label"
            :aria-labelledby="`account-nav-${group.label}`"
          >
            <h2
              :id="`account-nav-${group.label}`"
              class="mb-2 px-3 text-xs font-semibold uppercase tracking-[0.14em] text-[rgb(var(--muted))]"
            >
              {{ group.label }}
            </h2>
            <ul class="space-y-1">
              <li
                v-for="item in group.items"
                :key="item.to"
              >
                <NuxtLink
                  :to="item.to"
                  class="group flex min-h-11 items-start gap-3 rounded-lg border px-3 py-2.5 transition"
                  :class="route.path === item.to
                    ? 'border-[var(--g-accent-border)] bg-[var(--g-accent-soft)] text-[rgb(var(--fg))]'
                    : 'border-transparent text-[rgb(var(--muted-strong))] hover:border-[rgb(var(--panel-border))] hover:bg-[rgb(var(--panel))] hover:text-[rgb(var(--fg))]'"
                  :aria-current="route.path === item.to ? 'page' : undefined"
                >
                  <LucideIcon
                    :name="item.icon"
                    class="mt-0.5 h-4.5 w-4.5 shrink-0"
                    :class="route.path === item.to ? 'text-[var(--g-accent)]' : 'text-[rgb(var(--muted))] group-hover:text-[var(--g-accent)]'"
                    stroke-width="1.8"
                    aria-hidden="true"
                  />
                  <span class="min-w-0">
                    <span class="block text-sm font-medium">{{ item.label }}</span>
                    <span class="mt-0.5 block text-xs leading-4 text-[rgb(var(--muted))]">
                      {{ item.description }}
                    </span>
                  </span>
                </NuxtLink>
              </li>
            </ul>
          </section>
        </nav>
      </aside>

      <div class="min-w-0">
        <slot />
      </div>
    </div>
  </div>
</template>
