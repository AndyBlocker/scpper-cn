<!-- pages/page/[wikidotId].vue -->
<template>
  <div>
    <!-- Loading -->
    <div v-if="pagePending" class="p-10 text-center">
      <div class="inline-flex items-center gap-2">
        <svg class="w-5 h-5 animate-spin text-[rgb(var(--accent))]" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
        <span class="text-neutral-600 dark:text-neutral-400">加载中…</span>
      </div>
    </div>

    <!-- Error -->
    <div v-else-if="pageError" class="p-10 text-center text-red-600 dark:text-red-400">
      加载失败：{{ pageError.message }}
    </div>

    <!-- Content -->
    <div v-else class="space-y-6">
      <!-- Title + Actions -->
      <header class="flex items-start justify-between gap-3 relative">
        <h1 class="text-[22px] leading-snug font-bold text-neutral-900 dark:text-neutral-100">
          {{ page?.title || 'Untitled' }}
        </h1>
        <div class="flex items-center gap-2 shrink-0">
          <button
            v-if="page?.wikidotId"
            @click="copyId"
            :title="copiedId ? '已复制' : '复制'"
            class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 border border-neutral-200 dark:border-neutral-700"
          >
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
            </svg>
            ID {{ page?.wikidotId }}
          </button>

          <span v-if="page?.isDeleted" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100/90 dark:bg-red-900/40 text-red-700 dark:text-red-300 border border-red-200/80 dark:border-red-800">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"/>
            </svg>
            <span>已删除</span>
            <span v-if="deletedDate" class="text-[11px] opacity-80">· {{ deletedDate }}</span>
          </span>

          <a v-if="page?.url"
             :href="page.url" target="_blank" rel="noopener"
             class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 border border-neutral-200 dark:border-neutral-700">
            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M18 13v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
              <polyline points="15 3 21 3 21 9"/>
              <line x1="10" y1="14" x2="21" y2="3"/>
            </svg>
            源页面
          </a>
        </div>
      </header>

      <!-- Meta line -->
      <section class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-5 text-neutral-600 dark:text-neutral-400">
        <div v-if="groupedAttributions && groupedAttributions.length > 0" class="inline-flex items-center gap-2">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M20 21v-2a4 4 0 0 0-3-3.87"/><path d="M4 21v-2a4 4 0 0 1 3-3.87"/><circle cx="12" cy="7" r="4"/>
          </svg>
          <div class="flex flex-wrap gap-2 items-center">
            <template v-for="attr in groupedAttributions" :key="attr.type">
              <template v-for="(person, idx) in attr.users" :key="`p-${attr.type}-${idx}`">
                <UserCard
                  size="sm"
                  :wikidot-id="(person?.userWikidotId ?? 0)"
                  :display-name="person?.displayName || '(account deleted)'"
                  :to="person?.userWikidotId ? `/user/${person.userWikidotId}` : null"
                  :avatar="true"
                />
              </template>
            </template>
          </div>
        </div>

        <div class="inline-flex items-center gap-1">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          <span>{{ createdDate ? formatDate(createdDate) : 'N/A' }}</span>
        </div>

        <div class="inline-flex items-center gap-1">
          <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M3 4h18"/><path d="M8 2v4"/><path d="M16 2v4"/><rect x="3" y="8" width="18" height="12" rx="2"/>
          </svg>
          <span>修订 {{ page?.revisionCount || 0 }}</span>
        </div>

        <div class="inline-flex items-center gap-2 flex-wrap">
          <template v-for="t in allTags" :key="t">
            <NuxtLink :to="`/search?tags=${encodeURIComponent(t)}`"
                      class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-800/40 transition-colors"
                      :title="`查看包含「${t}」标签的所有页面`">#{{ t }}</NuxtLink>
          </template>
        </div>
      </section>

      <!-- Metrics (4 cards) -->
      <section class="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <!-- 评分 -->
        <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 bg-white dark:bg-neutral-900 shadow-sm">
          <div class="flex items-start justify-between">
            <div class="text-[12px] text-neutral-600 dark:text-neutral-400">评分</div>
            <div class="text-lg font-bold text-neutral-900 dark:text-neutral-100" :title="ratingTooltip">
              {{ Number(page?.rating ?? 0).toFixed(0) }}
            </div>
          </div>
          <div class="mt-2 grid grid-cols-2 text-[11px]">
            <div class="text-green-600 dark:text-green-400">↑ {{ upvotes }}</div>
            <div class="text-red-600 dark:text-red-400 text-right">↓ {{ downvotes }}</div>
          </div>
          <div class="mt-2 h-1.5 w-full rounded bg-neutral-200 dark:bg-neutral-800 overflow-hidden flex">
            <div class="h-full bg-[rgb(var(--accent))]" :style="{ width: upvotePct + '%' }" aria-hidden="true"></div>
            <div class="h-full bg-red-500" :style="{ width: downvotePct + '%' }" aria-hidden="true"></div>
          </div>
        </div>

        <!-- 支持率 -->
        <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 bg-white dark:bg-neutral-900 shadow-sm">
          <div class="flex items-start justify-between">
            <div class="text-[12px] text-neutral-600 dark:text-neutral-400">支持率</div>
            <div class="text-lg font-bold text-neutral-900 dark:text-neutral-100" :title="voteTooltip">
              {{ likeRatioPct.toFixed(0) }}%
            </div>
          </div>
          <div class="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">总票数 {{ totalVotes }}</div>
          <div class="mt-2 h-1.5 w-full rounded bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
            <div class="h-full bg-[rgb(var(--accent))]" :style="{ width: likeRatioPct + '%' }" aria-hidden="true"></div>
          </div>
        </div>

        <!-- Wilson95 下界 -->
        <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 bg-white dark:bg-neutral-900 shadow-sm">
          <div class="flex items-start justify-between">
            <div class="text-[12px] text-neutral-600 dark:text-neutral-400">Wilson 95% 下界</div>
            <div class="text-lg font-bold text-neutral-900 dark:text-neutral-100" :title="wilsonTooltip">
              {{ (wilsonLB * 100).toFixed(1) }}%
            </div>
          </div>
          <div class="mt-2 text-[11px] text-neutral-500 dark:text-neutral-400">
            在相同票数下更稳健的支持率估计
          </div>
          <div class="mt-2 h-1.5 w-full rounded bg-neutral-200 dark:bg-neutral-800 overflow-hidden">
            <div class="h-full bg-[rgb(var(--accent))]" :style="{ width: Math.max(0, Math.min(100, wilsonLB * 100)) + '%' }" aria-hidden="true"></div>
          </div>
        </div>

        <!-- 争议指数 -->
        <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 bg-white dark:bg-neutral-900 shadow-sm">
          <div class="flex items-start justify-between">
            <div class="text-[12px] text-neutral-600 dark:text-neutral-400">争议指数</div>
            <div class="text-lg font-bold text-neutral-900 dark:text-neutral-100">
              {{ controversyIdx.toFixed(3) }}
            </div>
          </div>
        </div>
      </section>


      <!-- Chart -->
      <section v-if="Array.isArray(ratingHistory) && ratingHistory.length" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">评分趋势</h3>
          <span class="text-xs text-neutral-500 dark:text-neutral-500">按周聚合</span>
        </div>
        <ClientOnly>
          <RatingHistoryChart
            :data="ratingHistory"
            :first-activity-date="firstRev && firstRev[0] ? firstRev[0].timestamp : ''"
            :allow-page-markers="false"
            :debug="Boolean(route?.query?.debugChart)"
          />
          <template #fallback>
            <div class="h-64 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
              加载图表中...
            </div>
          </template>
        </ClientOnly>
      </section>

      <!-- Revisions -->
      <section id="revisions" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 bg-white dark:bg-neutral-900 shadow-sm min-h-[280px] flex flex-col">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">最近修订</h3>
            <div class="text-xs text-neutral-500 dark:text-neutral-400">{{ (revPage + 1) }} / {{ revTotalPages }}</div>
          </div>

          <div v-if="!revisionsPaged || revisionsPaged.length === 0" class="flex-1 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
            暂无修订记录
          </div>

          <div v-else class="flex-1">
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              <div
                v-for="rev in revisionsPaged"
                :key="rev.revisionId || rev.wikidotId"
                class="p-2 rounded border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-neutral-800"
              >
                <div class="flex items-center justify-between gap-3">
                  <div class="flex items-center gap-2 min-w-0">
                    <span :class="['inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium shrink-0 w-[120px] justify-center', revisionTypeClass(rev.type)]">
                      {{ formatRevisionType(rev.type) }}
                    </span>
                    <div class="min-w-0">
                      <UserCard
                        size="sm"
                        :wikidot-id="rev.userWikidotId || null"
                        :display-name="rev.userDisplayName || '(account deleted)'"
                        :to="rev.userWikidotId ? `/user/${rev.userWikidotId}` : null"
                        :avatar="true"
                      />
                    </div>
                  </div>
                  <div class="text-xs text-neutral-500 dark:text-neutral-400 whitespace-nowrap shrink-0">{{ formatRelativeTime(rev.timestamp) }}</div>
                </div>
                <div v-if="rev.comment" class="text-xs text-neutral-600 dark:text-neutral-400 mt-1 break-words overflow-hidden" style="display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;">{{ rev.comment }}</div>
              </div>
            </div>

          </div>
          <div v-if="revisionsPaged && revisionsPaged.length > 0" class="mt-3">
            <div class="flex items-center justify-between">
              <button @click="prevRevPage" :disabled="revPage === 0"
                      class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
              <div class="flex items-center gap-1">
                <button
                  v-for="n in revPageNumbers"
                  :key="`rp-${n}`"
                  @click="goRevPage(n)"
                  :class="['text-xs px-2 py-1 rounded border', (revPage + 1 === n) ? 'bg-neutral-200 dark:bg-neutral-700 border-neutral-300 dark:border-neutral-700' : 'bg-neutral-100 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-800']"
                >{{ n }}</button>
              </div>
              <button @click="nextRevPage" :disabled="!hasMoreRevisions"
                      class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
            </div>
          </div>

          
      </section>

      <!-- Recent Votes -->
      <section class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 bg-white dark:bg-neutral-900 shadow-sm min-h-[280px] flex flex-col">
          <div class="flex items-center justify-between mb-4">
            <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">最近投票</h3>
            <div class="text-xs text-neutral-500 dark:text-neutral-400">{{ currentVotePage }} / {{ voteTotalPages }}</div>
          </div>

          <div v-if="!recentVotes || recentVotes.length === 0" class="flex-1 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
            暂无投票
          </div>

          <div v-else class="flex-1">
            <div class="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-2">
              <div
                v-for="v in recentVotes"
                :key="`${v.timestamp}-${v.userId || v.userWikidotId}`"
                :class="[
                  'p-2 rounded',
                  v.direction > 0 ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/40' :
                  v.direction < 0 ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/40' :
                  'bg-neutral-50 dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-800'
                ]"
              >
                <div class="flex items-center gap-2">
                  <div class="min-w-0 flex-1">
                    <UserCard
                      size="sm"
                      :wikidot-id="v.userWikidotId || null"
                      :display-name="v.userDisplayName || '(account deleted)'"
                      :to="v.userWikidotId ? `/user/${v.userWikidotId}` : null"
                      :avatar="true"
                    />
                  </div>
                  <div class="text-[11px] text-neutral-600 dark:text-neutral-400 whitespace-nowrap shrink-0 tabular-nums">{{ formatDateCompact(v.timestamp) }}</div>
                </div>
              </div>
            </div>

          </div>
          <div v-if="recentVotes && recentVotes.length > 0" class="mt-3">
            <div class="flex items-center justify-between">
              <button @click="prevVotePage" :disabled="voteOffset === 0" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
              <div class="flex items-center gap-1">
                <button
                  v-for="n in votePageNumbers"
                  :key="`vp-${n}`"
                  @click="goVotePage(n)"
                  :class="['text-xs px-2 py-1 rounded border', (currentVotePage === n) ? 'bg-neutral-200 dark:bg-neutral-700 border-neutral-300 dark:border-neutral-700' : 'bg-neutral-100 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-800']"
                >{{ n }}</button>
              </div>
              <button @click="nextVotePage" :disabled="!hasMoreVotes" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
            </div>
          </div>

          
      </section>

      

      <!-- Related Pages (Recommendations) -->
      <section class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
        <div class="flex items-center justify-between mb-4">
          <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">相关页面</h3>
        </div>
        <div v-if="relatedPending" class="grid grid-cols-3 gap-3">
          <div v-for="i in 3" :key="`skeleton-${i}`" class="rounded-lg border border-neutral-200 dark:border-neutral-800 p-4 bg-neutral-50 dark:bg-neutral-900/60 animate-pulse">
            <div class="h-4 w-3/4 bg-neutral-200 dark:bg-neutral-800 rounded mb-3"></div>
            <div class="flex gap-2 mb-3">
              <div class="h-3 w-16 bg-neutral-200 dark:bg-neutral-800 rounded"></div>
              <div class="h-3 w-12 bg-neutral-200 dark:bg-neutral-800 rounded"></div>
              <div class="h-3 w-10 bg-neutral-200 dark:bg-neutral-800 rounded"></div>
            </div>
            <div class="h-20 w-full bg-neutral-200/70 dark:bg-neutral-800/70 rounded"></div>
          </div>
        </div>
        <div v-else-if="relatedPages && relatedPages.length > 0" class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <PageCard
            v-for="rp in relatedPages.slice(0, 3)"
            :key="rp.wikidotId"
            size="md"
            :to="`/page/${rp.wikidotId}`"
            :wikidot-id="rp.wikidotId"
            :title="rp.title"
            :tags="Array.isArray(rp.tags) ? rp.tags : []"
            :rating="Number(rp.rating ?? 0)"
            :comments="Number(rp.commentCount ?? rp.revisionCount ?? 0)"
            :wilson95="typeof rp.wilson95 === 'number' ? rp.wilson95 : undefined"
            :controversy="typeof rp.controversy === 'number' ? rp.controversy : 0"
            :date-iso="rp.createdAt || ''"
            :authors="Array.isArray((rp as any).authors_full) ? (rp as any).authors_full.map((a:any) => ({ name: a?.displayName || '', url: a?.wikidotId ? `/user/${a.wikidotId}` : undefined })) : []"
          />
        </div>
        <div v-else class="text-center py-4 text-neutral-500 dark:text-neutral-400">
          暂无推荐
        </div>
      </section>

      <!-- Source Viewer -->
      <section class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-2">
          <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">页面源码</h3>
          <div class="flex flex-wrap items-center gap-3">
            <button @click="toggleDiffMode"
                    class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700">
              {{ diffMode ? '退出对比' : '对比版本' }}
            </button>

            <div v-if="!diffMode" class="flex items-center gap-2">
              <label class="text-xs text-neutral-500 dark:text-neutral-400">页面版本:</label>
              <select v-model="selectedVersion" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">
                <option v-for="v in pageVersions" :key="v.pageVersionId" :value="v.pageVersionId">
                  {{ v.validTo ? '历史' : '当前' }} · {{ formatDate(v.createdAt) }} · {{ v.title || '' }}
                </option>
              </select>
            </div>

            <div v-else class="flex items-center gap-2 flex-wrap">
              <div class="flex items-center gap-1">
                <label class="text-xs text-neutral-500 dark:text-neutral-400">基准:</label>
                <select v-model="baseVersionId" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">
                  <option v-for="v in orderedVersions" :key="`b-${v.pageVersionId}`" :value="v.pageVersionId">
                    {{ v.validTo ? '历史' : '当前' }} · {{ formatDate(v.createdAt) }} · {{ v.title || '' }}
                  </option>
                </select>
              </div>
              <div class="flex items-center gap-1">
                <label class="text-xs text-neutral-500 dark:text-neutral-400">对比:</label>
                <select v-model="compareVersionId" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">
                  <option v-for="v in orderedVersions" :key="`c-${v.pageVersionId}`" :value="v.pageVersionId">
                    {{ v.validTo ? '历史' : '当前' }} · {{ formatDate(v.createdAt) }} · {{ v.title || '' }}
                  </option>
                </select>
              </div>
              <label class="inline-flex items-center gap-1 text-xs text-neutral-500 dark:text-neutral-400">
                <input type="checkbox" v-model="ignoreWhitespace" class="rounded">
                忽略空白
              </label>
              <button @click="runDiff"
                      class="text-xs px-2 py-1 rounded bg-[rgba(var(--accent),0.12)] dark:bg-[rgba(var(--accent),0.22)] text-[rgb(var(--accent))] hover:bg-[rgba(var(--accent),0.18)]">
                生成对比
              </button>
            </div>

            <div class="flex items-center gap-2">
              <button @click="copySource" :disabled="diffMode" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-50">
                复制源码
              </button>
              <button @click="downloadSource" :disabled="diffMode" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 hover:bg-neutral-200 dark:hover:bg-neutral-700 disabled:opacity-50">
                下载源码
              </button>
            </div>
          </div>
        </div>

        <div v-if="!diffMode" class="border border-neutral-200 dark:border-neutral-700 rounded bg-neutral-50 dark:bg-neutral-800 p-3 max-h-96 overflow-auto text-xs whitespace-pre-wrap font-mono"
             aria-label="页面源码内容">
          {{ displayedSource }}
        </div>
        <div v-else class="border border-neutral-200 dark:border-neutral-700 rounded bg-neutral-50 dark:bg-neutral-800 p-3 max-h-96 overflow-auto text-xs font-mono">
          <div v-if="diffLoading" class="text-neutral-500 dark:text-neutral-400">计算对比中…</div>
          <div v-else-if="diffError" class="text-red-600 dark:text-red-400">{{ diffError }}</div>
          <div v-else-if="!diffParts || diffParts.length === 0" class="text-neutral-500 dark:text-neutral-400">尚未生成对比</div>
          <div v-else class="space-y-0">
            <div v-for="(part, idx) in diffParts" :key="idx"
                 :class="[
                   'whitespace-pre-wrap',
                   part.added ? 'bg-[rgba(var(--accent),0.12)] dark:bg-[rgba(var(--accent),0.22)] text-[rgb(var(--accent))]' :
                   part.removed ? 'bg-red-100/60 dark:bg-red-900/30 text-red-800 dark:text-red-300' :
                   'text-neutral-800 dark:text-neutral-200'
                 ]">
              <span class="select-none text-[10px] mr-1"
                    :class="part.added ? 'text-[rgb(var(--accent))]' : part.removed ? 'text-red-600' : 'text-transparent'">
                {{ part.added ? '+' : part.removed ? '-' : '·' }}
              </span>{{ part.value }}
            </div>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { onBeforeRouteUpdate } from 'vue-router'

