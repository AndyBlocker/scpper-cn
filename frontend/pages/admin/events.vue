<template>
  <div class="mx-auto max-w-6xl space-y-8 py-10">
    <h1 class="text-2xl font-bold text-neutral-900 dark:text-neutral-100">活动月历管理</h1>

    <div v-if="authStatus === 'unknown'" class="rounded-xl border border-dashed border-neutral-200/70 bg-white/70 p-6 text-sm text-neutral-600 dark:border-neutral-800/70 dark:bg-neutral-900/60 dark:text-neutral-300">
      正在校验登录状态...
    </div>

    <div v-else-if="authStatus === 'unauthenticated'" class="rounded-xl border border-neutral-200/70 bg-white/80 p-6 text-sm text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900/80 dark:text-neutral-300">
      <p>请先登录账户以访问管理页面。</p>
      <NuxtLink to="/auth/login" class="mt-2 inline-block text-[rgb(var(--accent-strong))] hover:underline">前往登录</NuxtLink>
    </div>

    <div v-else>
      <div v-if="adminError" class="rounded-xl border border-rose-200/70 bg-rose-50/70 p-6 text-sm text-rose-600 dark:border-rose-500/40 dark:bg-rose-500/10 dark:text-rose-200">
        {{ adminError }}
      </div>

      <div v-else class="space-y-8">
        <!-- Create -->
        <section class="space-y-4 rounded-2xl border border-neutral-200/70 bg-white/80 p-5 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
          <header class="space-y-1">
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">新增活动</h2>
            <p class="text-sm text-neutral-500 dark:text-neutral-400">填写活动信息后保存，即可在工具中心的“活动月历”展示。</p>
          </header>
          <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div class="space-y-2">
              <label class="text-xs text-neutral-500 dark:text-neutral-400">标题</label>
              <input v-model="form.title" type="text" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800" />
            </div>
            <div class="space-y-2">
              <label class="text-xs text-neutral-500 dark:text-neutral-400">摘要</label>
              <input v-model="form.summary" type="text" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800" placeholder="显示在条带上（可选）" />
            </div>
            <div class="space-y-2">
              <label class="text-xs text-neutral-500 dark:text-neutral-400">开始日期</label>
              <input v-model="form.startsAt" type="date" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800" />
            </div>
            <div class="space-y-2">
              <label class="text-xs text-neutral-500 dark:text-neutral-400">结束日期</label>
              <input v-model="form.endsAt" type="date" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800" />
            </div>
            <div class="space-y-2">
              <label class="text-xs text-neutral-500 dark:text-neutral-400">颜色</label>
              <div class="flex items-center gap-2">
                <input v-model="form.color" type="color" class="h-9 w-12 rounded border border-neutral-300 dark:border-neutral-700" />
                <input v-model="form.color" type="text" placeholder="#22c55e" class="flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800" />
              </div>
            </div>
            <div class="space-y-2">
              <label class="text-xs text-neutral-500 dark:text-neutral-400">发布</label>
              <label class="inline-flex items-center gap-2">
                <input v-model="form.isPublished" type="checkbox" class="rounded border-neutral-300 text-[rgb(var(--accent-strong))] focus:ring-[rgb(var(--accent))]" />
                <span class="text-sm">公开展示</span>
              </label>
            </div>
            <div class="sm:col-span-2 space-y-2">
              <label class="text-xs text-neutral-500 dark:text-neutral-400">详细说明（Markdown）</label>
              <textarea v-model="form.detailsMd" class="w-full min-h-[140px] rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800" placeholder="支持 Markdown 格式"></textarea>
            </div>
          </div>
          <div class="flex items-center justify-end gap-2">
            <button class="rounded-lg border border-neutral-200 px-4 py-2 text-sm dark:border-neutral-700" @click="resetForm">重置</button>
            <button :disabled="saving" class="rounded-lg bg-[rgb(var(--accent-strong))] px-4 py-2 text-sm font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))] disabled:opacity-60" @click="createEvent">保存</button>
          </div>
          <transition name="fade">
            <p v-if="message" class="text-xs text-emerald-700 dark:text-emerald-300">{{ message }}</p>
          </transition>
          <transition name="fade">
            <p v-if="error" class="text-xs text-rose-600 dark:text-rose-300">{{ error }}</p>
          </transition>
        </section>

        <!-- List -->
        <section class="space-y-4 rounded-2xl border border-neutral-200/70 bg-white/80 p-5 shadow-sm dark:border-neutral-800/70 dark:bg-neutral-900/70">
          <header class="flex items-center justify-between">
            <h2 class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">活动列表</h2>
            <button class="text-xs text-[rgb(var(--accent-strong))] hover:underline" @click="refresh">刷新</button>
          </header>
          <div class="overflow-x-auto">
            <table class="min-w-full divide-y divide-neutral-200 dark:divide-neutral-800">
              <thead class="bg-neutral-50/60 dark:bg-neutral-800/60">
                <tr>
                  <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">标题</th>
                  <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">时间</th>
                  <th class="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">发布</th>
                  <th class="px-4 py-3 text-right text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">操作</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-neutral-200 bg-white/70 dark:divide-neutral-800 dark:bg-neutral-900/40">
                <template v-for="ev in items" :key="ev.id">
                  <tr>
                    <td class="px-4 py-3 text-sm">
                      <div class="flex items-center gap-2">
                        <span :style="{ background: ev.color || '#64748b' }" class="inline-block h-3 w-3 rounded"></span>
                        <span class="font-medium">{{ ev.title }}</span>
                        <span v-if="ev.summary" class="text-neutral-500 dark:text-neutral-400">· {{ ev.summary }}</span>
                      </div>
                    </td>
                    <td class="px-4 py-3 text-sm text-neutral-600 dark:text-neutral-300">
                      {{ formatRange(ev.startsAt, ev.endsAt) }}
                    </td>
                    <td class="px-4 py-3 text-sm">
                      <label class="inline-flex items-center gap-2">
                        <input type="checkbox" v-model="ev.isPublished" @change="togglePublish(ev)" />
                        <span class="text-xs">{{ ev.isPublished ? '已发布' : '未发布' }}</span>
                      </label>
                    </td>
                    <td class="px-4 py-3 text-sm text-right">
                      <button class="rounded border border-neutral-300 px-2 py-1 mr-2 text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800" @click="openEdit(ev)">编辑</button>
                      <button class="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800" @click="remove(ev)">删除</button>
                    </td>
                  </tr>
                  <!-- Inline editor row -->
                  <tr v-if="editingId === ev.id" class="bg-neutral-50/50 dark:bg-neutral-800/40">
                    <td colspan="4" class="px-4 py-4">
                      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div class="space-y-2">
                          <label class="text-xs text-neutral-500 dark:text-neutral-400">标题</label>
                          <input v-model="edit.title" type="text" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800" />
                        </div>
                        <div class="space-y-2">
                          <label class="text-xs text-neutral-500 dark:text-neutral-400">摘要</label>
                          <input v-model="edit.summary" type="text" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800" />
                        </div>
                        <div class="space-y-2">
                          <label class="text-xs text-neutral-500 dark:text-neutral-400">开始日期</label>
                          <input v-model="edit.startsAt" type="date" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800" />
                        </div>
                        <div class="space-y-2">
                          <label class="text-xs text-neutral-500 dark:text-neutral-400">结束日期</label>
                          <input v-model="edit.endsAt" type="date" class="w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800" />
                        </div>
                        <div class="space-y-2">
                          <label class="text-xs text-neutral-500 dark:text-neutral-400">颜色</label>
                          <div class="flex items-center gap-2">
                            <input v-model="edit.color" type="color" class="h-9 w-12 rounded border border-neutral-300 dark:border-neutral-700" />
                            <input v-model="edit.color" type="text" placeholder="#22c55e" class="flex-1 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800" />
                          </div>
                        </div>
                        <div class="space-y-2">
                          <label class="text-xs text-neutral-500 dark:text-neutral-400">发布</label>
                          <label class="inline-flex items-center gap-2">
                            <input v-model="edit.isPublished" type="checkbox" class="rounded border-neutral-300 text-[rgb(var(--accent-strong))] focus:ring-[rgb(var(--accent))]" />
                            <span class="text-sm">公开展示</span>
                          </label>
                        </div>
                        <div class="sm:col-span-2 space-y-2">
                          <label class="text-xs text-neutral-500 dark:text-neutral-400">详细说明（Markdown）</label>
                          <textarea v-model="edit.detailsMd" class="w-full min-h-[120px] rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[rgb(var(--accent))] dark:border-neutral-700 dark:bg-neutral-800"></textarea>
                        </div>
                      </div>
                      <div class="mt-3 flex items-center justify-end gap-2">
                        <button class="rounded-lg border border-neutral-200 px-3 py-1.5 text-sm dark:border-neutral-700" @click="cancelEdit">取消</button>
                        <button :disabled="savingEdit" class="rounded-lg bg-[rgb(var(--accent-strong))] px-4 py-1.5 text-sm font-semibold text-white shadow transition hover:bg-[rgb(var(--accent))] disabled:opacity-60" @click="saveEdit">保存修改</button>
                      </div>
                      <transition name="fade"><p v-if="editMessage" class="text-xs text-emerald-700 dark:text-emerald-300 mt-1">{{ editMessage }}</p></transition>
                      <transition name="fade"><p v-if="editError" class="text-xs text-rose-600 dark:text-rose-300 mt-1">{{ editError }}</p></transition>
                    </td>
                  </tr>
                </template>
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useAuth } from '@/composables/useAuth';

