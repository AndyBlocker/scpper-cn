<script setup lang="ts">
import { useNotificationsEnabled } from '~/composables/useNotificationsEnabled'

const route = useRoute()
const notificationsEnabled = useNotificationsEnabled()

const rawLegacyTab = Array.isArray(route.query.tab) ? route.query.tab[0] : route.query.tab
if (typeof rawLegacyTab === 'string') {
  const legacyDestinations: Record<string, string> = {
    overview: '/account',
    profile: '/account/profile',
    security: '/account/security',
    appearance: '/settings/appearance',
    collections: '/collections',
    follows: '/following'
  }
  const query = { ...route.query }
  delete query.tab

  if (rawLegacyTab === 'alerts' || rawLegacyTab === 'notifications') {
    if (notificationsEnabled.value) {
      legacyDestinations.alerts = '/notifications'
      legacyDestinations.notifications = '/settings/notifications'
    } else {
      query.notice = 'notifications-paused'
    }
  }

  await navigateTo({
    path: legacyDestinations[rawLegacyTab] || '/account',
    query
  }, {
    replace: true,
    redirectCode: 302
  })
}

const showNotificationsPausedNotice = computed(() => {
  const notice = Array.isArray(route.query.notice) ? route.query.notice[0] : route.query.notice
  return notice === 'notifications-paused'
})

useHead({
  title: '账号概览'
})
</script>

<template>
  <AccountShell
    title="账号概览"
    description="查看账号状态，并从这里进入资料、连接、安全与个人内容管理。"
  >
    <AccountAuthGate>
      <template #default="{ user }">
        <AccountOverview
          :user="user"
          :show-notifications-paused-notice="showNotificationsPausedNotice"
        />
      </template>
    </AccountAuthGate>
  </AccountShell>
</template>