// Nuxt auto imports for type checker
declare const useAsyncData: any
declare const useNuxtApp: any
declare const useRoute: any
declare const definePageMeta: any
declare const process: any

const route = useRoute();
const {$bff} = useNuxtApp();

definePageMeta({ key: (route:any) => route.fullPath })

if (process.dev) {
  onBeforeRouteUpdate((to:any, from:any) => {
    console.log('页面路由更新:', { to: to.fullPath, from: from.fullPath })
  });
}

const wikidotId = computed(() => route.params.wikidotId as string)

// ===== Fetches =====
const { data: page, pending: pagePending, error: pageError } = await useAsyncData(
  () => `page-${wikidotId.value}`,
  () => $bff(`/pages/by-id`, { params: { wikidotId: wikidotId.value } }),
  { watch: [() => route.params.wikidotId] }
)

const { data: stats } = await useAsyncData(
  () => `stats-${wikidotId.value}`,
  () => $bff(`/stats/pages/${wikidotId.value}`),
  { watch: [() => route.params.wikidotId] }
)

// rating history moved below after firstRev to decide dynamic granularity

const pageSize = ref(3)
const revPage = ref(0)
const { data: revisionsPaged } = await useAsyncData(
  () => `revs-${wikidotId.value}-${revPage.value}-${pageSize.value}`,
  () => $bff(`/pages/${wikidotId.value}/revisions`, { params: { limit: pageSize.value, offset: revPage.value * pageSize.value, order: 'DESC' } }),
  { watch: [() => route.params.wikidotId, () => revPage.value, () => pageSize.value] }
)
const hasMoreRevisions = computed(() => Array.isArray(revisionsPaged.value) && revisionsPaged.value.length === pageSize.value)
function nextRevPage(){ if (hasMoreRevisions.value) revPage.value += 1 }
function prevRevPage(){ if (revPage.value > 0) revPage.value -= 1 }
const revTotalPages = computed(() => {
  const total = Number(page.value?.revisionCount || 0)
  if (!total || !pageSize.value) return 1
  return Math.max(1, Math.ceil(total / pageSize.value))
})
const deletedDate = computed(() => {
  const raw = page.value?.deletedAt
  if (!raw) return ''
  const d = new Date(raw)
  return isNaN(d.getTime()) ? '' : d.toISOString().slice(0,10)
})
const revPageNumbers = computed(() => [1,2,3,4].filter(n => n <= revTotalPages.value))
function goRevPage(n:number){
  const idx = Math.max(1, Math.min(revTotalPages.value, n)) - 1
  revPage.value = idx
}

