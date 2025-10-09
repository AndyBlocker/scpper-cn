import { PageMetricType } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as dotenv from 'dotenv';
import { createRequire } from 'module';
import { disconnectPrisma, getPrismaClient } from '../utils/db-connection.js';

type CheckAlertsOptions = {
  limit?: string | number;
  since?: string;
  json?: boolean;
  userDbUrl?: string;
};

type RecentVersionInfo = {
  pageId: number;
  versionId: number;
  createdAt: Date;
  title: string | null;
  pageUrl: string;
};

type AlertSource = {
  watchSource: string;
  registrationSource: 'user-backend' | 'fallback';
};

type AlertSummary = {
  alertId: number;
  detectedAt: string;
  metric: PageMetricType;
  pageId: number;
  pageUrl: string;
  diffValue: number | null;
  prevValue: number | null;
  newValue: number | null;
  userId: number;
  wikidotId: number;
  userLabel: string;
  source: AlertSource;
};

const MAX_LIMIT = 200000;
const USER_BACKEND_CLIENT_PATH = '../../../user-backend/node_modules/@prisma/client/index.js';

type RegisteredUserSet = {
  set: Set<number> | null;
  source: 'user-backend' | 'missing-env' | 'error';
};

let registeredCache: RegisteredUserSet | null = null;
let userDbUrlOverride: string | null = null;
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
let userEnvLoaded = false;

function ensureUserBackendEnv(): void {
  if (userEnvLoaded) return;
  const candidate = path.resolve(__dirname, '../../../user-backend/.env');
  if (fs.existsSync(candidate)) {
    dotenv.config({ path: candidate, override: false });
  }
  userEnvLoaded = true;
}

