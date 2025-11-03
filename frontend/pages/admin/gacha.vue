
<template>
  <div class="mx-auto max-w-6xl space-y-8 py-10">
    <h1 class="text-2xl font-bold text-neutral-900 dark:text-neutral-100">抽卡管理</h1>

    <div v-if="authStatus === 'unknown'" class="rounded-xl border border-dashed border-neutral-200/70 bg-white/70 p-6 text-sm text-neutral-600 dark:border-neutral-800/70 dark:bg-neutral-900/60 dark:text-neutral-300">
      正在校验登录状态...
    </div>

    <div v-else-if="authStatus === 'unauthenticated'" class="rounded-xl border border-neutral-200/70 bg-white/80 p-6 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/80 dark:text-neutral-300">
      <p>请先登录账户以访问抽卡管理页面。</p>
      <NuxtLink to="/auth/login" class="mt-2 inline-block text-[rgb(var(--accent-strong))] hover:underline">前往登录</NuxtLink>
    </div>

    <div v-else>
      <div v-if="adminError" class="rounded-xl border border-rose-200/70 bg-rose-50/70 p-6 text-sm text-rose-600 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200">
        {{ adminError }}
      </div>

      <div v-else class="space-y-8">
        <section class="space-y-5 rounded-2xl border border-neutral-200/70 bg-white/80 p-5 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
          <header class="space-y-1">
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">抽卡返还配置</h2>
            <p class="text-sm text-neutral-500 dark:text-neutral-400">按稀有度设置抽取与分解返还，用于所有卡池的默认值。</p>
          </header>
          <transition name="fade">
            <p v-if="economyError" class="rounded-lg border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-xs text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
              {{ economyError }}
            </p>
          </transition>
          <transition name="fade">
            <p v-if="economyMessage" class="rounded-lg border border-emerald-200/70 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
              {{ economyMessage }}
            </p>
          </transition>
          <div v-if="economyLoading && !economyConfig" class="rounded-xl border border-dashed border-neutral-200/70 bg-white/70 p-4 text-center text-sm text-neutral-500 dark:border-neutral-800/70 dark:bg-neutral-900/60 dark:text-neutral-400">
            正在加载配置...
          </div>
          <div class="grid gap-5 md:grid-cols-2">
            <div class="space-y-3 rounded-2xl border border-neutral-200/70 bg-white/85 p-4 dark:border-neutral-800/60 dark:bg-neutral-900/60">
              <h3 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">抽取返还</h3>
              <div class="space-y-2">
                <div v-for="rarity in rarityOrder" :key="'economy-draw-' + rarity" class="flex items-center justify-between gap-3">
                  <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">{{ rarityLabel(rarity) }}</label>
                  <input v-model.number="economyForm.drawRewards[rarity]" type="number" min="0" class="w-24 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" :disabled="economyLoading" />
                </div>
              </div>
            </div>
            <div class="space-y-3 rounded-2xl border border-neutral-200/70 bg-white/85 p-4 dark:border-neutral-800/60 dark:bg-neutral-900/60">
              <h3 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">分解返还</h3>
              <div class="space-y-2">
                <div v-for="rarity in rarityOrder" :key="'economy-dismantle-' + rarity" class="flex items-center justify-between gap-3">
                  <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">{{ rarityLabel(rarity) }}</label>
                  <input v-model.number="economyForm.dismantleRewards[rarity]" type="number" min="0" class="w-24 rounded-lg border border-neutral-200 bg-white px-2 py-1 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" :disabled="economyLoading" />
                </div>
              </div>
            </div>
          </div>
          <div class="flex items-center justify-end gap-2">
            <button type="button" class="rounded-lg border border-neutral-200 px-4 py-2 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" :disabled="economyLoading" @click="resetEconomyForm">重置</button>
            <button type="button" class="rounded-lg bg-[rgb(var(--accent-strong))] px-4 py-2 text-xs font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))] disabled:opacity-60" :disabled="economyLoading" @click="submitEconomy">
              <span v-if="economyLoading">处理中...</span>
              <span v-else>保存配置</span>
            </button>
          </div>
        </section>
        <section class="space-y-5 rounded-2xl border border-neutral-200/70 bg-white/80 p-5 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
          <header class="space-y-1">
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">Token 调整工具</h2>
            <p class="text-sm text-neutral-500 dark:text-neutral-400">调试时可快速增减指定用户或全体用户的钱包余额。</p>
          </header>
          <div class="grid gap-5 md:grid-cols-2">
            <form class="space-y-3 rounded-2xl border border-neutral-200/70 bg-white/85 p-4 dark:border-neutral-800/60 dark:bg-neutral-900/60" @submit.prevent="submitWalletAdjust">
              <h3 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">单个用户</h3>
              <p class="text-xs text-neutral-500 dark:text-neutral-400">至少填写 userId 或邮箱其一。</p>
              <input v-model.trim="walletAdjustForm.userId" type="text" placeholder="userId" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
              <input v-model.trim="walletAdjustForm.email" type="email" placeholder="邮箱" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
              <input v-model.number="walletAdjustForm.delta" type="number" placeholder="调整数额（可为负）" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
              <input v-model.trim="walletAdjustForm.reason" type="text" placeholder="备注（可选）" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
              <label class="inline-flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                <input v-model="walletAdjustForm.allowNegative" type="checkbox" class="rounded border-neutral-300 text-[rgb(var(--accent-strong))] focus:ring-[rgb(var(--accent))]" />
                允许余额为负
              </label>
              <transition name="fade">
                <p v-if="walletAdjustSingleError" class="rounded-lg border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-xs text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
                  {{ walletAdjustSingleError }}
                </p>
              </transition>
              <transition name="fade">
                <p v-if="walletAdjustSingleMessage" class="rounded-lg border border-emerald-200/70 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
                  {{ walletAdjustSingleMessage }}
                </p>
              </transition>
              <div class="flex items-center justify-between gap-2">
                <button type="button" class="rounded-lg border border-neutral-200 px-4 py-2 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" :disabled="walletAdjustSingleLoading" @click="resetWalletAdjustForm">清空</button>
                <button type="submit" class="rounded-lg bg-[rgb(var(--accent-strong))] px-4 py-2 text-xs font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))] disabled:opacity-60" :disabled="walletAdjustSingleLoading">
                  <span v-if="walletAdjustSingleLoading">执行中...</span>
                  <span v-else>调整用户</span>
                </button>
              </div>
            </form>
            <form class="space-y-3 rounded-2xl border border-neutral-200/70 bg-white/85 p-4 dark:border-neutral-800/60 dark:bg-neutral-900/60" @submit.prevent="submitWalletAdjustAll">
              <h3 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">全部钱包</h3>
              <input v-model.number="walletAdjustAllForm.delta" type="number" placeholder="调整数额（可为负）" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
              <input v-model.trim="walletAdjustAllForm.reason" type="text" placeholder="备注（可选）" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
              <label class="inline-flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                <input v-model="walletAdjustAllForm.allowNegative" type="checkbox" class="rounded border-neutral-300 text-[rgb(var(--accent-strong))] focus:ring-[rgb(var(--accent))]" />
                允许余额为负
              </label>
              <transition name="fade">
                <p v-if="walletAdjustAllError" class="rounded-lg border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-xs text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
                  {{ walletAdjustAllError }}
                </p>
              </transition>
              <transition name="fade">
                <p v-if="walletAdjustAllMessage" class="rounded-lg border border-emerald-200/70 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
                  {{ walletAdjustAllMessage }}
                </p>
              </transition>
              <div class="flex items-center justify-between gap-2">
                <button type="button" class="rounded-lg border border-neutral-200 px-4 py-2 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" :disabled="walletAdjustAllLoading" @click="resetWalletAdjustAllForm">清空</button>
                <button type="submit" class="rounded-lg bg-[rgb(var(--accent-strong))] px-4 py-2 text-xs font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))] disabled:opacity-60" :disabled="walletAdjustAllLoading">
                  <span v-if="walletAdjustAllLoading">执行中...</span>
                  <span v-else>调整全部</span>
                </button>
              </div>
            </form>
          </div>
        </section>
        <section class="space-y-5 rounded-2xl border border-neutral-200/70 bg-white/80 p-5 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
          <header class="space-y-1">
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">卡池与卡片配置</h2>
            <p class="text-sm text-neutral-500 dark:text-neutral-400">维护常驻卡池、创建卡片并即时同步到抽卡服务。</p>
          </header>

          <div class="grid gap-5 lg:grid-cols-2">
            <div class="space-y-4 rounded-2xl border border-neutral-200/70 bg-white/85 p-4 dark:border-neutral-800/60 dark:bg-neutral-900/60">
              <div class="flex items-center justify-between">
                <h3 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">{{ editingPoolId ? '编辑卡池' : '新增卡池' }}</h3>
                <button type="button" class="text-xs text-[rgb(var(--accent-strong))] hover:underline" @click="resetPoolForm()">重置</button>
              </div>
              <div class="space-y-2">
                <label class="block text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">名称</label>
                <input v-model="poolForm.name" type="text" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
              </div>
              <div class="space-y-2">
                <label class="block text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">简介</label>
                <textarea v-model="poolForm.description" rows="3" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100"></textarea>
              </div>
              <div class="grid gap-3 sm:grid-cols-3">
                <div class="space-y-1">
                  <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">单抽消耗</label>
                  <input v-model.number="poolForm.tokenCost" type="number" min="1" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
                </div>
                <div class="space-y-1">
                  <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">十连消耗</label>
                  <input v-model.number="poolForm.tenDrawCost" type="number" min="1" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
                </div>
                <div class="space-y-1">
                  <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">重复奖励</label>
                  <input v-model.number="poolForm.rewardPerDuplicate" type="number" min="0" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
                </div>
              </div>
              <div class="grid gap-3 sm:grid-cols-2">
                <div class="space-y-1">
                  <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">开始时间</label>
                  <input v-model="poolForm.startsAt" type="datetime-local" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
                </div>
                <div class="space-y-1">
                  <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">结束时间</label>
                  <input v-model="poolForm.endsAt" type="datetime-local" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
                </div>
              </div>
              <div class="space-y-2 rounded-xl border border-neutral-200/70 bg-white/70 p-3 text-xs text-neutral-600 dark:border-neutral-800/60 dark:bg-neutral-900/50 dark:text-neutral-300">
                <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">初始卡片</label>
                <div class="flex flex-col gap-2">
                  <label class="inline-flex items-center gap-2">
                    <input v-model="poolForm.copyAllCards" type="checkbox" class="rounded border-neutral-300 text-[rgb(var(--accent-strong))] focus:ring-[rgb(var(--accent))]" :disabled="!!editingPoolId" />
                    <span>复制全部现有卡片作为起始内容</span>
                  </label>
                  <p class="text-[11px] text-neutral-400 dark:text-neutral-500">仅在创建新卡池时生效；可在创建后继续微调或批量删除。</p>
                  <div class="space-y-1" :class="(poolForm.copyAllCards || editingPoolId) ? 'opacity-50 pointer-events-none' : ''">
                    <label class="text-[11px] uppercase tracking-wide text-neutral-400 dark:text-neutral-500">或指定来源卡池</label>
                    <select v-model="poolForm.copyFromPoolId" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
                      <option value="">选择卡池</option>
                      <option v-for="pool in pools" :key="pool.id" :value="pool.id">{{ pool.name }}</option>
                    </select>
                  </div>
                </div>
              </div>
              <label class="inline-flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
                <input v-model="poolForm.isActive" type="checkbox" class="rounded border-neutral-300 text-[rgb(var(--accent-strong))] focus:ring-[rgb(var(--accent))]" />
                卡池开放
              </label>
              <transition name="fade">
                <p v-if="poolError" class="rounded-lg border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-xs text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
                  {{ poolError }}
                </p>
              </transition>
              <transition name="fade">
                <p v-if="poolMessage" class="rounded-lg border border-emerald-200/70 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
                  {{ poolMessage }}
                </p>
              </transition>
              <div class="flex items-center justify-end gap-2">
                <button type="button" class="rounded-lg border border-neutral-200 px-4 py-2 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" @click="startCreatePool()">
                  {{ editingPoolId ? '取消编辑' : '清空' }}
                </button>
                <button type="button" class="rounded-lg bg-[rgb(var(--accent-strong))] px-4 py-2 text-xs font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))] disabled:opacity-60" :disabled="poolLoading" @click="submitPool()">
                  <span v-if="poolLoading">处理中...</span>
                  <span v-else>{{ editingPoolId ? '保存修改' : '创建卡池' }}</span>
                </button>
              </div>
            </div>

            <div class="space-y-3 rounded-2xl border border-neutral-200/70 bg-white/85 p-4 dark:border-neutral-800/60 dark:bg-neutral-900/60">
              <div class="flex items-center justify-between">
                <h3 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">卡池列表</h3>
                <button type="button" class="text-xs text-[rgb(var(--accent-strong))] hover:underline" @click="loadPools(true)">刷新</button>
              </div>
              <div v-if="poolLoading" class="rounded-lg border border-dashed border-neutral-200/70 bg-neutral-50/70 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-800/70 dark:bg-neutral-900/60 dark:text-neutral-300">
                卡池加载中...
              </div>
              <ul v-else class="space-y-3 text-sm text-neutral-600 dark:text-neutral-300">
                <li v-for="pool in pools" :key="pool.id" class="space-y-2 rounded-xl border border-neutral-200/70 bg-white/70 p-3 dark:border-neutral-800/60 dark:bg-neutral-900/60">
                  <div class="flex items-center justify-between gap-2">
                    <div>
                      <div class="flex items-center gap-2">
                        <span class="text-sm font-semibold text-neutral-900 dark:text-neutral-100">{{ pool.name }}</span>
                        <span class="rounded-full border px-2 py-0.5 text-[11px]" :class="pool.isActive ? 'border-emerald-300/70 text-emerald-600 dark:border-emerald-500/40 dark:text-emerald-300' : 'border-neutral-300/70 text-neutral-500 dark:border-neutral-700/50 dark:text-neutral-400'">
                          {{ pool.isActive ? '开放中' : '未开放' }}
                        </span>
                      </div>
                      <p class="text-xs text-neutral-500 dark:text-neutral-400">单抽 {{ pool.tokenCost }} ｜ 十连 {{ pool.tenDrawCost }} ｜ 重复 {{ pool.rewardPerDuplicate }}</p>
                    </div>
                    <div class="flex items-center gap-2 text-xs">
                      <button type="button" class="rounded border border-neutral-200 px-2 py-1 text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" @click="selectPoolForCards(pool.id)">查看卡片</button>
                      <button type="button" class="rounded border border-neutral-200 px-2 py-1 text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" @click="startEditPool(pool)">编辑</button>
                      <button type="button" class="rounded border border-rose-200 px-2 py-1 text-rose-600 hover:bg-rose-50 dark:border-rose-500/50 dark:text-rose-300 dark:hover:bg-rose-500/10" @click="removePool(pool)">删除</button>
                    </div>
                  </div>
                  <p v-if="pool.description" class="text-xs text-neutral-500 dark:text-neutral-400">{{ pool.description }}</p>
                  <p class="text-[11px] text-neutral-400 dark:text-neutral-500">
                    开始：{{ pool.startsAt ? new Date(pool.startsAt).toLocaleString() : '未设定' }} ｜ 结束：{{ pool.endsAt ? new Date(pool.endsAt).toLocaleString() : '未设定' }}
                  </p>
                </li>
                <li v-if="pools.length === 0" class="rounded-lg border border-dashed border-neutral-200/70 bg-neutral-50/70 px-3 py-2 text-center text-xs text-neutral-500 dark:border-neutral-800/70 dark:bg-neutral-900/60 dark:text-neutral-400">
                  暂无卡池，先创建一个常驻卡池吧。
                </li>
              </ul>
            </div>
          </div>

          <div class="space-y-3 rounded-2xl border border-neutral-200/70 bg-white/85 p-4 dark:border-neutral-800/60 dark:bg-neutral-900/60">
            <div class="flex items-center justify-between">
              <h3 class="text-sm font-semibold text-neutral-800 dark:text-neutral-100">{{ editingCardId ? '编辑卡片' : '新增卡片' }}</h3>
              <button type="button" class="text-xs text-[rgb(var(--accent-strong))] hover:underline" @click="resetCardForm()">重置</button>
            </div>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div class="space-y-1">
                <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">卡池</label>
                <select v-model="cardForm.poolId" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
                  <option value="">选择卡池</option>
                  <option v-for="pool in pools" :key="pool.id" :value="pool.id">{{ pool.name }}</option>
                </select>
              </div>
              <div class="space-y-1">
                <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">标题</label>
                <input v-model="cardForm.title" type="text" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
              </div>
              <div class="space-y-1">
                <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">稀有度</label>
                <select v-model="cardForm.rarity" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
                  <option v-for="option in raritySelectOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
                </select>
              </div>
              <div class="space-y-1">
                <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">权重</label>
                <input v-model.number="cardForm.weight" type="number" min="1" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
              </div>
              <div class="space-y-1">
                <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">抽取返还</label>
                <input v-model.number="cardForm.rewardTokens" type="number" min="0" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
              </div>
              <div class="space-y-1">
                <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">图片地址</label>
                <input v-model="cardForm.imageUrl" type="url" placeholder="https://..." class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
              </div>
              <div class="space-y-1">
                <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">Wikidot ID</label>
                <input v-model="cardForm.wikidotId" type="number" min="0" placeholder="可选" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
              </div>
              <div class="space-y-1">
                <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">Page ID</label>
                <input v-model="cardForm.pageId" type="number" min="0" placeholder="可选" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
              </div>
            </div>
            <div class="space-y-1">
              <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">标签（逐个添加）</label>
              <div class="flex flex-wrap items-center gap-2">
                <input v-model="cardForm.tagsInput" type="text" placeholder="输入标签后回车" class="flex-1 min-w-[180px] rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" @keyup.enter.prevent="addCardTag" />
                <button type="button" class="rounded border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" @click="addCardTag">添加</button>
              </div>
              <div v-if="cardForm.tags.length" class="flex flex-wrap gap-2">
                <span v-for="tag in cardForm.tags" :key="tag" class="inline-flex items-center gap-1 rounded-full bg-neutral-100 px-2 py-1 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-200">
                  #{{ tag }}
                  <button type="button" class="text-[rgb(var(--accent-strong))]" @click="removeCardTag(tag)">×</button>
                </span>
              </div>
            </div>
            <transition name="fade">
              <p v-if="cardFormError" class="rounded-lg border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-xs text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
                {{ cardFormError }}
              </p>
            </transition>
            <transition name="fade">
              <p v-if="cardMessage" class="rounded-lg border border-emerald-200/70 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
                {{ cardMessage }}
              </p>
            </transition>
            <div class="flex items-center justify-end gap-2">
              <button type="button" class="rounded-lg border border-neutral-200 px-4 py-2 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" @click="resetCardForm()">清空</button>
              <button type="button" class="rounded-lg bg-[rgb(var(--accent-strong))] px-4 py-2 text-xs font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))] disabled:opacity-60" :disabled="cardSubmitting" @click="submitCard()">
                <span v-if="cardSubmitting">处理中...</span>
                <span v-else>{{ editingCardId ? '保存卡片' : '新增卡片' }}</span>
              </button>
            </div>
          </div>
        </section>

        <section class="space-y-4 rounded-2xl border border-neutral-200/70 bg-white/80 p-5 dark:border-neutral-800/70 dark:bg-neutral-900/70">
          <header class="flex items-center justify-between">
            <div>
              <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">卡片列表</h2>
              <p class="text-sm text-neutral-500 dark:text-neutral-400">通过筛选与分页查看卡片，并执行编辑或删除操作。</p>
            </div>
            <div class="flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <span>每页</span>
              <select v-model.number="cardLimit" class="rounded border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
                <option v-for="size in cardLimitOptions" :key="size" :value="size">{{ size }}</option>
              </select>
            </div>
          </header>

          <div class="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <div class="space-y-1">
              <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">卡池</label>
              <select v-model="cardFilters.poolId" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
                <option value="">选择卡池</option>
                <option v-for="pool in pools" :key="pool.id" :value="pool.id">{{ pool.name }}</option>
              </select>
            </div>
            <div class="space-y-1">
              <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">稀有度</label>
              <select v-model="cardFilters.rarity" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
                <option value="ALL">全部</option>
                <option v-for="option in raritySelectOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </div>
            <div class="space-y-1">
              <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">包含标签</label>
              <input v-model="cardFilters.includeTags" type="text" placeholder="tag-a, tag-b" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
            </div>
            <div class="space-y-1">
              <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">排除标签</label>
              <input v-model="cardFilters.excludeTags" type="text" placeholder="tag-c" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <div class="flex-1 min-w-[220px]">
              <input v-model="cardFilters.search" type="text" placeholder="搜索标题或标签" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" @keyup.enter="applyCardFilters" />
            </div>
            <div class="flex items-center gap-2">
              <button type="button" class="rounded border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" @click="applyCardFilters">应用筛选</button>
              <button type="button" class="rounded border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" @click="clearCardFilters">重置</button>
            </div>
          </div>

          <transition name="fade">
            <p v-if="cardError" class="rounded-lg border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-xs text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
              {{ cardError }}
            </p>
          </transition>

          <div v-if="cardLoading" class="rounded-xl border border-dashed border-neutral-200/70 bg-neutral-50/70 px-4 py-3 text-sm text-neutral-500 dark:border-neutral-800/70 dark:bg-neutral-900/60 dark:text-neutral-300">
            卡片数据加载中...
          </div>
          <div v-else-if="cardItems.length === 0" class="rounded-xl border border-dashed border-neutral-200/70 bg-neutral-50/70 px-4 py-3 text-sm text-neutral-500 dark:border-neutral-800/70 dark:bg-neutral-900/60 dark:text-neutral-300">
            暂无符合条件的卡片。
          </div>
          <div v-else class="overflow-x-auto">
            <table class="min-w-full text-xs text-neutral-600 dark:text-neutral-300">
              <thead>
                <tr class="bg-neutral-50/70 text-neutral-500 dark:bg-neutral-900/60 dark:text-neutral-400">
                  <th class="px-2 py-1 text-left">标题</th>
                  <th class="px-2 py-1 text-left">稀有度</th>
                  <th class="px-2 py-1 text-left">权重</th>
                  <th class="px-2 py-1 text-left">抽取返还</th>
                  <th class="px-2 py-1 text-left">标签</th>
                  <th class="px-2 py-1 text-left">卡池</th>
                  <th class="px-2 py-1 text-right">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="card in cardItems" :key="card.id" class="border-t border-neutral-200/60 bg-white/70 dark:border-neutral-800/60 dark:bg-neutral-900/50">
                  <td class="px-2 py-1">{{ card.title }}</td>
                  <td class="px-2 py-1">{{ rarityLabel(card.rarity) }}</td>
                  <td class="px-2 py-1">{{ card.weight }}</td>
                  <td class="px-2 py-1">{{ card.rewardTokens }}</td>
                  <td class="px-2 py-1">{{ card.tags?.join(', ') || '-' }}</td>
                  <td class="px-2 py-1">{{ card.poolName || '-' }}</td>
                  <td class="px-2 py-1 text-right">
                    <div class="inline-flex items-center gap-2">
                      <button type="button" class="text-[rgb(var(--accent-strong))] hover:underline" @click="startEditCard(card)">编辑</button>
                      <button type="button" class="text-rose-500 hover:text-rose-600 dark:text-rose-300 dark:hover:text-rose-200" @click="removeCard(card)">删除</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <transition name="fade">
            <p v-if="cardMessage" class="rounded-lg border border-emerald-200/70 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
              {{ cardMessage }}
            </p>
          </transition>
          <div class="flex flex-wrap items-center justify-between gap-3 text-xs text-neutral-500 dark:text-neutral-400">
            <div>显示 {{ cardPageStart }} - {{ cardPageEnd }} / {{ cardTotal }}</div>
            <div class="flex items-center gap-2">
              <button type="button" class="rounded border border-neutral-200 px-3 py-1 text-xs text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" :disabled="!cardHasPrev" @click="goPrevCardPage">上一页</button>
              <button type="button" class="rounded border border-neutral-200 px-3 py-1 text-xs text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" :disabled="!cardHasNext" @click="goNextCardPage">下一页</button>
            </div>
          </div>
        </section>

        <section class="space-y-4 rounded-2xl border border-neutral-200/70 bg-white/80 p-5 dark:border-neutral-800/70 dark:bg-neutral-900/70">
          <header class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">批量调整权重</h2>
              <p class="text-sm text-neutral-500 dark:text-neutral-400">通过标签筛选卡片，并统一调整权重。</p>
            </div>
            <div class="flex items-center gap-2">
              <button type="button" class="rounded border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" @click="applyFiltersToBatch">
                使用当前筛选
              </button>
              <button type="button" class="rounded border border-neutral-200 px-3 py-1.5 text-xs font-medium text-neutral-600 hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" @click="resetBatchForm">
                重置
              </button>
            </div>
          </header>
          <p class="rounded-lg border border-dashed border-neutral-200/60 bg-white/60 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-800/40 dark:bg-neutral-900/40 dark:text-neutral-400">
            当前范围：{{ cardFilterSummary }}
          </p>
          <div class="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
            <div class="space-y-1">
              <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">卡池</label>
              <select v-model="batchForm.poolId" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
                <option value="">全部卡池</option>
                <option v-for="pool in pools" :key="pool.id" :value="pool.id">{{ pool.name }}</option>
              </select>
            </div>
            <div class="space-y-1">
              <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">稀有度</label>
              <select v-model="batchForm.rarity" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
                <option value="ALL">全部</option>
                <option v-for="option in raritySelectOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
              </select>
            </div>
            <div class="space-y-1">
              <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">包含标签</label>
              <input v-model="batchForm.includeTags" type="text" placeholder="tag-a, tag-b" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
            </div>
            <div class="space-y-1">
              <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">排除标签</label>
              <input v-model="batchForm.excludeTags" type="text" placeholder="tag-c" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
            </div>
            <div class="space-y-1">
              <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">匹配方式</label>
              <select v-model="batchForm.match" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100">
                <option value="any">任意匹配</option>
                <option value="all">全部匹配</option>
              </select>
            </div>
            <div class="space-y-1">
              <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">权重倍率</label>
              <input v-model.number="batchForm.multiplier" type="number" min="0" step="0.1" placeholder="1.2" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
            </div>
            <div class="space-y-1">
              <label class="text-xs font-semibold uppercase tracking-wide text-neutral-400 dark:text-neutral-500">目标权重</label>
              <input v-model="batchForm.setWeight" type="number" min="1" placeholder="例如 80" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm text-neutral-700 outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-100" />
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-[11px] text-neutral-500 dark:text-neutral-400">
            <span>常用倍率：</span>
            <button v-for="preset in batchMultiplierPresets" :key="preset" type="button" class="rounded border border-neutral-200 px-2 py-1 text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-neutral-600 dark:hover:text-neutral-50" @click="setBatchMultiplier(preset)">
              ×{{ preset }}
            </button>
          </div>
          <transition name="fade">
            <p v-if="batchError" class="rounded-lg border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-xs text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
              {{ batchError }}
            </p>
          </transition>
          <transition name="fade">
            <p v-if="batchMessage" class="rounded-lg border border-emerald-200/70 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
              {{ batchMessage }}
            </p>
          </transition>
          <div class="flex items-center justify-end">
            <button type="button" class="rounded-lg bg-[rgb(var(--accent-strong))] px-4 py-2 text-xs font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))] disabled:opacity-60" :disabled="batchProcessing" @click="submitBatchAdjust()">
              <span v-if="batchProcessing">执行中...</span>
              <span v-else>批量调整</span>
            </button>
          </div>
        </section>
        <section class="space-y-4 rounded-2xl border border-neutral-200/70 bg-white/80 p-5 dark:border-neutral-800/70 dark:bg-neutral-900/70">
          <header class="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">批量移除卡片</h2>
              <p class="text-sm text-neutral-500 dark:text-neutral-400">配合上方筛选快速清理卡池中不需要的内容。</p>
            </div>
            <span class="text-xs text-neutral-500 dark:text-neutral-400">当前匹配：{{ cardTotal }} 张</span>
          </header>
          <p class="rounded-lg border border-dashed border-neutral-200/60 bg-white/60 px-3 py-2 text-xs text-neutral-500 dark:border-neutral-800/40 dark:bg-neutral-900/40 dark:text-neutral-400">
            操作范围：{{ cardFilterSummary }}
          </p>
          <transition name="fade">
            <p v-if="batchRemoveError" class="rounded-lg border border-rose-200/70 bg-rose-50/70 px-3 py-2 text-xs text-rose-600 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200">
              {{ batchRemoveError }}
            </p>
          </transition>
          <transition name="fade">
            <p v-if="batchRemoveMessage" class="rounded-lg border border-emerald-200/70 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200">
              {{ batchRemoveMessage }}
            </p>
          </transition>
          <div class="flex items-center justify-end">
            <button type="button" class="rounded-lg border border-rose-200 px-4 py-2 text-xs font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-rose-500/40 dark:text-rose-200 dark:hover:bg-rose-500/10" :disabled="batchRemoveLoading || !cardFilters.poolId" @click="batchRemoveByFilters">
              <span v-if="batchRemoveLoading">处理中...</span>
              <span v-else>批量删除匹配卡片</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useAuth } from '@/composables/useAuth'
