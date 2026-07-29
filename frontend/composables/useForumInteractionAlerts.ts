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
  /**
   * 身份世代号。A 登出、B 登录时若 A 的请求还在飞，
   * 它回来会把 A 的通知标题与未读数写进 B 看到的共享状态 —— 跨账号信息泄露。
   * resetState 时 +1，在途响应回来比对，不一致就整个丢弃。
   */
  const identityEpoch = useState<number>('forumAlerts/epoch', () => 0);
  /**
   * 请求世代号。identityEpoch 只在换账号时变，**挡不住同一账号内的并发请求**：
   * 铃铛以 unreadOnly=false 预取、账号页以 unreadOnly=true 强制刷新，两者会重叠，
   * 谁后到谁覆盖共享状态；旧的那份后到就会让未读列表退回「列表空、徽标有数字」。
   * 每次请求 +1，只有最新一次允许写回 —— 与 useAlerts 的做法一致。
   */
  const requestGeneration = useState<{ all: number; unread: number }>(
    'forumAlerts/reqGen', () => ({ all: 0, unread: 0 })
  );
  /**
   * 未读口径的结果**单独存**。铃铛（含已读）与账号页提醒流（仅未读）是
   * 同时存在的消费者，共用一个数组时无论谁写都在破坏对方 ——
   * 靠新鲜度或世代号调停只能推迟覆盖，不能消除它。
   */
  const unreadAlerts = useState<ForumInteractionAlertItem[]>('forumAlerts/unreadList', () => []);
  const unreadLastFetchedAt = useState<string | null>('forumAlerts/unreadLastFetchedAt', () => null);
  const unreadLoading = useState<boolean>('forumAlerts/unreadLoading', () => false);

  async function fetchAlerts(force = false, limit = 20, offset = 0, unreadOnly = false) {
    const slot = unreadOnly ? 'unread' : 'all';
    const list = unreadOnly ? unreadAlerts : alerts;
    const stamp = unreadOnly ? unreadLastFetchedAt : lastFetchedAt;
    const busy = unreadOnly ? unreadLoading : loading;

    if (busy.value && !force) return list.value;

    if (!force && stamp.value) {
      const last = new Date(stamp.value).getTime();
      if (Date.now() - last < 60_000) return list.value;
    }

    busy.value = true;
    const myEpoch = identityEpoch.value;
    const myRequest = requestGeneration.value[slot] + 1;
    requestGeneration.value = { ...requestGeneration.value, [slot]: myRequest };
    try {
      const res = await $bff<ForumAlertsResponse>('/alerts/forum', {
        method: 'GET',
        params: { limit, offset, ...(unreadOnly ? { unreadOnly: '1' } : {}) }
      });

      // 期间换过身份 → 本次结果作废，绝不写回共享状态
      if (identityEpoch.value !== myEpoch) return list.value;
      // 同口径已有更新的请求发出 → 本次是旧数据，丢弃
      if (requestGeneration.value[slot] !== myRequest) return list.value;
      if (res?.ok) {
        list.value = Array.isArray(res.alerts) ? res.alerts : [];
        const parsed = Number(res.unreadCount);
        unreadCount.value = Number.isFinite(parsed) ? parsed : 0;
        stamp.value = new Date().toISOString();
        error.value = null;
      } else {
        // 保留已有数据，只记录错误
        error.value = '加载论坛提醒失败';
      }
    } catch (e) {
      console.warn('[forum-alerts] fetch failed', e);
      // 旧请求的失败不该覆盖新请求正在做的事
      if (requestGeneration.value[slot] === myRequest) error.value = '网络异常，未能刷新论坛提醒';
    } finally {
      // 同理：旧请求结束不能把 loading 关掉，否则新请求还在飞就显示「已加载完」
      if (requestGeneration.value[slot] === myRequest) busy.value = false;
    }

    return list.value;
  }

  async function markRead(id: number) {
    if (!Number.isFinite(id)) return;

    const idx = alerts.value.findIndex((item) => item.id === id);
    // 先取出再用：alerts.value[idx] 在 noUncheckedIndexedAccess 下是 T | undefined，
    // 直接展开会让所有字段变成可选，赋回去就不再满足 ForumInteractionAlertItem
    const target = idx >= 0 ? alerts.value[idx] : undefined;
    const prev = target?.acknowledgedAt ?? null;
    // 失败回滚要还原**回滚前的服务端计数**。按本地列表重算会把 100 砍到 ≤20
    // （列表只有一页），而且要等下次刷新才恢复。
    let prevUnread = Number(unreadCount.value || 0);

    // 未读口径那份只装未读，读掉一条就该移出去。
    // 先存一份原值：请求失败要还原，否则条目从提醒流里消失了，
    // 服务端却仍是未读 —— 用户再也看不到它，直到下次重新取数。
    const prevUnreadList = unreadAlerts.value;
    // 「本来是未读吗」要在**任何改动之前**、并且**两份缓存都看**地算出来：
    // 提醒流的条目取自未读桶，而含已读那份只有最近 20 条，
    // 较早的未读不在其中时只看 target 会漏判 —— 条目消失了红点却不减。
    const wasUnread = prevUnreadList.some((item) => item.id === id)
      || Boolean(target && !target.acknowledgedAt);

    if (target && !target.acknowledgedAt) {
      alerts.value[idx] = {
        ...target,
        acknowledgedAt: new Date().toISOString()
      };
    }
    if (wasUnread) {
      // 同 useFollowAlerts：递减而非按截断到 20 条的本地列表重算
      prevUnread = Number(unreadCount.value || 0);
      unreadCount.value = Math.max(0, prevUnread - 1);
    }
    unreadAlerts.value = prevUnreadList.filter((item) => item.id !== id);

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
      // 未读桶必须无条件还原 —— 它和 alerts 是两份数据，
      // 只在 rollback 存在时还原的话，不在含已读缓存里的条目就永久消失了
      unreadAlerts.value = prevUnreadList;
      // 还原保存下来的服务端计数，而不是按本地列表重算 ——
      // 列表只有一页（≤20 条），重算会把 100 直接砍成 ≤20，且要等下次刷新才恢复。
      // 这一步不能挂在 rollback 上：条目可能只存在于未读桶里（含已读那份只有 20 条），
      // 那时 rollback 是 undefined，递减过的计数就再也回不来了。
      if (wasUnread) unreadCount.value = prevUnread;
      const rollback = idx >= 0 ? alerts.value[idx] : undefined;
      if (rollback) {
        alerts.value[idx] = {
          ...rollback,
          acknowledgedAt: prev
        };
      }
    }
  }

  /** 换账号时必须清空并作废在途请求，否则 B 会看到 A 的通知 */
  function resetState() {
    identityEpoch.value += 1;
    requestGeneration.value = {
      all: requestGeneration.value.all + 1,
      unread: requestGeneration.value.unread + 1
    };
    alerts.value = [];
    unreadAlerts.value = [];
    unreadCount.value = 0;
    lastFetchedAt.value = null;
    unreadLastFetchedAt.value = null;
    error.value = null;
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
        unreadAlerts.value = [];
        unreadCount.value = 0;
      }
    } catch (error) {
      console.warn('[forum-alerts] mark all read failed', error);
    }
  }

  const hasUnread = computed(() => unreadCount.value > 0);

  return {
    alerts,
    /** 未读口径的结果，供账号页提醒流使用（与 alerts 是两份独立数据） */
    unreadAlerts,
    unreadLoading,
    unreadCount,
    loading,
    lastFetchedAt,
    hasUnread,
    fetchAlerts,
    markRead,
    markAllRead,
    error,
    resetState
  };
}
