<template>
  <div class="space-y-6">
    <div class="flex items-center justify-between border-b-2 border-[var(--g-accent-medium)] dark:border-[var(--g-accent-strong)] pb-3">
      <div class="flex items-center gap-3">
        <div class="h-8 w-1 bg-[var(--g-accent)] rounded" />
        <h2 class="text-lg font-bold text-neutral-800 dark:text-neutral-100">搜索</h2>
      </div>
      <button 
        @click="showAdvanced = !showAdvanced"
        class="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium rounded-lg border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
      >
        <LucideIcon name="SlidersHorizontal" class="w-4 h-4" />
        {{ showAdvanced ? '简单搜索' : '高级搜索' }}
      </button>
    </div>

    <!-- 高级搜索面板 -->
    <div v-show="showAdvanced" class="bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg p-6 shadow-sm">
      <form @submit.prevent="performAdvancedSearch" class="space-y-4">
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- 搜索对象（用户/页面/全部） -->
          <div class="md:col-span-2">
            <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">搜索对象</label>
            <div class="segmented">
              <button type="button" :aria-pressed="searchForm.scope==='both'" @click="searchForm.scope='both'">全部</button>
              <button type="button" :aria-pressed="searchForm.scope==='users'" @click="searchForm.scope='users'">仅用户</button>
              <button type="button" :aria-pressed="searchForm.scope==='pages'" @click="searchForm.scope='pages'">仅页面</button>
              <button type="button" :aria-pressed="searchForm.scope==='forums'" @click="searchForm.scope='forums'">仅讨论区</button>
            </div>
            <p
              v-if="authorScopeAutoAdjusted"
              class="mt-2 text-xs text-amber-700 dark:text-amber-400"
            >
              作者筛选仅作用于页面搜索，已自动切换为“仅页面”。
            </p>
          </div>
          <!-- 关键词搜索 -->
          <div class="md:col-span-2">
            <div class="flex items-center justify-between mb-2">
              <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">关键词</label>
              <label v-show="searchForm.scope !== 'forums'" class="inline-flex items-center gap-1.5 cursor-pointer select-none">
                <input type="checkbox" v-model="searchForm.isRegex"
                  class="rounded border-neutral-300 dark:border-neutral-600 text-[var(--g-accent)] focus:ring-[var(--g-accent)]" />
                <span class="text-xs text-neutral-500 dark:text-neutral-400">正则搜索</span>
              </label>
            </div>
            <input
              v-model="searchForm.query"
              type="text"
              :placeholder="searchForm.isRegex ? '输入正则表达式，如 SCP-CN-\\d{3,4}' : '搜索页面标题或内容...'"
              class="w-full bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
            />
            <p v-if="regexError" class="text-xs text-red-500 mt-1">{{ regexError }}</p>
          </div>

          <!-- 标签过滤 -->
          <div v-show="searchForm.scope !== 'forums'" class="md:col-span-2">
            <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">标签</label>
            <div class="space-y-2">
              <!-- 包含标签 -->
              <div>
                <label class="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">包含标签</label>
                <div class="relative">
                  <input 
                    v-model="tagSearchQuery"
                    @input="searchTags"
                    @focus="showTagSuggestions = true"
                    @blur="hideTagSuggestions"
                    type="text"
                    placeholder="输入标签名搜索..."
                    class="w-full bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
                  />
                  <!-- Tag建议下拉 -->
                  <div v-if="showTagSuggestions && tagSuggestions.length > 0" class="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
                    <button
                      v-for="tag in tagSuggestions"
                      :key="tag.tag"
                      @click="addIncludeTag(tag.tag)"
                      type="button"
                      class="w-full text-left px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors border-b border-neutral-100 dark:border-neutral-800 last:border-b-0"
                    >
                      <div class="flex items-center justify-between gap-2">
                        <span class="text-sm text-neutral-800 dark:text-neutral-200 truncate min-w-0 flex-1">{{ tag.tag }}</span>
                        <span class="text-xs text-neutral-500 dark:text-neutral-400 shrink-0 ml-2">{{ tag.pageCount }} 页面</span>
                      </div>
                    </button>
                  </div>
                </div>
                <label class="mt-2 flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400 select-none">
                  <input
                    id="only-include-tags"
                    v-model="searchForm.onlyIncludeTags"
                    type="checkbox"
                    class="h-4 w-4 rounded border-neutral-300 dark:border-neutral-600 text-[var(--g-accent)] focus:ring-[var(--g-accent)]"
                  />
                  <span>仅包含</span>
                </label>
                <div v-if="searchForm.includeTags.length > 0" class="mt-2 space-y-1">
                  <div class="text-xs text-neutral-500 dark:text-neutral-400">
                    {{ searchForm.onlyIncludeTags ? '仅包含这些tag' : '包含这些tag' }}
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <span 
                      v-for="tag in searchForm.includeTags" 
                      :key="tag"
                      class="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 rounded text-sm"
                    >
                      #{{ tag }}
                      <button @click="removeIncludeTag(tag)" type="button" class="hover:text-blue-800 dark:hover:text-blue-300">
                        <LucideIcon name="X" class="w-3 h-3" />
                      </button>
                    </span>
                  </div>
                </div>
              </div>

              <!-- 排除标签 -->
              <div>
                <label class="block text-xs text-neutral-600 dark:text-neutral-400 mb-1">排除标签</label>
                <div class="relative">
                  <input 
                    v-model="excludeTagSearchQuery"
                    @input="searchExcludeTags"
                    @focus="showExcludeTagSuggestions = true"
                    @blur="hideExcludeTagSuggestions"
                    type="text"
                    placeholder="输入要排除的标签..."
                    class="w-full bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
                  />
                  <!-- 排除Tag建议下拉 -->
                  <div v-if="showExcludeTagSuggestions && excludeTagSuggestions.length > 0" class="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg shadow-lg z-50 max-h-48 overflow-y-auto">
                    <button
                      v-for="tag in excludeTagSuggestions"
                      :key="tag.tag"
                      @click="addExcludeTag(tag.tag)"
                      type="button"
                      class="w-full text-left px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors border-b border-neutral-100 dark:border-neutral-800 last:border-b-0"
                    >
                      <div class="flex items-center justify-between gap-2">
                        <span class="text-sm text-neutral-800 dark:text-neutral-200 truncate min-w-0 flex-1">{{ tag.tag }}</span>
                        <span class="text-xs text-neutral-500 dark:text-neutral-400 shrink-0 ml-2">{{ tag.pageCount }} 页面</span>
                      </div>
                    </button>
                  </div>
                </div>
                <div v-if="searchForm.excludeTags.length > 0" class="flex flex-wrap gap-2 mt-2">
                  <span 
                    v-for="tag in searchForm.excludeTags" 
                    :key="tag"
                    class="inline-flex items-center gap-1 px-2 py-1 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 rounded text-sm"
                  >
                    #{{ tag }}
                    <button @click="removeExcludeTag(tag)" type="button" class="hover:text-red-800 dark:hover:text-red-300">
                      <LucideIcon name="X" class="w-3 h-3" />
                    </button>
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- 作者过滤 -->
          <div v-show="searchForm.scope !== 'forums'" class="md:col-span-2">
            <div class="mb-2 flex items-center justify-between gap-2">
              <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">作者</label>
              <button
                v-if="searchForm.selectedAuthors.length > 0"
                type="button"
                class="text-xs text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                @click="clearSelectedAuthors"
              >
                清空
              </button>
            </div>
            <div class="space-y-2">
              <div class="relative">
                <input
                  v-model="authorSearchQuery"
                  @input="searchAuthors"
                  @focus="showAuthorSuggestions = true"
                  @blur="hideAuthorSuggestions"
                  @keydown.enter.prevent="handleAuthorEnter"
                  @keydown.esc.prevent="showAuthorSuggestions = false"
                  @keydown.backspace="handleAuthorBackspace"
                  type="text"
                  placeholder="输入作者名或 Wikidot ID..."
                  class="w-full bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
                />
                <div
                  v-if="showAuthorSuggestions && authorSuggestions.length > 0"
                  class="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg shadow-lg z-50 max-h-56 overflow-y-auto"
                >
                  <button
                    v-for="author in authorSuggestions"
                    :key="author.wikidotId"
                    type="button"
                    class="w-full text-left px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors border-b border-neutral-100 dark:border-neutral-800 last:border-b-0"
                    @click="addSelectedAuthor(author)"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-sm text-neutral-800 dark:text-neutral-200 truncate min-w-0 flex-1">{{ author.displayName }}</span>
                      <span class="text-xs text-neutral-500 dark:text-neutral-400 shrink-0">#{{ author.wikidotId }}</span>
                    </div>
                  </button>
                </div>
              </div>

              <div class="segmented segmented--sm">
                <button
                  type="button"
                  :aria-pressed="searchForm.authorMatch==='any'"
                  @click="searchForm.authorMatch='any'"
                >
                  任一匹配 (OR)
                </button>
                <button
                  type="button"
                  :aria-pressed="searchForm.authorMatch==='all'"
                  @click="searchForm.authorMatch='all'"
                >
                  全部匹配 (AND)
                </button>
              </div>

              <div v-if="searchForm.selectedAuthors.length > 0" class="flex flex-wrap gap-2">
                <span
                  v-for="author in searchForm.selectedAuthors"
                  :key="author.wikidotId"
                  class="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-900/20 dark:text-emerald-300"
                >
                  <span class="truncate max-w-[14rem]">{{ author.displayName }}</span>
                  <span class="text-[11px] opacity-80">#{{ author.wikidotId }}</span>
                  <button
                    type="button"
                    class="hover:text-emerald-900 dark:hover:text-emerald-100"
                    @click="removeSelectedAuthor(author.wikidotId)"
                  >
                    <LucideIcon name="X" class="w-3 h-3" />
                  </button>
                </span>
              </div>

              <p v-if="authorLimitReached" class="text-xs text-amber-600 dark:text-amber-400">
                最多可选择 {{ MAX_SELECTED_AUTHORS }} 位作者。
              </p>
            </div>
          </div>

          <!-- 分数范围 -->
          <div v-show="searchForm.scope !== 'forums'">
            <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">评分范围</label>
            <div class="flex items-center gap-2 min-w-0">
              <input 
                v-model="searchForm.ratingMin"
                type="number"
                placeholder="最低分"
                step="1"
                class="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
              />
              <span class="text-neutral-500 dark:text-neutral-400">至</span>
              <input 
                v-model="searchForm.ratingMax"
                type="number"
                placeholder="最高分"
                step="1"
                class="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
              />
            </div>
          </div>

          <!-- 页面状态 -->
          <div v-show="searchForm.scope !== 'forums'">
            <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">页面状态</label>
            <select
              v-model="searchForm.deletedFilter"
              class="w-full bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
            >
              <option value="any">全部页面</option>
              <option value="exclude">不看已删除页面</option>
              <option value="only">仅看已删除页面</option>
            </select>
          </div>

          <!-- 排序方式 -->
          <div v-show="searchForm.scope !== 'forums'" class="md:col-span-2">
            <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">排序方式</label>
            <select
              v-model="searchForm.orderBy"
              class="w-full bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
            >
              <option v-if="!searchForm.isRegex" value="relevance">相关性</option>
              <optgroup label="评分">
                <option value="rating">评分：高到低</option>
                <option value="rating_asc">评分：低到高</option>
              </optgroup>
              <optgroup label="日期">
                <option value="recent">日期：新到旧</option>
                <option value="recent_asc">日期：旧到新</option>
              </optgroup>
              <optgroup label="Wilson分数">
                <option value="wilson95">Wilson分数：高到低</option>
                <option value="wilson95_asc">Wilson分数：低到高</option>
              </optgroup>
              <optgroup label="争议度">
                <option value="controversy">争议度：高到低</option>
                <option value="controversy_asc">争议度：低到高</option>
              </optgroup>
              <optgroup label="评论数">
                <option value="comment_count">评论数：多到少</option>
                <option value="comment_count_asc">评论数：少到多</option>
              </optgroup>
              <optgroup label="投票数">
                <option value="vote_count">投票数：多到少</option>
                <option value="vote_count_asc">投票数：少到多</option>
              </optgroup>
            </select>
          </div>
        </div>

        <!-- 更多筛选条件（可折叠） -->
        <div v-show="searchForm.scope !== 'forums'" class="md:col-span-2">
          <button
            type="button"
            @click="showExtraFilters = !showExtraFilters"
            class="inline-flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors"
          >
            <LucideIcon :name="showExtraFilters ? 'ChevronDown' : 'ChevronRight'" class="w-4 h-4" />
            <span>更多筛选条件</span>
            <span v-if="extraFiltersCount > 0" class="ml-1 px-1.5 py-0.5 text-xs rounded-full bg-[var(--g-accent)] text-white">
              {{ extraFiltersCount }}
            </span>
          </button>

          <div v-show="showExtraFilters" class="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 pl-6 border-l-2 border-neutral-200 dark:border-neutral-700">
            <!-- Wilson分数范围 -->
            <div>
              <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                Wilson分数
                <span class="text-xs text-neutral-500 dark:text-neutral-400 font-normal ml-1" title="基于投票数和支持率计算的置信区间下界，范围0~1">(0~1)</span>
              </label>
              <div class="flex items-center gap-2 min-w-0">
                <input
                  v-model="searchForm.wilson95Min"
                  type="number"
                  placeholder="最低"
                  step="0.01"
                  min="0"
                  max="1"
                  class="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
                />
                <span class="text-neutral-500 dark:text-neutral-400">至</span>
                <input
                  v-model="searchForm.wilson95Max"
                  type="number"
                  placeholder="最高"
                  step="0.01"
                  min="0"
                  max="1"
                  class="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
                />
              </div>
            </div>

            <!-- 争议度范围 -->
            <div>
              <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                争议度
                <span class="text-xs text-neutral-500 dark:text-neutral-400 font-normal ml-1" title="反对票占比越高，争议度越高">(越高越有争议)</span>
              </label>
              <div class="flex items-center gap-2 min-w-0">
                <input
                  v-model="searchForm.controversyMin"
                  type="number"
                  placeholder="最低"
                  step="0.01"
                  min="0"
                  class="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
                />
                <span class="text-neutral-500 dark:text-neutral-400">至</span>
                <input
                  v-model="searchForm.controversyMax"
                  type="number"
                  placeholder="最高"
                  step="0.01"
                  min="0"
                  class="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
                />
              </div>
            </div>

            <!-- 评论数范围 -->
            <div>
              <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">评论数</label>
              <div class="flex items-center gap-2 min-w-0">
                <input
                  v-model="searchForm.commentCountMin"
                  type="number"
                  placeholder="最少"
                  step="1"
                  min="0"
                  class="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
                />
                <span class="text-neutral-500 dark:text-neutral-400">至</span>
                <input
                  v-model="searchForm.commentCountMax"
                  type="number"
                  placeholder="最多"
                  step="1"
                  min="0"
                  class="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
                />
              </div>
            </div>

            <!-- 投票数范围 -->
            <div>
              <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">投票数</label>
              <div class="flex items-center gap-2 min-w-0">
                <input
                  v-model="searchForm.voteCountMin"
                  type="number"
                  placeholder="最少"
                  step="1"
                  min="0"
                  class="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
                />
                <span class="text-neutral-500 dark:text-neutral-400">至</span>
                <input
                  v-model="searchForm.voteCountMax"
                  type="number"
                  placeholder="最多"
                  step="1"
                  min="0"
                  class="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
                />
              </div>
            </div>

            <!-- 日期范围 -->
            <div class="md:col-span-2">
              <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">创建日期</label>
              <div class="flex items-center gap-2 min-w-0">
                <input
                  v-model="searchForm.dateMin"
                  type="date"
                  class="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
                />
                <span class="text-neutral-500 dark:text-neutral-400">至</span>
                <input
                  v-model="searchForm.dateMax"
                  type="date"
                  class="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
                />
              </div>
            </div>
          </div>
        </div>

        <!-- 讨论区模式：日期过滤 + 作者过滤（提升为顶级） -->
        <div v-show="searchForm.scope === 'forums'" class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <!-- 讨论区作者过滤 -->
          <div class="md:col-span-2">
            <div class="mb-2 flex items-center justify-between gap-2">
              <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300">发帖用户</label>
              <button
                v-if="searchForm.selectedAuthors.length > 0"
                type="button"
                class="text-xs text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200"
                @click="clearSelectedAuthors"
              >
                清空
              </button>
            </div>
            <div class="space-y-2">
              <div class="relative">
                <input
                  v-model="authorSearchQuery"
                  @input="searchAuthors"
                  @focus="showAuthorSuggestions = true"
                  @blur="hideAuthorSuggestions"
                  @keydown.enter.prevent="handleAuthorEnter"
                  @keydown.esc.prevent="showAuthorSuggestions = false"
                  @keydown.backspace="handleAuthorBackspace"
                  type="text"
                  placeholder="输入用户名或 Wikidot ID..."
                  class="w-full bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
                />
                <div
                  v-if="showAuthorSuggestions && authorSuggestions.length > 0"
                  class="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 rounded-lg shadow-lg z-50 max-h-56 overflow-y-auto"
                >
                  <button
                    v-for="author in authorSuggestions"
                    :key="author.wikidotId"
                    type="button"
                    class="w-full text-left px-3 py-2 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors border-b border-neutral-100 dark:border-neutral-800 last:border-b-0"
                    @click="addSelectedAuthor(author)"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="text-sm text-neutral-800 dark:text-neutral-200 truncate min-w-0 flex-1">{{ author.displayName }}</span>
                      <span class="text-xs text-neutral-500 dark:text-neutral-400 shrink-0">#{{ author.wikidotId }}</span>
                    </div>
                  </button>
                </div>
              </div>

              <div v-if="searchForm.selectedAuthors.length > 0" class="flex flex-wrap gap-2">
                <span
                  v-for="author in searchForm.selectedAuthors"
                  :key="author.wikidotId"
                  class="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-xs text-emerald-700 dark:border-emerald-800/60 dark:bg-emerald-900/20 dark:text-emerald-300"
                >
                  <span class="truncate max-w-[14rem]">{{ author.displayName }}</span>
                  <span class="text-[11px] opacity-80">#{{ author.wikidotId }}</span>
                  <button
                    type="button"
                    class="hover:text-emerald-900 dark:hover:text-emerald-100"
                    @click="removeSelectedAuthor(author.wikidotId)"
                  >
                    <LucideIcon name="X" class="w-3 h-3" />
                  </button>
                </span>
              </div>

              <p v-if="authorLimitReached" class="text-xs text-amber-600 dark:text-amber-400">
                最多可选择 {{ MAX_SELECTED_AUTHORS }} 位用户。
              </p>
            </div>
          </div>

          <!-- 讨论区日期过滤 -->
          <div class="md:col-span-2">
            <label class="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">发帖日期</label>
            <div class="flex items-center gap-2 min-w-0">
              <input
                v-model="searchForm.dateMin"
                type="date"
                class="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
              />
              <span class="text-neutral-500 dark:text-neutral-400">至</span>
              <input
                v-model="searchForm.dateMax"
                type="date"
                class="flex-1 min-w-0 bg-white dark:bg-neutral-800 border border-neutral-300 dark:border-neutral-700 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-[var(--g-accent)] focus:border-transparent transition-all"
              />
            </div>
          </div>
        </div>

        <!-- 搜索按钮 -->
        <div class="flex items-center justify-between">
          <button
            @click="clearForm"
            type="button"
            class="px-4 py-2 text-sm font-medium text-neutral-600 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-200 transition-colors"
          >
            重置
          </button>
          <button
            type="submit"
            class="px-6 py-2 bg-[var(--g-accent)] text-white font-medium rounded-lg hover:bg-[rgb(var(--accent-strong))] transition-colors disabled:opacity-50"
            :disabled="!hasSearchCriteria()"
          >
            搜索
          </button>
        </div>
      </form>
    </div>

    <!-- 搜索结果显示 -->
    <div v-if="searchPerformed">
      <div v-if="initialLoading" class="text-sm text-neutral-600 dark:text-neutral-400">搜索中…</div>
      <div v-else-if="error" class="text-sm text-red-600 dark:text-red-400">搜索失败，请稍后重试</div>
      <div v-else>
        <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div v-if="searchForm.scope === 'forums'" class="text-sm text-neutral-600 dark:text-neutral-400">
            找到讨论区帖子 <span class="font-semibold text-[var(--g-accent)]">{{ totalForums }}</span>
          </div>
          <div v-else class="text-sm text-neutral-600 dark:text-neutral-400">
            找到用户 <span class="font-semibold text-[var(--g-accent)]">{{ totalUsers }}</span>
            ，页面 <span class="font-semibold text-[var(--g-accent)]">{{ totalPages }}</span>
          </div>
          <!--
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-medium text-neutral-600 shadow-sm transition hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
            :disabled="csvPending || pageResults.length === 0"
            @click="exportCsv"
          >
            <LucideIcon name="Download" class="h-3.5 w-3.5" stroke-width="1.6" />
            <span>{{ csvPending ? '导出中…' : '导出 CSV' }}</span>
          </button>
          -->
        </div>

        <div class="space-y-8">
          <section v-if="(searchForm.scope==='both' || searchForm.scope==='users') && (totalUsers > 0 || usersLoading)" class="space-y-3">
            <div class="flex items-center justify-between">
              <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">用户</div>
              <div class="text-[11px] text-neutral-400 dark:text-neutral-500">共 {{ totalUsers }}</div>
            </div>
            <div v-if="usersLoading && userResults.length === 0" class="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              <div v-for="i in 6" :key="`user-skel-${i}`" class="h-24 rounded-lg border border-neutral-200 bg-neutral-100/70 animate-pulse dark:border-neutral-800 dark:bg-neutral-800/40"></div>
            </div>
            <div v-else-if="userResults.length === 0" class="rounded-lg border border-dashed border-neutral-300 bg-neutral-50/80 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
              暂无用户符合条件。
            </div>
            <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              <UserCard
                v-for="u in userResults"
                :key="u.wikidotId || u.id"
                size="md"
                :wikidot-id="u.wikidotId"
                :display-name="u.displayName"
                :rank="u.rank"
                :totals="{ totalRating: u.totalRating, works: u.pageCount }"
              />
            </div>
            <div v-if="userLoadingMore" class="flex items-center justify-center text-xs text-neutral-500 dark:text-neutral-400">
              正在载入更多用户…
            </div>
            <div v-else-if="userHasMore" class="flex flex-col items-center gap-2">
              <button
                type="button"
                class="rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                @click="loadMoreUsers"
              >加载更多用户</button>
              <div ref="userSentinelRef" class="h-1 w-full"></div>
            </div>
          </section>

          <section v-if="(searchForm.scope==='both' || searchForm.scope==='pages')" class="space-y-4">
            <div class="flex items-center justify-between">
              <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">页面</div>
              <div class="text-[11px] text-neutral-400 dark:text-neutral-500">共 {{ totalPages }}</div>
            </div>
            <div v-if="pagesLoading && pageResults.length === 0" class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              <div v-for="i in 6" :key="`page-skel-${i}`" class="h-48 rounded-lg border border-neutral-200 bg-neutral-100/70 animate-pulse dark:border-neutral-800 dark:bg-neutral-800/40"></div>
            </div>
            <div v-else-if="pageResults.length === 0" class="rounded-lg border border-dashed border-neutral-300 bg-neutral-50/80 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
              暂无页面符合条件。
            </div>
            <div v-else>
              <div class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                <PageCard size="md" v-for="p in pageResults" :key="p.wikidotId || p.id" :p="p" />
              </div>
            </div>
            <div v-if="pageLoadingMore" class="flex items-center justify-center text-xs text-neutral-500 dark:text-neutral-400">
              正在载入更多页面…
            </div>
            <div v-else-if="pageHasMore" class="flex flex-col items-center gap-2">
              <button
                type="button"
                class="rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                @click="loadMorePages"
              >加载更多页面</button>
              <div ref="pageSentinelRef" class="h-1 w-full"></div>
            </div>
            <div v-else>
              <div ref="pageSentinelRef" class="h-0 w-full"></div>
            </div>
          </section>
          <section v-if="searchForm.scope==='forums'" class="space-y-4">
            <div class="flex items-center justify-between">
              <div class="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">讨论区</div>
              <div class="text-[11px] text-neutral-400 dark:text-neutral-500">共 {{ totalForums }}</div>
            </div>
            <div v-if="forumsLoading && forumResults.length === 0" class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              <div v-for="i in 6" :key="`forum-skel-${i}`" class="h-36 rounded-lg border border-neutral-200 bg-neutral-100/70 animate-pulse dark:border-neutral-800 dark:bg-neutral-800/40"></div>
            </div>
            <div v-else-if="forumResults.length === 0" class="rounded-lg border border-dashed border-neutral-300 bg-neutral-50/80 px-4 py-6 text-sm text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900/70 dark:text-neutral-300">
              暂无讨论区帖子符合条件。
            </div>
            <div v-else class="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              <NuxtLink
                v-for="post in forumResults"
                :key="post.postId || `${post.threadId}-${post.createdAt}`"
                :to="forumPostLink(post)"
                class="block rounded-lg border border-neutral-200 bg-white p-4 shadow-sm transition hover:border-[var(--g-accent-border)] hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900 dark:hover:border-neutral-700"
              >
                <div class="flex items-start gap-3">
                  <UserAvatar
                    v-if="post.createdByWikidotId"
                    :wikidot-id="post.createdByWikidotId"
                    :name="post.createdByName"
                    :size="32"
                    class="shrink-0 mt-0.5"
                  />
                  <div class="min-w-0 flex-1 space-y-1.5">
                    <h3 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100 line-clamp-1">
                      {{ post.title || post.threadTitle || '(无标题)' }}
                    </h3>
                    <div v-if="post.categoryTitle || post.threadTitle" class="text-xs text-neutral-500 dark:text-neutral-400 line-clamp-1">
                      <span v-if="post.categoryTitle">{{ post.categoryTitle }}</span>
                      <span v-if="post.categoryTitle && post.threadTitle"> › </span>
                      <span v-if="post.threadTitle">{{ post.threadTitle }}</span>
                    </div>
                    <p class="text-xs text-neutral-600 dark:text-neutral-300 line-clamp-2" v-html="highlightForumSnippet(post.textHtml, searchForm.query)"></p>
                    <div class="flex items-center gap-2 text-[11px] text-neutral-400 dark:text-neutral-500">
                      <span v-if="post.createdByName" class="font-medium text-neutral-500 dark:text-neutral-400">{{ post.createdByName }}</span>
                      <span v-if="post.createdAt">{{ formatForumDate(post.createdAt) }}</span>
                    </div>
                  </div>
                </div>
              </NuxtLink>
            </div>
            <div v-if="forumLoadingMore" class="flex items-center justify-center text-xs text-neutral-500 dark:text-neutral-400">
              正在载入更多帖子…
            </div>
            <div v-else-if="forumHasMore" class="flex flex-col items-center gap-2">
              <button
                type="button"
                class="rounded-full border border-neutral-200 bg-white/80 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-[var(--g-accent-border)] hover:text-[var(--g-accent)] dark:border-neutral-700 dark:bg-neutral-900/70 dark:text-neutral-300"
                @click="loadMoreForums"
              >加载更多帖子</button>
              <div ref="forumSentinelRef" class="h-1 w-full"></div>
            </div>
          </section>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useNuxtApp, useHead, useState } from 'nuxt/app'
