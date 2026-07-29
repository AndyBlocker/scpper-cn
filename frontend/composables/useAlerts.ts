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
  /**
   * 未读口径的结果**单独存一份**，不与 alerts（含已读）共用。
   *
   * 两个调用方口径不同且同时存在：常驻 layout 的铃铛要 unreadOnly=false
   * （列出最近的，含已读，只是弱化显示），账号页提醒流要 unreadOnly=true。
   * 共用一个数组时无论谁写都在破坏对方 —— 先后试过「记住上次口径」
   * 「按口径判新鲜」，都只是让覆盖发生得晚一点：铃铛真的重新取一次，
   * 提醒流的未读列表就没了，于是列表空着而徽标有数字。
   * 两种口径是两份数据，就该有两个位置。
   */
  const unreadAlerts = useState<AlertsRecord<AlertItem[]>>('alerts/unreadItems', () => createAlertsRecord(() => []));
  const unreadLastFetchedAt = useState<AlertsRecord<string | null>>('alerts/unreadLastFetchedAt', () => createAlertsRecord(() => null));
  const unreadLoading = useState<AlertsRecord<boolean>>('alerts/unreadLoading', () => createAlertsRecord(() => false));
  const activeMetric = useState<AlertMetric>('alerts/activeMetric', () => 'COMMENT_COUNT');
  const error = useState<AlertsRecord<string | null>>('alerts/error', () => createAlertsRecord(() => null));
  // 请求世代必须**跨组件共享**：每个 useAlerts() 调用各自新建一个 Map 的话，
  // layout 里 resetState 递增的世代号影响不到面板里那份，守卫等于没有。
  // 世代号要按 metric **和口径**双维度记：两种口径写的是两份不同的缓存，
  // 共用一个世代号的话，铃铛的 all 请求会让提醒流那次 unread 请求的写回
  // 被判为过期而丢弃 —— 它俩根本不冲突。
  const epochs = useState<AlertsRecord<{ all: number; unread: number }>>(
    'alerts/epochs', () => createAlertsRecord(() => ({ all: 0, unread: 0 }))
  );
  /**
   * **身份**世代号：只在 resetState（换账号）时递增。
   *
   * 上一轮我拿 epochs 当身份签名，但它每次普通取数都会变 ——
   * 于是「标记已读」期间只要有一次刷新或焦点重新校验，回滚就被判定为
   * 「已换账号」而永远不执行，乐观删掉的条目再也回不来。
   * 「该不该回滚」只取决于用户有没有换人，与期间刷新过几次无关，
   * 所以必须是一个独立的、只随账号变化的计数。
   */
  const identityEpoch = useState<number>('alerts/identityEpoch', () => 0);
  /**
   * 未读计数的世代号。两种读取口径写的是**同一个** unreadCount，
   * 各自的 epochs 管不到对方：一条较旧的响应后到就会把新计数覆盖回去，
   * 让红点凭空复活或消失。所有会写 unreadCount 的操作共用这一个。
   */
  const countGeneration = useState<AlertsRecord<number>>('alerts/countGen', () => createAlertsRecord(() => 0));
  return { alerts, unreadAlerts, unreadCount, loading, unreadLoading, lastFetchedAt, unreadLastFetchedAt, activeMetric, error, epochs, identityEpoch, countGeneration };
}

