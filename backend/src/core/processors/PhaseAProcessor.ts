// src/core/processors/PhaseAProcessor.ts
import { GraphQLClient } from '../client/GraphQLClient.js';
import { CoreQueries } from '../graphql/CoreQueries.js';
import { PointEstimator } from '../graphql/PointEstimator.js';
import { DatabaseStore } from '../store/DatabaseStore.js';
import {
  AttributionService,
  buildDisplayNameAnonKey,
  normalizeAttributionAnonKey
} from '../store/AttributionService.js';
import { Logger } from '../../utils/Logger.js';
import { Progress } from '../../utils/Progress.js';
import type { PageVersion } from '@prisma/client';

interface AlternateTitleEntry {
  title?: string;
}

interface PageNode {
  url: string;
  wikidotId?: string | number | null;
  title?: string;
  rating?: number | null;
  voteCount?: number | null;
  revisionCount?: number | null;
  commentCount?: number | null;
  tags?: string[];
  category?: string | null;
  parent?: { url?: string } | null;
  alternateTitles?: AlternateTitleEntry[];
  attributions?: unknown[];
}

interface PageEdge {
  node: PageNode;
}

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

interface PagesResult {
  pages: {
    edges: PageEdge[];
    pageInfo: PageInfo;
  };
}

interface QueueStats {
  total: number;
  phaseB: number;
  phaseC: number;
  deleted: number;
}

interface PhaseAResult {
  totalScanned: number;
  elapsedTime: number;
  speed: string;
  queueStats: QueueStats;
}

interface CurrentVersionAttributionSnapshot {
  type: string;
  order: number;
  date: Date | null;
  anonKey: string | null;
  user: {
    wikidotId: number | null;
  } | null;
}

type CurrentVersionSnapshot = PageVersion & {
  attributions: CurrentVersionAttributionSnapshot[];
};

const cq = new CoreQueries();

const extractAlternateTitle = (node: PageNode): string | null => {
  if (!node || !Array.isArray(node.alternateTitles)) return null;
  const first = node.alternateTitles.find(
    (entry): entry is AlternateTitleEntry & { title: string } =>
      typeof entry?.title === 'string' && entry.title.trim().length > 0
  );
  return first ? first.title.trim() : null;
};

const normalizeAttributionDate = (value: unknown): string | null => {
  if (value == null) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const normalizeIncomingAttributionSignature = (rawAttributions: unknown[]): string[] => {
  const normalized = rawAttributions.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];

    const attr = raw as Record<string, unknown>;
    const type = typeof attr.type === 'string' && attr.type.trim()
      ? attr.type.trim()
      : 'unknown';
    const order = typeof attr.order === 'number'
      ? attr.order
      : Number.parseInt(String(attr.order ?? 0), 10) || 0;

    let userData = attr.user;
    if (userData && typeof userData === 'object' && 'wikidotUser' in userData) {
      userData = (userData as Record<string, unknown>).wikidotUser;
    }

    let actorKey: string | null = null;
    if (userData && typeof userData === 'object') {
      const userRecord = userData as Record<string, unknown>;
      const wikidotIdRaw = userRecord.wikidotId;
      const wikidotId = typeof wikidotIdRaw === 'number'
        ? wikidotIdRaw
        : Number.parseInt(String(wikidotIdRaw ?? ''), 10);
      if (Number.isFinite(wikidotId)) {
        actorKey = `u:${wikidotId}`;
      } else {
        const anonKey = buildDisplayNameAnonKey(userRecord.displayName);
        if (anonKey) {
          actorKey = `a:${anonKey}`;
        }
      }
    }

    const normalizedAnonKey = normalizeAttributionAnonKey(attr.anonKey);
    if (!actorKey && normalizedAnonKey) {
      actorKey = `a:${normalizedAnonKey}`;
    }

    // Mirror AttributionService: entries without a stable actor are ignored.
    if (!actorKey) return [];

    return [`${type}|${order}|${actorKey}|${normalizeAttributionDate(attr.date) ?? ''}`];
  });

  normalized.sort();
  return normalized;
};