const { data: firstRev } = await useAsyncData(
  () => `firstrev-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/revisions`, { params: { limit: 1, offset: 0, order: 'ASC', type: 'PAGE_CREATED' } }),
  { watch: [() => route.params.wikidotId] }
)

// Dynamic granularity for rating history: day <= ~90d, week <= ~3y, else month
const ratingGranularity = computed(() => {
  const first = firstRev.value && firstRev.value[0] && firstRev.value[0].timestamp
  const last = page.value?.updatedAt || page.value?.createdAt || ''
  const t0 = first ? new Date(first).getTime() : undefined
  const t1 = last ? new Date(last).getTime() : undefined
  if (t0 && t1 && t1 > t0) {
    const days = (t1 - t0) / 86400000
    if (days <= 90) return 'day'
    // Cap at week even for longer spans
    return 'week'
  }
  // Default to week rather than month
  return 'week'
})

const { data: ratingHistory } = await useAsyncData(
  () => `page-rating-history-${wikidotId.value}-${ratingGranularity.value}`,
  () => $bff(`/pages/${wikidotId.value}/rating-history`, { params: { granularity: ratingGranularity.value } }),
  { watch: [() => route.params.wikidotId, () => ratingGranularity.value] }
)

const { data: attributions } = await useAsyncData(
  () => `attributions-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/attributions`),
  { watch: [() => route.params.wikidotId] }
)

