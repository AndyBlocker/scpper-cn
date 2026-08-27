import type { L0ListPageRow, L1ListPageRow } from './incrementalListPages.js';

export interface IncrementalDiffState {
  lastL0Revision: number | null;
  lastL0UpdatedAt: string | null;
  lastL1Revision: number | null;
  lastL1Rating: number | null;
  lastL1RatingVotes: number | null;
}

interface L0DiffRow {
  current: L0ListPageRow;
  previous: IncrementalDiffState | null;
  revisionChanged: boolean;
  updatedAtChangedWithoutRevision: boolean;
}

export interface L0Diff {
  changed: L0DiffRow[];
  unchanged: number;
  revisionRegressions: string[];
}

interface L1DiffRow {
  current: L1ListPageRow;
  previous: IncrementalDiffState | null;
  voteChanged: boolean;
  revisionChanged: boolean;
  l0CapturedRevision: boolean;
}

export interface L1Diff {
  bootstrap: boolean;
  changed: L1DiffRow[];
  voteChanges: L1DiffRow[];
  revisionChanges: L1DiffRow[];
  revisionMisses: L1DiffRow[];
  unchanged: number;
  revisionRegressions: string[];
}

export function diffL0Rows(
  rows: readonly L0ListPageRow[],
  states: ReadonlyMap<string, IncrementalDiffState>,
): L0Diff {
  const changed: L0DiffRow[] = [];
  const revisionRegressions: string[] = [];
  let unchanged = 0;
  for (const current of rows) {
    const previous = states.get(current.fullname) ?? null;
    if (
      previous?.lastL0Revision !== null &&
      previous?.lastL0Revision !== undefined &&
      current.revisions < previous.lastL0Revision
    ) {
      revisionRegressions.push(current.fullname);
      continue;
    }
    const revisionChanged =
      previous?.lastL0Revision === null ||
      previous?.lastL0Revision === undefined ||
      current.revisions !== previous.lastL0Revision;
    const updatedAtChanged =
      previous?.lastL0UpdatedAt !== null &&
      previous?.lastL0UpdatedAt !== undefined &&
      current.updatedAt !== previous.lastL0UpdatedAt;
    const updatedAtChangedWithoutRevision = !revisionChanged && updatedAtChanged;
    if (revisionChanged || updatedAtChangedWithoutRevision) {
      changed.push({ current, previous, revisionChanged, updatedAtChangedWithoutRevision });
    } else {
      unchanged++;
    }
  }
  return { changed, unchanged, revisionRegressions };
}

export function diffL1Rows(
  rows: readonly L1ListPageRow[],
  states: ReadonlyMap<string, IncrementalDiffState>,
  hasBaseline: boolean,
): L1Diff {
  const changed: L1DiffRow[] = [];
  const voteChanges: L1DiffRow[] = [];
  const revisionChanges: L1DiffRow[] = [];
  const revisionMisses: L1DiffRow[] = [];
  const revisionRegressions: string[] = [];
  let unchanged = 0;

  for (const current of rows) {
    const previous = states.get(current.fullname) ?? null;
    if (
      previous?.lastL1Revision !== null &&
      previous?.lastL1Revision !== undefined &&
      current.revisions < previous.lastL1Revision
    ) {
      revisionRegressions.push(current.fullname);
      continue;
    }
    // 没有上一轮 L1 值时只建修订基线，不能把首次看到/刚解析到的 slug
    // 算成“跨轮修订变化”，否则长期 mismatch 的分区会在每轮污染 L0 覆盖率。
    // 新 slug 仍由 voteChanged + pending/resolver 的 new_page_highfreq 链路接住。
    const hasPrevious = previous?.lastL1Revision !== null && previous?.lastL1Revision !== undefined;
    const voteChanged =
      hasBaseline &&
      (!hasPrevious ||
        current.rating !== previous?.lastL1Rating ||
        current.ratingVotes !== previous?.lastL1RatingVotes);
    const revisionChanged =
      hasBaseline && hasPrevious && current.revisions !== previous.lastL1Revision;
    const l0CapturedRevision =
      revisionChanged &&
      previous?.lastL0Revision !== null &&
      previous?.lastL0Revision !== undefined &&
      previous.lastL0Revision >= current.revisions;
    const row = {
      current,
      previous,
      voteChanged,
      revisionChanged,
      l0CapturedRevision,
    };
    if (voteChanged || revisionChanged) changed.push(row);
    else unchanged++;
    if (voteChanged) voteChanges.push(row);
    if (revisionChanged) {
      revisionChanges.push(row);
      if (!l0CapturedRevision) revisionMisses.push(row);
    }
  }

  return {
    bootstrap: !hasBaseline,
    changed,
    voteChanges,
    revisionChanges,
    revisionMisses,
    unchanged,
    revisionRegressions,
  };
}
