import { Prisma, PrismaClient, PageMetricType, PageMetricThresholdType } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';

const AUTO_WATCH_SOURCE = 'AUTO_OWNERSHIP';
const DEFAULT_VOTE_THRESHOLD = 20;

type RevisionAlertFilter = 'ANY' | 'NON_OWNER' | 'NON_OWNER_NO_ATTR';

function parseRevisionFilter(config: Prisma.JsonValue | null | undefined): RevisionAlertFilter {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return 'ANY';
  }
  const candidate = (config as Record<string, unknown>).revisionFilter;
  if (candidate === 'ANY' || candidate === 'NON_OWNER' || candidate === 'NON_OWNER_NO_ATTR') {
    return candidate;
  }
  return 'ANY';
}

function buildRevisionConfig(filter: RevisionAlertFilter): Prisma.JsonObject {
  return { revisionFilter: filter };
}

function isConfigObject(value: Prisma.JsonValue | null | undefined): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneVoteConfig(config: Prisma.JsonValue | null | undefined): Record<string, unknown> {
  return isConfigObject(config) ? { ...(config as Record<string, unknown>) } : {};
}

function readNumericField(record: Record<string, unknown>, key: string): number | null {
  const raw = record[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw;
  }
  if (typeof raw === 'string') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function serialiseVoteConfig(
  original: Record<string, unknown>,
  threshold: number,
  baselineValue: number | null,
  pendingDiff: number,
  options: { lastAppliedThreshold?: number | null } = {}
): Prisma.JsonObject {
  const next: Record<string, unknown> = { ...original };
  next.voteThreshold = threshold;
  const lastApplied = options.lastAppliedThreshold ?? threshold;
  next.lastAppliedThreshold = lastApplied;

  const normalisedPending = Number.isFinite(pendingDiff) ? Number(pendingDiff) : 0;
  next.pendingDiff = Math.abs(normalisedPending) < 1e-6 ? 0 : normalisedPending;

  if (baselineValue == null || !Number.isFinite(baselineValue)) {
    next.baselineValue = null;
  } else {
    next.baselineValue = Number(baselineValue);
  }

  return next as Prisma.JsonObject;
}

function buildVoteConfig(
  threshold: number,
  options: { baselineValue?: number | null; pendingDiff?: number; lastAppliedThreshold?: number | null } = {}
): Prisma.JsonObject {
  const baseline = options.baselineValue ?? null;
  const pending = options.pendingDiff ?? 0;
  const lastApplied = options.lastAppliedThreshold ?? threshold;
  return serialiseVoteConfig({}, threshold, baseline, pending, { lastAppliedThreshold: lastApplied });
}

function parseVoteThreshold(config: Prisma.JsonValue | null | undefined): number | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return null;
  }
  const raw = (config as Record<string, unknown>).voteThreshold ?? (config as Record<string, unknown>).threshold;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  if (typeof raw === 'string') {
    const converted = Number(raw);
    if (Number.isFinite(converted) && converted > 0) {
      return converted;
    }
  }
  return null;
}

function parseMuted(config: Prisma.JsonValue | null | undefined): boolean | null {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return null;
  }
  const raw = (config as Record<string, unknown>).muted;
  if (typeof raw === 'boolean') {
    return raw;
  }
  if (typeof raw === 'string') {
    const normalised = raw.trim().toLowerCase();
    if (normalised === 'true') return true;
    if (normalised === 'false') return false;
  }
  return null;
}

