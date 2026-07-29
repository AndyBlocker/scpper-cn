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
   * 未读口径的结果**单独存**，不与 alerts（含已读）共用一个数组。
   *
   * 为什么必须分开而不是靠新鲜度/世代号调停：铃铛常驻 layout，要 unreadOnly=false
   * （它会把已读条目也列出来，只是弱化显示）；账号页提醒流要 unreadOnly=true。
   * 两者是**同时存在**的消费者，共用一个数组时，无论谁写都在破坏对方 ——
   * 前几轮先后试过「记住上次口径」「按口径判新鲜」，都只是让覆盖发生得晚一点：
   * 只要铃铛真的重新取一次，提醒流的未读列表就没了，于是列表空着而徽标有数字。
   * 两种口径是两份数据，就该有两个位置。
   */
  const unreadAlerts = useState<FollowAlertItem[]>('followAlerts/unreadList', () => []);
  const unreadLastFetchedAt = useState<string | null>('followAlerts/unreadLastFetchedAt', () => null);
  const unreadLoading = useState<boolean>('followAlerts/unreadLoading', () => false);
  /**
   * 请求世代号，**按口径各记一份**。共用一个的话，铃铛发起的请求会让
   * 提醒流那次在途请求的写回被判为过期而整个丢弃 —— 它俩本来井水不犯河水。
   */
  const requestGeneration = useState<{ all: number; unread: number }>(
    'followAlerts/reqGen', () => ({ all: 0, unread: 0 })
  );
  /**
   * 未读计数的世代号。两种读取口径写的是**同一个** unreadCount，
   * 各自的 requestGeneration 管不到对方 —— 较旧的响应后到就会把新计数
   * 覆盖回去，红点凭空复活或消失。所有会写 unreadCount 的操作共用它。
   */
  const countGeneration = useState<number>('followAlerts/countGen', () => 0);

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
    const myCountGen = countGeneration.value + 1;
    countGeneration.value = myCountGen;
    try {
      const res = await $bff<{ ok: boolean; alerts: FollowAlertItem[]; unreadCount: number }>(
        '/alerts/follow', { method: 'GET', params: { limit, offset, ...(unreadOnly ? { unreadOnly: '1' } : {}) } }
      );
      // 期间换过身份 → 本次结果作废，绝不写回共享状态
      if (identityEpoch.value !== myEpoch) return list.value;
      // 同口径已有更新的请求发出 → 本次是旧数据，丢弃
      if (requestGeneration.value[slot] !== myRequest) return list.value;
      if (res?.ok) {
        list.value = Array.isArray(res.alerts) ? res.alerts : [];
        // Number() 而非 Number.isFinite(原值)：COUNT 经 pg 驱动可能是字符串，
        // isFinite('3') 为 false 会把未读数静默判成 0
        const parsed = Number(res.unreadCount);
        // 只有仍是最新一次写计数的操作才允许落笔
        if (countGeneration.value === myCountGen) {
          unreadCount.value = Number.isFinite(parsed) ? parsed : 0;
        }
        stamp.value = new Date().toISOString();
        // combined 只服务铃铛那套（含已读），不要被未读口径的结果改写
        if (!unreadOnly) {
          combined.value = buildCombinedGroups(alerts.value);
          combinedLastFetchedAt.value = new Date().toISOString();
        }
        error.value = null;
      } else {
        // 保留已有数据：清空会让用户看到「暂无提醒」，误以为提醒被清掉了
        error.value = '加载关注提醒失败';
      }
    } catch (e) {
      console.warn('[follow-alerts] fetch failed', e);
      // 旧请求的失败不该覆盖新请求正在做的事
      if (requestGeneration.value[slot] === myRequest) error.value = '网络异常，未能刷新关注提醒';
    } finally {
      // 同理：旧请求结束不能把 loading 关掉，否则新请求还在飞就显示「已加载完」
      if (requestGeneration.value[slot] === myRequest) busy.value = false;
    }
    return list.value;
  }

  function resetState() {
    identityEpoch.value += 1;
    requestGeneration.value = {
      all: requestGeneration.value.all + 1,
      unread: requestGeneration.value.unread + 1
    };
    countGeneration.value += 1;
    // 被作废的在途 GET 已经清不掉自己的 loading（世代守卫不成立），
    // 这里替它收尾，否则转圈停不下来、后续非强制刷新也会被挡住。
    loading.value = false;
    unreadLoading.value = false;
    alerts.value = [];
    unreadAlerts.value = [];
    unreadCount.value = 0;
    lastFetchedAt.value = null;
    unreadLastFetchedAt.value = null;
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
    // 与 fetchAlerts 同样的守卫：换过账号就不写回共享状态
    const epochAtStart = identityEpoch.value;
    try {
      const list = await fetchAlerts(force, limit, offset);
      if (identityEpoch.value !== epochAtStart) return combined.value;
      combined.value = buildCombinedGroups(list);
      combinedLastFetchedAt.value = new Date().toISOString();
    } catch (e) {
      console.warn('[follow-alerts] combined fetch failed', e);
      if (identityEpoch.value === epochAtStart) {
        combined.value = [];
        combinedLastFetchedAt.value = null;
      }
    } finally {
      if (identityEpoch.value === epochAtStart) combinedLoading.value = false;
    }
    return combined.value;
  }

  async function markRead(id: number) {
    // 成功写回也要守卫：A 的请求在 B 登录后才返回的话，
    // 下面这些对共享状态的修改会落到 B 的界面上。
    const epochAtStart = identityEpoch.value;
    // 作废在途 GET：一个在写入**之前**就发出的请求，回来时带的是「还没读」
    // 的快照，会把刚标记已读的条目和计数原样恢复 —— 乐观更新被自己的旧读覆盖。
    requestGeneration.value = {
      all: requestGeneration.value.all + 1,
      unread: requestGeneration.value.unread + 1
    };
    countGeneration.value += 1;
    // 被作废的在途 GET 已经清不掉自己的 loading（世代守卫不成立），
    // 这里替它收尾，否则转圈停不下来、后续非强制刷新也会被挡住。
    loading.value = false;
    unreadLoading.value = false;
    try {
      const res = await $bff<{ ok: boolean; id: number; acknowledgedAt: string | null }>(`/alerts/follow/${id}/read`, { method: 'POST' });
      if (res?.ok && identityEpoch.value === epochAtStart) {
        const acknowledgedAt = res.acknowledgedAt ?? new Date().toISOString();
        const idx = alerts.value.findIndex(a => a.id === id);
        // 先取出再展开：直接写 { ...alerts.value[idx] } 在
        // noUncheckedIndexedAccess 下类型是 T | undefined，展开后所有字段变可选
        const current = idx >= 0 ? alerts.value[idx] : undefined;
        // 只有本来未读才算「新读了一条」。铃铛下拉里也会展示已读条目，
        // 点开它们同样会调这个幂等接口，无条件递减会把徽标越点越少。
        // 两份缓存都要看：提醒流的条目取自未读桶，而含已读那份只有最近 20 条，
        // 较早的未读不在其中时只看 current 会漏判，导致条目消失而徽标不减。
        const inUnreadBucket = unreadAlerts.value.some(a => a.id === id);
        const wasUnread = inUnreadBucket || Boolean(current && !current.acknowledgedAt);
        if (current) alerts.value[idx] = { ...current, acknowledgedAt };
        combined.value = combined.value.map(group => ({
          ...group,
          alerts: group.alerts.map(alert => alert.id === id ? { ...alert, acknowledgedAt } : alert)
        }));
        // 递减而非按本地列表重算：列表只有最近 20 条，服务端可能有 100 条未读，
        // 重算会把徽标直接砍到 ≤19。
        // 未读口径那份也要同步：它本就只装未读，读掉一条就该移出去，
        // 否则提醒流会一直显示一条已经读过的条目，直到下次重新取数。
        unreadAlerts.value = unreadAlerts.value.filter(a => a.id !== id);
        if (wasUnread) unreadCount.value = Math.max(0, Number(unreadCount.value || 0) - 1);
      }
    } catch (e) {
      console.warn('[follow-alerts] mark read failed', e);
    }
  }

  async function markAllRead() {
    const epochAtStart = identityEpoch.value;
    // 作废在途 GET：一个在写入**之前**就发出的请求，回来时带的是「还没读」
    // 的快照，会把刚标记已读的条目和计数原样恢复 —— 乐观更新被自己的旧读覆盖。
    requestGeneration.value = {
      all: requestGeneration.value.all + 1,
      unread: requestGeneration.value.unread + 1
    };
    countGeneration.value += 1;
    // 被作废的在途 GET 已经清不掉自己的 loading（世代守卫不成立），
    // 这里替它收尾，否则转圈停不下来、后续非强制刷新也会被挡住。
    loading.value = false;
    unreadLoading.value = false;
    try {
      const res = await $bff<{ ok: boolean; updated: number }>('/alerts/follow/read-all', { method: 'POST' });
      if (res?.ok && identityEpoch.value === epochAtStart) {
        const nowIso = new Date().toISOString();
        alerts.value = alerts.value.map(a => ({ ...a, acknowledgedAt: a.acknowledgedAt ?? nowIso }));
        combined.value = combined.value.map(group => ({
          ...group,
          alerts: group.alerts.map(alert => ({ ...alert, acknowledgedAt: alert.acknowledgedAt ?? nowIso }))
        }));
        // 未读口径那份整体清空 —— 全部已读之后它按定义就是空的
        unreadAlerts.value = [];
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
    /** 未读口径的结果，供账号页提醒流使用（与 alerts 是两份独立数据） */
    unreadAlerts,
    unreadLoading,
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