import { useGacha, type AdminCard, type EconomyConfig, type GachaPool, type MatchMode, type Rarity } from '~/composables/useGacha'

const { fetchCurrentUser, status: authStatusRef } = useAuth()
const authStatus = ref(authStatusRef.value)
const adminError = ref<string | null>(null)

const {
  listPools,
  createPool,
  updatePool,
  deletePool,
  listAdminCards,
  createCard,
  updateCard,
  deleteCard,
  batchAdjustCardWeights,
  getEconomyConfig,
  updateEconomyConfig,
  adjustWallet,
  adjustAllWallets
} = useGacha()

const pools = ref<GachaPool[]>([])
const poolLoading = ref(false)
const poolError = ref<string | null>(null)
const poolMessage = ref<string | null>(null)
const editingPoolId = ref<string | null>(null)
const poolForm = reactive({
  name: '',
  description: '',
  tokenCost: 10,
  tenDrawCost: 100,
  rewardPerDuplicate: 5,
  startsAt: '',
  endsAt: '',
  isActive: true,
  copyAllCards: true,
  copyFromPoolId: ''
})

const economyConfig = ref<EconomyConfig | null>(null)
const economyLoading = ref(false)
const economyError = ref<string | null>(null)
const economyMessage = ref<string | null>(null)

