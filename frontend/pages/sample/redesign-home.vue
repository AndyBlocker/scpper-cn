<template>
  <div class="rd-app min-h-screen transition-colors duration-200" :class="isDark ? 'bg-neutral-950 text-neutral-100' : 'bg-neutral-50 text-neutral-900'">
    <nav
      class="sticky top-0 z-50 backdrop-blur-md border-b transition-colors duration-200"
      :class="isDark ? 'bg-neutral-900/80 border-neutral-800' : 'bg-white/80 border-neutral-200'"
    >
      <div class="max-w-7xl mx-auto px-4 sm:px-6">
        <div class="flex items-center justify-between h-14">
          <a
            @click.prevent="go('home')"
            class="flex items-center gap-2 hover:opacity-80 transition-opacity cursor-pointer"
          >
            <div class="w-7 h-7 rounded flex items-center justify-center" :class="isDark ? 'bg-white' : 'bg-neutral-900'">
              <span class="font-bold text-xs" :class="isDark ? 'text-neutral-900' : 'text-white'">SC</span>
            </div>
            <span class="font-semibold text-sm tracking-tight">SCPPER-CN</span>
          </a>

          <div class="hidden md:flex items-center gap-1">
            <a
              v-for="item in navItems"
              :key="item.id"
              @click.prevent="go(item.id)"
              class="px-3 py-1.5 rounded text-sm font-medium transition-colors cursor-pointer"
              :class="
                currentView === item.id
                  ? isDark
                    ? 'bg-neutral-800 text-neutral-100'
                    : 'bg-neutral-100 text-neutral-900'
                  : isDark
                    ? 'text-neutral-400 hover:text-neutral-100 hover:bg-neutral-900'
                    : 'text-neutral-600 hover:text-neutral-900 hover:bg-neutral-50'
              "
            >
              {{ item.label }}
            </a>
          </div>

          <div class="flex items-center gap-2">
            <button
              @click="go('search')"
              class="md:hidden h-8 w-8 flex items-center justify-center rounded transition-colors"
              :class="isDark ? 'hover:bg-neutral-800 text-neutral-300' : 'hover:bg-neutral-100 text-neutral-600'"
              aria-label="搜索"
            >
              <Search class="w-4 h-4" />
            </button>
            <button
              @click="toggleDark"
              class="h-8 w-8 flex items-center justify-center rounded transition-colors"
              :class="isDark ? 'hover:bg-neutral-800 text-neutral-300' : 'hover:bg-neutral-100 text-neutral-600'"
              aria-label="切换主题"
            >
              <Sun v-if="isDark" class="w-4 h-4" />
              <Moon v-else class="w-4 h-4" />
            </button>
            <button
              class="relative h-8 w-8 flex items-center justify-center rounded transition-colors"
              :class="isDark ? 'hover:bg-neutral-800 text-neutral-300' : 'hover:bg-neutral-100 text-neutral-600'"
              aria-label="通知"
            >
              <Bell class="w-4 h-4" />
              <span class="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full" :class="isDark ? 'bg-neutral-200' : 'bg-neutral-900'"></span>
            </button>
            <div
              @click="go('user', 10086)"
              class="w-7 h-7 rounded-full border flex items-center justify-center cursor-pointer transition-colors"
              :class="
                isDark
                  ? 'bg-neutral-800 border-neutral-700 hover:border-neutral-500 text-neutral-200'
                  : 'bg-neutral-100 border-neutral-200 hover:border-neutral-300 text-neutral-700'
              "
            >
              <span class="text-xs font-semibold">AB</span>
            </div>
            <button
              @click="mobileMenuOpen = !mobileMenuOpen"
              class="md:hidden h-8 w-8 flex items-center justify-center rounded transition-colors"
              :class="isDark ? 'hover:bg-neutral-800 text-neutral-300' : 'hover:bg-neutral-100 text-neutral-600'"
              aria-label="移动菜单"
            >
              <Menu v-if="!mobileMenuOpen" class="w-4 h-4" />
              <X v-else class="w-4 h-4" />
            </button>
          </div>
        </div>

        <div v-if="mobileMenuOpen" class="md:hidden py-3 border-t" :class="isDark ? 'border-neutral-800' : 'border-neutral-100'">
          <div class="space-y-1">
            <a
              v-for="item in navItems"
              :key="item.id"
              @click.prevent="go(item.id); mobileMenuOpen = false"
              class="block px-3 py-2 rounded text-sm font-medium transition-colors cursor-pointer"
              :class="
                currentView === item.id
                  ? isDark
                    ? 'bg-neutral-800 text-neutral-100'
                    : 'bg-neutral-100 text-neutral-900'
                  : isDark
                    ? 'text-neutral-300 hover:bg-neutral-900'
                    : 'text-neutral-600 hover:bg-neutral-50'
              "
            >
              {{ item.label }}
            </a>
          </div>
        </div>
      </div>
    </nav>

    <div v-if="currentView !== 'home'" class="max-w-6xl mx-auto px-4 sm:px-6 pt-4">
      <div class="flex items-center gap-1.5 text-sm" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">
        <a @click.prevent="go('home')" class="hover:text-current opacity-80 hover:opacity-100 cursor-pointer transition-opacity">首页</a>
        <ChevronRight class="w-3.5 h-3.5" />
        <span class="font-medium" :class="isDark ? 'text-neutral-200' : 'text-neutral-900'">{{ viewTitle }}</span>
      </div>
    </div>

    <main class="pb-16">
      <div v-if="viewLoading" class="max-w-6xl mx-auto px-4 sm:px-6 py-10">
        <div class="space-y-4 rounded-2xl border p-6" :class="isDark ? 'border-neutral-800 bg-neutral-900/50' : 'border-neutral-200 bg-white'">
          <div class="skeleton h-8 w-64"></div>
          <div class="skeleton h-4 w-96 max-w-full"></div>
          <div class="skeleton h-24 w-full"></div>
          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div class="skeleton h-24"></div>
            <div class="skeleton h-24"></div>
            <div class="skeleton h-24"></div>
          </div>
        </div>
      </div>

      <Transition name="fade" mode="out-in">
        <section v-if="currentView === 'home'" key="home" class="max-w-6xl mx-auto px-4 sm:px-6">
          <div class="pt-14 pb-12 text-center">
            <div
              class="inline-flex items-center justify-center w-14 h-14 rounded-xl mb-7"
              :class="isDark ? 'bg-neutral-100 text-neutral-900' : 'bg-neutral-900 text-white'"
            >
              <span class="text-2xl font-bold">SC</span>
            </div>
            <h1 class="text-4xl sm:text-5xl font-semibold tracking-tight mb-3">SCPPER-CN</h1>
            <p class="text-sm sm:text-base max-w-md mx-auto mb-8" :class="isDark ? 'text-neutral-400' : 'text-neutral-600'">
              SCP 中文分部数据分析平台，连接作者、读者与内容趋势。
            </p>

            <div class="search-hero mb-6">
              <Search class="search-icon w-5 h-5" />
              <input
                type="text"
                v-model="searchQuery"
                placeholder="搜索页面、用户、标签..."
                @keydown.enter="handleSearch"
              />
              <kbd class="search-kbd hidden sm:block">⌘K</kbd>
            </div>

            <div class="flex flex-wrap justify-center gap-2">
              <a
                v-for="link in quickLinks"
                :key="link.view"
                @click.prevent="go(link.view)"
                class="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border transition-all cursor-pointer"
                :class="
                  isDark
                    ? 'bg-neutral-900 border-neutral-700 text-neutral-200 hover:border-neutral-500'
                    : 'bg-white border-neutral-200 text-neutral-700 hover:bg-neutral-50 hover:border-neutral-300'
                "
              >
                {{ link.label }}
              </a>
            </div>
          </div>

          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 pb-10">
            <div
              v-for="card in statCards"
              :key="card.label"
              class="rounded-xl border p-5 text-center transition-colors"
              :class="isDark ? 'bg-neutral-900 border-neutral-800 hover:border-neutral-700' : 'bg-white border-neutral-200 hover:border-neutral-300'"
            >
              <div class="text-xs font-semibold uppercase tracking-wider mb-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ card.label }}</div>
              <div class="text-3xl font-semibold mb-2">{{ fmt(card.value) }}</div>
              <div class="text-xs" :class="isDark ? 'text-neutral-400' : 'text-neutral-500'" v-html="card.sub"></div>
            </div>
          </div>

          <div class="rounded-2xl p-8 mb-10 overflow-hidden relative" :class="isDark ? 'bg-neutral-900 border border-neutral-800' : 'bg-neutral-900'">
            <div class="absolute inset-0 pointer-events-none" :class="isDark ? 'bg-[radial-gradient(circle_at_85%_10%,rgba(255,255,255,0.08),transparent_45%)]' : 'bg-[radial-gradient(circle_at_85%_10%,rgba(255,255,255,0.2),transparent_45%)]'"></div>
            <div class="relative">
              <div class="flex items-center gap-2 mb-4">
                <span class="inline-flex items-center gap-2 px-3 py-1 text-xs font-semibold uppercase tracking-wider rounded-full border border-white/20 bg-white/10 text-white/90">
                  竞赛专题
                </span>
                <span class="text-xs text-white/50 uppercase tracking-wider">2026 冬季征文</span>
              </div>
              <h2 class="text-2xl sm:text-3xl font-semibold text-white mb-3">2026 冬季征文：循环</h2>
              <p class="text-sm text-white/75 max-w-2xl mb-6">
                专题页整合赛程节点、随机四篇、标签趋势和参赛作品榜单，帮助读者快速定位本届高分稿件。
              </p>
              <div class="flex flex-wrap gap-4 text-xs text-white/65 mb-6">
                <span>征文开始: 2026-02-17</span><span>•</span>
                <span>投稿截止: 2026-03-03</span><span>•</span>
                <span>计票截止: 2026-03-10</span>
              </div>
              <a
                @click.prevent="go('contest')"
                class="inline-flex items-center gap-2 px-5 py-3 text-sm font-semibold bg-white text-neutral-900 rounded-lg hover:bg-neutral-100 transition-colors cursor-pointer"
              >
                查看竞赛页
                <ArrowRight class="w-4 h-4" />
              </a>
            </div>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 pb-16">
            <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-semibold">热门页面</h3>
                <a @click.prevent="go('search')" class="text-sm cursor-pointer" :class="isDark ? 'text-neutral-400 hover:text-neutral-100' : 'text-neutral-500 hover:text-neutral-900'">查看全部</a>
              </div>
              <div class="space-y-1">
                <a
                  v-for="work in popularWorks"
                  :key="work.id"
                  @click.prevent="go('page', work.id)"
                  class="list-item"
                >
                  <div>
                    <div class="text-sm font-medium">{{ work.title }}</div>
                    <div class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ work.author }}</div>
                  </div>
                  <span class="badge-redesign" :class="work.rating >= 100 ? 'badge-positive' : ''">{{ signed(work.rating) }}</span>
                </a>
              </div>
            </div>

            <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <div class="flex items-center justify-between mb-4">
                <h3 class="text-lg font-semibold">活跃作者</h3>
                <a @click.prevent="go('ranking')" class="text-sm cursor-pointer" :class="isDark ? 'text-neutral-400 hover:text-neutral-100' : 'text-neutral-500 hover:text-neutral-900'">查看排行</a>
              </div>
              <div class="space-y-1">
                <a
                  v-for="(user, index) in activeUsers"
                  :key="user.id"
                  @click.prevent="go('user', user.id)"
                  class="list-item"
                >
                  <div class="flex items-center gap-3">
                    <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold" :class="isDark ? 'bg-neutral-800 text-neutral-300' : 'bg-neutral-100 text-neutral-600'">{{ index + 1 }}</div>
                    <div>
                      <div class="text-sm font-medium">{{ user.name }}</div>
                      <div class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ user.pages }} 作品</div>
                    </div>
                  </div>
                  <span class="text-sm font-mono" :class="isDark ? 'text-neutral-300' : 'text-neutral-600'">{{ fmt(user.score) }}</span>
                </a>
              </div>
            </div>
          </div>
        </section>

        <section v-else-if="currentView === 'ranking'" key="ranking" class="max-w-6xl mx-auto px-4 sm:px-6 py-8">
          <div class="flex flex-col gap-4 mb-6">
            <div class="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h1 class="text-2xl font-semibold mb-1">用户排行</h1>
                <p class="text-sm" :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">按分类查看贡献者分布，支持列排序与分页。</p>
              </div>
              <div class="flex items-center gap-2 text-sm">
                <label class="text-xs uppercase tracking-wide" :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">每页</label>
                <select
                  v-model.number="rankPageSize"
                  class="h-9 rounded-lg border px-3 text-sm"
                  :class="isDark ? 'bg-neutral-900 border-neutral-700 text-neutral-100' : 'bg-white border-neutral-200 text-neutral-900'"
                >
                  <option :value="20">20</option>
                  <option :value="50">50</option>
                  <option :value="100">100</option>
                </select>
              </div>
            </div>

            <div class="segment-control">
              <button
                v-for="tab in rankTabs"
                :key="tab.id"
                :class="{ active: rankTab === tab.id }"
                @click="rankTab = tab.id"
              >
                {{ tab.label }}
              </button>
            </div>
          </div>

          <div class="rounded-xl border overflow-hidden" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
            <div class="overflow-x-auto">
              <table class="table-redesign min-w-[880px]">
                <thead>
                  <tr>
                    <th class="w-16">排名</th>
                    <th @click="toggleRankSort('name')">
                      <div class="inline-flex items-center gap-1">
                        用户
                        <ChevronUp v-if="rankSort.key === 'name' && rankSort.direction === 'asc'" class="w-3.5 h-3.5" />
                        <ChevronDown v-if="rankSort.key === 'name' && rankSort.direction === 'desc'" class="w-3.5 h-3.5" />
                      </div>
                    </th>
                    <th @click="toggleRankSort('pages')" class="text-right">
                      <div class="inline-flex items-center gap-1 justify-end w-full">
                        作品数
                        <ChevronUp v-if="rankSort.key === 'pages' && rankSort.direction === 'asc'" class="w-3.5 h-3.5" />
                        <ChevronDown v-if="rankSort.key === 'pages' && rankSort.direction === 'desc'" class="w-3.5 h-3.5" />
                      </div>
                    </th>
                    <th @click="toggleRankSort('score')" class="text-right">
                      <div class="inline-flex items-center gap-1 justify-end w-full">
                        总评分
                        <ChevronUp v-if="rankSort.key === 'score' && rankSort.direction === 'asc'" class="w-3.5 h-3.5" />
                        <ChevronDown v-if="rankSort.key === 'score' && rankSort.direction === 'desc'" class="w-3.5 h-3.5" />
                      </div>
                    </th>
                    <th @click="toggleRankSort('avg')" class="text-right">
                      <div class="inline-flex items-center gap-1 justify-end w-full">
                        均分
                        <ChevronUp v-if="rankSort.key === 'avg' && rankSort.direction === 'asc'" class="w-3.5 h-3.5" />
                        <ChevronDown v-if="rankSort.key === 'avg' && rankSort.direction === 'desc'" class="w-3.5 h-3.5" />
                      </div>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="row in pagedRankingUsers" :key="row.id" @click="go('user', row.id)">
                    <td>
                      <span
                        v-if="row.rank <= 3"
                        class="rank-badge"
                        :class="row.rank === 1 ? 'rank-badge-gold' : row.rank === 2 ? 'rank-badge-silver' : 'rank-badge-bronze'"
                      >
                        {{ row.rank }}
                      </span>
                      <span v-else class="font-semibold" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">#{{ row.rank }}</span>
                    </td>
                    <td>
                      <div class="flex items-center gap-3">
                        <div class="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold" :class="isDark ? 'bg-neutral-800 text-neutral-200' : 'bg-neutral-100 text-neutral-700'">
                          {{ row.name.slice(0, 1).toUpperCase() }}
                        </div>
                        <div>
                          <div class="font-medium">{{ row.name }}</div>
                          <div class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">加入 {{ row.joined }}</div>
                        </div>
                      </div>
                    </td>
                    <td class="text-right">
                      <div class="font-medium">{{ row.pages }}</div>
                      <div class="progress-bar mt-1">
                        <div class="progress-fill" :style="{ width: `${Math.round((row.pages / rankMaxPages) * 100)}%`, background: 'var(--text-secondary)' }"></div>
                      </div>
                    </td>
                    <td class="text-right">
                      <div class="font-semibold">{{ fmt(row.activeScore) }}</div>
                      <div class="progress-bar mt-1">
                        <div class="progress-fill" :style="{ width: `${Math.round((row.activeScore / rankMaxScore) * 100)}%`, background: 'var(--status-positive)' }"></div>
                      </div>
                    </td>
                    <td class="text-right">{{ signed(row.avg) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div v-if="rankPager.totalPages.value > 1" class="flex items-center justify-center gap-1 mt-6">
            <button
              class="h-9 px-3 rounded-lg border text-sm inline-flex items-center gap-1"
              :class="buttonClass"
              @click="rankPager.prev"
              :disabled="rankPage <= 1"
            >
              <ChevronLeft class="w-4 h-4" /> 上页
            </button>
            <button
              v-for="pageNumber in rankPager.pageNumbers.value"
              :key="`ranking-page-${pageNumber}`"
              :disabled="pageNumber < 0"
              @click="pageNumber > 0 ? (rankPage = pageNumber) : null"
              class="h-9 min-w-9 px-3 rounded-lg border text-sm"
              :class="
                pageNumber === rankPage
                  ? isDark
                    ? 'bg-neutral-100 text-neutral-900 border-neutral-200'
                    : 'bg-neutral-900 text-white border-neutral-900'
                  : pageNumber < 0
                    ? 'border-transparent bg-transparent cursor-default'
                    : buttonClass
              "
            >
              {{ pageNumber < 0 ? '...' : pageNumber }}
            </button>
            <button
              class="h-9 px-3 rounded-lg border text-sm inline-flex items-center gap-1"
              :class="buttonClass"
              @click="rankPager.next"
              :disabled="rankPage >= rankPager.totalPages.value"
            >
              下页 <ChevronRight class="w-4 h-4" />
            </button>
          </div>
        </section>

        <section v-else-if="currentView === 'search'" key="search" class="max-w-6xl mx-auto px-4 sm:px-6 py-8">
          <div class="mb-6 space-y-4">
            <div class="relative group max-w-3xl">
              <Search class="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-neutral-400 group-focus-within:text-neutral-600 transition-colors" />
              <input
                ref="searchInput"
                type="text"
                v-model="searchQuery"
                placeholder="搜索页面、用户、标签、论坛主题..."
                class="w-full h-12 pl-12 pr-4 text-base rounded-xl border transition-all"
                :class="isDark ? 'bg-neutral-900 border-neutral-700 placeholder-neutral-500' : 'bg-white border-neutral-200 placeholder-neutral-400'"
              />
            </div>

            <div class="flex flex-wrap items-center gap-3">
              <div class="segment-control">
                <button
                  v-for="target in searchTargets"
                  :key="target.id"
                  :class="{ active: searchTarget === target.id }"
                  @click="setSearchTarget(target.id)"
                >
                  {{ target.label }}
                </button>
              </div>

              <button
                @click="showAdvanced = !showAdvanced"
                class="h-9 px-3 rounded-lg border text-sm inline-flex items-center gap-2"
                :class="buttonClass"
              >
                <SlidersHorizontal class="w-4 h-4" />
                {{ showAdvanced ? '收起高级' : '高级搜索' }}
              </button>
            </div>

            <div v-if="showAdvanced" class="advanced-panel space-y-4">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label>包含标签</label>
                  <div class="flex gap-2">
                    <input v-model="includeTagInput" @keydown.enter.prevent="pushSearchTag('include')" placeholder="输入后回车" />
                    <button class="h-9 px-3 rounded-lg border text-xs" :class="buttonClass" @click="pushSearchTag('include')">添加</button>
                  </div>
                  <div v-if="includeTags.length" class="flex flex-wrap gap-2 mt-2">
                    <span v-for="tag in includeTags" :key="`include-${tag}`" class="tag-pill">
                      #{{ tag }}
                      <span class="tag-pill-remove" @click="removeSearchTag('include', tag)">×</span>
                    </span>
                  </div>
                </div>

                <div>
                  <label>排除标签</label>
                  <div class="flex gap-2">
                    <input v-model="excludeTagInput" @keydown.enter.prevent="pushSearchTag('exclude')" placeholder="输入后回车" />
                    <button class="h-9 px-3 rounded-lg border text-xs" :class="buttonClass" @click="pushSearchTag('exclude')">添加</button>
                  </div>
                  <div v-if="excludeTags.length" class="flex flex-wrap gap-2 mt-2">
                    <span v-for="tag in excludeTags" :key="`exclude-${tag}`" class="tag-pill">
                      #{{ tag }}
                      <span class="tag-pill-remove" @click="removeSearchTag('exclude', tag)">×</span>
                    </span>
                  </div>
                </div>

                <div>
                  <label>作者过滤</label>
                  <input v-model="authorFilter" placeholder="按作者名模糊匹配" />
                </div>

                <div class="grid grid-cols-2 gap-2">
                  <div>
                    <label>最低评分</label>
                    <input v-model.number="scoreMin" type="number" placeholder="0" />
                  </div>
                  <div>
                    <label>最高评分</label>
                    <input v-model.number="scoreMax" type="number" placeholder="9999" />
                  </div>
                </div>

                <div>
                  <label>排序方式</label>
                  <select v-model="sortBy">
                    <option value="relevance">相关性</option>
                    <option value="ratingDesc">评分降序</option>
                    <option value="newest">日期最新</option>
                    <option value="wilson">Wilson 分数</option>
                  </select>
                </div>

                <div>
                  <label>页面状态</label>
                  <div class="flex flex-wrap gap-3 pt-2 text-sm" :class="isDark ? 'text-neutral-300' : 'text-neutral-700'">
                    <label class="inline-flex items-center gap-1.5 cursor-pointer">
                      <input v-model="pageStatus" type="radio" value="all" />
                      全部
                    </label>
                    <label class="inline-flex items-center gap-1.5 cursor-pointer">
                      <input v-model="pageStatus" type="radio" value="excludeDeleted" />
                      排除已删
                    </label>
                    <label class="inline-flex items-center gap-1.5 cursor-pointer">
                      <input v-model="pageStatus" type="radio" value="onlyDeleted" />
                      仅已删
                    </label>
                  </div>
                </div>
              </div>
            </div>

            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex gap-2">
                <button
                  v-for="tab in searchTabs"
                  :key="tab.id"
                  @click="searchTab = tab.id"
                  class="h-9 px-3 rounded-lg text-sm border transition-colors"
                  :class="
                    searchTab === tab.id
                      ? isDark
                        ? 'bg-neutral-100 text-neutral-900 border-neutral-100'
                        : 'bg-neutral-900 text-white border-neutral-900'
                      : buttonClass
                  "
                >
                  {{ tab.label }}
                </button>
              </div>
              <div class="text-sm" :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">共找到 {{ searchTotalResults }} 条结果</div>
            </div>
          </div>
          <div v-if="activeSearchKind === 'pages'" class="space-y-3">
            <a
              v-for="page in pagedPageSearchResults"
              :key="page.id"
              @click.prevent="go('page', page.id)"
              class="block rounded-xl border p-5 transition-colors cursor-pointer"
              :class="isDark ? 'bg-neutral-900 border-neutral-800 hover:border-neutral-700' : 'bg-white border-neutral-200 hover:border-neutral-300'"
            >
              <div class="flex items-start justify-between gap-3 mb-3">
                <div class="flex items-start gap-3 min-w-0">
                  <div class="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold" :class="isDark ? 'bg-neutral-800 text-neutral-200' : 'bg-neutral-100 text-neutral-700'">
                    {{ page.author.charAt(0).toUpperCase() }}
                  </div>
                  <div class="min-w-0">
                    <h3 class="text-sm font-semibold truncate">{{ page.title }}</h3>
                    <p class="text-xs mt-0.5" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">作者: {{ page.author }}</p>
                  </div>
                </div>
                <div class="flex items-center gap-2 flex-shrink-0">
                  <span class="badge-redesign" :class="page.rating > 100 ? 'badge-positive' : ''">{{ signed(page.rating) }}</span>
                  <span
                    v-if="page.status === 'deleted'"
                    class="px-2 py-0.5 text-xs rounded-full border"
                    :class="isDark ? 'bg-red-950/40 text-red-300 border-red-800' : 'bg-red-50 text-red-700 border-red-200'"
                  >
                    已删除
                  </span>
                </div>
              </div>
              <div class="flex flex-wrap gap-1.5 mb-3">
                <span v-for="tag in page.tags" :key="`${page.id}-${tag}`" class="tag-pill" @click.prevent.stop="go('tag', tag)">
                  <Hash class="w-3 h-3" /> {{ tag }}
                </span>
              </div>
              <p class="text-sm leading-6 line-clamp-2 mb-3" :class="isDark ? 'text-neutral-300' : 'text-neutral-600'">{{ page.excerpt }}</p>
              <div class="text-xs flex items-center gap-4" :class="isDark ? 'text-neutral-500' : 'text-neutral-400'">
                <span>{{ page.date }}</span>
                <span>Wilson {{ page.wilson.toFixed(2) }}</span>
              </div>
            </a>
          </div>

          <div v-else-if="activeSearchKind === 'users'" class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <a
              v-for="user in pagedUserSearchResults"
              :key="user.id"
              @click.prevent="go('user', user.id)"
              class="rounded-xl border p-5 transition-colors cursor-pointer"
              :class="isDark ? 'bg-neutral-900 border-neutral-800 hover:border-neutral-700' : 'bg-white border-neutral-200 hover:border-neutral-300'"
            >
              <div class="flex items-center gap-3 mb-3">
                <div class="w-10 h-10 rounded-full flex items-center justify-center text-sm font-semibold" :class="isDark ? 'bg-neutral-800 text-neutral-200' : 'bg-neutral-100 text-neutral-700'">
                  {{ user.name.slice(0, 2).toUpperCase() }}
                </div>
                <div>
                  <div class="font-semibold text-sm">{{ user.name }}</div>
                  <div class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">加入于 {{ user.joined }}</div>
                </div>
              </div>
              <div class="grid grid-cols-3 gap-2 text-center">
                <div class="rounded-lg p-2" :class="isDark ? 'bg-neutral-800' : 'bg-neutral-50'">
                  <div class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">作品</div>
                  <div class="text-sm font-semibold">{{ user.pages }}</div>
                </div>
                <div class="rounded-lg p-2" :class="isDark ? 'bg-neutral-800' : 'bg-neutral-50'">
                  <div class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">总评分</div>
                  <div class="text-sm font-semibold">{{ signed(user.totalScore) }}</div>
                </div>
                <div class="rounded-lg p-2" :class="isDark ? 'bg-neutral-800' : 'bg-neutral-50'">
                  <div class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">作品均分</div>
                  <div class="text-sm font-semibold">{{ signed(user.avgScore) }}</div>
                </div>
              </div>
            </a>
          </div>

          <div v-else-if="activeSearchKind === 'tags'" class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div
              v-for="tag in pagedTagSearchResults"
              :key="tag.name"
              class="rounded-xl border p-5"
              :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'"
            >
              <div class="flex items-center justify-between mb-2">
                <button class="inline-flex items-center gap-1 text-sm font-semibold hover:underline" @click="go('tag', tag.name)">
                  <Tag class="w-3.5 h-3.5" /> #{{ tag.name }}
                </button>
                <span class="text-xs" :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">{{ tag.pageCount }} 页</span>
              </div>
              <p class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">最近活跃：{{ tag.lastActive }}</p>
            </div>
          </div>

          <div v-else class="space-y-3">
            <div
              v-for="forum in pagedForumSearchResults"
              :key="forum.id"
              class="rounded-xl border p-5"
              :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'"
            >
              <div class="flex items-center justify-between gap-3 mb-2">
                <h3 class="text-sm font-semibold">{{ forum.title }}</h3>
                <span class="text-xs px-2 py-0.5 rounded-full border" :class="isDark ? 'bg-neutral-800 border-neutral-700 text-neutral-300' : 'bg-neutral-50 border-neutral-200 text-neutral-600'">
                  {{ forum.replies }} 回复
                </span>
              </div>
              <p class="text-sm mb-2" :class="isDark ? 'text-neutral-300' : 'text-neutral-600'">{{ forum.excerpt }}</p>
              <div class="text-xs flex items-center gap-4" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">
                <span>{{ forum.author }}</span>
                <span>{{ forum.lastActive }}</span>
              </div>
            </div>
          </div>

          <div v-if="searchTotalResults === 0" class="rounded-xl border p-10 text-center mt-4" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
            <Search class="w-8 h-8 mx-auto mb-3" :class="isDark ? 'text-neutral-500' : 'text-neutral-400'" />
            <div class="text-sm font-medium mb-1">未找到匹配结果</div>
            <p class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">尝试调整关键词或减少过滤条件。</p>
          </div>

          <div v-if="searchPager.totalPages.value > 1 && searchTotalResults > 0" class="flex items-center justify-center gap-1 mt-6">
            <button
              class="h-9 px-3 rounded-lg border text-sm inline-flex items-center gap-1"
              :class="buttonClass"
              @click="searchPager.prev"
              :disabled="searchPage <= 1"
            >
              <ChevronLeft class="w-4 h-4" /> 上页
            </button>
            <button
              v-for="pageNumber in searchPager.pageNumbers.value"
              :key="`search-page-${pageNumber}`"
              :disabled="pageNumber < 0"
              @click="pageNumber > 0 ? (searchPage = pageNumber) : null"
              class="h-9 min-w-9 px-3 rounded-lg border text-sm"
              :class="
                pageNumber === searchPage
                  ? isDark
                    ? 'bg-neutral-100 text-neutral-900 border-neutral-100'
                    : 'bg-neutral-900 text-white border-neutral-900'
                  : pageNumber < 0
                    ? 'border-transparent bg-transparent cursor-default'
                    : buttonClass
              "
            >
              {{ pageNumber < 0 ? '...' : pageNumber }}
            </button>
            <button
              class="h-9 px-3 rounded-lg border text-sm inline-flex items-center gap-1"
              :class="buttonClass"
              @click="searchPager.next"
              :disabled="searchPage >= searchPager.totalPages.value"
            >
              下页 <ChevronRight class="w-4 h-4" />
            </button>
          </div>
        </section>

        <section v-else-if="currentView === 'page'" key="page" class="max-w-6xl mx-auto px-4 sm:px-6 py-8">
          <article class="space-y-6">
            <div class="rounded-2xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <div class="flex flex-wrap items-start justify-between gap-4 mb-4">
                <div>
                  <div class="flex items-center flex-wrap gap-2 mb-2">
                    <span class="px-2.5 py-1 text-xs rounded-full border font-semibold" :class="isDark ? 'bg-neutral-100 text-neutral-900 border-neutral-100' : 'bg-neutral-900 text-white border-neutral-900'">
                      {{ currentPageType }}
                    </span>
                    <span
                      v-if="currentPage.deleted"
                      class="px-2.5 py-1 text-xs rounded-full border"
                      :class="isDark ? 'bg-red-950/40 text-red-300 border-red-800' : 'bg-red-50 text-red-700 border-red-200'"
                    >
                      已删除 {{ currentPage.deletedDate }}
                    </span>
                  </div>
                  <h1 class="text-2xl sm:text-3xl font-semibold tracking-tight mb-2">{{ currentPage.title }}</h1>
                  <div class="text-sm" :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">
                    页面 ID: <span class="font-mono">{{ currentPage.pageId }}</span>
                  </div>
                </div>

                <div class="flex flex-wrap gap-2">
                  <button class="h-9 px-3 rounded-lg border text-sm inline-flex items-center gap-2" :class="buttonClass" @click="copyId">
                    <Copy class="w-4 h-4" />
                    {{ copiedId ? '已复制' : '复制ID' }}
                  </button>
                  <a
                    :href="`https://scp-wiki-cn.wikidot.com/${currentPage.pageId.toLowerCase()}`"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="h-9 px-3 rounded-lg border text-sm inline-flex items-center gap-2"
                    :class="buttonClass"
                  >
                    <ExternalLink class="w-4 h-4" /> Wikidot
                  </a>
                  <button class="h-9 px-3 rounded-lg border text-sm inline-flex items-center gap-2" :class="buttonClass">
                    <Star class="w-4 h-4" /> 加入收藏夹
                  </button>
                </div>
              </div>

              <div class="flex flex-wrap gap-3 mb-4">
                <a
                  v-for="author in currentPage.authors"
                  :key="author.id"
                  @click.prevent="go('user', author.id)"
                  class="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm cursor-pointer"
                  :class="isDark ? 'bg-neutral-800 border-neutral-700 hover:border-neutral-500' : 'bg-neutral-50 border-neutral-200 hover:border-neutral-300'"
                >
                  <span class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-semibold" :class="isDark ? 'bg-neutral-900 text-neutral-200' : 'bg-white text-neutral-700 border border-neutral-200'">
                    {{ author.name.slice(0, 1).toUpperCase() }}
                  </span>
                  {{ author.name }}
                </a>
              </div>

              <div class="flex flex-wrap items-center gap-2 text-xs mb-3" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">
                <span>{{ currentPage.createdAt }}</span>
                <span>·</span>
                <span>修订 {{ currentPage.revisions }} 次</span>
                <span>·</span>
                <span>浏览 {{ fmt(currentPage.viewCount) }}（今日 +{{ currentPage.dailyViews }}）</span>
              </div>

              <div class="flex flex-wrap gap-1.5">
                <button v-for="tag in currentPage.tags" :key="`page-tag-${tag}`" class="tag-pill" @click="go('tag', tag)">
                  <Tag class="w-3 h-3" /> {{ tag }}
                </button>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
              <div class="rounded-xl border p-5" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
                <div class="text-xs mb-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">评分</div>
                <div class="text-3xl font-semibold mb-3">{{ signed(currentPage.rating) }}</div>
                <div class="text-xs flex items-center justify-between mb-2">
                  <span class="inline-flex items-center gap-1 text-emerald-500"><ThumbsUp class="w-3.5 h-3.5" />{{ fmt(currentPage.upvotes) }}</span>
                  <span class="inline-flex items-center gap-1 text-red-500"><ThumbsDown class="w-3.5 h-3.5" />{{ fmt(currentPage.downvotes) }}</span>
                </div>
                <div class="vote-bar">
                  <div class="vote-bar-positive" :style="{ width: `${Math.round(pageVoteRatio * 100)}%` }"></div>
                  <div class="vote-bar-negative" :style="{ width: `${Math.round((1 - pageVoteRatio) * 100)}%` }"></div>
                </div>
              </div>

              <div class="rounded-xl border p-5" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
                <div class="text-xs mb-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">支持率</div>
                <div class="text-3xl font-semibold mb-3">{{ (currentPage.supportRate * 100).toFixed(1) }}%</div>
                <div class="progress-bar">
                  <div class="progress-fill" :style="{ width: `${Math.round(currentPage.supportRate * 100)}%`, background: 'var(--status-positive)' }"></div>
                </div>
              </div>

              <div class="rounded-xl border p-5" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
                <div class="text-xs mb-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">Wilson 95%</div>
                <div class="text-3xl font-semibold mb-2">{{ currentPage.wilson.toFixed(2) }}</div>
                <p class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">稳健评分估计</p>
              </div>

              <div class="rounded-xl border p-5" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
                <div class="text-xs mb-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">争议指数</div>
                <div class="text-3xl font-semibold mb-2">{{ currentPage.controversy.toFixed(2) }}</div>
                <p class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">0 = 无争议</p>
              </div>
            </div>

            <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <div class="flex items-center justify-between mb-4">
                <h2 class="text-lg font-semibold">评分趋势（30 周）</h2>
                <span class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">样本更新至 2026-03-01</span>
              </div>
              <svg class="sparkline w-full h-44" viewBox="0 0 320 120" preserveAspectRatio="none">
                <polyline class="sparkline-stroke" :points="trendPolylinePoints" />
                <text x="0" y="112">30周前</text>
                <text x="287" y="112">本周</text>
              </svg>
            </div>

            <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
                <div class="flex items-center justify-between mb-4">
                  <h2 class="text-lg font-semibold">修订历史</h2>
                  <span class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ currentPage.revisionHistory.length }} 条</span>
                </div>
                <div class="overflow-x-auto">
                  <table class="table-redesign min-w-[520px]">
                    <thead>
                      <tr>
                        <th>类型</th>
                        <th>修订者</th>
                        <th>时间</th>
                        <th>备注</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="item in pagedRevisions" :key="`${item.time}-${item.editor}`">
                        <td>
                          <span :class="revisionTypeClass(item.type)">{{ revisionTypeLabel(item.type) }}</span>
                        </td>
                        <td>{{ item.editor }}</td>
                        <td>{{ item.time }}</td>
                        <td>{{ item.note }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <div v-if="revisionPager.totalPages.value > 1" class="flex items-center justify-center gap-1 mt-4">
                  <button class="h-8 px-2.5 rounded-lg border text-xs inline-flex items-center gap-1" :class="buttonClass" @click="revisionPager.prev" :disabled="pageRevisionPage <= 1">
                    <ChevronLeft class="w-3.5 h-3.5" />
                  </button>
                  <button
                    v-for="pageNumber in revisionPager.pageNumbers.value"
                    :key="`rev-page-${pageNumber}`"
                    :disabled="pageNumber < 0"
                    @click="pageNumber > 0 ? (pageRevisionPage = pageNumber) : null"
                    class="h-8 min-w-8 px-2 rounded-lg border text-xs"
                    :class="
                      pageNumber === pageRevisionPage
                        ? isDark
                          ? 'bg-neutral-100 text-neutral-900 border-neutral-100'
                          : 'bg-neutral-900 text-white border-neutral-900'
                        : pageNumber < 0
                          ? 'border-transparent bg-transparent cursor-default'
                          : buttonClass
                    "
                  >
                    {{ pageNumber < 0 ? '...' : pageNumber }}
                  </button>
                  <button class="h-8 px-2.5 rounded-lg border text-xs inline-flex items-center gap-1" :class="buttonClass" @click="revisionPager.next" :disabled="pageRevisionPage >= revisionPager.totalPages.value">
                    <ChevronRight class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>

              <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
                <div class="flex items-center justify-between mb-4">
                  <h2 class="text-lg font-semibold">最近投票</h2>
                  <span class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ currentPage.recentVotes.length }} 条</span>
                </div>

                <div class="space-y-2">
                  <div
                    v-for="vote in pagedVotes"
                    :key="`${vote.time}-${vote.userId}-${vote.direction}`"
                    class="rounded-lg border p-3 flex items-center justify-between"
                    :class="isDark ? 'bg-neutral-800/70 border-neutral-700' : 'bg-neutral-50 border-neutral-200'"
                  >
                    <div class="flex items-center gap-3">
                      <div class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold" :class="isDark ? 'bg-neutral-900 text-neutral-200' : 'bg-white text-neutral-700 border border-neutral-200'">
                        {{ vote.name.slice(0, 1).toUpperCase() }}
                      </div>
                      <div>
                        <div class="text-sm font-medium">{{ vote.name }}</div>
                        <div class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ vote.time }}</div>
                      </div>
                    </div>
                    <div class="text-sm font-semibold" :class="vote.direction === 'up' ? 'text-emerald-500' : 'text-red-500'">
                      {{ vote.direction === 'up' ? '↑ 支持' : '↓ 反对' }}
                    </div>
                  </div>
                </div>

                <div v-if="votePager.totalPages.value > 1" class="flex items-center justify-center gap-1 mt-4">
                  <button class="h-8 px-2.5 rounded-lg border text-xs inline-flex items-center gap-1" :class="buttonClass" @click="votePager.prev" :disabled="pageVotePage <= 1">
                    <ChevronLeft class="w-3.5 h-3.5" />
                  </button>
                  <button
                    v-for="pageNumber in votePager.pageNumbers.value"
                    :key="`vote-page-${pageNumber}`"
                    :disabled="pageNumber < 0"
                    @click="pageNumber > 0 ? (pageVotePage = pageNumber) : null"
                    class="h-8 min-w-8 px-2 rounded-lg border text-xs"
                    :class="
                      pageNumber === pageVotePage
                        ? isDark
                          ? 'bg-neutral-100 text-neutral-900 border-neutral-100'
                          : 'bg-neutral-900 text-white border-neutral-900'
                        : pageNumber < 0
                          ? 'border-transparent bg-transparent cursor-default'
                          : buttonClass
                    "
                  >
                    {{ pageNumber < 0 ? '...' : pageNumber }}
                  </button>
                  <button class="h-8 px-2.5 rounded-lg border text-xs inline-flex items-center gap-1" :class="buttonClass" @click="votePager.next" :disabled="pageVotePage >= votePager.totalPages.value">
                    <ChevronRight class="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <div class="flex items-center justify-between mb-4">
                <h2 class="text-lg font-semibold">相关推荐</h2>
                <button class="h-9 px-3 rounded-lg border text-sm inline-flex items-center gap-2" :class="buttonClass" @click="shuffleRelatedPages">
                  <Shuffle class="w-4 h-4" /> 刷新
                </button>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
                <a
                  v-for="related in currentPage.relatedPages"
                  :key="related.id"
                  @click.prevent="go('page', related.id)"
                  class="rounded-lg border p-4 transition-colors cursor-pointer"
                  :class="isDark ? 'bg-neutral-800 border-neutral-700 hover:border-neutral-500' : 'bg-neutral-50 border-neutral-200 hover:border-neutral-300'"
                >
                  <h3 class="text-sm font-semibold mb-1">{{ related.title }}</h3>
                  <p class="text-xs mb-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ related.author }}</p>
                  <span class="badge-redesign" :class="related.rating > 100 ? 'badge-positive' : ''">{{ signed(related.rating) }}</span>
                </a>
              </div>
            </div>
          </article>
        </section>

        <section v-else-if="currentView === 'user'" key="user" class="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
          <div class="rounded-2xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
            <div class="flex flex-col lg:flex-row gap-6">
              <div class="w-20 h-20 rounded-full border-2 flex items-center justify-center text-2xl font-semibold flex-shrink-0" :class="isDark ? 'bg-neutral-800 border-neutral-700 text-neutral-200' : 'bg-neutral-100 border-neutral-200 text-neutral-700'">
                {{ currentUser.name.slice(0, 1).toUpperCase() }}
              </div>

              <div class="flex-1 min-w-0">
                <div class="flex flex-wrap items-start justify-between gap-3 mb-4">
                  <div>
                    <h1 class="text-2xl font-semibold mb-1">{{ currentUser.name }}</h1>
                    <p class="text-sm" :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">加入于 {{ currentUser.joined }} · 最后活跃 {{ currentUser.lastActive }}</p>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    <span class="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-full border" :class="isDark ? 'bg-neutral-100 text-neutral-900 border-neutral-100' : 'bg-neutral-900 text-white border-neutral-900'">
                      综合排名 #{{ currentUser.rank }}
                    </span>
                    <a
                      :href="`https://scp-wiki-cn.wikidot.com/user:info/${currentUser.name.toLowerCase()}`"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="h-9 px-3 rounded-lg border text-sm inline-flex items-center gap-2"
                      :class="buttonClass"
                    >
                      <ExternalLink class="w-4 h-4" /> Wikidot
                    </a>
                    <button class="h-9 px-3 rounded-lg border text-sm inline-flex items-center gap-2" :class="buttonClass" @click="userFollowed = !userFollowed">
                      <Star class="w-4 h-4" :class="userFollowed ? 'fill-current' : ''" />
                      {{ userFollowed ? '已关注' : '关注' }}
                    </button>
                  </div>
                </div>

                <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
                  <div v-for="metric in userMetrics" :key="metric.label" class="rounded-lg p-3" :class="isDark ? 'bg-neutral-800' : 'bg-neutral-50'">
                    <div class="text-xs mb-1" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ metric.label }}</div>
                    <div class="text-lg font-semibold">{{ metric.value }}</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div class="rounded-xl border p-5" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <h2 class="text-sm font-semibold mb-3">首次活动</h2>
              <div class="text-sm mb-1">{{ currentUser.firstActivity.date }}</div>
              <div class="text-xs mb-1" :class="isDark ? 'text-neutral-400' : 'text-neutral-600'">{{ currentUser.firstActivity.type }}</div>
              <a class="text-xs hover:underline" @click.prevent="go('page', currentUser.firstActivity.pageId)">{{ currentUser.firstActivity.pageTitle }}</a>
              <p class="text-xs mt-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">投票方向: {{ currentUser.firstActivity.voteDirection }}</p>
            </div>
            <div class="rounded-xl border p-5" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <h2 class="text-sm font-semibold mb-3">最近活动</h2>
              <div class="text-sm mb-1">{{ currentUser.lastTimeline.date }}</div>
              <div class="text-xs mb-1" :class="isDark ? 'text-neutral-400' : 'text-neutral-600'">{{ currentUser.lastTimeline.type }}</div>
              <a class="text-xs hover:underline" @click.prevent="go('page', currentUser.lastTimeline.pageId)">{{ currentUser.lastTimeline.pageTitle }}</a>
              <p class="text-xs mt-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">活动说明: {{ currentUser.lastTimeline.note }}</p>
            </div>
          </div>

          <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
            <h2 class="text-lg font-semibold mb-4">分类表现</h2>
            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              <div
                v-for="category in currentUser.categories"
                :key="category.id"
                class="rounded-lg border p-4"
                :class="isDark ? 'bg-neutral-800 border-neutral-700' : 'bg-neutral-50 border-neutral-200'"
              >
                <div class="flex items-center justify-between mb-2">
                  <span class="text-sm font-medium">{{ category.label }}</span>
                  <span class="text-xs" :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">#{{ category.rank }}</span>
                </div>
                <div class="text-xs mb-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ category.works }} 作品 · {{ signed(category.score) }}</div>
                <div class="progress-bar">
                  <div class="progress-fill" :style="{ width: `${category.share}%`, background: 'var(--text-secondary)' }"></div>
                </div>
              </div>
            </div>
          </div>

          <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
            <h2 class="text-lg font-semibold mb-3">最爱标签</h2>
            <div class="flex gap-2 overflow-x-auto pb-2">
              <span v-for="tag in currentUser.favoriteTags" :key="`fav-tag-${tag}`" class="tag-pill whitespace-nowrap" @click="go('tag', tag)">
                <Hash class="w-3 h-3" /> {{ tag }}
              </span>
            </div>
          </div>

          <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
            <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div class="flex flex-wrap gap-2">
                <button
                  v-for="tab in userWorkTabs"
                  :key="tab.id"
                  @click="userWorksTab = tab.id"
                  class="h-9 px-3 rounded-lg border text-sm"
                  :class="
                    userWorksTab === tab.id
                      ? isDark
                        ? 'bg-neutral-100 text-neutral-900 border-neutral-100'
                        : 'bg-neutral-900 text-white border-neutral-900'
                      : buttonClass
                  "
                >
                  {{ tab.label }}
                </button>
              </div>
              <div class="flex items-center gap-2">
                <button
                  class="h-9 px-3 rounded-lg border text-sm"
                  :class="userWorksSort === 'time' ? activeSmallButtonClass : buttonClass"
                  @click="userWorksSort = 'time'"
                >
                  按时间
                </button>
                <button
                  class="h-9 px-3 rounded-lg border text-sm"
                  :class="userWorksSort === 'rating' ? activeSmallButtonClass : buttonClass"
                  @click="userWorksSort = 'rating'"
                >
                  按评分
                </button>
              </div>
            </div>

            <div v-if="pagedUserWorks.length" class="space-y-2">
              <a
                v-for="work in pagedUserWorks"
                :key="`work-${work.id}`"
                @click.prevent="go('page', work.id)"
                class="rounded-lg border p-4 flex items-center justify-between gap-3 cursor-pointer"
                :class="isDark ? 'bg-neutral-800 border-neutral-700 hover:border-neutral-500' : 'bg-neutral-50 border-neutral-200 hover:border-neutral-300'"
              >
                <div class="min-w-0">
                  <div class="text-sm font-medium truncate">{{ work.title }}</div>
                  <div class="text-xs mt-1" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ work.date }}</div>
                  <div class="flex flex-wrap gap-1.5 mt-2">
                    <span v-for="tag in work.tags" :key="`${work.id}-${tag}`" class="tag-pill" @click.prevent.stop="go('tag', tag)">{{ tag }}</span>
                  </div>
                </div>
                <span class="badge-redesign" :class="work.rating > 100 ? 'badge-positive' : ''">{{ signed(work.rating) }}</span>
              </a>
            </div>
            <div v-else class="rounded-lg border p-10 text-center" :class="isDark ? 'bg-neutral-800 border-neutral-700' : 'bg-neutral-50 border-neutral-200'">
              <FileText class="w-7 h-7 mx-auto mb-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-400'" />
              <p class="text-sm">暂无数据</p>
            </div>

            <div v-if="userWorksPager.totalPages.value > 1" class="flex items-center justify-center gap-1 mt-4">
              <button class="h-8 px-2.5 rounded-lg border text-xs inline-flex items-center gap-1" :class="buttonClass" @click="userWorksPager.prev" :disabled="userWorksPage <= 1">
                <ChevronLeft class="w-3.5 h-3.5" />
              </button>
              <button
                v-for="pageNumber in userWorksPager.pageNumbers.value"
                :key="`user-work-page-${pageNumber}`"
                :disabled="pageNumber < 0"
                @click="pageNumber > 0 ? (userWorksPage = pageNumber) : null"
                class="h-8 min-w-8 px-2 rounded-lg border text-xs"
                :class="
                  pageNumber === userWorksPage
                    ? isDark
                      ? 'bg-neutral-100 text-neutral-900 border-neutral-100'
                      : 'bg-neutral-900 text-white border-neutral-900'
                    : pageNumber < 0
                      ? 'border-transparent bg-transparent cursor-default'
                      : buttonClass
                "
              >
                {{ pageNumber < 0 ? '...' : pageNumber }}
              </button>
              <button class="h-8 px-2.5 rounded-lg border text-xs inline-flex items-center gap-1" :class="buttonClass" @click="userWorksPager.next" :disabled="userWorksPage >= userWorksPager.totalPages.value">
                <ChevronRight class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div class="rounded-xl border p-5" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <h3 class="text-sm font-semibold mb-3">最喜欢的作者</h3>
              <div class="space-y-2">
                <div v-for="author in currentUser.favoriteAuthors" :key="author.name" class="flex items-center justify-between text-sm">
                  <span>{{ author.name }}</span>
                  <span :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">{{ author.count }} 次</span>
                </div>
              </div>
            </div>
            <div class="rounded-xl border p-5" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <h3 class="text-sm font-semibold mb-3">粉丝</h3>
              <div class="space-y-2">
                <div v-for="fan in currentUser.fans" :key="fan.name" class="flex items-center justify-between text-sm">
                  <span>{{ fan.name }}</span>
                  <span :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">{{ fan.count }} 互动</span>
                </div>
              </div>
            </div>
            <div class="rounded-xl border p-5" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <h3 class="text-sm font-semibold mb-3">最爱标签</h3>
              <div class="space-y-2">
                <div v-for="tag in currentUser.lovedTags" :key="tag.name" class="flex items-center justify-between text-sm">
                  <span>#{{ tag.name }}</span>
                  <span :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">{{ tag.count }}</span>
                </div>
              </div>
            </div>
            <div class="rounded-xl border p-5" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <h3 class="text-sm font-semibold mb-3">最不喜欢标签</h3>
              <div class="space-y-2">
                <div v-for="tag in currentUser.hatedTags" :key="tag.name" class="flex items-center justify-between text-sm">
                  <span>#{{ tag.name }}</span>
                  <span :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">{{ tag.count }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
            <h2 class="text-lg font-semibold mb-3">活跃热力图</h2>
            <div class="grid grid-rows-7 grid-flow-col gap-1 overflow-x-auto pb-2">
              <div
                v-for="(cell, index) in currentUser.heatmapData"
                :key="`heat-${index}`"
                class="heatmap-cell"
                :class="cell > 0 ? `heatmap-cell-${Math.min(cell, 4)}` : ''"
              ></div>
            </div>
          </div>

          <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
            <h2 class="text-lg font-semibold mb-4">公开收藏夹</h2>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div
                v-for="collection in currentUser.collections"
                :key="collection.name"
                class="rounded-lg border p-4"
                :class="isDark ? 'bg-neutral-800 border-neutral-700' : 'bg-neutral-50 border-neutral-200'"
              >
                <h3 class="text-sm font-semibold mb-1">{{ collection.name }}</h3>
                <p class="text-xs mb-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ collection.description }}</p>
                <div class="text-xs" :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">{{ collection.pageCount }} 个页面</div>
              </div>
            </div>
          </div>
        </section>

        <section v-else-if="currentView === 'tag'" key="tag" class="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
          <div class="rounded-2xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
            <div class="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h1 class="text-3xl font-semibold mb-1">#{{ currentTagData.name }}</h1>
                <p class="text-sm" :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">标签趋势与热门页面洞察</p>
              </div>
              <div class="flex flex-wrap gap-2">
                <button class="h-9 px-3 rounded-lg border text-sm inline-flex items-center gap-2" :class="buttonClass" @click="go('search')">
                  <Search class="w-4 h-4" /> 在搜索中查看
                </button>
                <button class="h-9 px-3 rounded-lg border text-sm inline-flex items-center gap-2" :class="buttonClass" @click="refreshTagData">
                  <RefreshCw class="w-4 h-4" /> 刷新数据
                </button>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div class="rounded-xl border p-5" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <div class="text-xs mb-1" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">相关页面数</div>
              <div class="text-3xl font-semibold">{{ fmt(currentTagData.pageCount) }}</div>
            </div>
            <div class="rounded-xl border p-5" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <div class="text-xs mb-1" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">近30日新增</div>
              <div class="text-3xl font-semibold">{{ currentTagData.recentCount }}</div>
              <div class="text-xs mt-1" :class="currentTagData.recentDelta >= 0 ? 'text-emerald-500' : 'text-red-500'">
                对比前30日 {{ currentTagData.recentDelta >= 0 ? '+' : '' }}{{ currentTagData.recentDelta.toFixed(1) }}%
              </div>
            </div>
            <div class="rounded-xl border p-5" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <div class="text-xs mb-1" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">平均 Rating</div>
              <div class="text-3xl font-semibold">{{ signed(currentTagData.avgRating) }}</div>
              <div class="text-xs mt-1" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">样本 {{ currentTagData.sampleSize }} 页</div>
            </div>
          </div>

          <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
            <div class="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h2 class="text-lg font-semibold">热门页面</h2>
              <div class="flex items-center gap-2 text-sm">
                <span :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">显示数量</span>
                <select v-model.number="tagTopCount" class="h-9 rounded-lg border px-3 text-sm" :class="isDark ? 'bg-neutral-900 border-neutral-700' : 'bg-white border-neutral-200'">
                  <option :value="6">6</option>
                  <option :value="9">9</option>
                  <option :value="12">12</option>
                </select>
              </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              <a
                v-for="item in visibleTagTopPages"
                :key="`tag-top-${item.id}`"
                @click.prevent="go('page', item.id)"
                class="rounded-lg border p-4 transition-colors cursor-pointer"
                :class="isDark ? 'bg-neutral-800 border-neutral-700 hover:border-neutral-500' : 'bg-neutral-50 border-neutral-200 hover:border-neutral-300'"
              >
                <h3 class="text-sm font-semibold mb-2">{{ item.title }}</h3>
                <p class="text-xs mb-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ item.author }} · {{ item.date }}</p>
                <span class="badge-redesign" :class="item.rating > 100 ? 'badge-positive' : ''">{{ signed(item.rating) }}</span>
              </a>
            </div>
          </div>

          <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
            <h2 class="text-lg font-semibold mb-4">最近发布</h2>
            <div class="space-y-2">
              <a
                v-for="item in currentTagRecentPages"
                :key="`tag-recent-${item.id}`"
                @click.prevent="go('page', item.id)"
                class="rounded-lg border p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 cursor-pointer"
                :class="isDark ? 'bg-neutral-800 border-neutral-700 hover:border-neutral-500' : 'bg-neutral-50 border-neutral-200 hover:border-neutral-300'"
              >
                <div>
                  <h3 class="text-sm font-medium mb-1">{{ item.title }}</h3>
                  <div class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ item.date }}</div>
                </div>
                <div class="flex flex-wrap gap-2 items-center">
                  <span class="badge-redesign" :class="item.rating > 100 ? 'badge-positive' : ''">{{ signed(item.rating) }}</span>
                  <span v-for="tag in item.tags" :key="`recent-tag-${item.id}-${tag}`" class="tag-pill" @click.prevent.stop="go('tag', tag)">{{ tag }}</span>
                </div>
              </a>
            </div>
          </div>
        </section>

        <section v-else-if="currentView === 'tools'" key="tools" class="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
          <div>
            <h1 class="text-2xl font-semibold mb-1">数据工具</h1>
            <p class="text-sm" :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">探索站点数据能力和实验工具。</p>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <div
              v-for="tool in toolsList"
              :key="tool.id"
              class="rounded-xl border p-5 transition-colors cursor-pointer"
              :class="isDark ? 'bg-neutral-900 border-neutral-800 hover:border-neutral-600' : 'bg-white border-neutral-200 hover:border-neutral-300'"
            >
              <div class="w-10 h-10 rounded-lg mb-4 flex items-center justify-center" :class="tool.colorClass">
                <component :is="tool.icon" class="w-5 h-5" />
              </div>
              <h3 class="text-sm font-semibold mb-1">{{ tool.title }}</h3>
              <p class="text-xs mb-3" :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">{{ tool.desc }}</p>
              <div class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ fmt(tool.usage) }} 次使用</div>
            </div>
          </div>

          <div class="divider"></div>

          <div>
            <h2 class="text-xl font-semibold mb-3">竞赛专题</h2>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
              <a
                v-for="contest in contests"
                :key="contest.id"
                @click.prevent="contest.action ? contest.action() : undefined"
                class="rounded-xl border p-5"
                :class="[
                  isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200',
                  contest.action ? 'cursor-pointer hover:border-neutral-500 transition-colors' : ''
                ]"
              >
                <div class="flex items-center justify-between mb-2">
                  <h3 class="text-sm font-semibold">{{ contest.title }}</h3>
                  <span
                    class="px-2 py-0.5 text-xs rounded-full border"
                    :class="contest.status === '进行中'
                      ? (isDark ? 'bg-emerald-950/50 text-emerald-300 border-emerald-800' : 'bg-emerald-50 text-emerald-700 border-emerald-200')
                      : (isDark ? 'bg-neutral-800 text-neutral-300 border-neutral-700' : 'bg-neutral-50 text-neutral-600 border-neutral-200')"
                  >
                    {{ contest.status }}
                  </span>
                </div>
                <p class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ contest.desc }}</p>
              </a>
            </div>
          </div>
        </section>

        <section v-else-if="currentView === 'contest'" key="contest" class="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
          <div class="rounded-2xl p-8" :class="isDark ? 'bg-neutral-900 border border-neutral-800' : 'bg-neutral-900'">
            <div class="flex items-center gap-2 mb-3">
              <span class="inline-flex items-center px-3 py-1 text-xs rounded-full border border-white/20 bg-white/10 text-white">竞赛专题</span>
              <span class="text-xs text-white/60">2026 冬季征文</span>
            </div>
            <h1 class="text-3xl font-semibold text-white mb-2">2026 冬季征文：循环</h1>
            <p class="text-sm text-white/70 max-w-2xl mb-6">探索时间、记忆与命运循环的叙事可能。</p>
            <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div class="rounded-lg p-4 border border-white/10 bg-white/5">
                <div class="text-xs text-white/60 mb-1">征文开始</div>
                <div class="text-sm font-semibold text-white">2026-02-17</div>
              </div>
              <div class="rounded-lg p-4 border border-white/10 bg-white/5">
                <div class="text-xs text-white/60 mb-1">投稿截止</div>
                <div class="text-sm font-semibold text-white">2026-03-03</div>
              </div>
              <div class="rounded-lg p-4 border border-white/10 bg-white/5">
                <div class="text-xs text-white/60 mb-1">计票截止</div>
                <div class="text-sm font-semibold text-white">2026-03-10</div>
              </div>
            </div>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <a
              v-for="entry in contestEntries"
              :key="entry.id"
              @click.prevent="go('page', entry.id)"
              class="rounded-xl border p-5"
              :class="isDark ? 'bg-neutral-900 border-neutral-800 hover:border-neutral-600' : 'bg-white border-neutral-200 hover:border-neutral-300'"
            >
              <div class="flex items-center justify-between gap-2 mb-2">
                <h3 class="text-sm font-semibold">{{ entry.title }}</h3>
                <span class="badge-redesign" :class="entry.rating > 100 ? 'badge-positive' : ''">{{ signed(entry.rating) }}</span>
              </div>
              <p class="text-sm mb-3" :class="isDark ? 'text-neutral-300' : 'text-neutral-600'">{{ entry.excerpt }}</p>
              <div class="text-xs flex items-center gap-3" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">
                <span>{{ entry.author }}</span>
                <span>{{ entry.date }}</span>
              </div>
            </a>
          </div>
        </section>

        <section v-else-if="currentView === 'about'" key="about" class="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-6">
          <div class="rounded-2xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
            <div class="flex items-center gap-4 mb-6">
              <div class="w-14 h-14 rounded-lg flex items-center justify-center" :class="isDark ? 'bg-neutral-100 text-neutral-900' : 'bg-neutral-900 text-white'">
                <span class="text-2xl font-bold">SC</span>
              </div>
              <div>
                <h1 class="text-2xl font-semibold">SCPPER-CN</h1>
                <p class="text-sm" :class="isDark ? 'text-neutral-400' : 'text-neutral-500'">SCP 中文站数据统计与分析平台</p>
              </div>
            </div>

            <div class="space-y-3 text-sm leading-7" :class="isDark ? 'text-neutral-300' : 'text-neutral-700'">
              <p>SCPPER-CN 聚合页面、用户、标签与论坛多维数据，提供创作生态分析、趋势跟踪和专题展示。</p>
              <p>目标是以清晰、克制、可追溯的方式，将社区数据转化为可用洞察。</p>
            </div>
          </div>

          <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <h2 class="text-lg font-semibold mb-3">版权与协议</h2>
              <div class="space-y-2 text-sm" :class="isDark ? 'text-neutral-300' : 'text-neutral-700'">
                <p>数据来源：SCP 基金会中文分部公开页面与论坛。</p>
                <p>内容遵循 <strong>CC-BY-SA 3.0</strong> 授权，保留原作者署名与同方式共享条款。</p>
                <p>站点图像/页面解析能力由 CROM API 提供支持，感谢社区工具生态。</p>
              </div>
            </div>

            <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
              <h2 class="text-lg font-semibold mb-3">赞助者</h2>
              <div class="space-y-2 text-sm">
                <div v-for="sponsor in sponsors" :key="sponsor.name" class="flex items-start justify-between gap-3">
                  <div>
                    <div class="font-medium">{{ sponsor.name }}</div>
                    <div class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ sponsor.message }}</div>
                  </div>
                  <span class="text-xs" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">{{ sponsor.date }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
            <h2 class="text-lg font-semibold mb-4">功能路线图</h2>

            <div class="mb-4">
              <div class="text-xs uppercase tracking-wider mb-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">已完成</div>
              <div class="space-y-1">
                <div v-for="item in roadmap.done" :key="item" class="roadmap-item">
                  <span class="roadmap-item-icon text-emerald-500"><Check class="w-4 h-4" /></span>
                  <span>{{ item }}</span>
                </div>
              </div>
            </div>

            <div class="mb-4">
              <div class="text-xs uppercase tracking-wider mb-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">进行中</div>
              <div class="space-y-1">
                <div v-for="item in roadmap.working" :key="item" class="roadmap-item">
                  <span class="roadmap-item-icon text-sky-500"><Loader2 class="w-4 h-4 animate-spin" /></span>
                  <span>{{ item }}</span>
                </div>
              </div>
            </div>

            <div>
              <div class="text-xs uppercase tracking-wider mb-2" :class="isDark ? 'text-neutral-500' : 'text-neutral-500'">计划中</div>
              <div class="space-y-1">
                <div v-for="item in roadmap.planned" :key="item" class="roadmap-item">
                  <span class="roadmap-item-icon" :class="isDark ? 'text-neutral-500' : 'text-neutral-400'"><Circle class="w-4 h-4" /></span>
                  <span>{{ item }}</span>
                </div>
              </div>
            </div>
          </div>

          <div class="rounded-xl border p-6" :class="isDark ? 'bg-neutral-900 border-neutral-800' : 'bg-white border-neutral-200'">
            <h2 class="text-lg font-semibold mb-2">联系方式</h2>
            <a
              href="https://github.com/andyblocker/scpper-cn"
              target="_blank"
              rel="noopener noreferrer"
              class="inline-flex items-center gap-2 text-sm hover:underline"
            >
              <ExternalLink class="w-4 h-4" /> github.com/andyblocker/scpper-cn
            </a>
          </div>
        </section>
      </Transition>
    </main>
  </div>
