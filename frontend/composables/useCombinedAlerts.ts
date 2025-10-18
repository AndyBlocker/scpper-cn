import { useNuxtApp } from 'nuxt/app';
import { computed } from 'vue';
import type { AlertMetric, AlertItem } from './useAlerts';

export interface CombinedAlertGroup {
  pageId: number;
  pageWikidotId: number | null;
  pageUrl: string | null;
  pageTitle: string | null;
  pageAlternateTitle: string | null;
  updatedAt: string;
  alerts: AlertItem[];
}

interface CombinedAlertsResponse {
  ok: boolean;
  total?: number;
  groups: CombinedAlertGroup[];
}

interface BatchReadResponse {
  ok: boolean;
  updated: number;
  ids: number[];
}

export function useCombinedAlerts() {
  const { $bff } = useNuxtApp();
  const groups = useState<CombinedAlertGroup[]>('alerts/combined/groups', () => []);
  const loading = useState<boolean>('alerts/combined/loading', () => false);
  const lastFetchedAt = useState<string | null>('alerts/combined/lastFetchedAt', () => null);

  async function fetchCombined(limit = 20, offset = 0, force = false) {
    if (loading.value) return groups.value;
    if (!force && lastFetchedAt.value) {
      const last = new Date(lastFetchedAt.value).getTime();
      if (Date.now() - last < 60_000) return groups.value;
    }
    loading.value = true;
    try {
      const res = await $bff<CombinedAlertsResponse>('/alerts/combined', { method: 'GET', params: { limit, offset } });
      if (res?.ok && Array.isArray(res.groups)) {
        groups.value = res.groups;
        lastFetchedAt.value = new Date().toISOString();
      } else {
        groups.value = [];
        lastFetchedAt.value = null;
      }
    } catch (error) {
      console.warn('[combined-alerts] fetch failed', error);
      groups.value = [];
      lastFetchedAt.value = null;
    } finally {
      loading.value = false;
    }
    return groups.value;
  }

  async function markBatchRead(ids: number[]) {
    if (!ids || ids.length === 0) return 0;
    try {
      const res = await $bff<BatchReadResponse>('/alerts/read-batch', { method: 'POST', body: { ids } });
      if (res?.ok) {
        const idSet = new Set(res.ids);
        const nextGroups: CombinedAlertGroup[] = [];
        for (const g of groups.value) {
          const remaining = g.alerts.filter(a => !idSet.has(a.id));
          if (remaining.length > 0) {
            nextGroups.push({ ...g, alerts: remaining });
          }
        }
        groups.value = nextGroups;
        return res.updated || 0;
      }
    } catch (error) {
      console.warn('[combined-alerts] batch read failed', error);
    }
    return 0;
  }

  const totalUnread = computed(() => groups.value.reduce((acc, g) => acc + (Array.isArray(g.alerts) ? g.alerts.length : 0), 0));

  return {
    groups,
    loading,
    lastFetchedAt,
    fetchCombined,
    markBatchRead,
    totalUnread
  };
}
