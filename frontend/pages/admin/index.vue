<template>
  <div class="space-y-6">
    <h1 class="text-2xl font-bold">管理中心</h1>

    <div v-if="authStatus === 'unauthenticated'" class="rounded-xl border border-neutral-200/70 bg-white/80 p-6 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/80 dark:text-neutral-300">
      <p>请先登录账户以访问管理页面。</p>
      <NuxtLink to="/auth/login" class="mt-2 inline-block text-[rgb(var(--accent-strong))] hover:underline">前往登录</NuxtLink>
    </div>

    <div v-else>
      <div v-if="errorCode === 403" class="rounded-xl border border-amber-300/50 bg-amber-50/70 p-4 text-amber-800 dark:border-amber-400/30 dark:bg-amber-950/30 dark:text-amber-200">
        无访问权限。请联系管理员添加权限。
      </div>

      <div v-else class="space-y-5">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div class="rounded-xl border border-neutral-200/80 bg-white/80 p-4 dark:border-neutral-800/70 dark:bg-neutral-900/70">
            <div class="text-sm text-neutral-500 dark:text-neutral-400">注册用户</div>
            <div class="mt-1 text-2xl font-semibold">{{ overview.totalUsers }}</div>
          </div>
          <div class="rounded-xl border border-neutral-200/80 bg-white/80 p-4 dark:border-neutral-800/70 dark:bg-neutral-900/70">
            <div class="text-sm text-neutral-500 dark:text-neutral-400">已绑定 Wikidot</div>
            <div class="mt-1 text-2xl font-semibold">{{ overview.boundUsers }}</div>
          </div>
          <div class="rounded-xl border border-neutral-200/80 bg-white/80 p-4 dark:border-neutral-800/70 dark:bg-neutral-900/70">
            <div class="text-sm text-neutral-500 dark:text-neutral-400">当前结果</div>
            <div class="mt-1 text-2xl font-semibold">{{ total }}</div>
          </div>
        </div>

        <div class="flex flex-col gap-3 rounded-xl border border-neutral-200/80 bg-white/80 p-4 dark:border-neutral-800/70 dark:bg-neutral-900/70">
          <div class="flex flex-col items-stretch gap-2 sm:flex-row">
            <input
              v-model="q"
              type="text"
              placeholder="搜索邮箱 / 昵称 / wikidotId"
              class="flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800"
              @keyup.enter="refresh()"
            />
            <div class="flex items-center gap-2">
              <button
                class="rounded-lg bg-[rgb(var(--accent-strong))] px-4 py-2 text-sm font-semibold text-white shadow hover:bg-[rgb(var(--accent))]"
                @click="refresh()"
              >搜索</button>
              <button
                class="rounded-lg border border-neutral-200 px-4 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                @click="clearSearch()"
              >重置</button>
            </div>
          </div>

          <div class="overflow-hidden rounded-xl border border-neutral-200/70 dark:border-neutral-800/70">
            <table class="min-w-full divide-y divide-neutral-200 dark:divide-neutral-800">
              <thead class="bg-neutral-50/60 dark:bg-neutral-800/60">
                <tr>
                  <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">邮箱</th>
                  <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">昵称</th>
                  <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">绑定 Wikidot</th>
                  <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">最近登录</th>
                  <th class="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">操作</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-200 bg-white/70 dark:divide-neutral-800 dark:bg-neutral-900/40">
                <tr v-for="acc in accounts" :key="acc.id" class="hover:bg-neutral-50/70 dark:hover:bg-neutral-900/50">
                  <td class="px-4 py-3 text-sm">{{ acc.email }}</td>
                  <td class="px-4 py-3 text-sm">{{ acc.displayName || '-' }}</td>
                  <td class="px-4 py-3 text-sm">
                    <template v-if="acc.linkedWikidotId">
                      <NuxtLink :to="`/user/${acc.linkedWikidotId}`" class="text-[rgb(var(--accent-strong))] hover:underline">#{{ acc.linkedWikidotId }}</NuxtLink>
                    </template>
                    <template v-else>
                      <span class="text-neutral-400">未绑定</span>
                    </template>
                  </td>
                  <td class="px-4 py-3 text-sm">{{ formatDateTime(acc.lastLoginAt) }}</td>
                  <td class="px-4 py-3 text-right text-sm">
                    <div class="inline-flex items-center gap-2">
                      <button
                        class="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
                        @click="openLinkModal(acc)"
                      >绑定</button>
                      <button
                        class="rounded-lg border border-rose-200 px-3 py-1.5 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50 dark:border-rose-800/50 dark:text-rose-300 dark:hover:bg-rose-900/40"
                        :disabled="!acc.linkedWikidotId"
                        @click="confirmUnlink(acc)"
                      >解绑</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div class="flex items-center justify-between text-sm text-neutral-600 dark:text-neutral-300">
            <div>共 {{ total }} 条</div>
            <div class="flex items-center gap-2">
              <button class="rounded border border-neutral-200 px-3 py-1.5 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800" :disabled="offset <= 0 || loading" @click="prevPage">上一页</button>
              <button class="rounded border border-neutral-200 px-3 py-1.5 hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800" :disabled="offset + limit >= total || loading" @click="nextPage">下一页</button>
            </div>
          </div>
        </div>

        <transition name="fade">
          <div v-if="isLinkOpen" class="fixed inset-0 z-50">
            <div class="absolute inset-0 bg-black/50" @click="closeLinkModal" />
            <div class="absolute inset-0 flex items-center justify-center p-4">
              <div class="w-full max-w-xl rounded-2xl border border-neutral-200/80 bg-white p-5 shadow-xl dark:border-neutral-800/70 dark:bg-neutral-900">
                <div class="flex items-start justify-between">
                  <h3 class="text-lg font-semibold">绑定 Wikidot 账户</h3>
                  <button class="p-2 text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-200" @click="closeLinkModal">
                    <LucideIcon name="X" class="h-5 w-5" />
                  </button>
                </div>
                <div class="mt-1 text-sm text-neutral-600 dark:text-neutral-300">目标账号：{{ targetAccount?.email }}</div>

                <div class="mt-4 space-y-3">
                  <div class="flex items-center gap-2">
                    <input v-model="wikidotInput" type="text" placeholder="输入 Wikidot ID 或 用户名" class="flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800" @keyup.enter="onSearchWikidot" />
                    <button class="rounded-lg bg-neutral-900 px-3 py-2 text-sm font-semibold text-white hover:bg-neutral-800 dark:bg-neutral-200 dark:text-neutral-900 dark:hover:bg-white" @click="onSearchWikidot">搜索</button>
                  </div>
                  <div v-if="wikidotError" class="rounded-lg border border-rose-300/50 bg-rose-50/70 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-200">
                    {{ wikidotError }}
                  </div>
                  <div v-if="wikidotCandidate" class="rounded-lg border border-emerald-300/50 bg-emerald-50/70 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-200">
                    将绑定：{{ wikidotCandidate.displayName || '用户' }}（#{{ wikidotCandidate.wikidotId }}）
                  </div>
                  <div v-if="wikidotResults.length > 0" class="max-h-60 overflow-auto rounded-lg border border-neutral-200/80 dark:border-neutral-700/70">
                    <ul>
                      <li v-for="u in wikidotResults" :key="u.wikidotId" class="flex items-center justify-between gap-2 border-b border-neutral-200/70 px-3 py-2 last:border-none dark:border-neutral-800/60">
                        <div class="truncate"><span class="font-medium">{{ u.displayName }}</span> <span class="text-neutral-500">#{{ u.wikidotId }}</span></div>
                        <button class="rounded border border-[rgba(var(--accent),0.5)] px-2 py-1 text-xs font-semibold text-[rgb(var(--accent-strong))] hover:bg-[rgba(var(--accent),0.08)]" @click="selectWikidot(u)">选择</button>
                      </li>
                    </ul>
                  </div>

                  <div class="flex items-center gap-4 text-sm">
                    <label class="inline-flex items-center gap-2"><input type="checkbox" v-model="force" class="rounded border-neutral-300 text-[rgb(var(--accent-strong))] focus:ring-[rgb(var(--accent))]" /> 强制覆盖</label>
                    <label class="inline-flex items-center gap-2"><input type="checkbox" v-model="takeover" class="rounded border-neutral-300 text-[rgb(var(--accent-strong))] focus:ring-[rgb(var(--accent))]" /> 接管转移</label>
                  </div>
                </div>

                <div class="mt-5 flex items-center justify-end gap-2">
                  <button class="rounded-lg border border-neutral-200 px-4 py-2 text-sm dark:border-neutral-700" @click="closeLinkModal">取消</button>
                  <button :disabled="!wikidotCandidate || saving" class="rounded-lg bg-[rgb(var(--accent-strong))] px-4 py-2 text-sm font-semibold text-white hover:bg-[rgb(var(--accent))] disabled:opacity-50" @click="submitLink">确认绑定</button>
                </div>
              </div>
            </div>
          </div>
        </transition>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useNuxtApp } from 'nuxt/app'