</template>

<script setup lang="ts">
import {
  ArrowRight,
  BarChart3,
  Bell,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Circle,
  Code,
  Copy,
  ExternalLink,
  FileText,
  FlaskConical,
  Grid3x3,
  Hash,
  Image,
  Loader2,
  Menu,
  Moon,
  RefreshCw,
  Search,
  Shuffle,
  SlidersHorizontal,
  Sparkles,
  Star,
  Sun,
  Tag,
  Tags,
  ThumbsDown,
  ThumbsUp,
  X,
} from 'lucide-vue-next';
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue';

type ViewId = 'home' | 'ranking' | 'search' | 'page' | 'user' | 'tag' | 'tools' | 'contest' | 'about';
type SearchTab = 'pages' | 'users' | 'tags';
type SearchTarget = 'all' | 'pages' | 'users' | 'forums';
type RankTab = 'overall' | 'scp' | 'story' | 'goi' | 'translation' | 'wanderers' | 'art' | 'forum';
type RankSortKey = 'name' | 'pages' | 'score' | 'avg';
type SortDirection = 'asc' | 'desc';
type PageStatusFilter = 'all' | 'excludeDeleted' | 'onlyDeleted';
type SearchSort = 'relevance' | 'ratingDesc' | 'newest' | 'wilson';
type ActiveSearchKind = 'pages' | 'users' | 'tags' | 'forums';
type WorkTab = 'all' | 'scp' | 'story' | 'goi' | 'translation' | 'other';

