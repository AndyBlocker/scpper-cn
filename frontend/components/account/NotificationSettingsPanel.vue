<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useAlertSettings, type RevisionFilterOption } from '~/composables/useAlertSettings'
import { useAuth } from '~/composables/useAuth'
import { ALERT_METRICS, type AlertMetric } from '~/composables/useAlerts'
import { useNotifyPreferences, type NotifyType } from '~/composables/useNotifyPreferences'
import { useFollowAlerts } from '~/composables/useFollowAlerts'
import { useForumInteractionAlerts } from '~/composables/useForumInteractionAlerts'

/**
 * 通知设置 —— 从提醒流里搬出来的所有偏好。
 *
 * 旧版把这些控件嵌在提醒列表中间，而且**只在选中特定指标时才出现**
 * （投票阈值只在选 VOTE_COUNT 时显示，修订过滤只在选 REVISION_COUNT 时显示），
 * 是整个账号页最难被发现的交互。现在集中在一处，按「接收什么」与「怎么接收」分组。
 */

const { preferences, loading, saving, error, fetchPreferences, updatePreferences } = useAlertSettings()
const {
  matrix, byType, channel,
  loading: prefsLoading, loaded: prefsLoaded, saving: prefsSaving, error: prefsError,
  fetchPreferences: fetchNotifyPrefs, save: saveNotifyPrefs
} = useNotifyPreferences()
const { user, fetchCurrentUser } = useAuth()
// 站内开关改动后要强制重取对应来源 —— 它们各有 60 秒新鲜度门禁
const { fetchAll: refreshPageAlerts } = useAlerts()
const { fetchAlerts: refreshFollowAlerts } = useFollowAlerts()
const { fetchAlerts: refreshForumAlerts } = useForumInteractionAlerts()

const METRIC_LABEL: Record<AlertMetric, { title: string; hint: string }> = {
  COMMENT_COUNT: { title: '页面收到评论', hint: '你的作品下有新回复时提醒' },
  VOTE_COUNT: { title: '页面票数变化', hint: '累计变化达到下方阈值时提醒' },
  REVISION_COUNT: { title: '页面被编辑', hint: '你的作品被修订时提醒' }
}

/** 五类通知的展示信息。与后端 NotificationTypeKey 一一对应。 */
const TYPE_LABEL: Record<NotifyType, { title: string; hint: string }> = {
  PAGE_COMMENT: { title: '页面收到评论', hint: '你的作品下有新回复' },
  PAGE_VOTE: { title: '页面票数变化', hint: '累计变化达到触发条件' },
  PAGE_REVISION: { title: '页面被编辑', hint: '你的作品被修订' },
  FOLLOW_ACTIVITY: { title: '关注的作者有动态', hint: '发布或编辑了页面' },
  FORUM_INTERACTION: { title: '论坛回复与提及', hint: '有人回复你或 @ 你' }
}

const DIGEST_HOURS = Array.from({ length: 24 }, (_, h) => h)

/** 本地表单值：日限额与时点用 input 绑定，需要独立的 ref 才能在保存前校验 */
const dailyLimitInput = ref(20)
const digestHourInput = ref(21)
const modeInput = ref<'REALTIME' | 'DAILY_DIGEST'>('REALTIME')

watch(channel, (c) => {
  if (!c) return
  dailyLimitInput.value = c.qqDailyLimit
  digestHourInput.value = c.qqDigestHour
  modeInput.value = c.qqMode
}, { immediate: true, deep: true })

/**
 * 切换某个类型在某个渠道上的开关。
 *
 * 站内与 QQ **完全独立**：关掉站内不影响 QQ，反之亦然。
 * 这是刻意的 —— 「站内不看、只要 QQ 推」是常见诉求。
 */
