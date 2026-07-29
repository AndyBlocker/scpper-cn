import { computed, ref } from 'vue'
import { useAlerts, type AlertItem, type AlertMetric } from '~/composables/useAlerts'
import { useFollowAlerts, type FollowAlertItem } from '~/composables/useFollowAlerts'
import { useForumInteractionAlerts, type ForumInteractionAlertItem } from '~/composables/useForumInteractionAlerts'
import { formatDateTimeUtc8 } from '~/utils/timezone'

/**
 * 把三套互不相通的提醒合成**一条时间线**。
 *
 * 重设计的动机：原来的账号页把「页面/关注/论坛」三个来源做成一组 pill，
 * 又叠了「按指标/按页面」第二组 pill，用户要在 3×2 的组合里找自己的消息，
 * 而每种组合的空态文案、已读按钮、渲染结构都不一样。
 * 这里改为：一条按时间倒序的流 + 一组类型筛选，所有条目结构一致。
 *
 * 本文件只做**读侧聚合与写侧分发**，不自己发请求 ——
 * 三个来源各自的取数、缓存与错误状态仍归各自的 composable。
 */

export type FeedKind = 'page' | 'follow' | 'forum'

export interface FeedItem {
  /** v-for 的 key，也是标记已读时定位来源的依据 */
  key: string
  kind: FeedKind
  id: number
  /** page 类型才有，用于「按指标标记已读」 */
  metric?: AlertMetric
  /** 主文案 */
  title: string
  /** 次要说明（可空） */
  detail: string | null
  /** 点击跳转目标 */
  href: string | null
  detectedAt: string
  /** 本地化后的时间，统一 UTC+8 且带年份 */
  timeLabel: string
  read: boolean
}

const KIND_LABEL: Record<FeedKind, string> = {
  page: '我的页面',
  follow: '关注的人',
  forum: '论坛'
}

const METRIC_VERB: Record<AlertMetric, string> = {
  COMMENT_COUNT: '收到新评论',
  VOTE_COUNT: '投票有变化',
  REVISION_COUNT: '被编辑'
}

function pageTitleOf(a: { pageTitle: string | null; pageAlternateTitle: string | null; pageUrl: string | null }): string {
  const t = a.pageTitle?.trim()
  const alt = a.pageAlternateTitle?.trim()
  if (t && alt) return `${t}（${alt}）`
  return t || alt || a.pageUrl || '未知页面'
}

function signed(n: number | null | undefined): string {
  const v = Number(n)
  if (!Number.isFinite(v) || v === 0) return ''
  return v > 0 ? `+${v}` : String(v)
}