import { useAuth } from '@/composables/useAuth'

type AccountItem = {
  id: string
  email: string
  displayName: string | null
  status: string
  linkedWikidotId: number | null
  createdAt: string
  lastLoginAt: string | null
}

type WikidotUser = { wikidotId: number; displayName: string }

const { $bff } = useNuxtApp()
const { status: authStatusRef, fetchCurrentUser } = useAuth()
const authStatus = ref<'unknown'|'authenticated'|'unauthenticated'>(authStatusRef.value)

const q = ref('')
const limit = ref(20)
const offset = ref(0)
const total = ref(0)
const accounts = ref<AccountItem[]>([])
const overview = ref<{ totalUsers: number; boundUsers: number }>({ totalUsers: 0, boundUsers: 0 })
const loading = ref(false)
const errorCode = ref<number | null>(null)

async function fetchAccounts() {
  loading.value = true
  errorCode.value = null
  try {
    const res = await $bff<{ items: AccountItem[]; total: number; overview: { totalUsers: number; boundUsers: number } }>(
      '/admin/accounts',
      { method: 'GET', params: { query: q.value || undefined, limit: String(limit.value), offset: String(offset.value) } }
    )
    accounts.value = (res as any).items || []
    total.value = Number((res as any).total || 0)
    overview.value = (res as any).overview || { totalUsers: 0, boundUsers: 0 }
  } catch (err: any) {
    errorCode.value = err?.status || null
    accounts.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

function refresh() {
  offset.value = 0
  void fetchAccounts()
}
function clearSearch() {
  q.value = ''
  refresh()
}
function prevPage() {
  offset.value = Math.max(0, offset.value - limit.value)
  void fetchAccounts()
}
function nextPage() {
  if (offset.value + limit.value >= total.value) return
  offset.value = offset.value + limit.value
  void fetchAccounts()
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(d)
}

// Link modal
const isLinkOpen = ref(false)
const targetAccount = ref<AccountItem | null>(null)
const wikidotInput = ref('')
const wikidotCandidate = ref<WikidotUser | null>(null)
const wikidotResults = ref<WikidotUser[]>([])
const wikidotError = ref<string | null>(null)
const force = ref(false)
const takeover = ref(false)
const saving = ref(false)

function openLinkModal(acc: AccountItem) {
  targetAccount.value = acc
  wikidotInput.value = ''
  wikidotCandidate.value = null
  wikidotResults.value = []
  wikidotError.value = null
  force.value = false
  takeover.value = false
  isLinkOpen.value = true
}
function closeLinkModal() {
  isLinkOpen.value = false
}

function selectWikidot(u: WikidotUser) {
  wikidotCandidate.value = u
  wikidotResults.value = []
}

async function onSearchWikidot() {
  wikidotError.value = null
  wikidotCandidate.value = null
  wikidotResults.value = []
  const qv = (wikidotInput.value || '').trim()
  if (!qv) return
  const asNum = Number(qv)
  try {
    if (Number.isInteger(asNum) && asNum > 0) {
      const data = await $bff<any>('/users/by-wikidot-id', { method: 'GET', params: { wikidotId: String(asNum) } })
      wikidotCandidate.value = { wikidotId: Number(data.wikidotId), displayName: data.displayName || String(data.wikidotId) }
      return
    }
    const res = await $bff<{ results: Array<{ wikidotId: number; displayName: string }> }>('/search/users', { method: 'GET', params: { query: qv, limit: '20' } })
    const items = (res as any).results || []
    if (items.length === 1) {
      wikidotCandidate.value = { wikidotId: Number(items[0].wikidotId), displayName: items[0].displayName }
    } else {
      wikidotResults.value = items.map((i: any) => ({ wikidotId: Number(i.wikidotId), displayName: i.displayName }))
      if (items.length === 0) wikidotError.value = '未找到匹配的 Wikidot 用户'
    }
  } catch (err: any) {
    wikidotError.value = err?.data?.error || err?.message || '查询失败'
  }
}

async function submitLink() {
  if (!targetAccount.value || !wikidotCandidate.value) return
  saving.value = true
  try {
    await $bff('/admin/accounts/' + encodeURIComponent(targetAccount.value.id) + '/link', {
      method: 'POST',
      body: {
        wikidotId: wikidotCandidate.value.wikidotId,
        force: !!force.value,
        takeover: !!takeover.value
      }
    })
    isLinkOpen.value = false
    await fetchAccounts()
  } catch (err: any) {
    wikidotError.value = err?.data?.error || err?.message || '绑定失败'
  } finally {
    saving.value = false
  }
}

async function confirmUnlink(acc: AccountItem) {
  if (!acc.linkedWikidotId) return
  if (!confirm(`确定要解绑 ${acc.email} 的 Wikidot 账户（#${acc.linkedWikidotId}）吗？`)) return
  try {
    await $bff('/admin/accounts/' + encodeURIComponent(acc.id) + '/unlink', { method: 'POST' })
    await fetchAccounts()
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('unlink failed', err)
  }
}

onMounted(async () => {
  try {
    await fetchCurrentUser()
  } finally {
    authStatus.value = authStatusRef.value
    if (authStatus.value === 'authenticated') {
      await fetchAccounts()
    }
  }
})
</script>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity .15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
