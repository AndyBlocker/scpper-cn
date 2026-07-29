import type { Pool } from 'pg';

/** 与主库 NotificationTypeKey 枚举一一对应 */
export type NotifyType =
  | 'PAGE_COMMENT' | 'PAGE_VOTE' | 'PAGE_REVISION'
  | 'FOLLOW_ACTIVITY' | 'FORUM_INTERACTION';

/** 页面指标 → 通知类型。三个提醒路由共用，避免各写一份对照表而写歪。 */
export const METRIC_TO_NOTIFY_TYPE: Record<string, NotifyType> = {
  COMMENT_COUNT: 'PAGE_COMMENT',
  VOTE_COUNT: 'PAGE_VOTE',
  REVISION_COUNT: 'PAGE_REVISION'
};

/** 站内展示的可见性：哪些类型整个关掉了，以及每个类型的抑制边界。 */
export interface SiteVisibility {
  /** 显式关掉站内展示的类型；没有记录 = 默认开启 */
  disabled: Set<NotifyType>;
  /**
   * 每个类型最近一次切换站内开关的时刻。展示侧只显示**晚于**它的告警。
   *
   * 关闭只是遮蔽，产出侧照旧在写告警。没有这个边界的话，重新开启的瞬间
   * 关闭期间攒下的会全部涌出，变成一大堆「新未读」。
   *
   * 【为什么不直接把那些告警标成已读】
   * acknowledgedAt 的含义是「用户读过了」，QQ 投递器正是拿它判断「不必再推」。
   * 用它表达「站内不再显示」，在「站内关掉但 QQ 仍开着」这个核心场景下会分叉 ——
   * 站内一关，待发的 QQ 通知被一起杀掉。两个渠道必须完全独立。
   */
  suppressedBefore: Map<NotifyType, Date>;
}

/**
 * 读取该用户的站内展示可见性。
 *
 * 【为什么列表和计数必须用同一份结果】
 * 只过滤列表不过滤未读数的话，会出现「徽标显示 3 条未读、点进去空空如也」——
 * 用户无法消除那个红点，因为对应的条目根本不展示。
 */
export async function loadSiteVisibility(pool: Pool, userId: number): Promise<SiteVisibility> {
  const { rows } = await pool.query(
    'SELECT "type", "siteEnabled", "siteSuppressedBefore" FROM "UserNotificationPreference" WHERE "userId" = $1',
    [userId]
  );
  const disabled = new Set<NotifyType>();
  const suppressedBefore = new Map<NotifyType, Date>();
  for (const r of rows as Array<{ type: string; siteEnabled: boolean; siteSuppressedBefore: Date | null }>) {
    const t = r.type as NotifyType;
    if (!r.siteEnabled) disabled.add(t);
    if (r.siteSuppressedBefore) suppressedBefore.set(t, r.siteSuppressedBefore);
  }
  return { disabled, suppressedBefore };
}

/**
 * 生成「只显示抑制边界之后的告警」这一段 SQL，并把参数追加进 params。
 *
 * 五个读取点各写一遍容易写歪（尤其是列表和未读数这一对，写歪就是消不掉的红点），
 * 统一在这里生成。没有边界时返回空串，查询保持原样。
 *
 * @param alias 表别名；传空串表示不带别名（形如 `"detectedAt"`）
 */
export function siteBoundaryClause(
  boundary: Date | undefined,
  params: unknown[],
  alias: string
): string {
  params.push(boundary ?? null);
  const col = alias ? `${alias}."detectedAt"` : '"detectedAt"';
  // NULL 容忍写法：没有边界时谓词恒真，查询与改动前完全等价。
  // 这样固定位置参数的查询也能用同一套，不必为「有没有边界」写两个分支。
  return `AND ($${params.length}::timestamp IS NULL OR ${col} >= $${params.length})`;
}
