/**
 * v1 → v2 S4/S5/S6 的纯转换层。
 *
 * 这层刻意不接受 slug 作为署名输入：存量署名的 page_id 只能由
 * Attribution.pageVerId → PageVersion.pageId 得到。dry-run、正式写入和测试共用这些
 * 转换，避免预演与落库各自解释一遍历史数据。
 */

import {
  INT4_MAX,
  V2_RESERVED_ANONYMOUS_ACTOR_ID_START,
} from './id-policy.js';

export interface V1AttributionRow {
  id: number;
  page_version_id: number;
  page_id: number;
  page_wikidot_id: number;
  user_id: number | null;
  anon_key: string | null;
  role: string;
  ord: number;
  at_date: string | null;
}

export interface ExistingAnonActor {
  id: number;
  anon_key: string;
}

export interface AnonymousActorPlan {
  id: number;
  anonKey: string;
  displayName: string;
}

export interface MappedAttributionPlan {
  v1AttributionId: number;
  v1PageVersionId: number;
  pageId: number;
  wikidotId: number;
  v1UserId: number | null;
  anonKey: string | null;
  actorId: number;
  role: string;
  ord: number;
  atDate: string | null;
}

export interface AttributionCarryoverPlan {
  anonymousActors: AnonymousActorPlan[];
  mappedRows: MappedAttributionPlan[];
  currentRows: Array<MappedAttributionPlan & { isDisplay: boolean }>;
}