interface RankingUser {
  id: number;
  name: string;
  pages: number;
  avg: number;
  joined: string;
  scores: Record<RankTab, number>;
}

interface SearchPageItem {
  id: number;
  title: string;
  author: string;
  authorId: number;
  rating: number;
  date: string;
  excerpt: string;
  tags: string[];
  status: 'active' | 'deleted';
  wilson: number;
}

interface SearchUserItem {
  id: number;
  name: string;
  pages: number;
  totalScore: number;
  avgScore: number;
  joined: string;
}

interface SearchTagItem {
  name: string;
  pageCount: number;
  lastActive: string;
}

interface SearchForumItem {
  id: string;
  title: string;
  author: string;
  replies: number;
  lastActive: string;
  excerpt: string;
}

interface UserWork {
  id: number;
  title: string;
  rating: number;
  date: string;
  tags: string[];
  type: Exclude<WorkTab, 'all'>;
}

interface UserCategory {
  id: string;
  label: string;
  rank: number;
  works: number;
  score: number;
  share: number;
}

interface CountEntry {
  name: string;
  count: number;
}

interface TimelineEntry {
  date: string;
  type: string;
  pageId: number;
  pageTitle: string;
  voteDirection: string;
  note: string;
}

interface UserCollection {
  name: string;
  description: string;
  pageCount: number;
}