async function toggleChannel(
  type: NotifyType,
  key: 'siteEnabled' | 'qqEnabled',
  next: boolean,
  el: HTMLInputElement
) {
  const row = byType.value.get(type)
  if (!row) return
  const updated = { ...row, [key]: next }
  const ok = await saveNotifyPrefs({ matrix: [updated] })
  if (ok && key === 'siteEnabled') {
    // 站内可见性变了，但共享的提醒列表与未读数还是旧的。
    // 三个 composable 都有 60 秒新鲜度门禁，非强制取数会被直接跳过 ——
    // 用户关掉某类提醒后，铃铛里那些条目和红点会继续挂着，像是没生效。
    // 强制重取对应的来源。
    // **两种读取口径都要刷**：铃铛用 unreadOnly=false、提醒流用 true，
    // 两份数据是分开存的。只刷一份的话，切到另一个界面时那 60 秒新鲜度门禁
    // 会让它继续用旧数据，被关掉的类型还挂在那儿。
    if (row.type === 'FOLLOW_ACTIVITY') {
      await Promise.all([refreshFollowAlerts(true, 20, 0, false), refreshFollowAlerts(true, 20, 0, true)])
    } else if (row.type === 'FORUM_INTERACTION') {
      await Promise.all([refreshForumAlerts(true, 20, 0, false), refreshForumAlerts(true, 20, 0, true)])
    } else {
      await Promise.all([refreshPageAlerts(true, false), refreshPageAlerts(true, true)])
    }
  }
  if (!ok) {
    // 这里用的是 :checked 单向绑定，浏览器点击时已经改了 DOM，
    // 而保存失败时 matrix 没变 —— Vue 的 vdom 认为值没变化就不会 patch 回去，
    // 勾选框会一直显示成「保存成功了」的样子，直到组件重新挂载。
    // 必须按权威状态手动写回。
    el.checked = row[key]
    return
  }
  flashSaved()
}

async function saveChannelSetting() {
  const ok = await saveNotifyPrefs({
    channel: {
      qqDailyLimit: dailyLimitInput.value,
      qqMode: modeInput.value,
      qqDigestHour: digestHourInput.value
    }
  })
  if (ok) flashSaved()
}

const REVISION_OPTIONS: Array<{ value: RevisionFilterOption; label: string; hint: string }> = [
  { value: 'ANY', label: '所有修订', hint: '包括你自己的编辑' },
  { value: 'NON_OWNER', label: '仅他人修订', hint: '忽略你自己的编辑' },
  { value: 'NON_OWNER_NO_ATTR', label: '仅非署名者修订', hint: '同时忽略共同署名者的编辑' }
]

const voteThreshold = ref(20)
const revisionFilter = ref<RevisionFilterOption>('ANY')
const ignoreSelfRevision = ref(true)
const savedHint = ref(false)
let savedTimer: ReturnType<typeof setTimeout> | null = null

// 从服务端拉到偏好后同步到本地表单
watch(preferences, (p) => {
  if (!p) return
  voteThreshold.value = p.voteCountThreshold
  revisionFilter.value = p.revisionFilter
  ignoreSelfRevision.value = p.ignoreLinkedWikidotSelfRevision
}, { immediate: true, deep: true })

const qqBound = computed(() => Boolean(user.value?.qqBinding?.bound))
const qqMask = computed(() => user.value?.qqBinding?.addressMask ?? null)
/**
 * 只有 ACTIVE 才算真的能收 —— 投递器只加载 ACTIVE 的绑定。
 * PAUSED（连续投递失败被自动暂停）时 bound 仍是 true，
 * 照着 bound 画绿点会让用户完全看不出「为什么收不到了」。
 */
const qqActive = computed(() => user.value?.qqBinding?.status === 'ACTIVE')
const qqPaused = computed(() => qqBound.value && !qqActive.value)

function flashSaved() {
  savedHint.value = true
  if (savedTimer) clearTimeout(savedTimer)
  savedTimer = setTimeout(() => { savedHint.value = false }, 1800)
}

async function saveGeneration() {
  await updatePreferences({
    voteCountThreshold: voteThreshold.value,
    revisionFilter: revisionFilter.value,
    ignoreLinkedWikidotSelfRevision: ignoreSelfRevision.value
  })
  if (!error.value) flashSaved()
}

/**
 * 旧的 toggleMuted 已被上面的 toggleChannel 取代 —— 静音是单一开关，
 * 现在每个类型有站内/QQ 两个独立开关，语义不同，不再复用。
 */

