<!-- pages/page/[wikidotId].vue -->
<template>
  <div>
    <!-- Loading -->
    <div v-if="pagePending" class="p-10 text-center">
      <div class="inline-flex items-center gap-2">
        <LucideIcon name="Loader2" class="w-5 h-5 animate-spin text-[rgb(var(--accent))]" stroke-width="2" aria-hidden="true" />
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
      <header class="relative flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <h1 class="text-[22px] leading-snug font-bold text-neutral-900 dark:text-neutral-100">
          {{ pageDisplayTitle }}
        </h1>
        <div class="flex flex-wrap items-center gap-2 sm:flex-nowrap sm:justify-end sm:shrink-0">
          <button
            v-if="page?.wikidotId"
            @click="copyId"
            :title="copiedId ? '已复制' : '复制'"
            class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 border border-neutral-200 dark:border-neutral-700"
          >
            <LucideIcon name="Copy" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            ID {{ page?.wikidotId }}
          </button>

          <span v-if="page?.isDeleted" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-red-100/90 dark:bg-red-900/40 text-red-700 dark:text-red-300 border border-red-200/80 dark:border-red-800">
            <LucideIcon name="Trash2" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            <span>已删除</span>
            <span v-if="deletedDate" class="text-[11px] opacity-80">· {{ deletedDate }}</span>
          </span>

          <a v-if="page?.url"
             :href="sourceUrlHttps" target="_blank" rel="noopener"
             class="inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium bg-neutral-100 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700 border border-neutral-200 dark:border-neutral-700">
            <LucideIcon name="ExternalLink" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            源页面
            <span class="ml-1 pl-1 inline-flex items-center border-l border-neutral-200 dark:border-neutral-700">
              <span
                @click.stop.prevent="copySourceUrl"
                :title="copiedSource ? '已复制' : '复制 URL'"
                :class="['inline-flex items-center gap-0.5 px-1 py-0.5 rounded transition-colors', copiedSource ? 'bg-[rgba(var(--accent),0.12)] text-[rgb(var(--accent))]' : 'bg-neutral-200/60 dark:bg-neutral-700/60 text-neutral-600 dark:text-neutral-300']"
              >
                <LucideIcon name="Copy" class="w-3 h-3" stroke-width="2" aria-hidden="true" />
              </span>
            </span>
          </a>
          <CollectionPicker
            v-if="page?.pageId"
            :page-id="page.pageId"
            :page-wikidot-id="page?.wikidotId ?? null"
            :page-title="pageDisplayTitle"
          />
        </div>
      </header>

      <!-- Meta line -->
      <section class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] leading-5 text-neutral-600 dark:text-neutral-400">
        <div v-if="groupedAttributions && groupedAttributions.length > 0" class="inline-flex items-center gap-2">
          <LucideIcon name="Users" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
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
          <LucideIcon name="Clock" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
          <span>{{ createdDate ? formatDate(createdDate) : 'N/A' }}</span>
        </div>

        <div class="inline-flex items-center gap-1">
          <LucideIcon name="History" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
          <span>
            修订 {{ page?.revisionCount || 0 }}
            <template v-if="totalViewsCount > 0">
              · 浏览 {{ totalViewsDisplay }}
              <span v-if="todayViewsCount > 0" class="text-green-600 dark:text-green-400">
                (+{{ todayViewsDisplay }})
              </span>
            </template>
          </span>
        </div>

        <div class="inline-flex items-center gap-2 flex-wrap">
          <template v-for="t in allTags" :key="t">
            <NuxtLink :to="{ path: '/search', query: { tags: [t] } }"
                      class="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-800/40 transition-colors"
                      :title="`查看包含「${t}」标签的所有页面`">#{{ t }}</NuxtLink>
          </template>
        </div>
      </section>

      <!-- Metrics (4 cards) -->
      <section id="metrics" class="space-y-3">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div class="flex items-center gap-2">
            <h2 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">核心指标</h2>
            <button
              type="button"
              class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-[rgb(var(--accent))] hover:border-[rgba(var(--accent),0.35)] dark:text-neutral-400 dark:hover:text-[rgb(var(--accent))]"
              @click="copyAnchorLink('metrics')"
              :title="copiedAnchorId === 'metrics' ? '已复制链接' : '复制该段落链接'"
            >
              <LucideIcon v-if="copiedAnchorId === 'metrics'" name="Check" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
              <LucideIcon v-else name="Link" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            </button>
          </div>
          <span v-if="metricsUpdatedAt" class="text-xs text-neutral-500 dark:text-neutral-400">
            更新于 {{ formatDate(metricsUpdatedAt) }}
          </span>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <!-- 评分 -->
          <div class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-3 bg-white dark:bg-neutral-900 shadow-sm">
            <div class="flex items-start justify-between">
              <div class="text-[12px] text-neutral-600 dark:text-neutral-400">评分</div>
              <div class="text-lg font-bold text-neutral-900 dark:text-neutral-100" :title="ratingTooltip">
                {{ totalScoreDisplay }}
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
        </div>
      </section>
      <!-- Chart -->
      <section
        v-if="ratingHistoryPending || ratingHistoryError || (Array.isArray(ratingHistory) && ratingHistory.length)"
        id="rating-history"
        class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm"
      >
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">评分趋势</h3>
            <button
              type="button"
              class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-[rgb(var(--accent))] hover:border-[rgba(var(--accent),0.35)] dark:text-neutral-400 dark:hover:text-[rgb(var(--accent))]"
              @click="copyAnchorLink('rating-history')"
              :title="copiedAnchorId === 'rating-history' ? '已复制链接' : '复制该段落链接'"
            >
              <LucideIcon v-if="copiedAnchorId === 'rating-history'" name="Check" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
              <LucideIcon v-else name="Link" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            </button>
          </div>
          <span class="text-xs text-neutral-500 dark:text-neutral-500">按周聚合</span>
        </div>
        <div v-if="ratingHistoryPending" class="h-64 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
          加载图表中...
        </div>
        <div v-else-if="ratingHistoryError" class="rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50/80 dark:bg-neutral-900/60 p-6 text-sm text-neutral-600 dark:text-neutral-400">
          加载评分趋势失败。
          <button type="button" class="ml-2 inline-flex items-center gap-1 text-[rgb(var(--accent))] hover:underline" @click="refreshRatingHistory()">重试</button>
        </div>
        <ClientOnly v-else>
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
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">最近修订</h3>
              <button
                type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-[rgb(var(--accent))] hover:border-[rgba(var(--accent),0.35)] dark:text-neutral-400 dark:hover:text-[rgb(var(--accent))]"
                @click="copyAnchorLink('revisions')"
                :title="copiedAnchorId === 'revisions' ? '已复制链接' : '复制该段落链接'"
              >
                <LucideIcon v-if="copiedAnchorId === 'revisions'" name="Check" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
                <LucideIcon v-else name="Link" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
              </button>
            </div>
            <div class="text-xs text-neutral-500 dark:text-neutral-400">{{ (revPage + 1) }} / {{ revTotalPages }}</div>
          </div>

          <div v-if="revisionsPending" class="flex-1 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
            正在加载修订记录…
          </div>

          <div v-else-if="revisionsError" class="flex-1 flex flex-col items-center justify-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
            加载修订记录失败。
            <button type="button" class="inline-flex items-center gap-1 text-[rgb(var(--accent))] hover:underline" @click="refreshRevisions()">重试</button>
          </div>

          <div v-else-if="!revisionsPaged || revisionsPaged.length === 0" class="flex-1 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
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
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
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
              <div class="hidden sm:flex items-center gap-1">
                <input
                  v-model.number="revJumpPage"
                  type="number"
                  :min="1"
                  :max="revTotalPages"
                  placeholder="页码"
                  @keyup.enter="jumpToRevPage"
                  class="w-16 text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800"
                />
                <button @click="jumpToRevPage" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">跳转</button>
              </div>
              <button @click="nextRevPage" :disabled="!hasMoreRevisions"
                      class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
            </div>
          </div>

          
      </section>

      <!-- Recent Votes -->
      <section id="votes" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-4 bg-white dark:bg-neutral-900 shadow-sm min-h-[280px] flex flex-col">
          <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">最近投票</h3>
              <button
                type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-[rgb(var(--accent))] hover:border-[rgba(var(--accent),0.35)] dark:text-neutral-400 dark:hover:text-[rgb(var(--accent))]"
                @click="copyAnchorLink('votes')"
                :title="copiedAnchorId === 'votes' ? '已复制链接' : '复制该段落链接'"
              >
                <LucideIcon v-if="copiedAnchorId === 'votes'" name="Check" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
                <LucideIcon v-else name="Link" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
              </button>
            </div>
            <div class="text-xs text-neutral-500 dark:text-neutral-400">{{ currentVotePage }} / {{ voteTotalPages }}</div>
          </div>

          <div v-if="recentVotesPending" class="flex-1 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
            正在加载投票记录…
          </div>

          <div v-else-if="recentVotesError" class="flex-1 flex flex-col items-center justify-center gap-2 text-sm text-neutral-500 dark:text-neutral-400">
            加载投票记录失败。
            <button type="button" class="inline-flex items-center gap-1 text-[rgb(var(--accent))] hover:underline" @click="refreshRecentVotes()">重试</button>
          </div>

          <div v-else-if="!recentVotes || recentVotes.length === 0" class="flex-1 flex items-center justify-center text-neutral-500 dark:text-neutral-400">
            暂无投票
          </div>

          <div v-else class="flex-1">
            <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5 gap-2">
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
                      :viewer-vote="viewerLinkedId != null && Number(v.userWikidotId || 0) === viewerLinkedId ? Number(v.direction || 0) : null"
                    />
                  </div>
                  <div class="text-[11px] text-neutral-600 dark:text-neutral-400 whitespace-nowrap shrink-0 tabular-nums">{{ formatDateCompact(v.timestamp) }}</div>
                </div>
              </div>
            </div>

          </div>
          <div v-if="recentVotes && recentVotes.length > 0" class="mt-3">
            <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <button @click="prevVotePage" :disabled="voteOffset === 0" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">上一页</button>
              <div class="flex items-center gap-1">
                <button
                  v-for="n in votePageNumbers"
                  :key="`vp-${n}`"
                  @click="goVotePage(n)"
                  :class="['text-xs px-2 py-1 rounded border', (currentVotePage === n) ? 'bg-neutral-200 dark:bg-neutral-700 border-neutral-300 dark:border-neutral-700' : 'bg-neutral-100 dark:bg-neutral-800 border-neutral-200 dark:border-neutral-800']"
                >{{ n }}</button>
              </div>
              <div class="hidden sm:flex items-center gap-1">
                <input
                  v-model.number="voteJumpPage"
                  type="number"
                  :min="1"
                  :max="voteTotalPages"
                  placeholder="页码"
                  @keyup.enter="jumpToVotePage"
                  class="w-16 text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-800"
                />
                <button @click="jumpToVotePage" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">跳转</button>
              </div>
              <button @click="nextVotePage" :disabled="!hasMoreVotes" class="text-xs px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800 disabled:opacity-50">下一页</button>
            </div>
          </div>

          
      </section>

      

      <!-- Related Pages (Recommendations) -->
      <section id="related" class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm">
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">相关页面</h3>
            <button
              type="button"
              class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-[rgb(var(--accent))] hover:border-[rgba(var(--accent),0.35)] dark:text-neutral-400 dark:hover:text-[rgb(var(--accent))]"
              @click="copyAnchorLink('related')"
              :title="copiedAnchorId === 'related' ? '已复制链接' : '复制该段落链接'"
            >
              <LucideIcon v-if="copiedAnchorId === 'related'" name="Check" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
              <LucideIcon v-else name="Link" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            </button>
          </div>
          <button
            type="button"
            class="hidden sm:inline-flex items-center gap-1 rounded-full border border-neutral-200 dark:border-neutral-700 px-3 py-1 text-xs text-neutral-500 hover:text-[rgb(var(--accent))] hover:border-[rgba(var(--accent),0.35)] dark:text-neutral-400 dark:hover:text-[rgb(var(--accent))]"
            @click="refreshRelatedPages()"
            title="刷新推荐"
          >
            <LucideIcon name="RefreshCcw" class="h-3.5 w-3.5" stroke-width="1.8" />
            刷新
          </button>
        </div>
        <div v-if="relatedPending" class="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
        <div v-else-if="relatedError" class="rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50/80 dark:bg-neutral-900/60 p-6 text-sm text-neutral-600 dark:text-neutral-400">
          加载推荐失败。
          <button type="button" class="ml-2 inline-flex items-center gap-1 text-[rgb(var(--accent))] hover:underline" @click="refreshRelatedPages()">重试</button>
        </div>
        <div v-else-if="relatedPages && relatedPages.length > 0" class="grid grid-cols-1 md:grid-cols-3 gap-3">
          <PageCard
            v-for="rp in relatedPages.slice(0, 3)"
            :key="rp.wikidotId"
            size="md"
            :to="`/page/${rp.wikidotId}`"
            :wikidot-id="rp.wikidotId"
            :title="rp.title"
            :snippet-html="(rp as any).snippet || null"
            :tags="orderTags(Array.isArray(rp.tags) ? rp.tags : [])"
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

      <section
        v-if="pageImagesPending || hasPageImages || pageImagesError"
        id="page-images"
        class="border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 bg-white dark:bg-neutral-900 shadow-sm"
      >
        <div class="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-200">相关图片</h3>
              <button
                type="button"
                class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-[rgb(var(--accent))] hover:border-[rgba(var(--accent),0.35)] dark:text-neutral-400 dark:hover:text-[rgb(var(--accent))]"
                @click="copyAnchorLink('page-images')"
                :title="copiedAnchorId === 'page-images' ? '已复制链接' : '复制该段落链接'"
              >
                <LucideIcon v-if="copiedAnchorId === 'page-images'" name="Check" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
                <LucideIcon v-else name="Link" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
              </button>
            </div>
            <p v-if="hasPageImages" class="text-xs text-neutral-500 dark:text-neutral-400">
              第 {{ pageImagePage }} / {{ pageImageTotalPages }} 页 · 展示 {{ pageImageRangeLabel }} · 共 {{ pageImages.length }} 张
            </p>
            <p v-else class="text-xs text-neutral-500 dark:text-neutral-400">
              暂无可用图片资源。
            </p>
          </div>
          <div v-if="hasPageImages" class="flex flex-wrap items-center gap-3 text-xs text-neutral-500 dark:text-neutral-400">
            <div class="inline-flex items-center gap-2">
              <span class="hidden sm:inline">每行数量</span>
              <div class="inline-flex overflow-hidden rounded-full border border-neutral-200 dark:border-neutral-700 bg-neutral-100/60 dark:bg-neutral-800/60">
                <button
                  v-for="option in pageImageSizeOptions"
                  :key="option.value"
                  type="button"
                  @click="pageImageColumns = option.value"
                  :class="[
                    'px-3 py-1 font-medium transition-colors',
                    pageImageColumns === option.value
                      ? 'bg-white dark:bg-neutral-700 text-[rgb(var(--accent))] shadow'
                      : 'text-neutral-600 dark:text-neutral-300 hover:text-[rgb(var(--accent))]'
                  ]"
                >
                  {{ option.label }} ({{ option.value }})
                </button>
              </div>
            </div>
            <div class="inline-flex items-center gap-2">
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-full border border-neutral-200 dark:border-neutral-700 px-3 py-1 text-neutral-600 dark:text-neutral-300 hover:border-[rgb(var(--accent))] hover:text-[rgb(var(--accent))] disabled:opacity-40"
                @click="pageImagePage = Math.max(1, pageImagePage - 1)"
                :disabled="pageImagePage <= 1"
              >上一页</button>
              <button
                type="button"
                class="inline-flex items-center gap-1 rounded-full border border-neutral-200 dark:border-neutral-700 px-3 py-1 text-neutral-600 dark:text-neutral-300 hover:border-[rgb(var(--accent))] hover:text-[rgb(var(--accent))] disabled:opacity-40"
                @click="pageImagePage = Math.min(pageImageTotalPages, pageImagePage + 1)"
                :disabled="pageImagePage >= pageImageTotalPages"
              >下一页</button>
            </div>
          </div>
        </div>

        <div v-if="pageImagesPending" class="mt-6 text-sm text-neutral-500 dark:text-neutral-400">正在加载图片…</div>
        <div v-else-if="pageImagesError" class="mt-6 rounded-lg border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50/80 dark:bg-neutral-900/60 p-6 text-sm text-neutral-600 dark:text-neutral-400">
          加载图片失败。
          <button type="button" class="ml-2 inline-flex items-center gap-1 text-[rgb(var(--accent))] hover:underline" @click="refreshPageImages()">重试</button>
        </div>
        <div v-else-if="hasPageImages" class="page-images-grid mt-4" :style="pageImageGridStyle">
          <figure
            v-for="img in paginatedPageImages"
            :key="img.pageVersionImageId || img.normalizedUrl || img.originUrl"
            class="group space-y-2"
          >
            <div
              class="relative w-full overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-100 dark:bg-neutral-900/40"
              :style="img.aspectStyle"
            >
              <img
                :src="img.imageSrc"
                :srcset="img.imageSrcFull && img.imageSrc ? `${img.imageSrc} 1x, ${img.imageSrcFull} 2x` : undefined"
                :alt="img.label || pageDisplayTitle"
                loading="lazy"
                class="absolute inset-0 h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
              >
            </div>
            <figcaption class="text-xs text-neutral-600 dark:text-neutral-400 truncate">
              {{ img.label || '图片资源' }}
            </figcaption>
          </figure>
        </div>
        <div v-else class="mt-6 text-sm text-neutral-500 dark:text-neutral-400">暂无图片。</div>
      </section>

      <!-- Source Viewer -->
      <section id="page-source" class="border border-neutral-200 dark:border-neutral-800 rounded-lg bg-white dark:bg-neutral-900 shadow-sm">
        <header class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between px-6 pt-6">
          <div class="flex items-center gap-2">
            <h3 class="text-sm font-semibold text-neutral-700 dark:text-neutral-300">页面源码</h3>
            <button
              type="button"
              class="inline-flex h-7 w-7 items-center justify-center rounded-full border border-neutral-200 dark:border-neutral-700 text-neutral-500 hover:text-[rgb(var(--accent))] hover:border-[rgba(var(--accent),0.35)] dark:text-neutral-400 dark:hover:text-[rgb(var(--accent))]"
              @click="copyAnchorLink('page-source')"
              :title="copiedAnchorId === 'page-source' ? '已复制链接' : '复制该段落链接'"
            >
              <LucideIcon v-if="copiedAnchorId === 'page-source'" name="Check" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
              <LucideIcon v-else name="Link" class="w-3.5 h-3.5" stroke-width="2" aria-hidden="true" />
            </button>
          </div>
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

            <div v-else class="diff-toolbar flex flex-col gap-2 text-xs text-neutral-600 dark:text-neutral-400 sm:flex-row sm:flex-wrap sm:items-stretch sm:gap-3">
              <div class="diff-chip flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-100/70 dark:bg-neutral-800/60 shadow-sm sm:flex-[1_1_220px]">
                <span class="diff-label text-neutral-500 dark:text-neutral-300">基准</span>
                <select
                  v-model="baseVersionId"
                  class="diff-select flex-1 min-w-0 px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)]"
                >
                  <option v-for="v in orderedVersions" :key="`b-${v.pageVersionId}`" :value="v.pageVersionId">
                    {{ v.validTo ? '历史' : '当前' }} · {{ formatDate(v.createdAt) }} · {{ v.title || '' }}
                  </option>
                </select>
              </div>
              <div class="diff-chip flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-100/70 dark:bg-neutral-800/60 shadow-sm sm:flex-[1_1_220px]">
                <span class="diff-label text-neutral-500 dark:text-neutral-300">对比</span>
                <select
                  v-model="compareVersionId"
                  class="diff-select flex-1 min-w-0 px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)]"
                >
                  <option v-for="v in orderedVersions" :key="`c-${v.pageVersionId}`" :value="v.pageVersionId">
                    {{ v.validTo ? '历史' : '当前' }} · {{ formatDate(v.createdAt) }} · {{ v.title || '' }}
                  </option>
                </select>
              </div>
              <div class="diff-chip flex items-center gap-3 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-100/70 dark:bg-neutral-800/60 shadow-sm sm:flex-[1_1_200px]">
                <span class="diff-label text-neutral-500 dark:text-neutral-300">视图</span>
                <div class="diff-view-toggle inline-flex items-center rounded-full bg-neutral-200/60 dark:bg-neutral-800/70 p-[3px]">
                  <button
                    type="button"
                    :class="[
                      'diff-view-toggle__btn px-3 py-1 rounded-full text-[11px] font-medium transition-colors',
                      diffViewMode === 'unified'
                        ? 'bg-white text-[rgb(var(--accent))] shadow-sm dark:bg-neutral-700'
                        : 'text-neutral-600 hover:text-neutral-800 dark:text-neutral-300 dark:hover:text-neutral-100'
                    ]"
                    @click="diffViewMode = 'unified'"
                  >
                    合并
                  </button>
                  <button
                    type="button"
                    :class="[
                      'diff-view-toggle__btn px-3 py-1 rounded-full text-[11px] font-medium transition-colors',
                      diffViewMode === 'split'
                        ? 'bg-white text-[rgb(var(--accent))] shadow-sm dark:bg-neutral-700'
                        : 'text-neutral-600 hover:text-neutral-800 dark:text-neutral-300 dark:hover:text-neutral-100'
                    ]"
                    @click="diffViewMode = 'split'"
                  >
                    并排
                  </button>
                </div>
              </div>
              <div class="diff-chip diff-chip--context flex items-center gap-2 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-100/70 dark:bg-neutral-800/60 shadow-sm sm:flex-[0_1_150px]">
                <span class="diff-label text-neutral-500 dark:text-neutral-300">上下文</span>
                <select
                  v-model.number="diffContextLines"
                  class="diff-select diff-select--narrow flex-none px-2 py-1 rounded border border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-900 focus:outline-none focus:ring-2 focus:ring-[rgba(var(--accent),0.35)]"
                >
                  <option :value="1">1</option>
                  <option :value="2">2</option>
                  <option :value="3">3</option>
                  <option :value="5">5</option>
                </select>
              </div>
              <div class="diff-chip diff-chip--toggles flex gap-2 px-3 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 bg-neutral-100/70 dark:bg-neutral-800/60 shadow-sm sm:flex-[1_1_220px]">
                <span class="diff-label text-neutral-500 dark:text-neutral-300">显示</span>
                <div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                  <label class="inline-flex items-center gap-2">
                    <input type="checkbox" v-model="ignoreWhitespace" class="rounded">
                    <span class="text-neutral-600 dark:text-neutral-300">忽略空白</span>
                  </label>
                  <label class="inline-flex items-center gap-2">
                    <input type="checkbox" v-model="diffCollapseUnchanged" class="rounded">
                    <span class="text-neutral-600 dark:text-neutral-300">折叠未变化</span>
                  </label>
                </div>
              </div>
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
        </header>

        <div class="mt-4 border-t border-neutral-100 dark:border-neutral-800"></div>

        <div v-if="!diffMode" class="px-6 pb-6">
          <div class="mb-2 text-[11px] text-neutral-500 dark:text-neutral-400 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>源码字符数 {{ sourceCharacterCount }}</span>
            <span aria-hidden="true">·</span>
            <span>文字字数 {{ textContentCharacterCount }}</span>
          </div>
          <pre class="source-code-block border border-neutral-200 dark:border-neutral-700 rounded bg-neutral-50 dark:bg-neutral-800 p-3 max-h-96 overflow-auto text-xs font-mono whitespace-pre-wrap select-text"
               aria-label="页面源码内容">{{ displayedSource }}</pre>
        </div>

        <div v-else class="px-6 pb-6">
          <div class="source-code-block border border-neutral-200 dark:border-neutral-700 rounded bg-neutral-50 dark:bg-neutral-800 overflow-hidden text-xs font-mono select-text">
            <div v-if="diffLoading" class="px-3 py-4 text-neutral-500 dark:text-neutral-400">计算对比中…</div>
            <div v-else-if="diffError" class="px-3 py-4 text-red-600 dark:text-red-400">{{ diffError }}</div>
            <div v-else-if="!diffData" class="px-3 py-4 text-neutral-500 dark:text-neutral-400">尚未生成对比</div>
            <template v-else>
              <div class="flex flex-wrap items-center gap-3 px-3 py-2 text-[11px] text-neutral-600 dark:text-neutral-400 border-b border-neutral-200 dark:border-neutral-700 bg-white/60 dark:bg-neutral-900/40">
                <span>变化 {{ diffSummary.blocks }} 处 · +{{ diffSummary.added }} / -{{ diffSummary.removed }}</span>
                <span v-if="!diffHasChanges" class="text-neutral-500 dark:text-neutral-400">两个版本内容一致</span>
              </div>
              <div v-if="diffViewMode === 'unified'" class="diff-viewer-unified max-h-[28rem] overflow-auto">
                <template v-for="row in diffUnifiedRows" :key="row.kind === 'fold' ? `fold-${row.id}` : row.key">
                  <div v-if="row.kind === 'fold'" class="border-b border-neutral-200 dark:border-neutral-700 bg-neutral-100/60 dark:bg-neutral-800/60 px-3 py-2">
                    <button type="button" @click="toggleDiffFold(row.id)"
                            class="inline-flex items-center gap-1 text-[11px] text-neutral-600 dark:text-neutral-300">
                      <span>{{ row.isExpanded ? '折叠' : '展开' }} {{ row.skipped }} 行未变化</span>
                      <span v-if="row.oldRange || row.newRange" class="opacity-60">
                        (旧 {{ formatRange(row.oldRange) }} / 新 {{ formatRange(row.newRange) }})
                      </span>
                    </button>
                  </div>
                  <div v-else
                       :class="['grid grid-cols-[56px_56px_1fr] gap-2 px-3 py-1 border-b border-neutral-200 dark:border-neutral-800 whitespace-pre-wrap',
                         row.type === 'added' ? 'bg-[rgba(var(--accent),0.12)] dark:bg-[rgba(var(--accent),0.2)] text-[rgb(var(--accent))]' :
                         row.type === 'removed' ? 'bg-red-100/60 dark:bg-red-900/30 text-red-700 dark:text-red-300' :
                         'text-neutral-800 dark:text-neutral-200']">
                    <span class="text-right text-[10px] text-neutral-400">
                      {{ row.oldLine ?? '' }}
                    </span>
                    <span class="text-right text-[10px] text-neutral-400">
                      {{ row.newLine ?? '' }}
                    </span>
                    <span>{{ row.text || ' ' }}</span>
                  </div>
                </template>
              </div>
              <div v-else class="diff-viewer-split max-h-[28rem] overflow-auto">
                <template v-for="row in diffSplitRows" :key="row.kind === 'fold' ? `fold-${row.id}` : row.key">
                  <div v-if="row.kind === 'fold'" class="border-b border-neutral-200 dark:border-neutral-700 bg-neutral-100/60 dark:bg-neutral-800/60 px-3 py-2">
                    <button type="button" @click="toggleDiffFold(row.id)"
                            class="inline-flex items-center gap-1 text-[11px] text-neutral-600 dark:text-neutral-300">
                      <span>{{ row.isExpanded ? '折叠' : '展开' }} {{ row.skipped }} 行未变化</span>
                      <span v-if="row.oldRange || row.newRange" class="opacity-60">
                        (旧 {{ formatRange(row.oldRange) }} / 新 {{ formatRange(row.newRange) }})
                      </span>
                    </button>
                  </div>
                  <div v-else class="grid gap-2 px-3 py-1 border-b border-neutral-200 dark:border-neutral-800 text-neutral-800 dark:text-neutral-200 sm:grid-cols-[56px_minmax(0,1fr)_56px_minmax(0,1fr)]">
                    <div class="flex items-baseline justify-between sm:block text-[10px] text-neutral-400">
                      <span class="sm:hidden text-neutral-500 mr-2">基准</span>
                      <span>{{ row.left.line ?? '' }}</span>
                    </div>
                    <span :class="[
                        'block whitespace-pre-wrap',
                        row.changeType === 'removed' || row.changeType === 'modified'
                          ? 'bg-red-100/60 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded'
                          : '']">
                      {{ row.left.text || ' ' }}
                    </span>
                    <div class="flex items-baseline justify-between sm:block text-[10px] text-neutral-400">
                      <span class="sm:hidden text-neutral-500 mr-2">对比</span>
                      <span>{{ row.right.line ?? '' }}</span>
                    </div>
                    <span :class="[
                        'block whitespace-pre-wrap',
                        row.changeType === 'added' || row.changeType === 'modified'
                          ? 'bg-[rgba(var(--accent),0.12)] dark:bg-[rgba(var(--accent),0.2)] text-[rgb(var(--accent))] rounded'
                          : '']">
                      {{ row.right.text || ' ' }}
                    </span>
                  </div>
                </template>
              </div>
            </template>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { useHead } from '#imports'