import { orderTags } from '~/composables/useTagOrder'
import { useViewerVotes } from '~/composables/useViewerVotes'

const route = useRoute();
const router = useRouter();
const currentQueryKey = computed(() => route.fullPath || '')
import type { BffFetcher } from '~/types/nuxt-bff'
const { $bff } = useNuxtApp();
const bff = $bff as unknown as BffFetcher

type SearchAuthorOption = {
  wikidotId: number
  displayName: string
}

const MAX_SELECTED_AUTHORS = 10

// UI状态
const showAdvanced = ref(false);
const showExtraFilters = ref(false);
const searchPerformed = ref(false);
const initialLoading = ref(false);
const error = ref(false);
const regexError = ref('');
const authorScopeAutoAdjusted = ref(false);

// 高级搜索表单
const searchForm = ref({
  query: '',
  isRegex: false,
  includeTags: [] as string[],
  excludeTags: [] as string[],
  selectedAuthors: [] as SearchAuthorOption[],
  authorMatch: 'any' as 'any' | 'all',
  onlyIncludeTags: false,
  ratingMin: '',
  ratingMax: '',
  deletedFilter: 'exclude',
  orderBy: 'relevance',
  scope: 'both' as 'both' | 'users' | 'pages' | 'forums',
  // 新增过滤条件
  wilson95Min: '',
  wilson95Max: '',
  controversyMin: '',
  controversyMax: '',
  commentCountMin: '',
  commentCountMax: '',
  voteCountMin: '',
  voteCountMax: '',
  dateMin: '',
  dateMax: ''
});