async function resolveRegisteredUsers(): Promise<RegisteredUserSet> {
  if (registeredCache) {
    return registeredCache;
  }

  ensureUserBackendEnv();

  const userDbUrl = userDbUrlOverride || process.env.USER_DATABASE_URL || process.env.USER_BACKEND_DATABASE_URL;
  if (!userDbUrl) {
    registeredCache = { set: null, source: 'missing-env' };
    return registeredCache;
  }

  try {
    const localRequire = createRequire(import.meta.url);
    const userBackendModule: any = localRequire(USER_BACKEND_CLIENT_PATH);
    const UserBackendPrismaClient = userBackendModule?.PrismaClient;
    if (typeof UserBackendPrismaClient !== 'function') {
      registeredCache = { set: null, source: 'error' };
      return registeredCache;
    }

    const userClient: any = new UserBackendPrismaClient({
      datasources: {
        db: { url: userDbUrl }
      }
    });

    try {
      const rows: Array<{ linkedWikidotId: number | null; status?: string | null }> = await userClient.userAccount.findMany({
        where: {
          linkedWikidotId: { not: null },
          status: 'ACTIVE'
        },
        select: {
          linkedWikidotId: true,
          status: true
        }
      });

      const set = new Set<number>();
      for (const row of rows) {
        const id = row?.linkedWikidotId;
        if (typeof id === 'number' && Number.isFinite(id)) {
          set.add(id);
        }
      }
      registeredCache = { set, source: 'user-backend' };
      return registeredCache;
    } finally {
      await userClient.$disconnect?.();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[alerts] Unable to load registered-user list from user-backend:', message);
    registeredCache = { set: null, source: 'error' };
    return registeredCache;
  }
}

function parseLimit(raw: string | number | undefined): number {
  if (raw === undefined) return 20;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid limit value: ${raw}`);
  }
  return Math.min(parsed, MAX_LIMIT);
}

function formatUserLabel(user: { displayName: string | null; username: string | null; wikidotId: number }): string {
  if (user.displayName && user.displayName.trim().length > 0) {
    return user.displayName.trim();
  }
  if (user.username && user.username.trim().length > 0) {
    return user.username.trim();
  }
  return `wikidot:${user.wikidotId}`;
}

function buildRow(alert: AlertSummary): string {
  const diff = alert.diffValue === null || alert.diffValue === undefined
    ? '--'
    : alert.diffValue > 0
      ? `+${alert.diffValue}`
      : String(alert.diffValue);
  const prev = alert.prevValue === null ? '--' : String(alert.prevValue);
  const next = alert.newValue === null ? '--' : String(alert.newValue);
  return [
    alert.detectedAt,
    alert.metric.padEnd(14),
    diff.padStart(6),
    `prev ${prev}`,
    `-> ${next}`,
    alert.pageUrl,
    `user ${alert.userLabel} (#${alert.wikidotId})`,
    `watch:${alert.source.watchSource}`
  ].join(' | ');
}

type PageVersionRow = {
  id: number;
  createdAt: Date;
  title: string | null;
  pageId: number;
  page: { currentUrl: string };
};

export async function checkRecentAlerts(options: CheckAlertsOptions = {}): Promise<void> {
  const prisma = getPrismaClient();

  try {
    let since: Date | null = null;
    let rawVersions: PageVersionRow[] = [];
    let usingExplicitSince = false;
    let limitValue: number | null = null;

    if (options.userDbUrl && options.userDbUrl.trim().length > 0) {
      const trimmed = options.userDbUrl.trim();
      if (userDbUrlOverride !== trimmed) {
        userDbUrlOverride = trimmed;
        registeredCache = null;
      }
    }

    if (options.since) {
      const parsed = new Date(options.since);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`Invalid --since value, must be a valid ISO date: ${options.since}`);
      }
      since = parsed;
      usingExplicitSince = true;

      rawVersions = await prisma.pageVersion.findMany({
        where: {
          createdAt: { gte: since }
        },
        select: {
          id: true,
          createdAt: true,
          title: true,
          pageId: true,
          page: {
            select: {
              currentUrl: true
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      });
    } else {
      limitValue = parseLimit(options.limit);
      rawVersions = await prisma.pageVersion.findMany({
        take: limitValue,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          createdAt: true,
          title: true,
          pageId: true,
          page: {
            select: {
              currentUrl: true
            }
          }
        }
      });

      if (rawVersions.length > 0) {
        since = rawVersions[rawVersions.length - 1].createdAt;
      }
    }

    if (!since) {
      console.log('No recent page updates found; nothing to inspect.');
      return;
    }

    const versionDetails: RecentVersionInfo[] = rawVersions.map(version => ({
      pageId: version.pageId,
      versionId: version.id,
      createdAt: version.createdAt,
      title: version.title ?? null,
      pageUrl: version.page.currentUrl
    }));

    const uniquePageIds = Array.from(new Set(versionDetails.map(v => v.pageId)));

    const alertsRaw = await prisma.pageMetricAlert.findMany({
      where: {
        detectedAt: { gte: since },
        ...(uniquePageIds.length > 0 ? { pageId: { in: uniquePageIds } } : {}),
        watch: {
          user: {
            wikidotId: { not: null }
          }
        }
      },
      select: {
        id: true,
        detectedAt: true,
        metric: true,
        diffValue: true,
        prevValue: true,
        newValue: true,
        pageId: true,
        page: {
          select: {
            currentUrl: true
          }
        },
        watch: {
          select: {
            source: true,
            user: {
              select: {
                id: true,
                wikidotId: true,
                displayName: true,
                username: true
              }
            }
          }
        }
      },
      orderBy: { detectedAt: 'desc' }
    });

    const alerts: AlertSummary[] = alertsRaw
      .map(alert => {
        const user = alert.watch.user;
        if (!user || user.wikidotId === null || user.wikidotId === undefined) {
          return null;
        }
        const wikidotId = user.wikidotId as number;
        return {
          alertId: alert.id,
          detectedAt: alert.detectedAt.toISOString(),
          metric: alert.metric,
          pageId: alert.pageId,
          pageUrl: alert.page.currentUrl,
          diffValue: alert.diffValue === null ? null : Number(alert.diffValue),
          prevValue: alert.prevValue === null ? null : Number(alert.prevValue),
          newValue: alert.newValue === null ? null : Number(alert.newValue),
          userId: user.id,
          wikidotId,
          userLabel: formatUserLabel({ displayName: user.displayName, username: user.username, wikidotId }),
          source: {
            watchSource: alert.watch.source ?? 'UNKNOWN',
            registrationSource: 'fallback'
          }
        };
      })
      .filter((entry): entry is AlertSummary => entry !== null);

    const { set: registeredSet, source: registeredSource } = await resolveRegisteredUsers();
    const filteredAlerts = registeredSet
      ? alerts.filter(alert => registeredSet.has(alert.wikidotId))
      : alerts;

    if (registeredSet) {
      for (const alert of filteredAlerts) {
        alert.source.registrationSource = 'user-backend';
      }
    }

    const uniqueUsers = new Set(filteredAlerts.map(alert => alert.wikidotId));
    const uniqueAlertPages = new Set(filteredAlerts.map(alert => alert.pageId));

    const excludedCount = alerts.length - filteredAlerts.length;

    if (options.json) {
      const payload = {
        inspectedVersionCount: versionDetails.length,
        since: since.toISOString(),
        filter: usingExplicitSince ? { type: 'explicit-since' } : { type: 'recent-versions', limit: limitValue },
        pagesInspected: uniquePageIds.length,
        alertCount: filteredAlerts.length,
        userCount: uniqueUsers.size,
        pageCountWithAlerts: uniqueAlertPages.size,
        registrationFilter: registeredSet
          ? { applied: true, source: registeredSource, excluded: excludedCount }
          : { applied: false, source: registeredSource },
        alerts: filteredAlerts
      };
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    const sinceLabel = since.toISOString();
    if (usingExplicitSince) {
      console.log(`Inspecting alerts since ${sinceLabel} (explicit --since).`);
    } else {
      const limitText = limitValue === null ? 'n/a' : String(limitValue);
      console.log(`Inspecting alerts for the latest ${versionDetails.length}/${limitText} page updates (since ${sinceLabel}).`);
    }

    if (registeredSet) {
      console.log(`Registration filter: using user-backend (${filteredAlerts.length} alerts matched, ${excludedCount} filtered out).`);
    } else if (registeredSource === 'missing-env') {
      console.log('Registration filter skipped: USER_DATABASE_URL not configured.');
    } else if (registeredSource === 'error') {
      console.log('Registration filter unavailable due to lookup error; falling back to wikidotId presence.');
    }

    console.log(`Pages touched: ${uniquePageIds.length}. Alerts affecting registered users: ${filteredAlerts.length}.`);
    if (filteredAlerts.length === 0) {
      console.log('No alerts raised for registered users within the inspected window.');
      return;
    }

    console.log(`Registered users impacted: ${uniqueUsers.size}. Pages with alerts: ${uniqueAlertPages.size}.`);
    console.log('---');

    for (const alert of filteredAlerts) {
      console.log(buildRow(alert));
    }
  } catch (error: unknown) {
    const err = error as Error;
    console.error('Failed to inspect recent alerts:', err.message);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exitCode = 1;
  } finally {
    await disconnectPrisma();
  }
}
