<script setup lang="ts">
useHead({
  title: '账号安全'
})
</script>

<template>
  <AccountShell
    title="账号安全"
    description="修改登录密码、核对最近登录信息，或退出当前账号。"
  >
    <AccountAuthGate>
      <template #default="{ user }">
        <SecuritySettingsPanel :user="user" />
      </template>
    </AccountAuthGate>
  </AccountShell>
</template>