const normalizeStoredAttributionSignature = (
  attributions: CurrentVersionAttributionSnapshot[]
): string[] => {
  const normalized = attributions.flatMap((attr) => {
    const normalizedAnonKey = normalizeAttributionAnonKey(attr.anonKey);
    const actorKey = attr.user?.wikidotId != null
      ? `u:${attr.user.wikidotId}`
      : normalizedAnonKey
        ? `a:${normalizedAnonKey}`
        : null;
    // Mirror incoming side: entries without a stable actor are excluded.
    if (!actorKey) return [];
    return [`${attr.type}|${attr.order}|${actorKey}|${normalizeAttributionDate(attr.date) ?? ''}`];
  });
  normalized.sort();
  return normalized;
};

const attributionSignatureChanged = (
  currentVersion: CurrentVersionSnapshot,
  rawAttributions: unknown[]
): boolean => {
  const incoming = normalizeIncomingAttributionSignature(rawAttributions);
  const stored = normalizeStoredAttributionSignature(currentVersion.attributions);
  if (incoming.length !== stored.length) {
    return true;
  }
  return incoming.some((value, index) => value !== stored[index]);
};

const PHASE_A_BATCHSIZE = 100;

// Total count query
const TOTAL_QUERY = /* GraphQL */ `
  query {
    aggregatePages(filter: {url: {startsWith: "http://scp-wiki-cn.wikidot.com/"}}) {
      _count
    }
  }
`;

export class PhaseAProcessor {
  private client: GraphQLClient;
  private store: DatabaseStore;
  private attrService: AttributionService;

  constructor() {
    this.client = new GraphQLClient();
    this.store = new DatabaseStore();
    this.attrService = new AttributionService(this.store.prisma);
  }