import { orderTags } from '~/composables/useTagOrder'
import { onBeforeRouteUpdate } from 'vue-router'
import { useAuth } from '~/composables/useAuth'
import { useViewerVotes } from '~/composables/useViewerVotes'
import { formatDateUtc8, formatDateIsoUtc8, diffUtc8CalendarDays } from '~/utils/timezone'
import CollectionPicker from '~/components/collections/CollectionPicker.vue'
import { normalizeBffBase, resolveWithFallback } from '~/utils/assetUrl'

// Nuxt auto imports for type checker
declare const useAsyncData: any
declare const useNuxtApp: any
declare const useRoute: any
declare const definePageMeta: any
declare const useRuntimeConfig: any

const route = useRoute();
const {$bff} = useNuxtApp();
const runtimeConfig = useRuntimeConfig();
const { user: authUser, isAuthenticated } = useAuth()
const { hydratePages: hydrateViewerVotes } = useViewerVotes()
const PAGE_ANCHOR_KEY = '__page__'
const copiedAnchorId = ref<string | null>(null)
let anchorCopyTimer: ReturnType<typeof setTimeout> | null = null
const isClient = typeof window !== 'undefined'
const isDev = import.meta.env.DEV

const viewerLinkedId = computed(() => {
  const id = authUser.value?.linkedWikidotId
  if (id == null) return null
  const numeric = Number(id)
  return Number.isFinite(numeric) ? numeric : null
})