const rarityOrder: Rarity[] = ['GOLD', 'PURPLE', 'BLUE', 'GREEN', 'WHITE']
const rarityWeightDefaults: Record<Rarity, number> = {
  GOLD: 5,
  PURPLE: 14,
  BLUE: 32,
  GREEN: 80,
  WHITE: 150
}
const defaultDrawRewardMap: Record<Rarity, number> = {
  GOLD: 200,
  PURPLE: 100,
  BLUE: 50,
  GREEN: 10,
  WHITE: 1
}
const defaultDismantleRewardMap: Record<Rarity, number> = {
  GOLD: 100,
  PURPLE: 50,
  BLUE: 10,
  GREEN: 5,
  WHITE: 2
}

const economyForm = reactive<{ drawRewards: Record<Rarity, number>; dismantleRewards: Record<Rarity, number> }>({
  drawRewards: { ...defaultDrawRewardMap },
  dismantleRewards: { ...defaultDismantleRewardMap }
})

const rarityRewardDefaults = reactive<{ [K in Rarity]: number }>({ ...defaultDrawRewardMap })
const raritySelectOptions = rarityOrder.map((rarity) => ({ value: rarity, label: rarityLabel(rarity) }))

const cardFilters = reactive({
  poolId: '',
  rarity: 'ALL' as 'ALL' | Rarity,
  includeTags: '',
  excludeTags: '',
  search: ''
})
const cardLimitOptions = [25, 50, 100]
const cardLimit = ref(50)
const cardOffset = ref(0)
const cardTotal = ref(0)
const cardItems = ref<AdminCard[]>([])
const cardLoading = ref(false)
const cardError = ref<string | null>(null)
const cardMessage = ref<string | null>(null)
const editingCardId = ref<string | null>(null)
const cardFormError = ref<string | null>(null)
const cardSubmitting = ref(false)
const cardForm = reactive({
  poolId: '',
  title: '',
  rarity: 'WHITE' as Rarity,
  tagsInput: '',
  tags: [] as string[],
  weight: rarityWeightDefaults.WHITE,
  rewardTokens: rarityRewardDefaults.WHITE,
  wikidotId: '',
  pageId: '',
  imageUrl: ''
})

