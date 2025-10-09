import { ref } from 'vue';
import { useNuxtApp } from 'nuxt/app';
import type { AlertMetric } from './useAlerts';

export type RevisionFilterOption = 'ANY' | 'NON_OWNER' | 'NON_OWNER_NO_ATTR';

interface AlertPreferencesResponse {
  ok: boolean;
  preferences: {
    voteCountThreshold: number;
    revisionFilter: RevisionFilterOption;
    mutedMetrics?: Partial<Record<AlertMetric, boolean>>;
  };
}

interface UpdatePreferencesResponse extends AlertPreferencesResponse {}

interface AlertPreferences {
  voteCountThreshold: number;
  revisionFilter: RevisionFilterOption;
  mutedMetrics: Record<AlertMetric, boolean>;
}

const DEFAULT_MUTED_METRICS: Record<AlertMetric, boolean> = {
  COMMENT_COUNT: false,
  VOTE_COUNT: false,
  RATING: false,
  REVISION_COUNT: false,
  SCORE: false
};

function createDefaultPreferences(): AlertPreferences {
  return {
    voteCountThreshold: 20,
    revisionFilter: 'ANY',
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
    ? Math.round(voteCount)
    : fallback.voteCountThreshold;

  const revisionFilter: RevisionFilterOption = (preferences.revisionFilter ?? fallback.revisionFilter) as RevisionFilterOption;

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
    mutedMetrics
  };
}

export function useAlertSettings() {
  const { $bff } = useNuxtApp();
  const preferences = useState<AlertPreferences>('alerts/preferences', () => createDefaultPreferences());
  const loading = useState('alerts/preferencesLoading', () => false);
  const saving = useState('alerts/preferencesSaving', () => false);
  const error = ref<string | null>(null);

  async function fetchPreferences(force = false) {
    if (loading.value && !force) return preferences.value;
    loading.value = true;
    error.value = null;
    try {
      const res = await $bff<AlertPreferencesResponse>('/alerts/preferences', { method: 'GET' });
      if (res?.ok && res.preferences) {
        preferences.value = normalisePreferences(res.preferences);
      } else {
        preferences.value = createDefaultPreferences();
      }
    } catch (err) {
      console.warn('[alerts] load preferences failed', err);
      error.value = '加载提醒设置失败';
    } finally {
      loading.value = false;
    }
    return preferences.value;
  }

  async function updatePreferences(payload: Partial<AlertPreferencesResponse['preferences']>) {
    if (!payload || Object.keys(payload).length === 0) return preferences.value;
    saving.value = true;
    error.value = null;
    try {
      const res = await $bff<UpdatePreferencesResponse>('/alerts/preferences', {
        method: 'POST',
        body: payload
      });
      if (res?.ok && res.preferences) {
        preferences.value = normalisePreferences(res.preferences);
      }
    } catch (err) {
      console.warn('[alerts] update preferences failed', err);
      error.value = '保存提醒设置失败';
      throw err;
    } finally {
      saving.value = false;
    }
    return preferences.value;
  }

  async function setMetricMuted(metric: AlertMetric, muted: boolean) {
    saving.value = true;
    error.value = null;
    try {
      const res = await $bff<UpdatePreferencesResponse>('/alerts/preferences/mute', {
        method: 'POST',
        body: { metric, muted }
      });
      if (res?.ok && res.preferences) {
        preferences.value = normalisePreferences(res.preferences);
      }
    } catch (err) {
      console.warn('[alerts] update mute preference failed', err);
      error.value = '保存提醒设置失败';
      throw err;
    } finally {
      saving.value = false;
    }
    return preferences.value;
  }

  return {
    preferences,
    loading,
    saving,
    error,
    fetchPreferences,
    updatePreferences,
    setMetricMuted
  };
}
