import type { PageSnapshotEntry, PageSnapshotMap } from '../scanner/PageScanner.js';

export type ChangeCategory = 'new_page' | 'deleted_page' | 'votes_changed' | 'content_changed' | 'metadata_changed';

export type PageChange = {
  fullname: string;
  categories: Set<ChangeCategory>;
  prev: PageSnapshotEntry | null;
  curr: PageSnapshotEntry | null;
};

/**
 * 全字段差异检测：比较两个 PageSnapshotMap，按变化类型分类
 */
export function diffPages(
  previous: PageSnapshotMap,
  current: PageSnapshotMap
): PageChange[] {
  const changes: PageChange[] = [];

  for (const [fullname, curr] of current) {
    const prev = previous.get(fullname);
    if (!prev) {
      changes.push({
        fullname,
        categories: new Set(['new_page']),
        prev: null,
        curr,
      });
      continue;
    }

    const cats = new Set<ChangeCategory>();

    // 投票变化
    if (prev.rating !== curr.rating || prev.votesCount !== curr.votesCount) {
      cats.add('votes_changed');
    }

    // 内容变化
    if (prev.revisionsCount !== curr.revisionsCount || prev.size !== curr.size) {
      cats.add('content_changed');
    }

    // 元数据变化
    if (
      prev.title !== curr.title ||
      prev.commentsCount !== curr.commentsCount ||
      prev.parentFullname !== curr.parentFullname ||
      !arraysEqual(prev.tags, curr.tags) ||
      prev.createdBy !== curr.createdBy
    ) {
      cats.add('metadata_changed');
    }

    if (cats.size > 0) {
      changes.push({ fullname, categories: cats, prev, curr });
    }
  }

  // 删除检测
  for (const [fullname, prev] of previous) {
    if (!current.has(fullname)) {
      changes.push({
        fullname,
        categories: new Set(['deleted_page']),
        prev,
        curr: null,
      });
    }
  }

  return changes;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 按类型汇总统计 */
export function summarizeChanges(changes: PageChange[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const c of changes) {
    for (const cat of c.categories) {
      summary[cat] = (summary[cat] || 0) + 1;
    }
  }
  return summary;
}
