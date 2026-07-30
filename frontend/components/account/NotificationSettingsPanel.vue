<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useQqNotifyEnabled } from '~/composables/useQqNotifyEnabled'
import {
  AlertSettingsSupersededError,
  useAlertSettings,
  type AlertPreferences,
  type RevisionFilterOption
} from '~/composables/useAlertSettings'
import { useAuth } from '~/composables/useAuth'
import { ALERT_METRICS, type AlertMetric } from '~/composables/useAlerts'

type PanelState = 'loading' | 'ready' | 'saving' | 'load-error'

interface PreferencesSnapshot {
  voteCountThreshold: number
  revisionFilter: RevisionFilterOption
  ignoreLinkedWikidotSelfRevision: boolean
  mutedMetrics: Record<AlertMetric, boolean>
}

interface SnapshotIdentity {
  userId: string
  epoch: number
}

const {
  error: settingsError,
  identityEpoch,
  fetchPreferences,
  updatePreferences,
  setMetricMuted
} = useAlertSettings()
const { user, status: authStatus, fetchCurrentUser } = useAuth()

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

const panelState = ref<PanelState>('loading')
const serverSnapshot = ref<PreferencesSnapshot | null>(null)
const serverSnapshotIdentity = ref<SnapshotIdentity | null>(null)
const draft = ref<PreferencesSnapshot | null>(null)
const snapshotStale = ref(false)
const loadError = ref<string | null>(null)
const actionError = ref<string | null>(null)
const savedMessage = ref<string | null>(null)
let savedTimer: ReturnType<typeof setTimeout> | null = null
let mounted = false
let panelGeneration = 0
let activeLoadGeneration: number | null = null
let reloadScheduled = false

const isBusy = computed(() => panelState.value === 'loading' || panelState.value === 'saving')
const currentIdentity = computed<SnapshotIdentity | null>(() => {
  const userId = user.value?.id
  if (authStatus.value !== 'authenticated' || !userId) return null
  return {
    userId,
    epoch: identityEpoch.value
  }
})
const snapshotOwnedByCurrentIdentity = computed(() => (
  identitiesEqual(serverSnapshotIdentity.value, currentIdentity.value)
))
const dirty = computed(() => {
  if (!serverSnapshot.value || !draft.value) return false
  return !snapshotsEqual(serverSnapshot.value, draft.value)
})
const thresholdValid = computed(() => {
  if (!draft.value) return false
  const value = Number(draft.value.voteCountThreshold)
  return Number.isInteger(value) && value >= 1 && value <= 1000
})
const canEdit = computed(() => (
  panelState.value === 'ready'
  && serverSnapshot.value !== null
  && draft.value !== null
  && snapshotOwnedByCurrentIdentity.value
  && !snapshotStale.value
))

// QQ 通知总开关（2026-07-30 暂时下线）。关掉时不读取或显示渠道状态。
const qqNotifyEnabled = useQqNotifyEnabled()
const qqBound = computed(() => Boolean(user.value?.qqBinding?.bound))
const qqMask = computed(() => user.value?.qqBinding?.addressMask ?? null)
const qqFeatureAvailable = computed(() => Boolean(
  user.value?.qqBinding?.capabilities?.featureEnabled
))
// 只有 user-backend 明确给出 deliverNotifications=true 才显示投递绿灯；
// status=ACTIVE 本身不代表总开关与机器人配置当前可用。
const qqActive = computed(() => (
  qqBound.value
  && Boolean(user.value?.qqBinding?.capabilities?.deliverNotifications)
))
const qqFeaturePaused = computed(() => !qqFeatureAvailable.value)
const qqPaused = computed(() => (
  qqBound.value
  && qqFeatureAvailable.value
  && !qqActive.value
))

function snapshotFromPreferences(preferences: AlertPreferences): PreferencesSnapshot {
  return {
    voteCountThreshold: Number(preferences.voteCountThreshold),
    revisionFilter: preferences.revisionFilter,
    ignoreLinkedWikidotSelfRevision: preferences.ignoreLinkedWikidotSelfRevision,
    mutedMetrics: {
      COMMENT_COUNT: Boolean(preferences.mutedMetrics.COMMENT_COUNT),
      VOTE_COUNT: Boolean(preferences.mutedMetrics.VOTE_COUNT),
      REVISION_COUNT: Boolean(preferences.mutedMetrics.REVISION_COUNT)
    }
  }
}

