/**
 * 活 v1 与 v2 自铸身份的 id 命名空间策略。
 *
 * v1 的 Page.id / User.id 在回填期间仍持续增长，所以“当前 max(id) + 1”不是边界。
 * v2 自铸 page 从 1,500,000,000 起；匿名署名以及 ensure_user 自铸的 guest /
 * synthetic / 新 Wikidot actor 从 2,000,000,000 起。两段都仍在 int4 正数域内，
 * 而 v1 身份由 top-up 显式保留原 id，不消费这些序列。
 *
 * user 段选择 2,000,000,000 的来由：2026-07-28 v1 User.max(id)=283,404,101，
 * 起点大于当时上界的 7 倍，并保留 147,483,648 个正 int4 id。full gate 每次都
 * 重验这个倍率；v1 若逼近预警线，gate 会在发生命名空间碰撞之前硬失败。
 */
export const INT4_MAX = 2_147_483_647;
export const V2_RESERVED_PAGE_ID_START = 1_500_000_000;
export const V2_RESERVED_ANONYMOUS_ACTOR_ID_START = 2_000_000_000;
export const V1_USER_ID_SAFETY_FACTOR = 7;

export interface AnonymousActorSafety {
  actorCount: number;
  minimumActorId: number | null;
  v1MaximumUserId: number;
  requiredExclusiveFloor: number;
  ok: boolean;
}

/** 与 full backfill gate 相同的结构性边界断言，供 S4 dry-run/execute 共用。 */
export function anonymousActorSafety(
  actorIds: readonly number[],
  v1MaximumUserId: number,
): AnonymousActorSafety {
  if (!Number.isSafeInteger(v1MaximumUserId) || v1MaximumUserId < 0) {
    throw new Error(`v1MaximumUserId 非法：${v1MaximumUserId}`);
  }
  for (const id of actorIds) {
    if (!Number.isSafeInteger(id) || id <= 0 || id > INT4_MAX) {
      throw new Error(`匿名 actor id 非法：${id}`);
    }
  }

  const minimumActorId = actorIds.length === 0 ? null : Math.min(...actorIds);
  const requiredExclusiveFloor = v1MaximumUserId * V1_USER_ID_SAFETY_FACTOR;
  return {
    actorCount: actorIds.length,
    minimumActorId,
    v1MaximumUserId,
    requiredExclusiveFloor,
    ok:
      minimumActorId === null ||
      (minimumActorId >= V2_RESERVED_ANONYMOUS_ACTOR_ID_START &&
        minimumActorId > requiredExclusiveFloor),
  };
}