// removed revision list for source selection

const { data: voteDistribution } = await useAsyncData(
  () => `vote-dist-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/vote-distribution`),
  { watch: [() => route.params.wikidotId] }
)

// removed related-records fetch

// Recommendations (related pages) - 非阻塞加载
const { data: relatedPages, pending: relatedPending } = useAsyncData(
  () => `related-pages-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/recommendations`, { params: { limit: 6, strategy: 'both', diversity: 'simple' } }),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

const votePageSize = ref(10)

// Responsive page sizes: 3-5 for revisions, votes sized to whole rows to avoid partial pages
function recalcPageSizes() {
  const w = window.innerWidth || 0
  // determine columns used in votes grid
  const voteCols = w >= 1536 ? 5 : w >= 1280 ? 4 : w >= 1024 ? 3 : w >= 768 ? 2 : w >= 640 ? 2 : 2
  const revCols = w >= 1024 ? 3 : w >= 640 ? 2 : 1

  // When fewer columns, increase rows to show more vertical content (mobile-friendly)
  const revRows = revCols <= 1 ? 7 : revCols === 2 ? 5 : 4
  pageSize.value = Math.max(1, revCols * revRows)

  const voteRows = voteCols <= 2 ? 10 : voteCols === 3 ? 8 : voteCols === 4 ? 7 : 6
  votePageSize.value = Math.max(voteCols, voteCols * voteRows)
  // reset paginations when size changes
  revPage.value = 0
  voteOffset.value = 0
}
const voteOffset = ref(0)
const { data: recentVotes } = await useAsyncData(
  () => `page-votes-${wikidotId.value}-${voteOffset.value}-${votePageSize.value}`,
  () => $bff(`/pages/${wikidotId.value}/votes/fuzzy`, { params: { limit: votePageSize.value, offset: voteOffset.value } }),
  { watch: [() => route.params.wikidotId, () => voteOffset.value, () => votePageSize.value] }
)
const hasMoreVotes = computed(() => Array.isArray(recentVotes.value) && recentVotes.value.length === votePageSize.value)
const currentVotePage = computed(() => (voteOffset.value / votePageSize.value) + 1)
const voteTotalPages = computed(() => {
  const total = Number(totalVotes.value)
  if (!total || !votePageSize.value) return 1
  return Math.max(1, Math.ceil(total / votePageSize.value))
})
const votePageNumbers = computed(() => [1,2,3,4].filter(n => n <= voteTotalPages.value))
function goVotePage(n:number){
  const idx = Math.max(1, Math.min(voteTotalPages.value, n)) - 1
  voteOffset.value = idx * votePageSize.value
}
function nextVotePage(){ if (hasMoreVotes.value) voteOffset.value += votePageSize.value }
function prevVotePage(){ voteOffset.value = Math.max(0, voteOffset.value - votePageSize.value) }

