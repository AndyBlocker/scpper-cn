import { useNuxtApp } from 'nuxt/app';
import { computed } from 'vue';
import { useAuth } from './useAuth';

/**
 * 会真正产生数据的指标。
 *
 * schema 的 PageMetricType 里还有 RATING 与 SCORE，但 PageMetricMonitorJob 从不产生它们
 * （生产库 GROUP BY metric 实测 0 行），BFF 的 MUTABLE_METRICS 也只有这三个。
 * 之前前端按 5 个来，每次 fetchAll 白发两个必空请求 —— 而每个请求都要经 BFF
 * 打一次 user-backend 做鉴权。
 */
export const ALERT_METRICS = ['COMMENT_COUNT', 'VOTE_COUNT', 'REVISION_COUNT'] as const;
export type AlertMetric = (typeof ALERT_METRICS)[number];

export interface AlertItem {
  id: number;
  metric: AlertMetric;
  prevValue: number | null;
  newValue: number | null;
  diffValue: number | null;
  detectedAt: string;
  acknowledgedAt: string | null;
  pageId: number;
  pageWikidotId: number | null;
  pageUrl: string | null;
  pageTitle: string | null;
  pageAlternateTitle: string | null;
  source: string;
}

interface AlertsResponse {
  ok: boolean;
  metric: string;
  unreadCount: number;
  alerts: AlertItem[];
  error?: string;
}

const METRIC_QUERY_MAP: Record<AlertMetric, string> = {
  COMMENT_COUNT: 'comment',
  VOTE_COUNT: 'vote',
  REVISION_COUNT: 'revision'
};

type AlertsRecord<T> = Record<AlertMetric, T>;

function createAlertsRecord<T>(factory: () => T): AlertsRecord<T> {
  return {
    COMMENT_COUNT: factory(),
    VOTE_COUNT: factory(),
    REVISION_COUNT: factory()
  };
}

function useAlertsState() {
  const alerts = useState<AlertsRecord<AlertItem[]>>('alerts/items', () => createAlertsRecord(() => []));
  const unreadCount = useState<AlertsRecord<number>>('alerts/unread', () => createAlertsRecord(() => 0));
  const loading = useState<AlertsRecord<boolean>>('alerts/loading', () => createAlertsRecord(() => false));
  const lastFetchedAt = useState<AlertsRecord<string | null>>('alerts/lastFetchedAt', () => createAlertsRecord(() => null));
  const activeMetric = useState<AlertMetric>('alerts/activeMetric', () => 'COMMENT_COUNT');
  const error = useState<AlertsRecord<string | null>>('alerts/error', () => createAlertsRecord(() => null));
  return { alerts, unreadCount, loading, lastFetchedAt, activeMetric, error };
}

