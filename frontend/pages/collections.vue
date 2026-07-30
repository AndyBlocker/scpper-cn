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
      <CollectionManager />
    </AccountAuthGate>
  </AccountShell>
</template>
