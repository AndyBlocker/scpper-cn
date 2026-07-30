<script setup lang="ts">
useHead({
  title: '我的关注'
})
</script>

<template>
  <AccountShell
    title="我的关注"
    description="查找已关注的作者，并在需要时取消关注。"
  >
    <AccountAuthGate>
      <template #default="{ user }">
        <FollowsPanel v-if="user.linkedWikidotId" />
        <WikidotIdentityRequired
          v-else
          feature-name="关注管理"
        />
      </template>
    </AccountAuthGate>
  </AccountShell>
</template>