// 计算已填写的高级过滤器数量
const extraFiltersCount = computed(() => {
  let count = 0;
  if (searchForm.value.wilson95Min || searchForm.value.wilson95Max) count++;
  if (searchForm.value.controversyMin || searchForm.value.controversyMax) count++;
  if (searchForm.value.commentCountMin || searchForm.value.commentCountMax) count++;
  if (searchForm.value.voteCountMin || searchForm.value.voteCountMax) count++;
  if (searchForm.value.dateMin || searchForm.value.dateMax) count++;
  return count;
});

// 正则模式切换时自动调整排序
watch(() => searchForm.value.isRegex, (val) => {
  if (val && searchForm.value.orderBy === 'relevance') {
    searchForm.value.orderBy = 'rating'
  }
  regexError.value = ''
})

// 切换到讨论区模式时禁用正则
watch(() => searchForm.value.scope, (val) => {
  if (val === 'forums' && searchForm.value.isRegex) {
    searchForm.value.isRegex = false
  }
})

const authorLimitReached = computed(() => searchForm.value.selectedAuthors.length >= MAX_SELECTED_AUTHORS)

function enforceScopeForAuthorFilter() {
  // 讨论区模式下作者过滤不影响 scope
  if (searchForm.value.scope === 'forums') {
    authorScopeAutoAdjusted.value = false
    return
  }
  if (searchForm.value.selectedAuthors.length === 0) {
    authorScopeAutoAdjusted.value = false
    return
  }
  if (searchForm.value.selectedAuthors.length > 0 && searchForm.value.scope === 'users') {
    searchForm.value.scope = 'pages'
    authorScopeAutoAdjusted.value = true
    return
  }
  if (authorScopeAutoAdjusted.value && searchForm.value.scope !== 'pages') {
    authorScopeAutoAdjusted.value = false
  }
}