interface UserProfile {
  id: number;
  name: string;
  joined: string;
  lastActive: string;
  rank: number;
  pages: number;
  totalScore: number;
  avgScore: number;
  upvotes: number;
  downvotes: number;
  revisions: number;
  firstActivity: TimelineEntry;
  lastTimeline: TimelineEntry;
  categories: UserCategory[];
  favoriteTags: string[];
  favoriteAuthors: CountEntry[];
  fans: CountEntry[];
  lovedTags: CountEntry[];
  hatedTags: CountEntry[];
  collections: UserCollection[];
  heatmapData: number[];
  works: UserWork[];
}

interface PageAuthor {
  id: number;
  name: string;
}

interface RevisionEntry {
  type: 'create' | 'edit' | 'title' | 'tags';
  editor: string;
  time: string;
  note: string;
}

interface VoteEntry {
  userId: number;
  name: string;
  direction: 'up' | 'down';
  time: string;
}

interface RelatedPage {
  id: number;
  title: string;
  author: string;
  rating: number;
}

interface PageDetail {
  id: number;
  pageId: string;
  title: string;
  createdAt: string;
  rating: number;
  upvotes: number;
  downvotes: number;
  supportRate: number;
  wilson: number;
  controversy: number;
  viewCount: number;
  dailyViews: number;
  deleted: boolean;
  deletedDate: string | null;
  tags: string[];
  authors: PageAuthor[];
  content: string;
  revisions: number;
  revisionHistory: RevisionEntry[];
  recentVotes: VoteEntry[];
  relatedPages: RelatedPage[];
  trendData: number[];
}