function assertPositiveInt(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} 必须是正的安全整数，拿到 ${value}`);
  }
}

/**
 * 给 v1 没有 User.id 的匿名署名铸稳定 actor。
 *
 * anon_key 原样保留；displayName 只剥已有的 `anon:` 展示前缀，不反推、不合并名字。
 * 新 id 只从 v2 保留高位段顺序分配。targetUserAllocationHighWater 同时包含表内
 * max(id) 与 user_id_seq 已交付水位，因而不会复用已由回滚事务消费过的 id。
 * 这条策略不依赖仍在增长的 v1 当前上界。
 */
export function buildAttributionCarryoverPlan(
  rows: readonly V1AttributionRow[],
  existingAnonActors: readonly ExistingAnonActor[],
  targetUserAllocationHighWater: number,
): AttributionCarryoverPlan {
  if (
    !Number.isSafeInteger(targetUserAllocationHighWater) ||
    targetUserAllocationHighWater < 0
  ) {
    throw new Error(
      `targetUserAllocationHighWater 非法：${targetUserAllocationHighWater}`,
    );
  }

  const actorByAnonKey = new Map<string, number>();
  for (const actor of existingAnonActors) {
    assertPositiveInt(actor.id, 'existing anon actor id');
    if (!actor.anon_key.startsWith('anon:')) {
      throw new Error(`目标 anon actor 的 anon_key 缺少 anon: 前缀：${actor.anon_key}`);
    }
    const previous = actorByAnonKey.get(actor.anon_key);
    if (previous !== undefined && previous !== actor.id) {
      throw new Error(`目标 anon_key=${actor.anon_key} 对应多个 actor id`);
    }
    actorByAnonKey.set(actor.anon_key, actor.id);
  }

  const missingKeys = [...new Set(rows
    .filter((row) => row.user_id === null)
    .map((row) => {
      if (row.anon_key === null || !row.anon_key.startsWith('anon:')) {
        throw new Error(
          `Attribution.id=${row.id} 的 userId IS NULL 但 anonKey 不是 anon: 原始键`,
        );
      }
      return row.anon_key;
    })
    .filter((key) => !actorByAnonKey.has(key)))]
    .sort((a, b) => a.localeCompare(b));

  const allocationFloor = Math.max(
    targetUserAllocationHighWater,
    V2_RESERVED_ANONYMOUS_ACTOR_ID_START - 1,
  );
  if (allocationFloor + missingKeys.length > INT4_MAX) {
    throw new Error(
      `匿名署名需要 ${missingKeys.length} 个 actor，会越过 int4 上界` +
        `（保留段已交付水位=${allocationFloor}）`,
    );
  }

  const anonymousActors = missingKeys.map((anonKey, index) => {
    const id = allocationFloor + index + 1;
    actorByAnonKey.set(anonKey, id);
    return {
      id,
      anonKey,
      displayName: anonKey.slice('anon:'.length),
    };
  });

  const mappedRows = rows.map((row): MappedAttributionPlan => {
    assertPositiveInt(row.id, 'Attribution.id');
    assertPositiveInt(row.page_version_id, `Attribution.id=${row.id} pageVerId`);
    assertPositiveInt(row.page_id, `Attribution.id=${row.id} mapped pageId`);
    assertPositiveInt(row.page_wikidot_id, `Attribution.id=${row.id} page wikidotId`);
    if (row.role.trim() === '') throw new Error(`Attribution.id=${row.id} role 为空`);
    if (!Number.isInteger(row.ord) || row.ord < 0) {
      throw new Error(`Attribution.id=${row.id} order 非法：${row.ord}`);
    }

    let actorId: number;
    if (row.user_id !== null) {
      assertPositiveInt(row.user_id, `Attribution.id=${row.id} userId`);
      if (row.anon_key !== null) {
        throw new Error(`Attribution.id=${row.id} 同时带 userId 与 anonKey，拒绝猜优先级`);
      }
      actorId = row.user_id;
    } else {
      if (row.anon_key === null || !row.anon_key.startsWith('anon:')) {
        throw new Error(`Attribution.id=${row.id} 缺合法 anonKey`);
      }
      const mapped = actorByAnonKey.get(row.anon_key);
      if (mapped === undefined) throw new Error(`anonKey=${row.anon_key} 未分配 actor`);
      actorId = mapped;
    }

    return {
      v1AttributionId: row.id,
      v1PageVersionId: row.page_version_id,
      pageId: row.page_id,
      wikidotId: row.page_wikidot_id,
      v1UserId: row.user_id,
      anonKey: row.anon_key,
      actorId,
      role: row.role.toUpperCase(),
      ord: row.ord,
      atDate: row.at_date,
    };
  });

  // v2 当前态的自然键是 (page, role, actor)。v1 的相同署名可能随 PageVersion 被复制；
  // 以 order、pageVerId、Attribution.id 稳定择一，完整原始行仍全部保存在映射审计表。
  const selected = new Map<string, MappedAttributionPlan>();
  for (const row of [...mappedRows].sort(
    (a, b) =>
      a.pageId - b.pageId ||
      a.role.localeCompare(b.role) ||
      a.actorId - b.actorId ||
      a.ord - b.ord ||
      a.v1PageVersionId - b.v1PageVersionId ||
      a.v1AttributionId - b.v1AttributionId,
  )) {
    const key = `${row.pageId}\0${row.role}\0${row.actorId}`;
    if (!selected.has(key)) selected.set(key, row);
  }

  const byPage = new Map<number, MappedAttributionPlan[]>();
  for (const row of selected.values()) {
    const group = byPage.get(row.pageId);
    if (group) group.push(row);
    else byPage.set(row.pageId, [row]);
  }

  const currentRows: Array<MappedAttributionPlan & { isDisplay: boolean }> = [];
  for (const group of byPage.values()) {
    const hasNonSubmitter = group.some((row) => row.role !== 'SUBMITTER');
    for (const row of group) {
      currentRows.push({
        ...row,
        // 只有 SUBMITTER 时必须展示；出现其它角色后才抑制 SUBMITTER。
        isDisplay: !(row.role === 'SUBMITTER' && hasNonSubmitter),
      });
    }
  }
  currentRows.sort(
    (a, b) =>
      a.pageId - b.pageId ||
      a.role.localeCompare(b.role) ||
      a.ord - b.ord ||
      a.actorId - b.actorId,
  );

  return { anonymousActors, mappedRows, currentRows };
}

export interface V1PageLifeRow {
  page_id: number;
  wikidot_id: number;
  current_slug: string;
  page_is_deleted: boolean;
  current_version_is_deleted: boolean;
  first_published_at: string | null;
  page_created_at: string;
  tombstone_at: string | null;
  last_vote_at: string | null;
  last_revision_at: string | null;
  legacy_fingerprint: boolean;
  current_version_id: number;
  title: string | null;
  alternate_title: string | null;
  tags: string[] | null;
  category: string | null;
  search_text: string | null;
}

export interface PageLifePlan extends V1PageLifeRow {
  createdAt: string;
  createdPrecision: 'exact' | 'inferred';
  resolvedDeleted: boolean;
  deletedAt: string | null;
  deletedPrecision: 'inferred' | null;
  deletionSource: 'legacy_import_2025_11' | 'v1_backfill' | null;
  usedActivityFallback: boolean;
  divergent: boolean;
}

function epoch(value: string | null): number | null {
  if (value === null) return null;
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error(`非法 UTC 时间：${value}`);
  return result;
}

function later(a: string | null, b: string | null): string | null {
  const ae = epoch(a);
  const be = epoch(b);
  if (ae === null) return b;
  if (be === null) return a;
  return ae >= be ? a : b;
}

/**
 * Page.isDeleted 只作为迁移输入生成事件；落库后 status 只能由 page_life_event 翻转。
 * tombstone 早于末票/末修订是已知不可信指纹，此时严格改用 GREATEST(末票,末修订)。
 */
export function buildPageLifePlan(row: V1PageLifeRow): PageLifePlan {
  assertPositiveInt(row.page_id, 'Page.id');
  assertPositiveInt(row.wikidot_id, `Page.id=${row.page_id} wikidotId`);
  assertPositiveInt(row.current_version_id, `Page.id=${row.page_id} current PageVersion.id`);
  if (row.current_slug === '') throw new Error(`Page.id=${row.page_id} current slug 为空`);

  const activity = later(row.last_vote_at, row.last_revision_at);
  const tombEpoch = epoch(row.tombstone_at);
  const activityEpoch = epoch(activity);
  const usedActivityFallback =
    row.page_is_deleted &&
    activityEpoch !== null &&
    (tombEpoch === null || tombEpoch < activityEpoch);
  const deletedAt = row.page_is_deleted
    ? (usedActivityFallback ? activity : row.tombstone_at ?? activity)
    : null;

  if (row.page_is_deleted && deletedAt === null) {
    throw new Error(`Page.id=${row.page_id} 已删但 tombstone/末票/末修订全空`);
  }

  return {
    ...row,
    createdAt: row.first_published_at ?? row.page_created_at,
    createdPrecision: row.first_published_at === null ? 'inferred' : 'exact',
    resolvedDeleted: row.page_is_deleted,
    deletedAt,
    // v1 tombstone 是发现时刻，不是 SiteChanges 的精确删除事件；两条路径都不冒充 exact。
    deletedPrecision: row.page_is_deleted ? 'inferred' : null,
    deletionSource: row.page_is_deleted
      ? (row.legacy_fingerprint ? 'legacy_import_2025_11' : 'v1_backfill')
      : null,
    usedActivityFallback,
    divergent: row.page_is_deleted !== row.current_version_is_deleted,
  };
}

export interface V1VersionRow {
  id: number;
  page_id: number;
  valid_from: string;
  valid_to: string | null;
  is_deleted: boolean;
  title: string | null;
  alternate_title: string | null;
  tags: string[] | null;
  category: string | null;
}

export interface VersionMapPlan extends V1VersionRow {
  versionNo: number;
}

/** serve.page_version_display 的展示序号从 1 起；同刻以 v1 PageVersion.id 稳定裁决。 */
export function buildVersionMap(rows: readonly V1VersionRow[]): VersionMapPlan[] {
  const sorted = [...rows].sort(
    (a, b) =>
      a.page_id - b.page_id ||
      Date.parse(a.valid_from) - Date.parse(b.valid_from) ||
      a.id - b.id,
  );
  const counters = new Map<number, number>();
  return sorted.map((row) => {
    assertPositiveInt(row.id, 'PageVersion.id');
    assertPositiveInt(row.page_id, `PageVersion.id=${row.id} pageId`);
    if (!Number.isFinite(Date.parse(row.valid_from))) {
      throw new Error(`PageVersion.id=${row.id} validFrom 非法`);
    }
    const versionNo = (counters.get(row.page_id) ?? 0) + 1;
    counters.set(row.page_id, versionNo);
    return { ...row, versionNo };
  });
}
