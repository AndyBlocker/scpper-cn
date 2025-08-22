import { Logger } from '../../utils/Logger.js';

export function arraysEqual(a: any[] | undefined | null, b: any[] | undefined | null): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Decide whether a new PageVersion should be created.
 * Only content/structure changes should trigger a new version; statistics like rating/voteCount should not.
 */
export function shouldCreateNewVersion(currentVersion: any | null | undefined, newData: any): boolean {
  if (!currentVersion) return true;

  try {
    const titleChanged = currentVersion.title !== newData.title && newData.title !== undefined;
    const categoryChanged = (currentVersion.category ?? null) !== (newData.category ?? null) && newData.category !== undefined;
    const tagsChanged = newData.tags !== undefined && !arraysEqual(currentVersion.tags ?? [], newData.tags ?? []);
    const sourceChanged = newData.source !== undefined && currentVersion.source !== newData.source;
    const textChanged = newData.textContent !== undefined && currentVersion.textContent !== newData.textContent;

    return Boolean(titleChanged || categoryChanged || tagsChanged || sourceChanged || textChanged);
  } catch (e) {
    // Be safe: if we cannot determine, do not create a new version by default
    Logger.warn('shouldCreateNewVersion failed to compare; defaulting to no new version');
    return false;
  }
}