  async runComplete(onProgress?: () => void): Promise<PhaseAResult> {
    Logger.info('=== Phase A: Complete Page Scanning (New Architecture) ===');

    // Get total page count
    Logger.info('Fetching total page count...');
    const totalResult = await this.client.request<{ aggregatePages: { _count: number } }>(TOTAL_QUERY);
    const total = totalResult.aggregatePages._count;
    Logger.info(`Total pages in remote: ${total}`);
    const bar = total > 0 ? Progress.createBar({ title: 'Phase A', total }) : null;

    // Clear staging table to start fresh
    Logger.info('🧹 Clearing staging table...');
    await this.store.prisma.pageMetaStaging.deleteMany({});

    let after: string | null = null;
    let processedCount = 0;
    const startTime = Date.now();
    let batchCount = 0;

    Logger.info('🔄 Starting complete scan (no skipping)...');

    while (true) {
      const vars = cq.buildPhaseAVariables({ first: PHASE_A_BATCHSIZE, after });
      const { query } = cq.buildQuery('phaseA', vars);

      const res = await this.client.request<PagesResult>(query, vars);
      const edges = res.pages.edges;

      if (edges.length === 0) break;

      batchCount++;
      let totalCostInBatch = 0;

      // Process all pages in this batch (no skipping)
      for (const { node } of edges) {
        let currentVersionCache: CurrentVersionSnapshot | null | undefined;
        let currentVersionLoaded = false;

        const loadCurrentVersion = async (): Promise<CurrentVersionSnapshot | null> => {
          if (currentVersionLoaded) return currentVersionCache ?? null;
          currentVersionLoaded = true;

          if (!node.wikidotId) {
            currentVersionCache = null;
            return null;
          }

          const wikidotId = typeof node.wikidotId === 'string'
            ? parseInt(node.wikidotId, 10)
            : node.wikidotId;
          if (wikidotId == null || Number.isNaN(wikidotId)) {
            currentVersionCache = null;
            return null;
          }

          const page = await this.store.prisma.page.findUnique({
            where: { wikidotId },
            include: {
              versions: {
                where: { validTo: null },
                take: 1,
                include: {
                  attributions: {
                    include: {
                      user: {
                        select: {
                          wikidotId: true
                        }
                      }
                    }
                  }
                }
              }
            }
          });

          currentVersionCache = page?.versions?.[0] ?? null;
          return currentVersionCache ?? null;
        };

        // Estimate complete collection cost with more accurate parameters
        const estCost = PointEstimator.estimatePageCost(
          node,
          {
            revisionLimit: Math.max(node.revisionCount ?? 0, 20),
            voteLimit: Math.max(node.voteCount ?? 0, 20)
          }
        );

        const wikidotId = node.wikidotId != null
          ? (typeof node.wikidotId === 'string' ? parseInt(node.wikidotId, 10) : node.wikidotId)
          : null;

        // Write to staging. GraphQL does not expose isDeleted field,
        // deletion detection relies on "locally exists but not seen in this scan",
        // handled by DatabaseStore.reconcileAndMarkDeletions,
        // so we treat all as not deleted here.
        await this.store.upsertPageMetaStaging({
          url: node.url,
          wikidotId: wikidotId ?? null,
          title: node.title ?? null,
          rating: node.rating != null ? Number(node.rating) : null,
          voteCount: node.voteCount != null ? Number(node.voteCount) : null,
          revisionCount: node.revisionCount != null ? Number(node.revisionCount) : null,
          commentCount: node.commentCount != null ? Number(node.commentCount) : null,
          tags: node.tags || [],
          isDeleted: false,
          estimatedCost: estCost,
          // New fields for enhanced dirty detection
          category: node.category || null,
          parentUrl: node.parent?.url || null,
          childCount: null,
          attributionCount: Array.isArray(node.attributions) ? node.attributions.length : null,
          voteUp: null, // Will be populated by Wilson score calculation if available
          voteDown: null, // Will be populated by Wilson score calculation if available
        });

        // Best-effort attribution import in Phase A: if page exists, write attributions to current version
        if (Array.isArray(node.attributions) && node.attributions.length > 0 && wikidotId != null) {
          try {
            const currentVersion = await loadCurrentVersion();
            if (currentVersion) {
              const nextAttributionCount = node.attributions.length;
              const changed = attributionSignatureChanged(currentVersion, node.attributions);
              await this.attrService.importAttributions(currentVersion.id, node.attributions);
              if (changed || currentVersion.attributionCount !== nextAttributionCount) {
                await this.store.prisma.pageVersion.update({
                  where: { id: currentVersion.id },
                  // Keep updatedAt moving when attribution rows change without a
                  // count change so incremental analytics can see the delta.
                  data: {
                    attributionCount: nextAttributionCount,
                    updatedAt: new Date()
                  }
                });
              }
            }
          } catch (e) {
            Logger.warn('Phase A attribution import failed', {
              url: node.url,
              err: e instanceof Error ? e.message : String(e)
            });
          }
        }

        // Best-effort commentCount update in Phase A: if page exists, write directly
        if (wikidotId != null && node.commentCount != null) {
          try {
            const currentVersion = await loadCurrentVersion();
            const nextCommentCount = Number(node.commentCount);
            if (currentVersion && currentVersion.commentCount !== nextCommentCount) {
              await this.store.prisma.pageVersion.update({
                where: { id: currentVersion.id },
                data: { commentCount: nextCommentCount }
              });
            }
          } catch (e) {
            Logger.warn('Phase A commentCount update failed', {
              url: node.url,
              err: e instanceof Error ? e.message : String(e)
            });
          }
        }

        // Update alternate title directly on the latest PageVersion when available
        if (wikidotId != null) {
          try {
            const currentVersion = await loadCurrentVersion();
            if (currentVersion && !currentVersion.isDeleted) {
              const alternateTitle = extractAlternateTitle(node);
              const existingAlternateTitle = currentVersion.alternateTitle ?? null;

              if (alternateTitle !== existingAlternateTitle) {
                await this.store.prisma.pageVersion.update({
                  where: { id: currentVersion.id },
                  data: { alternateTitle }
                });
              }
            }
          } catch (e) {
            Logger.warn('Phase A alternateTitle update failed', {
              url: node.url,
              err: e instanceof Error ? e.message : String(e)
            });
          }
        }

        totalCostInBatch += estCost;
        processedCount++;
        if (bar) bar.increment(1);
      }

      const avgCostInBatch = edges.length > 0 ? (totalCostInBatch / edges.length).toFixed(2) : '0';
      const firstUrl = edges.length > 0 ? edges[0].node.url : 'N/A';
      Logger.info(`Batch ${batchCount}: processed ${edges.length} pages (${processedCount}/${total}), avg cost: ${avgCostInBatch} pts`);
      Logger.info(`  First URL: ${firstUrl}`);
      onProgress?.();

      if (!res.pages.pageInfo.hasNextPage) break;
      after = res.pages.pageInfo.endCursor;
    }

    const elapsedTime = (Date.now() - startTime) / 1000;
    const speed = elapsedTime > 0 && processedCount > 0
      ? (processedCount / elapsedTime).toFixed(1) + ' pages/s'
      : 'N/A';

    Logger.info(`✅ Phase A completed: ${processedCount} pages scanned in ${elapsedTime.toFixed(1)}s (${speed})`);
    if (bar) bar.stop();

    // Now build the dirty queue
    Logger.info('🔍 Building dirty page queue...');
    const queueStats = await this.store.buildDirtyQueue();

    // Cleanup old staging data
    await this.store.cleanupStagingData(24);

    return {
      totalScanned: processedCount,
      elapsedTime,
      speed,
      queueStats,
    };
  }