const bffBase = normalizeBffBase((runtimeConfig?.public as any)?.bffBase);

const resolveAssetPath = (path?: string | null, fallback?: string | null, preferLow = false) => {
  const full = resolveWithFallback(path ?? '', fallback ?? '', bffBase);
  if (!preferLow) return full;
  const low = resolveWithFallback(path ?? '', fallback ?? '', bffBase, { variant: 'low' });
  return low || full;
};

definePageMeta({ key: (route:any) => route.fullPath })

if (isDev) {
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

const pageDisplayTitle = computed(() => {
  const base = typeof page.value?.title === 'string' ? page.value!.title!.trim() : ''
  const alt = typeof (page.value as any)?.alternateTitle === 'string' ? (page.value as any).alternateTitle.trim() : ''
  if (alt) return base ? `${base} - ${alt}` : alt
  return base || 'Untitled'
})

const metricsUpdatedAt = computed(() => {
  const record = page.value as any
  if (!record) return null
  const raw = record.updatedAt || record.validFrom || record.createdAt || null
  if (!raw) return null
  if (typeof raw === 'string') return raw
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
})

const { data: pageImagesData, pending: pageImagesPending, error: pageImagesError, refresh: refreshPageImages } = await useAsyncData(
  () => `page-images-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/images`),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

const pageImagesRaw = computed(() => {
  const images = pageImagesData.value
  return Array.isArray(images) ? images : []
})

const pageImages = computed(() => {
  const raw = pageImagesRaw.value
  return raw.map((img: any) => {
    const width = Number(img.width ?? img.assetWidth ?? 0)
    const height = Number(img.height ?? img.assetHeight ?? 0)
    const ratio = width > 0 && height > 0 ? width / height : null
    const orientation = ratio == null ? 'unknown' : ratio >= 1.7 ? 'wide' : ratio <= 0.65 ? 'tall' : 'normal'
    const aspectStyle = ratio == null
      ? 'aspect-ratio: 4 / 3;'
      : orientation === 'wide'
        ? 'aspect-ratio: 16 / 9;'
        : orientation === 'tall'
          ? 'aspect-ratio: 3 / 4;'
          : 'aspect-ratio: 4 / 3;'
    const labelSource = img.displayUrl || img.normalizedUrl || img.originUrl || ''
    let label = labelSource
    if (label) {
      try {
        const parsed = new URL(label)
        const pathname = parsed.pathname.replace(/\/+$/u, '') || '/'
        label = `${parsed.hostname}${pathname}`
      } catch {
        label = label.replace(/^https?:\/\//i, '')
      }
    }
    const fullSrc = resolveAssetPath(img.imageUrl, labelSource)
    const lowSrc = resolveAssetPath(img.imageUrl, labelSource, true)
    const imageSrc = lowSrc || fullSrc
    if (!imageSrc) return null

    return {
      ...img,
      width,
      height,
      ratio,
      orientation,
      aspectStyle,
      label,
      imageSrc,
      imageSrcFull: fullSrc
    }
  }).filter(Boolean)
})

const hasPageImages = computed(() => pageImages.value.length > 0)

const primaryImageUrl = computed(() => {
  const firstImage = pageImages.value[0]
  if (firstImage?.imageSrc) return firstImage.imageSrc as string
  const record = page.value as any
  if (record && Array.isArray(record.images) && record.images.length > 0) {
    const fallback = record.images[0]
    const candidate = typeof fallback === 'string'
      ? fallback
      : fallback?.imageUrl || fallback?.normalizedUrl || fallback?.originUrl || ''
    if (typeof candidate === 'string' && candidate.trim()) {
      return resolveAssetPath(candidate, candidate)
    }
  }
  const direct = typeof record?.primaryImageUrl === 'string'
    ? record.primaryImageUrl
    : typeof record?.coverImageUrl === 'string'
      ? record.coverImageUrl
      : ''
  if (direct && typeof direct === 'string') {
    return resolveAssetPath(direct)
  }
  return ''
})

const canonicalUrl = computed(() => {
  const basePath = (route.fullPath || '').split('#')[0] || ''
  const normalizedPath = basePath.startsWith('/') ? basePath : `/${basePath}`
  if (isClient && typeof window !== 'undefined' && window.location?.origin) {
    return `${window.location.origin}${normalizedPath}`
  }
  const siteBase = (runtimeConfig?.public as any)?.siteBase
  if (typeof siteBase === 'string' && siteBase.trim()) {
    const sanitized = siteBase.replace(/\/+$/u, '')
    return `${sanitized}${normalizedPath}`
  }
  return ''
})

const pageImageSizeOptions = [
  { label: '小', value: 9 },
  { label: '中', value: 6 },
  { label: '大', value: 3 }
]

const pageImageColumns = ref<number>(6)
const pageImageRows = computed(() => {
  const cols = pageImageColumns.value
  if (cols >= 9) return 5
  if (cols >= 6) return 4
  return 3
})
const pageImagesPerPage = computed(() => Math.max(1, pageImageColumns.value * pageImageRows.value))
const pageImagePage = ref(1)
const pageImageTotalPages = computed(() => {
  if (!pageImages.value.length) return 1
  return Math.max(1, Math.ceil(pageImages.value.length / pageImagesPerPage.value))
})

const paginatedPageImages = computed(() => {
  const pageIndex = Math.max(1, Math.min(pageImagePage.value, pageImageTotalPages.value)) - 1
  const start = pageIndex * pageImagesPerPage.value
  return pageImages.value.slice(start, start + pageImagesPerPage.value)
})

const pageImageRangeLabel = computed(() => {
  if (!pageImages.value.length) return '0'
  const start = (Math.max(1, pageImagePage.value) - 1) * pageImagesPerPage.value + 1
  const end = Math.min(pageImages.value.length, start + pageImagesPerPage.value - 1)
  return `${start} - ${end}`
})

const pageImageGridStyle = computed(() => ({
  '--columns': String(Math.max(1, Math.min(pageImageColumns.value, 12)))
}))

watch(pageImages, () => {
  if (pageImagePage.value > pageImageTotalPages.value) {
    pageImagePage.value = pageImageTotalPages.value
  }
})

watch(pageImageColumns, () => {
  pageImagePage.value = 1
})

const { data: stats, pending: statsPending } = await useAsyncData(
  () => `stats-${wikidotId.value}`,
  () => $bff(`/stats/pages/${wikidotId.value}`),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

// rating history moved below after firstRev to decide dynamic granularity

const pageSize = ref(3)
const revPage = ref(0)
const { data: revisionsPaged, pending: revisionsPending, error: revisionsError, refresh: refreshRevisions } = await useAsyncData(
  () => `revs-${wikidotId.value}-${revPage.value}-${pageSize.value}`,
  () => $bff(`/pages/${wikidotId.value}/revisions`, { params: { limit: pageSize.value, offset: revPage.value * pageSize.value, order: 'DESC', scope: 'latest' } }),
  { watch: [() => route.params.wikidotId, () => revPage.value, () => pageSize.value], server: false, lazy: true }
)
const hasMoreRevisions = computed(() => Array.isArray(revisionsPaged.value) && revisionsPaged.value.length === pageSize.value)
function nextRevPage(){ if (hasMoreRevisions.value) revPage.value += 1 }
function prevRevPage(){ if (revPage.value > 0) revPage.value -= 1 }
const { data: revisionsCount, pending: revisionsCountPending } = await useAsyncData(
  () => `revs-count-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/revisions/count`, { params: { scope: 'latest' } }),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)
const revTotalPages = computed(() => {
  const total = Number((revisionsCount as any).value?.total ?? page.value?.revisionCount ?? 0)
  if (!total || !pageSize.value) return 1
  return Math.max(1, Math.ceil(total / pageSize.value))
})
const deletedDate = computed(() => {
  const raw = page.value?.deletedAt
  if (!raw) return ''
  return formatDateIsoUtc8(raw)
})
const revPageNumbers = computed(() => [1,2,3,4].filter(n => n <= revTotalPages.value))
function goRevPage(n:number){
  const idx = Math.max(1, Math.min(revTotalPages.value, n)) - 1
  revPage.value = idx
}
const revJumpPage = ref<number | null>(null)
function jumpToRevPage(){
  const raw = Number(revJumpPage.value)
  if (!Number.isFinite(raw)) return
  const target = Math.max(1, Math.min(revTotalPages.value, Math.trunc(raw)))
  revPage.value = target - 1
  revJumpPage.value = target
}

const { data: firstRev, pending: firstRevPending } = await useAsyncData(
  () => `firstrev-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/revisions`, { params: { limit: 1, offset: 0, order: 'ASC', type: 'PAGE_CREATED' } }),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
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

const { data: ratingHistory, pending: ratingHistoryPending, error: ratingHistoryError, refresh: refreshRatingHistory } = await useAsyncData(
  () => `page-rating-history-${wikidotId.value}-${ratingGranularity.value}`,
  () => $bff(`/pages/${wikidotId.value}/rating-history`, { params: { granularity: ratingGranularity.value } }),
  { watch: [() => route.params.wikidotId, () => ratingGranularity.value], server: false, lazy: true }
)

const { data: attributions, pending: attributionsPending } = await useAsyncData(
  () => `attributions-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/attributions`),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

// removed revision list for source selection

const { data: voteDistribution, pending: voteDistributionPending } = await useAsyncData(
  () => `vote-dist-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/vote-distribution`),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

// removed related-records fetch

// Recommendations (related pages) - 非阻塞加载
const { data: relatedPages, pending: relatedPending, error: relatedError, refresh: refreshRelatedPages } = useAsyncData(
  () => `related-pages-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/recommendations`, { params: { limit: 6, strategy: 'both', diversity: 'simple' } }),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

watch(
  () => relatedPages.value,
  (pages) => {
    if (!isClient) return
    if (!Array.isArray(pages) || pages.length === 0) return
    void hydrateViewerVotes(pages as any[])
  },
  { immediate: true, flush: 'post' }
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
const { data: recentVotes, pending: recentVotesPending, error: recentVotesError, refresh: refreshRecentVotes } = await useAsyncData(
  () => `page-votes-${wikidotId.value}-${voteOffset.value}-${votePageSize.value}`,
  () => $bff(`/pages/${wikidotId.value}/votes/fuzzy`, { params: { limit: votePageSize.value, offset: voteOffset.value } }),
  { watch: [() => route.params.wikidotId, () => voteOffset.value, () => votePageSize.value], server: false, lazy: true }
)
const hasMoreVotes = computed(() => Array.isArray(recentVotes.value) && recentVotes.value.length === votePageSize.value)
const currentVotePage = computed(() => (voteOffset.value / votePageSize.value) + 1)
const { data: voteFuzzyCount, pending: voteFuzzyCountPending } = await useAsyncData(
  () => `page-votes-count-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/votes/fuzzy/count`),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)
const voteTotalPages = computed(() => {
  const total = Number((voteFuzzyCount as any).value?.total ?? 0)
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
const voteJumpPage = ref<number | null>(null)
function jumpToVotePage(){
  const raw = Number(voteJumpPage.value)
  if (!Number.isFinite(raw)) return
  const target = Math.max(1, Math.min(voteTotalPages.value, Math.trunc(raw)))
  voteOffset.value = (target - 1) * votePageSize.value
  voteJumpPage.value = target
}

const selectedVersion = ref<number | null>(null)
// removed revision selection; only page version is used
const { data: latestSourceResp, pending: latestSourcePending } = await useAsyncData(
  () => `page-latest-source-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/source`),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
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

const sourceText = computed(() => {
  const text = latestSource.value
  return typeof text === 'string' ? text : ''
})

const sourceCharacterCount = computed(() => sourceText.value.length)

const { data: textContentResp, pending: textContentPending } = await useAsyncData(
  () => `page-text-content-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/text-content`),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
)

const pageTextContent = computed(() => {
  const payload = textContentResp.value as any
  const text = payload?.textContent
  return typeof text === 'string' ? text : ''
})

const textContentCharacterCount = computed(() => {
  const raw = pageTextContent.value
  if (!raw) return 0
  return raw.replace(/[\r\n\t]/g, '').length
})

const seoDescription = computed(() => {
  const record = page.value as any
  const candidates: Array<unknown> = [
    record?.summary,
    record?.description,
    record?.excerpt,
    record?.alternateTitle,
    pageTextContent.value
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      const sanitized = candidate.replace(/\s+/g, ' ').trim()
      if (sanitized) {
        return sanitized.length > 160 ? `${sanitized.slice(0, 157)}…` : sanitized
      }
    }
  }
  return `${pageDisplayTitle.value} - SCPPER-CN 页面详情`
})

useHead(() => {
  const description = seoDescription.value
  const image = primaryImageUrl.value
  const url = canonicalUrl.value
  const meta: Array<{ name?: string; property?: string; content: string; key: string }> = [
    { name: 'description', content: description, key: 'description' },
    { property: 'og:type', content: 'article', key: 'og:type' },
    { property: 'og:title', content: pageDisplayTitle.value, key: 'og:title' },
    { property: 'og:description', content: description, key: 'og:description' },
    { name: 'twitter:card', content: image ? 'summary_large_image' : 'summary', key: 'twitter:card' },
    { name: 'twitter:title', content: pageDisplayTitle.value, key: 'twitter:title' },
    { name: 'twitter:description', content: description, key: 'twitter:description' }
  ]
  if (image) {
    meta.push({ property: 'og:image', content: image, key: 'og:image' })
    meta.push({ name: 'twitter:image', content: image, key: 'twitter:image' })
  }
  if (url) {
    meta.push({ property: 'og:url', content: url, key: 'og:url' })
  }
  const link = url ? [{ rel: 'canonical', href: url, key: 'canonical' }] : []
  return {
    title: pageDisplayTitle.value,
    meta,
    link
  }
})

const { data: pageVersions, pending: pageVersionsPending } = await useAsyncData(
  () => `page-versions-${wikidotId.value}`,
  () => $bff(`/pages/${wikidotId.value}/versions`, { params: { includeSource: false, limit: 100 } }),
  { watch: [() => route.params.wikidotId], server: false, lazy: true }
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
const diffViewMode = ref<'unified' | 'split'>('unified')
const diffCollapseUnchanged = ref(true)
const diffContextLines = ref(3)
const diffExpandedFoldIds = ref<string[]>([])
let diffJobSeq = 0
let diffScheduleHandle: ReturnType<typeof setTimeout> | null = null

type DiffLineType = 'context' | 'added' | 'removed'
interface DiffLine {
  kind: DiffLineType
  text: string
  oldLine: number | null
  newLine: number | null
}
interface DiffContextSegment {
  type: 'context'
  index: number
  lines: DiffLine[]
}
interface DiffChangeSegment {
  type: 'change'
  index: number
  removed: DiffLine[]
  added: DiffLine[]
}
type DiffSegment = DiffContextSegment | DiffChangeSegment

interface DiffPrepared {
  lines: DiffLine[]
  segments: DiffSegment[]
  stats: { added: number; removed: number; blocks: number }
}

interface DiffFoldRow {
  kind: 'fold'
  id: string
  skipped: number
  oldRange: [number, number] | null
  newRange: [number, number] | null
  isExpanded: boolean
}
interface DiffUnifiedLineRow {
  kind: 'line'
  key: string
  type: DiffLineType
  text: string
  oldLine: number | null
  newLine: number | null
}
type DiffUnifiedRow = DiffUnifiedLineRow | DiffFoldRow

interface DiffSplitCell {
  text: string
  line: number | null
}
interface DiffSplitLineRow {
  kind: 'line'
  key: string
  left: DiffSplitCell
  right: DiffSplitCell
  changeType: 'context' | 'added' | 'removed' | 'modified'
}
type DiffSplitRow = DiffSplitLineRow | DiffFoldRow

const diffData = ref<DiffPrepared | null>(null)

const diffSummary = computed(() => diffData.value?.stats ?? { added: 0, removed: 0, blocks: 0 })
const diffHasChanges = computed(() => diffSummary.value.blocks > 0)

watch(diffCollapseUnchanged, () => {
  diffExpandedFoldIds.value = []
})
watch(diffContextLines, (value) => {
  const numeric = Number(value)
  const normalized = Number.isFinite(numeric) ? Math.max(0, Math.min(20, Math.round(numeric))) : 0
  if (normalized !== diffContextLines.value) {
    diffContextLines.value = normalized
    return
  }
  diffExpandedFoldIds.value = []
})

const diffUnifiedRows = computed<DiffUnifiedRow[]>(() => {
  if (!diffData.value) return []
  return buildUnifiedRows(diffData.value.segments, {
    collapse: diffCollapseUnchanged.value,
    context: Math.max(0, Math.min(20, Math.round(Number(diffContextLines.value) || 0))),
    expanded: new Set(diffExpandedFoldIds.value),
    hasChanges: diffHasChanges.value
  })
})

const diffSplitRows = computed<DiffSplitRow[]>(() => {
  if (!diffData.value) return []
  return buildSplitRows(diffData.value.segments, {
    collapse: diffCollapseUnchanged.value,
    context: Math.max(0, Math.min(20, Math.round(Number(diffContextLines.value) || 0))),
    expanded: new Set(diffExpandedFoldIds.value),
    hasChanges: diffHasChanges.value
  })
})

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
  diffData.value = null
  diffExpandedFoldIds.value = []
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
    scheduleDiff()
  } else {
    // leaving diff
    if (diffScheduleHandle) {
      clearTimeout(diffScheduleHandle)
      diffScheduleHandle = null
    }
    diffLoading.value = false
    resetDiffResults()
  }
}

watch([baseVersionId, compareVersionId, () => ignoreWhitespace.value], () => {
  if (!diffMode.value) return
  scheduleDiff()
})

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
    diffLoading.value = false
    diffError.value = null
    diffData.value = null
    diffExpandedFoldIds.value = []
    return
  }
  const jobId = ++diffJobSeq
  diffLoading.value = true
  diffError.value = null
  diffData.value = null
  diffExpandedFoldIds.value = []
  try {
    const [baseText, compareText] = await Promise.all([
      getSourceForVersion(Number(baseVersionId.value)),
      getSourceForVersion(Number(compareVersionId.value))
    ])
    const diffLib: any = await import('diff')
    const parts = (diffLib?.diffLines || diffLib?.default?.diffLines)?.call(diffLib, String(baseText), String(compareText), {
      ignoreWhitespace: !!ignoreWhitespace.value
    }) || []
    if (jobId !== diffJobSeq) return
    diffData.value = Array.isArray(parts) ? prepareDiffData(parts) : { lines: [], segments: [], stats: { added: 0, removed: 0, blocks: 0 } }
  } catch (e:any) {
    if (jobId !== diffJobSeq) return
    diffError.value = '对比失败'
  } finally {
    if (jobId === diffJobSeq) diffLoading.value = false
  }
}