interface TagOverview {
  name: string;
  pageCount: number;
  recentCount: number;
  recentDelta: number;
  avgRating: number;
  sampleSize: number;
}

interface TagPageItem {
  id: number;
  title: string;
  author: string;
  rating: number;
  date: string;
  tags: string[];
}

const usePagination = (total: ComputedRef<number>, pageSize: Ref<number>, page: Ref<number>) => {
  const totalPages = computed(() => {
    if (total.value <= 0) return 1;
    return Math.max(1, Math.ceil(total.value / pageSize.value));
  });

  watch([totalPages, total, pageSize], () => {
    if (page.value < 1) page.value = 1;
    if (page.value > totalPages.value) page.value = totalPages.value;
  });

  const pageNumbers = computed(() => {
    const max = totalPages.value;
    if (max <= 7) {
      return Array.from({ length: max }, (_, index) => index + 1);
    }

    const current = page.value;
    const middleStart = Math.max(2, current - 1);
    const middleEnd = Math.min(max - 1, current + 1);

    const numbers: number[] = [1];
    if (middleStart > 2) numbers.push(-1);
    for (let value = middleStart; value <= middleEnd; value += 1) numbers.push(value);
    if (middleEnd < max - 1) numbers.push(-2);
    numbers.push(max);

    return numbers;
  });

  const prev = () => {
    page.value = Math.max(1, page.value - 1);
  };

  const next = () => {
    page.value = Math.min(totalPages.value, page.value + 1);
  };

  return { page, totalPages, pageNumbers, prev, next };
};

const navItems: Array<{ id: ViewId; label: string }> = [
  { id: 'home', label: '首页' },
  { id: 'ranking', label: '排行' },
  { id: 'tools', label: '工具' },
  { id: 'about', label: '关于' },
];

const quickLinks: Array<{ view: ViewId; label: string }> = [
  { view: 'ranking', label: '用户排行' },
  { view: 'search', label: '站内搜索' },
  { view: 'tools', label: '数据工具' },
  { view: 'contest', label: '竞赛专题' },
];

const rankTabs: Array<{ id: RankTab; label: string }> = [
  { id: 'overall', label: '综合' },
  { id: 'scp', label: 'SCP' },
  { id: 'story', label: '故事' },
  { id: 'goi', label: 'GoI格式' },
  { id: 'translation', label: '翻译' },
  { id: 'wanderers', label: '被放逐者' },
  { id: 'art', label: '艺术' },
  { id: 'forum', label: '论坛' },
];

const searchTabs: Array<{ id: SearchTab; label: string }> = [
  { id: 'pages', label: '页面' },
  { id: 'users', label: '用户' },
  { id: 'tags', label: '标签' },
];

const searchTargets: Array<{ id: SearchTarget; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'pages', label: '仅页面' },
  { id: 'users', label: '仅用户' },
  { id: 'forums', label: '仅论坛' },
];

const userWorkTabs: Array<{ id: WorkTab; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'scp', label: 'SCP' },
  { id: 'story', label: '故事' },
  { id: 'goi', label: 'GoI' },
  { id: 'translation', label: '翻译' },
  { id: 'other', label: '其他' },
];

const statCards = [
  { label: '用户', value: 34066, sub: '5,578 活跃' },
  { label: '页面', value: 44191, sub: '12,411 原创' },
  { label: '投票', value: 1027108, sub: '<span class="text-emerald-500">946,411</span> / <span class="text-neutral-500">80,697</span>' },
  { label: '修订', value: 408634, sub: '持续更新' },
];

const popularWorks = [
  { id: 3301, title: 'SCP-CN-3301', author: 'AndyBlocker', rating: 601 },
  { id: 2025, title: 'SCPPER-CN 2025 年度总结', author: 'AndyBlocker', rating: 213 },
  { id: 616, title: '超形上学导论', author: 'Etinjat', rating: 616 },
  { id: 2000, title: 'SCP-CN-2000', author: 'Holy_Darklight', rating: 389 },
  { id: 1000, title: 'SCP-CN-1000', author: 'Sekai_s', rating: 512 },
];

const activeUsers = [
  { id: 10086, name: 'AndyBlocker', score: 16540, pages: 45 },
  { id: 616, name: 'Etinjat', score: 14980, pages: 67 },
  { id: 456, name: 'qntm', score: 14230, pages: 156 },
  { id: 123, name: 'Dr_Gears', score: 14020, pages: 89 },
  { id: 789, name: 'Djoric', score: 13210, pages: 124 },
];

const rankingUsers: RankingUser[] = [
  { id: 10086, name: 'AndyBlocker', pages: 45, avg: 183, joined: '2020-03', scores: { overall: 16540, scp: 13220, story: 5100, goi: 2200, translation: 860, wanderers: 430, art: 190, forum: 730 } },
  { id: 616, name: 'Etinjat', pages: 67, avg: 186, joined: '2018-11', scores: { overall: 14980, scp: 8400, story: 9300, goi: 2800, translation: 1020, wanderers: 1100, art: 310, forum: 640 } },
  { id: 456, name: 'qntm', pages: 156, avg: 91, joined: '2018-05', scores: { overall: 14230, scp: 11020, story: 6820, goi: 2600, translation: 1930, wanderers: 420, art: 160, forum: 990 } },
  { id: 123, name: 'Dr_Gears', pages: 89, avg: 173, joined: '2019-01', scores: { overall: 14020, scp: 12300, story: 3120, goi: 1800, translation: 980, wanderers: 280, art: 90, forum: 770 } },
  { id: 789, name: 'Djoric', pages: 124, avg: 112, joined: '2019-08', scores: { overall: 13210, scp: 9200, story: 8010, goi: 3100, translation: 740, wanderers: 560, art: 220, forum: 810 } },
  { id: 234, name: 'Clef', pages: 78, avg: 161, joined: '2017-09', scores: { overall: 12670, scp: 9800, story: 4200, goi: 1950, translation: 420, wanderers: 310, art: 80, forum: 1250 } },
  { id: 567, name: 'Kondraki', pages: 92, avg: 123, joined: '2018-07', scores: { overall: 11890, scp: 8450, story: 5010, goi: 1670, translation: 430, wanderers: 270, art: 110, forum: 1530 } },
  { id: 890, name: 'Bright', pages: 145, avg: 75, joined: '2016-04', scores: { overall: 10980, scp: 7100, story: 6680, goi: 1580, translation: 390, wanderers: 180, art: 120, forum: 2330 } },
  { id: 345, name: 'Mann', pages: 67, avg: 146, joined: '2020-01', scores: { overall: 10220, scp: 6600, story: 3920, goi: 1200, translation: 720, wanderers: 140, art: 80, forum: 420 } },
  { id: 678, name: 'Gears', pages: 103, avg: 90, joined: '2021-06', scores: { overall: 9710, scp: 6320, story: 3810, goi: 1400, translation: 610, wanderers: 200, art: 120, forum: 780 } },
  { id: 199, name: 'Ravel', pages: 72, avg: 102, joined: '2022-02', scores: { overall: 8860, scp: 5210, story: 2940, goi: 1310, translation: 520, wanderers: 350, art: 210, forum: 410 } },
  { id: 278, name: 'Ari', pages: 55, avg: 118, joined: '2023-01', scores: { overall: 8010, scp: 4100, story: 3530, goi: 980, translation: 820, wanderers: 430, art: 330, forum: 250 } },
];

const pageSearchResults: SearchPageItem[] = [
  { id: 3301, title: 'SCP-CN-3301', author: 'AndyBlocker', authorId: 10086, rating: 601, date: '2025-12-15', excerpt: '一个关于数据、统计与信息增殖的异常项目，记录并预测创作行为。', tags: ['scp', 'euclid', '数据'], status: 'active', wilson: 0.92 },
  { id: 2025, title: 'SCPPER-CN 2025 年度总结', author: 'AndyBlocker', authorId: 10086, rating: 213, date: '2025-12-31', excerpt: '回顾 2025 年中文分部创作、评分、标签与活跃度的完整数据画像。', tags: ['故事', '年度总结'], status: 'active', wilson: 0.88 },
  { id: 616, title: '超形上学导论', author: 'Etinjat', authorId: 616, rating: 616, date: '2024-08-20', excerpt: '从叙事层级和现实锚点切入，讨论基金会宇宙的存在论结构。', tags: ['设定', '哲学'], status: 'active', wilson: 0.94 },
  { id: 2000, title: 'SCP-CN-2000', author: 'Holy_Darklight', authorId: 2000, rating: 389, date: '2024-05-10', excerpt: '一次跨日循环中的收容失效与重启决策，时间成为项目本身。', tags: ['scp', 'keter', '时间'], status: 'active', wilson: 0.9 },
  { id: 4102, title: 'SCP-CN-4102', author: 'Ravel', authorId: 199, rating: 146, date: '2025-08-21', excerpt: '论坛争议延伸为收容叙事，项目在意见分裂中持续变异。', tags: ['scp', '论坛', '争议'], status: 'active', wilson: 0.8 },
  { id: 3891, title: '循环手记', author: 'EchoMind', authorId: 5003, rating: 97, date: '2026-02-23', excerpt: '以第一人称记录 17 次时间回环中的记忆衰退。', tags: ['故事', '时间', '循环'], status: 'active', wilson: 0.67 },
  { id: 1033, title: 'SCP-CN-1033（已删除）', author: 'Kondraki', authorId: 567, rating: 122, date: '2023-09-11', excerpt: '早期实验稿，已因设定冲突删除。', tags: ['scp', '已删除', '实验'], status: 'deleted', wilson: 0.61 },
  { id: 5230, title: '冬季征文：命运支线', author: 'CycleWriter', authorId: 5002, rating: 168, date: '2026-02-28', excerpt: '在循环终点前，你还剩最后一次选择机会。', tags: ['故事', '征文', '循环'], status: 'active', wilson: 0.86 },
  { id: 5514, title: 'GoI-CN：灰烬协议', author: 'Mann', authorId: 345, rating: 132, date: '2025-06-18', excerpt: '一份组织档案与三条互相矛盾的补注，真相被刻意打散。', tags: ['goi', '档案', '组织'], status: 'active', wilson: 0.82 },
];