export function useAlerts() {
  const { $bff } = useNuxtApp();
  const { user, status } = useAuth();
  const { alerts, unreadCount, loading, lastFetchedAt, activeMetric, error } = useAlertsState();
  // Persist last used metric for better UX across sessions
  if (typeof window !== 'undefined') {
    try {
      const saved = window.localStorage.getItem('alerts:lastMetric');
      if (saved && (ALERT_METRICS as readonly string[]).includes(saved)) {
        activeMetric.value = saved as AlertMetric;
      }
    } catch {
      // Ignore localStorage access failures in private mode or restricted contexts.
    }
  }

  function resetState() {
    alerts.value = createAlertsRecord(() => []);
    unreadCount.value = createAlertsRecord(() => 0);
    lastFetchedAt.value = createAlertsRecord(() => null);
    loading.value = createAlertsRecord(() => false);
    error.value = createAlertsRecord(() => null);
    activeMetric.value = 'COMMENT_COUNT';
  }

  async function fetchAlerts(metric?: AlertMetric, force = false) {
    const authStatus = status.value;
    const currentUser = user.value;
    if (!currentUser || authStatus !== 'authenticated' || !currentUser.linkedWikidotId) {
      resetState();
      return alerts.value[activeMetric.value];
    }
    const targetMetric = metric ?? activeMetric.value;
    if (metric && activeMetric.value !== metric) {
      activeMetric.value = metric;
      if (typeof window !== 'undefined') {
        try { window.localStorage.setItem('alerts:lastMetric', metric); } catch {
          // Ignore localStorage access failures in private mode or restricted contexts.
        }
      }
    }
    // 注意顺序：loading 门禁必须在 force 之后。原先写在前面，导致 force=true 的
    // 「刷新」在已有请求在飞时被静默吞掉，界面既不报错也不转圈。
    if (!force && loading.value[targetMetric]) {
      return alerts.value[targetMetric];
    }
    const lastFetchedTs = lastFetchedAt.value[targetMetric];
    if (!force && lastFetchedTs) {
      const lastFetched = new Date(lastFetchedTs).getTime();
      const now = Date.now();
      if (now - lastFetched < 60_000) {
        return alerts.value[targetMetric];
      }
    }

    loading.value[targetMetric] = true;
    try {
      const res = await $bff<AlertsResponse>('/alerts', {
        method: 'GET',
        params: { metric: METRIC_QUERY_MAP[targetMetric] }
      });
      if (res?.ok) {
        alerts.value[targetMetric] = Array.isArray(res.alerts) ? res.alerts : [];
        // 用 Number() 而非 Number.isFinite(原值)：PostgreSQL 的 COUNT 经 pg 驱动
        // 可能返回字符串，isFinite('3') 为 false 会把未读数静默判成 0 —— 这正是
        // 「未读数不同步」最容易复发的坑，且不抛错、不告警。
        const parsed = Number(res.unreadCount);
        unreadCount.value[targetMetric] = Number.isFinite(parsed) ? parsed : 0;
        lastFetchedAt.value[targetMetric] = new Date().toISOString();
        error.value[targetMetric] = null;
      } else {
        // 保留已有数据：清空会让用户看到「暂无提醒」，误以为提醒被清掉了
        error.value[targetMetric] = res?.error || '加载提醒失败';
      }
    } catch (err) {
      console.warn('[alerts] fetch failed', err);
      error.value[targetMetric] = '网络异常，未能刷新提醒';
    } finally {
      loading.value[targetMetric] = false;
    }
    return alerts.value[targetMetric];
  }

  async function markAlertRead(id: number, metricOpt?: AlertMetric) {
    if (!Number.isFinite(id)) return;
    // optimistic update
    const metric = metricOpt ?? activeMetric.value;
    const list = alerts.value[metric] ?? [];
    const target = list.find(item => item.id === id);
    const prevAck = target?.acknowledgedAt ?? null;
    if (target) {
      target.acknowledgedAt = target.acknowledgedAt ?? new Date().toISOString();
      const remaining = (alerts.value[metric] ?? []).filter(item => !item.acknowledgedAt).length;
      unreadCount.value[metric] = remaining;
    }
    try {
      const res = await $bff<{ ok: boolean; acknowledgedAt: string | null }>(`/alerts/${id}/read`, { method: 'POST' });
      if (!res?.ok && target) {
        // rollback on failure
        target.acknowledgedAt = prevAck;
        const remaining = (alerts.value[metric] ?? []).filter(item => !item.acknowledgedAt).length;
        unreadCount.value[metric] = remaining;
      } else if (res?.ok && target) {
        target.acknowledgedAt = res.acknowledgedAt ?? target.acknowledgedAt;
      }
    } catch (error) {
      console.warn('[alerts] mark read failed', error);
      if (target) {
        target.acknowledgedAt = prevAck;
        const remaining = (alerts.value[metric] ?? []).filter(item => !item.acknowledgedAt).length;
        unreadCount.value[metric] = remaining;
      }
    }
  }

  async function markAllAlertsRead(metric: AlertMetric = 'COMMENT_COUNT') {
    try {
      const res = await $bff<{ ok: boolean; updated: number }>('/alerts/read-all', {
        method: 'POST',
        body: { metric: METRIC_QUERY_MAP[metric] }
      });
      if (res?.ok) {
        const nowIso = new Date().toISOString();
        alerts.value[metric] = (alerts.value[metric] ?? []).map(item => ({
          ...item,
          acknowledgedAt: item.acknowledgedAt ?? nowIso
        }));
        unreadCount.value[metric] = 0;
      }
    } catch (error) {
      console.warn('[alerts] mark all read failed', error);
    }
  }

  // Fetch all metrics (in parallel) for a unified, fresh view
  async function fetchAll(force = false) {
    await Promise.all(ALERT_METRICS.map(m => fetchAlerts(m, force)));
    return true;
  }

  // Mark all as read for a specific metric or across all
  async function markAllRead(target: AlertMetric | 'ALL') {
    if (target === 'ALL') {
      await Promise.all(ALERT_METRICS.map(async (m) => markAllAlertsRead(m)));
      return;
    }
    await markAllAlertsRead(target);
  }

  // Unified stream for ALL tab (newest first)
  const alertsAll = computed(() => {
    const buckets = alerts.value;
    const flat: Array<AlertItem & { sourceMetric: AlertMetric } > = [];
    ALERT_METRICS
      .forEach((key) => {
        for (const item of (buckets[key] ?? [])) {
          flat.push({ ...item, sourceMetric: key });
        }
      });
    return flat.sort((a, b) => String(b.detectedAt).localeCompare(String(a.detectedAt)));
  });

  const hasUnread = computed(() => unreadCount.value[activeMetric.value] > 0);
  const totalUnread = computed(() => Object.values(unreadCount.value).reduce((acc, count) => acc + (Number.isFinite(count) ? count : 0), 0));
  const currentAlerts = computed(() => alerts.value[activeMetric.value] ?? []);
  const currentUnreadCount = computed(() => unreadCount.value[activeMetric.value] ?? 0);
  const currentLoading = computed(() => Boolean(loading.value[activeMetric.value]));
  const currentError = computed(() => error.value[activeMetric.value] ?? null);
  /** 任一指标出错即为真，供「加载失败，重试」这类整体提示使用 */
  const hasError = computed(() => ALERT_METRICS.some((m) => Boolean(error.value[m])));

  function setActiveMetric(metric: AlertMetric) {
    if (activeMetric.value !== metric) {
      activeMetric.value = metric;
      if (typeof window !== 'undefined') {
        try { window.localStorage.setItem('alerts:lastMetric', metric); } catch {
          // Ignore localStorage access failures in private mode or restricted contexts.
        }
      }
    }
  }

  // Revalidate on visibility/online for SWR-like freshness
  function startRevalidateOnFocus(intervalMs = 30_000) {
    if (typeof document === 'undefined') return;
    let last = 0;
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        const now = Date.now();
        if (now - last >= intervalMs) {
          last = now;
          void fetchAll(false);
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }
  function startRevalidateOnReconnect() {
    if (typeof window === 'undefined') return;
    const onOnline = () => { void fetchAll(false); };
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }

  return {
    alerts: currentAlerts,
    alertsAll,
    alertsByMetric: alerts,
    unreadCount: currentUnreadCount,
    unreadByMetric: unreadCount,
    loading: currentLoading,
    loadingByMetric: loading,
    hasUnread,
    lastFetchedAt,
    totalUnread,
    activeMetric,
    error: currentError,
    errorByMetric: error,
    hasError,
    fetchAlerts,
    fetchAll,
    markAlertRead,
    markAllAlertsRead,
    markAllRead,
    resetState,
    setActiveMetric,
    startRevalidateOnFocus,
    startRevalidateOnReconnect
  };
}