const selectedVersion = ref<number | null>(null)
// removed revision selection; only page version is used
const { data: latestSourceResp } = await useAsyncData(
  () => `page-latest-source-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/source`),
  { watch: [() => route.params.wikidotId] }
)
const latestSource = computed(() => {
  const s = latestSourceResp.value as any
  if (!s) return null
  return s.source || null
})

watch(selectedVersion, async (ver) => {
  if (ver == null) return
  try {
    const resp = await $bff(`/pages/${wikidotId.value}/versions/${ver}/source`)
    ;(latestSourceResp as any).value = { source: resp?.source ?? null }
  } catch {
    ;(latestSourceResp as any).value = { source: null }
  }
})

const displayedSource = computed(() => latestSource.value ?? '暂无源码')

const { data: pageVersions } = await useAsyncData(
  () => `page-versions-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/versions`, { params: { includeSource: false, limit: 100 } }),
  { watch: [() => route.params.wikidotId] }
)
watch(pageVersions, (list:any[]) => {
  if (Array.isArray(list) && list.length > 0) {
    const current = list.find((v:any) => !v.validTo)
    selectedVersion.value = (current || list[0]).pageVersionId
  } else {
    selectedVersion.value = null
  }
}, { immediate: true })

// ===== Diff mode state =====
const diffMode = ref(false)
const baseVersionId = ref<number | null>(null)
const compareVersionId = ref<number | null>(null)
const ignoreWhitespace = ref(true)
const diffLoading = ref(false)
const diffError = ref<string | null>(null)
const diffParts = ref<Array<{ value: string; added?: boolean; removed?: boolean }>>([])

