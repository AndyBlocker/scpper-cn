/**
 * Wikidot 的修订号从 0 开始：`%%revisions%%` 与 CROM `revisionCount` 表示当前最大修订号，
 * 而 RevisionList / ingest.revision 的行数包含第 0 号修订，因此真实行数恒为声称值 + 1。
 */
export const REVISION_COUNT_OFFSET = 1;

/** 把 Wikidot/CROM 的零基修订声明值换算成 RevisionList 的真实行数。 */
export function revisionListCountFromClaimed(claimedTotal: number): number {
  return claimedTotal + REVISION_COUNT_OFFSET;
}

/** 判断零基声明值与 RevisionList/本地事实行数是否一致。 */
export function revisionCountsMatch(claimedTotal: number, revisionListCount: number): boolean {
  return revisionListCount === revisionListCountFromClaimed(claimedTotal);
}

/** 返回真实行数相对“声称值 + offset”的偏差；0 才是一致。 */
export function revisionCountDelta(claimedTotal: number, revisionListCount: number): number {
  return revisionListCount - revisionListCountFromClaimed(claimedTotal);
}

/**
 * 无远端声明值时，把已有真实事实数换算回可用于抓取护栏的零基声明值。
 * 尚未采到任何事实的页面以 0 兜底，不能制造负数声明值。
 */
export function claimedRevisionCountFromListCount(revisionListCount: number): number {
  return Math.max(0, revisionListCount - REVISION_COUNT_OFFSET);
}