const userSearchResults: SearchUserItem[] = [
  { id: 10086, name: 'AndyBlocker', pages: 45, totalScore: 8234, avgScore: 183, joined: '2020-03-15' },
  { id: 616, name: 'Etinjat', pages: 67, totalScore: 12456, avgScore: 186, joined: '2018-11-03' },
  { id: 456, name: 'qntm', pages: 156, totalScore: 14230, avgScore: 91, joined: '2018-05-20' },
  { id: 123, name: 'Dr_Gears', pages: 89, totalScore: 15420, avgScore: 173, joined: '2019-01-10' },
  { id: 789, name: 'Djoric', pages: 124, totalScore: 13890, avgScore: 112, joined: '2019-08-12' },
  { id: 345, name: 'Mann', pages: 67, totalScore: 9780, avgScore: 146, joined: '2020-01-18' },
];

const tagSearchResults: SearchTagItem[] = [
  { name: 'scp', pageCount: 29123, lastActive: '2026-03-02' },
  { name: '故事', pageCount: 9421, lastActive: '2026-03-03' },
  { name: 'goi', pageCount: 3298, lastActive: '2026-03-01' },
  { name: '翻译', pageCount: 6422, lastActive: '2026-03-03' },
  { name: '时间', pageCount: 618, lastActive: '2026-03-02' },
  { name: '循环', pageCount: 231, lastActive: '2026-03-03' },
  { name: '论坛', pageCount: 188, lastActive: '2026-02-27' },
  { name: '被放逐者图书馆', pageCount: 351, lastActive: '2026-03-01' },
];

const forumSearchResults: SearchForumItem[] = [
  { id: 'forum-1', title: '2026 冬季征文集中讨论帖', author: 'TimeKeeper', replies: 142, lastActive: '2026-03-03 09:23', excerpt: '集中收录投稿链接、评审意见和活动提醒。' },
  { id: 'forum-2', title: 'SCP-CN-3301 评论区精选', author: 'OldBear', replies: 88, lastActive: '2026-03-02 18:02', excerpt: '围绕数据异常设定展开的深入讨论。' },
  { id: 'forum-3', title: '标签治理提案：论坛标签规范', author: 'Ari', replies: 63, lastActive: '2026-03-01 22:14', excerpt: '提议统一论坛主题标签，降低检索成本。' },
  { id: 'forum-4', title: 'GoI 系列内容策划协作帖', author: 'Mann', replies: 57, lastActive: '2026-02-28 20:31', excerpt: '组织格式页面协作进度和连载排期。' },
  { id: 'forum-5', title: '翻译质量控制流程讨论', author: 'Ravel', replies: 41, lastActive: '2026-02-26 11:08', excerpt: '从术语一致性到审校流程，征求新的标准建议。' },
  { id: 'forum-6', title: '站点样式 redesign 反馈收集', author: 'AndyBlocker', replies: 26, lastActive: '2026-02-25 17:45', excerpt: '汇总对新界面布局、可读性和移动端表现的反馈。' },
];

const buildHeatmap = (seed: number) => {
  return Array.from({ length: 91 }, (_, index) => {
    const value = (index * 7 + seed) % 11;
    if (value <= 1) return 0;
    if (value <= 3) return 1;
    if (value <= 6) return 2;
    if (value <= 8) return 3;
    return 4;
  });
};

const userProfiles: Record<number, UserProfile> = {
  10086: {
    id: 10086,
    name: 'AndyBlocker',
    joined: '2020-03-15',
    lastActive: '2 小时前',
    rank: 6,
    pages: 45,
    totalScore: 8234,
    avgScore: 183,
    upvotes: 9121,
    downvotes: 887,
    revisions: 234,
    firstActivity: {
      date: '2020-03-18 20:10',
      type: '首次投票',
      pageId: 1000,
      pageTitle: 'SCP-CN-1000',
      voteDirection: '支持',
      note: '对首页推荐作品投出第一票',
    },
    lastTimeline: {
      date: '2026-03-03 01:17',
      type: '页面修订',
      pageId: 2025,
      pageTitle: 'SCPPER-CN 2025 年度总结',
      voteDirection: 'N/A',
      note: '补充 2026 年初趋势对比图',
    },
    categories: [
      { id: 'scp', label: 'SCP', rank: 12, works: 22, score: 5210, share: 88 },
      { id: 'story', label: '故事', rank: 8, works: 11, score: 1980, share: 56 },
      { id: 'goi', label: 'GoI格式', rank: 15, works: 4, score: 650, share: 34 },
      { id: 'translation', label: '翻译', rank: 33, works: 3, score: 210, share: 21 },
      { id: 'wanderers', label: '被放逐者图书馆', rank: 18, works: 2, score: 110, share: 13 },
      { id: 'art', label: '艺术作品', rank: 26, works: 3, score: 74, share: 10 },
    ],
    favoriteTags: ['scp', '数据', '循环', '时间', '论坛', '设计', '年度总结'],
    favoriteAuthors: [
      { name: 'Etinjat', count: 124 },
      { name: 'Ravel', count: 92 },
      { name: 'Mann', count: 70 },
    ],
    fans: [
      { name: 'Ari', count: 66 },
      { name: 'CycleWriter', count: 54 },
      { name: 'EchoMind', count: 43 },
    ],
    lovedTags: [
      { name: '数据', count: 201 },
      { name: '时间', count: 143 },
      { name: '循环', count: 112 },
    ],
    hatedTags: [
      { name: '恐怖', count: 18 },
      { name: '血腥', count: 12 },
      { name: '地缘政治', count: 8 },
    ],
    collections: [
      { name: '循环叙事精选', description: '时间回环主题页面合集', pageCount: 28 },
      { name: '统计可视化案例', description: '包含图表/趋势页的作品', pageCount: 15 },
      { name: '论坛策略讨论', description: '与内容治理相关的讨论串', pageCount: 9 },
    ],
    heatmapData: buildHeatmap(2),
    works: [
      { id: 3301, title: 'SCP-CN-3301', rating: 601, date: '2025-12-15', tags: ['scp', '数据'], type: 'scp' },
      { id: 2025, title: 'SCPPER-CN 2025 年度总结', rating: 213, date: '2025-12-31', tags: ['故事', '年度总结'], type: 'story' },
      { id: 5230, title: '冬季征文：命运支线', rating: 168, date: '2026-02-28', tags: ['故事', '循环'], type: 'story' },
      { id: 5514, title: 'GoI-CN：灰烬协议', rating: 132, date: '2025-06-18', tags: ['goi', '组织'], type: 'goi' },
      { id: 4102, title: 'SCP-CN-4102', rating: 146, date: '2025-08-21', tags: ['scp', '论坛'], type: 'scp' },
      { id: 3891, title: '循环手记', rating: 97, date: '2026-02-23', tags: ['故事', '时间'], type: 'story' },
      { id: 1022, title: '译文：温顺之神', rating: 79, date: '2024-10-12', tags: ['翻译', 'scp'], type: 'translation' },
      { id: 7310, title: '异常插画稿 #4', rating: 56, date: '2025-01-19', tags: ['艺术', '图像'], type: 'other' },
    ],
  },
  616: {
    id: 616,
    name: 'Etinjat',
    joined: '2018-11-03',
    lastActive: '1 天前',
    rank: 3,
    pages: 67,
    totalScore: 12456,
    avgScore: 186,
    upvotes: 13210,
    downvotes: 990,
    revisions: 388,
    firstActivity: {
      date: '2018-11-20 22:04',
      type: '首篇发布',
      pageId: 616,
      pageTitle: '超形上学导论',
      voteDirection: 'N/A',
      note: '以设定类长文进入创作视野',
    },
    lastTimeline: {
      date: '2026-03-02 16:50',
      type: '标签修订',
      pageId: 617,
      pageTitle: '叙事理论概述',
      voteDirection: 'N/A',
      note: '补充跨站引用与标签整理',
    },
    categories: [
      { id: 'scp', label: 'SCP', rank: 6, works: 31, score: 6340, share: 81 },
      { id: 'story', label: '故事', rank: 2, works: 19, score: 4500, share: 72 },
      { id: 'goi', label: 'GoI格式', rank: 10, works: 7, score: 1200, share: 36 },
      { id: 'translation', label: '翻译', rank: 22, works: 4, score: 210, share: 16 },
      { id: 'wanderers', label: '被放逐者图书馆', rank: 9, works: 3, score: 168, share: 14 },
      { id: 'art', label: '艺术作品', rank: 38, works: 3, score: 38, share: 9 },
    ],
    favoriteTags: ['设定', '哲学', '叙事', '现实扭曲', '模因学'],
    favoriteAuthors: [{ name: 'qntm', count: 111 }, { name: 'AndyBlocker', count: 89 }, { name: 'Mann', count: 65 }],
    fans: [{ name: 'Ravel', count: 42 }, { name: 'Ari', count: 33 }, { name: 'OldBear', count: 30 }],
    lovedTags: [{ name: '设定', count: 188 }, { name: '叙事', count: 155 }, { name: '现实扭曲', count: 96 }],
    hatedTags: [{ name: '速写', count: 11 }, { name: '抽象', count: 7 }, { name: '轻小说', count: 4 }],
    collections: [
      { name: '设定索引', description: '站内核心设定文档清单', pageCount: 33 },
      { name: '高分故事线', description: '超过 +200 的故事页面', pageCount: 24 },
      { name: '讨论串摘录', description: '重要论坛答疑与作者访谈', pageCount: 11 },
    ],
    heatmapData: buildHeatmap(5),
    works: [
      { id: 616, title: '超形上学导论', rating: 616, date: '2024-08-20', tags: ['设定', '哲学'], type: 'story' },
      { id: 617, title: '叙事理论概述', rating: 423, date: '2024-10-05', tags: ['设定', '叙事'], type: 'story' },
      { id: 618, title: '现实锚点札记', rating: 292, date: '2025-03-17', tags: ['scp', '设定'], type: 'scp' },
      { id: 619, title: 'GoI 反事实调查', rating: 188, date: '2025-07-11', tags: ['goi', '调查'], type: 'goi' },
      { id: 620, title: '译文：群像异常学', rating: 142, date: '2025-10-08', tags: ['翻译', '设定'], type: 'translation' },
    ],
  },
};

const trendSeed = (base: number) => {
  return Array.from({ length: 30 }, (_, index) => {
    const wave = Math.sin(index / 4) * 18;
    const rise = index * 2.3;
    return Math.max(20, Math.round(base + rise + wave));
  });
};

const pageData = reactive<Record<number, PageDetail>>({
  3301: {
    id: 3301,
    pageId: 'SCP-CN-3301',
    title: 'SCP-CN-3301',
    createdAt: '2025-12-15',
    rating: 601,
    upvotes: 742,
    downvotes: 141,
    supportRate: 0.84,
    wilson: 0.92,
    controversy: 0.18,
    viewCount: 42102,
    dailyViews: 309,
    deleted: false,
    deletedDate: null,
    tags: ['scp', 'euclid', '数据', '统计', '论坛'],
    authors: [
      { id: 10086, name: 'AndyBlocker' },
      { id: 616, name: 'Etinjat' },
    ],
    content: '项目编号：SCP-CN-3301。项目可自主解析并重构中文分部公开数据，以拟合未来创作趋势。在高负载期，系统会生成自发的“预测注释”。',
    revisions: 23,
    revisionHistory: [
      { type: 'create', editor: 'AndyBlocker', time: '2025-12-15 09:22', note: '创建页面' },
      { type: 'edit', editor: 'Etinjat', time: '2025-12-16 12:41', note: '补充叙事层级说明' },
      { type: 'tags', editor: 'Mann', time: '2025-12-18 20:17', note: '添加“论坛”标签' },
      { type: 'title', editor: 'AndyBlocker', time: '2025-12-19 00:05', note: '标题规范化' },
      { type: 'edit', editor: 'Ari', time: '2025-12-20 14:01', note: '修正术语一致性' },
      { type: 'edit', editor: 'Ravel', time: '2025-12-22 10:44', note: '补充附录' },
    ],
    recentVotes: [
      { userId: 616, name: 'Etinjat', direction: 'up', time: '2026-03-03 09:18' },
      { userId: 345, name: 'Mann', direction: 'up', time: '2026-03-03 09:05' },
      { userId: 5003, name: 'EchoMind', direction: 'up', time: '2026-03-03 08:36' },
      { userId: 278, name: 'Ari', direction: 'down', time: '2026-03-03 08:11' },
      { userId: 567, name: 'Kondraki', direction: 'up', time: '2026-03-02 23:58' },
      { userId: 123, name: 'Dr_Gears', direction: 'up', time: '2026-03-02 22:45' },
      { userId: 890, name: 'Bright', direction: 'down', time: '2026-03-02 21:20' },
      { userId: 199, name: 'Ravel', direction: 'up', time: '2026-03-02 20:32' },
    ],
    relatedPages: [
      { id: 2025, title: 'SCPPER-CN 2025 年度总结', author: 'AndyBlocker', rating: 213 },
      { id: 4102, title: 'SCP-CN-4102', author: 'Ravel', rating: 146 },
      { id: 2000, title: 'SCP-CN-2000', author: 'Holy_Darklight', rating: 389 },
    ],
    trendData: trendSeed(110),
  },
  2025: {
    id: 2025,
    pageId: 'SCPPER-CN-2025-ANNUAL',
    title: 'SCPPER-CN 2025 年度总结',
    createdAt: '2025-12-31',
    rating: 213,
    upvotes: 314,
    downvotes: 55,
    supportRate: 0.85,
    wilson: 0.88,
    controversy: 0.12,
    viewCount: 11820,
    dailyViews: 90,
    deleted: false,
    deletedDate: null,
    tags: ['故事', '年度总结', '数据'],
    authors: [{ id: 10086, name: 'AndyBlocker' }],
    content: '2025 年中文分部共新增 1,234 篇页面，活跃作者增长 16.4%。在标签维度上，时间异常与叙事设定类显著上升。',
    revisions: 12,
    revisionHistory: [
      { type: 'create', editor: 'AndyBlocker', time: '2025-12-31 22:20', note: '创建页面' },
      { type: 'edit', editor: 'Ari', time: '2026-01-01 10:18', note: '修订数据统计注释' },
      { type: 'edit', editor: 'Ravel', time: '2026-01-03 14:44', note: '补充图片说明' },
      { type: 'tags', editor: 'Mann', time: '2026-01-05 08:11', note: '增加“数据”标签' },
      { type: 'edit', editor: 'AndyBlocker', time: '2026-01-11 23:09', note: '同步年度最终版本' },
    ],
    recentVotes: [
      { userId: 616, name: 'Etinjat', direction: 'up', time: '2026-03-02 09:18' },
      { userId: 123, name: 'Dr_Gears', direction: 'up', time: '2026-03-01 22:01' },
      { userId: 345, name: 'Mann', direction: 'down', time: '2026-03-01 18:14' },
      { userId: 278, name: 'Ari', direction: 'up', time: '2026-02-28 14:21' },
      { userId: 567, name: 'Kondraki', direction: 'up', time: '2026-02-28 09:56' },
    ],
    relatedPages: [
      { id: 3301, title: 'SCP-CN-3301', author: 'AndyBlocker', rating: 601 },
      { id: 5230, title: '冬季征文：命运支线', author: 'CycleWriter', rating: 168 },
      { id: 5514, title: 'GoI-CN：灰烬协议', author: 'Mann', rating: 132 },
    ],
    trendData: trendSeed(70),
  },
  2000: {
    id: 2000,
    pageId: 'SCP-CN-2000',
    title: 'SCP-CN-2000',
    createdAt: '2024-05-10',
    rating: 389,
    upvotes: 581,
    downvotes: 192,
    supportRate: 0.75,
    wilson: 0.9,
    controversy: 0.43,
    viewCount: 32900,
    dailyViews: 164,
    deleted: true,
    deletedDate: '2026-01-20',
    tags: ['scp', 'keter', '时间', '循环'],
    authors: [{ id: 2000, name: 'Holy_Darklight' }],
    content: 'SCP-CN-2000 是一次覆盖站点叙事层面的时间循环异常。完全收容不可行，当前策略为观测与最小化扰动。',
    revisions: 45,
    revisionHistory: [
      { type: 'create', editor: 'Holy_Darklight', time: '2024-05-10 08:43', note: '创建页面' },
      { type: 'edit', editor: 'Kondraki', time: '2024-06-03 19:44', note: '补充收容细则' },
      { type: 'title', editor: 'Ari', time: '2024-08-10 09:20', note: '标题统一格式' },
      { type: 'tags', editor: 'Mann', time: '2025-01-12 13:06', note: '增补“循环”标签' },
      { type: 'edit', editor: 'Etinjat', time: '2025-03-16 11:21', note: '增补叙事注释' },
      { type: 'edit', editor: 'AndyBlocker', time: '2026-01-20 07:15', note: '标记已删除并归档' },
    ],
    recentVotes: [
      { userId: 345, name: 'Mann', direction: 'up', time: '2026-01-20 05:02' },
      { userId: 278, name: 'Ari', direction: 'down', time: '2026-01-20 04:51' },
      { userId: 616, name: 'Etinjat', direction: 'up', time: '2026-01-20 04:20' },
      { userId: 199, name: 'Ravel', direction: 'down', time: '2026-01-20 04:01' },
      { userId: 890, name: 'Bright', direction: 'up', time: '2026-01-19 22:09' },
    ],
    relatedPages: [
      { id: 3301, title: 'SCP-CN-3301', author: 'AndyBlocker', rating: 601 },
      { id: 3891, title: '循环手记', author: 'EchoMind', rating: 97 },
      { id: 5230, title: '冬季征文：命运支线', author: 'CycleWriter', rating: 168 },
    ],
    trendData: trendSeed(98),
  },
});