const walletAdjustForm = reactive({
  userId: '',
  email: '',
  delta: 0,
  reason: '',
  allowNegative: false
})
const walletAdjustSingleLoading = ref(false)
const walletAdjustSingleError = ref<string | null>(null)
const walletAdjustSingleMessage = ref<string | null>(null)

const walletAdjustAllForm = reactive({
  delta: 0,
  reason: '',
  allowNegative: false
})
const walletAdjustAllLoading = ref(false)
const walletAdjustAllError = ref<string | null>(null)
const walletAdjustAllMessage = ref<string | null>(null)

const batchForm = reactive({
  poolId: '',
  rarity: 'ALL' as 'ALL' | Rarity,
  includeTags: '',
  excludeTags: '',
  match: 'any' as MatchMode,
  multiplier: 1.2,
  setWeight: ''
})
const batchProcessing = ref(false)
const batchError = ref<string | null>(null)
const batchMessage = ref<string | null>(null)
const batchMultiplierPresets = [1.1, 1.25, 1.5, 2]
const batchRemoveLoading = ref(false)
const batchRemoveError = ref<string | null>(null)
const batchRemoveMessage = ref<string | null>(null)

const cardPageStart = computed(() => (cardTotal.value === 0 ? 0 : cardOffset.value + 1))
const cardPageEnd = computed(() => (cardTotal.value === 0 ? 0 : Math.min(cardOffset.value + cardItems.value.length, cardTotal.value)))
const cardHasPrev = computed(() => cardOffset.value > 0)
const cardHasNext = computed(() => cardOffset.value + cardItems.value.length < cardTotal.value)
const cardFilterSummary = computed(() => {
  const parts: string[] = []
  const poolId = cardFilters.poolId
  if (poolId) {
    const pool = pools.value.find((entry) => entry.id === poolId)
    parts.push(`卡池：${pool?.name ?? poolId}`)
  } else {
    parts.push('卡池：全部')
  }
  if (cardFilters.rarity !== 'ALL') {
    parts.push(`稀有度：${rarityLabel(cardFilters.rarity)}`)
  }
  if (cardFilters.includeTags.trim()) {
    parts.push(`包含标签：${parseTagInput(cardFilters.includeTags).join(', ')}`)
  }
  if (cardFilters.excludeTags.trim()) {
    parts.push(`排除标签：${parseTagInput(cardFilters.excludeTags).join(', ')}`)
  }
  if (cardFilters.search.trim()) {
    parts.push(`搜索：${cardFilters.search.trim()}`)
  }
  const hasExtraFilter =
    Boolean(poolId) ||
    cardFilters.rarity !== 'ALL' ||
    Boolean(cardFilters.includeTags.trim()) ||
    Boolean(cardFilters.excludeTags.trim()) ||
    Boolean(cardFilters.search.trim())
  if (!hasExtraFilter) {
    return '未设置筛选（默认全部卡池）'
  }
  return parts.join(' ｜ ')
})

