<template>
  <div class="max-w-5xl mx-auto w-full py-14 space-y-12">
    <header class="space-y-5 text-center sm:text-left">
      <div class="inline-flex items-center gap-2 rounded-full border border-[rgba(var(--accent),0.35)] bg-[rgba(var(--accent),0.08)] px-4 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-[rgb(var(--accent))]">
        <span>工具枢纽</span>
      </div>
      <div class="space-y-3">
        <h1 class="text-3xl font-semibold text-neutral-900 dark:text-neutral-50 sm:text-4xl">集中入口，一步抵达分析与赛事模块</h1>
        <p class="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">
          按类别快速定位常用数据工具与最新竞赛专题，点击卡片即可跳转到对应页面。
        </p>
      </div>
    </header>

    <section v-for="section in sections" :key="section.key" class="space-y-4">
      <div class="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 class="text-xl font-semibold text-neutral-900 dark:text-neutral-50">{{ section.title }}</h2>
          <p v-if="section.caption" class="text-sm text-neutral-500 dark:text-neutral-400">{{ section.caption }}</p>
        </div>
      </div>
      <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <NuxtLink
          v-for="item in section.items"
          :key="item.to"
          :to="item.to"
          class="group relative flex flex-col gap-4 rounded-2xl border border-white/70 bg-white/90 p-6 text-left shadow-sm transition hover:-translate-y-1 hover:shadow-lg dark:border-white/10 dark:bg-neutral-900/80"
        >
          <div class="inline-flex h-12 w-12 items-center justify-center rounded-xl bg-[rgba(var(--accent),0.08)] text-[rgb(var(--accent))]">
            <component :is="item.icon" class="h-6 w-6" />
          </div>
          <div class="space-y-2">
            <h3 class="text-lg font-semibold text-neutral-900 transition-colors group-hover:text-[rgb(var(--accent))] dark:text-neutral-100">{{ item.title }}</h3>
            <p class="text-sm text-neutral-500 dark:text-neutral-400">{{ item.description }}</p>
          </div>
          <span class="absolute right-6 top-6 text-xs font-medium uppercase tracking-wide text-[rgba(var(--accent),0.7)]">
            {{ item.badge }}
          </span>
        </NuxtLink>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { defineComponent, h } from 'vue'

const sections = [
  {
    key: 'tools',
    title: '工具',
    caption: '站点分析、标签洞察与图库服务，便捷掌握站点脉搏。',
    items: [
      {
        to: '/analytics',
        title: '站点数据分析',
        description: '查看分类趋势、活跃用户以及标签组合表现，用数据解读站点动向。',
        badge: 'Analytics',
        icon: defineComponent({
          name: 'AnalyticsIcon',
          setup: () => () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2' }, [
            h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M11 3v18M3 12h18' })
          ])
        })
      },
      {
        to: '/tag-analytics',
        title: '标签偏好榜',
        description: '探索标签热度、分布与读者偏好，支持组合比较与榜单浏览。',
        badge: 'Tags',
        icon: defineComponent({
          name: 'TagIcon',
          setup: () => () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2' }, [
            h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z' })
          ])
        })
      },
      {
        to: '/gallery',
        title: '图片画廊',
        description: '浏览缓存插图并回到原始页面，发现站点创作的视觉亮点。',
        badge: 'Gallery',
        icon: defineComponent({
          name: 'GalleryIcon',
          setup: () => () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2' }, [
            h('rect', { x: '3', y: '4', width: '18', height: '16', rx: '2', ry: '2' }),
            h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M8 12l2.5 3 3.5-5 4 6' }),
            h('circle', { cx: '8.5', cy: '8.5', r: '1.5', fill: 'currentColor' })
          ])
        })
      },
      {
        to: '/series-availability',
        title: '编号系列占用/空闲',
        description: '查看各系列使用进度，并合并显示空闲编号区间。',
        badge: 'Series',
        icon: defineComponent({
          name: 'SeriesIcon',
          setup: () => () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2' }, [
            h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M4 7h12' }),
            h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M4 12h16' }),
            h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M4 17h10' })
          ])
        })
      }
    ]
  },
  {
    key: 'events',
    title: '竞赛',
    caption: '了解比赛时间线、规则与参赛作品展示，持续关注创作赛事。',
    items: [
      {
        to: '/newbee2025',
        title: '2025“群雄逐鹿”新秀竞赛',
        description: '查看倒计时、参赛规则以及“2025新秀竞赛”标签下的参赛作品展示。',
        badge: 'Newbee 2025',
        icon: defineComponent({
          name: 'TrophyIcon',
          setup: () => () => h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '2' }, [
            h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M8 21h8' }),
            h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M12 17v4' }),
            h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M7 4h10v2a5 5 0 01-5 5 5 5 0 01-5-5V4z' }),
            h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M5 4h2v2a5 5 0 01-2 4' }),
            h('path', { strokeLinecap: 'round', strokeLinejoin: 'round', d: 'M19 4h-2v2a5 5 0 002 4' })
          ])
        })
      }
    ]
  }
] as const
</script>