const orderedVersions = computed<any[]>(() => {
  const list = Array.isArray(pageVersions.value) ? [...(pageVersions.value as any[])] : []
  return list.sort((a:any, b:any) => {
    const ta = new Date(a?.createdAt || 0).getTime()
    const tb = new Date(b?.createdAt || 0).getTime()
    return ta - tb // old -> new
  })
})

function resetDiffResults(){
  diffError.value = null
  diffParts.value = []
}

function toggleDiffMode(){
  diffMode.value = !diffMode.value
  if (diffMode.value) {
    // entering diff: preselect sensible defaults (previous vs current)
    const list = orderedVersions.value
    if (list.length === 0) {
      baseVersionId.value = null
      compareVersionId.value = null
    } else {
      const currentId = selectedVersion.value
      const idx = currentId != null ? list.findIndex((v:any) => v.pageVersionId === currentId) : list.length - 1
      const prevIdx = Math.max(0, Math.min(list.length - 1, idx - 1))
      const nextIdx = Math.max(0, Math.min(list.length - 1, idx))
      baseVersionId.value = list[prevIdx]?.pageVersionId ?? null
      compareVersionId.value = list[nextIdx]?.pageVersionId ?? null
    }
    resetDiffResults()
  } else {
    // leaving diff
    resetDiffResults()
  }
}