function rarityLabel(rarity: string) {
  const map: Record<string, string> = {
    GOLD: '金色',
    PURPLE: '紫色',
    BLUE: '蓝色',
    GREEN: '绿色',
    WHITE: '白色'
  }
  return map[rarity] || rarity
}

function normaliseTag(tag: string) {
  return tag.trim().toLowerCase().replace(/\s+/g, '-')
}

function parseTagInput(value: string) {
  return value
    .split(',')
    .map((tag) => normaliseTag(tag))
    .filter((tag) => tag.length > 0)
}

function applyEconomyConfig(config: EconomyConfig) {
  rarityOrder.forEach((rarity) => {
    economyForm.drawRewards[rarity] = config.drawRewards[rarity]
    economyForm.dismantleRewards[rarity] = config.dismantleRewards[rarity]
    rarityRewardDefaults[rarity] = config.drawRewards[rarity]
  })
  if (!editingCardId.value) {
    cardForm.rewardTokens = rarityRewardDefaults[cardForm.rarity]
  }
}

function resetEconomyForm() {
  if (economyConfig.value) {
    applyEconomyConfig(economyConfig.value)
  } else {
    rarityOrder.forEach((rarity) => {
      economyForm.drawRewards[rarity] = defaultDrawRewardMap[rarity]
      economyForm.dismantleRewards[rarity] = defaultDismantleRewardMap[rarity]
      rarityRewardDefaults[rarity] = defaultDrawRewardMap[rarity]
    })
  }
  economyError.value = null
  if (!editingCardId.value) {
    cardForm.rewardTokens = rarityRewardDefaults[cardForm.rarity]
  }
}

