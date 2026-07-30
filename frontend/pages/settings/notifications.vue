<script setup lang="ts">
import { useNotificationsEnabled } from '~/composables/useNotificationsEnabled'

const notificationsEnabled = useNotificationsEnabled()
if (!notificationsEnabled.value) {
  await navigateTo({
    path: '/account',
    query: { notice: 'notifications-paused' }
  }, {
    replace: true,
    redirectCode: 302
  })
}

useHead({
  title: '通知设置'
})
</script>

<template>
  <AccountShell
    title="通知设置"
    description="控制需要接收的页面提醒类型、触发条件与可用渠道。"
  >
    <AccountAuthGate>
      <template #default="{ user }">
        <section
          v-if="user.linkedWikidotId"
          class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-5 shadow-sm sm:p-6"
        >
          <NotificationSettingsPanel />
        </section>
        <WikidotIdentityRequired
          v-else
          feature-name="通知设置"
        />
      </template>
    </AccountAuthGate>
  </AccountShell>
</template>