watch(
  () => [searchForm.value.scope, searchForm.value.selectedAuthors.length],
  () => {
    enforceScopeForAuthorFilter()
  }
)

// Tag联想功能
const tagSearchQuery = ref('');
const excludeTagSearchQuery = ref('');
const tagSuggestions = ref<Array<{tag: string, pageCount: number}>>([]);
const excludeTagSuggestions = ref<Array<{tag: string, pageCount: number}>>([]);
const authorSearchQuery = ref('');
const authorSuggestions = ref<SearchAuthorOption[]>([]);
const showTagSuggestions = ref(false);
const showExcludeTagSuggestions = ref(false);
const showAuthorSuggestions = ref(false);
let tagSearchTimeout: NodeJS.Timeout | null = null;
let excludeTagSearchTimeout: NodeJS.Timeout | null = null;
let authorSearchTimeout: NodeJS.Timeout | null = null;
let tagRequestSeq = 0;
let excludeTagRequestSeq = 0;
let authorRequestSeq = 0;
const suggestionStabilizeDelay = 120;

const delay = (ms: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, ms);
});

// 搜索结果
const userResults = ref<any[]>([])
const pageResults = ref<any[]>([])
const forumResults = ref<any[]>([])
const totalUsers = ref(0)
const totalPages = ref(0)
const totalForums = ref(0)
const usersLoading = ref(false)
const pagesLoading = ref(false)
const forumsLoading = ref(false)
const USER_BATCH_SIZE = 12
const PAGE_BATCH_SIZE = 18
const FORUM_BATCH_SIZE = 20
const userOffset = ref(0)
const pageOffset = ref(0)
const forumOffset = ref(0)
const userHasMore = ref(false)
const pageHasMore = ref(false)
const forumHasMore = ref(false)
const userLoadingMore = ref(false)
const pageLoadingMore = ref(false)
const forumLoadingMore = ref(false)
const lastSearchParams = ref<Record<string, any>>({})
const searchCache = useState<{
  key: string
  pages: any[]
  users: any[]
  forums: any[]
  totalPages: number
  totalUsers: number
  totalForums: number
  pageOffset: number
  userOffset: number
  forumOffset: number
  pageHasMore: boolean
  userHasMore: boolean
  forumHasMore: boolean
  scrollY: number
}>('search-cache', () => ({
  key: '',
  pages: [] as any[],
  users: [] as any[],
  forums: [] as any[],
  totalPages: 0,
  totalUsers: 0,
  totalForums: 0,
  pageOffset: 0,
  userOffset: 0,
  forumOffset: 0,
  pageHasMore: false,
  userHasMore: false,
  forumHasMore: false,
  scrollY: 0
}))
const restoringScroll = ref(false)
const pageSentinelRef = ref<HTMLElement | null>(null)
const userSentinelRef = ref<HTMLElement | null>(null)
const forumSentinelRef = ref<HTMLElement | null>(null)
let pageObserver: IntersectionObserver | null = null
let userObserver: IntersectionObserver | null = null
let forumObserver: IntersectionObserver | null = null
// CSV export temporarily disabled.
// const csvPending = ref(false)
const { hydratePages } = useViewerVotes()
const isClient = typeof window !== 'undefined'

function normalizePage(p: any) {
  const toISODate = (v: any) => {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  };
  return {
    wikidotId: p.wikidotId,
    title: p.title,
    alternateTitle: p.alternateTitle,
    authors: p.authors,
    tags: orderTags(p.tags as string[] | null | undefined),
    rating: p.rating,
    wilson95: p.wilson95,
    commentCount: p.commentCount ?? p.revisionCount,
    controversy: p.controversy,
    snippetHtml: p.snippet || null,
    isDeleted: Boolean(p.isDeleted),
    deletedAt: p.deletedAt || null,
    createdDate: toISODate(p.firstRevisionAt || p.createdAt || p.validFrom)
  };
}

// Tag搜索功能
const searchTags = () => {
  if (tagSearchTimeout) {
    clearTimeout(tagSearchTimeout);
  }

  const query = tagSearchQuery.value.trim();
  if (query.length < 1) {
    tagSuggestions.value = [];
    return;
  }

  tagSearchTimeout = setTimeout(async () => {
    const requestId = ++tagRequestSeq;
    try {
      const resp = await bff('/search/tags', { params: { query, limit: 10 } });
      await delay(suggestionStabilizeDelay);
      if (requestId !== tagRequestSeq) return;
      tagSuggestions.value = resp.results || [];
    } catch (err) {
      console.error('搜索标签失败:', err);
      if (requestId === tagRequestSeq) {
        tagSuggestions.value = [];
      }
    }
  }, 300);
};

