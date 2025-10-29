import { useNuxtApp } from 'nuxt/app';
import { computed } from 'vue';

export type FollowAlertType = 'REVISION' | 'ATTRIBUTION' | 'ATTRIBUTION_REMOVED';

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
        combined.value = buildCombinedGroups(alerts.value);
        combinedLastFetchedAt.value = new Date().toISOString();
      } else {
        alerts.value = [];
        unreadCount.value = 0;
        lastFetchedAt.value = null;
        combined.value = [];
        combinedLastFetchedAt.value = null;
      }
    } catch (e) {
      console.warn('[follow-alerts] fetch failed', e);
      alerts.value = [];
      unreadCount.value = 0;
      lastFetchedAt.value = null;
      combined.value = [];
      combinedLastFetchedAt.value = null;
    } finally {
      loading.value = false;
    }
    return alerts.value;
  }

  function buildCombinedGroups(list: FollowAlertItem[]): FollowCombinedGroup[] {
    const groups = new Map<number, FollowCombinedGroup>();
    for (const item of list) {
      const existing = groups.get(item.pageId);
      if (!existing) {
        groups.set(item.pageId, {
          pageId: item.pageId,
          pageWikidotId: item.pageWikidotId ?? null,
          pageUrl: item.pageUrl ?? null,
          pageTitle: item.pageTitle ?? null,
          pageAlternateTitle: item.pageAlternateTitle ?? null,
          updatedAt: item.detectedAt,
          alerts: [item]
        });
        continue;
      }
      existing.alerts.push(item);
      if (new Date(item.detectedAt).getTime() > new Date(existing.updatedAt).getTime()) {
        existing.updatedAt = item.detectedAt;
      }
      if (existing.pageTitle == null && item.pageTitle) existing.pageTitle = item.pageTitle;
      if (existing.pageAlternateTitle == null && item.pageAlternateTitle) existing.pageAlternateTitle = item.pageAlternateTitle;
      if (existing.pageWikidotId == null && item.pageWikidotId != null) existing.pageWikidotId = item.pageWikidotId;
      if (existing.pageUrl == null && item.pageUrl) existing.pageUrl = item.pageUrl;
    }
    return Array.from(groups.values()).map(group => ({
      ...group,
      alerts: group.alerts
        .slice()
        .sort((a, b) => new Date(b.detectedAt).getTime() - new Date(a.detectedAt).getTime())
    })).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  async function fetchCombined(force = false, limit = 20, offset = 0) {
    if (combinedLoading.value && !force) return combined.value;
    if (!force && combinedLastFetchedAt.value) {
      const last = new Date(combinedLastFetchedAt.value).getTime();
      if (Date.now() - last < 60_000) return combined.value;
    }
    combinedLoading.value = true;
    try {
      const list = await fetchAlerts(force, limit, offset);
      combined.value = buildCombinedGroups(list);
      combinedLastFetchedAt.value = new Date().toISOString();
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
        const acknowledgedAt = res.acknowledgedAt ?? new Date().toISOString();
        const idx = alerts.value.findIndex(a => a.id === id);
        if (idx >= 0) alerts.value[idx] = { ...alerts.value[idx], acknowledgedAt };
        combined.value = combined.value.map(group => ({
          ...group,
          alerts: group.alerts.map(alert => alert.id === id ? { ...alert, acknowledgedAt } : alert)
        }));
        unreadCount.value = alerts.value.filter(a => !a.acknowledgedAt).length;
      }
    } catch (e) {
      console.warn('[follow-alerts] mark read failed', e);
    }
  }

  async function markAllRead() {
    try {
      const res = await $bff<{ ok: boolean; updated: number }>('/alerts/follow/read-all', { method: 'POST' });
      if (res?.ok) {
        const nowIso = new Date().toISOString();
        alerts.value = alerts.value.map(a => ({ ...a, acknowledgedAt: a.acknowledgedAt ?? nowIso }));
        combined.value = combined.value.map(group => ({
          ...group,
          alerts: group.alerts.map(alert => ({ ...alert, acknowledgedAt: alert.acknowledgedAt ?? nowIso }))
        }));
        unreadCount.value = 0;
      }
    } catch (e) {
      console.warn('[follow-alerts] mark all read failed', e);
    }
  }

  const combinedUnread = computed(() => combined.value.reduce((acc, g) => (
    acc + g.alerts.reduce((count, alert) => count + (alert.acknowledgedAt ? 0 : 1), 0)
  ), 0));

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
