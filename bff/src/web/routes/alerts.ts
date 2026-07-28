import { Router, type Request } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { fetchAuthUser, type AuthUserPayload } from '../utils/auth.js';
import { createCache } from '../utils/cache.js';
import { getReadPoolSync } from '../utils/dbPool.js';

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
const DEFAULT_IGNORE_LINKED_WIKIDOT_SELF_REVISION = true;
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

function sanitizeBoolean(value: unknown): boolean | null {
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

function extractIgnoreLinkedWikidotSelfRevision(config: any, fallback: boolean): boolean {
  if (config && typeof config === 'object') {
    const candidate = (config as Record<string, unknown>).ignoreLinkedWikidotSelfRevision;
    const sanitised = sanitizeBoolean(candidate);
    if (sanitised !== null) {
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

async function resolvePreferences(readPool: Pool, userId: number): Promise<{
  voteCountThreshold: number;
  revisionFilter: RevisionFilter;
  ignoreLinkedWikidotSelfRevision: boolean;
  mutedMetrics: Record<MutableMetric, boolean>;
}> {
  let voteThreshold = DEFAULT_VOTE_THRESHOLD;
  let revisionFilter: RevisionFilter = 'ANY';
  let ignoreLinkedWikidotSelfRevision = DEFAULT_IGNORE_LINKED_WIKIDOT_SELF_REVISION;
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
  const prefResult = await readPool.query<{ metric: string; config: any }>(prefSql, [userId]);
  for (const row of prefResult.rows) {
    if (row.metric === 'VOTE_COUNT') {
      voteThreshold = extractVoteThreshold(row.config, voteThreshold);
      hasVotePref = true;
    } else if (row.metric === 'REVISION_COUNT') {
      revisionFilter = extractRevisionFilter(row.config, revisionFilter);
      ignoreLinkedWikidotSelfRevision = extractIgnoreLinkedWikidotSelfRevision(row.config, ignoreLinkedWikidotSelfRevision);
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
    const voteWatch = await readPool.query<{ thresholdValue: number | null; config: any }>(voteWatchSql, [userId, AUTO_WATCH_SOURCE]);
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
    const revisionWatch = await readPool.query<{ config: any }>(revisionWatchSql, [userId, AUTO_WATCH_SOURCE]);
    const row = revisionWatch.rows[0];
    if (row) {
      revisionFilter = extractRevisionFilter(row.config, revisionFilter);
      ignoreLinkedWikidotSelfRevision = extractIgnoreLinkedWikidotSelfRevision(row.config, ignoreLinkedWikidotSelfRevision);
    }
  }

  const mutedResult = await readPool.query<{ metric: string; isMuted: boolean }>(
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
    ignoreLinkedWikidotSelfRevision,
    mutedMetrics
  };
}

/**
 * 把登录身份解析成主库 User.id。
 *
 * 原实现先试 `Number.parseInt(authUser.id, 10)` —— 但 authUser.id 是
 * user-backend 的 **cuid 字符串**，与主库 User.id（自增整数）毫无关系。
 * 目前 Prisma 的 cuid() 恒以字母 'c' 开头，parseInt 得到 NaN 才侥幸落到下面
 * 正确的 wikidotId 分支；一旦 id 生成器换成 nanoid（可能以数字开头），
 * 就会静默解析出**另一个用户的** User.id，读写到他人的提醒偏好。
 * 同文件的 GET / 走的本来就是 wikidotId 路径，两套识别方式也不一致。
 * 这里删掉那条捷径，统一只认 wikidotId。
 */
async function resolveAppUserId(readPool: Pool, authUser: AuthUserPayload): Promise<number | null> {
  if (authUser.linkedWikidotId == null) {
    return null;
  }
  const result = await readPool.query<{ id: number }>(
    'SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1',
    [authUser.linkedWikidotId]
  );
  const resolved = result.rows[0]?.id;
  return Number.isFinite(resolved) ? resolved : null;
}

/**
 * 解析 metric 参数；无法识别时返回 null 而不是静默回落。
 *
 * 原实现对任何无法识别的值（含拼写错误）一律返回 COMMENT_COUNT。
 * 后果不只是「查错了指标」——`POST /alerts/read-all` 传一个拼错的 metric
 * 会把该用户**所有评论提醒**误标为已读，且没有任何报错。
 */
function normalizeMetric(metricParam?: string): string | null {
  if (!metricParam) return METRIC_ALIAS.comment;
  const key = metricParam.toLowerCase();
  return METRIC_ALIAS[key] ?? null;
}

export function alertsRouter(pool: Pool, redis: RedisClientType | null) {
  const router = Router();
  const cache = createCache(redis);

  // 读写分离：读操作使用从库，写操作使用主库
  const readPool = getReadPoolSync(pool);

  // GET / 的响应（含 unreadCount 与每条的 acknowledgedAt）缓存 30 秒，
  // 而 key 里带了 metric/limit/offset，因此任何标记已读的写操作都必须整族失效，
  // 否则用户点完已读再刷新，未读数会在一个 TTL 内反复回弹。
  const invalidateAlertsCache = async (wikidotId: number) => {
    await cache.delByPrefix(`alerts:${wikidotId}:`);
  };

  router.get('/', async (req, res, next) => {
    try {
      const authUser = await fetchAuthUser(req);
      if (!authUser || authUser.linkedWikidotId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }

      const metric = normalizeMetric(req.query.metric as string | undefined);
      if (metric === null) {
        return res.status(400).json({ ok: false, error: 'invalid_metric' });
      }
      const limitParam = Number.parseInt(String(req.query.limit ?? '20'), 10);
      const offsetParam = Number.parseInt(String(req.query.offset ?? '0'), 10);
      const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 50)) : 20;
      const offset = Number.isFinite(offsetParam) ? Math.max(0, offsetParam) : 0;
      // 只要未读。没有它的话，前端拿到最近 20 条后再在客户端过滤已读，
      // 一旦最新 20 条都读过、更早的未读还在，界面就会显示「没有未读」
      // 而徽标仍有数字，且无从翻到那些未读。
      const unreadOnly = String(req.query.unreadOnly ?? '') === '1';

      // 缓存 30 秒 - 减少 sync 期间的数据库压力，同时保持数据较新
      const cacheKey = `alerts:${authUser.linkedWikidotId}:${metric}:${limit}:${offset}:${unreadOnly ? 'u' : 'a'}`;
      const result = await cache.remember(cacheKey, 30, async () => {
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
            ${unreadOnly ? 'AND pa."acknowledgedAt" IS NULL' : ''}
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
          readPool.query<AlertsQueryRow>(alertsQuery, [authUser.linkedWikidotId, metric, limit, offset]),
          readPool.query<{ count: number }>(unreadQuery, [authUser.linkedWikidotId, metric])
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

        return { ok: true, metric, unreadCount, alerts };
      });

      res.json(result);
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
      const ignoreLinkedWikidotSelfRevisionInput = req.body?.ignoreLinkedWikidotSelfRevision;

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
        if (!updates.includes('revision')) {
          updates.push('revision');
        }
      }

      let ignoreLinkedWikidotSelfRevision: boolean | null = null;
      if (ignoreLinkedWikidotSelfRevisionInput !== undefined) {
        const sanitised = sanitizeBoolean(ignoreLinkedWikidotSelfRevisionInput);
        if (sanitised === null) {
          return res.status(400).json({ ok: false, error: 'invalid_ignore_linked_wikidot_self_revision' });
        }
        ignoreLinkedWikidotSelfRevision = sanitised;
        if (!updates.includes('revision')) {
          updates.push('revision');
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ ok: false, error: 'no_updates_provided' });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        if (updates.includes('vote') && voteThreshold !== null) {
          // 原子 upsert。原先是「先 UPDATE，rowCount===0 再 INSERT」：
          // 两个并发请求都判定 0 行时，第二条 INSERT 会撞 uniq_user_metric_preference
          // 抛出未捕获异常 → 500。快速连点设置即可触发。
          await client.query(
            `
              INSERT INTO "UserMetricPreference" ("userId", "metric", "config", "createdAt", "updatedAt")
              VALUES ($1, 'VOTE_COUNT'::"PageMetricType", jsonb_build_object('voteThreshold', $2::numeric), NOW(), NOW())
              ON CONFLICT ("userId", "metric") DO UPDATE
              SET "config" = jsonb_set(COALESCE("UserMetricPreference"."config", '{}'::jsonb), '{voteThreshold}', to_jsonb($2::numeric), true),
                  "updatedAt" = NOW()
            `,
            [userId, voteThreshold]
          );

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

        if (updates.includes('revision')) {
          const prefRow = await client.query<{ id: number; config: any }>(
            `
              SELECT id, "config"
              FROM "UserMetricPreference"
              WHERE "userId" = $1
                AND "metric" = 'REVISION_COUNT'::"PageMetricType"
              LIMIT 1
              FOR UPDATE
            `,
            [userId]
          );

          const existingPref = prefRow.rows[0];
          const nextPrefConfig = isJsonObject(existingPref?.config) ? { ...existingPref.config } : {};
          if (revisionFilter !== null) {
            nextPrefConfig.revisionFilter = revisionFilter;
          } else {
            nextPrefConfig.revisionFilter = extractRevisionFilter(nextPrefConfig, 'ANY');
          }
          if (ignoreLinkedWikidotSelfRevision !== null) {
            nextPrefConfig.ignoreLinkedWikidotSelfRevision = ignoreLinkedWikidotSelfRevision;
          } else {
            nextPrefConfig.ignoreLinkedWikidotSelfRevision = extractIgnoreLinkedWikidotSelfRevision(
              nextPrefConfig,
              DEFAULT_IGNORE_LINKED_WIKIDOT_SELF_REVISION
            );
          }

          // 原子 upsert，理由同上（此处的 SELECT ... FOR UPDATE 对**不存在的行**
          // 加不上锁，所以先查后插同样有竞态）
          await client.query(
            `
              INSERT INTO "UserMetricPreference" ("userId", "metric", "config", "createdAt", "updatedAt")
              VALUES ($1, 'REVISION_COUNT'::"PageMetricType", $2::jsonb, NOW(), NOW())
              ON CONFLICT ("userId", "metric") DO UPDATE
              SET "config" = EXCLUDED."config",
                  "updatedAt" = NOW()
            `,
            [userId, JSON.stringify(nextPrefConfig)]
          );

          const watchRows = await client.query<{ id: number; config: any }>(
            `
              SELECT id, "config"
              FROM "PageMetricWatch"
              WHERE "userId" = $1
                AND "metric" = 'REVISION_COUNT'::"PageMetricType"
                AND "source" = $2
            `,
            [userId, AUTO_WATCH_SOURCE]
          );

          for (const watch of watchRows.rows) {
            const nextWatchConfig = isJsonObject(watch.config) ? { ...watch.config } : {};
            nextWatchConfig.revisionFilter = revisionFilter ?? extractRevisionFilter(
              nextWatchConfig,
              extractRevisionFilter(nextPrefConfig, 'ANY')
            );
            nextWatchConfig.ignoreLinkedWikidotSelfRevision = ignoreLinkedWikidotSelfRevision ?? extractIgnoreLinkedWikidotSelfRevision(
              nextWatchConfig,
              extractIgnoreLinkedWikidotSelfRevision(nextPrefConfig, DEFAULT_IGNORE_LINKED_WIKIDOT_SELF_REVISION)
            );

            await client.query(
              `
                UPDATE "PageMetricWatch"
                SET "config" = $2::jsonb,
                    "lastObserved" = NULL,
                    "updatedAt" = NOW()
                WHERE id = $1
              `,
              [watch.id, JSON.stringify(nextWatchConfig)]
            );
          }
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

        // 原子 upsert，理由同上。静音开关是最容易被连点的控件。
        await client.query(
          `
            INSERT INTO "UserMetricPreference" ("userId", "metric", "config", "createdAt", "updatedAt")
            VALUES ($1, $2::"PageMetricType", jsonb_build_object('muted', $3::boolean), NOW(), NOW())
            ON CONFLICT ("userId", "metric") DO UPDATE
            SET "config" = jsonb_set(COALESCE("UserMetricPreference"."config", '{}'::jsonb), '{muted}', to_jsonb($3::boolean), true),
                "updatedAt" = NOW()
          `,
          [userId, metric, muted]
        );

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
      await invalidateAlertsCache(authUser.linkedWikidotId);
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
      if (metric === null) {
        // 400 而非静默回落：拼错 metric 曾会把该用户所有评论提醒误标已读
        return res.status(400).json({ ok: false, error: 'invalid_metric' });
      }
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
      await invalidateAlertsCache(authUser.linkedWikidotId);
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

      const countResult = await readPool.query<{ count: number }>(
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

      const groupRows = await readPool.query<{ pageId: number; updatedAt: string }>(
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
      const details = await readPool.query<AlertsQueryRow>(
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
      await invalidateAlertsCache(authUser.linkedWikidotId);
      res.json({ ok: true, updated: updatedIds.length, ids: updatedIds });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