function scheduleDiff(immediate = false) {
  if (!diffMode.value) return
  if (diffScheduleHandle) {
    clearTimeout(diffScheduleHandle)
    diffScheduleHandle = null
  }
  if (immediate) {
    runDiff()
    return
  }
  diffScheduleHandle = setTimeout(() => {
    diffScheduleHandle = null
    runDiff()
  }, 120)
}

interface BuildDiffViewOptions {
  collapse: boolean
  context: number
  expanded: Set<string>
  hasChanges: boolean
}

function prepareDiffData(parts: Array<{ value: string; added?: boolean; removed?: boolean }>): DiffPrepared {
  let oldLine = 1
  let newLine = 1
  let added = 0
  let removed = 0
  const lines: DiffLine[] = []

  parts.forEach((part) => {
    const chunkLines = extractDiffLines(part)
    chunkLines.forEach((text) => {
      if (part?.added) {
        lines.push({ kind: 'added', text, oldLine: null, newLine })
        newLine += 1
        added += 1
      } else if (part?.removed) {
        lines.push({ kind: 'removed', text, oldLine, newLine: null })
        oldLine += 1
        removed += 1
      } else {
        lines.push({ kind: 'context', text, oldLine, newLine })
        oldLine += 1
        newLine += 1
      }
    })
  })

  const segments = buildSegments(lines)
  return {
    lines,
    segments,
    stats: {
      added,
      removed,
      blocks: segments.filter((seg) => seg.type === 'change').length
    }
  }
}

