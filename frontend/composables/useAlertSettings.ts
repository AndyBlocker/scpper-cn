import { useNuxtApp } from 'nuxt/app';
import type { AlertMetric } from './useAlerts';

export type RevisionFilterOption = 'ANY' | 'NON_OWNER' | 'NON_OWNER_NO_ATTR';

export interface AlertPreferencesPayload {
  voteCountThreshold: number;
  revisionFilter: RevisionFilterOption;
  ignoreLinkedWikidotSelfRevision?: boolean;
  mutedMetrics?: Partial<Record<AlertMetric, boolean>>;
}

interface AlertPreferencesResponse {
  ok: boolean;
  preferences?: AlertPreferencesPayload;
  error?: string;
}

interface UpdatePreferencesResponse extends AlertPreferencesResponse {}

export interface AlertPreferences {
  voteCountThreshold: number;
  revisionFilter: RevisionFilterOption;
  ignoreLinkedWikidotSelfRevision: boolean;
  mutedMetrics: Record<AlertMetric, boolean>;
}

export interface AlertPreferencesResult {
  preferences: AlertPreferences;
  identityEpoch: number;
}

/**
 * 请求发出后身份或请求世代发生了变化。调用方必须把它当作失败处理，
 * 不能读取当前 useState 中的默认值并假装它来自服务端。
 */
export class AlertSettingsSupersededError extends Error {
  readonly code = 'ALERT_SETTINGS_SUPERSEDED';

  constructor() {
    super('提醒设置请求已被新的身份或请求取代');
    this.name = 'AlertSettingsSupersededError';
  }
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

function normalisePreferences(preferences?: AlertPreferencesPayload | null): AlertPreferences {
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
  // 多个 useAlertSettings() 调用共享同一份偏好，也必须共享同一份结果错误。
  // 否则 layout 里的 resetState 与面板实例会各自看到不同的 error。
  const error = useState<string | null>('alerts/preferencesError', () => null);
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

  function beginOperation(kind: 'load' | 'save') {
    const request = requestGeneration.value + 1;
    requestGeneration.value = request;
    loading.value = kind === 'load';
    saving.value = kind === 'save';
    error.value = null;
    return {
      epoch: identityEpoch.value,
      request
    };
  }

  function assertCurrent(epoch: number, request: number) {
    if (identityEpoch.value !== epoch || requestGeneration.value !== request) {
      throw new AlertSettingsSupersededError();
    }
  }

  function resultFromConfirmed(
    confirmed: AlertPreferences,
    epoch: number
  ): AlertPreferencesResult {
    return {
      // 返回独立快照，避免后续共享 useState 写入改变调用方刚确认的结果。
      preferences: normalisePreferences(confirmed),
      identityEpoch: epoch
    };
  }

  function handleOperationError(
    err: unknown,
    epoch: number,
    request: number,
    fallback: string
  ): never {
    if (err instanceof AlertSettingsSupersededError) {
      throw err;
    }
    if (identityEpoch.value !== epoch || requestGeneration.value !== request) {
      throw new AlertSettingsSupersededError();
    }
    const message = err instanceof Error && err.message
      ? err.message
      : fallback;
    error.value = message;
    throw err instanceof Error ? err : new Error(message);
  }

  async function fetchPreferences(): Promise<AlertPreferencesResult> {
    const operation = beginOperation('load');
    try {
      const res = await $bff<AlertPreferencesResponse>('/alerts/preferences', { method: 'GET' });
      // 期间换过身份 / 已有更新的请求 → 显式失败，绝不返回 reset 后的默认值。
      assertCurrent(operation.epoch, operation.request);
      if (res?.ok && res.preferences) {
        const confirmed = normalisePreferences(res.preferences);
        preferences.value = confirmed;
        return resultFromConfirmed(confirmed, operation.epoch);
      }
      // 无法确认服务端数据时保留上一次快照。若在这里写入本地默认值，
      // 设置面板会把“读取失败”误判成一份真实偏好，用户下一次保存就可能
      // 覆盖原有配置。
      throw new Error(res?.error || '加载提醒设置失败');
    } catch (err) {
      if (!(err instanceof AlertSettingsSupersededError)) {
        console.warn('[alerts] load preferences failed', err);
      }
      return handleOperationError(
        err,
        operation.epoch,
        operation.request,
        '加载提醒设置失败'
      );
    } finally {
      if (
        identityEpoch.value === operation.epoch
        && requestGeneration.value === operation.request
      ) {
        loading.value = false;
      }
    }
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

  async function updatePreferences(
    payload: Partial<AlertPreferencesPayload>
  ): Promise<AlertPreferencesResult> {
    if (!payload || Object.keys(payload).length === 0) {
      throw new Error('没有需要保存的提醒设置');
    }
    const operation = beginOperation('save');
    // 保存的响应同样是一次共享状态写入：A 的保存请求在 B 登录后才返回的话，
    // 会把 A 的偏好显示在 B 的设置面板上。
    try {
      const res = await $bff<UpdatePreferencesResponse>('/alerts/preferences', {
        method: 'POST',
        body: payload
      });
      assertCurrent(operation.epoch, operation.request);
      if (res?.ok && res.preferences) {
        const confirmed = normalisePreferences(res.preferences);
        preferences.value = confirmed;
        return resultFromConfirmed(confirmed, operation.epoch);
      }
      throw new Error(res?.error || '保存提醒设置失败');
    } catch (err) {
      if (!(err instanceof AlertSettingsSupersededError)) {
        console.warn('[alerts] update preferences failed', err);
      }
      return handleOperationError(
        err,
        operation.epoch,
        operation.request,
        '保存提醒设置失败'
      );
    } finally {
      if (
        identityEpoch.value === operation.epoch
        && requestGeneration.value === operation.request
      ) {
        saving.value = false;
      }
    }
  }

  async function setMetricMuted(
    metric: AlertMetric,
    muted: boolean
  ): Promise<AlertPreferencesResult> {
    const operation = beginOperation('save');
    // 同 updatePreferences：换过账号就不要把结果写进共享状态
    try {
      const res = await $bff<UpdatePreferencesResponse>('/alerts/preferences/mute', {
        method: 'POST',
        body: { metric, muted }
      });
      assertCurrent(operation.epoch, operation.request);
      if (res?.ok && res.preferences) {
        const confirmed = normalisePreferences(res.preferences);
        preferences.value = confirmed;
        return resultFromConfirmed(confirmed, operation.epoch);
      }
      throw new Error(res?.error || '保存提醒设置失败');
    } catch (err) {
      if (!(err instanceof AlertSettingsSupersededError)) {
        console.warn('[alerts] update mute preference failed', err);
      }
      return handleOperationError(
        err,
        operation.epoch,
        operation.request,
        '保存提醒设置失败'
      );
    } finally {
      if (
        identityEpoch.value === operation.epoch
        && requestGeneration.value === operation.request
      ) {
        saving.value = false;
      }
    }
  }

  return {
    preferences,
    loading,
    saving,
    error,
    identityEpoch,
    fetchPreferences,
    resetState,
    updatePreferences,
    setMetricMuted
  };
}