async function loadEconomy(force = false) {
  if (economyLoading.value) return
  economyLoading.value = true
  economyError.value = null
  try {
    const res = await getEconomyConfig(force)
    if (!res.ok) {
      economyError.value = res.error || '加载经济配置失败'
      if (!economyConfig.value) {
        resetEconomyForm()
      }
      return
    }
    if (res.data) {
      economyConfig.value = res.data
      applyEconomyConfig(res.data)
    }
  } finally {
    economyLoading.value = false
  }
}

async function submitEconomy() {
  if (economyLoading.value) return
  economyLoading.value = true
  economyError.value = null
  economyMessage.value = null
  try {
    const payload = {
      drawRewards: { ...economyForm.drawRewards },
      dismantleRewards: { ...economyForm.dismantleRewards }
    }
    const res = await updateEconomyConfig(payload)
    if (!res.ok) {
      economyError.value = res.error || '更新经济配置失败'
      return
    }
    if (res.data) {
      economyConfig.value = res.data
      applyEconomyConfig(res.data)
      showEconomyMessage('已更新抽卡返还配置')
    }
  } finally {
    economyLoading.value = false
  }
}

function showEconomyMessage(message: string) {
  economyMessage.value = message
  window.setTimeout(() => {
    if (economyMessage.value === message) economyMessage.value = null
  }, 4000)
}

function resetWalletAdjustForm() {
  walletAdjustForm.userId = ''
  walletAdjustForm.email = ''
  walletAdjustForm.delta = 0
  walletAdjustForm.reason = ''
  walletAdjustForm.allowNegative = false
  walletAdjustSingleError.value = null
  walletAdjustSingleMessage.value = null
}

function resetWalletAdjustAllForm() {
  walletAdjustAllForm.delta = 0
  walletAdjustAllForm.reason = ''
  walletAdjustAllForm.allowNegative = false
  walletAdjustAllError.value = null
  walletAdjustAllMessage.value = null
}

async function submitWalletAdjust() {
  if (walletAdjustSingleLoading.value) return
  const userId = walletAdjustForm.userId.trim()
  const email = walletAdjustForm.email.trim()
  if (!userId && !email) {
    walletAdjustSingleError.value = '请填写 userId 或邮箱'
    return
  }
  if (walletAdjustForm.delta === 0) {
    walletAdjustSingleError.value = '调整数额不能为 0'
    return
  }
  walletAdjustSingleLoading.value = true
  walletAdjustSingleError.value = null
  walletAdjustSingleMessage.value = null
  try {
    const res = await adjustWallet({
      userId: userId || undefined,
      email: email || undefined,
      delta: walletAdjustForm.delta,
      reason: walletAdjustForm.reason.trim() || undefined,
      allowNegative: walletAdjustForm.allowNegative
    })
    if (!res.ok) {
      walletAdjustSingleError.value = res.error || '调整失败'
      return
    }
    showWalletAdjustSingleMessage('已成功调整目标钱包')
  } finally {
    walletAdjustSingleLoading.value = false
  }
}

async function submitWalletAdjustAll() {
  if (walletAdjustAllLoading.value) return
  if (walletAdjustAllForm.delta === 0) {
    walletAdjustAllError.value = '调整数额不能为 0'
    return
  }
  walletAdjustAllLoading.value = true
  walletAdjustAllError.value = null
  walletAdjustAllMessage.value = null
  try {
    const res = await adjustAllWallets({
      delta: walletAdjustAllForm.delta,
      reason: walletAdjustAllForm.reason.trim() || undefined,
      allowNegative: walletAdjustAllForm.allowNegative
    })
    if (!res.ok) {
      walletAdjustAllError.value = res.error || '调整失败'
      return
    }
    const affected = res.updated ?? 0
    showWalletAdjustAllMessage(`已批量调整 ${affected} 个钱包`)
  } finally {
    walletAdjustAllLoading.value = false
  }
}

function showWalletAdjustSingleMessage(message: string) {
  walletAdjustSingleMessage.value = message
  window.setTimeout(() => {
    if (walletAdjustSingleMessage.value === message) walletAdjustSingleMessage.value = null
  }, 4000)
}

function showWalletAdjustAllMessage(message: string) {
  walletAdjustAllMessage.value = message
  window.setTimeout(() => {
    if (walletAdjustAllMessage.value === message) walletAdjustAllMessage.value = null
  }, 4000)
}

function showPoolMessage(message: string) {
  poolMessage.value = message
  window.setTimeout(() => {
    if (poolMessage.value === message) poolMessage.value = null
  }, 4000)
}

function showCardMessage(message: string) {
  cardMessage.value = message
  window.setTimeout(() => {
    if (cardMessage.value === message) cardMessage.value = null
  }, 4000)
}

function showBatchMessage(message: string) {
  batchMessage.value = message
  window.setTimeout(() => {
    if (batchMessage.value === message) batchMessage.value = null
  }, 4000)
}

function resetPoolForm() {
  poolForm.name = ''
  poolForm.description = ''
  poolForm.tokenCost = 10
  poolForm.tenDrawCost = 100
  poolForm.rewardPerDuplicate = 5
  poolForm.startsAt = ''
  poolForm.endsAt = ''
  poolForm.isActive = true
  poolForm.copyAllCards = true
  poolForm.copyFromPoolId = ''
  poolError.value = null
  editingPoolId.value = null
}

function startCreatePool() {
  resetPoolForm()
}

function startEditPool(pool: GachaPool) {
  editingPoolId.value = pool.id
  poolForm.name = pool.name
  poolForm.description = pool.description ?? ''
  poolForm.tokenCost = pool.tokenCost
  poolForm.tenDrawCost = pool.tenDrawCost
  poolForm.rewardPerDuplicate = pool.rewardPerDuplicate
  poolForm.startsAt = pool.startsAt ?? ''
  poolForm.endsAt = pool.endsAt ?? ''
  poolForm.isActive = pool.isActive
  poolForm.copyAllCards = false
  poolForm.copyFromPoolId = ''
  poolError.value = null
}

async function loadPools(force = false) {
  poolLoading.value = true
  poolError.value = null
  try {
    const res = await listPools(force)
    if (!res.ok) {
      if (res.error?.includes('无权限')) {
        adminError.value = res.error
      } else {
        poolError.value = res.error || '加载卡池失败'
      }
      pools.value = []
      return
    }
    pools.value = res.data ?? []
    if (pools.value.length > 0) {
      const preferred = cardFilters.poolId && pools.value.some((pool) => pool.id === cardFilters.poolId)
        ? cardFilters.poolId
        : pools.value.find((pool) => pool.isActive)?.id ?? pools.value[0].id
      cardFilters.poolId = preferred
      if (!cardForm.poolId) {
        cardForm.poolId = preferred
      }
      if (!batchForm.poolId) {
        batchForm.poolId = preferred
      }
    } else {
      cardFilters.poolId = ''
      cardForm.poolId = ''
      batchForm.poolId = ''
    }
  } catch (error: any) {
    poolError.value = error?.message || '加载卡池失败'
    pools.value = []
  } finally {
    poolLoading.value = false
  }
}