onMounted(() => {
  void fetchPreferences()
  void fetchNotifyPrefs()
  // 渠道健康度（ACTIVE / PAUSED）随投递结果在后端变化，只失效了服务端缓存，
  // SPA 里的 user 对象不会自己更新 —— 长会话或直接导航进来时，
  // 这里的绿点/黄点可能一直停在过期状态。强制刷新一次登录态。
  void fetchCurrentUser(true)
})
</script>

<template>
  <div class="space-y-8">
    <div v-if="error" class="rounded-lg border border-[rgb(var(--danger))]/30 bg-[rgb(var(--danger))]/10 px-3 py-2 text-sm text-[rgb(var(--danger-strong))]" role="alert">
      {{ error }}
    </div>

    <div v-if="loading" class="py-8 text-center text-sm text-[rgb(var(--muted))]">正在加载设置…</div>

    <template v-else>
      <!-- ① 接收什么 × 走哪个渠道 -->
      <section>
        <h3 class="text-sm font-semibold text-[rgb(var(--fg))]">接收哪些提醒</h3>
        <p class="mt-0.5 text-xs text-[rgb(var(--muted))]">
          两个渠道**互相独立**：关掉站内不影响 QQ 推送，反之亦然。
        </p>

        <div class="mt-3 overflow-hidden rounded-lg border border-[rgb(var(--panel-border))]">
          <div class="flex items-center gap-3 border-b border-[rgb(var(--panel-border))] bg-[rgb(var(--panel-border))]/20 px-3 py-2 text-xs font-medium text-[rgb(var(--muted))]">
            <span class="min-w-0 flex-1">类型</span>
            <span class="w-12 shrink-0 text-center">站内</span>
            <span class="w-12 shrink-0 text-center">QQ</span>
          </div>
          <div class="divide-y divide-[rgb(var(--panel-border))]">
            <div v-for="row in matrix" :key="row.type" class="flex items-center gap-3 px-3 py-3">
              <span class="min-w-0 flex-1">
                <span class="block text-sm text-[rgb(var(--fg))]">{{ TYPE_LABEL[row.type].title }}</span>
                <span class="block text-xs text-[rgb(var(--muted))]">{{ TYPE_LABEL[row.type].hint }}</span>
              </span>
              <span class="w-12 shrink-0 text-center">
                <input
                  type="checkbox"
                  class="h-4 w-4 rounded border-[rgb(var(--input-border))]"
                  :checked="row.siteEnabled"
                  :disabled="prefsSaving || prefsLoading || !prefsLoaded"
                  :aria-label="`${TYPE_LABEL[row.type].title} 的站内提醒`"
                  @change="toggleChannel(row.type, 'siteEnabled', ($event.target as HTMLInputElement).checked, $event.target as HTMLInputElement)"
                >
              </span>
              <span class="w-12 shrink-0 text-center">
                <input
                  type="checkbox"
                  class="h-4 w-4 rounded border-[rgb(var(--input-border))] disabled:opacity-40"
                  :checked="row.qqEnabled"
                  :disabled="prefsSaving || prefsLoading || !prefsLoaded || !qqBound"
                  :aria-label="`${TYPE_LABEL[row.type].title} 的 QQ 推送`"
                  :title="qqBound ? '' : '绑定 QQ 后可用'"
                  @change="toggleChannel(row.type, 'qqEnabled', ($event.target as HTMLInputElement).checked, $event.target as HTMLInputElement)"
                >
              </span>
            </div>
          </div>
        </div>
        <p v-if="!qqBound" class="mt-2 text-xs text-[rgb(var(--muted))]">
          QQ 一列需要先绑定 QQ 才能调整；这里的设置会在绑定后立即生效。
        </p>
        <p v-if="prefsError" class="mt-2 text-xs text-[rgb(var(--danger-strong))]" role="alert">{{ prefsError }}</p>
      </section>

      <!-- ② 触发条件 -->
      <section>
        <h3 class="text-sm font-semibold text-[rgb(var(--fg))]">触发条件</h3>
        <div class="mt-3 space-y-4 rounded-lg border border-[rgb(var(--panel-border))] p-4">
          <div>
            <label for="vote-threshold" class="block text-sm text-[rgb(var(--fg))]">票数变化阈值</label>
            <p class="mt-0.5 text-xs text-[rgb(var(--muted))]">
              累计变化达到这个数值才提醒一次，避免每一票都打扰你。
            </p>
            <div class="mt-2 flex items-center gap-2">
              <input
                id="vote-threshold"
                v-model.number="voteThreshold"
                type="number"
                min="1"
                max="1000"
                class="w-24 rounded-lg border border-[rgb(var(--input-border))] bg-[rgb(var(--input-bg))] px-2 py-1.5 text-sm"
                :disabled="saving"
              >
              <span class="text-xs text-[rgb(var(--muted))]">票</span>
            </div>
          </div>

          <div>
            <span class="block text-sm text-[rgb(var(--fg))]">页面编辑提醒范围</span>
            <div class="mt-2 space-y-1.5">
              <label v-for="opt in REVISION_OPTIONS" :key="opt.value" class="flex cursor-pointer items-start gap-2">
                <input
                  v-model="revisionFilter"
                  type="radio"
                  :value="opt.value"
                  class="mt-0.5 h-4 w-4 border-[rgb(var(--input-border))]"
                  :disabled="saving"
                >
                <span>
                  <span class="block text-sm text-[rgb(var(--fg))]">{{ opt.label }}</span>
                  <span class="block text-xs text-[rgb(var(--muted))]">{{ opt.hint }}</span>
                </span>
              </label>
            </div>
          </div>

          <label class="flex cursor-pointer items-start gap-2">
            <input
              v-model="ignoreSelfRevision"
              type="checkbox"
              class="mt-0.5 h-4 w-4 rounded border-[rgb(var(--input-border))]"
              :disabled="saving"
            >
            <span>
              <span class="block text-sm text-[rgb(var(--fg))]">忽略我自己账号的修订</span>
              <span class="block text-xs text-[rgb(var(--muted))]">用已绑定的 Wikidot 身份判断</span>
            </span>
          </label>

          <div class="flex items-center gap-3 pt-1">
            <button
              type="button"
              class="rounded-lg bg-[rgb(var(--accent))] px-4 py-1.5 text-sm text-white hover:bg-[rgb(var(--accent-strong))] disabled:opacity-50"
              :disabled="saving"
              @click="saveGeneration"
            >
              {{ saving ? '保存中…' : '保存' }}
            </button>
            <span v-if="savedHint" class="text-xs text-[rgb(var(--success-strong))]" role="status">已保存</span>
          </div>
        </div>
      </section>

      <!-- ③ 推送渠道 -->
      <section>
        <h3 class="text-sm font-semibold text-[rgb(var(--fg))]">推送渠道</h3>
        <p class="mt-0.5 text-xs text-[rgb(var(--muted))]">
          站内提醒始终开启。绑定 QQ 后可额外通过私信接收。
        </p>
        <div class="mt-3 space-y-2 rounded-lg border border-[rgb(var(--panel-border))] p-4">
          <div class="flex items-center gap-2 text-sm text-[rgb(var(--fg))]">
            <span class="inline-block h-2 w-2 rounded-full bg-[rgb(var(--success))]" aria-hidden="true" />
            站内提醒
            <span class="text-xs text-[rgb(var(--muted))]">（始终开启）</span>
          </div>
          <div class="flex items-center gap-2 text-sm">
            <span
              class="inline-block h-2 w-2 rounded-full"
              :class="qqActive ? 'bg-[rgb(var(--success))]' : qqPaused ? 'bg-[rgb(var(--warning))]' : 'bg-[rgb(var(--slate-400))]'"
              aria-hidden="true"
            />
            <span class="text-[rgb(var(--fg))]">QQ 私信</span>
            <span v-if="qqBound" class="font-mono text-xs text-[rgb(var(--muted))]">{{ qqMask }}</span>
            <span v-if="qqPaused" class="text-xs text-[rgb(var(--warning-strong))]">
              已暂停（连续投递失败，请确认机器人仍是好友后重新绑定）
            </span>
            <span v-else-if="!qqBound" class="text-xs text-[rgb(var(--muted))]">未绑定</span>
            <NuxtLink
              v-if="!qqBound"
              to="/account?tab=overview"
              class="ml-auto text-xs text-[var(--g-accent)] hover:underline"
            >
              去绑定 →
            </NuxtLink>
          </div>
          <!-- QQ 渠道的推送节奏与用量上限 -->
          <div v-if="qqBound" class="mt-3 space-y-4 border-t border-[rgb(var(--panel-border))] pt-4">
            <div>
              <span class="block text-sm text-[rgb(var(--fg))]">推送节奏</span>
              <div class="mt-2 space-y-1.5">
                <label class="flex cursor-pointer items-start gap-2">
                  <input v-model="modeInput" type="radio" value="REALTIME" class="mt-0.5 h-4 w-4" :disabled="prefsSaving || prefsLoading || !prefsLoaded">
                  <span>
                    <span class="block text-sm text-[rgb(var(--fg))]">实时</span>
                    <span class="block text-xs text-[rgb(var(--muted))]">有新动态就推（仍按同步周期汇总，通常一小时内）</span>
                  </span>
                </label>
                <label class="flex cursor-pointer items-start gap-2">
                  <input v-model="modeInput" type="radio" value="DAILY_DIGEST" class="mt-0.5 h-4 w-4" :disabled="prefsSaving || prefsLoading || !prefsLoaded">
                  <span>
                    <span class="block text-sm text-[rgb(var(--fg))]">每日汇总一次</span>
                    <span class="block text-xs text-[rgb(var(--muted))]">攒到指定时间一起推，当天只发一条</span>
                  </span>
                </label>
              </div>
            </div>

            <div v-if="modeInput === 'DAILY_DIGEST'">
              <label for="digest-hour" class="block text-sm text-[rgb(var(--fg))]">发送时间</label>
              <div class="mt-2 flex items-center gap-2">
                <select
                  id="digest-hour"
                  v-model.number="digestHourInput"
                  class="rounded-lg border border-[rgb(var(--input-border))] bg-[rgb(var(--input-bg))] px-2 py-1.5 text-sm"
                  :disabled="prefsSaving || prefsLoading || !prefsLoaded"
                >
                  <option v-for="h in DIGEST_HOURS" :key="h" :value="h">{{ String(h).padStart(2, '0') }}:00</option>
                </select>
                <span class="text-xs text-[rgb(var(--muted))]">（UTC+8）</span>
              </div>
            </div>

            <div>
              <label for="qq-daily-limit" class="block text-sm text-[rgb(var(--fg))]">每日最多接收</label>
              <p class="mt-0.5 text-xs text-[rgb(var(--muted))]">
                达到上限后当天剩余提醒不再推送（站内仍可查看）。
              </p>
              <div class="mt-2 flex items-center gap-2">
                <input
                  id="qq-daily-limit"
                  v-model.number="dailyLimitInput"
                  type="number"
                  min="1"
                  max="200"
                  class="w-24 rounded-lg border border-[rgb(var(--input-border))] bg-[rgb(var(--input-bg))] px-2 py-1.5 text-sm"
                  :disabled="prefsSaving || prefsLoading || !prefsLoaded"
                >
                <span class="text-xs text-[rgb(var(--muted))]">条</span>
                <span
                  v-if="dailyLimitInput > channel.globalDailyLimit"
                  class="text-xs text-[rgb(var(--warning-strong))]"
                >
                  超过站点上限，实际按 {{ channel.globalDailyLimit }} 条执行
                </span>
              </div>
            </div>

            <div class="flex items-center gap-3">
              <button
                type="button"
                class="rounded-lg bg-[rgb(var(--accent))] px-4 py-1.5 text-sm text-white hover:bg-[rgb(var(--accent-strong))] disabled:opacity-50"
                :disabled="prefsSaving"
                @click="saveChannelSetting"
              >
                {{ prefsSaving ? '保存中…' : '保存推送设置' }}
              </button>
            </div>
          </div>

          <p v-else class="pt-1 text-[11px] text-[rgb(var(--muted))]">
            绑定 QQ 后可设置推送节奏与每日上限。
          </p>
        </div>
      </section>
    </template>
  </div>
</template>
