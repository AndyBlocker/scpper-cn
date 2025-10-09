import { Prisma, PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../src/utils/db-connection.js';
import chalk from 'chalk';

type WatchDrift = {
  id: number;
  pageId: number;
  wikidotId: number;
  currentUrl: string;
  userId: number;
  lastObserved: number | null;
  commentCount: number | null;
  updatedAt: Date | null;
};

type AlertRecord = {
  watchId: number;
  detectedAt: Date;
  newValue: number | null;
};

function asNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function fetchWatchDrift(prisma: PrismaClient): Promise<WatchDrift[]> {
  const rows = await prisma.$queryRaw<WatchDrift[]>(Prisma.sql`
    SELECT
      w.id,
      w."pageId",
      p."wikidotId",
      p."currentUrl",
      w."userId",
      w."lastObserved",
      pv."commentCount",
      pv."updatedAt"
    FROM "PageMetricWatch" w
    JOIN "PageVersion" pv ON pv."pageId" = w."pageId" AND pv."validTo" IS NULL
    JOIN "Page" p ON p.id = w."pageId"
    WHERE w.metric = 'COMMENT_COUNT'::"PageMetricType"
      AND w."source" = 'AUTO_OWNERSHIP'
      AND w."mutedAt" IS NULL
      AND pv."commentCount" IS NOT NULL
      AND (w."lastObserved" IS NULL OR pv."commentCount" <> w."lastObserved")
  `);

  return rows.map(row => ({
    ...row,
    lastObserved: asNumber(row.lastObserved),
    commentCount: asNumber(row.commentCount)
  }));
}

async function fetchLatestAlerts(prisma: PrismaClient, watchIds: number[]): Promise<Map<number, AlertRecord>> {
  if (watchIds.length === 0) {
    return new Map();
  }
  const alerts = await prisma.pageMetricAlert.findMany({
    where: {
      watchId: { in: watchIds },
      metric: 'COMMENT_COUNT'
    },
    orderBy: { detectedAt: 'desc' },
    select: { watchId: true, detectedAt: true, newValue: true }
  });

  const map = new Map<number, AlertRecord>();
  for (const alert of alerts) {
    if (!map.has(alert.watchId)) {
      map.set(alert.watchId, {
        watchId: alert.watchId,
        detectedAt: alert.detectedAt,
        newValue: asNumber(alert.newValue)
      });
    }
  }
  return map;
}

function toLocal(date: Date | null, timeZone = 'Asia/Shanghai') {
  if (!date) return 'null';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}

function formatIssue(
  watch: WatchDrift,
  alert: AlertRecord | undefined,
  watermarkTs: Date | null
) {
  const lastObserved = watch.lastObserved === null ? 'null' : watch.lastObserved.toString();
  const commentCount = watch.commentCount === null ? 'null' : watch.commentCount.toString();
  const lastAlert = alert ? `${alert.detectedAt.toISOString()} (new=${alert.newValue ?? 'null'})` : 'none';
  const deltaFromCursorHours = watermarkTs && watch.updatedAt
    ? ((watch.updatedAt.getTime() - watermarkTs.getTime()) / 36e5).toFixed(2)
    : 'n/a';
  const behindCursor = watermarkTs && watch.updatedAt
    ? watch.updatedAt.getTime() <= watermarkTs.getTime()
    : false;

  return {
    watchId: watch.id,
    pageId: watch.pageId,
    wikidotId: watch.wikidotId,
    url: watch.currentUrl,
    userId: watch.userId,
    lastObserved,
    commentCount,
    versionUpdatedAtUTC: watch.updatedAt ? watch.updatedAt.toISOString() : 'null',
    versionUpdatedAtLocal: toLocal(watch.updatedAt),
    deltaFromCursorHours,
    behindCursor,
    lastAlert,
    lastAlertLocal: alert ? toLocal(alert.detectedAt) : 'none'
  };
}

function describeWatermark(cursorTs?: Date | null, lastRunAt?: Date | null, newestVersionTs?: Date | null) {
  const now = Date.now();
  const summary: Record<string, string> = {};
  if (cursorTs) {
    summary.cursorTsUTC = cursorTs.toISOString();
    summary.cursorTsLocal = toLocal(cursorTs);
    const skewMs = cursorTs.getTime() - now;
    summary.skewVsNowMs = skewMs.toString();
  } else {
    summary.cursorTsUTC = 'none';
  }
  summary.lastRunAtUTC = lastRunAt ? lastRunAt.toISOString() : 'none';
  summary.lastRunAtLocal = lastRunAt ? toLocal(lastRunAt) : 'none';
  if (cursorTs && newestVersionTs) {
    const deltaMs = newestVersionTs.getTime() - cursorTs.getTime();
    summary.deltaNewestMinusCursorMs = deltaMs.toString();
  }
  summary.newestVersionUpdatedAtUTC = newestVersionTs ? newestVersionTs.toISOString() : 'unknown';
  summary.newestVersionUpdatedAtLocal = newestVersionTs ? toLocal(newestVersionTs) : 'unknown';
  return summary;
}

async function main() {
  const prisma = getPrismaClient();
  try {
    const [watermark, newestVersion, drifts] = await Promise.all([
      prisma.analysisWatermark.findUnique({
        where: { task: 'page_metric_alerts' },
        select: { cursorTs: true, lastRunAt: true }
      }),
      prisma.pageVersion.findFirst({
        where: { validTo: null, isDeleted: false },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true }
      }),
      fetchWatchDrift(prisma)
    ]);

    const latestAlerts = await fetchLatestAlerts(
      prisma,
      drifts.map(item => item.id)
    );

    const issues = drifts.map(watch => formatIssue(watch, latestAlerts.get(watch.id), watermark?.cursorTs ?? null));

    const watermarkSummary = describeWatermark(
      watermark?.cursorTs ?? null,
      watermark?.lastRunAt ?? null,
      newestVersion?.updatedAt ?? null
    );

    const futureSkew = watermark?.cursorTs
      ? watermark.cursorTs.getTime() - Date.now()
      : 0;

    const skewWarning = watermark?.cursorTs && futureSkew > 5 * 60 * 1000;
    const inverseWarning = watermark?.cursorTs && newestVersion?.updatedAt
      ? watermark.cursorTs.getTime() - newestVersion.updatedAt.getTime() > 0
      : false;
    const behindCursorCount = issues.filter(issue => issue.behindCursor).length;

    console.log(chalk.bold('Comment Alert Pipeline Health Check'));
    console.log('Watermark:', watermarkSummary);
    console.log(`Drifted watches: ${issues.length}`);
    if (behindCursorCount > 0) {
      console.log(chalk.red(`⚠️ ${behindCursorCount} watches have updatedAt <= cursor (potential timezone/config issue).`));
    }

    if (skewWarning) {
      console.log(chalk.red('⚠️ Watermark cursor is ahead of current time by more than 5 minutes.'));
    }
    if (inverseWarning) {
      console.log(chalk.red('⚠️ Watermark cursor is ahead of latest PageVersion.updatedAt.'));
    }

    if (issues.length === 0 && !skewWarning && !inverseWarning) {
      console.log(chalk.green('✅ No inconsistencies detected.'));
      return;
    }

    if (issues.length > 0) {
      console.log(chalk.yellow('Detected watcher/PageVersion mismatches:'));
      for (const issue of issues) {
        console.log(` - watch ${issue.watchId} | page ${issue.wikidotId} (${issue.url}) | user ${issue.userId}`);
        console.log(`   commentCount=${issue.commentCount}, lastObserved=${issue.lastObserved}`);
        console.log(`   versionUpdatedAt UTC=${issue.versionUpdatedAtUTC}, local=${issue.versionUpdatedAtLocal}`);
        console.log(`   Δ(updatedAt - cursor)≈${issue.deltaFromCursorHours}h, behindCursor=${issue.behindCursor}`);
        console.log(`   lastAlert=${issue.lastAlert} (local ${issue.lastAlertLocal})`);
      }
    }

    if (!skewWarning && !inverseWarning) {
      console.log(chalk.yellow('⚠️ Review mismatched watchers above.'));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('Comment alert pipeline check failed:', err);
  process.exitCode = 1;
});