const searchExcludeTags = () => {
  if (excludeTagSearchTimeout) {
    clearTimeout(excludeTagSearchTimeout);
  }

  const query = excludeTagSearchQuery.value.trim();
  if (query.length < 1) {
    excludeTagSuggestions.value = [];
    return;
  }

  excludeTagSearchTimeout = setTimeout(async () => {
    const requestId = ++excludeTagRequestSeq;
    try {
      const resp = await bff('/search/tags', { params: { query, limit: 10 } });
      await delay(suggestionStabilizeDelay);
      if (requestId !== excludeTagRequestSeq) return;
      excludeTagSuggestions.value = resp.results || [];
    } catch (err) {
      console.error('搜索排除标签失败:', err);
      if (requestId === excludeTagRequestSeq) {
        excludeTagSuggestions.value = [];
      }
    }
  }, 300);
};

function normalizeAuthorOption(input: any): SearchAuthorOption | null {
  const wikidotId = Number(input?.wikidotId);
  if (!Number.isInteger(wikidotId) || wikidotId <= 0) return null;
  const displayName = String(input?.displayName || input?.username || `#${wikidotId}`).trim();
  return {
    wikidotId,
    displayName: displayName || `#${wikidotId}`
  };
}

function addSelectedAuthor(author: SearchAuthorOption) {
  if (!Number.isInteger(author.wikidotId) || author.wikidotId <= 0) return;
  const exists = searchForm.value.selectedAuthors.some((item) => item.wikidotId === author.wikidotId);
  if (exists) {
    const current = searchForm.value.selectedAuthors.find((item) => item.wikidotId === author.wikidotId);
    if (current && (!current.displayName || current.displayName.startsWith('#')) && author.displayName) {
      current.displayName = author.displayName;
    }
  } else {
    if (authorLimitReached.value) return;
    searchForm.value.selectedAuthors.push({
      wikidotId: author.wikidotId,
      displayName: author.displayName || `#${author.wikidotId}`
    });
  }
  authorSearchQuery.value = '';
  authorSuggestions.value = [];
  showAuthorSuggestions.value = false;
  enforceScopeForAuthorFilter();
}

function removeSelectedAuthor(wikidotId: number) {
  searchForm.value.selectedAuthors = searchForm.value.selectedAuthors.filter((item) => item.wikidotId !== wikidotId);
  enforceScopeForAuthorFilter();
}

function clearSelectedAuthors() {
  searchForm.value.selectedAuthors = [];
  authorSearchQuery.value = '';
  authorSuggestions.value = [];
  showAuthorSuggestions.value = false;
  authorScopeAutoAdjusted.value = false;
}

const searchAuthors = () => {
  if (authorSearchTimeout) {
    clearTimeout(authorSearchTimeout);
  }

  const query = authorSearchQuery.value.trim();
  if (query.length < 1) {
    authorSuggestions.value = [];
    return;
  }

  authorSearchTimeout = setTimeout(async () => {
    const requestId = ++authorRequestSeq;
    try {
      const resp = await bff('/search/users', { params: { query, limit: 8, includeTotal: false } });
      await delay(suggestionStabilizeDelay);
      if (requestId !== authorRequestSeq) return;
      const rows = Array.isArray(resp?.results) ? resp.results : [];
      const selectedIds = new Set(searchForm.value.selectedAuthors.map((item) => item.wikidotId));
      authorSuggestions.value = rows
        .map((row: unknown) => normalizeAuthorOption(row))
        .filter((item: SearchAuthorOption | null): item is SearchAuthorOption => item !== null)
        .filter((item: SearchAuthorOption) => !selectedIds.has(item.wikidotId))
        .slice(0, 8);
    } catch (err) {
      console.error('搜索作者失败:', err);
      if (requestId === authorRequestSeq) {
        authorSuggestions.value = [];
      }
    }
  }, 250);
};

const hideAuthorSuggestions = () => {
  setTimeout(() => {
    showAuthorSuggestions.value = false;
  }, 200);
};

function handleAuthorEnter() {
  if (authorSuggestions.value.length > 0) {
    addSelectedAuthor(authorSuggestions.value[0]);
    return;
  }
  const numericId = Number.parseInt(authorSearchQuery.value.trim(), 10);
  if (Number.isInteger(numericId) && numericId > 0) {
    addSelectedAuthor({ wikidotId: numericId, displayName: `#${numericId}` });
    void hydrateAuthorLabels([numericId]);
  }
}

function handleAuthorBackspace(event: KeyboardEvent) {
  if (authorSearchQuery.value.trim().length > 0) return;
  if (event.key !== 'Backspace') return;
  const last = searchForm.value.selectedAuthors[searchForm.value.selectedAuthors.length - 1];
  if (!last) return;
  removeSelectedAuthor(last.wikidotId);
}

async function hydrateAuthorLabels(ids: number[]) {
  const uniqueIds = Array.from(new Set(ids.filter((id) => Number.isInteger(id) && id > 0)));
  if (uniqueIds.length === 0) return;
  await Promise.all(uniqueIds.map(async (wikidotId) => {
    try {
      const row = await bff('/users/by-wikidot-id', { params: { wikidotId } });
      const normalized = normalizeAuthorOption(row);
      if (!normalized) return;
      const target = searchForm.value.selectedAuthors.find((item) => item.wikidotId === normalized.wikidotId);
      if (!target) return;
      target.displayName = normalized.displayName;
    } catch {
      // Ignore unresolved users.
    }
  }));
}

const hideTagSuggestions = () => {
  setTimeout(() => {
    showTagSuggestions.value = false;
  }, 200);
};

const hideExcludeTagSuggestions = () => {
  setTimeout(() => {
    showExcludeTagSuggestions.value = false;
  }, 200);
};

const addIncludeTag = (tag: string) => {
  if (!searchForm.value.includeTags.includes(tag)) {
    searchForm.value.includeTags.push(tag);
  }
  tagSearchQuery.value = '';
  tagSuggestions.value = [];
  showTagSuggestions.value = false;
};

const addExcludeTag = (tag: string) => {
  if (!searchForm.value.excludeTags.includes(tag)) {
    searchForm.value.excludeTags.push(tag);
  }
  excludeTagSearchQuery.value = '';
  excludeTagSuggestions.value = [];
  showExcludeTagSuggestions.value = false;
};

const removeIncludeTag = (tag: string) => {
  const index = searchForm.value.includeTags.indexOf(tag);
  if (index > -1) {
    searchForm.value.includeTags.splice(index, 1);
  }
};

const removeExcludeTag = (tag: string) => {
  const index = searchForm.value.excludeTags.indexOf(tag);
  if (index > -1) {
    searchForm.value.excludeTags.splice(index, 1);
  }
};

const clearForm = () => {
  searchForm.value = {
    query: '',
    isRegex: false,
    includeTags: [],
    excludeTags: [],
    selectedAuthors: [],
    authorMatch: 'any',
    onlyIncludeTags: false,
    ratingMin: '',
    ratingMax: '',
    deletedFilter: 'exclude',
    orderBy: 'relevance',
    scope: 'both',
    wilson95Min: '',
    wilson95Max: '',
    controversyMin: '',
    controversyMax: '',
    commentCountMin: '',
    commentCountMax: '',
    voteCountMin: '',
    voteCountMax: '',
    dateMin: '',
    dateMax: ''
  } as typeof searchForm.value;
  tagSearchQuery.value = '';
  excludeTagSearchQuery.value = '';
  authorSearchQuery.value = '';
  authorSuggestions.value = [];
  showAuthorSuggestions.value = false;
  authorScopeAutoAdjusted.value = false;
  showExtraFilters.value = false;
};

function hasSearchCriteria(): boolean {
  if (searchForm.value.scope === 'forums') {
    return Boolean(searchForm.value.query?.trim())
  }
  return Boolean(searchForm.value.query?.trim())
    || searchForm.value.includeTags.length > 0
    || searchForm.value.excludeTags.length > 0
    || searchForm.value.selectedAuthors.length > 0
    || Boolean(searchForm.value.ratingMin)
    || Boolean(searchForm.value.ratingMax)
    || Boolean(searchForm.value.wilson95Min)
    || Boolean(searchForm.value.wilson95Max)
    || Boolean(searchForm.value.controversyMin)
    || Boolean(searchForm.value.controversyMax)
    || Boolean(searchForm.value.commentCountMin)
    || Boolean(searchForm.value.commentCountMax)
    || Boolean(searchForm.value.voteCountMin)
    || Boolean(searchForm.value.voteCountMax)
    || Boolean(searchForm.value.dateMin)
    || Boolean(searchForm.value.dateMax)
    || searchForm.value.deletedFilter !== 'exclude'
}