export class PageMetricMonitorJob {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || getPrismaClient();
  }

  async run(pageVersionIds?: number[]): Promise<void> {
    await this.syncAutoWatches();
    const pageIds = await this.resolvePageIds(pageVersionIds);
    if (pageIds.length === 0) {
      Logger.debug('[metric-monitor] No relevant pageIds to evaluate, skipping alert diff scan.');
      return;
    }
    await this.processCommentCountChanges(pageIds);
    await this.processVoteCountChanges(pageIds);
    await this.processRevisionChanges(pageIds);
  }

  private async resolvePageIds(pageVersionIds?: number[]): Promise<number[]> {
    if (!pageVersionIds || pageVersionIds.length === 0) {
      return [];
    }
    const rows = await this.prisma.pageVersion.findMany({
      where: { id: { in: pageVersionIds } },
      select: { pageId: true }
    });
    const unique = new Set<number>();
    for (const row of rows) {
      unique.add(row.pageId);
    }
    return Array.from(unique);
  }

  async syncAutoWatches(): Promise<void> {
    const ownerTuples = await this.prisma.$queryRaw<Array<{
      userId: number;
      pageId: number;
      commentCount: number | null;
      voteCount: number | null;
    }>>(Prisma.sql`
      WITH attr_pages AS (
        SELECT DISTINCT a."userId" AS user_id, pv."pageId" AS page_id
        FROM "Attribution" a
        JOIN "PageVersion" pv ON pv.id = a."pageVerId"
        WHERE a."userId" IS NOT NULL
      ), page_creators AS (
        SELECT DISTINCT r."userId" AS user_id, pv."pageId" AS page_id
        FROM "Revision" r
        JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
        WHERE r."userId" IS NOT NULL AND r.type = 'PAGE_CREATED'
      ), owners AS (
        SELECT user_id, page_id FROM attr_pages
        UNION
        SELECT user_id, page_id FROM page_creators
      ), owners_with_users AS (
        SELECT o.user_id, o.page_id
        FROM owners o
        JOIN "User" u ON u.id = o.user_id
        WHERE u."wikidotId" IS NOT NULL
      )
      SELECT DISTINCT o.user_id AS "userId",
             o.page_id AS "pageId",
             pv."commentCount" AS "commentCount",
             pv."voteCount" AS "voteCount"
      FROM owners_with_users o
      JOIN "PageVersion" pv ON pv."pageId" = o.page_id
      WHERE pv."validTo" IS NULL
    `);

    const ownerSet = new Set<string>();
    const ownerData = new Map<string, { commentCount: number | null; voteCount: number | null }>();
    for (const tuple of ownerTuples) {
      const key = `${tuple.userId}:${tuple.pageId}`;
      ownerSet.add(key);
      ownerData.set(key, {
        commentCount: tuple.commentCount === null ? null : Number(tuple.commentCount),
        voteCount: tuple.voteCount === null ? null : Number(tuple.voteCount)
      });
    }

    const existing = await this.prisma.pageMetricWatch.findMany({
      where: {
        source: AUTO_WATCH_SOURCE,
        metric: { in: [PageMetricType.COMMENT_COUNT, PageMetricType.VOTE_COUNT, PageMetricType.REVISION_COUNT] }
      },
      select: {
        id: true,
        pageId: true,
        userId: true,
        metric: true,
        lastObserved: true,
        thresholdType: true,
        thresholdValue: true,
        config: true
      }
    });

    const existingMap = new Map<string, typeof existing[number]>();
    for (const watch of existing) {
      existingMap.set(`${watch.metric}:${watch.userId}:${watch.pageId}`, watch);
    }

    const uniqueUserIds = Array.from(new Set(ownerTuples.map(tuple => tuple.userId)));
    const preferences = uniqueUserIds.length === 0
      ? []
      : await this.prisma.userMetricPreference.findMany({
          where: {
            userId: { in: uniqueUserIds },
            metric: { in: [PageMetricType.COMMENT_COUNT, PageMetricType.VOTE_COUNT, PageMetricType.REVISION_COUNT] }
          },
          select: { userId: true, metric: true, config: true }
        });

    const preferenceMap = new Map<string, { voteThreshold?: number; revisionFilter?: RevisionAlertFilter; muted?: boolean }>();
    for (const pref of preferences) {
      const key = `${pref.userId}:${pref.metric}`;
      const current = preferenceMap.get(key) ?? {};

      if (pref.metric === PageMetricType.VOTE_COUNT) {
        const threshold = parseVoteThreshold(pref.config);
        if (threshold) {
          current.voteThreshold = threshold;
        }
      } else if (pref.metric === PageMetricType.REVISION_COUNT) {
        const filter = parseRevisionFilter(pref.config);
        current.revisionFilter = filter;
      }

      const muted = parseMuted(pref.config);
      if (muted !== null) {
        current.muted = muted;
      }

      preferenceMap.set(key, current);
    }

    const createPayload: Prisma.PageMetricWatchCreateManyInput[] = [];

    for (const tuple of ownerTuples) {
      for (const metric of [PageMetricType.COMMENT_COUNT, PageMetricType.VOTE_COUNT, PageMetricType.REVISION_COUNT]) {
        const key = `${metric}:${tuple.userId}:${tuple.pageId}`;
        if (existingMap.has(key)) {
          continue;
        }

        const prefKey = `${tuple.userId}:${metric}`;
        const pref = preferenceMap.get(prefKey);
        const isMuted = pref?.muted === true;
        let thresholdType: PageMetricThresholdType = PageMetricThresholdType.ANY_CHANGE;
        let thresholdValue: number | null = null;
        let lastObserved: number | null = null;
        let config: Prisma.JsonObject | undefined;

        if (metric === PageMetricType.COMMENT_COUNT) {
          thresholdType = PageMetricThresholdType.ANY_CHANGE;
          lastObserved = tuple.commentCount === null ? null : Number(tuple.commentCount);
        } else if (metric === PageMetricType.VOTE_COUNT) {
          const voteThreshold = pref?.voteThreshold ?? DEFAULT_VOTE_THRESHOLD;
          thresholdType = PageMetricThresholdType.ABSOLUTE;
          thresholdValue = voteThreshold;
          const baselineVote = tuple.voteCount === null ? null : Number(tuple.voteCount);
          config = buildVoteConfig(voteThreshold, {
            baselineValue: baselineVote,
            pendingDiff: 0,
            lastAppliedThreshold: voteThreshold
          });
          lastObserved = baselineVote;
        } else {
          const filter = pref?.revisionFilter ?? 'ANY';
          thresholdType = PageMetricThresholdType.ANY_CHANGE;
          thresholdValue = null;
          config = buildRevisionConfig(filter);
          lastObserved = null;
        }

        createPayload.push({
          pageId: tuple.pageId,
          userId: tuple.userId,
          metric,
          thresholdType,
          thresholdValue,
          lastObserved,
          source: AUTO_WATCH_SOURCE,
          config,
          mutedAt: isMuted ? new Date() : null
        });
      }
    }

    if (createPayload.length > 0) {
      await this.prisma.pageMetricWatch.createMany({
        data: createPayload,
        skipDuplicates: true
      });
      Logger.info(`[metric-monitor] Created ${createPayload.length} auto ownership metric watches.`);
    }

    const staleWatchIds = existing
      .filter(watch => !ownerSet.has(`${watch.userId}:${watch.pageId}`))
      .map(watch => watch.id);

    if (staleWatchIds.length > 0) {
      await this.prisma.pageMetricWatch.deleteMany({ where: { id: { in: staleWatchIds } } });
      Logger.info(`[metric-monitor] Removed ${staleWatchIds.length} stale auto ownership watches.`);
    }

    const baselineUpdates: Array<{ id: number; value: number | null }> = [];
    for (const watch of existing) {
      if (watch.lastObserved !== null) {
        continue;
      }
      const ownerKey = `${watch.userId}:${watch.pageId}`;
      const data = ownerData.get(ownerKey);
      if (!data) {
        continue;
      }
      if (watch.metric === PageMetricType.COMMENT_COUNT && data.commentCount !== null) {
        baselineUpdates.push({ id: watch.id, value: data.commentCount });
      } else if (watch.metric === PageMetricType.VOTE_COUNT && data.voteCount !== null) {
        baselineUpdates.push({ id: watch.id, value: data.voteCount });
      }
    }

    for (const item of baselineUpdates) {
      await this.prisma.pageMetricWatch.update({
        where: { id: item.id },
        data: { lastObserved: item.value }
      });
    }
    if (baselineUpdates.length > 0) {
      Logger.info(`[metric-monitor] Initialised ${baselineUpdates.length} watches with baseline metrics.`);
    }
  }

  async processCommentCountChanges(pageIds: number[]): Promise<void> {
    if (pageIds.length === 0) {
      return;
    }

    const pageIdArray = Prisma.sql`ARRAY[${Prisma.join(pageIds.map(id => Prisma.sql`${id}`))}]::int[]`;

    const watchRows = await this.prisma.$queryRaw<Array<{
      watchId: number;
      pageId: number;
      lastObserved: number | null;
      thresholdType: PageMetricThresholdType;
      thresholdValue: number | null;
      currentValue: number | null;
    }>>(Prisma.sql`
      SELECT 
        w.id AS "watchId",
        w."pageId" AS "pageId",
        w."lastObserved" AS "lastObserved",
        w."thresholdType" AS "thresholdType",
        w."thresholdValue" AS "thresholdValue",
        pv."commentCount" AS "currentValue"
      FROM "PageMetricWatch" w
      JOIN "PageVersion" pv ON pv."pageId" = w."pageId" AND pv."validTo" IS NULL
      WHERE w.metric = 'COMMENT_COUNT'::"PageMetricType"
        AND w."source" = ${AUTO_WATCH_SOURCE}
        AND (w."mutedAt" IS NULL)
        AND w."pageId" = ANY(${pageIdArray})
    `);

    if (watchRows.length === 0) {
      Logger.debug('[metric-monitor] No comment count watches to evaluate for supplied pageIds.');
      return;
    }

    const alerts: Array<{ watchId: number; pageId: number; prevValue: number | null; newValue: number | null; diffValue: number | null }> = [];
    const updates: Array<{ id: number; value: number | null }> = [];

    for (const row of watchRows) {
      const current = row.currentValue === null ? null : Number(row.currentValue);
      if (current === null) {
        continue;
      }

      if (row.lastObserved === null) {
        updates.push({ id: row.watchId, value: current });
        continue;
      }

      const prev = Number(row.lastObserved);
      if (prev === current) {
        continue;
      }

      const diff = current - prev;
      if (this.shouldTrigger(row.thresholdType, row.thresholdValue, prev, current)) {
        alerts.push({
          watchId: row.watchId,
          pageId: row.pageId,
          prevValue: prev,
          newValue: current,
          diffValue: diff
        });
      }

      updates.push({ id: row.watchId, value: current });
    }

    if (alerts.length > 0) {
      const now = new Date();
      const watchIds = Array.from(new Set(alerts.map(a => a.watchId)));
      const existing = watchIds.length === 0
        ? []
        : await this.prisma.pageMetricAlert.findMany({
            where: {
              acknowledgedAt: null,
              watchId: { in: watchIds }
            },
            select: { id: true, watchId: true, prevValue: true, detectedAt: true },
            orderBy: [{ watchId: 'asc' }, { detectedAt: 'asc' }]
          });

      const earliestByWatch = new Map<number, { id: number; prevValue: number | null }>();
      for (const row of existing) {
        if (!earliestByWatch.has(row.watchId)) {
          earliestByWatch.set(row.watchId, { id: row.id, prevValue: row.prevValue });
        }
      }

      const toCreate: typeof alerts = [];
      const toUpdate: Array<{ id: number; newValue: number | null; diffValue: number | null }> = [];

      for (const alert of alerts) {
        const existingUnread = earliestByWatch.get(alert.watchId);
        if (existingUnread) {
          const prevVal = existingUnread.prevValue == null ? null : Number(existingUnread.prevValue);
          const newVal = alert.newValue == null ? null : Number(alert.newValue);
          const diffVal = prevVal == null || newVal == null ? null : (newVal - prevVal);
          toUpdate.push({ id: existingUnread.id, newValue: newVal, diffValue: diffVal });
        } else {
          toCreate.push(alert);
        }
      }

      if (toCreate.length > 0) {
        await this.prisma.pageMetricAlert.createMany({
          data: toCreate.map(alert => ({
            watchId: alert.watchId,
            pageId: alert.pageId,
            metric: PageMetricType.COMMENT_COUNT,
            prevValue: alert.prevValue,
            newValue: alert.newValue,
            diffValue: alert.diffValue,
            detectedAt: now,
            createdAt: now
          }))
        });
      }

      for (const upd of toUpdate) {
        await this.prisma.pageMetricAlert.update({
          where: { id: upd.id },
          data: { newValue: upd.newValue, diffValue: upd.diffValue, detectedAt: now }
        });
      }

      Logger.info(`[metric-monitor] Created ${toCreate.length} and updated ${toUpdate.length} comment count alerts.`);
    }

    for (const update of updates) {
      await this.prisma.pageMetricWatch.update({
        where: { id: update.id },
        data: { lastObserved: update.value }
      });
    }
  }

  async processVoteCountChanges(pageIds: number[]): Promise<void> {
    if (pageIds.length === 0) {
      return;
    }

    const pageIdArray = Prisma.sql`ARRAY[${Prisma.join(pageIds.map(id => Prisma.sql`${id}`))}]::int[]`;

    const watchRows = await this.prisma.$queryRaw<Array<{
      watchId: number;
      pageId: number;
      lastObserved: number | null;
      thresholdType: PageMetricThresholdType;
      thresholdValue: number | null;
      currentValue: number | null;
      config: Prisma.JsonValue | null;
    }>>(Prisma.sql`
      SELECT 
        w.id AS "watchId",
        w."pageId" AS "pageId",
        w."lastObserved" AS "lastObserved",
        w."thresholdType" AS "thresholdType",
        w."thresholdValue" AS "thresholdValue",
        pv."voteCount" AS "currentValue",
        w."config" AS "config"
      FROM "PageMetricWatch" w
      JOIN "PageVersion" pv ON pv."pageId" = w."pageId" AND pv."validTo" IS NULL
      WHERE w.metric = 'VOTE_COUNT'::"PageMetricType"
        AND w."source" = ${AUTO_WATCH_SOURCE}
        AND (w."mutedAt" IS NULL)
        AND w."pageId" = ANY(${pageIdArray})
    `);

    if (watchRows.length === 0) {
      Logger.debug('[metric-monitor] No vote count watches to evaluate for supplied pageIds.');
      return;
    }

    const alerts: Array<{ watchId: number; pageId: number; prevValue: number; newValue: number; diffValue: number }> = [];
    const updates: Array<{ id: number; data: Prisma.PageMetricWatchUpdateInput }> = [];

    for (const row of watchRows) {
      const current = row.currentValue === null ? null : Number(row.currentValue);
      if (current === null) {
        continue;
      }

      const configRecord = cloneVoteConfig(row.config);
      const configuredThreshold = parseVoteThreshold(row.config) ?? undefined;
      let threshold = row.thresholdValue ?? configuredThreshold ?? DEFAULT_VOTE_THRESHOLD;
      if (!Number.isFinite(threshold) || threshold <= 0) {
        threshold = DEFAULT_VOTE_THRESHOLD;
      }
      threshold = Number(threshold);

      if (row.lastObserved === null) {
        const nextConfig = serialiseVoteConfig(configRecord, threshold, current, 0, { lastAppliedThreshold: threshold });
        updates.push({ id: row.watchId, data: { lastObserved: current, config: nextConfig } });
        continue;
      }

      const prev = Number(row.lastObserved);
      if (row.thresholdType !== PageMetricThresholdType.ABSOLUTE) {
        if (prev === current) {
          continue;
        }
        const diff = current - prev;
        if (this.shouldTrigger(row.thresholdType, row.thresholdValue, prev, current)) {
          alerts.push({
            watchId: row.watchId,
            pageId: row.pageId,
            prevValue: prev,
            newValue: current,
            diffValue: diff
          });
        }
        updates.push({ id: row.watchId, data: { lastObserved: current } });
        continue;
      }

      const pendingDiff = readNumericField(configRecord, 'pendingDiff') ?? 0;
      let baselineValue = readNumericField(configRecord, 'baselineValue');
      const lastAppliedThreshold = readNumericField(configRecord, 'lastAppliedThreshold');

      const thresholdChanged = !Number.isFinite(lastAppliedThreshold) || Math.abs((lastAppliedThreshold ?? 0) - threshold) > 1e-6;

      if (thresholdChanged) {
        const nextConfig = serialiseVoteConfig(configRecord, threshold, current, 0, { lastAppliedThreshold: threshold });
        updates.push({ id: row.watchId, data: { lastObserved: current, config: nextConfig } });
        continue;
      }

      if (baselineValue == null || !Number.isFinite(baselineValue)) {
        baselineValue = prev;
      }

      const diff = current - prev;
      const totalDiff = pendingDiff + diff;

      if (Math.abs(totalDiff) >= threshold) {
        const previousValue = baselineValue ?? prev;
        const diffValue = current - previousValue;
        alerts.push({
          watchId: row.watchId,
          pageId: row.pageId,
          prevValue: previousValue,
          newValue: current,
          diffValue
        });

        const nextConfig = serialiseVoteConfig(configRecord, threshold, current, 0, { lastAppliedThreshold: threshold });
        updates.push({ id: row.watchId, data: { lastObserved: current, config: nextConfig } });
        continue;
      }

      const nextBaseline = baselineValue ?? prev;
      const nextConfig = serialiseVoteConfig(configRecord, threshold, nextBaseline, totalDiff, { lastAppliedThreshold: threshold });
      updates.push({ id: row.watchId, data: { lastObserved: current, config: nextConfig } });
    }

    if (alerts.length > 0) {
      const now = new Date();
      const watchIds = Array.from(new Set(alerts.map(a => a.watchId)));
      const existing = watchIds.length === 0
        ? []
        : await this.prisma.pageMetricAlert.findMany({
            where: {
              acknowledgedAt: null,
              watchId: { in: watchIds }
            },
            select: { id: true, watchId: true, prevValue: true, detectedAt: true },
            orderBy: [{ watchId: 'asc' }, { detectedAt: 'asc' }]
          });

      const earliestByWatch = new Map<number, { id: number; prevValue: number | null }>();
      for (const row of existing) {
        if (!earliestByWatch.has(row.watchId)) {
          earliestByWatch.set(row.watchId, { id: row.id, prevValue: row.prevValue });
        }
      }

      const toCreate: typeof alerts = [];
      const toUpdate: Array<{ id: number; newValue: number | null; diffValue: number | null }> = [];

      for (const alert of alerts) {
        const existingUnread = earliestByWatch.get(alert.watchId);
        if (existingUnread) {
          const prevVal = existingUnread.prevValue == null ? null : Number(existingUnread.prevValue);
          const newVal = alert.newValue == null ? null : Number(alert.newValue);
          const diffVal = prevVal == null || newVal == null ? null : (newVal - prevVal);
          toUpdate.push({ id: existingUnread.id, newValue: newVal, diffValue: diffVal });
        } else {
          toCreate.push(alert);
        }
      }

      if (toCreate.length > 0) {
        await this.prisma.pageMetricAlert.createMany({
          data: toCreate.map(alert => ({
            watchId: alert.watchId,
            pageId: alert.pageId,
            metric: PageMetricType.VOTE_COUNT,
            prevValue: alert.prevValue,
            newValue: alert.newValue,
            diffValue: alert.diffValue,
            detectedAt: now,
            createdAt: now
          }))
        });
      }

      for (const upd of toUpdate) {
        await this.prisma.pageMetricAlert.update({
          where: { id: upd.id },
          data: { newValue: upd.newValue, diffValue: upd.diffValue, detectedAt: now }
        });
      }

      Logger.info(`[metric-monitor] Created ${toCreate.length} and updated ${toUpdate.length} vote count alerts.`);
    }

    for (const update of updates) {
      await this.prisma.pageMetricWatch.update({
        where: { id: update.id },
        data: update.data
      });
    }
  }

  async processRevisionChanges(pageIds: number[]): Promise<void> {
    if (pageIds.length === 0) {
      return;
    }

    const watches = await this.prisma.pageMetricWatch.findMany({
      where: {
        metric: PageMetricType.REVISION_COUNT,
        source: AUTO_WATCH_SOURCE,
        mutedAt: null,
        pageId: { in: pageIds }
      },
      select: {
        id: true,
        pageId: true,
        userId: true,
        lastObserved: true,
        config: true
      }
    });

    if (watches.length === 0) {
      Logger.debug('[metric-monitor] No revision watches to evaluate for supplied pageIds.');
      return;
    }

    const pageIdArray = Prisma.sql`ARRAY[${Prisma.join(pageIds.map(id => Prisma.sql`${id}`))}]::int[]`;

    const revisionRows = await this.prisma.$queryRaw<Array<{
      pageId: number;
      userId: number | null;
      count: number;
    }>>(Prisma.sql`
      SELECT pv."pageId" AS "pageId",
             r."userId" AS "userId",
             COUNT(*)::int AS "count"
      FROM "Revision" r
      JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
      WHERE pv."pageId" = ANY(${pageIdArray})
      GROUP BY pv."pageId", r."userId"
    `);

    const attributionRows = await this.prisma.$queryRaw<Array<{ pageId: number; userId: number }>>(Prisma.sql`
      SELECT DISTINCT pv."pageId" AS "pageId",
             a."userId" AS "userId"
      FROM "Attribution" a
      JOIN "PageVersion" pv ON pv.id = a."pageVerId"
      WHERE pv."pageId" = ANY(${pageIdArray})
        AND a."userId" IS NOT NULL
    `);

    const totalCounts = new Map<number, number>();
    const perPageUserCounts = new Map<number, Map<number | null, number>>();
    for (const row of revisionRows) {
      totalCounts.set(row.pageId, (totalCounts.get(row.pageId) ?? 0) + Number(row.count));
      let userMap = perPageUserCounts.get(row.pageId);
      if (!userMap) {
        userMap = new Map<number | null, number>();
        perPageUserCounts.set(row.pageId, userMap);
      }
      userMap.set(row.userId, Number(row.count));
    }

    const attributionMap = new Map<number, Set<number>>();
    for (const row of attributionRows) {
      let set = attributionMap.get(row.pageId);
      if (!set) {
        set = new Set<number>();
        attributionMap.set(row.pageId, set);
      }
      set.add(Number(row.userId));
    }

    const alerts: Array<{ watchId: number; pageId: number; prevValue: number | null; newValue: number | null; diffValue: number | null }> = [];
    const updates: Array<{ id: number; value: number }> = [];

    for (const watch of watches) {
      const filter = parseRevisionFilter(watch.config);
      const total = totalCounts.get(watch.pageId) ?? 0;
      const userMap = perPageUserCounts.get(watch.pageId) ?? new Map<number | null, number>();
      const ownerCount = userMap.get(watch.userId) ?? 0;

      let relevant = total;
      if (filter === 'NON_OWNER') {
        relevant = Math.max(0, total - ownerCount);
      } else if (filter === 'NON_OWNER_NO_ATTR') {
        let attributionCount = 0;
        const credited = attributionMap.get(watch.pageId);
        if (credited && credited.size > 0) {
          for (const creditedUserId of credited) {
            if (creditedUserId === watch.userId) {
              continue;
            }
            attributionCount += userMap.get(creditedUserId) ?? 0;
          }
        }
        relevant = Math.max(0, total - ownerCount - attributionCount);
      }

      if (watch.lastObserved === null) {
        updates.push({ id: watch.id, value: relevant });
        continue;
      }

      const prev = Number(watch.lastObserved);
      const diff = relevant - prev;
      if (diff > 0) {
        alerts.push({
          watchId: watch.id,
          pageId: watch.pageId,
          prevValue: prev,
          newValue: relevant,
          diffValue: diff
        });
      }

      if (diff !== 0) {
        updates.push({ id: watch.id, value: relevant });
      }
    }

    if (alerts.length > 0) {
      const now = new Date();
      const watchIds = Array.from(new Set(alerts.map(a => a.watchId)));
      const existing = watchIds.length === 0
        ? []
        : await this.prisma.pageMetricAlert.findMany({
            where: {
              acknowledgedAt: null,
              watchId: { in: watchIds }
            },
            select: { id: true, watchId: true, prevValue: true, detectedAt: true },
            orderBy: [{ watchId: 'asc' }, { detectedAt: 'asc' }]
          });

      const earliestByWatch = new Map<number, { id: number; prevValue: number | null }>();
      for (const row of existing) {
        if (!earliestByWatch.has(row.watchId)) {
          earliestByWatch.set(row.watchId, { id: row.id, prevValue: row.prevValue });
        }
      }

      const toCreate: typeof alerts = [];
      const toUpdate: Array<{ id: number; newValue: number | null; diffValue: number | null }> = [];

      for (const alert of alerts) {
        const existingUnread = earliestByWatch.get(alert.watchId);
        if (existingUnread) {
          const prevVal = existingUnread.prevValue == null ? null : Number(existingUnread.prevValue);
          const newVal = alert.newValue == null ? null : Number(alert.newValue);
          const diffVal = prevVal == null || newVal == null ? null : (newVal - prevVal);
          toUpdate.push({ id: existingUnread.id, newValue: newVal, diffValue: diffVal });
        } else {
          toCreate.push(alert);
        }
      }

      if (toCreate.length > 0) {
        await this.prisma.pageMetricAlert.createMany({
          data: toCreate.map(alert => ({
            watchId: alert.watchId,
            pageId: alert.pageId,
            metric: PageMetricType.REVISION_COUNT,
            prevValue: alert.prevValue,
            newValue: alert.newValue,
            diffValue: alert.diffValue,
            detectedAt: now,
            createdAt: now
          }))
        });
      }

      for (const upd of toUpdate) {
        await this.prisma.pageMetricAlert.update({
          where: { id: upd.id },
          data: { newValue: upd.newValue, diffValue: upd.diffValue, detectedAt: now }
        });
      }

      Logger.info(`[metric-monitor] Created ${toCreate.length} and updated ${toUpdate.length} revision alerts.`);
    }

    for (const update of updates) {
      await this.prisma.pageMetricWatch.update({
        where: { id: update.id },
        data: { lastObserved: update.value }
      });
    }
  }

  private shouldTrigger(
    thresholdType: PageMetricThresholdType,
    thresholdValue: number | null,
    previous: number,
    current: number
  ): boolean {
    const diff = current - previous;
    switch (thresholdType) {
      case PageMetricThresholdType.ANY_CHANGE:
        return diff !== 0;
      case PageMetricThresholdType.ABSOLUTE: {
        const absoluteThreshold = thresholdValue ?? 1;
        return Math.abs(diff) >= absoluteThreshold;
      }
      case PageMetricThresholdType.PERCENT: {
        const base = Math.abs(previous);
        if (base < 1e-6) {
          return Math.abs(diff) >= (thresholdValue ?? 0);
        }
        const pct = Math.abs(diff) / base * 100;
        return pct >= (thresholdValue ?? 0);
      }
      default:
        return diff !== 0;
    }
  }
}
