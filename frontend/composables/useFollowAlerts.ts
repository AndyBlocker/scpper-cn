import { useNuxtApp } from 'nuxt/app';
import { computed } from 'vue';

export type FollowAlertType = 'REVISION' | 'ATTRIBUTION';

export interface FollowAlertItem {
  id: number;
  type: FollowAlertType;
  detectedAt: string;
  acknowledgedAt: string | null;
  pageId: number;
  pageWikidotId: number | null;
  pageUrl: string | null;
  pageTitle: string | null;
  pageAlternateTitle: string | null;
  targetUserId: number;
}

export interface FollowCombinedGroup {
  pageId: number;
  pageWikidotId: number | null;
  pageUrl: string | null;
  pageTitle: string | null;
  pageAlternateTitle: string | null;
  updatedAt: string;
  alerts: FollowAlertItem[];
}

export function useFollowAlerts() {
  const { $bff } = useNuxtApp();
  const alerts = useState<FollowAlertItem[]>('followAlerts/list', () => []);
  const unreadCount = useState<number>('followAlerts/unread', () => 0);
  const loading = useState<boolean>('followAlerts/loading', () => false);
  const lastFetchedAt = useState<string | null>('followAlerts/lastFetchedAt', () => null);

  const combined = useState<FollowCombinedGroup[]>('followAlerts/combined', () => []);
  const combinedLoading = useState<boolean>('followAlerts/combinedLoading', () => false);
  const combinedLastFetchedAt = useState<string | null>('followAlerts/combinedLastFetchedAt', () => null);

  async function fetchAlerts(force = false, limit = 20, offset = 0) {
    if (loading.value && !force) return alerts.value;
    if (!force && lastFetchedAt.value) {
      const last = new Date(lastFetchedAt.value).getTime();
      if (Date.now() - last < 60_000) return alerts.value;
    }
    loading.value = true;
    try {
      const res = await $bff<{ ok: boolean; alerts: FollowAlertItem[]; unreadCount: number }>(
        '/alerts/follow', { method: 'GET', params: { limit, offset } }
      );
      if (res?.ok) {
        alerts.value = Array.isArray(res.alerts) ? res.alerts : [];
        unreadCount.value = Number.isFinite(res.unreadCount) ? res.unreadCount : 0;
        lastFetchedAt.value = new Date().toISOString();
      } else {
        alerts.value = [];
        unreadCount.value = 0;
        lastFetchedAt.value = null;
      }
    } catch (e) {
      console.warn('[follow-alerts] fetch failed', e);
      alerts.value = [];
      unreadCount.value = 0;
      lastFetchedAt.value = null;
    } finally {
      loading.value = false;
    }
    return alerts.value;
  }

  async function fetchCombined(force = false, limit = 20, offset = 0) {
    if (combinedLoading.value && !force) return combined.value;
    if (!force && combinedLastFetchedAt.value) {
      const last = new Date(combinedLastFetchedAt.value).getTime();
      if (Date.now() - last < 60_000) return combined.value;
    }
    combinedLoading.value = true;
    try {
      const res = await $bff<{ ok: boolean; total?: number; groups: FollowCombinedGroup[] }>(
        '/alerts/follow/combined', { method: 'GET', params: { limit, offset } }
      );
      if (res?.ok) {
        combined.value = Array.isArray(res.groups) ? res.groups : [];
        combinedLastFetchedAt.value = new Date().toISOString();
      } else {
        combined.value = [];
        combinedLastFetchedAt.value = null;
      }
    } catch (e) {
      console.warn('[follow-alerts] combined fetch failed', e);
      combined.value = [];
      combinedLastFetchedAt.value = null;
    } finally {
      combinedLoading.value = false;
    }
    return combined.value;
  }

  async function markRead(id: number) {
    try {
      const res = await $bff<{ ok: boolean; id: number; acknowledgedAt: string | null }>(`/alerts/follow/${id}/read`, { method: 'POST' });
      if (res?.ok) {
        const idx = alerts.value.findIndex(a => a.id === id);
        if (idx >= 0) alerts.value[idx].acknowledgedAt = res.acknowledgedAt ?? new Date().toISOString();
        // Update combined cache
        const nextGroups: FollowCombinedGroup[] = [];
        for (const g of combined.value) {
          const remaining = g.alerts.filter(a => a.id !== id);
          if (remaining.length > 0) nextGroups.push({ ...g, alerts: remaining });
        }
        combined.value = nextGroups;
        unreadCount.value = Math.max(0, (unreadCount.value || 0) - 1);
      }
    } catch (e) {
      console.warn('[follow-alerts] mark read failed', e);
    }
  }

  async function markAllRead() {
    try {
      const res = await $bff<{ ok: boolean; updated: number }>('/alerts/follow/read-all', { method: 'POST' });
      if (res?.ok) {
        alerts.value = alerts.value.map(a => ({ ...a, acknowledgedAt: a.acknowledgedAt ?? new Date().toISOString() }));
        combined.value = [];
        unreadCount.value = 0;
      }
    } catch (e) {
      console.warn('[follow-alerts] mark all read failed', e);
    }
  }

  const combinedUnread = computed(() => combined.value.reduce((acc, g) => acc + g.alerts.length, 0));

  return {
    alerts,
    unreadCount,
    loading,
    lastFetchedAt,
    fetchAlerts,
    markRead,
    markAllRead,
    combined,
    combinedLoading,
    fetchCombined,
    combinedUnread
  };
}