function buildSearchParamsFromForm(includeDefaultsForOrder = false): Record<string, any> {
  const params: Record<string, any> = {}
  const query = searchForm.value.query.trim()
  if (query) params.query = query

  if (searchForm.value.scope && searchForm.value.scope !== 'both') {
    params.scope = searchForm.value.scope
  }

  // 讨论区模式只传 query + dateMin/dateMax + authorIds
  if (searchForm.value.scope === 'forums') {
    if (searchForm.value.dateMin) params.dateMin = searchForm.value.dateMin
    if (searchForm.value.dateMax) params.dateMax = searchForm.value.dateMax
    const authorIds = searchForm.value.selectedAuthors
      .map((author) => Number(author.wikidotId))
      .filter((id) => Number.isInteger(id) && id > 0)
    if (authorIds.length > 0) {
      params.authorIds = authorIds.map(String)
    }
    return params
  }

  if (searchForm.value.isRegex) params.isRegex = 'true'
  if (searchForm.value.includeTags.length > 0) params.tags = [...searchForm.value.includeTags]
  if (searchForm.value.onlyIncludeTags) params.onlyIncludeTags = 'true'
  if (searchForm.value.excludeTags.length > 0) params.excludeTags = [...searchForm.value.excludeTags]
  const authorIds = searchForm.value.selectedAuthors
    .map((author) => Number(author.wikidotId))
    .filter((id) => Number.isInteger(id) && id > 0)
  if (authorIds.length > 0) {
    params.authorIds = authorIds.map(String)
    if (searchForm.value.authorMatch === 'all') {
      params.authorMatch = 'all'
    }
  }
  if (searchForm.value.ratingMin) params.ratingMin = searchForm.value.ratingMin
  if (searchForm.value.ratingMax) params.ratingMax = searchForm.value.ratingMax
  // 新增过滤参数
  if (searchForm.value.wilson95Min) params.wilson95Min = searchForm.value.wilson95Min
  if (searchForm.value.wilson95Max) params.wilson95Max = searchForm.value.wilson95Max
  if (searchForm.value.controversyMin) params.controversyMin = searchForm.value.controversyMin
  if (searchForm.value.controversyMax) params.controversyMax = searchForm.value.controversyMax
  if (searchForm.value.commentCountMin) params.commentCountMin = searchForm.value.commentCountMin
  if (searchForm.value.commentCountMax) params.commentCountMax = searchForm.value.commentCountMax
  if (searchForm.value.voteCountMin) params.voteCountMin = searchForm.value.voteCountMin
  if (searchForm.value.voteCountMax) params.voteCountMax = searchForm.value.voteCountMax
  if (searchForm.value.dateMin) params.dateMin = searchForm.value.dateMin
  if (searchForm.value.dateMax) params.dateMax = searchForm.value.dateMax
  if (searchForm.value.deletedFilter) {
    params.deletedFilter = searchForm.value.deletedFilter
  }
  if (includeDefaultsForOrder || (searchForm.value.orderBy && searchForm.value.orderBy !== 'relevance')) {
    params.orderBy = searchForm.value.orderBy || 'relevance'
  }
  return params
}

// 搜索功能
async function fetchUsers(params: Record<string, any> | null = null, options: { append?: boolean } = {}) {
  const append = options.append ?? false
  const baseParams = params ?? lastSearchParams.value
  const offset = append ? userOffset.value : 0
  const includeTotal = offset === 0
  const limit = USER_BATCH_SIZE
  if (append) {
    userLoadingMore.value = true
  } else {
    usersLoading.value = true
  }
  try {
    const resp = await bff('/search/users', { params: { ...baseParams, limit, offset, includeTotal } })
    const rows = Array.isArray(resp?.results) ? resp.results : (Array.isArray(resp) ? resp : [])
    if (append && rows.length > 0) {
      userResults.value = userResults.value.concat(rows)
    } else if (!append) {
      userResults.value = rows
    }
    const fetched = rows.length
    const totalCandidate = resp?.total
    const parsedTotal = totalCandidate === undefined || totalCandidate === null ? null : Number(totalCandidate)
    const hasValidTotal = parsedTotal !== null && Number.isFinite(parsedTotal)
    const totalValue = hasValidTotal ? parsedTotal : null
    if (totalValue !== null) {
      totalUsers.value = totalValue
    } else if (!append) {
      totalUsers.value = rows.length
    }
    userOffset.value = offset + fetched
    userHasMore.value = totalValue !== null ? userOffset.value < totalValue : fetched === limit
  } catch (err: any) {
    console.error('搜索用户失败:', err)
    const errData = err?.data || err?.response?._data
    if (errData?.error === 'invalid_regex' || errData?.error === 'regex_timeout') {
      regexError.value = errData.message || '正则表达式错误'
    } else if (!append) {
      userResults.value = []
      totalUsers.value = 0
      error.value = true
    }
  } finally {
    if (append) {
      userLoadingMore.value = false
    } else {
      usersLoading.value = false
    }
    updateCache()
  }
}

async function fetchPages(params: Record<string, any> | null = null, options: { append?: boolean } = {}) {
  const append = options.append ?? false
  const baseParams = params ?? lastSearchParams.value
  const offset = append ? pageOffset.value : 0
  const includeTotal = offset === 0
  const limit = PAGE_BATCH_SIZE
  if (append) {
    pageLoadingMore.value = true
  } else {
    pagesLoading.value = true
  }
  try {
    const resp = await bff('/search/pages', {
      params: {
        ...baseParams,
        limit,
        offset,
        includeTotal,
        includeSnippet: true,
        includeDate: includeTotal
      }
    })
    const rowsRaw = Array.isArray(resp?.results) ? resp.results : (Array.isArray(resp) ? resp : [])
    const rows = rowsRaw.map(normalizePage)
    await hydratePages(rows)
    if (append && rows.length > 0) {
      pageResults.value = pageResults.value.concat(rows)
    } else if (!append) {
      pageResults.value = rows
    }
    const fetched = rows.length
    const totalCandidate = resp?.total
    const parsedTotal = totalCandidate === undefined || totalCandidate === null ? null : Number(totalCandidate)
    const hasValidTotal = parsedTotal !== null && Number.isFinite(parsedTotal)
    const totalValue = hasValidTotal ? parsedTotal : null
    if (totalValue !== null) {
      totalPages.value = totalValue
    } else if (!append) {
      totalPages.value = rows.length
    }
    pageOffset.value = offset + fetched
    pageHasMore.value = totalValue !== null ? pageOffset.value < totalValue : fetched === limit
  } catch (err: any) {
    console.error('搜索页面失败:', err)
    const errData = err?.data || err?.response?._data
    if (errData?.error === 'invalid_regex' || errData?.error === 'regex_timeout') {
      regexError.value = errData.message || '正则表达式错误'
    } else if (!append) {
      pageResults.value = []
      totalPages.value = 0
      error.value = true
    }
  } finally {
    if (append) {
      pageLoadingMore.value = false
    } else {
      pagesLoading.value = false
    }
    updateCache()
  }
}

function resetPagination() {
  userOffset.value = 0
  pageOffset.value = 0
  forumOffset.value = 0
  userHasMore.value = false
  pageHasMore.value = false
  forumHasMore.value = false
  userResults.value = []
  pageResults.value = []
  forumResults.value = []
  userLoadingMore.value = false
  pageLoadingMore.value = false
  forumLoadingMore.value = false
}

function updateCache() {
  searchCache.value = {
    key: currentQueryKey.value,
    pages: [...pageResults.value],
    users: [...userResults.value],
    forums: [...forumResults.value],
    totalPages: totalPages.value,
    totalUsers: totalUsers.value,
    totalForums: totalForums.value,
    pageOffset: pageOffset.value,
    userOffset: userOffset.value,
    forumOffset: forumOffset.value,
    pageHasMore: pageHasMore.value,
    userHasMore: userHasMore.value,
    forumHasMore: forumHasMore.value,
    scrollY: isClient ? window.scrollY : searchCache.value.scrollY
  }
}

function restoreFromCacheIfAvailable(key: string) {
  if (!key || searchCache.value.key !== key) return false
  pageResults.value = [...searchCache.value.pages]
  userResults.value = [...searchCache.value.users]
  forumResults.value = [...searchCache.value.forums]
  totalPages.value = searchCache.value.totalPages
  totalUsers.value = searchCache.value.totalUsers
  totalForums.value = searchCache.value.totalForums
  pageOffset.value = searchCache.value.pageOffset
  userOffset.value = searchCache.value.userOffset
  forumOffset.value = searchCache.value.forumOffset
  pageHasMore.value = searchCache.value.pageHasMore
  userHasMore.value = searchCache.value.userHasMore
  forumHasMore.value = searchCache.value.forumHasMore
  lastSearchParams.value = buildSearchParamsFromForm(true)
  searchPerformed.value = true
  initialLoading.value = false
  if (isClient) {
    restoringScroll.value = true
    nextTick(() => {
      window.scrollTo({ top: searchCache.value.scrollY || 0 })
      restoringScroll.value = false
    })
  }
  return true
}

