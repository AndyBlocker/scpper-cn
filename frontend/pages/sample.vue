<template>
    <div class="space-y-8">
      <header class="flex items-center justify-between border-b-2 border-emerald-100 dark:border-emerald-900/30 pb-3">
        <div class="flex items-center gap-3">
          <div class="h-8 w-1 bg-emerald-600 rounded" />
          <h1 class="text-lg font-bold text-neutral-800 dark:text-neutral-100">Card 组件样例（v2）</h1>
        </div>
        <span class="text-xs text-neutral-500 dark:text-neutral-400">示例用于展示新版视觉与尺寸</span>
      </header>
  
      <!-- UserCard Variants -->
      <section class="space-y-3">
        <h2 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">UserCard</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
          <UserCard size="L" :wikidot-id="userSample.wikidotId" :display-name="userSample.displayName" :rank="userSample.rank" :totals="{ totalRating: 512, avgRating: 170.7, works: 3, votesUp: 204, votesDown: 22 }" handle="@bright" :sparkline="sparkDemo" />
          <UserCard size="M" :wikidot-id="userSample.wikidotId" :display-name="userSample.displayName" :rank="userSample.rank" :totals="{ totalRating: 512, works: 3 }" handle="@bright" />
          <UserCard size="S" :wikidot-id="userSample.wikidotId" :display-name="userSample.displayName" :rank="userSample.rank" />
        </div>
      </section>
  
      <!-- PageCard Variants -->
      <section class="space-y-3">
        <h2 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">PageCard</h2>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
          <PageCard size="L" title="SCP-XXXX 示例页面标题" url="/page/123456" :authors="authorsSample" date-iso="2023-09-10" :tags="tagsSampleL" excerpt="这是一个用于演示 PageCard 外观与信息层次的示例摘录。" :rating="128" :comments="24" :controversy="0.213" :sparkline="sparkDemo" />
          <PageCard size="M" title="演示页面（中尺寸）" url="/page/654321" :authors="[{ name: 'Dr. Bright', url: '/user/3405622' }]" date-iso="2024-06-02" :tags="tagsSampleM" :rating="92" :comments="12" :controversy="0.137" :sparkline="sparkDemo.slice(2)" />
          <!-- S 仅展示 Title / Date / Author -->
          <PageCard size="S" title="小尺寸卡片" url="/page/777888" :authors="[{ name: 'Dr. Bright', url: '/user/3405622' }]" date-iso="2024-06-03" />
        </div>
      </section>
    </div>
  </template>
  
  <script setup lang="ts">
  const userSample = { wikidotId: 3405622, displayName: 'Dr. Bright', rank: 42 }
  const authorsSample = [ { name: 'Dr. Bright', url: '/user/3405622' }, { name: 'Clef', url: '/user/12345' }, { name: 'Gears' } ]
  const tagsSampleL = ['SCP', '原创', 'Keter', '中文', '精选']
  const tagsSampleM = ['故事', '翻译', '精选']
  const sparkDemo = [120,121,122,124,123,126,128,129,130,129,131,133]
  </script>
  