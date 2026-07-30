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
  title: '提醒收件箱'
})
</script>

<template>
  <AccountShell
    title="提醒收件箱"
    description="集中查看与你的页面、关注作者和论坛互动有关的动态。"
  >
    <AccountAuthGate>
      <template #default="{ user }">
        <section
          v-if="user.linkedWikidotId"
          class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-5 shadow-sm sm:p-6"
        >
          <AlertsFeedPanel />
        </section>
        <WikidotIdentityRequired
          v-else
          feature-name="提醒"
        />
      </template>
    </AccountAuthGate>
  </AccountShell>
</template>
