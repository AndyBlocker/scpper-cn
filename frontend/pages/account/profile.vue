<script setup lang="ts">
useHead({
  title: '个人资料'
})
</script>

<template>
  <AccountShell
    title="个人资料"
    description="管理站内昵称，并查看登录邮箱和头像来源。"
  >
    <AccountAuthGate>
      <template #default="{ user }">
        <ProfileSettingsPanel :user="user" />
      </template>
    </AccountAuthGate>
  </AccountShell>
</template>