export function useAlerts() {
  const { $bff } = useNuxtApp();
  const { user, status } = useAuth();
  // 请求世代：force 刷新会绕过 loading 门禁，于是同一 metric 可能有两个请求在飞；
  // 换账号时 A 的请求也可能在 B 登录后才返回。两种情况都会用陈旧/他人的数据
  // 覆盖共享状态。每次发起 +1，回来时比对，不是最新的就整个丢弃。
  const { alerts, unreadAlerts, unreadCount, loading, unreadLoading, lastFetchedAt, unreadLastFetchedAt, activeMetric, error, epochs, identityEpoch, countGeneration } = useAlertsState();
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
    // 作废所有在途请求：A 的响应若在 B 登录后才回来，会把 A 的数据
    // 写进 B 看到的共享状态（跨账号信息泄露）。
    identityEpoch.value += 1;
    for (const m of ALERT_METRICS) {
      epochs.value[m] = { all: epochs.value[m].all + 1, unread: epochs.value[m].unread + 1 };
      countGeneration.value[m] += 1;
    }
    alerts.value = createAlertsRecord(() => []);
    unreadCount.value = createAlertsRecord(() => 0);
    lastFetchedAt.value = createAlertsRecord(() => null);
    unreadAlerts.value = createAlertsRecord(() => []);
    unreadLastFetchedAt.value = createAlertsRecord(() => null);
    unreadLoading.value = createAlertsRecord(() => false);
    loading.value = createAlertsRecord(() => false);
    error.value = createAlertsRecord(() => null);
    activeMetric.value = 'COMMENT_COUNT';
  }

  async function fetchAlerts(metric?: AlertMetric, force = false, unreadOnly = false) {
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
    // 未读口径与含已读口径各存各的，取数、时间戳、loading 全部按口径路由
    const list = unreadOnly ? unreadAlerts : alerts;
    const stamps = unreadOnly ? unreadLastFetchedAt : lastFetchedAt;
    const busy = unreadOnly ? unreadLoading : loading;

    // 注意顺序：loading 门禁必须在 force 之后。原先写在前面，导致 force=true 的
    // 「刷新」在已有请求在飞时被静默吞掉，界面既不报错也不转圈。
    if (!force && busy.value[targetMetric]) {
      return list.value[targetMetric];
    }
    const lastFetchedTs = stamps.value[targetMetric];
    if (!force && lastFetchedTs) {
      const lastFetched = new Date(lastFetchedTs).getTime();
      const now = Date.now();
      if (now - lastFetched < 60_000) {
        return list.value[targetMetric];
      }
    }

    busy.value[targetMetric] = true;
    const slot = unreadOnly ? 'unread' : 'all';
    const myEpoch = epochs.value[targetMetric][slot] + 1;
    epochs.value[targetMetric] = { ...epochs.value[targetMetric], [slot]: myEpoch };
    // 计数的世代单独抓：它是两种口径共写的
    const myCountGen = countGeneration.value[targetMetric] + 1;
    countGeneration.value[targetMetric] = myCountGen;
    try {
      const res = await $bff<AlertsResponse>('/alerts', {
        method: 'GET',
        params: { metric: METRIC_QUERY_MAP[targetMetric], ...(unreadOnly ? { unreadOnly: '1' } : {}) }
      });
      // 在途期间又发起了更新的请求 → 本次结果作废
      if (epochs.value[targetMetric][slot] !== myEpoch) return list.value[targetMetric];
      if (res?.ok) {
        list.value[targetMetric] = Array.isArray(res.alerts) ? res.alerts : [];
        // 用 Number() 而非 Number.isFinite(原值)：PostgreSQL 的 COUNT 经 pg 驱动
        // 可能返回字符串，isFinite('3') 为 false 会把未读数静默判成 0 —— 这正是
        // 「未读数不同步」最容易复发的坑，且不抛错、不告警。
        const parsed = Number(res.unreadCount);
        // 只有仍是最新一次写计数的操作才允许落笔
        if (countGeneration.value[targetMetric] === myCountGen) {
          unreadCount.value[targetMetric] = Number.isFinite(parsed) ? parsed : 0;
        }
        stamps.value[targetMetric] = new Date().toISOString();
        error.value[targetMetric] = null;
      } else {
        // 保留已有数据：清空会让用户看到「暂无提醒」，误以为提醒被清掉了
        error.value[targetMetric] = res?.error || '加载提醒失败';
      }
    } catch (err) {
      console.warn('[alerts] fetch failed', err);
      if (epochs.value[targetMetric][slot] === myEpoch) {
        error.value[targetMetric] = '网络异常，未能刷新提醒';
      }
    } finally {
      // 只有最新那次请求才有资格关掉 loading。旧请求先返回就把它关掉的话，
      // 转圈提前消失、还会放行新的刷新，而更新的那次其实还在飞 ——
      // follow / forum 两个 composable 已经这么做了，这里之前漏了。
      if (epochs.value[targetMetric][slot] === myEpoch) busy.value[targetMetric] = false;
    }
    return list.value[targetMetric];
  }

  async function markAlertRead(id: number, metricOpt?: AlertMetric) {
    if (!Number.isFinite(id)) return;
    // optimistic update
    const metric = metricOpt ?? activeMetric.value;
    /**
     * 身份签名。resetState 会递增每个 metric 的两个世代号，
     * 这里把它们记下来，回滚前比对。
     *
     * 不比对的话：A 的标记已读请求还在飞时 A 登出、B 登录，
     * 请求失败的 catch 会把 **A 的未读列表和计数**原样恢复进共享状态 ——
     * B 看到的是 A 的通知标题。乐观更新的回滚同样是一次写入，
     * 该受和取数一样的守卫。
     */
    const identityAtStart = identityEpoch.value;
    const sameIdentity = () => identityEpoch.value === identityAtStart;
    // 作废该 metric 上所有在途 GET：一个在写入**之前**就发出的请求，
    // 回来时带的是「还没读」的快照，会把刚标记已读的条目和计数原样恢复。
    // 变更必须让这些读作废，否则乐观更新会被自己的旧读覆盖掉。
    epochs.value[metric] = { all: epochs.value[metric].all + 1, unread: epochs.value[metric].unread + 1 };
    countGeneration.value[metric] += 1;
    const list = alerts.value[metric] ?? [];
    const target = list.find(item => item.id === id);
    const prevAck = target?.acknowledgedAt ?? null;
    // 递减而非按本地列表重算：列表只有最近 20 条，服务端可能有更多未读，
    // 重算会把徽标直接砍到本页未读数。
    const prevUnread = Number(unreadCount.value[metric] || 0);
    const prevUnreadList = unreadAlerts.value[metric] ?? [];

    // 「这条本来是未读吗」必须**两份缓存都看**。
    // 提醒流的条目取自未读桶，而含已读那份只有最近 20 条；一条较早的未读
    // 不在其中时，只看 target 会判成「本来就已读」而不递减徽标 ——
    // 结果条目从列表消失了，红点数字却纹丝不动。
    const inUnreadBucket = prevUnreadList.some(item => item.id === id);
    const wasUnread = inUnreadBucket || Boolean(target && !target.acknowledgedAt);

    if (target && !target.acknowledgedAt) {
      target.acknowledgedAt = new Date().toISOString();
    }
    if (wasUnread) {
      unreadCount.value[metric] = Math.max(0, prevUnread - 1);
    }
    // 未读口径那份只装未读，读掉一条就该移出去；否则提醒流会继续显示
    // 一条已经读过的条目，直到下一次重新取数
    unreadAlerts.value[metric] = prevUnreadList.filter(item => item.id !== id);
    try {
      const res = await $bff<{ ok: boolean; acknowledgedAt: string | null }>(`/alerts/${id}/read`, { method: 'POST' });
      if (!res?.ok && sameIdentity()) {
        unreadAlerts.value[metric] = prevUnreadList;
        // 计数回滚不能挂在 target 上：一条较早的未读可能只存在于未读桶里
        // （含已读那份只有最近 20 条），此时 target 是 undefined，
        // 乐观递减过的计数就永远回不来了 —— 列表恢复了、红点却少了一个。
        if (wasUnread) unreadCount.value[metric] = prevUnread;
      }
      if (!res?.ok && target && sameIdentity()) {
        target.acknowledgedAt = prevAck;
      } else if (res?.ok && target && sameIdentity()) {
        target.acknowledgedAt = res.acknowledgedAt ?? target.acknowledgedAt;
      }
    } catch (error) {
      console.warn('[alerts] mark read failed', error);
      // 换过身份就不要回滚 —— 那会把上一个账号的数据写进当前用户的界面
      if (!sameIdentity()) return;
      unreadAlerts.value[metric] = prevUnreadList;
      if (wasUnread) unreadCount.value[metric] = prevUnread;
      if (target) target.acknowledgedAt = prevAck;
    }
  }

  async function markAllAlertsRead(metric: AlertMetric = 'COMMENT_COUNT') {
    // 同 markAlertRead：成功后的写回若落在换账号之后，
    // 会把 B 的未读数错误地清成 0（直到下次刷新才纠正）。
    const identityAtStart = identityEpoch.value;
    // 同上：先作废在途 GET，再发起变更
    epochs.value[metric] = { all: epochs.value[metric].all + 1, unread: epochs.value[metric].unread + 1 };
    countGeneration.value[metric] += 1;
    try {
      const res = await $bff<{ ok: boolean; updated: number }>('/alerts/read-all', {
        method: 'POST',
        body: { metric: METRIC_QUERY_MAP[metric] }
      });
      if (res?.ok && identityEpoch.value === identityAtStart) {
        const nowIso = new Date().toISOString();
        alerts.value[metric] = (alerts.value[metric] ?? []).map(item => ({
          ...item,
          acknowledgedAt: item.acknowledgedAt ?? nowIso
        }));
        unreadAlerts.value[metric] = [];
        unreadCount.value[metric] = 0;
      }
    } catch (error) {
      console.warn('[alerts] mark all read failed', error);
    }
  }

  // Fetch all metrics (in parallel) for a unified, fresh view
  async function fetchAll(force = false, unreadOnly = false) {
    await Promise.all(ALERT_METRICS.map(m => fetchAlerts(m, force, unreadOnly)));
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

  /** 与 alertsAll 同形，但取自未读口径那份数据，供账号页提醒流使用 */
  const alertsAllUnread = computed(() => {
    const buckets = unreadAlerts.value;
    const flat: Array<AlertItem & { sourceMetric: AlertMetric } > = [];
    ALERT_METRICS.forEach((key) => {
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
  /** 任一指标的错误文案。fetchAll 会打三个请求，只看当前指标会漏报其余两个。 */
  const anyError = computed<string | null>(() => {
    for (const m of ALERT_METRICS) { const e = error.value[m]; if (e) return e; }
    return null;
  });

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
    alertsAllUnread,
    unreadAlerts,
    unreadLoading,
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
    anyError,
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
