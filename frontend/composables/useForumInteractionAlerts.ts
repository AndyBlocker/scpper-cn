import { useNuxtApp } from 'nuxt/app';
import { computed } from 'vue';

export type ForumInteractionAlertType = 'PAGE_REPLY' | 'DIRECT_REPLY' | 'MENTION';

export interface ForumInteractionAlertItem {
  id: number;
  type: ForumInteractionAlertType;
  detectedAt: string;
  acknowledgedAt: string | null;
  recipientUserId: number;
  actorUserId: number | null;
  actorWikidotId: number | null;
  actorName: string | null;
  postId: number;
  parentPostId: number | null;
  threadId: number;
  pageId: number | null;
  postTitle: string | null;
  postExcerpt: string | null;
  threadTitle: string | null;
  pageWikidotId: number | null;
  pageUrl: string | null;
  pageTitle: string | null;
  pageAlternateTitle: string | null;
  sourceThreadUrl: string | null;
  sourcePostUrl: string | null;
}

interface ForumAlertsResponse {
  ok: boolean;
  alerts: ForumInteractionAlertItem[];
  unreadCount: number;
}

interface MarkReadResponse {
  ok: boolean;
  id: number;
  acknowledgedAt: string | null;
}

interface MarkAllReadResponse {
  ok: boolean;
  updated: number;
}

export function useForumInteractionAlerts() {
  const { $bff } = useNuxtApp();

  const alerts = useState<ForumInteractionAlertItem[]>('forumAlerts/list', () => []);
  const unreadCount = useState<number>('forumAlerts/unread', () => 0);
  const loading = useState<boolean>('forumAlerts/loading', () => false);
  const lastFetchedAt = useState<string | null>('forumAlerts/lastFetchedAt', () => null);
  const error = useState<string | null>('forumAlerts/error', () => null);

  async function fetchAlerts(force = false, limit = 20, offset = 0) {
    if (loading.value && !force) return alerts.value;

    if (!force && lastFetchedAt.value) {
      const last = new Date(lastFetchedAt.value).getTime();
      if (Date.now() - last < 60_000) return alerts.value;
    }

    loading.value = true;
    try {
      const res = await $bff<ForumAlertsResponse>('/alerts/forum', {
        method: 'GET',
        params: { limit, offset }
      });

      if (res?.ok) {
        alerts.value = Array.isArray(res.alerts) ? res.alerts : [];
        const parsed = Number(res.unreadCount);
        unreadCount.value = Number.isFinite(parsed) ? parsed : 0;
        lastFetchedAt.value = new Date().toISOString();
        error.value = null;
      } else {
        // 保留已有数据，只记录错误
        error.value = '加载论坛提醒失败';
      }
    } catch (e) {
      console.warn('[forum-alerts] fetch failed', e);
      error.value = '网络异常，未能刷新论坛提醒';
    } finally {
      loading.value = false;
    }

    return alerts.value;
  }

  async function markRead(id: number) {
    if (!Number.isFinite(id)) return;

    const idx = alerts.value.findIndex((item) => item.id === id);
    // 先取出再用：alerts.value[idx] 在 noUncheckedIndexedAccess 下是 T | undefined，
    // 直接展开会让所有字段变成可选，赋回去就不再满足 ForumInteractionAlertItem
    const target = idx >= 0 ? alerts.value[idx] : undefined;
    const prev = target?.acknowledgedAt ?? null;

    if (target && !target.acknowledgedAt) {
      alerts.value[idx] = {
        ...target,
        acknowledgedAt: new Date().toISOString()
      };
      unreadCount.value = alerts.value.filter((item) => !item.acknowledgedAt).length;
    }

    try {
      const res = await $bff<MarkReadResponse>(`/alerts/forum/${id}/read`, { method: 'POST' });
      const after = idx >= 0 ? alerts.value[idx] : undefined;
      if (res?.ok && after) {
        alerts.value[idx] = {
          ...after,
          acknowledgedAt: res.acknowledgedAt ?? after.acknowledgedAt
        };
      }
    } catch (error) {
      console.warn('[forum-alerts] mark read failed', error);
      const rollback = idx >= 0 ? alerts.value[idx] : undefined;
      if (rollback) {
        alerts.value[idx] = {
          ...rollback,
          acknowledgedAt: prev
        };
        unreadCount.value = alerts.value.filter((item) => !item.acknowledgedAt).length;
      }
    }
  }

  async function markAllRead() {
    try {
      const res = await $bff<MarkAllReadResponse>('/alerts/forum/read-all', { method: 'POST' });
      if (res?.ok) {
        const ackAt = new Date().toISOString();
        alerts.value = alerts.value.map((item) => ({
          ...item,
          acknowledgedAt: item.acknowledgedAt ?? ackAt
        }));
        unreadCount.value = 0;
      }
    } catch (error) {
      console.warn('[forum-alerts] mark all read failed', error);
    }
  }

  const hasUnread = computed(() => unreadCount.value > 0);

  return {
    alerts,
    unreadCount,
    loading,
    lastFetchedAt,
    hasUnread,
    fetchAlerts,
    markRead,
    markAllRead,
    error
  };
}