function extractDiffLines(part: { value?: string; added?: boolean; removed?: boolean; count?: number }): string[] {
  const raw = String(part?.value ?? '').replace(/\r/g, '')
  if (!raw) {
    return part?.added || part?.removed ? [''] : []
  }
  const lines = raw.split('\n')
  if (raw.endsWith('\n')) {
    lines.pop()
  }
  return lines.length ? lines : ['']
}

function buildSegments(lines: DiffLine[]): DiffSegment[] {
  type PendingSegment = { type: 'context'; lines: DiffLine[] } | { type: 'change'; removed: DiffLine[]; added: DiffLine[] }
  const segments: PendingSegment[] = []
  let contextBuffer: DiffLine[] = []
  let removedBuffer: DiffLine[] = []
  let addedBuffer: DiffLine[] = []

  const pushContext = () => {
    if (contextBuffer.length) {
      segments.push({ type: 'context', lines: contextBuffer })
      contextBuffer = []
    }
  }
  const pushChange = () => {
    if (removedBuffer.length || addedBuffer.length) {
      segments.push({ type: 'change', removed: removedBuffer, added: addedBuffer })
      removedBuffer = []
      addedBuffer = []
    }
  }

  lines.forEach((line) => {
    if (line.kind === 'context') {
      pushChange()
      contextBuffer.push(line)
    } else if (line.kind === 'removed') {
      pushContext()
      removedBuffer.push(line)
    } else if (line.kind === 'added') {
      pushContext()
      addedBuffer.push(line)
    }
  })

  pushChange()
  pushContext()

  return segments.map((seg, idx) => seg.type === 'context'
    ? { type: 'context', index: idx, lines: seg.lines }
    : { type: 'change', index: idx, removed: seg.removed, added: seg.added })
}

