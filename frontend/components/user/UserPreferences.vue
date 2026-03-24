<template>
  <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
    <div class="flex items-center justify-between mb-4">
      <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">偏好一览</h3>
    </div>
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <!-- Favorite Authors with avatar -->
      <div class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-4">
        <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-2">最喜欢的作者</div>
        <div v-if="likerAuthorsPending" class="space-y-2">
          <div v-for="n in 3" :key="`fav-author-skeleton-${n}`" class="h-10 rounded-lg bg-neutral-100 animate-pulse dark:bg-neutral-700/60" />
        </div>
        <div v-else-if="favAuthors && favAuthors.length > 0" class="space-y-2">
          <div v-for="a in favAuthors" :key="`fa-${a.userId}`" class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 min-w-0">
              <UserAvatar :wikidot-id="a.wikidotId" :name="a.displayName || String(a.wikidotId || a.userId)" :size="24" class="ring-1 ring-neutral-200 dark:ring-neutral-800" />
              <NuxtLink :to="`/user/${a.wikidotId}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-[var(--g-accent)] truncate">
                {{ a.displayName || a.wikidotId || a.userId }}
              </NuxtLink>
            </div>
            <div class="text-xs shrink-0 inline-flex items-center gap-1">
              <span class="px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">+{{ a.uv }}</span>
              <span class="px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">-{{ a.dv }}</span>
            </div>
          </div>
        </div>
        <div v-else class="text-xs text-neutral-500 dark:text-neutral-400">暂无数据</div>
        <div class="flex items-center justify-end gap-2 mt-3">
          <button @click="$emit('prev-fav-authors')" :disabled="prefAuthorsOffset===0" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
          <button @click="$emit('next-fav-authors')" :disabled="!hasMoreFavAuthors" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
        </div>
      </div>

      <!-- Fans -->
      <div class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-4">
        <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-2">我的粉丝</div>
        <div v-if="fanAuthorsPending" class="space-y-2">
          <div v-for="n in 3" :key="`fan-author-skeleton-${n}`" class="h-10 rounded-lg bg-neutral-100 animate-pulse dark:bg-neutral-700/60" />
        </div>
        <div v-else-if="fanAuthors && fanAuthors.length > 0" class="space-y-2">
          <div v-for="fan in fanAuthors" :key="`fan-${fan.userId}`" class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-2 min-w-0">
              <UserAvatar :wikidot-id="fan.wikidotId" :name="fan.displayName || String(fan.wikidotId || fan.userId)" :size="24" class="ring-1 ring-neutral-200 dark:ring-neutral-800" />
              <NuxtLink :to="`/user/${fan.wikidotId}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-[var(--g-accent)] truncate">
                {{ fan.displayName || fan.wikidotId || fan.userId }}
              </NuxtLink>
            </div>
            <div class="text-xs shrink-0 inline-flex items-center gap-1">
              <span class="px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">+{{ fan.uv }}</span>
              <span class="px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">-{{ fan.dv }}</span>
            </div>
          </div>
        </div>
        <div v-else class="text-xs text-neutral-500 dark:text-neutral-400">暂无数据</div>
        <div class="flex items-center justify-end gap-2 mt-3">
          <button @click="$emit('prev-fan-authors')" :disabled="prefFansOffset===0" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
          <button @click="$emit('next-fan-authors')" :disabled="!hasMoreFanAuthors" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
        </div>
      </div>

      <!-- Favorite Tags -->
      <div class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-4">
        <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-2">最喜欢的标签</div>
        <div v-if="likerTagsPending" class="space-y-2">
          <div v-for="n in 4" :key="`fav-tag-skeleton-${n}`" class="h-8 rounded-lg bg-neutral-100 animate-pulse dark:bg-neutral-700/60" />
        </div>
        <div v-else-if="favTags && favTags.length > 0" class="space-y-2">
          <div v-for="t in favTags" :key="`ft-${t.tag}`" class="flex items-center justify-between">
            <NuxtLink :to="`/search?tags=${encodeURIComponent(t.tag)}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-[var(--g-accent)] truncate">
              #{{ t.tag }}
            </NuxtLink>
            <div class="text-xs shrink-0 inline-flex items-center gap-1">
              <span class="px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">+{{ t.uv }}</span>
              <span class="px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">-{{ t.dv }}</span>
            </div>
          </div>
        </div>
        <div v-else class="text-xs text-neutral-500 dark:text-neutral-400">暂无数据</div>
        <div class="flex items-center justify-end gap-2 mt-3">
          <button @click="$emit('prev-fav-tags')" :disabled="prefFavTagsOffset===0" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
          <button @click="$emit('next-fav-tags')" :disabled="!hasMoreFavTags" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
        </div>
      </div>

      <!-- Most Hated Tags -->
      <div class="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-4">
        <div class="text-xs text-neutral-600 dark:text-neutral-400 mb-2">最讨厌的标签</div>
        <div v-if="haterTagsPending" class="space-y-2">
          <div v-for="n in 4" :key="`hate-tag-skeleton-${n}`" class="h-8 rounded-lg bg-neutral-100 animate-pulse dark:bg-neutral-700/60" />
        </div>
        <div v-else-if="hateTags && hateTags.length > 0" class="space-y-2">
          <div v-for="t in hateTags" :key="`ht-${t.tag}`" class="flex items-center justify-between">
            <NuxtLink :to="`/search?excludeTags=${encodeURIComponent(t.tag)}`" class="text-sm font-medium text-neutral-900 dark:text-neutral-100 hover:text-[var(--g-accent)] truncate">
              #{{ t.tag }}
            </NuxtLink>
            <div class="text-xs shrink-0 inline-flex items-center gap-1">
              <span class="px-2 py-0.5 rounded bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400">-{{ t.dv }}</span>
              <span class="px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">+{{ t.uv }}</span>
            </div>
          </div>
        </div>
        <div v-else class="text-xs text-neutral-500 dark:text-neutral-400">暂无数据</div>
        <div class="flex items-center justify-end gap-2 mt-3">
          <button @click="$emit('prev-hate-tags')" :disabled="prefHateTagsOffset===0" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
          <button @click="$emit('next-hate-tags')" :disabled="!hasMoreHateTags" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  // Authors
  favAuthors: any[]
  fanAuthors: any[]
  likerAuthorsPending: boolean
  fanAuthorsPending: boolean
  hasMoreFavAuthors: boolean
  hasMoreFanAuthors: boolean
  prefAuthorsOffset: number
  prefFansOffset: number
  // Tags
  favTags: Array<{ tag: string; uv: number; dv: number }>
  hateTags: Array<{ tag: string; uv: number; dv: number }>
  likerTagsPending: boolean
  haterTagsPending: boolean
  hasMoreFavTags: boolean
  hasMoreHateTags: boolean
  prefFavTagsOffset: number
  prefHateTagsOffset: number
}>()

defineEmits<{
  'prev-fav-authors': []
  'next-fav-authors': []
  'prev-fan-authors': []
  'next-fan-authors': []
  'prev-fav-tags': []
  'next-fav-tags': []
  'prev-hate-tags': []
  'next-hate-tags': []
}>()
</script>
