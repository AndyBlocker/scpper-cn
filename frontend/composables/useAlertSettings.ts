import { ref } from 'vue';
import { useNuxtApp } from 'nuxt/app';
import type { AlertMetric } from './useAlerts';

export type RevisionFilterOption = 'ANY' | 'NON_OWNER' | 'NON_OWNER_NO_ATTR';

interface AlertPreferencesResponse {
  ok: boolean;
  preferences: {
    voteCountThreshold: number;
    revisionFilter: RevisionFilterOption;
    ignoreLinkedWikidotSelfRevision?: boolean;
    mutedMetrics?: Partial<Record<AlertMetric, boolean>>;
  };
}

interface UpdatePreferencesResponse extends AlertPreferencesResponse {}

interface AlertPreferences {
  voteCountThreshold: number;
  revisionFilter: RevisionFilterOption;
  ignoreLinkedWikidotSelfRevision: boolean;
  mutedMetrics: Record<AlertMetric, boolean>;
}

// RATING / SCORE 已从 AlertMetric 移除：PageMetricMonitorJob 从不产生它们
// （生产库 0 行），BFF 的 MUTABLE_METRICS 也只认这三个 —— 之前渲染出来的
// 那两个静音开关一旦被点，后端会直接 400。
const DEFAULT_MUTED_METRICS: Record<AlertMetric, boolean> = {
  COMMENT_COUNT: false,
  VOTE_COUNT: false,
  REVISION_COUNT: false
};

function createDefaultPreferences(): AlertPreferences {
  return {
    voteCountThreshold: 20,
    revisionFilter: 'ANY',
    ignoreLinkedWikidotSelfRevision: true,
    mutedMetrics: { ...DEFAULT_MUTED_METRICS }
  };
}

function normalisePreferences(preferences?: AlertPreferencesResponse['preferences'] | null): AlertPreferences {
  const fallback = createDefaultPreferences();
  if (!preferences) {
    return fallback;
  }

  const voteCount = Number(preferences.voteCountThreshold);
  const voteCountThreshold = Number.isFinite(voteCount) && voteCount > 0
    ? Math.min(1000, Math.round(voteCount))
    : fallback.voteCountThreshold;

  const revisionFilter: RevisionFilterOption = (preferences.revisionFilter ?? fallback.revisionFilter) as RevisionFilterOption;
  const ignoreLinkedWikidotSelfRevision = typeof preferences.ignoreLinkedWikidotSelfRevision === 'boolean'
    ? preferences.ignoreLinkedWikidotSelfRevision
    : fallback.ignoreLinkedWikidotSelfRevision;

  const mutedMetrics: Record<AlertMetric, boolean> = { ...DEFAULT_MUTED_METRICS };
  if (preferences.mutedMetrics && typeof preferences.mutedMetrics === 'object') {
    for (const [key, value] of Object.entries(preferences.mutedMetrics)) {
      const metricKey = key as AlertMetric;
      if (metricKey in mutedMetrics && typeof value === 'boolean') {
        mutedMetrics[metricKey] = value;
      }
    }
  }

  return {
    voteCountThreshold,
    revisionFilter,
    ignoreLinkedWikidotSelfRevision,
    mutedMetrics
  };
}

export function useAlertSettings() {
  const { $bff } = useNuxtApp();
  const preferences = useState<AlertPreferences>('alerts/preferences', () => createDefaultPreferences());
  const loading = useState('alerts/preferencesLoading', () => false);
  const saving = useState('alerts/preferencesSaving', () => false);
  const error = ref<string | null>(null);
  /**
   * 身份世代号。三个提醒 composable 早就有这个守卫，唯独这里漏了 ——
   * A 的偏好请求还在飞时用户登出、B 在同一标签页登录：
   * 共享的 loading 让 B 跳过自己的取数，随后 A 的响应无守卫地写进
   * 全局 preferences，于是 B 看到的是 A 的设置，一保存就把 A 的值
   * 写进了自己的账号。
   */
  const identityEpoch = useState<number>('alerts/preferencesEpoch', () => 0);
  /** 请求世代：同账号内的并发请求也要保证只有最新一次能写回 */
  const requestGeneration = useState<number>('alerts/preferencesReqGen', () => 0);

  async function fetchPreferences(force = false) {
    if (loading.value && !force) return preferences.value;
    loading.value = true;
    error.value = null;
    const myEpoch = identityEpoch.value;
    const myRequest = requestGeneration.value + 1;
    requestGeneration.value = myRequest;
    try {
      const res = await $bff<AlertPreferencesResponse>('/alerts/preferences', { method: 'GET' });
      // 期间换过身份 / 已有更新的请求 → 本次结果作废，绝不写回共享状态
      if (identityEpoch.value !== myEpoch || requestGeneration.value !== myRequest) {
        return preferences.value;
      }
      if (res?.ok && res.preferences) {
        preferences.value = normalisePreferences(res.preferences);
      } else {
        preferences.value = createDefaultPreferences();
      }
    } catch (err) {
      console.warn('[alerts] load preferences failed', err);
      if (identityEpoch.value === myEpoch && requestGeneration.value === myRequest) {
        error.value = '加载提醒设置失败';
      }
    } finally {
      if (requestGeneration.value === myRequest) loading.value = false;
    }
    return preferences.value;
  }

  /** 换账号时清空并作废在途请求，否则 B 会看到 A 的偏好 */
  function resetState() {
    identityEpoch.value += 1;
    requestGeneration.value += 1;
    preferences.value = createDefaultPreferences();
    loading.value = false;
    saving.value = false;
    error.value = null;
  }

  async function updatePreferences(payload: Partial<AlertPreferencesResponse['preferences']>) {
    if (!payload || Object.keys(payload).length === 0) return preferences.value;
    saving.value = true;
    error.value = null;
    // 保存的响应同样是一次共享状态写入：A 的保存请求在 B 登录后才返回的话，
    // 会把 A 的偏好显示在 B 的设置面板上。
    const epochAtStart = identityEpoch.value;
    try {
      const res = await $bff<UpdatePreferencesResponse>('/alerts/preferences', {
        method: 'POST',
        body: payload
      });
      if (res?.ok && res.preferences && identityEpoch.value === epochAtStart) {
        preferences.value = normalisePreferences(res.preferences);
      }
    } catch (err) {
      console.warn('[alerts] update preferences failed', err);
      if (identityEpoch.value === epochAtStart) error.value = '保存提醒设置失败';
      throw err;
    } finally {
      if (identityEpoch.value === epochAtStart) saving.value = false;
    }
    return preferences.value;
  }

  async function setMetricMuted(metric: AlertMetric, muted: boolean) {
    saving.value = true;
    error.value = null;
    // 同 updatePreferences：换过账号就不要把结果写进共享状态
    const epochAtStart = identityEpoch.value;
    try {
      const res = await $bff<UpdatePreferencesResponse>('/alerts/preferences/mute', {
        method: 'POST',
        body: { metric, muted }
      });
      if (res?.ok && res.preferences && identityEpoch.value === epochAtStart) {
        preferences.value = normalisePreferences(res.preferences);
      }
    } catch (err) {
      console.warn('[alerts] update mute preference failed', err);
      if (identityEpoch.value === epochAtStart) error.value = '保存提醒设置失败';
      throw err;
    } finally {
      if (identityEpoch.value === epochAtStart) saving.value = false;
    }
    return preferences.value;
  }

  return {
    preferences,
    loading,
    saving,
    error,
    fetchPreferences,
    resetState,
    updatePreferences,
    setMetricMuted
  };
}