function buildUnifiedRows(segments: DiffSegment[], options: BuildDiffViewOptions): DiffUnifiedRow[] {
  const rows: DiffUnifiedRow[] = []
  if (!segments.length) return rows

  const { collapse, context, expanded, hasChanges } = options
  const changeAfter: boolean[] = new Array(segments.length).fill(false)
  let seenChangeAhead = false
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    changeAfter[i] = seenChangeAhead
    if (segments[i].type === 'change') {
      seenChangeAhead = true
    }
  }

  let seenChange = false
  let keyCounter = 0
  const pushLine = (line: DiffLine, override?: DiffLineType) => {
    rows.push({
      kind: 'line',
      key: `u-${keyCounter++}`,
      type: override ?? line.kind,
      text: line.text,
      oldLine: line.oldLine,
      newLine: line.newLine
    })
  }

  segments.forEach((segment) => {
    if (segment.type === 'change') {
      seenChange = true
      segment.removed.forEach((line) => pushLine(line, 'removed'))
      segment.added.forEach((line) => pushLine(line, 'added'))
      return
    }

    const lines = segment.lines
    if (!collapse || !hasChanges) {
      lines.forEach((line) => pushLine(line, 'context'))
      return
    }

    const keepBefore = seenChange ? context : 0
    const keepAfter = changeAfter[segment.index] ? context : 0
    if (keepBefore + keepAfter >= lines.length) {
      lines.forEach((line) => pushLine(line, 'context'))
      return
    }

    const head = keepBefore > 0 ? lines.slice(0, keepBefore) : []
    const tail = keepAfter > 0 ? lines.slice(lines.length - keepAfter) : []
    const hidden = lines.slice(keepBefore, lines.length - keepAfter)

    head.forEach((line) => pushLine(line, 'context'))
    if (hidden.length) {
      const foldRow = createFoldRow(`context-${segment.index}`, hidden, expanded)
      rows.push(foldRow)
      if (foldRow.isExpanded) {
        hidden.forEach((line) => pushLine(line, 'context'))
      }
    }
    tail.forEach((line) => pushLine(line, 'context'))
  })

  return rows
}