type EventItem = {
  id: string
  title: string
  summary: string | null
  color: string | null
  startsAt: string
  endsAt: string
  detailsMd: string | null
  isPublished: boolean
}

const { $bff } = useNuxtApp();
const { status: authStatusRef } = useAuth();
const authStatus = ref<'unknown'|'authenticated'|'unauthenticated'>(authStatusRef.value);

const adminError = ref<string | null>(null);

const items = ref<EventItem[]>([]);
const saving = ref(false);
const message = ref('');
const error = ref('');

// Editing state
const editingId = ref<string | null>(null);
const savingEdit = ref(false);
const editMessage = ref('');
const editError = ref('');
const edit = ref({
  title: '',
  summary: '',
  color: '#22c55e',
  startsAt: '',
  endsAt: '',
  detailsMd: '',
  isPublished: true
});

const form = ref({
  title: '',
  summary: '',
  color: '#22c55e',
  startsAt: '',
  endsAt: '',
  detailsMd: '',
  isPublished: true
});

function resetForm() {
  form.value = {
    title: '',
    summary: '',
    color: '#22c55e',
    startsAt: '',
    endsAt: '',
    detailsMd: '',
    isPublished: true
  };
}

function formatRange(start: string, end: string) {
  const s = new Date(start);
  const e = new Date(end);
  const fmt = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${fmt(s)} 至 ${fmt(e)}`;
}

function fromIsoToLocalDate(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function refresh() {
  try {
    const res = await $bff<{ items: EventItem[] }>('/admin/events');
    items.value = res.items || [];
  } catch (err: any) {
    if (err?.response?.status === 401) adminError.value = '未登录';
    else if (err?.response?.status === 403) adminError.value = '无访问权限';
    else adminError.value = '加载失败';
  }
}

async function createEvent() {
  message.value = '';
  error.value = '';
  if (!form.value.title || !form.value.startsAt || !form.value.endsAt) {
    error.value = '请完整填写标题、开始和结束日期';
    return;
  }
  saving.value = true;
  try {
    const payload = {
      title: form.value.title,
      summary: form.value.summary || null,
      color: form.value.color || null,
      startsAt: toIsoDate(form.value.startsAt),
      endsAt: toIsoDate(form.value.endsAt),
      detailsMd: form.value.detailsMd || null,
      isPublished: !!form.value.isPublished
    };
    await $bff('/admin/events', { method: 'POST', body: payload });
    message.value = '创建成功';
    resetForm();
    await refresh();
  } catch (err: any) {
    error.value = err?.data?.error || '创建失败';
  } finally {
    saving.value = false;
  }
}

function toIsoDate(localDate: string) {
  // Interpret as local date (YYYY-MM-DD) and convert to ISO mid-day to avoid TZ shifts
  const [y, m, d] = localDate.split('-').map((s) => parseInt(s, 10));
  const date = new Date(y, (m - 1), d, 12, 0, 0);
  return date.toISOString();
}

function openEdit(ev: EventItem) {
  editMessage.value = '';
  editError.value = '';
  editingId.value = ev.id;
  edit.value = {
    title: ev.title,
    summary: ev.summary || '',
    color: ev.color || '#22c55e',
    startsAt: fromIsoToLocalDate(ev.startsAt),
    endsAt: fromIsoToLocalDate(ev.endsAt),
    detailsMd: ev.detailsMd || '',
    isPublished: !!ev.isPublished
  };
}

function cancelEdit() {
  editingId.value = null;
}

async function saveEdit() {
  if (!editingId.value) return;
  editMessage.value = '';
  editError.value = '';
  if (!edit.value.title || !edit.value.startsAt || !edit.value.endsAt) {
    editError.value = '请完整填写标题、开始和结束日期';
    return;
  }
  savingEdit.value = true;
  try {
    const payload = {
      title: edit.value.title,
      summary: edit.value.summary || null,
      color: edit.value.color || null,
      startsAt: toIsoDate(edit.value.startsAt),
      endsAt: toIsoDate(edit.value.endsAt),
      detailsMd: edit.value.detailsMd || null,
      isPublished: !!edit.value.isPublished
    };
    await $bff(`/admin/events/${editingId.value}`, { method: 'PATCH', body: payload });
    editMessage.value = '已保存修改';
    editingId.value = null;
    await refresh();
  } catch (err: any) {
    editError.value = err?.data?.error || '保存失败';
  } finally {
    savingEdit.value = false;
  }
}

async function togglePublish(ev: EventItem) {
  try {
    await $bff(`/admin/events/${ev.id}`, { method: 'PATCH', body: { isPublished: !!ev.isPublished } });
  } catch (err) {
    // revert on failure
    ev.isPublished = !ev.isPublished;
  }
}

async function remove(ev: EventItem) {
  if (!confirm(`确认删除活动 “${ev.title}”？`)) return;
  try {
    await $bff(`/admin/events/${ev.id}`, { method: 'DELETE' });
    await refresh();
  } catch (err) {
    // eslint-disable-next-line no-alert
    alert('删除失败');
  }
}

onMounted(async () => {
  await refresh();
});
</script>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity .15s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