function identitiesEqual(
  left: SnapshotIdentity | null,
  right: SnapshotIdentity | null
): boolean {
  return Boolean(
    left
    && right
    && left.userId === right.userId
    && left.epoch === right.epoch
  )
}

function captureIdentity(): SnapshotIdentity | null {
  const identity = currentIdentity.value
  return identity ? { ...identity } : null
}

function isCurrentPanelOperation(
  generation: number,
  identity: SnapshotIdentity
): boolean {
  return mounted
    && generation === panelGeneration
    && identitiesEqual(identity, currentIdentity.value)
}

function cloneSnapshot(source: PreferencesSnapshot): PreferencesSnapshot {
  return {
    ...source,
    mutedMetrics: { ...source.mutedMetrics }
  }
}

function snapshotsEqual(left: PreferencesSnapshot, right: PreferencesSnapshot): boolean {
  return left.voteCountThreshold === right.voteCountThreshold
    && left.revisionFilter === right.revisionFilter
    && left.ignoreLinkedWikidotSelfRevision === right.ignoreLinkedWikidotSelfRevision
    && ALERT_METRICS.every(metric => left.mutedMetrics[metric] === right.mutedMetrics[metric])
}

function generationFieldsMatch(left: PreferencesSnapshot, right: PreferencesSnapshot): boolean {
  return left.voteCountThreshold === right.voteCountThreshold
    && left.revisionFilter === right.revisionFilter
    && left.ignoreLinkedWikidotSelfRevision === right.ignoreLinkedWikidotSelfRevision
}

function messageFrom(errorValue: unknown, fallback: string): string {
  if (settingsError.value) return settingsError.value
  if (errorValue instanceof Error && errorValue.message) return errorValue.message
  return fallback
}

function flashSaved(message: string) {
  savedMessage.value = message
  if (savedTimer) clearTimeout(savedTimer)
  savedTimer = setTimeout(() => { savedMessage.value = null }, 1800)
}

function clearSavedFeedback() {
  if (savedTimer) {
    clearTimeout(savedTimer)
    savedTimer = null
  }
  savedMessage.value = null
}

function invalidatePanelSnapshot() {
  // 先递增本地世代，所有旧身份的 load/save finally 都不能再改变新面板。
  panelGeneration += 1
  activeLoadGeneration = null
  serverSnapshot.value = null
  serverSnapshotIdentity.value = null
  draft.value = null
  snapshotStale.value = false
  loadError.value = null
  actionError.value = null
  clearSavedFeedback()
  panelState.value = 'loading'
}

function scheduleIdentityReload() {
  if (!mounted || reloadScheduled || !currentIdentity.value) return
  reloadScheduled = true
  queueMicrotask(() => {
    reloadScheduled = false
    if (mounted && currentIdentity.value) {
      void loadPreferences()
    }
  })
}

async function loadPreferences() {
  const identity = captureIdentity()
  if (!identity || panelState.value === 'saving') return
  if (
    activeLoadGeneration !== null
    && activeLoadGeneration === panelGeneration
  ) return

  const hadSnapshot = Boolean(
    serverSnapshot.value
    && identitiesEqual(serverSnapshotIdentity.value, identity)
  )
  const operationGeneration = panelGeneration + 1
  panelGeneration = operationGeneration
  activeLoadGeneration = operationGeneration
  panelState.value = 'loading'
  loadError.value = null
  actionError.value = null
  clearSavedFeedback()

  try {
    const result = await fetchPreferences()
    if (
      result.identityEpoch !== identity.epoch
      || !isCurrentPanelOperation(operationGeneration, identity)
    ) {
      throw new AlertSettingsSupersededError()
    }

    const confirmed = snapshotFromPreferences(result.preferences)
    serverSnapshot.value = confirmed
    serverSnapshotIdentity.value = { ...identity }
    draft.value = cloneSnapshot(confirmed)
    snapshotStale.value = false
    panelState.value = 'ready'
  } catch (errorValue) {
    // 身份 watcher 已经清空并为新用户安排了加载。旧请求的 catch/finally
    // 必须完全静默，不能重新放回 A 的快照或把 B 的面板标成 ready。
    if (!isCurrentPanelOperation(operationGeneration, identity)) return

    loadError.value = messageFrom(errorValue, '无法加载提醒设置，请稍后重试。')
    if (
      hadSnapshot
      && serverSnapshot.value
      && identitiesEqual(serverSnapshotIdentity.value, identity)
    ) {
      draft.value = cloneSnapshot(serverSnapshot.value)
      snapshotStale.value = true
      panelState.value = 'ready'
    } else {
      serverSnapshot.value = null
      serverSnapshotIdentity.value = null
      draft.value = null
      snapshotStale.value = false
      panelState.value = 'load-error'
    }
  } finally {
    if (activeLoadGeneration === operationGeneration) {
      activeLoadGeneration = null
    }
  }
}