function buildSplitRows(segments: DiffSegment[], options: BuildDiffViewOptions): DiffSplitRow[] {
  const rows: DiffSplitRow[] = []
  if (!segments.length) return rows

  const { collapse, context, expanded, hasChanges } = options
  const changeAfter: boolean[] = new Array(segments.length).fill(false)
  let seenChangeAhead = false
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    changeAfter[i] = seenChangeAhead
    if (segments[i].type === 'change') {
      seenChangeAhead = true
    }
  }

  let seenChange = false
  let keyCounter = 0
  const pushContextRow = (line: DiffLine) => {
    rows.push({
      kind: 'line',
      key: `s-${keyCounter++}`,
      left: { text: line.text, line: line.oldLine },
      right: { text: line.text, line: line.newLine },
      changeType: 'context'
    })
  }

  segments.forEach((segment) => {
    if (segment.type === 'change') {
      seenChange = true
      const maxLen = Math.max(segment.removed.length, segment.added.length)
      for (let idx = 0; idx < maxLen; idx += 1) {
        const leftLine = segment.removed[idx]
        const rightLine = segment.added[idx]
        const changeType: 'added' | 'removed' | 'modified' = leftLine && rightLine
          ? 'modified'
          : leftLine
            ? 'removed'
            : 'added'
        rows.push({
          kind: 'line',
          key: `s-${keyCounter++}`,
          left: { text: leftLine ? leftLine.text : '', line: leftLine?.oldLine ?? null },
          right: { text: rightLine ? rightLine.text : '', line: rightLine?.newLine ?? null },
          changeType
        })
      }
      return
    }

    const lines = segment.lines
    if (!collapse || !hasChanges) {
      lines.forEach((line) => pushContextRow(line))
      return
    }

    const keepBefore = seenChange ? context : 0
    const keepAfter = changeAfter[segment.index] ? context : 0
    if (keepBefore + keepAfter >= lines.length) {
      lines.forEach((line) => pushContextRow(line))
      return
    }

    const head = keepBefore > 0 ? lines.slice(0, keepBefore) : []
    const tail = keepAfter > 0 ? lines.slice(lines.length - keepAfter) : []
    const hidden = lines.slice(keepBefore, lines.length - keepAfter)

    head.forEach((line) => pushContextRow(line))
    if (hidden.length) {
      const foldRow = createFoldRow(`context-${segment.index}`, hidden, expanded)
      rows.push(foldRow)
      if (foldRow.isExpanded) {
        hidden.forEach((line) => pushContextRow(line))
      }
    }
    tail.forEach((line) => pushContextRow(line))
  })

  return rows
}