export function useNotificationFeed() {
  const pageAlerts = useAlerts()
  const followAlerts = useFollowAlerts()
  const forumAlerts = useForumInteractionAlerts()

  /** 类型筛选。null = 全部 */
  const kindFilter = ref<FeedKind | null>(null)
  /** 是否显示已读条目。切换会改变向服务端请求的口径，故需重新取数。 */
  const showRead = ref(false)

  /**
   * 按当前口径选数据源。
   *
   * 三个 composable 各存两份：alerts（含已读，铃铛用）与 unreadAlerts（仅未读，这里用）。
   * 铃铛常驻 layout 且随时可能刷新，两份合一时它一取数就会把提醒流的未读列表冲掉 ——
   * 「列表空着但徽标有数字」正是这么来的。分开存之后，两边各读各的，互不影响。
   */
  const activePageAlerts = computed(() =>
    showRead.value ? pageAlerts.alertsAll.value : pageAlerts.alertsAllUnread.value
  )
  const activeFollowAlerts = computed(() =>
    showRead.value ? followAlerts.alerts.value : followAlerts.unreadAlerts.value
  )
  const activeForumAlerts = computed(() =>
    showRead.value ? forumAlerts.alerts.value : forumAlerts.unreadAlerts.value
  )


  const pageItems = computed<FeedItem[]>(() =>
    (activePageAlerts.value as Array<AlertItem & { sourceMetric: AlertMetric }>).map((a) => {
      const delta = signed(a.diffValue)
      return {
        key: `page:${a.id}`,
        kind: 'page' as const,
        id: a.id,
        metric: a.sourceMetric,
        title: `《${pageTitleOf(a)}》${METRIC_VERB[a.sourceMetric] ?? '有变化'}`,
        detail: delta ? `${delta}（现为 ${a.newValue ?? '—'}）` : null,
        href: a.pageWikidotId ? `/page/${a.pageWikidotId}` : null,
        detectedAt: a.detectedAt,
        timeLabel: formatDateTimeUtc8(a.detectedAt),
        read: Boolean(a.acknowledgedAt)
      }
    })
  )

  const followItems = computed<FeedItem[]>(() =>
    (activeFollowAlerts.value as FollowAlertItem[]).map((a) => {
      const who = a.targetDisplayName || `用户 ${a.targetWikidotId ?? a.targetUserId}`
      const verb = a.type === 'REVISION' ? '编辑了' : a.type === 'ATTRIBUTION' ? '发布了' : '不再署名于'
      return {
        key: `follow:${a.id}`,
        kind: 'follow' as const,
        id: a.id,
        title: `${who} ${verb}《${pageTitleOf(a)}》`,
        detail: null,
        href: a.pageWikidotId ? `/page/${a.pageWikidotId}` : null,
        detectedAt: a.detectedAt,
        timeLabel: formatDateTimeUtc8(a.detectedAt),
        read: Boolean(a.acknowledgedAt)
      }
    })
  )

  const forumItems = computed<FeedItem[]>(() =>
    (activeForumAlerts.value as ForumInteractionAlertItem[]).map((a) => {
      const actor = a.actorName || '有人'
      const verb = a.type === 'MENTION' ? '提到了你' : a.type === 'DIRECT_REPLY' ? '回复了你' : '在讨论中发言'
      return {
        key: `forum:${a.id}`,
        kind: 'forum' as const,
        id: a.id,
        title: `${actor} ${verb}${a.postTitle ? `：${a.postTitle}` : ''}`,
        detail: a.postExcerpt || null,
        // 路由是 pages/forums/t/[id].vue，且要带 postId 才能定位到具体楼层。
        // 写成 /forums/t-<id> 会直接 404（layouts/default.vue:669 与 search.vue 用的都是这个格式）
        href: a.threadId ? `/forums/t/${a.threadId}${a.postId ? `?postId=${a.postId}` : ''}` : null,
        detectedAt: a.detectedAt,
        timeLabel: formatDateTimeUtc8(a.detectedAt),
        read: Boolean(a.acknowledgedAt)
      }
    })
  )

  /** 合流并按时间倒序。ISO 字符串可直接比较，无需 new Date。 */
  const allItems = computed<FeedItem[]>(() =>
    [...pageItems.value, ...followItems.value, ...forumItems.value]
      .sort((a, b) => String(b.detectedAt).localeCompare(String(a.detectedAt)))
  )

  const items = computed<FeedItem[]>(() =>
    allItems.value.filter((it) => {
      if (kindFilter.value && it.kind !== kindFilter.value) return false
      if (!showRead.value && it.read) return false
      return true
    })
  )

  /**
   * 「服务端说还有未读，但当前这一页里一条未读都没有」。
   *
   * 每个来源只返回最近 20 条，用户把它们逐条读完、更早的未读还在时，
   * 就会看到徽标有数字、列表却说「没有未读提醒」。UI 据此提示如何看到它们，
   * 而不是让用户对着矛盾的界面发愣。
   */
  const hasHiddenUnread = computed(() => {
    if (showRead.value || items.value.length > 0) return false
    // 有类型筛选时只看该类型的未读数。用全局总数的话，
    // 「页面有未读、但筛选停在关注」会让面板谎称「关注还有更早的未读」。
    const relevant = kindFilter.value ? unreadByKind.value[kindFilter.value] : totalUnread.value
    return relevant > 0
  })

  const unreadByKind = computed<Record<FeedKind, number>>(() => ({
    // 未读数取各 composable 的服务端计数，而不是数当前列表 ——
    // 列表只有最近 20 条，数它会系统性少报。
    page: Number(pageAlerts.totalUnread.value) || 0,
    follow: Number(followAlerts.unreadCount.value) || 0,
    forum: Number(forumAlerts.unreadCount.value) || 0
  }))

  /**
   * 总未读。原实现用 Math.max 取三者最大值，系统性少报
   * （3+2+1 会显示成 3）；这里改为求和。
   */
  const totalUnread = computed(() =>
    unreadByKind.value.page + unreadByKind.value.follow + unreadByKind.value.forum
  )

  const loading = computed(() => {
    if (showRead.value) {
      return Boolean(pageAlerts.loading.value || followAlerts.loading.value || forumAlerts.loading.value)
    }
    // 未读口径有自己的 loading：看含已读那份的话，铃铛在后台取数会让
    // 提醒流平白转圈，而它自己其实早就加载完了
    return Boolean(
      Object.values(pageAlerts.unreadLoading.value).some(Boolean)
      || followAlerts.unreadLoading.value
      || forumAlerts.unreadLoading.value
    )
  })

  /**
   * 任一来源出错就暴露出来，让 UI 能渲染「加载失败，重试」而不是假装「暂无提醒」。
   * 页面提醒用 anyError 而非 error：fetchAll 会打三个指标的请求，
   * 只看当前选中指标会漏掉另外两个的失败，界面看起来「加载完整」但少了一类。
   */
  const error = computed<string | null>(() =>
    pageAlerts.anyError.value || followAlerts.error.value || forumAlerts.error.value || null
  )

  async function refresh(force = true) {
    // 不看已读时直接向服务端要未读，而不是取最近 20 条再在客户端筛。
    // 后者会让「最新 20 条都读过、更早的未读还在」的用户看到空列表而徽标仍有数字。
    const unreadOnly = !showRead.value

    // 两种口径各存各的数据、各有各的时间戳，这里只管按当前口径要数就行。
    // 曾经试过在这一层记「上次用的是哪个口径」，但铃铛直接调底层 composable、
    // 绕过了这一层；后来把口径记到数据旁边，仍然挡不住铃铛把提醒流的未读列表
    // 整个覆盖掉 —— 只要两者共用一个数组，就总有一方在破坏另一方。
    // 现在是两份独立数据，问题从根上消失了。
    await Promise.all([
      pageAlerts.fetchAll(force, unreadOnly),
      followAlerts.fetchAlerts(force, 20, 0, unreadOnly),
      forumAlerts.fetchAlerts(force, 20, 0, unreadOnly)
    ])
  }

  /** 单条已读：按 kind 分发到对应 composable。三套的接口签名不同，这里收口。 */
  async function markRead(item: FeedItem): Promise<void> {
    if (item.read) return
    if (item.kind === 'page') {
      await pageAlerts.markAlertRead(item.id, item.metric)
    } else if (item.kind === 'follow') {
      await followAlerts.markRead(item.id)
    } else {
      await forumAlerts.markRead(item.id)
    }
  }

  /** 全部已读：三套都要清，缺一个就会出现「铃铛归零但列表还有未读」 */
  async function markAllRead(): Promise<void> {
    await Promise.all([
      pageAlerts.markAllRead('ALL'),
      followAlerts.markAllRead(),
      forumAlerts.markAllRead()
    ])
    await refresh(true)
  }

  return {
    items,
    allItems,
    kindFilter,
    showRead,
    unreadByKind,
    totalUnread,
    hasHiddenUnread,
    loading,
    error,
    refresh,
    markRead,
    markAllRead,
    KIND_LABEL
  }
}
