<script setup lang="ts">
useHead({
  title: '我的收藏夹'
})
</script>

<template>
  <AccountShell
    title="我的收藏夹"
    description="整理收藏页面、添加批注，并管理公开或私密的收藏夹。"
  >
    <AccountAuthGate>
      <template #default="{ user }">
        <CollectionManager v-if="user.linkedWikidotId" />
        <WikidotIdentityRequired
          v-else
          feature-name="收藏夹"
        />
      </template>
    </AccountAuthGate>
  </AccountShell>
</template>