async function loadMorePages() {
  if (!pageHasMore.value || pageLoadingMore.value || pagesLoading.value) return
  await fetchPages(null, { append: true })
}

async function loadMoreUsers() {
  if (!userHasMore.value || userLoadingMore.value || usersLoading.value) return
  await fetchUsers(null, { append: true })
}

// ─── Forum search ────────────────────────────────
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function stripHtml(html: string | null | undefined): string {
  if (!html) return ''
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/&[a-zA-Z]+;/g, ' ').replace(/\s+/g, ' ').trim()
}

function highlightForumSnippet(html: string | null | undefined, query: string): string {
  const text = stripHtml(html)
  if (!text) return ''

  const q = query.trim()
  if (!q) return escapeHtml(text.slice(0, 200)) + (text.length > 200 ? '…' : '')

  const lowerText = text.toLowerCase()
  const lowerQ = q.toLowerCase()
  const firstIdx = lowerText.indexOf(lowerQ)

  if (firstIdx === -1) {
    return escapeHtml(text.slice(0, 200)) + (text.length > 200 ? '…' : '')
  }

  // 前缀 3-5 个字符，确保关键词一定可见
  const prefixLen = Math.min(firstIdx, 5)
  const start = firstIdx - prefixLen
  const snippetLen = 200
  const end = Math.min(text.length, start + snippetLen)
  const snippet = text.slice(start, end)

  // 高亮片段内所有匹配
  const lowerSnippet = snippet.toLowerCase()
  let result = ''
  let pos = 0
  while (pos < snippet.length) {
    const matchPos = lowerSnippet.indexOf(lowerQ, pos)
    if (matchPos === -1) {
      result += escapeHtml(snippet.slice(pos))
      break
    }
    result += escapeHtml(snippet.slice(pos, matchPos))
    result += `<span class="keyword">${escapeHtml(snippet.slice(matchPos, matchPos + q.length))}</span>`
    pos = matchPos + q.length
  }

  if (start > 0) result = '…' + result
  if (end < text.length) result += '…'

  return result
}

function formatForumDate(dateStr: string | null | undefined): string {
  if (!dateStr) return ''
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function normalizeForumPost(post: any) {
  const postId = Number(post?.postId ?? post?.id)
  const threadId = Number(post?.threadId)
  return {
    ...post,
    postId: Number.isInteger(postId) && postId > 0 ? postId : null,
    threadId: Number.isInteger(threadId) && threadId > 0 ? threadId : null,
  }
}

function forumPostLink(post: any): string {
  const threadId = Number(post?.threadId)
  if (!Number.isInteger(threadId) || threadId <= 0) {
    return '/forums'
  }
  const postId = Number(post?.postId ?? post?.id)
  if (Number.isInteger(postId) && postId > 0) {
    return `/forums/t/${threadId}?postId=${postId}`
  }
  return `/forums/t/${threadId}`
}

async function fetchForumPosts(params: Record<string, any> | null = null, options: { append?: boolean } = {}) {
  const append = options.append ?? false
  const baseParams = params ?? lastSearchParams.value
  const offset = append ? forumOffset.value : 0
  const includeTotal = offset === 0
  const limit = FORUM_BATCH_SIZE
  if (append) {
    forumLoadingMore.value = true
  } else {
    forumsLoading.value = true
  }
  try {
    const resp = await bff('/search/forums', {
      params: {
        query: baseParams.query,
        dateMin: baseParams.dateMin || undefined,
        dateMax: baseParams.dateMax || undefined,
        authorIds: baseParams.authorIds || undefined,
        limit,
        offset,
        includeTotal,
      }
    })
    const rowsRaw = Array.isArray(resp?.results) ? resp.results : []
    const rows = rowsRaw
      .map(normalizeForumPost)
      .filter((post: any) => Number.isInteger(post.threadId) && post.threadId > 0)
    if (append && rows.length > 0) {
      forumResults.value = forumResults.value.concat(rows)
    } else if (!append) {
      forumResults.value = rows
    }
    const fetched = rows.length
    const parsedTotal = resp?.total !== undefined && resp?.total !== null ? Number(resp.total) : null
    const totalValue = parsedTotal !== null && Number.isFinite(parsedTotal) ? parsedTotal : null
    if (totalValue !== null) {
      totalForums.value = totalValue
    } else if (!append) {
      totalForums.value = rows.length
    }
    forumOffset.value = offset + fetched
    forumHasMore.value = totalValue !== null ? forumOffset.value < totalValue : fetched === limit
  } catch (err: any) {
    console.error('搜索讨论区失败:', err)
    const errData = err?.data || err?.response?._data
    if (errData?.error === 'query_too_short') {
      regexError.value = errData.message || '关键词至少需要 2 个字符'
    } else if (!append) {
      forumResults.value = []
      totalForums.value = 0
      error.value = true
    }
  } finally {
    if (append) {
      forumLoadingMore.value = false
    } else {
      forumsLoading.value = false
    }
    updateCache()
  }
}

async function loadMoreForums() {
  if (!forumHasMore.value || forumLoadingMore.value || forumsLoading.value) return
  await fetchForumPosts(null, { append: true })
}

// async function exportCsv() {
//   if (!pageResults.value.length) return
//   csvPending.value = true
//   try {
//     const headers = ['wikidotId', '标题', '别名', 'Rating', '评论数', '标签', '创建日期']
//     const rows = pageResults.value.map((p) => {
//       const id = p.wikidotId ?? ''
//       const title = (p.title || '').replace(/"/g, '""')
//       const alt = (p.alternateTitle || '').replace(/"/g, '""')
//       const rating = p.rating ?? ''
//       const comments = p.commentCount ?? ''
//       const tags = Array.isArray(p.tags) ? p.tags.join(' ') : ''
//       const created = p.createdDate || ''
//       return [id, `"${title}"`, alt ? `"${alt}"` : '', rating, comments, `"${tags.replace(/"/g, '""')}"`, created]
//     })
//     const csvContent = [headers.join(','), ...rows.map(row => row.join(','))].join('\n')
//     const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
//     const url = URL.createObjectURL(blob)
//     const link = document.createElement('a')
//     link.href = url
//     link.download = `search-results-${Date.now()}.csv`
//     document.body.appendChild(link)
//     link.click()
//     document.body.removeChild(link)
//     URL.revokeObjectURL(url)
//   } catch (err) {
//     console.error('导出 CSV 失败:', err)
//   } finally {
//     csvPending.value = false
//   }
// }

function setupPageObserver() {
  if (!isClient || typeof IntersectionObserver === 'undefined') return
  if (pageObserver) pageObserver.disconnect()
  pageObserver = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting)) {
      void loadMorePages()
    }
  }, { rootMargin: '320px 0px' })
  if (pageSentinelRef.value) pageObserver.observe(pageSentinelRef.value)
}

function setupUserObserver() {
  if (!isClient || typeof IntersectionObserver === 'undefined') return
  if (userObserver) userObserver.disconnect()
  userObserver = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting)) {
      void loadMoreUsers()
    }
  }, { rootMargin: '320px 0px' })
  if (userSentinelRef.value) userObserver.observe(userSentinelRef.value)
}

function setupForumObserver() {
  if (!isClient || typeof IntersectionObserver === 'undefined') return
  if (forumObserver) forumObserver.disconnect()
  forumObserver = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting)) {
      void loadMoreForums()
    }
  }, { rootMargin: '320px 0px' })
  if (forumSentinelRef.value) forumObserver.observe(forumSentinelRef.value)
}

watch(pageSentinelRef, (newEl, oldEl) => {
  if (!isClient || !pageObserver) return
  if (oldEl) pageObserver.unobserve(oldEl)
  if (newEl) pageObserver.observe(newEl)
})

watch(userSentinelRef, (newEl, oldEl) => {
  if (!isClient || !userObserver) return
  if (oldEl) userObserver.unobserve(oldEl)
  if (newEl) userObserver.observe(newEl)
})

watch(forumSentinelRef, (newEl, oldEl) => {
  if (!isClient || !forumObserver) return
  if (oldEl) forumObserver.unobserve(oldEl)
  if (newEl) forumObserver.observe(newEl)
})

onMounted(() => {
  setupPageObserver()
  setupUserObserver()
  setupForumObserver()
})

onBeforeUnmount(() => {
  if (tagSearchTimeout) {
    clearTimeout(tagSearchTimeout)
    tagSearchTimeout = null
  }
  if (excludeTagSearchTimeout) {
    clearTimeout(excludeTagSearchTimeout)
    excludeTagSearchTimeout = null
  }
  if (authorSearchTimeout) {
    clearTimeout(authorSearchTimeout)
    authorSearchTimeout = null
  }
  if (pageObserver) {
    pageObserver.disconnect()
    pageObserver = null
  }
  if (userObserver) {
    userObserver.disconnect()
    userObserver = null
  }
  if (forumObserver) {
    forumObserver.disconnect()
    forumObserver = null
  }
  if (isClient) {
    searchCache.value.scrollY = window.scrollY
  }
})

