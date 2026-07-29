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

/**
 * 该用户**关闭了站内展示**的通知类型。
 *
 * 只返回显式关掉的那些：没有记录 = 默认开启。这样新用户不必先去设置页
 * 点一遍，也不会因为漏了一行记录而整类消失。
 *
 * 【为什么列表和计数必须用同一份结果】
 * 只过滤列表不过滤未读数的话，会出现「徽标显示 3 条未读、点进去空空如也」——
 * 用户无法消除那个红点，因为对应的条目根本不展示。
 */
export async function loadDisabledSiteTypes(pool: Pool, userId: number): Promise<Set<NotifyType>> {
  const { rows } = await pool.query(
    'SELECT "type" FROM "UserNotificationPreference" WHERE "userId" = $1 AND "siteEnabled" = false',
    [userId]
  );
  return new Set(rows.map((r: { type: string }) => r.type as NotifyType));
}
