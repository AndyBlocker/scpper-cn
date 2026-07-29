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
  /** 被关注者的展示名。BFF 此前不返回，前端只能显示「你关注的作者」 */
  targetDisplayName: string | null;
  targetWikidotId: number | null;
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
  const error = useState<string | null>('followAlerts/error', () => null);
  /**
   * 身份世代号。A 登出、B 登录时若 A 的请求还在飞，
   * 它回来会把 A 的通知标题与未读数写进 B 看到的共享状态 —— 跨账号信息泄露。
   * resetState 时 +1，在途响应回来比对，不一致就整个丢弃。
   */
  const identityEpoch = useState<number>('followAlerts/epoch', () => 0);
  /**
   * 请求世代号。identityEpoch 只在换账号时变，**挡不住同一账号内的并发请求**：
   * 常驻 layout 的铃铛以 unreadOnly=false 预取，账号页的提醒流以 unreadOnly=true
   * 强制刷新，两者会重叠，谁后到谁覆盖共享状态。若旧的那份（含已读、截断在 20 条）
   * 后到，未读列表就又退回「列表空、徽标却有数字」。
   * 每次请求 +1 并记下自己的号，只有最新一次允许写回 —— 与 useAlerts 的做法一致。
   */
  const requestGeneration = useState<number>('followAlerts/reqGen', () => 0);
  /**
   * 上一次取数用的 unreadOnly 口径，必须与数据存在一起。
   * 铃铛要 unreadOnly=false、账号页提醒流要 true；只按 lastFetchedAt 判新鲜的话，
   * 谁先取到谁的那份就会被另一方当成自己的直接复用 ——
   * 最新 20 条都已读、更早处还有未读时，列表空着而徽标有数字。
   */
  const lastFetchUnreadOnly = useState<boolean | null>('followAlerts/lastFetchMode', () => null);

  async function fetchAlerts(force = false, limit = 20, offset = 0, unreadOnly = false) {
    if (loading.value && !force) return alerts.value;
    // 口径不同就不算新鲜：手上那份是另一种 unreadOnly 取来的
    const sameMode = lastFetchUnreadOnly.value === unreadOnly;
    if (!force && sameMode && lastFetchedAt.value) {
      const last = new Date(lastFetchedAt.value).getTime();
      if (Date.now() - last < 60_000) return alerts.value;
    }
    loading.value = true;
    const myEpoch = identityEpoch.value;
    const myRequest = requestGeneration.value + 1;
    requestGeneration.value = myRequest;
    try {
      const res = await $bff<{ ok: boolean; alerts: FollowAlertItem[]; unreadCount: number }>(
        '/alerts/follow', { method: 'GET', params: { limit, offset, ...(unreadOnly ? { unreadOnly: '1' } : {}) } }
      );
      // 期间换过身份 → 本次结果作废，绝不写回共享状态
      if (identityEpoch.value !== myEpoch) return alerts.value;
      // 已有更新的请求发出 → 本次是旧数据，丢弃
      if (requestGeneration.value !== myRequest) return alerts.value;
      if (res?.ok) {
        alerts.value = Array.isArray(res.alerts) ? res.alerts : [];
        // Number() 而非 Number.isFinite(原值)：COUNT 经 pg 驱动可能是字符串，
        // isFinite('3') 为 false 会把未读数静默判成 0
        const parsed = Number(res.unreadCount);
        unreadCount.value = Number.isFinite(parsed) ? parsed : 0;
        lastFetchedAt.value = new Date().toISOString();
        lastFetchUnreadOnly.value = unreadOnly;
        combined.value = buildCombinedGroups(alerts.value);
        combinedLastFetchedAt.value = new Date().toISOString();
        error.value = null;
      } else {
        // 保留已有数据：清空会让用户看到「暂无提醒」，误以为提醒被清掉了
        error.value = '加载关注提醒失败';
      }
    } catch (e) {
      console.warn('[follow-alerts] fetch failed', e);
      // 旧请求的失败不该覆盖新请求正在做的事
      if (requestGeneration.value === myRequest) error.value = '网络异常，未能刷新关注提醒';
    } finally {
      // 同理：旧请求结束不能把 loading 关掉，否则新请求还在飞就显示「已加载完」
      if (requestGeneration.value === myRequest) loading.value = false;
    }
    return alerts.value;
  }

  function resetState() {
    identityEpoch.value += 1;
    requestGeneration.value += 1;
    alerts.value = [];
    unreadCount.value = 0;
    lastFetchedAt.value = null;
    lastFetchUnreadOnly.value = null;
    combined.value = [];
    combinedLastFetchedAt.value = null;
    error.value = null;
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
        // 先取出再展开：直接写 { ...alerts.value[idx] } 在
        // noUncheckedIndexedAccess 下类型是 T | undefined，展开后所有字段变可选
        const current = idx >= 0 ? alerts.value[idx] : undefined;
        // 只有本来未读才算「新读了一条」。铃铛下拉里也会展示已读条目，
        // 点开它们同样会调这个幂等接口，无条件递减会把徽标越点越少。
        const wasUnread = Boolean(current && !current.acknowledgedAt);
        if (current) alerts.value[idx] = { ...current, acknowledgedAt };
        combined.value = combined.value.map(group => ({
          ...group,
          alerts: group.alerts.map(alert => alert.id === id ? { ...alert, acknowledgedAt } : alert)
        }));
        // 递减而非按本地列表重算：列表只有最近 20 条，服务端可能有 100 条未读，
        // 重算会把徽标直接砍到 ≤19。
        if (wasUnread) unreadCount.value = Math.max(0, Number(unreadCount.value || 0) - 1);
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
    combinedUnread,
    error,
    resetState
  };
}
