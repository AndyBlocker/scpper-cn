type Counts = { upvotes?: unknown; downvotes?: unknown }
type Stats = { hasStats?: boolean; uv?: unknown; dv?: unknown }

// Keep availability and displayed counts on the same source. Empty vote rows
// cannot establish zero votes when the page still has a nonzero snapshot.
export function resolvePageVoteMetrics(distribution: Counts | null | undefined, stats: Stats | null | undefined, voteCount: unknown) {
  const valid = (up: unknown, down: unknown) => up != null && down != null
    && Number.isInteger(Number(up)) && Number(up) >= 0
    && Number.isInteger(Number(down)) && Number(down) >= 0
  const snapshotEmpty = voteCount != null && Number(voteCount) === 0
  if (distribution && valid(distribution.upvotes, distribution.downvotes)) {
    const upvotes = Number(distribution.upvotes)
    const downvotes = Number(distribution.downvotes)
    if (upvotes + downvotes > 0 || snapshotEmpty) return { available: true, upvotes, downvotes }
  }
  if (stats?.hasStats && valid(stats.uv, stats.dv)) {
    const upvotes = Number(stats.uv)
    const downvotes = Number(stats.dv)
    if (upvotes + downvotes > 0 || snapshotEmpty) return { available: true, upvotes, downvotes }
  }
  return { available: false, upvotes: 0, downvotes: 0 }
}