const contestEntries = [
  { id: 5001, title: '永恒的星期二', author: 'TimeKeeper', rating: 142, date: '2026-02-20', excerpt: '每个星期二都在重复，直到他发现打破循环的方法。' },
  { id: 5002, title: '轮回之门', author: 'CycleWriter', rating: 98, date: '2026-02-22', excerpt: '一扇门连接着无数个平行循环世界。' },
  { id: 5003, title: '记忆的回声', author: 'EchoMind', rating: 156, date: '2026-02-25', excerpt: '在每次循环中，只有记忆会留存。' },
  { id: 5230, title: '命运支线', author: 'CycleWriter', rating: 168, date: '2026-02-28', excerpt: '终点前的最后一次选择。' },
];

const tagOverviews: Record<string, TagOverview> = {
  scp: { name: 'scp', pageCount: 29123, recentCount: 182, recentDelta: 6.8, avgRating: 132, sampleSize: 1200 },
  故事: { name: '故事', pageCount: 9421, recentCount: 74, recentDelta: 12.4, avgRating: 118, sampleSize: 840 },
  循环: { name: '循环', pageCount: 231, recentCount: 26, recentDelta: 38.2, avgRating: 154, sampleSize: 160 },
  时间: { name: '时间', pageCount: 618, recentCount: 37, recentDelta: 15.3, avgRating: 141, sampleSize: 280 },
  goi: { name: 'goi', pageCount: 3298, recentCount: 21, recentDelta: -2.7, avgRating: 127, sampleSize: 460 },
};

const tagTopPages: Record<string, TagPageItem[]> = {
  scp: [
    { id: 3301, title: 'SCP-CN-3301', author: 'AndyBlocker', rating: 601, date: '2025-12-15', tags: ['scp', '数据'] },
    { id: 2000, title: 'SCP-CN-2000', author: 'Holy_Darklight', rating: 389, date: '2024-05-10', tags: ['scp', '时间'] },
    { id: 1000, title: 'SCP-CN-1000', author: 'Sekai_s', rating: 512, date: '2023-11-05', tags: ['scp', '艺术'] },
    { id: 4102, title: 'SCP-CN-4102', author: 'Ravel', rating: 146, date: '2025-08-21', tags: ['scp', '论坛'] },
    { id: 5514, title: 'GoI-CN：灰烬协议', author: 'Mann', rating: 132, date: '2025-06-18', tags: ['goi', 'scp'] },
    { id: 3891, title: '循环手记', author: 'EchoMind', rating: 97, date: '2026-02-23', tags: ['故事', 'scp'] },
    { id: 5230, title: '命运支线', author: 'CycleWriter', rating: 168, date: '2026-02-28', tags: ['故事', 'scp'] },
    { id: 616, title: '超形上学导论', author: 'Etinjat', rating: 616, date: '2024-08-20', tags: ['设定', 'scp'] },
    { id: 618, title: '现实锚点札记', author: 'Etinjat', rating: 292, date: '2025-03-17', tags: ['scp'] },
    { id: 7310, title: '异常插画稿 #4', author: 'AndyBlocker', rating: 56, date: '2025-01-19', tags: ['艺术', 'scp'] },
    { id: 1022, title: '译文：温顺之神', author: 'AndyBlocker', rating: 79, date: '2024-10-12', tags: ['翻译', 'scp'] },
    { id: 5001, title: '永恒的星期二', author: 'TimeKeeper', rating: 142, date: '2026-02-20', tags: ['故事', 'scp'] },
  ],
  故事: [
    { id: 2025, title: 'SCPPER-CN 2025 年度总结', author: 'AndyBlocker', rating: 213, date: '2025-12-31', tags: ['故事', '年度总结'] },
    { id: 3891, title: '循环手记', author: 'EchoMind', rating: 97, date: '2026-02-23', tags: ['故事', '时间'] },
    { id: 5001, title: '永恒的星期二', author: 'TimeKeeper', rating: 142, date: '2026-02-20', tags: ['故事', '循环'] },
    { id: 5003, title: '记忆的回声', author: 'EchoMind', rating: 156, date: '2026-02-25', tags: ['故事', '记忆'] },
    { id: 5230, title: '命运支线', author: 'CycleWriter', rating: 168, date: '2026-02-28', tags: ['故事', '循环'] },
    { id: 616, title: '超形上学导论', author: 'Etinjat', rating: 616, date: '2024-08-20', tags: ['设定', '故事'] },
    { id: 617, title: '叙事理论概述', author: 'Etinjat', rating: 423, date: '2024-10-05', tags: ['设定', '故事'] },
    { id: 4102, title: 'SCP-CN-4102', author: 'Ravel', rating: 146, date: '2025-08-21', tags: ['论坛', '故事'] },
    { id: 1022, title: '译文：温顺之神', author: 'AndyBlocker', rating: 79, date: '2024-10-12', tags: ['翻译', '故事'] },
    { id: 7310, title: '异常插画稿 #4', author: 'AndyBlocker', rating: 56, date: '2025-01-19', tags: ['艺术', '故事'] },
    { id: 5514, title: 'GoI-CN：灰烬协议', author: 'Mann', rating: 132, date: '2025-06-18', tags: ['goi', '故事'] },
    { id: 3301, title: 'SCP-CN-3301', author: 'AndyBlocker', rating: 601, date: '2025-12-15', tags: ['scp', '故事'] },
  ],
};

const tagRecentPages: Record<string, TagPageItem[]> = {
  scp: [
    { id: 5230, title: '命运支线', author: 'CycleWriter', rating: 168, date: '2026-02-28', tags: ['scp', '循环'] },
    { id: 5003, title: '记忆的回声', author: 'EchoMind', rating: 156, date: '2026-02-25', tags: ['scp', '记忆'] },
    { id: 5002, title: '轮回之门', author: 'CycleWriter', rating: 98, date: '2026-02-22', tags: ['scp', '传送'] },
    { id: 5001, title: '永恒的星期二', author: 'TimeKeeper', rating: 142, date: '2026-02-20', tags: ['scp', '循环'] },
    { id: 4102, title: 'SCP-CN-4102', author: 'Ravel', rating: 146, date: '2025-08-21', tags: ['scp', '论坛'] },
    { id: 5514, title: 'GoI-CN：灰烬协议', author: 'Mann', rating: 132, date: '2025-06-18', tags: ['scp', 'goi'] },
    { id: 3891, title: '循环手记', author: 'EchoMind', rating: 97, date: '2026-02-23', tags: ['scp', '故事'] },
    { id: 2025, title: 'SCPPER-CN 2025 年度总结', author: 'AndyBlocker', rating: 213, date: '2025-12-31', tags: ['数据', '故事'] },
  ],
  故事: [
    { id: 5230, title: '命运支线', author: 'CycleWriter', rating: 168, date: '2026-02-28', tags: ['故事', '循环'] },
    { id: 5003, title: '记忆的回声', author: 'EchoMind', rating: 156, date: '2026-02-25', tags: ['故事', '记忆'] },
    { id: 3891, title: '循环手记', author: 'EchoMind', rating: 97, date: '2026-02-23', tags: ['故事', '时间'] },
    { id: 5001, title: '永恒的星期二', author: 'TimeKeeper', rating: 142, date: '2026-02-20', tags: ['故事', '循环'] },
    { id: 2025, title: 'SCPPER-CN 2025 年度总结', author: 'AndyBlocker', rating: 213, date: '2025-12-31', tags: ['故事', '年度总结'] },
    { id: 616, title: '超形上学导论', author: 'Etinjat', rating: 616, date: '2024-08-20', tags: ['故事', '设定'] },
    { id: 617, title: '叙事理论概述', author: 'Etinjat', rating: 423, date: '2024-10-05', tags: ['故事', '设定'] },
    { id: 1022, title: '译文：温顺之神', author: 'AndyBlocker', rating: 79, date: '2024-10-12', tags: ['故事', '翻译'] },
  ],
};

