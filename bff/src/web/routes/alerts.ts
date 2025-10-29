import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { fetchAuthUser, type AuthUserPayload } from '../utils/auth.js';

interface AlertsQueryRow {
  id: number;
  metric: string;
  prevValue: number | null;
  newValue: number | null;
  diffValue: number | null;
  detectedAt: string;
  acknowledgedAt: string | null;
  pageId: number;
  pageWikidotId: number | null;
  pageUrl: string | null;
  pageTitle: string | null;
  pageAlternateTitle: string | null;
  source: string;
}

const METRIC_ALIAS: Record<string, string> = {
  comment: 'COMMENT_COUNT',
  vote: 'VOTE_COUNT',
  rating: 'RATING',
  revision: 'REVISION_COUNT',
  score: 'SCORE'
};

const AUTO_WATCH_SOURCE = 'AUTO_OWNERSHIP';
const DEFAULT_VOTE_THRESHOLD = 20;
const MUTABLE_METRICS = ['COMMENT_COUNT', 'VOTE_COUNT', 'REVISION_COUNT'] as const;
type MutableMetric = typeof MUTABLE_METRICS[number];

type RevisionFilter = 'ANY' | 'NON_OWNER' | 'NON_OWNER_NO_ATTR';

const REVISION_FILTERS: RevisionFilter[] = ['ANY', 'NON_OWNER', 'NON_OWNER_NO_ATTR'];

function sanitizeVoteThreshold(value: unknown): number | null {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value > 0 && value <= 1000) {
      return Math.round(value);
    }
    return null;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 1000) {
      return Math.round(parsed);
    }
  }
  return null;
}

