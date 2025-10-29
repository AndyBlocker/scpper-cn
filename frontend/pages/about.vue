<template>
  <div class="space-y-8">
    <section>
      <div class="flex items-center justify-between border-b-2 border-[rgba(var(--accent),0.18)] dark:border-[rgba(var(--accent),0.24)] pb-3 mb-4">
        <div class="flex items-center gap-3">
          <div class="h-8 w-1 bg-[rgb(var(--accent))] rounded" />
          <h1 class="text-lg font-bold text-neutral-800 dark:text-neutral-100">关于 SCPPER-CN</h1>
        </div>
      </div>
      <div class="grid grid-cols-1 gap-4">
        <!-- 简介 -->
        <div class="rounded-lg p-5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800">
          <p class="text-sm leading-6 text-neutral-700 dark:text-neutral-300">
            SCPPER-CN是基于CROM提供的数据数据制作的，SCP基金会中文维基数据分析网站。
          </p>
        </div>

        <!-- 版权信息 -->
        <div class="rounded-lg p-5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800">
          <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-100">版权信息</h2>
          <p class="text-sm leading-6 text-neutral-700 dark:text-neutral-300 mt-3">
            网站数据、文章内容来源于
            <a href="https://crom.avn.sh/" target="_blank" rel="noopener noreferrer" class="underline hover:text-[rgb(var(--accent))]">CROM</a>
            从
            <a href="https://scp-wiki-cn.wikidot.com/" target="_blank" rel="noopener noreferrer" class="underline hover:text-[rgb(var(--accent))]">SCP基金会中文维基</a>
            爬取的数据。用户头像数据来源于 Wikidot。若无特殊说明，以上数据遵循
            <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener noreferrer" class="underline hover:text-[rgb(var(--accent))]">CC-BY-SA 3.0</a>
            授权协议。
          </p>
          <p class="mt-3 text-sm leading-6 text-neutral-700 dark:text-neutral-300">
            网站图标由
            <UserCard class="inline-flex align-[-0.5ex] mr-2 h-6" size="S" :wikidot-id="3471238" :display-name="'breaddddd'" bare />
            创作，遵循
            <a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener noreferrer" class="underline hover:text-[rgb(var(--accent))]">CC-BY-SA 3.0</a>
            授权协议。
          </p>
        </div>

        <!-- 作者的话 -->
        <div class="rounded-lg p-5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800">
          <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-100">作者的话</h2>

          <p class="mt-3 text-sm leading-6 text-neutral-700 dark:text-neutral-300">
            <UserCard class="inline-flex align-[-0.5ex] mr-2 h-6" size="S" :wikidot-id="3471238" :display-name="'breaddddd'" bare/>
            ：面！
          </p>
        </div>


        <!-- 赞助者的话-->
        <div class="rounded-lg p-5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800">
          <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-100">赞助者的话</h2>
          <!-- Small UserCard + 一句话-->
          <p class="text-sm leading-6 text-neutral-700 dark:text-neutral-300">
            <UserCard class="inline-flex align-[-0.5ex] mr-2 h-6" size="S" :wikidot-id="8584266" :display-name="'DVA24'" bare />
            ：加个赞助者就行了，没必要写太多。 -- 2025.9.17 
          </p>
          <p class="text-sm leading-6 text-neutral-700 dark:text-neutral-300">
            <UserCard class="inline-flex align-[-0.5ex] mr-2 h-6" size="S" :wikidot-id="6513052" :display-name="'14#7_MonochromeMix'" bare />
            ：来玩《Ghostpia》吧！ -- 2025.10.24
          </p>
          <p class="text-sm leading-6 text-neutral-700 dark:text-neutral-300 mt-3">
            感谢以上赞助者对网站的支持！
          </p>

        </div>

        <!-- 正在计划的功能 -->
        <div class="rounded-lg p-5 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800">
          <h2 class="text-base font-semibold text-neutral-800 dark:text-neutral-100">正在计划的功能</h2>
          <ul class="mt-3 space-y-2">
            <!-- done -->
            <li class="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <LucideIcon name="Check" class="w-4 h-4 text-[rgb(var(--accent))]" />
              分数走势
            </li>
            <li class="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <LucideIcon name="Check" class="w-4 h-4 text-[rgb(var(--accent))]" />
              User&amp;Page Search
            </li>
            <li class="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <LucideIcon name="Check" class="w-4 h-4 text-[rgb(var(--accent))]" />
              Ranking Category
            </li>
            <li class="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <LucideIcon name="Check" class="w-4 h-4 text-[rgb(var(--accent))]" />
              用户头像获取与缓存
            </li>

            <!-- todo -->
            <li class="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <LucideIcon name="Check" class="w-4 h-4 text-[rgb(var(--accent))]" />
              SCP作品Alternative Title展示
            </li>
            <li class="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <LucideIcon name="Check" class="w-4 h-4 text-neutral-400" />
              页面引用关系解析
            </li>
            <li class="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <LucideIcon name="Check" class="w-4 h-4 text-neutral-400" />
              用户投票关系展示
            </li>
            <li class="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <LucideIcon name="CircleDashed" class="w-4 h-4 text-neutral-400" />
              基于已有数据的删号用户处理
            </li>
            <li class="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <LucideIcon name="Check" class="w-4 h-4 text-neutral-400" />
              图片资源获取
            </li>
            <li class="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <LucideIcon name="CircleDashed" class="w-4 h-4 text-neutral-400" />
              全文语义搜索
            </li>
            <li class="flex items-center gap-2 text-sm text-neutral-700 dark:text-neutral-300">
              <LucideIcon name="CircleDashed" class="w-4 h-4 text-neutral-400" />
              活跃竞赛页展示
            </li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { useHead } from 'nuxt/app'

useHead({
  title: '关于 - SCPPER-CN',
  meta: [
    { name: 'description', content: '关于 SCPPER-CN 数据分析平台与项目说明。' }
  ]
})
</script>

