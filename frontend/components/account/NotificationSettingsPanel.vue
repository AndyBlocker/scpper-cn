<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRuntimeConfig } from 'nuxt/app'
import { useAlertSettings, type RevisionFilterOption } from '~/composables/useAlertSettings'
import { useAuth } from '~/composables/useAuth'
import { ALERT_METRICS, type AlertMetric } from '~/composables/useAlerts'

/**
 * 通知设置 —— 从提醒流里搬出来的所有偏好。
 *
 * 旧版把这些控件嵌在提醒列表中间，而且**只在选中特定指标时才出现**
 * （投票阈值只在选 VOTE_COUNT 时显示，修订过滤只在选 REVISION_COUNT 时显示），
 * 是整个账号页最难被发现的交互。现在集中在一处，按「接收什么」与「怎么接收」分组。
 */

const { preferences, loading, saving, error, fetchPreferences, updatePreferences, setMetricMuted } = useAlertSettings()
const { user, fetchCurrentUser } = useAuth()

const METRIC_LABEL: Record<AlertMetric, { title: string; hint: string }> = {
  COMMENT_COUNT: { title: '页面收到评论', hint: '你的作品下有新回复时提醒' },
  VOTE_COUNT: { title: '页面票数变化', hint: '累计变化达到下方阈值时提醒' },
  REVISION_COUNT: { title: '页面被编辑', hint: '你的作品被修订时提醒' }
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

// QQ 通知总开关（2026-07-30 暂时下线）。关掉时不显示推送渠道一节。
const qqNotifyEnabled = computed(() => Boolean(useRuntimeConfig().public.qqNotifyEnabled))
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
 * 切换「接收此类提醒」。
 *
 * 必须把 input 元素传进来：这里用的是 :checked 单向绑定，浏览器点击时
 * 已经改了 DOM，而保存失败时 preferences 并没有变 —— Vue 的 vdom 认为
 * :checked 的值没变化，就不会把 DOM patch 回去，勾选框于是一直显示成
 * 「保存成功了」的样子，直到组件重新挂载。失败时得手动写回。
 */
async function toggleMuted(metric: AlertMetric, muted: boolean, el: HTMLInputElement) {
  try {
    await setMetricMuted(metric, muted)
  } catch {
    // setMetricMuted 会抛，错误文案由 error.value 呈现
  }
  if (error.value) {
    // 以权威状态为准复原：checked 表示「接收」，即 muted 为 false
    el.checked = !preferences.value.mutedMetrics[metric]
    return
  }
  flashSaved()
}

onMounted(() => {
  void fetchPreferences()
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
      <!-- ① 接收什么 -->
      <section>
        <h3 class="text-sm font-semibold text-[rgb(var(--fg))]">接收哪些提醒</h3>
        <p class="mt-0.5 text-xs text-[rgb(var(--muted))]">
          关掉后将不再产生这类提醒{{ qqNotifyEnabled ? '，站内与 QQ 都不会收到' : '' }}。
        </p>
        <div class="mt-3 divide-y divide-[rgb(var(--panel-border))] rounded-lg border border-[rgb(var(--panel-border))]">
          <label
            v-for="m in ALERT_METRICS"
            :key="m"
            class="flex cursor-pointer items-start gap-3 p-3"
          >
            <input
              type="checkbox"
              class="mt-0.5 h-4 w-4 rounded border-[rgb(var(--input-border))]"
              :checked="!preferences.mutedMetrics[m]"
              :disabled="saving"
              @change="toggleMuted(m, !($event.target as HTMLInputElement).checked, $event.target as HTMLInputElement)"
            >
            <span class="min-w-0">
              <span class="block text-sm text-[rgb(var(--fg))]">{{ METRIC_LABEL[m].title }}</span>
              <span class="block text-xs text-[rgb(var(--muted))]">{{ METRIC_LABEL[m].hint }}</span>
            </span>
          </label>
        </div>
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

      <!-- ③ 推送渠道。整节的意义就是 QQ（站内那行只是「始终开启」的说明），
           功能下线时整节隐藏，留一行「站内始终开启」反而让人以为漏了什么。 -->
      <section v-if="qqNotifyEnabled">
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
          <p class="pt-1 text-[11px] text-[rgb(var(--muted))]">
            QQ 推送按整点同步周期汇总发送，通常在事件发生后一小时内送达。
          </p>
        </div>
      </section>
    </template>
  </div>
</template>