function sanitizeRevisionFilter(value: unknown): RevisionFilter | null {
  if (typeof value !== 'string') {
    return null;
  }
  const upper = value.toUpperCase();
  return (REVISION_FILTERS as string[]).includes(upper) ? (upper as RevisionFilter) : null;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normaliseNumeric(input: unknown): number | null {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return Number(input);
  }
  if (typeof input === 'string' && input.trim().length > 0) {
    const parsed = Number(input);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function buildVoteWatchConfig(existing: unknown, threshold: number, lastObserved: unknown): Record<string, unknown> {
  const base = isJsonObject(existing) ? { ...existing } : {};
  base.voteThreshold = threshold;
  base.lastAppliedThreshold = threshold;
  base.pendingDiff = 0;
  const baseline = normaliseNumeric(lastObserved);
  base.baselineValue = baseline === null ? null : baseline;
  return base;
}

function extractVoteThreshold(config: any, fallback: number): number {
  if (config && typeof config === 'object') {
    const candidate = (config.voteThreshold ?? config.threshold) as unknown;
    const sanitised = sanitizeVoteThreshold(candidate);
    if (sanitised !== null) {
      return sanitised;
    }
  }
  return fallback;
}

function extractRevisionFilter(config: any, fallback: RevisionFilter): RevisionFilter {
  if (config && typeof config === 'object') {
    const candidate = (config.revisionFilter ?? config.filter) as unknown;
    const sanitised = sanitizeRevisionFilter(candidate);
    if (sanitised) {
      return sanitised;
    }
  }
  return fallback;
}

function extractMuted(config: any): boolean | null {
  if (!config || typeof config !== 'object') {
    return null;
  }
  const value = (config as Record<string, unknown>).muted;
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalised = value.trim().toLowerCase();
    if (normalised === 'true') return true;
    if (normalised === 'false') return false;
  }
  return null;
}

async function resolvePreferences(pool: Pool, userId: number): Promise<{ voteCountThreshold: number; revisionFilter: RevisionFilter; mutedMetrics: Record<MutableMetric, boolean> }> {
  let voteThreshold = DEFAULT_VOTE_THRESHOLD;
  let revisionFilter: RevisionFilter = 'ANY';
  let hasVotePref = false;
  let hasRevisionPref = false;
  const mutedMetrics: Record<MutableMetric, boolean> = {
    COMMENT_COUNT: false,
    VOTE_COUNT: false,
    REVISION_COUNT: false
  };

  const prefSql = `
    SELECT "metric", "config"
    FROM "UserMetricPreference"
    WHERE "userId" = $1
      AND "metric" IN ('COMMENT_COUNT', 'VOTE_COUNT', 'REVISION_COUNT')
  `;
  const prefResult = await pool.query<{ metric: string; config: any }>(prefSql, [userId]);
  for (const row of prefResult.rows) {
    if (row.metric === 'VOTE_COUNT') {
      voteThreshold = extractVoteThreshold(row.config, voteThreshold);
      hasVotePref = true;
    } else if (row.metric === 'REVISION_COUNT') {
      revisionFilter = extractRevisionFilter(row.config, revisionFilter);
      hasRevisionPref = true;
    }

    if (row.metric === 'COMMENT_COUNT' || row.metric === 'VOTE_COUNT' || row.metric === 'REVISION_COUNT') {
      const muted = extractMuted(row.config);
      if (muted !== null) {
        mutedMetrics[row.metric as MutableMetric] = muted;
      }
    }
  }

  if (!hasVotePref) {
    const voteWatchSql = `
      SELECT "thresholdValue", "config"
      FROM "PageMetricWatch"
      WHERE "userId" = $1
        AND "metric" = 'VOTE_COUNT'::"PageMetricType"
        AND "source" = $2
      ORDER BY "updatedAt" DESC
      LIMIT 1
    `;
    const voteWatch = await pool.query<{ thresholdValue: number | null; config: any }>(voteWatchSql, [userId, AUTO_WATCH_SOURCE]);
    const row = voteWatch.rows[0];
    if (row) {
      const thresholdFromColumn = sanitizeVoteThreshold(row.thresholdValue);
      if (thresholdFromColumn !== null) {
        voteThreshold = thresholdFromColumn;
      } else {
        voteThreshold = extractVoteThreshold(row.config, voteThreshold);
      }
    }
  }

  if (!hasRevisionPref) {
    const revisionWatchSql = `
      SELECT "config"
      FROM "PageMetricWatch"
      WHERE "userId" = $1
        AND "metric" = 'REVISION_COUNT'::"PageMetricType"
        AND "source" = $2
      ORDER BY "updatedAt" DESC
      LIMIT 1
    `;
    const revisionWatch = await pool.query<{ config: any }>(revisionWatchSql, [userId, AUTO_WATCH_SOURCE]);
    const row = revisionWatch.rows[0];
    if (row) {
      revisionFilter = extractRevisionFilter(row.config, revisionFilter);
    }
  }

  const mutedResult = await pool.query<{ metric: string; isMuted: boolean }>(
    `
      SELECT "metric", BOOL_OR("mutedAt" IS NOT NULL) AS "isMuted"
      FROM "PageMetricWatch"
      WHERE "userId" = $1
        AND "source" = $2
        AND "metric" = ANY($3::"PageMetricType"[])
      GROUP BY "metric"
    `,
    [userId, AUTO_WATCH_SOURCE, Array.from(MUTABLE_METRICS)]
  );

  for (const row of mutedResult.rows) {
    const metric = row.metric as MutableMetric | undefined;
    if (!metric || !MUTABLE_METRICS.includes(metric)) {
      continue;
    }
    mutedMetrics[metric] = Boolean(row.isMuted);
  }

  return {
    voteCountThreshold: voteThreshold,
    revisionFilter,
    mutedMetrics
  };
}

async function resolveAppUserId(pool: Pool, authUser: AuthUserPayload): Promise<number | null> {
  const parsed = Number.parseInt(authUser.id, 10);
  if (Number.isFinite(parsed)) {
    return parsed;
  }
  if (authUser.linkedWikidotId == null) {
    return null;
  }
  const result = await pool.query<{ id: number }>(
    'SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1',
    [authUser.linkedWikidotId]
  );
  const resolved = result.rows[0]?.id;
  return Number.isFinite(resolved) ? resolved : null;
}

function normalizeMetric(metricParam?: string): string {
  if (!metricParam) return METRIC_ALIAS.comment;
  const key = metricParam.toLowerCase();
  return METRIC_ALIAS[key] || METRIC_ALIAS.comment;
}

export function alertsRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const authUser = await fetchAuthUser(req);
      if (!authUser || authUser.linkedWikidotId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }

      const metric = normalizeMetric(req.query.metric as string | undefined);
      const limitParam = Number.parseInt(String(req.query.limit ?? '20'), 10);
      const offsetParam = Number.parseInt(String(req.query.offset ?? '0'), 10);
      const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 50)) : 20;
      const offset = Number.isFinite(offsetParam) ? Math.max(0, offsetParam) : 0;

      const alertsQuery = `
        SELECT 
          pa.id,
          pa."metric",
          pa."prevValue",
          pa."newValue",
          pa."diffValue",
          pa."detectedAt",
          pa."acknowledgedAt",
          pa."pageId",
          p."wikidotId" AS "pageWikidotId",
          p."currentUrl" AS "pageUrl",
          pv.title AS "pageTitle",
          pv."alternateTitle" AS "pageAlternateTitle",
          pw."source"
        FROM "PageMetricAlert" pa
        JOIN "PageMetricWatch" pw ON pw.id = pa."watchId"
        JOIN "User" u ON u.id = pw."userId"
        JOIN "Page" p ON p.id = pa."pageId"
        LEFT JOIN "PageVersion" pv ON pv."pageId" = pa."pageId" AND pv."validTo" IS NULL
        WHERE u."wikidotId" = $1
          AND pa."metric" = $2::"PageMetricType"
        ORDER BY pa."detectedAt" DESC
        LIMIT $3 OFFSET $4
      `;

      const unreadQuery = `
        SELECT COUNT(*)::int AS count
        FROM "PageMetricAlert" pa
        JOIN "PageMetricWatch" pw ON pw.id = pa."watchId"
        JOIN "User" u ON u.id = pw."userId"
        WHERE u."wikidotId" = $1
          AND pa."metric" = $2::"PageMetricType"
          AND pa."acknowledgedAt" IS NULL
      `;

      const [alertsResult, unreadResult] = await Promise.all([
        pool.query<AlertsQueryRow>(alertsQuery, [authUser.linkedWikidotId, metric, limit, offset]),
        pool.query<{ count: number }>(unreadQuery, [authUser.linkedWikidotId, metric])
      ]);

      const unreadCount = unreadResult.rows[0]?.count ?? 0;
      const alerts = alertsResult.rows.map(row => ({
        id: row.id,
        metric: row.metric,
        prevValue: row.prevValue,
        newValue: row.newValue,
        diffValue: row.diffValue,
        detectedAt: row.detectedAt,
        acknowledgedAt: row.acknowledgedAt,
        pageId: row.pageId,
        pageWikidotId: row.pageWikidotId,
        pageUrl: row.pageUrl,
        pageTitle: row.pageTitle,
        pageAlternateTitle: row.pageAlternateTitle,
        source: row.source
      }));

      res.json({ ok: true, metric, unreadCount, alerts });
    } catch (error) {
      next(error);
    }
  });

  router.get('/preferences', async (req, res, next) => {
    try {
      const authUser = await fetchAuthUser(req);
      if (!authUser || authUser.linkedWikidotId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }

      const userId = await resolveAppUserId(pool, authUser);
      if (userId == null) {
        return res.status(404).json({ ok: false, error: 'user_not_found' });
      }
      const preferences = await resolvePreferences(pool, userId);
      res.json({ ok: true, preferences });
    } catch (error) {
      next(error);
    }
  });

  router.post('/preferences', async (req, res, next) => {
    try {
      const authUser = await fetchAuthUser(req);
      if (!authUser || authUser.linkedWikidotId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }

      const userId = await resolveAppUserId(pool, authUser);
      if (userId == null) {
        return res.status(404).json({ ok: false, error: 'user_not_found' });
      }

      const voteThresholdInput = req.body?.voteCountThreshold;
      const revisionFilterInput = req.body?.revisionFilter;

      const updates: Array<'vote' | 'revision'> = [];
      let voteThreshold: number | null = null;
      if (voteThresholdInput !== undefined) {
        const sanitised = sanitizeVoteThreshold(voteThresholdInput);
        if (sanitised === null) {
          return res.status(400).json({ ok: false, error: 'invalid_vote_threshold' });
        }
        voteThreshold = sanitised;
        updates.push('vote');
      }

      let revisionFilter: RevisionFilter | null = null;
      if (revisionFilterInput !== undefined) {
        const sanitised = sanitizeRevisionFilter(revisionFilterInput);
        if (!sanitised) {
          return res.status(400).json({ ok: false, error: 'invalid_revision_filter', allowed: REVISION_FILTERS });
        }
        revisionFilter = sanitised;
        updates.push('revision');
      }

      if (updates.length === 0) {
        return res.status(400).json({ ok: false, error: 'no_updates_provided' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (updates.includes('vote') && voteThreshold !== null) {
          const updatePref = await client.query(
            `
              UPDATE "UserMetricPreference"
              SET "config" = jsonb_set(COALESCE("config", '{}'::jsonb), '{voteThreshold}', to_jsonb($2::numeric), true),
                  "updatedAt" = NOW()
              WHERE "userId" = $1
                AND "metric" = 'VOTE_COUNT'::"PageMetricType"
            `,
            [userId, voteThreshold]
          );

          if (updatePref.rowCount === 0) {
            await client.query(
              `
                INSERT INTO "UserMetricPreference" ("userId", "metric", "config", "createdAt", "updatedAt")
                VALUES ($1, 'VOTE_COUNT'::"PageMetricType", jsonb_build_object('voteThreshold', $2::numeric), NOW(), NOW())
              `,
              [userId, voteThreshold]
            );
          }

          const watchRows = await client.query<{ id: number; lastObserved: number | null; config: any }>(
            `
              SELECT id, "lastObserved", "config"
              FROM "PageMetricWatch"
              WHERE "userId" = $1
                AND "metric" = 'VOTE_COUNT'::"PageMetricType"
                AND "source" = $2
            `,
            [userId, AUTO_WATCH_SOURCE]
          );

          for (const watch of watchRows.rows) {
            const config = buildVoteWatchConfig(watch.config, voteThreshold, watch.lastObserved);
            await client.query(
              `
                UPDATE "PageMetricWatch"
                SET "thresholdType" = 'ABSOLUTE',
                    "thresholdValue" = $2,
                    "config" = $3::jsonb,
                    "updatedAt" = NOW()
                WHERE id = $1
              `,
              [watch.id, voteThreshold, JSON.stringify(config)]
            );
          }
        }

        if (updates.includes('revision') && revisionFilter !== null) {
          const updatePref = await client.query(
            `
              UPDATE "UserMetricPreference"
              SET "config" = jsonb_set(COALESCE("config", '{}'::jsonb), '{revisionFilter}', to_jsonb($2::text), true),
                  "updatedAt" = NOW()
              WHERE "userId" = $1
                AND "metric" = 'REVISION_COUNT'::"PageMetricType"
            `,
            [userId, revisionFilter]
          );

          if (updatePref.rowCount === 0) {
            await client.query(
              `
                INSERT INTO "UserMetricPreference" ("userId", "metric", "config", "createdAt", "updatedAt")
                VALUES ($1, 'REVISION_COUNT'::"PageMetricType", jsonb_build_object('revisionFilter', $2::text), NOW(), NOW())
              `,
              [userId, revisionFilter]
            );
          }

          await client.query(
            `
              UPDATE "PageMetricWatch"
              SET "config" = jsonb_set(COALESCE("config", '{}'::jsonb), '{revisionFilter}', to_jsonb($2::text), true),
                  "lastObserved" = NULL,
                  "updatedAt" = NOW()
              WHERE "userId" = $1
                AND "metric" = 'REVISION_COUNT'::"PageMetricType"
                AND "source" = $3
            `,
            [userId, revisionFilter, AUTO_WATCH_SOURCE]
          );
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      const preferences = await resolvePreferences(pool, userId);
      res.json({ ok: true, preferences });
    } catch (error) {
      next(error);
    }
  });

  router.post('/preferences/mute', async (req, res, next) => {
    try {
      const authUser = await fetchAuthUser(req);
      if (!authUser || authUser.linkedWikidotId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }

      const userId = await resolveAppUserId(pool, authUser);
      if (userId == null) {
        return res.status(404).json({ ok: false, error: 'user_not_found' });
      }

      const metricInput = req.body?.metric;
      let metric: MutableMetric | null = null;
      if (typeof metricInput === 'string') {
        const normalised = metricInput.trim().toUpperCase();
        if (MUTABLE_METRICS.includes(normalised as MutableMetric)) {
          metric = normalised as MutableMetric;
        }
      }

      if (!metric) {
        return res.status(400).json({ ok: false, error: 'invalid_metric', allowed: MUTABLE_METRICS });
      }

      const mutedInput = req.body?.muted;
      let muted: boolean | null = null;
      if (typeof mutedInput === 'boolean') {
        muted = mutedInput;
      } else if (typeof mutedInput === 'string') {
        const normalised = mutedInput.trim().toLowerCase();
        if (normalised === 'true') muted = true;
        if (normalised === 'false') muted = false;
      }

      if (muted === null) {
        return res.status(400).json({ ok: false, error: 'invalid_muted_value' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        await client.query(
          `
            UPDATE "PageMetricWatch"
            SET "mutedAt" = CASE WHEN $3 THEN COALESCE("mutedAt", NOW()) ELSE NULL END,
                "updatedAt" = NOW()
            WHERE "userId" = $1
              AND "metric" = $2::"PageMetricType"
              AND "source" = $4
          `,
          [userId, metric, muted, AUTO_WATCH_SOURCE]
        );

        const prefUpdate = await client.query(
          `
            UPDATE "UserMetricPreference"
            SET "config" = jsonb_set(COALESCE("config", '{}'::jsonb), '{muted}', to_jsonb($3::boolean), true),
                "updatedAt" = NOW()
            WHERE "userId" = $1
              AND "metric" = $2::"PageMetricType"
          `,
          [userId, metric, muted]
        );

        if (prefUpdate.rowCount === 0) {
          await client.query(
            `
              INSERT INTO "UserMetricPreference" ("userId", "metric", "config", "createdAt", "updatedAt")
              VALUES ($1, $2::"PageMetricType", jsonb_build_object('muted', $3::boolean), NOW(), NOW())
            `,
            [userId, metric, muted]
          );
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }

      const preferences = await resolvePreferences(pool, userId);
      res.json({ ok: true, preferences });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/read', async (req, res, next) => {
    try {
      const authUser = await fetchAuthUser(req);
      if (!authUser || authUser.linkedWikidotId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }

      const alertId = Number.parseInt(String(req.params.id), 10);
      if (!Number.isFinite(alertId)) {
        return res.status(400).json({ ok: false, error: 'invalid_alert_id' });
      }

      const sql = `
        UPDATE "PageMetricAlert" pa
        SET "acknowledgedAt" = COALESCE(pa."acknowledgedAt", NOW())
        FROM "PageMetricWatch" pw
        JOIN "User" u ON u.id = pw."userId"
        WHERE pa.id = $1
          AND pa."watchId" = pw.id
          AND u."wikidotId" = $2
        RETURNING pa.id, pa."acknowledgedAt"
      `;
      const result = await pool.query<{ id: number; acknowledgedAt: string | null }>(sql, [alertId, authUser.linkedWikidotId]);
      if (result.rowCount === 0) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      const acknowledgedAt = result.rows[0]?.acknowledgedAt ?? null;
      res.json({ ok: true, id: alertId, acknowledgedAt });
    } catch (error) {
      next(error);
    }
  });

  router.post('/read-all', async (req, res, next) => {
    try {
      const authUser = await fetchAuthUser(req);
      if (!authUser || authUser.linkedWikidotId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }

      const metric = normalizeMetric(req.body?.metric as string | undefined);
      const sql = `
        UPDATE "PageMetricAlert" pa
        SET "acknowledgedAt" = COALESCE(pa."acknowledgedAt", NOW())
        FROM "PageMetricWatch" pw
        JOIN "User" u ON u.id = pw."userId"
        WHERE pa."watchId" = pw.id
          AND u."wikidotId" = $1
          AND pa."metric" = $2::"PageMetricType"
          AND pa."acknowledgedAt" IS NULL
        RETURNING pa.id
      `;
      const result = await pool.query<{ id: number }>(sql, [authUser.linkedWikidotId, metric]);
      res.json({ ok: true, updated: result.rowCount });
    } catch (error) {
      next(error);
    }
  });

  // Combined unread alerts grouped by page for the authenticated user
  router.get('/combined', async (req, res, next) => {
    try {
      const authUser = await fetchAuthUser(req);
      if (!authUser || authUser.linkedWikidotId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }

      const limitParam = Number.parseInt(String(req.query.limit ?? '20'), 10);
      const offsetParam = Number.parseInt(String(req.query.offset ?? '0'), 10);
      const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 50)) : 20;
      const offset = Number.isFinite(offsetParam) ? Math.max(0, offsetParam) : 0;

      const countResult = await pool.query<{ count: number }>(
        `
          SELECT COUNT(*)::int AS count
          FROM (
            SELECT DISTINCT pa."pageId"
            FROM "PageMetricAlert" pa
            JOIN "PageMetricWatch" pw ON pw.id = pa."watchId"
            JOIN "User" u ON u.id = pw."userId"
            WHERE u."wikidotId" = $1
              AND pa."acknowledgedAt" IS NULL
          ) AS t
        `,
        [authUser.linkedWikidotId]
      );
      const totalGroups = countResult.rows[0]?.count ?? 0;

      const groupRows = await pool.query<{ pageId: number; updatedAt: string }>(
        `
          SELECT pa."pageId" AS "pageId", MAX(pa."detectedAt") AS "updatedAt"
          FROM "PageMetricAlert" pa
          JOIN "PageMetricWatch" pw ON pw.id = pa."watchId"
          JOIN "User" u ON u.id = pw."userId"
          WHERE u."wikidotId" = $1
            AND pa."acknowledgedAt" IS NULL
          GROUP BY pa."pageId"
          ORDER BY "updatedAt" DESC
          LIMIT $2 OFFSET $3
        `,
        [authUser.linkedWikidotId, limit, offset]
      );

      if (groupRows.rowCount === 0) {
        return res.json({ ok: true, total: totalGroups, groups: [] });
      }

      const pageIds = groupRows.rows.map(r => r.pageId);
      const details = await pool.query<AlertsQueryRow>(
        `
          SELECT 
            pa.id,
            pa."metric",
            pa."prevValue",
            pa."newValue",
            pa."diffValue",
            pa."detectedAt",
            pa."acknowledgedAt",
            pa."pageId",
            p."wikidotId" AS "pageWikidotId",
            p."currentUrl" AS "pageUrl",
            pv.title AS "pageTitle",
            pv."alternateTitle" AS "pageAlternateTitle",
            pw."source"
          FROM "PageMetricAlert" pa
          JOIN "PageMetricWatch" pw ON pw.id = pa."watchId"
          JOIN "User" u ON u.id = pw."userId"
          JOIN "Page" p ON p.id = pa."pageId"
          LEFT JOIN "PageVersion" pv ON pv."pageId" = pa."pageId" AND pv."validTo" IS NULL
          WHERE u."wikidotId" = $1
            AND pa."acknowledgedAt" IS NULL
            AND pa."pageId" = ANY($2::int[])
          ORDER BY pa."detectedAt" DESC
        `,
        [authUser.linkedWikidotId, pageIds]
      );

      const grouped = new Map<number, any>();
      const updatedMap = new Map<number, string>();
      for (const r of groupRows.rows) {
        updatedMap.set(r.pageId, r.updatedAt);
      }

      for (const row of details.rows) {
        let group = grouped.get(row.pageId);
        if (!group) {
          group = {
            pageId: row.pageId,
            pageWikidotId: row.pageWikidotId,
            pageUrl: row.pageUrl,
            pageTitle: row.pageTitle,
            pageAlternateTitle: row.pageAlternateTitle,
            updatedAt: updatedMap.get(row.pageId) || row.detectedAt,
            alerts: [] as any[]
          };
          grouped.set(row.pageId, group);
        }
        group.alerts.push({
          id: row.id,
          metric: row.metric,
          prevValue: row.prevValue,
          newValue: row.newValue,
          diffValue: row.diffValue,
          detectedAt: row.detectedAt,
          acknowledgedAt: row.acknowledgedAt,
          pageId: row.pageId,
          pageWikidotId: row.pageWikidotId,
          pageUrl: row.pageUrl,
          pageTitle: row.pageTitle,
          pageAlternateTitle: row.pageAlternateTitle,
          source: row.source
        });
      }

      // Keep original order by updatedAt desc
      const groups = groupRows.rows
        .map(r => grouped.get(r.pageId))
        .filter(Boolean);

      res.json({ ok: true, total: totalGroups, groups });
    } catch (error) {
      next(error);
    }
  });

  // Batch mark alerts read (for combined view)
  router.post('/read-batch', async (req, res, next) => {
    try {
      const authUser = await fetchAuthUser(req);
      if (!authUser || authUser.linkedWikidotId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }

      const idsInput = req.body?.ids;
      if (!Array.isArray(idsInput)) {
        return res.status(400).json({ ok: false, error: 'invalid_ids' });
      }
      const ids = idsInput
        .map((v: any) => Number.parseInt(String(v), 10))
        .filter((n: number) => Number.isFinite(n));
      if (ids.length === 0) {
        return res.status(400).json({ ok: false, error: 'empty_ids' });
      }
      if (ids.length > 500) {
        return res.status(400).json({ ok: false, error: 'too_many_ids' });
      }

      const result = await pool.query<{ id: number }>(
        `
          UPDATE "PageMetricAlert" pa
          SET "acknowledgedAt" = COALESCE(pa."acknowledgedAt", NOW())
          FROM "PageMetricWatch" pw
          JOIN "User" u ON u.id = pw."userId"
          WHERE pa.id = ANY($2::int[])
            AND pa."watchId" = pw.id
            AND u."wikidotId" = $1
          RETURNING pa.id
        `,
        [authUser.linkedWikidotId, ids]
      );

      const updatedIds = result.rows.map(r => r.id);
      res.json({ ok: true, updated: updatedIds.length, ids: updatedIds });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