// Cache fetched version sources to avoid repeated network calls
const versionSourceCache = new Map<number, string | null>()

async function getSourceForVersion(verId: number): Promise<string> {
  if (versionSourceCache.has(verId)) {
    return String(versionSourceCache.get(verId) || '')
  }
  const resp = await $bff(`/pages/${wikidotId.value}/versions/${verId}/source`)
  const text = (resp && typeof resp.source === 'string') ? resp.source : ''
  versionSourceCache.set(verId, text)
  return text
}

async function runDiff(){
  if (!diffMode.value) return
  if (baseVersionId.value == null || compareVersionId.value == null) {
    diffError.value = '请选择两个版本后再生成对比'
    return
  }
  diffLoading.value = true
  diffError.value = null
  diffParts.value = []
  try {
    const [baseText, compareText] = await Promise.all([
      getSourceForVersion(Number(baseVersionId.value)),
      getSourceForVersion(Number(compareVersionId.value))
    ])
    const diffLib: any = await import('diff')
    const parts = (diffLib?.diffLines || diffLib?.default?.diffLines)?.call(diffLib, String(baseText), String(compareText), {
      ignoreWhitespace: !!ignoreWhitespace.value
    }) || []
    diffParts.value = Array.isArray(parts) ? parts : []
  } catch (e:any) {
    diffError.value = '对比失败'
  } finally {
    diffLoading.value = false
  }
}

// ===== Derived & UI helpers =====
const createdDate = computed(() => {
  const fr = firstRev.value && firstRev.value[0]
  if (fr && fr.timestamp) return fr.timestamp
  return page.value?.createdAt || ''
})

const groupedAttributions = computed(() => {
  const list = Array.isArray(attributions.value) ? attributions.value : []
  const effective = list.length > 0 ? list : [{ displayName: '(account deleted)', userWikidotId: 0, type: 'AUTHOR' }]
  const grouped: Record<string, any[]> = {}
  effective.forEach((attr:any) => {
    const t = attr.type || 'AUTHOR'
    if (!grouped[t]) grouped[t] = []
    grouped[t].push(attr)
  })
  return Object.entries(grouped).map(([type, users]) => ({ type, users }))
})

function formatDate(dateStr: string) {
  if (!dateStr) return 'N/A'
  const date = new Date(dateStr)
  // Force a stable timezone to avoid SSR/CSR mismatch
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })
}
function formatDateCompact(dateStr: string) {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  // Use UTC components for stability across environments
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}
function formatRelativeTime(dateStr: string) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  const days = Math.floor(diff / (1000 * 60 * 60 * 24))
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days < 30) return `${days} 天前`
  if (days < 365) return `${Math.floor(days / 30)} 个月前`
  return `${Math.floor(days / 365)} 年前`
}

