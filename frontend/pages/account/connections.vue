<script setup lang="ts">
useHead({
  title: '账号连接'
})
</script>

<template>
  <AccountShell
    title="账号连接"
    description="连接你的 Wikidot 身份，并管理仍需收尾的历史外部连接。"
  >
    <AccountAuthGate>
      <template #default="{ user }">
        <ConnectionsSettingsPanel :user="user" />
      </template>
    </AccountAuthGate>
  </AccountShell>
</template>