  async runTestBatch(): Promise<PhaseAResult> {
    Logger.info('🧪 Starting test batch scan (first batch only)...');

    // Clear staging table to start fresh
    Logger.info('🧹 Clearing staging table...');
    await this.store.prisma.pageMetaStaging.deleteMany({});

    const startTime = Date.now();
    let processedCount = 0;

    // Only process the first batch
    const vars = cq.buildPhaseAVariables({ first: PHASE_A_BATCHSIZE, after: null });
    const { query } = cq.buildQuery('phaseA', vars);

    Logger.info(`📦 Processing test batch (up to ${PHASE_A_BATCHSIZE} pages)...`);

    const res = await this.client.request<PagesResult>(query, vars);
    const edges = res.pages.edges;
    const bar = edges.length > 0 ? Progress.createBar({ title: 'Phase A (test)', total: edges.length }) : null;

    if (edges.length === 0) {
      Logger.info('No pages found in first batch');
      return {
        totalScanned: 0,
        elapsedTime: 0,
        speed: 'N/A',
        queueStats: { total: 0, phaseB: 0, phaseC: 0, deleted: 0 }
      };
    }

    let totalCostInBatch = 0;

    // Process all pages in this test batch
    for (const { node } of edges) {
      let currentVersionCache: CurrentVersionSnapshot | null | undefined;
      let currentVersionLoaded = false;

      const loadCurrentVersion = async (): Promise<CurrentVersionSnapshot | null> => {
        if (currentVersionLoaded) return currentVersionCache ?? null;
        currentVersionLoaded = true;

        if (!node.wikidotId) {
          currentVersionCache = null;
          return null;
        }

        const wikidotId = typeof node.wikidotId === 'string'
          ? parseInt(node.wikidotId, 10)
          : node.wikidotId;
        if (wikidotId == null || Number.isNaN(wikidotId)) {
          currentVersionCache = null;
          return null;
        }

        const page = await this.store.prisma.page.findUnique({
          where: { wikidotId },
          include: {
            versions: {
              where: { validTo: null },
              take: 1,
              include: {
                attributions: {
                  include: {
                    user: {
                      select: {
                        wikidotId: true
                      }
                    }
                  }
                }
              }
            }
          }
        });

        currentVersionCache = page?.versions?.[0] ?? null;
        return currentVersionCache ?? null;
      };

      // Estimate complete collection cost with more accurate parameters
      const estCost = PointEstimator.estimatePageCost(
        node,
        {
          revisionLimit: Math.max(node.revisionCount ?? 0, 20),
          voteLimit: Math.max(node.voteCount ?? 0, 20)
        }
      );

      const wikidotId = node.wikidotId != null
        ? (typeof node.wikidotId === 'string' ? parseInt(node.wikidotId, 10) : node.wikidotId)
        : null;

      // Write to staging (test batch). Similarly don't rely on GraphQL isDeleted here,
      // deletion detection still relies on reconciliation logic.
      await this.store.upsertPageMetaStaging({
        url: node.url,
        wikidotId: wikidotId ?? null,
        title: node.title ?? null,
        rating: node.rating != null ? Number(node.rating) : null,
        voteCount: node.voteCount != null ? Number(node.voteCount) : null,
        revisionCount: node.revisionCount != null ? Number(node.revisionCount) : null,
        commentCount: node.commentCount != null ? Number(node.commentCount) : null,
        tags: node.tags || [],
        isDeleted: false,
        estimatedCost: estCost,
        lastSeenAt: new Date(),
        category: node.category || null,
        parentUrl: node.parent?.url || null,
        childCount: null,
        attributionCount: null,
        // Don't estimate uv/dv in Phase A, leave for analysis stage
        voteUp: null,
        voteDown: null,
      });

      // Best-effort commentCount update in Phase A test batch
      if (wikidotId != null && node.commentCount != null) {
        try {
          const currentVersion = await loadCurrentVersion();
          if (currentVersion) {
            await this.store.prisma.pageVersion.update({
              where: { id: currentVersion.id },
              data: { commentCount: Number(node.commentCount) }
            });
          }
        } catch (e) {
          Logger.warn('Phase A commentCount update failed (test batch)', {
            url: node.url,
            err: e instanceof Error ? e.message : String(e)
          });
        }
      }

      // Update alternate title directly on the latest PageVersion when available (test mode)
      if (wikidotId != null) {
        try {
          const currentVersion = await loadCurrentVersion();
          if (currentVersion && !currentVersion.isDeleted) {
            const alternateTitle = extractAlternateTitle(node);
            const existingAlternateTitle = currentVersion.alternateTitle ?? null;

            if (alternateTitle !== existingAlternateTitle) {
              await this.store.prisma.pageVersion.update({
                where: { id: currentVersion.id },
                data: { alternateTitle }
              });
            }
          }
        } catch (e) {
          Logger.warn('Phase A alternateTitle update failed (test batch)', {
            url: node.url,
            err: e instanceof Error ? e.message : String(e)
          });
        }
      }

      totalCostInBatch += estCost;
      processedCount++;
      if (bar) bar.increment(1);
    }

    const elapsedTime = (Date.now() - startTime) / 1000;
    const speed = elapsedTime > 0 && processedCount > 0
      ? (processedCount / elapsedTime).toFixed(1) + ' pages/s'
      : 'N/A';

    Logger.info(`✅ Test batch completed: ${processedCount} pages scanned in ${elapsedTime.toFixed(1)}s (${speed})`);
    if (bar) bar.stop();
    Logger.info(`💰 Estimated total cost for test batch: ${totalCostInBatch} points`);

    // Build dirty queue with only the test batch data
    Logger.info('🔍 Building dirty page queue for test batch...');
    const queueStats = await this.store.buildDirtyQueueTestMode();

    return {
      totalScanned: processedCount,
      elapsedTime,
      speed,
      queueStats,
    };
  }

  // Legacy method for backward compatibility
  async run(): Promise<PhaseAResult> {
    return await this.runComplete();
  }
}