function createFoldRow(id: string, lines: DiffLine[], expanded: Set<string>): DiffFoldRow {
  return {
    kind: 'fold',
    id,
    skipped: lines.length,
    oldRange: rangeFromLines(lines, 'oldLine'),
    newRange: rangeFromLines(lines, 'newLine'),
    isExpanded: expanded.has(id)
  }
}

function rangeFromLines(lines: DiffLine[], key: 'oldLine' | 'newLine'): [number, number] | null {
  const values = lines
    .map((line) => line[key])
    .filter((value): value is number => typeof value === 'number')
  if (!values.length) return null
  return [values[0], values[values.length - 1]]
}

function toggleDiffFold(id: string) {
  if (!id) return
  if (diffExpandedFoldIds.value.includes(id)) {
    diffExpandedFoldIds.value = diffExpandedFoldIds.value.filter((item) => item !== id)
  } else {
    diffExpandedFoldIds.value = [...diffExpandedFoldIds.value, id]
  }
}

function formatRange(range: [number, number] | null): string {
  if (!range) return '--'
  const [start, end] = range
  if (start == null || end == null) return '--'
  return start === end ? String(start) : `${start}-${end}`
}

// ===== Derived & UI helpers =====
const sourceUrlHttps = computed<string>(() => {
  const raw = String(page.value?.url || '')
  return raw.replace(/^http:\/\//i, 'https://')
})
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
  return formatDateUtc8(dateStr, { year: 'numeric', month: 'short', day: 'numeric' }) || 'N/A'
}
function formatDateCompact(dateStr: string) {
  if (!dateStr) return ''
  return formatDateIsoUtc8(dateStr)
}
function formatRelativeTime(dateStr: string) {
  if (!dateStr) return ''
  const diffDays = diffUtc8CalendarDays(new Date(), dateStr)
  if (diffDays == null) return ''
  if (diffDays === 0) return '今天'
  if (diffDays === 1) return '昨天'
  if (diffDays < 30) return `${diffDays} 天前`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)} 个月前`
  return `${Math.floor(diffDays / 365)} 年前`
}

function formatRevisionType(type: string) {
  const map:Record<string,string> = {
    'PAGE_CREATED':'创建页面','PAGE_EDITED':'编辑内容','PAGE_RENAMED':'重命名','PAGE_DELETED':'删除','PAGE_RESTORED':'恢复','METADATA_CHANGED':'修改元数据','TAGS_CHANGED':'修改标签','SOURCE_CHANGED':'编辑内容'
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
  if (t === 'SOURCE_CHANGED') {
    return 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
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

async function copyAnchorLink(sectionId?: string) {
  if (!isClient) return
  const hash = sectionId ? `#${sectionId}` : ''
  const basePath = route.fullPath.split('#')[0]
  const origin = window?.location?.origin || ''
  const url = `${origin}${basePath}${hash}`
  const mark = sectionId ?? PAGE_ANCHOR_KEY
  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(url)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = url
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.focus()
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    }
    copiedAnchorId.value = mark
    if (anchorCopyTimer) clearTimeout(anchorCopyTimer)
    anchorCopyTimer = setTimeout(() => {
      if (copiedAnchorId.value === mark) copiedAnchorId.value = null
    }, 2000)
  } catch (error) {
    console.warn('[page-detail] copy link failed', error)
    window.prompt('请复制链接', url)
  }
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

const copiedSource = ref(false)
async function copySourceUrl(){
  const url = sourceUrlHttps.value || ''
  if (!url) return
  try {
    await navigator.clipboard?.writeText(url)
    copiedSource.value = true
    setTimeout(() => { copiedSource.value = false }, 1200)
  } catch {}
}

// Tags - show all (ordered)
const allTags = computed(() => orderTags(Array.isArray(page.value?.tags) ? page.value!.tags : []))

// Votes derived
const upvotes = computed(() => Number(voteDistribution.value?.upvotes ?? stats.value?.uv ?? 0))
const downvotes = computed(() => Number(voteDistribution.value?.downvotes ?? stats.value?.dv ?? 0))
const totalVotes = computed(() => Math.max(0, upvotes.value + downvotes.value))
const upvotePct = computed(() => totalVotes.value ? (upvotes.value / totalVotes.value) * 100 : 0)
const downvotePct = computed(() => totalVotes.value ? (downvotes.value / totalVotes.value) * 100 : 0)
const likeRatioPct = computed(() => totalVotes.value ? (upvotes.value / totalVotes.value) * 100 : 0)
const totalScore = computed(() => {
  const distribution = voteDistribution.value as any
  if (distribution && distribution.upvotes != null && distribution.downvotes != null) {
    const up = Number(distribution.upvotes)
    const down = Number(distribution.downvotes)
    if (Number.isFinite(up) && Number.isFinite(down)) {
      return up - down
    }
  }

  const statsValue = stats.value as any
  if (statsValue && statsValue.hasStats) {
    const up = Number(statsValue.uv ?? 0)
    const down = Number(statsValue.dv ?? 0)
    if (Number.isFinite(up) && Number.isFinite(down)) {
      return up - down
    }
  }

  const fallback = Number(page.value?.rating ?? 0)
  return Number.isFinite(fallback) ? fallback : 0
})
const totalScoreDisplay = computed(() => {
  const value = totalScore.value
  return Number.isFinite(value) ? value.toFixed(0) : '0'
})

const totalViewsCount = computed(() => {
  const raw = Number((stats as any).value?.totalViews ?? 0)
  return Number.isFinite(raw) ? Math.max(0, raw) : 0
})
const todayViewsCount = computed(() => {
  const raw = Number((stats as any).value?.todayViews ?? 0)
  return Number.isFinite(raw) ? Math.max(0, raw) : 0
})
const totalViewsDisplay = computed(() => totalViewsCount.value.toLocaleString('zh-CN'))
const todayViewsDisplay = computed(() => todayViewsCount.value.toLocaleString('zh-CN'))

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
    a.download = `${pageDisplayTitle.value || 'source'}.txt`
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
  if (diffScheduleHandle) {
    clearTimeout(diffScheduleHandle)
    diffScheduleHandle = null
  }
  if (anchorCopyTimer) {
    clearTimeout(anchorCopyTimer)
    anchorCopyTimer = null
  }
})
</script>

<style scoped>
.source-code-block,
.source-code-block * {
  user-select: text;
  -webkit-user-select: text;
}

.diff-label {
  white-space: nowrap;
}

.diff-chip {
  transition: background-color 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
}

.diff-chip--toggles {
  align-items: flex-start;
}

@media (min-width: 640px) {
  .diff-chip--toggles {
    align-items: center;
  }
}

.diff-view-toggle__btn {
  border: none;
  cursor: pointer;
}

.diff-view-toggle__btn:focus-visible {
  outline: 2px solid rgba(var(--accent), 0.45);
  outline-offset: 1px;
}

.diff-select--narrow {
  max-width: 5.5rem;
}

@media (min-width: 640px) {
  .diff-select--narrow {
    max-width: 4.5rem;
  }
}

.page-images-grid {
  display: grid;
  gap: 1rem;
  grid-template-columns: repeat(var(--columns, 6), minmax(0, 1fr));
}

@media (max-width: 1024px) {
  .page-images-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .page-images-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 420px) {
  .page-images-grid {
    grid-template-columns: repeat(1, minmax(0, 1fr));
  }
}
</style>