function formatRevisionType(type: string) {
  const map:Record<string,string> = {
    'PAGE_CREATED':'创建页面','PAGE_EDITED':'编辑内容','PAGE_RENAMED':'重命名','PAGE_DELETED':'删除','PAGE_RESTORED':'恢复','METADATA_CHANGED':'修改元数据','TAGS_CHANGED':'修改标签'
  }
  return map[type] || type
}
function revisionTypeClass(type: string) {
  const t = String(type || '')
  if (t === 'PAGE_CREATED' || t === 'PAGE_RESTORED') {
    return 'bg-[rgba(var(--accent),0.12)] dark:bg-[rgba(var(--accent),0.22)] text-[rgb(var(--accent))]'
  }
  if (t === 'PAGE_EDITED') {
    return 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400'
  }
  if (t === 'PAGE_RENAMED') {
    return 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400'
  }
  if (t === 'PAGE_DELETED') {
    return 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
  }
  if (t === 'METADATA_CHANGED') {
    return 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
  }
  if (t === 'TAGS_CHANGED') {
    return 'bg-sky-100 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400'
  }
  return 'bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300'
}
function formatRecordCategory(category: string) {
  const map:Record<string,string> = { rating:'评分', content:'内容', fact:'事实' }
  return map[category] || category
}
function formatRecordType(type: string) {
  const map:Record<string,string> = {
    HIGHEST_RATED:'最高评分', FASTEST_RISING:'上升最快', MOST_CONTROVERSIAL:'最具争议', LONGEST_SOURCE:'最长源码',
    LONGEST_CONTENT:'最长内容', MOST_COMPLEX:'最复杂'
  }
  return map[type] || type
}

const copiedId = ref(false)
function copyId(){
  if (!page.value?.wikidotId) return
  navigator.clipboard?.writeText(String(page.value.wikidotId)).then(() => {
    copiedId.value = true
    setTimeout(() => { copiedId.value = false }, 1200)
  }).catch(() => {})
}
// removed share functionality

// Tags - show all
const allTags = computed(() => Array.isArray(page.value?.tags) ? page.value!.tags : [])

// Votes derived
const upvotes = computed(() => Number(voteDistribution.value?.upvotes ?? stats.value?.uv ?? 0))
const downvotes = computed(() => Number(voteDistribution.value?.downvotes ?? stats.value?.dv ?? 0))
const totalVotes = computed(() => Math.max(0, upvotes.value + downvotes.value))
const upvotePct = computed(() => totalVotes.value ? (upvotes.value / totalVotes.value) * 100 : 0)
const downvotePct = computed(() => totalVotes.value ? (downvotes.value / totalVotes.value) * 100 : 0)
const likeRatioPct = computed(() => totalVotes.value ? (upvotes.value / totalVotes.value) * 100 : 0)

// Wilson 95% lower bound
const wilsonLB = computed(() => {
  const n = totalVotes.value
  if (!n) return 0
  const z = 1.96
  const phat = upvotes.value / n
  const num = phat + (z*z)/(2*n) - z * Math.sqrt((phat*(1-phat) + (z*z)/(4*n))/n)
  const den = 1 + (z*z)/n
  return Math.max(0, num/den) // 0..1
})

// Tooltips
const ratingTooltip = computed(() => `最近更新：${formatRelativeTime(page.value?.updatedAt || page.value?.createdAt || '')}`)
const voteTooltip = computed(() => `总票数：${totalVotes.value}`)
const wilsonTooltip = computed(() => `基于 Wilson 区间的下界，结合票数与比例`)

// Controversy index [0,1]
const controversyIdx = computed(() => {
  const v = Number((stats as any).value?.controversy ?? 0)
  if (!Number.isFinite(v)) return 0
  return Math.max(0, Math.min(1, v))
})

// Copy / Download source
function copySource(){
  const text = displayedSource.value || ''
  if (!text || text === '加载中...' || text === '暂无源码') return
  navigator.clipboard?.writeText(text).catch(() => {})
}
function downloadSource(){
  const text = displayedSource.value || ''
  if (!text || text === '加载中...' || text === '暂无源码') return
  try {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${page.value?.title || 'source'}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  } catch {}
}

// Clean up (for any listeners we might add later)
function onMove(_e: MouseEvent) { /* reserved */ }
onMounted(() => {
  const el = document.querySelector('svg')
  el?.addEventListener('mousemove', onMove)
  recalcPageSizes()
  window.addEventListener('resize', recalcPageSizes)
})
onBeforeUnmount(() => {
  const el = document.querySelector('svg')
  el?.removeEventListener('mousemove', onMove as any)
  window.removeEventListener('resize', recalcPageSizes)
})
</script>
