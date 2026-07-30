<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { AuthUser } from '~/composables/useAuth'
import { useQqNotifyEnabled } from '~/composables/useQqNotifyEnabled'

const props = defineProps<{
  user: AuthUser
}>()

const frontendQqEnabled = useQqNotifyEnabled()
const qqCapabilities = computed(() => props.user.qqBinding?.capabilities)
// 服务端 capability 是“既有绑定此刻是否会投递”的权威；前端开关决定整个
// QQ 管理区是否可见，并作为新建入口的第二道闸门。
const qqServerFeatureEnabled = computed(() => Boolean(
  qqCapabilities.value?.featureEnabled
))
const allowNewQqBinding = computed(() => (
  frontendQqEnabled.value
  && qqServerFeatureEnabled.value
  && Boolean(qqCapabilities.value?.createBinding)
))
const hasQqCleanupWork = computed(() => (
  Boolean(props.user.qqBinding?.bound)
  || Boolean(props.user.qqBinding?.pendingChallenge)
  || Boolean(qqCapabilities.value?.manageExistingBinding)
))

// 解绑或取消会先刷新 /auth/me。父级摘要因此会在 child 写入成功提示前
// 变成“无绑定”，如果直接用一个纯 computed v-if，整个 child 会被卸载，
// 刚得到的终态提示也随之丢失。只要本次页面生命周期曾展示过管理区，
// 就保留到用户离开页面；它不会跨账号或跨路由持久化。
const retainQqManagement = ref(false)
watch(
  () => frontendQqEnabled.value && (
    hasQqCleanupWork.value || allowNewQqBinding.value
  ),
  visible => {
    if (visible) retainQqManagement.value = true
  },
  { immediate: true }
)

const showQqManagement = computed(() => (
  frontendQqEnabled.value
  && (
    retainQqManagement.value
    || hasQqCleanupWork.value
    || allowNewQqBinding.value
  )
))
</script>

<template>
  <div class="space-y-6">
    <section class="rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))] p-5 shadow-sm sm:p-6">
      <div class="flex items-start justify-between gap-4">
        <div class="flex min-w-0 items-start gap-3">
          <span class="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[var(--g-accent-soft)] text-[var(--g-accent)]">
            <LucideIcon
              name="ExternalLink"
              class="h-5 w-5"
              stroke-width="1.8"
              aria-hidden="true"
            />
          </span>
          <div>
            <h2 class="text-lg font-semibold text-[rgb(var(--fg))]">Wikidot 身份</h2>
            <p class="mt-1 text-sm leading-6 text-[rgb(var(--muted))]">
              连接后，SCPPER-CN 可以确认你的作者身份，并为关注、收藏夹等个人功能提供一致的账号归属。
            </p>
          </div>
        </div>
        <span
          class="inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium"
          :class="user.linkedWikidotId
            ? 'border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200'
            : 'border-[rgb(var(--panel-border))] bg-[rgb(var(--bg))] text-[rgb(var(--muted))]'"
        >
          <LucideIcon
            :name="user.linkedWikidotId ? 'CircleCheck' : 'CircleDashed'"
            class="h-3.5 w-3.5"
            aria-hidden="true"
          />
          {{ user.linkedWikidotId ? '已连接' : '未连接' }}
        </span>
      </div>

      <div
        v-if="user.linkedWikidotId"
        class="mt-5 rounded-lg border border-[rgb(var(--panel-border))] bg-[rgb(var(--bg))] p-4"
      >
        <dl class="sm:flex sm:items-center sm:justify-between sm:gap-4">
          <div>
            <dt class="text-xs font-medium text-[rgb(var(--muted))]">Wikidot ID</dt>
            <dd class="mt-1 font-mono text-sm font-semibold text-[rgb(var(--fg))]">
              {{ user.linkedWikidotId }}
            </dd>
          </div>
          <NuxtLink
            :to="`/user/${user.linkedWikidotId}`"
            class="mt-3 inline-flex min-h-10 items-center gap-1 text-sm font-medium text-[var(--g-accent)] underline-offset-4 hover:underline sm:mt-0"
          >
            查看作者页
            <LucideIcon
              name="ArrowUpRight"
              class="h-4 w-4"
              aria-hidden="true"
            />
          </NuxtLink>
        </dl>
      </div>

      <div
        v-else
        class="mt-5"
      >
        <WikidotBindingPanel />
      </div>
    </section>

    <section
      v-if="showQqManagement"
      class="rounded-lg border p-5 shadow-sm sm:p-6"
      :class="qqServerFeatureEnabled
        ? 'border-[rgb(var(--panel-border))] bg-[rgb(var(--panel))]'
        : 'border-amber-300/70 bg-amber-50/50 dark:border-amber-900/60 dark:bg-amber-950/20'"
    >
      <header class="mb-5">
        <div class="flex items-center gap-2">
          <LucideIcon
            :name="qqServerFeatureEnabled ? 'MessageCircle' : 'PauseCircle'"
            class="h-5 w-5"
            :class="qqServerFeatureEnabled
              ? 'text-[var(--g-accent)]'
              : 'text-amber-700 dark:text-amber-300'"
            aria-hidden="true"
          />
          <h2 class="text-lg font-semibold text-[rgb(var(--fg))]">QQ 连接</h2>
        </div>
        <p class="mt-2 text-sm leading-6 text-[rgb(var(--muted))]">
          <template v-if="!qqServerFeatureEnabled">
            QQ 功能目前暂停。这里只保留已有连接或未完成任务的清理入口，不会创建新的绑定。
          </template>
          <template v-else>
            管理 QQ 连接状态。
          </template>
        </p>
      </header>
      <QqBindingPanel
        :summary-bound="user.qqBinding?.bound"
        :summary-address-mask="user.qqBinding?.addressMask"
        :summary-pending-challenge="user.qqBinding?.pendingChallenge"
        :allow-new-binding="allowNewQqBinding"
        :feature-enabled="qqServerFeatureEnabled"
        :delivery-enabled="qqCapabilities?.deliverNotifications"
      />
    </section>
  </div>
</template>