async function submitPool() {
  if (poolLoading.value) return
  poolError.value = null
  if (!poolForm.name.trim()) {
    poolError.value = '名称不能为空'
    return
  }
  poolLoading.value = true
  try {
    const payload: {
      name: string
      description?: string
      tokenCost: number
      tenDrawCost: number
      rewardPerDuplicate: number
      startsAt?: string
      endsAt?: string
      isActive: boolean
      cloneAllCards?: boolean
      cloneFromPoolId?: string
    } = {
      name: poolForm.name,
      description: poolForm.description || undefined,
      tokenCost: poolForm.tokenCost,
      tenDrawCost: poolForm.tenDrawCost,
      rewardPerDuplicate: poolForm.rewardPerDuplicate,
      startsAt: poolForm.startsAt || undefined,
      endsAt: poolForm.endsAt || undefined,
      isActive: poolForm.isActive
    }
    if (!editingPoolId.value) {
      payload.cloneAllCards = poolForm.copyAllCards
      if (!poolForm.copyAllCards && poolForm.copyFromPoolId) {
        payload.cloneFromPoolId = poolForm.copyFromPoolId
      }
    }
    const isEditing = !!editingPoolId.value
    const res = editingPoolId.value
      ? await updatePool(editingPoolId.value, payload)
      : await createPool(payload)
    if (!res.ok) {
      poolError.value = res.error || '保存失败'
      return
    }
    if (isEditing) {
      showPoolMessage('卡池已更新')
    } else {
      const copied = res.copied ?? 0
      showPoolMessage(copied > 0 ? `卡池已创建，复制 ${copied} 张卡片` : '卡池已创建（未找到可复制卡片）')
    }
    resetPoolForm()
    await loadPools(true)
  } catch (error: any) {
    poolError.value = error?.message || '保存失败'
  } finally {
    poolLoading.value = false
  }
}

async function removePool(pool: GachaPool) {
  if (!confirm(`确认删除卡池「${pool.name}」及其卡片吗？`)) return
  try {
    const res = await deletePool(pool.id)
    if (!res.ok) {
      poolError.value = res.error || '删除失败'
      return
    }
    showPoolMessage('卡池已删除')
    await loadPools(true)
  } catch (error: any) {
    poolError.value = error?.message || '删除失败'
  }
}

function selectPoolForCards(poolId: string) {
  cardFilters.poolId = poolId
  cardForm.poolId = poolId
  batchForm.poolId = poolId
}

function resetCardForm(poolId?: string) {
  const targetPoolId = poolId || cardFilters.poolId || pools.value[0]?.id || ''
  cardForm.poolId = targetPoolId
  cardForm.title = ''
  cardForm.rarity = 'WHITE'
  cardForm.tagsInput = ''
  cardForm.tags = []
  cardForm.weight = rarityWeightDefaults.WHITE
  cardForm.rewardTokens = rarityRewardDefaults.WHITE
  cardForm.wikidotId = ''
  cardForm.pageId = ''
  cardForm.imageUrl = ''
  cardFormError.value = null
  editingCardId.value = null
}

function startCreateCard(poolId?: string) {
  if (poolId) {
    selectPoolForCards(poolId)
  }
  resetCardForm(poolId)
}

function startEditCard(card: AdminCard) {
  editingCardId.value = card.id
  selectPoolForCards(card.poolId)
  cardForm.title = card.title
  cardForm.rarity = card.rarity
  cardForm.tags = [...(card.tags ?? [])]
  cardForm.tagsInput = ''
  cardForm.weight = card.weight ?? rarityWeightDefaults[card.rarity]
  cardForm.rewardTokens = card.rewardTokens ?? rarityRewardDefaults[card.rarity]
  cardForm.wikidotId = card.wikidotId != null ? String(card.wikidotId) : ''
  cardForm.pageId = card.pageId != null ? String(card.pageId) : ''
  cardForm.imageUrl = card.imageUrl ?? ''
  cardFormError.value = null
}

function addCardTag() {
  if (!cardForm.tagsInput) return
  const tag = normaliseTag(cardForm.tagsInput)
  cardForm.tagsInput = ''
  if (!tag) return
  if (!cardForm.tags.includes(tag)) {
    cardForm.tags.push(tag)
  }
}

function removeCardTag(tag: string) {
  cardForm.tags = cardForm.tags.filter((item) => item !== tag)
}

async function submitCard() {
  if (cardSubmitting.value) return
  cardFormError.value = null
  if (!cardForm.poolId) {
    cardFormError.value = '请选择卡池'
    return
  }
  if (!cardForm.title.trim()) {
    cardFormError.value = '标题不能为空'
    return
  }
  cardSubmitting.value = true
  try {
    const payload = {
      poolId: cardForm.poolId,
      title: cardForm.title,
      rarity: cardForm.rarity,
      tags: cardForm.tags,
      weight: cardForm.weight,
      rewardTokens: cardForm.rewardTokens,
      wikidotId: cardForm.wikidotId ? Number(cardForm.wikidotId) : undefined,
      pageId: cardForm.pageId ? Number(cardForm.pageId) : undefined,
      imageUrl: cardForm.imageUrl || undefined
    }
    const res = editingCardId.value
      ? await updateCard(editingCardId.value, payload)
      : await createCard(payload)
    if (!res.ok) {
      cardFormError.value = res.error || '保存失败'
      return
    }
    showCardMessage(editingCardId.value ? '卡片已更新' : '卡片已创建')
    editingCardId.value = null
    resetCardForm(payload.poolId)
    await loadCards(true)
  } catch (error: any) {
    cardFormError.value = error?.message || '保存失败'
  } finally {
    cardSubmitting.value = false
  }
}

async function removeCard(card: AdminCard) {
  if (!confirm(`确认删除卡片「${card.title}」吗？`)) return
  try {
    const res = await deleteCard(card.id)
    if (!res.ok) {
      cardError.value = res.error || '删除失败'
      return
    }
    showCardMessage('卡片已删除')
    await loadCards(true)
  } catch (error: any) {
    cardError.value = error?.message || '删除失败'
  }
}

async function loadCards(reset = false) {
  if (reset) {
    cardOffset.value = 0
  }
  if (!cardFilters.poolId) {
    cardItems.value = []
    cardTotal.value = 0
    return
  }
  cardLoading.value = true
  cardError.value = null
  try {
    const includeTags = parseTagInput(cardFilters.includeTags)
    const excludeTags = parseTagInput(cardFilters.excludeTags)
    const res = await listAdminCards({
      poolId: cardFilters.poolId,
      rarity: cardFilters.rarity === 'ALL' ? undefined : cardFilters.rarity,
      includeTags: includeTags.length ? includeTags : undefined,
      excludeTags: excludeTags.length ? excludeTags : undefined,
      search: cardFilters.search || undefined,
      limit: cardLimit.value,
      offset: cardOffset.value
    })
    if (!res.ok) {
      cardError.value = res.error || '加载卡片失败'
      cardItems.value = []
      cardTotal.value = 0
      return
    }
    cardItems.value = res.data ?? []
    cardTotal.value = res.total ?? 0
  } catch (error: any) {
    cardError.value = error?.message || '加载卡片失败'
    cardItems.value = []
    cardTotal.value = 0
  } finally {
    cardLoading.value = false
  }
}