async function saveGeneration() {
  if (!canEdit.value || !draft.value || !dirty.value || !thresholdValid.value) return
  const identity = captureIdentity()
  if (!identity || !identitiesEqual(serverSnapshotIdentity.value, identity)) return

  const expected = cloneSnapshot(draft.value)
  const operationGeneration = panelGeneration + 1
  panelGeneration = operationGeneration
  panelState.value = 'saving'
  actionError.value = null
  clearSavedFeedback()

  try {
    const result = await updatePreferences({
      voteCountThreshold: expected.voteCountThreshold,
      revisionFilter: expected.revisionFilter,
      ignoreLinkedWikidotSelfRevision: expected.ignoreLinkedWikidotSelfRevision
    })
    if (
      result.identityEpoch !== identity.epoch
      || !isCurrentPanelOperation(operationGeneration, identity)
    ) {
      throw new AlertSettingsSupersededError()
    }

    const confirmed = snapshotFromPreferences(result.preferences)
    if (!generationFieldsMatch(confirmed, expected)) {
      throw new Error('服务器没有确认这次修改，请重试。')
    }
    serverSnapshot.value = confirmed
    serverSnapshotIdentity.value = { ...identity }
    draft.value = cloneSnapshot(confirmed)
    snapshotStale.value = false
    flashSaved('设置已保存')
  } catch (errorValue) {
    if (!isCurrentPanelOperation(operationGeneration, identity)) return
    actionError.value = messageFrom(errorValue, '保存提醒设置失败，请重试。')
  } finally {
    if (isCurrentPanelOperation(operationGeneration, identity)) {
      panelState.value = 'ready'
    }
  }
}

async function toggleMuted(metric: AlertMetric, muted: boolean) {
  if (!canEdit.value || !draft.value || !serverSnapshot.value) return
  const identity = captureIdentity()
  if (!identity || !identitiesEqual(serverSnapshotIdentity.value, identity)) return

  const draftBeforeToggle = cloneSnapshot(draft.value)
  const expectedDraft = cloneSnapshot(draft.value)
  expectedDraft.mutedMetrics[metric] = muted
  draft.value = expectedDraft
  const operationGeneration = panelGeneration + 1
  panelGeneration = operationGeneration
  panelState.value = 'saving'
  actionError.value = null
  clearSavedFeedback()

  try {
    const result = await setMetricMuted(metric, muted)
    if (
      result.identityEpoch !== identity.epoch
      || !isCurrentPanelOperation(operationGeneration, identity)
    ) {
      throw new AlertSettingsSupersededError()
    }

    const confirmed = snapshotFromPreferences(result.preferences)
    if (confirmed.mutedMetrics[metric] !== muted) {
      throw new Error('服务器没有确认这次修改，请重试。')
    }

    serverSnapshot.value = confirmed
    serverSnapshotIdentity.value = { ...identity }
    draft.value = {
      ...draftBeforeToggle,
      mutedMetrics: { ...confirmed.mutedMetrics }
    }
    snapshotStale.value = false
    flashSaved('提醒类型已保存')
  } catch (errorValue) {
    if (!isCurrentPanelOperation(operationGeneration, identity)) return
    draft.value = draftBeforeToggle
    actionError.value = messageFrom(errorValue, '保存提醒设置失败，请重试。')
  } finally {
    if (isCurrentPanelOperation(operationGeneration, identity)) {
      panelState.value = 'ready'
    }
  }
}

function resetDraft() {
  if (!serverSnapshot.value || !snapshotOwnedByCurrentIdentity.value || isBusy.value) return
  draft.value = cloneSnapshot(serverSnapshot.value)
  actionError.value = null
  clearSavedFeedback()
}

watch([
  () => authStatus.value,
  () => user.value?.id,
  () => identityEpoch.value
], () => {
  // user id 与 composable epoch 都是快照所有权的一部分。同步清空能保证
  // 同一帧内也不会出现“B 的 Cookie + A 的可编辑草稿”。
  invalidatePanelSnapshot()
  scheduleIdentityReload()
}, { flush: 'sync' })