const performAdvancedSearch = () => {
  if (!hasSearchCriteria()) {
    return;
  }

  enforceScopeForAuthorFilter();

  // 若用户在输入框中输入了标签但未点击建议，仍然纳入搜索
  const pendingInclude = tagSearchQuery.value.trim();
  if (pendingInclude && !searchForm.value.includeTags.includes(pendingInclude)) {
    searchForm.value.includeTags.push(pendingInclude);
  }
  const pendingExclude = excludeTagSearchQuery.value.trim();
  if (pendingExclude && !searchForm.value.excludeTags.includes(pendingExclude)) {
    searchForm.value.excludeTags.push(pendingExclude);
  }

  const pendingAuthor = authorSearchQuery.value.trim();
  if (pendingAuthor) {
    if (authorSuggestions.value.length > 0) {
      addSelectedAuthor(authorSuggestions.value[0]);
    } else {
      const numericId = Number.parseInt(pendingAuthor, 10);
      if (Number.isInteger(numericId) && numericId > 0) {
        addSelectedAuthor({ wikidotId: numericId, displayName: `#${numericId}` });
        void hydrateAuthorLabels([numericId]);
      }
    }
  }

  const searchParams = buildSearchParamsFromForm();
  
  // 更新URL
  router.push({ path: '/search', query: searchParams });
};

function parseAuthorIdsFromQuery(raw: unknown): number[] {
  if (raw === undefined || raw === null || raw === '') return [];
  const values = Array.isArray(raw) ? raw : [raw];
  const parsed = values
    .flatMap((item) => String(item).split(','))
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isInteger(item) && item > 0);
  return Array.from(new Set(parsed));
}

// 根据URL参数初始化搜索
const initializeFromQuery = () => {
  const query = route.query
  const rawDeletedFilter = String(query.deletedFilter || '')
  const normalizedDeletedFilter = ['only', 'any', 'exclude'].includes(rawDeletedFilter) ? rawDeletedFilter : 'exclude'
  const rawScope = String(query.scope || 'both').toLowerCase()
  const normalizedScope = (['users','pages','both','forums'].includes(rawScope) ? rawScope : 'both') as 'users'|'pages'|'both'|'forums'
  const authorIdsFromQuery = parseAuthorIdsFromQuery(query.authorIds)
  const normalizedAuthorMatch = String(query.authorMatch || '').toLowerCase() === 'all' ? 'all' : 'any'
  const hasAdvancedParams = query.tags || query.excludeTags || query.ratingMin || query.ratingMax ||
    query.wilson95Min || query.wilson95Max || query.controversyMin || query.controversyMax ||
    query.commentCountMin || query.commentCountMax || query.voteCountMin || query.voteCountMax ||
    query.dateMin || query.dateMax || query.isRegex === 'true' ||
    (query.orderBy && query.orderBy !== 'relevance') || query.advanced ||
    String(query.onlyIncludeTags || '').toLowerCase() === 'true' ||
    normalizedDeletedFilter !== 'exclude' || normalizedScope !== 'both' ||
    authorIdsFromQuery.length > 0 || normalizedAuthorMatch === 'all'

  showAdvanced.value = Boolean(hasAdvancedParams || !query.q)

  // 如果URL中有高级过滤器参数，自动展开高级过滤器区域
  const hasExtraFilters = query.wilson95Min || query.wilson95Max ||
    query.controversyMin || query.controversyMax ||
    query.commentCountMin || query.commentCountMax ||
    query.voteCountMin || query.voteCountMax ||
    query.dateMin || query.dateMax
  showExtraFilters.value = Boolean(hasExtraFilters)

  searchForm.value.query = String((query as any).query ?? query.q ?? '')
  searchForm.value.isRegex = query.isRegex === 'true'
  searchForm.value.includeTags = query.tags ? (Array.isArray(query.tags) ? query.tags as string[] : [String(query.tags)]) : []
  searchForm.value.excludeTags = query.excludeTags ? (Array.isArray(query.excludeTags) ? query.excludeTags as string[] : [String(query.excludeTags)]) : []
  searchForm.value.selectedAuthors = authorIdsFromQuery.map((wikidotId) => ({ wikidotId, displayName: `#${wikidotId}` }))
  searchForm.value.authorMatch = normalizedAuthorMatch
  authorSearchQuery.value = ''
  authorSuggestions.value = []
  showAuthorSuggestions.value = false
  searchForm.value.onlyIncludeTags = ['true', '1', 'yes'].includes(String(query.onlyIncludeTags || '').toLowerCase())
  searchForm.value.ratingMin = String(query.ratingMin || '')
  searchForm.value.ratingMax = String(query.ratingMax || '')
  // 新增参数解析
  searchForm.value.wilson95Min = String(query.wilson95Min || '')
  searchForm.value.wilson95Max = String(query.wilson95Max || '')
  searchForm.value.controversyMin = String(query.controversyMin || '')
  searchForm.value.controversyMax = String(query.controversyMax || '')
  searchForm.value.commentCountMin = String(query.commentCountMin || '')
  searchForm.value.commentCountMax = String(query.commentCountMax || '')
  searchForm.value.voteCountMin = String(query.voteCountMin || '')
  searchForm.value.voteCountMax = String(query.voteCountMax || '')
  searchForm.value.dateMin = String(query.dateMin || '')
  searchForm.value.dateMax = String(query.dateMax || '')
  searchForm.value.deletedFilter = normalizedDeletedFilter
  searchForm.value.orderBy = String(query.orderBy || 'relevance')
  searchForm.value.scope = normalizedScope
  enforceScopeForAuthorFilter()
  if (authorIdsFromQuery.length > 0) {
    void hydrateAuthorLabels(authorIdsFromQuery)
  }

  if (restoreFromCacheIfAvailable(currentQueryKey.value)) {
    return
  }

  if (hasSearchCriteria()) {
    void performSearch()
  } else {
    resetPagination()
    totalUsers.value = 0
    totalPages.value = 0
    searchPerformed.value = true
    initialLoading.value = false
    updateCache()
  }
}

const performSearch = async () => {
  error.value = false
  regexError.value = ''
  enforceScopeForAuthorFilter()
  searchPerformed.value = true
  const hasAnyCondition = hasSearchCriteria()

  if (!hasAnyCondition) {
    resetPagination()
    totalUsers.value = 0
    totalPages.value = 0
    updateCache()
    return
  }

  initialLoading.value = true
  resetPagination()

  const routerParams = buildSearchParamsFromForm()
  const apiParams: Record<string, any> = { ...routerParams }
  apiParams.orderBy = searchForm.value.orderBy || 'relevance'
  lastSearchParams.value = apiParams

  try {
    const scope = searchForm.value.scope
    const hasQuery = Boolean(apiParams.query)
    if (scope === 'forums') {
      if (hasQuery) {
        await fetchForumPosts(apiParams, { append: false })
      } else {
        forumResults.value = []
        totalForums.value = 0
        forumOffset.value = 0
        forumHasMore.value = false
      }
      // 清空其他结果
      userResults.value = []
      totalUsers.value = 0
      pageResults.value = []
      totalPages.value = 0
    } else if (scope === 'users') {
      if (hasQuery) {
        await fetchUsers(apiParams, { append: false })
      } else {
        userResults.value = []
        totalUsers.value = 0
        userOffset.value = 0
        userHasMore.value = false
      }
      // 清空页面结果
      pageResults.value = []
      totalPages.value = 0
      pageOffset.value = 0
      pageHasMore.value = false
    } else if (scope === 'pages') {
      await fetchPages(apiParams, { append: false })
      // 清空用户结果
      userResults.value = []
      totalUsers.value = 0
      userOffset.value = 0
      userHasMore.value = false
    } else {
      // both
      if (hasQuery) {
        await Promise.all([
          fetchUsers(apiParams, { append: false }),
          fetchPages(apiParams, { append: false })
        ])
      } else {
        await fetchPages(apiParams, { append: false })
        userResults.value = []
        totalUsers.value = 0
        userOffset.value = 0
        userHasMore.value = false
      }
    }
  } finally {
    initialLoading.value = false
    updateCache()
  }
}

// 监听URL变化（使用 fullPath 更稳健，避免对象复用导致不触发）
watch(() => route.fullPath, () => {
  initializeFromQuery();
}, { immediate: true });

// 页面标题：根据搜索条件动态更新
const pageTitle = computed(() => {
  const q = (searchForm.value.query || '').trim()
  const hasTag = (searchForm.value.includeTags?.length || 0) > 0
  if (q && hasTag) return '搜索：' + q + '（含标签）'
  if (q) return '搜索：' + q
  if (hasTag) return '搜索：按标签'
  return '搜索'
})

useHead({ title: pageTitle });
</script>
