<script setup lang="ts">
useHead({
  title: '账号连接'
})
</script>

<template>
  <AccountShell
    title="账号连接"
    description="连接并查看你的 Wikidot 身份，让作者与个人内容保持一致归属。"
  >
    <AccountAuthGate>
      <template #default="{ user }">
        <ConnectionsSettingsPanel :user="user" />
      </template>
    </AccountAuthGate>
  </AccountShell>
</template>
