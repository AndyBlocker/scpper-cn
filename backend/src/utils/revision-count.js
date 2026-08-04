/**
 * Wikidot/CROM 的 revisionCount 是从 0 开始的最大修订号；
 * Revision 列表/表行数包含 revision 0，因此真实行数恒为声明值 + offset。
 */
export const REVISION_COUNT_OFFSET = 1;

/** @param {number} claimedTotal */
export function revisionListCountFromClaimed(claimedTotal) {
  return claimedTotal + REVISION_COUNT_OFFSET;
}