function applyCardFilters() {
  void loadCards(true)
}

function clearCardFilters() {
  cardFilters.poolId = ''
  cardFilters.rarity = 'ALL'
  cardFilters.includeTags = ''
  cardFilters.excludeTags = ''
  cardFilters.search = ''
  cardItems.value = []
  cardTotal.value = 0
}

function goPrevCardPage() {
  if (!cardHasPrev.value) return
  cardOffset.value = Math.max(0, cardOffset.value - cardLimit.value)
  void loadCards(false)
}

function goNextCardPage() {
  if (!cardHasNext.value) return
  cardOffset.value = cardOffset.value + cardLimit.value
  void loadCards(false)
}

function resetBatchForm() {
  batchForm.poolId = cardFilters.poolId
  batchForm.rarity = 'ALL'
  batchForm.includeTags = ''
  batchForm.excludeTags = ''
  batchForm.match = 'any'
  batchForm.multiplier = 1.2
  batchForm.setWeight = ''
  batchError.value = null
}

function applyFiltersToBatch() {
  batchForm.poolId = cardFilters.poolId
  batchForm.rarity = cardFilters.rarity
  batchForm.includeTags = cardFilters.includeTags
  batchForm.excludeTags = cardFilters.excludeTags
  batchForm.match = 'any'
  batchError.value = null
}

function setBatchMultiplier(preset: number) {
  if (!Number.isFinite(preset)) return
  batchForm.multiplier = Number(preset.toFixed(2))
}

async function submitBatchAdjust() {
  if (batchProcessing.value) return
  batchError.value = null
  const includeTags = parseTagInput(batchForm.includeTags)
  const excludeTags = parseTagInput(batchForm.excludeTags)
  const multiplier = Number.isFinite(batchForm.multiplier) && batchForm.multiplier > 0 ? batchForm.multiplier : undefined
  const setWeightValue = batchForm.setWeight !== '' ? Number(batchForm.setWeight) : undefined
  const setWeight = setWeightValue != null && Number.isFinite(setWeightValue) && setWeightValue > 0 ? setWeightValue : undefined
  if (!multiplier && !setWeight) {
    batchError.value = '请设置倍率或目标权重'
    return
  }
  batchProcessing.value = true
  try {
    const res = await batchAdjustCardWeights({
      poolId: batchForm.poolId || undefined,
      includeTags: includeTags.length ? includeTags : undefined,
      excludeTags: excludeTags.length ? excludeTags : undefined,
      match: batchForm.match,
      rarity: batchForm.rarity === 'ALL' ? undefined : batchForm.rarity,
      multiplier,
      setWeight
    })
    if (!res.ok) {
      batchError.value = res.error || '批量调整失败'
      return
    }
    showBatchMessage(`已匹配 ${res.matched ?? 0} 张卡片，更新 ${res.updated ?? 0} 张`)
    await loadCards(true)
  } catch (error: any) {
    batchError.value = error?.message || '批量调整失败'
  } finally {
    batchProcessing.value = false
  }
}

function showBatchRemoveMessage(message: string) {
  batchRemoveMessage.value = message
  window.setTimeout(() => {
    if (batchRemoveMessage.value === message) batchRemoveMessage.value = null
  }, 4000)
}

async function fetchCardsForCurrentFilters() {
  const includeTags = parseTagInput(cardFilters.includeTags)
  const excludeTags = parseTagInput(cardFilters.excludeTags)
  const rarity = cardFilters.rarity === 'ALL' ? undefined : cardFilters.rarity
  const search = cardFilters.search.trim()
  const poolId = cardFilters.poolId || undefined
  const items: AdminCard[] = []
  const pageSize = 200
  let offset = 0
  while (true) {
    const res = await listAdminCards({
      poolId,
      rarity,
      includeTags: includeTags.length ? includeTags : undefined,
      excludeTags: excludeTags.length ? excludeTags : undefined,
      search: search || undefined,
      limit: pageSize,
      offset
    })
    if (!res.ok) {
      throw new Error(res.error || '加载卡片失败')
    }
    const pageItems = res.data ?? []
    items.push(...pageItems)
    const total = res.total ?? items.length
    if (items.length >= total || pageItems.length < pageSize) {
      break
    }
    offset += pageSize
  }
  return { items }
}

async function batchRemoveByFilters() {
  if (batchRemoveLoading.value) return
  batchRemoveError.value = null
  if (!cardFilters.poolId) {
    batchRemoveError.value = '请先选择卡池作为删除范围'
    return
  }
  if (cardTotal.value === 0) {
    batchRemoveError.value = '当前筛选没有匹配的卡片'
    return
  }
  if (!confirm(`确认删除筛选范围内的 ${cardTotal.value} 张卡片？\n${cardFilterSummary.value}`)) {
    return
  }
  batchRemoveLoading.value = true
  try {
    const { items } = await fetchCardsForCurrentFilters()
    if (!items.length) {
      showBatchRemoveMessage('筛选范围内没有可删除的卡片')
      return
    }
    let deleted = 0
    const failed: Array<{ title: string; error: string }> = []
    for (const card of items) {
      // eslint-disable-next-line no-await-in-loop
      const res = await deleteCard(card.id)
      if (!res.ok) {
        failed.push({ title: card.title, error: res.error || '删除失败' })
      } else {
        deleted += 1
      }
    }
    if (failed.length > 0) {
      const failedNames = failed.slice(0, 3).map((item) => item.title).join('、')
      batchRemoveError.value = failed.length > 3 ? `有 ${failed.length} 张卡片删除失败，如：${failedNames}` : `以下卡片删除失败：${failedNames}`
    }
    if (deleted > 0) {
      showBatchRemoveMessage(`已删除 ${deleted} 张卡片`)
    }
    await loadCards(true)
  } catch (error: any) {
    batchRemoveError.value = error?.message || '批量删除失败'
  } finally {
    batchRemoveLoading.value = false
  }
}

watch(() => cardForm.rarity, (next) => {
  if (editingCardId.value) return
  cardForm.weight = rarityWeightDefaults[next]
  cardForm.rewardTokens = rarityRewardDefaults[next]
})

watch(() => poolForm.copyAllCards, (next) => {
  if (next) {
    poolForm.copyFromPoolId = ''
  }
})

watch(() => cardFilters.poolId, (next, prev) => {
  if (next === prev) return
  batchRemoveError.value = null
  batchRemoveMessage.value = null
  if (!next) {
    cardForm.poolId = ''
    batchForm.poolId = ''
    cardItems.value = []
    cardTotal.value = 0
    return
  }
  cardForm.poolId = next
  batchForm.poolId = next
  void loadCards(true)
})

watch(() => cardLimit.value, () => {
  if (!cardFilters.poolId) return
  void loadCards(true)
})

watch(() => cardFilters.rarity, () => {
  if (!cardFilters.poolId) return
  void loadCards(true)
})

onMounted(async () => {
  try {
    await fetchCurrentUser()
  } catch (error) {
    // ignore
  }
  authStatus.value = authStatusRef.value
  if (authStatus.value !== 'authenticated') return
  await loadEconomy()
  await loadPools()
  if (cardFilters.poolId) {
    await loadCards(true)
  }
  resetBatchForm()
})
</script>