const toolsList: Array<{ id: string; title: string; desc: string; usage: number; icon: unknown; colorClass: string }> = [
  { id: 'analytics', title: '站点数据分析', desc: '站点整体指标与趋势对比', usage: 12453, icon: BarChart3, colorClass: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300' },
  { id: 'tags', title: '标签偏好榜', desc: '标签偏好分层与联动关系', usage: 9021, icon: Tags, colorClass: 'bg-fuchsia-100 text-fuchsia-700 dark:bg-fuchsia-950/50 dark:text-fuchsia-300' },
  { id: 'gallery', title: '图片画廊', desc: '站内图像资源与使用分布', usage: 7130, icon: Image, colorClass: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300' },
  { id: 'series', title: '编号系列占用', desc: '编号段占用/空闲情况', usage: 6420, icon: Grid3x3, colorClass: 'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300' },
  { id: 'calendar', title: '活动月历', desc: '按日历查看创作与投票波峰', usage: 5579, icon: Calendar, colorClass: 'bg-rose-100 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300' },
  { id: 'gacha', title: '抽卡图鉴', desc: '卡池、掉落和收藏进度面板', usage: 4312, icon: Sparkles, colorClass: 'bg-violet-100 text-violet-700 dark:bg-violet-950/50 dark:text-violet-300' },
  { id: 'ftml', title: 'FTML 编辑器', desc: '在线编辑与实时渲染预览', usage: 5020, icon: Code, colorClass: 'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-300' },
  { id: 'text-lab', title: '文本分析实验室', desc: '词频、风格、叙事结构检测', usage: 3840, icon: FlaskConical, colorClass: 'bg-teal-100 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300' },
];

const sponsors = [
  { name: 'ColdRiver', date: '2026-01-11', message: '感谢把站点数据做得这么易读。' },
  { name: 'Mirai', date: '2026-01-28', message: '竞赛专题页非常实用，已加入写作流程。' },
  { name: 'OldBear', date: '2026-02-02', message: '希望论坛数据分析继续深入。' },
  { name: 'CycleWriter', date: '2026-02-26', message: '期待下一版标签推荐算法。' },
];

const roadmap = {
  done: ['多视图重构样式系统', '竞赛专题页与入口整合', '页面/用户/标签 mock 数据层', '统一分页与空态组件', '暗色模式一键切换'],
  working: ['论坛主题结构化索引', 'Tag 画像与关联推荐', '移动端布局精修'],
  planned: ['跨页收藏夹同步', '图像画廊增强筛选', '多语言文案切换'],
};

const mobileMenuOpen = ref(false);
const searchQuery = ref('');
const searchInput = ref<HTMLInputElement | null>(null);
const currentView = ref<ViewId>('home');
const currentId = ref<number | string | null>(null);
const viewLoading = ref(false);
const isDark = ref(false);
const copiedId = ref(false);

const rankTab = ref<RankTab>('overall');
const rankPageSize = ref(20);
const rankPage = ref(1);
const rankSort = ref<{ key: RankSortKey; direction: SortDirection }>({ key: 'score', direction: 'desc' });

const searchTab = ref<SearchTab>('pages');
const searchTarget = ref<SearchTarget>('all');
const showAdvanced = ref(false);
const includeTags = ref<string[]>([]);
const excludeTags = ref<string[]>([]);
const includeTagInput = ref('');
const excludeTagInput = ref('');
const authorFilter = ref('');
const scoreMin = ref<number | null>(null);
const scoreMax = ref<number | null>(null);
const sortBy = ref<SearchSort>('relevance');
const pageStatus = ref<PageStatusFilter>('all');
const searchPage = ref(1);
const searchPageSize = ref(4);

const pageRevisionPage = ref(1);
const pageVotePage = ref(1);
const pageRevisionPageSize = ref(4);
const pageVotePageSize = ref(4);

const userWorksTab = ref<WorkTab>('all');
const userWorksSort = ref<'time' | 'rating'>('time');
const userWorksPage = ref(1);
const userWorksPageSize = ref(4);
const userFollowed = ref(false);

const tagTopCount = ref<6 | 9 | 12>(6);
let viewTimer: ReturnType<typeof setTimeout> | null = null;
let copyTimer: ReturnType<typeof setTimeout> | null = null;

const numericOrNull = (value: number | null) => {
  if (typeof value !== 'number') return null;
  return Number.isFinite(value) ? value : null;
};

const fmt = (value: number) => value.toLocaleString('zh-CN');
const signed = (value: number) => (value >= 0 ? `+${Number(value).toLocaleString('zh-CN')}` : `${Number(value).toLocaleString('zh-CN')}`);

const buttonClass = computed(() => (isDark.value ? 'bg-neutral-900 border-neutral-700 hover:border-neutral-500 text-neutral-200' : 'bg-white border-neutral-200 hover:border-neutral-300 text-neutral-700'));
const activeSmallButtonClass = computed(() => (isDark.value ? 'bg-neutral-100 text-neutral-900 border-neutral-100' : 'bg-neutral-900 text-white border-neutral-900'));

const rankRows = computed(() => {
  return rankingUsers.map((user) => ({ ...user, activeScore: user.scores[rankTab.value] }));
});

const sortedRankingUsers = computed(() => {
  const rows = [...rankRows.value];
  const { key, direction } = rankSort.value;
  const factor = direction === 'asc' ? 1 : -1;

  rows.sort((left, right) => {
    if (key === 'name') return left.name.localeCompare(right.name, 'zh-CN') * factor;
    if (key === 'pages') return (left.pages - right.pages) * factor;
    if (key === 'avg') return (left.avg - right.avg) * factor;
    return (left.activeScore - right.activeScore) * factor;
  });

  return rows;
});

const rankMaxPages = computed(() => {
  const values = sortedRankingUsers.value.map((item) => item.pages);
  return values.length ? Math.max(...values) : 1;
});

const rankMaxScore = computed(() => {
  const values = sortedRankingUsers.value.map((item) => item.activeScore);
  return values.length ? Math.max(...values) : 1;
});

const rankTotal = computed(() => sortedRankingUsers.value.length);
const rankPager = usePagination(rankTotal, rankPageSize, rankPage);

const pagedRankingUsers = computed(() => {
  const start = (rankPage.value - 1) * rankPageSize.value;
  return sortedRankingUsers.value.slice(start, start + rankPageSize.value).map((item, index) => ({
    ...item,
    rank: start + index + 1,
  }));
});

const activeSearchKind = computed<ActiveSearchKind>(() => {
  if (searchTarget.value === 'users') return 'users';
  if (searchTarget.value === 'forums') return 'forums';
  if (searchTarget.value === 'pages') return 'pages';
  return searchTab.value;
});

const normalizedSearchQuery = computed(() => searchQuery.value.trim().toLowerCase());
const normalizedAuthorFilter = computed(() => authorFilter.value.trim().toLowerCase());

const filteredPageSearchResults = computed(() => {
  const query = normalizedSearchQuery.value;
  const minValue = numericOrNull(scoreMin.value);
  const maxValue = numericOrNull(scoreMax.value);

  const filtered = pageSearchResults.filter((item) => {
    if (pageStatus.value === 'excludeDeleted' && item.status === 'deleted') return false;
    if (pageStatus.value === 'onlyDeleted' && item.status !== 'deleted') return false;

    if (normalizedAuthorFilter.value && !item.author.toLowerCase().includes(normalizedAuthorFilter.value)) {
      return false;
    }

    if (minValue !== null && item.rating < minValue) return false;
    if (maxValue !== null && item.rating > maxValue) return false;

    if (includeTags.value.length && !includeTags.value.every((tag) => item.tags.includes(tag))) {
      return false;
    }

    if (excludeTags.value.length && excludeTags.value.some((tag) => item.tags.includes(tag))) {
      return false;
    }

    if (!query) return true;

    return [item.title, item.author, item.excerpt, item.tags.join(' ')].join(' ').toLowerCase().includes(query);
  });

  const list = [...filtered];
  if (sortBy.value === 'ratingDesc') {
    list.sort((a, b) => b.rating - a.rating);
  } else if (sortBy.value === 'newest') {
    list.sort((a, b) => +new Date(b.date) - +new Date(a.date));
  } else if (sortBy.value === 'wilson') {
    list.sort((a, b) => b.wilson - a.wilson);
  } else {
    list.sort((a, b) => {
      const queryScore = (item: SearchPageItem) => {
        if (!query) return item.rating;
        let score = item.rating / 100;
        if (item.title.toLowerCase().includes(query)) score += 8;
        if (item.excerpt.toLowerCase().includes(query)) score += 3;
        if (item.tags.some((tag) => tag.toLowerCase().includes(query))) score += 2;
        return score;
      };
      return queryScore(b) - queryScore(a);
    });
  }

  return list;
});

const filteredUserSearchResults = computed(() => {
  const query = normalizedSearchQuery.value;
  const author = normalizedAuthorFilter.value;

  return userSearchResults
    .filter((item) => {
      if (author && !item.name.toLowerCase().includes(author)) return false;
      if (!query) return true;
      return item.name.toLowerCase().includes(query);
    })
    .sort((a, b) => b.totalScore - a.totalScore);
});

const filteredTagSearchResults = computed(() => {
  const query = normalizedSearchQuery.value;
  return tagSearchResults
    .filter((item) => {
      if (!query) return true;
      return item.name.toLowerCase().includes(query);
    })
    .sort((a, b) => b.pageCount - a.pageCount);
});

const filteredForumSearchResults = computed(() => {
  const query = normalizedSearchQuery.value;
  const author = normalizedAuthorFilter.value;
  const list = forumSearchResults.filter((item) => {
    if (author && !item.author.toLowerCase().includes(author)) return false;
    if (!query) return true;
    return [item.title, item.author, item.excerpt].join(' ').toLowerCase().includes(query);
  });

  if (sortBy.value === 'newest') {
    return [...list].sort((a, b) => +new Date(b.lastActive.replace(' ', 'T')) - +new Date(a.lastActive.replace(' ', 'T')));
  }

  if (sortBy.value === 'ratingDesc') {
    return [...list].sort((a, b) => b.replies - a.replies);
  }

  return list;
});

const searchTotalResults = computed(() => {
  if (activeSearchKind.value === 'pages') return filteredPageSearchResults.value.length;
  if (activeSearchKind.value === 'users') return filteredUserSearchResults.value.length;
  if (activeSearchKind.value === 'tags') return filteredTagSearchResults.value.length;
  return filteredForumSearchResults.value.length;
});

const searchPager = usePagination(searchTotalResults, searchPageSize, searchPage);

const searchSliceStart = computed(() => (searchPage.value - 1) * searchPageSize.value);
const searchSliceEnd = computed(() => searchSliceStart.value + searchPageSize.value);

const pagedPageSearchResults = computed(() => filteredPageSearchResults.value.slice(searchSliceStart.value, searchSliceEnd.value));
const pagedUserSearchResults = computed(() => filteredUserSearchResults.value.slice(searchSliceStart.value, searchSliceEnd.value));
const pagedTagSearchResults = computed(() => filteredTagSearchResults.value.slice(searchSliceStart.value, searchSliceEnd.value));
const pagedForumSearchResults = computed(() => filteredForumSearchResults.value.slice(searchSliceStart.value, searchSliceEnd.value));

const currentPage = computed<PageDetail>(() => {
  if (typeof currentId.value === 'number' && pageData[currentId.value]) {
    return pageData[currentId.value];
  }
  return pageData[3301];
});

const currentPageType = computed(() => {
  const tags = currentPage.value.tags;
  if (tags.includes('goi')) return 'GoI';
  if (tags.includes('故事')) return '故事';
  if (tags.includes('翻译')) return '翻译';
  if (tags.includes('艺术')) return '艺术';
  return 'SCP';
});

const pageVoteRatio = computed(() => {
  const total = currentPage.value.upvotes + currentPage.value.downvotes;
  if (total <= 0) return 0.5;
  return currentPage.value.upvotes / total;
});

const trendPolylinePoints = computed(() => {
  const values = currentPage.value.trendData;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const width = 300;
  const height = 90;
  const safeRange = Math.max(max - min, 1);

  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width + 10;
      const y = height - ((value - min) / safeRange) * height + 10;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
});

const revisionTotal = computed(() => currentPage.value.revisionHistory.length);
const voteTotal = computed(() => currentPage.value.recentVotes.length);
const revisionPager = usePagination(revisionTotal, pageRevisionPageSize, pageRevisionPage);
const votePager = usePagination(voteTotal, pageVotePageSize, pageVotePage);

const pagedRevisions = computed(() => {
  const start = (pageRevisionPage.value - 1) * pageRevisionPageSize.value;
  return currentPage.value.revisionHistory.slice(start, start + pageRevisionPageSize.value);
});

const pagedVotes = computed(() => {
  const start = (pageVotePage.value - 1) * pageVotePageSize.value;
  return currentPage.value.recentVotes.slice(start, start + pageVotePageSize.value);
});

const currentUser = computed<UserProfile>(() => {
  if (typeof currentId.value === 'number' && userProfiles[currentId.value]) {
    return userProfiles[currentId.value];
  }
  return userProfiles[10086];
});

const userMetrics = computed(() => [
  { label: '总评分', value: signed(currentUser.value.totalScore) },
  { label: '均分', value: signed(currentUser.value.avgScore) },
  { label: '作品数', value: `${currentUser.value.pages}` },
  { label: '支持票', value: fmt(currentUser.value.upvotes) },
  { label: '反对票', value: fmt(currentUser.value.downvotes) },
  { label: '修订数', value: fmt(currentUser.value.revisions) },
]);

const filteredUserWorks = computed(() => {
  const works = currentUser.value.works.filter((item) => {
    if (userWorksTab.value === 'all') return true;
    return item.type === userWorksTab.value;
  });

  if (userWorksSort.value === 'rating') {
    return [...works].sort((a, b) => b.rating - a.rating);
  }

  return [...works].sort((a, b) => +new Date(b.date) - +new Date(a.date));
});

const userWorksTotal = computed(() => filteredUserWorks.value.length);
const userWorksPager = usePagination(userWorksTotal, userWorksPageSize, userWorksPage);

const pagedUserWorks = computed(() => {
  const start = (userWorksPage.value - 1) * userWorksPageSize.value;
  return filteredUserWorks.value.slice(start, start + userWorksPageSize.value);
});

const currentTag = computed(() => {
  if (typeof currentId.value === 'string' && currentId.value.trim()) {
    return currentId.value;
  }
  return 'scp';
});

const currentTagData = computed<TagOverview>(() => {
  return tagOverviews[currentTag.value] || tagOverviews.scp;
});

const visibleTagTopPages = computed(() => {
  const list = tagTopPages[currentTag.value] || tagTopPages.scp;
  return list.slice(0, tagTopCount.value);
});

const currentTagRecentPages = computed(() => {
  return tagRecentPages[currentTag.value] || tagRecentPages.scp;
});

const viewTitle = computed(() => {
  const staticTitles: Partial<Record<ViewId, string>> = {
    ranking: '用户排行',
    search: '搜索',
    tag: `#${currentTagData.value.name}`,
    tools: '数据工具',
    contest: '2026 冬季征文',
    about: '关于',
  };

  if (currentView.value === 'page') return currentPage.value.title;
  if (currentView.value === 'user') return currentUser.value.name;
  return staticTitles[currentView.value] || '';
});

const contests = computed(() => [
  { id: 'cn4000', title: 'SCP-CN-4000 竞赛', status: '已结束', desc: '累计投稿 173 篇，现可查看归档结果。', action: null as null | (() => void) },
  { id: 'newbee2025', title: '2025 新秀竞赛', status: '已结束', desc: '新人创作者集中展示与回顾。', action: null as null | (() => void) },
  { id: 'winter2026', title: '2026 冬季征文：循环', status: '进行中', desc: '投稿与投票均可在专题页查看。', action: () => go('contest') },
]);

const applyThemeClass = (dark: boolean) => {
  if (!process.client) return;
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.classList.toggle('light', !dark);
  localStorage.setItem('theme', dark ? 'dark' : 'light');
};

const startViewLoading = () => {
  viewLoading.value = true;
  if (viewTimer) clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    viewLoading.value = false;
  }, 200);
};

const go = (view: ViewId, id?: number | string) => {
  currentView.value = view;
  currentId.value = id ?? null;
  mobileMenuOpen.value = false;
  startViewLoading();

  if (process.client) {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  if (view === 'search') {
    nextTick(() => {
      searchInput.value?.focus();
    });
  }
};

const toggleDark = () => {
  isDark.value = !isDark.value;
  applyThemeClass(isDark.value);
};

const handleSearch = () => {
  if (!searchQuery.value.trim()) return;
  go('search');
};

const toggleRankSort = (key: RankSortKey) => {
  if (rankSort.value.key === key) {
    rankSort.value.direction = rankSort.value.direction === 'asc' ? 'desc' : 'asc';
    return;
  }
  rankSort.value.key = key;
  rankSort.value.direction = key === 'name' ? 'asc' : 'desc';
};

const setSearchTarget = (target: SearchTarget) => {
  searchTarget.value = target;
  if (target === 'users') {
    searchTab.value = 'users';
  } else if (target === 'pages') {
    searchTab.value = 'pages';
  }
};

const pushSearchTag = (mode: 'include' | 'exclude') => {
  const input = mode === 'include' ? includeTagInput : excludeTagInput;
  const value = input.value.trim().toLowerCase();
  if (!value) return;

  const list = mode === 'include' ? includeTags : excludeTags;
  if (!list.value.includes(value)) {
    list.value = [...list.value, value];
  }

  input.value = '';
};

const removeSearchTag = (mode: 'include' | 'exclude', tag: string) => {
  const list = mode === 'include' ? includeTags : excludeTags;
  list.value = list.value.filter((item) => item !== tag);
};

const copyId = async () => {
  if (!process.client || !navigator.clipboard) return;
  await navigator.clipboard.writeText(currentPage.value.pageId);
  copiedId.value = true;
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copiedId.value = false;
  }, 1200);
};

const shuffleRelatedPages = () => {
  const page = currentPage.value;
  const clone = [...page.relatedPages];
  clone.sort(() => Math.random() - 0.5);
  page.relatedPages = clone;
};

const refreshTagData = () => {
  const currentTop = tagTopPages[currentTag.value] || tagTopPages.scp;
  const shuffled = [...currentTop].sort(() => Math.random() - 0.5);
  tagTopPages[currentTag.value] = shuffled;
};

const revisionTypeClass = (type: RevisionEntry['type']) => {
  if (type === 'create') return 'revision-type-create';
  if (type === 'edit') return 'revision-type-edit';
  if (type === 'title') return 'revision-type-title';
  return 'revision-type-tags';
};

const revisionTypeLabel = (type: RevisionEntry['type']) => {
  if (type === 'create') return '创建';
  if (type === 'edit') return '编辑';
  if (type === 'title') return '标题变更';
  return '标签变更';
};

onMounted(() => {
  if (!process.client) return;
  isDark.value = document.documentElement.classList.contains('dark');
  if (!document.documentElement.classList.contains('dark') && !document.documentElement.classList.contains('light')) {
    document.documentElement.classList.add('light');
    isDark.value = false;
  }
});

watch(rankTab, () => {
  rankPage.value = 1;
});

watch([searchTab, searchTarget, searchQuery, authorFilter, scoreMin, scoreMax, sortBy, pageStatus], () => {
  searchPage.value = 1;
});

watch([includeTags, excludeTags], () => {
  searchPage.value = 1;
}, { deep: true });

watch(currentView, () => {
  if (currentView.value === 'page') {
    pageRevisionPage.value = 1;
    pageVotePage.value = 1;
  }

  if (currentView.value === 'user') {
    userWorksPage.value = 1;
    userWorksTab.value = 'all';
  }

  if (currentView.value === 'tag') {
    tagTopCount.value = 6;
  }
});

watch(currentId, () => {
  pageRevisionPage.value = 1;
  pageVotePage.value = 1;
  userWorksPage.value = 1;
});

onBeforeUnmount(() => {
  if (viewTimer) clearTimeout(viewTimer);
  if (copyTimer) clearTimeout(copyTimer);
});
</script>

<style src="~/assets/css/redesign.css"></style>

<style scoped>
.rd-app {
  font-family: 'IBM Plex Sans', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif;
}
</style>