onMounted(() => {
  mounted = true
  scheduleIdentityReload()
  if (qqNotifyEnabled.value) {
    void fetchCurrentUser(true)
  }
})

onBeforeUnmount(() => {
  mounted = false
  panelGeneration += 1
  activeLoadGeneration = null
  clearSavedFeedback()
})
</script>

<template>
  <div
    class="space-y-6"
    :aria-busy="isBusy"
  >
    <div
      v-if="panelState === 'load-error' && !serverSnapshot"
      class="rounded-lg border border-[rgb(var(--danger))]/30 bg-[rgb(var(--danger))]/10 p-5"
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
    >
      <h2 id="notification-settings-load-error-title" class="text-base font-semibold text-[rgb(var(--danger-strong))]">
        无法加载提醒偏好
      </h2>
      <p class="mt-1 text-sm text-[rgb(var(--danger-strong))]">
        {{ loadError || '尚未取得服务端设置。为避免覆盖你已有的偏好，所有控件都已停用。' }}
      </p>
      <p class="mt-2 text-xs text-[rgb(var(--muted-strong))]">
        在成功读取服务端数据之前，本页面不会使用本地默认值，也不会发送保存请求。
      </p>
      <button
        type="button"
        class="mt-4 inline-flex min-h-11 items-center rounded-lg border border-[rgb(var(--danger))]/40 px-4 text-sm font-semibold text-[rgb(var(--danger-strong))] hover:bg-[rgb(var(--danger))]/10 disabled:cursor-not-allowed disabled:opacity-50"
        :disabled="isBusy"
        @click="loadPreferences"
      >
        重新加载
      </button>
    </div>

    <div
      v-else-if="panelState === 'loading' && !serverSnapshot"
      class="py-10 text-center text-sm text-[rgb(var(--muted))]"
      role="status"
      aria-live="polite"
    >
      正在从服务端加载提醒偏好…
    </div>

    <template v-else-if="draft && serverSnapshot">
      <header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 class="text-base font-semibold text-[rgb(var(--fg))]">页面提醒偏好</h2>
          <p class="mt-1 text-xs leading-5 text-[rgb(var(--muted))]">
            这些设置只影响你自己页面的评论、票数与修订提醒。
          </p>
        </div>
        <button
          type="button"
          class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-[rgb(var(--panel-border))] px-4 text-sm font-semibold text-[rgb(var(--muted-strong))] hover:text-[rgb(var(--accent))] disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="isBusy || dirty"
          :title="dirty ? '请先保存或撤销当前修改' : undefined"
          @click="loadPreferences"
        >
          {{ panelState === 'loading' ? '刷新中…' : '刷新设置' }}
        </button>
      </header>

      <div
        v-if="snapshotStale"
        class="flex flex-col gap-3 rounded-lg border border-[rgb(var(--warning))]/40 bg-[rgb(var(--warning))]/10 p-4 sm:flex-row sm:items-center sm:justify-between"
        role="status"
        aria-live="polite"
      >
        <div>
          <p class="text-sm font-semibold text-[rgb(var(--warning-strong))]">当前显示的是上次成功加载的设置</p>
          <p class="mt-1 text-xs text-[rgb(var(--muted-strong))]">
            {{ loadError || '刷新失败。为避免用过期数据覆盖服务端设置，暂时无法修改。' }}
          </p>
        </div>
        <button
          type="button"
          class="inline-flex min-h-11 shrink-0 items-center justify-center rounded-lg border border-[rgb(var(--warning))]/40 px-4 text-sm font-semibold text-[rgb(var(--warning-strong))] hover:bg-[rgb(var(--warning))]/10 disabled:cursor-not-allowed disabled:opacity-50"
          :disabled="isBusy"
          @click="loadPreferences"
        >
          重新加载
        </button>
      </div>

      <div
        v-else-if="panelState === 'loading'"
        class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] px-4 py-3 text-sm text-[rgb(var(--muted-strong))]"
        role="status"
        aria-live="polite"
      >
        正在刷新服务端设置，完成前无法修改。
      </div>

      <div
        v-if="actionError"
        class="rounded-lg border border-[rgb(var(--danger))]/30 bg-[rgb(var(--danger))]/10 px-4 py-3 text-sm text-[rgb(var(--danger-strong))]"
        role="alert"
        aria-live="assertive"
      >
        {{ actionError }}
      </div>

      <p
        v-if="dirty"
        class="text-xs font-medium text-[rgb(var(--warning-strong))]"
        role="status"
        aria-live="polite"
      >
        有尚未保存的修改
      </p>

      <section aria-labelledby="notification-metrics-title">
        <h3 id="notification-metrics-title" class="text-sm font-semibold text-[rgb(var(--fg))]">接收哪些提醒</h3>
        <p class="mt-0.5 text-xs text-[rgb(var(--muted))]">
          关闭某一项后，不再产生该类页面提醒{{ qqNotifyEnabled ? '，站内与 QQ 渠道都不会收到' : '' }}。
        </p>
        <div class="mt-3 divide-y divide-[rgb(var(--panel-border))] rounded-lg border border-[rgb(var(--panel-border))]">
          <label
            v-for="metric in ALERT_METRICS"
            :key="metric"
            :for="`notification-metric-${metric}`"
            class="flex cursor-pointer items-start gap-3 p-3"
            :class="{ 'cursor-not-allowed opacity-60': !canEdit }"
          >
            <input
              :id="`notification-metric-${metric}`"
              type="checkbox"
              class="mt-0.5 h-4 w-4 rounded border-[rgb(var(--input-border))]"
              :checked="!draft.mutedMetrics[metric]"
              :disabled="!canEdit"
              @change="toggleMuted(metric, !($event.target as HTMLInputElement).checked)"
            >
            <span class="min-w-0">
              <span class="block text-sm text-[rgb(var(--fg))]">{{ METRIC_LABEL[metric].title }}</span>
              <span class="block text-xs text-[rgb(var(--muted))]">{{ METRIC_LABEL[metric].hint }}</span>
            </span>
          </label>
        </div>
      </section>

      <section aria-labelledby="notification-conditions-title">
        <h3 id="notification-conditions-title" class="text-sm font-semibold text-[rgb(var(--fg))]">触发条件</h3>
        <div class="mt-3 space-y-5 rounded-lg border border-[rgb(var(--panel-border))] p-4">
          <div>
            <label for="vote-threshold" class="block text-sm text-[rgb(var(--fg))]">票数变化阈值</label>
            <p id="vote-threshold-hint" class="mt-0.5 text-xs text-[rgb(var(--muted))]">
              累计变化达到这个数值才提醒一次，避免每一票都打扰你。
            </p>
            <div class="mt-2 flex items-center gap-2">
              <input
                id="vote-threshold"
                v-model.number="draft.voteCountThreshold"
                type="number"
                min="1"
                max="1000"
                step="1"
                class="min-h-11 w-28 rounded-lg border border-[rgb(var(--input-border))] bg-[rgb(var(--input-bg))] px-3 py-2 text-sm"
                :disabled="!canEdit"
                :aria-invalid="!thresholdValid"
                aria-describedby="vote-threshold-hint vote-threshold-error"
              >
              <span class="text-xs text-[rgb(var(--muted))]">票</span>
            </div>
            <p
              id="vote-threshold-error"
              class="mt-1 min-h-4 text-xs text-[rgb(var(--danger-strong))]"
              aria-live="polite"
            >
              {{ thresholdValid ? '' : '请输入 1 到 1000 之间的整数。' }}
            </p>
          </div>

          <fieldset>
            <legend class="text-sm text-[rgb(var(--fg))]">页面编辑提醒范围</legend>
            <div class="mt-2 space-y-2">
              <label
                v-for="option in REVISION_OPTIONS"
                :key="option.value"
                :for="`revision-filter-${option.value}`"
                class="flex cursor-pointer items-start gap-2"
                :class="{ 'cursor-not-allowed opacity-60': !canEdit }"
              >
                <input
                  :id="`revision-filter-${option.value}`"
                  v-model="draft.revisionFilter"
                  type="radio"
                  name="revision-filter"
                  :value="option.value"
                  class="mt-0.5 h-4 w-4 border-[rgb(var(--input-border))]"
                  :disabled="!canEdit"
                >
                <span>
                  <span class="block text-sm text-[rgb(var(--fg))]">{{ option.label }}</span>
                  <span class="block text-xs text-[rgb(var(--muted))]">{{ option.hint }}</span>
                </span>
              </label>
            </div>
          </fieldset>

          <label
            for="ignore-self-revision"
            class="flex cursor-pointer items-start gap-2"
            :class="{ 'cursor-not-allowed opacity-60': !canEdit }"
          >
            <input
              id="ignore-self-revision"
              v-model="draft.ignoreLinkedWikidotSelfRevision"
              type="checkbox"
              class="mt-0.5 h-4 w-4 rounded border-[rgb(var(--input-border))]"
              :disabled="!canEdit"
            >
            <span>
              <span class="block text-sm text-[rgb(var(--fg))]">忽略我自己账号的修订</span>
              <span class="block text-xs text-[rgb(var(--muted))]">使用已连接的 Wikidot 身份判断</span>
            </span>
          </label>

          <div class="flex flex-wrap items-center gap-3 pt-1">
            <button
              type="button"
              class="inline-flex min-h-11 items-center rounded-lg bg-[rgb(var(--accent))] px-4 text-sm font-semibold text-white hover:bg-[rgb(var(--accent-strong))] disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="!canEdit || !dirty || !thresholdValid"
              @click="saveGeneration"
            >
              {{ panelState === 'saving' ? '保存中…' : '保存修改' }}
            </button>
            <button
              type="button"
              class="inline-flex min-h-11 items-center rounded-lg border border-[rgb(var(--panel-border))] px-4 text-sm font-semibold text-[rgb(var(--muted-strong))] hover:text-[rgb(var(--accent))] disabled:cursor-not-allowed disabled:opacity-50"
              :disabled="isBusy || !dirty"
              @click="resetDraft"
            >
              撤销修改
            </button>
            <span
              v-if="savedMessage"
              class="text-xs text-[rgb(var(--success-strong))]"
              role="status"
              aria-live="polite"
            >
              {{ savedMessage }}
            </span>
          </div>
        </div>
      </section>

      <section v-if="qqNotifyEnabled" aria-labelledby="notification-channels-title">
        <h3 id="notification-channels-title" class="text-sm font-semibold text-[rgb(var(--fg))]">推送渠道</h3>
        <p class="mt-0.5 text-xs text-[rgb(var(--muted))]">
          站内提醒始终开启。仅当服务端确认 QQ 投递能力可用时，才会额外发送私信。
        </p>
        <div class="mt-3 space-y-2 rounded-lg border border-[rgb(var(--panel-border))] p-4">
          <div class="flex items-center gap-2 text-sm text-[rgb(var(--fg))]">
            <span class="inline-block h-2 w-2 rounded-full bg-[rgb(var(--success))]" aria-hidden="true" />
            站内提醒
            <span class="text-xs text-[rgb(var(--muted))]">（始终开启）</span>
          </div>
          <div class="flex flex-wrap items-center gap-2 text-sm">
            <span
              class="inline-block h-2 w-2 rounded-full"
              :class="qqActive ? 'bg-[rgb(var(--success))]' : (qqFeaturePaused || qqPaused) ? 'bg-[rgb(var(--warning))]' : 'bg-[rgb(var(--slate-400))]'"
              aria-hidden="true"
            />
            <span class="text-[rgb(var(--fg))]">QQ 私信</span>
            <span v-if="qqBound" class="font-mono text-xs text-[rgb(var(--muted))]">{{ qqMask }}</span>
            <span v-if="qqFeaturePaused" class="text-xs text-[rgb(var(--warning-strong))]">
              功能暂停（当前不会通过 QQ 投递）
            </span>
            <span v-else-if="qqPaused" class="text-xs text-[rgb(var(--warning-strong))]">
              已暂停（连续投递失败，请确认机器人仍是好友后重新连接）
            </span>
            <span v-else-if="!qqBound" class="text-xs text-[rgb(var(--muted))]">未连接</span>
            <NuxtLink
              v-if="!qqBound && qqFeatureAvailable"
              to="/account/connections"
              class="ml-auto inline-flex min-h-11 items-center text-xs font-semibold text-[var(--g-accent)] hover:underline"
            >
              去连接 →
            </NuxtLink>
          </div>
          <p v-if="qqActive" class="pt-1 text-[11px] text-[rgb(var(--muted))]">
            QQ 推送按整点同步周期汇总发送，通常在事件发生后一小时内送达。
          </p>
          <p v-else class="pt-1 text-[11px] text-[rgb(var(--muted))]">
            当前未确认 QQ 投递能力；站内提醒不受影响。
          </p>
        </div>
      </section>
    </template>

    <div
      v-else
      class="rounded-lg border border-[rgb(var(--danger))]/30 bg-[rgb(var(--danger))]/10 p-5 text-sm text-[rgb(var(--danger-strong))]"
      role="alert"
    >
      设置状态不可用。请
      <button type="button" class="font-semibold underline" @click="loadPreferences">重新加载</button>。
    </div>
  </div>
</template>
