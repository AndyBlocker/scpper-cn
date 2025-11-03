import { Router } from 'express';
import type { Pool, QueryResultRow } from 'pg';
import type { RedisClientType } from 'redis';
import { consola } from 'consola';
import { createCache } from '../utils/cache.js';

export function statsRouter(pool: Pool, redis: RedisClientType | null) {
	const router = Router();
	const cache = createCache(redis);
	const log = consola.withTag('stats');
	const slowQueryThresholdMs = Number.isFinite(Number(process.env.STATS_QUERY_SLOW_MS))
		? Number(process.env.STATS_QUERY_SLOW_MS)
		: 200;

	const timedQuery = async <T extends QueryResultRow = QueryResultRow>(
		label: string,
		sql: string,
		params: any[] | undefined,
		reqLabel: string
	) => {
		const start = process.hrtime.bigint();
		try {
			const result = await pool.query<T>(sql, params);
			const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
			if (durationMs >= slowQueryThresholdMs) {
				log.info(`[${reqLabel}] slow query ${label} ${durationMs.toFixed(1)}ms`);
			} else {
				log.debug(`[${reqLabel}] query ${label} ${durationMs.toFixed(1)}ms`);
			}
			return result;
		} catch (error) {
			const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
			log.error(`[${reqLabel}] query ${label} failed after ${durationMs.toFixed(1)}ms`, error);
			throw error;
		}
	};

	// GET /stats/site/latest
	router.get('/site/latest', async (_req, res, next) => {
		try {
			const data = await cache.remember('stats:site:latest', 180, async () => {
				const reqLabel = `site.latest:${Date.now().toString(36)}`;
				const sql = `
					SELECT 
						s.date, 
						s."totalUsers", 
						s."activeUsers", -- 约定为近60天活跃
						s."totalPages", 
						s."totalVotes",
						s."newUsersToday", 
						s."newPagesToday", 
						s."newVotesToday",
						-- 参考口径：近30/60/90天活跃用户（基于当前日期）
						(SELECT COUNT(*) FROM "User" u WHERE u."lastActivityAt" IS NOT NULL AND u."lastActivityAt" >= CURRENT_DATE - INTERVAL '30 days') AS "activeUsers30",
						(SELECT COUNT(*) FROM "User" u WHERE u."lastActivityAt" IS NOT NULL AND u."lastActivityAt" >= CURRENT_DATE - INTERVAL '60 days') AS "activeUsers60",
						(SELECT COUNT(*) FROM "User" u WHERE u."lastActivityAt" IS NOT NULL AND u."lastActivityAt" >= CURRENT_DATE - INTERVAL '90 days') AS "activeUsers90"
					FROM "SiteStats" s
					ORDER BY s.date DESC
					LIMIT 1
				`;
				const { rows } = await timedQuery('site.latest base', sql, undefined, reqLabel);
				return rows[0] ?? null;
			});
			if (!data) return res.status(404).json({ error: 'not_found' });
			res.json(data);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/site/overview
	router.get('/site/overview', async (req, res, next) => {
		try {
			const payload = await cache.remember('stats:site:overview', 300, async () => {
				const reqLabel = `site.overview:${Date.now().toString(36)}`;
				const requestStart = process.hrtime.bigint();
				// Always compute all-time totals for overview display (full period)
				const siteSql = `
					SELECT 
						date, 
						"updatedAt",
						"totalUsers", 
						"activeUsers", 
						"totalPages", 
						"totalVotes"
					FROM "SiteStats"
					ORDER BY date DESC
					LIMIT 1
				`;

				const contributorsSql = `
				  SELECT COUNT(DISTINCT u."userId")::int AS count FROM (
				    SELECT r."userId" FROM "Revision" r WHERE r."userId" IS NOT NULL
				    UNION
				    SELECT a."userId" FROM "Attribution" a WHERE a."userId" IS NOT NULL
				  ) u
				`;
				const authorsSql = `SELECT COUNT(DISTINCT a."userId")::int AS count FROM "Attribution" a JOIN "PageVersion" pv ON pv.id = a."pageVerId" WHERE a."userId" IS NOT NULL AND pv."validTo" IS NULL AND '原创' = ANY(pv.tags)`;
				const pageOriginalsSql = `SELECT COUNT(*)::int AS count FROM "PageVersion" pv WHERE pv."validTo" IS NULL AND pv."isDeleted" = false AND '原创' = ANY(pv.tags)`;
				const pageTranslationsSql = `SELECT COUNT(*)::int AS count FROM "PageVersion" pv WHERE pv."validTo" IS NULL AND pv."isDeleted" = false AND NOT ('原创' = ANY(pv.tags))`;
				const pageDeletedSql = `SELECT COUNT(*)::int AS count FROM "PageVersion" pv WHERE pv."validTo" IS NULL AND pv."isDeleted" = true`;
				const votesPositiveSql = `
					SELECT COALESCE(SUM(ps.uv), 0)::bigint AS count
					FROM "PageStats" ps
					JOIN "PageVersion" pv ON ps."pageVersionId" = pv.id
					WHERE pv."validTo" IS NULL AND pv."isDeleted" = false`;
				const votesNegativeSql = `
					SELECT COALESCE(SUM(ps.dv), 0)::bigint AS count
					FROM "PageStats" ps
					JOIN "PageVersion" pv ON ps."pageVersionId" = pv.id
					WHERE pv."validTo" IS NULL AND pv."isDeleted" = false`;
				const revisionsTotalSql = `
					SELECT COUNT(*)::bigint AS count
					FROM "Revision" r
					JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
					WHERE pv."validTo" IS NULL AND pv."isDeleted" = false`;

				const [siteRow, contributorsRow, authorsRow, originalsRow, translationsRow, deletedRow, votesPosRow, votesNegRow, revisionsRow] = await Promise.all([
					timedQuery('site-overview site', siteSql, undefined, reqLabel).then(r => r.rows[0] || null),
					timedQuery('site-overview contributors', contributorsSql, undefined, reqLabel).then(r => r.rows[0] || { count: 0 }),
					timedQuery('site-overview authors', authorsSql, undefined, reqLabel).then(r => r.rows[0] || { count: 0 }),
					timedQuery('site-overview page-originals', pageOriginalsSql, undefined, reqLabel).then(r => r.rows[0] || { count: 0 }),
					timedQuery('site-overview page-translations', pageTranslationsSql, undefined, reqLabel).then(r => r.rows[0] || { count: 0 }),
					timedQuery('site-overview page-deleted', pageDeletedSql, undefined, reqLabel).then(r => r.rows[0] || { count: 0 }),
					timedQuery('site-overview votes-positive', votesPositiveSql, undefined, reqLabel).then(r => r.rows[0] || { count: 0n }),
					timedQuery('site-overview votes-negative', votesNegativeSql, undefined, reqLabel).then(r => r.rows[0] || { count: 0n }),
					timedQuery('site-overview revisions-total', revisionsTotalSql, undefined, reqLabel).then(r => r.rows[0] || { count: 0n })
				]);

				if (!siteRow) return null;

				const upvotes = Number(votesPosRow.count || 0);
				const downvotes = Number(votesNegRow.count || 0);
				const totalVotes = upvotes + downvotes;

				const totalDurationMs = Number(process.hrtime.bigint() - requestStart) / 1e6;
				if (totalDurationMs >= slowQueryThresholdMs) {
					log.info(`[${reqLabel}] completed /stats/site/overview in ${totalDurationMs.toFixed(1)}ms`);
				}

				return {
					date: siteRow.date,
					updatedAt: siteRow.updatedAt,
					users: {
						total: siteRow.totalUsers || 0,
						active: siteRow.activeUsers || 0,
						contributors: Number(contributorsRow.count || 0),
						authors: Number(authorsRow.count || 0)
					},
					pages: {
						total: siteRow.totalPages || 0,
						originals: Number(originalsRow.count || 0),
						translations: Number(translationsRow.count || 0),
						deleted: Number(deletedRow.count || 0)
					},
					votes: { total: totalVotes, upvotes, downvotes },
					revisions: { total: Number(revisionsRow.count || 0) }
				};
			});

			if (!payload) return res.status(404).json({ error: 'not_found' });
			return res.json(payload);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/site/overview/series
	router.get('/site/overview/series', async (req, res, next) => {
		try {
			const { startDate, endDate, limit = '365', offset = '0' } = req.query as Record<string, string>;
			const defaultStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
			const effectiveStart = (startDate && startDate.trim()) ? startDate : defaultStart;
			const cacheKey = `stats:site:overview:series:${effectiveStart || 'auto'}:${endDate || 'null'}:${limit}:${offset}`;
			const mapped = await cache.remember(cacheKey, 300, async () => {
				const sql = `
					SELECT date,
					       "usersTotal", "usersActive", "usersContributors", "usersAuthors",
					       "pagesTotal", "pagesOriginals", "pagesTranslations",
					       "votesUp", "votesDown", "revisionsTotal"
					FROM "SiteOverviewDaily"
					WHERE ($1::date IS NULL OR date >= $1::date)
					  AND ($2::date IS NULL OR date <= $2::date)
					ORDER BY date ASC
					LIMIT $3::int OFFSET $4::int
				`;
				const params = [effectiveStart, endDate || null, limit, offset];
				const { rows } = await pool.query(sql, params);
				return rows.map((r: any) => ({
					date: r.date,
					users: { total: r.usersTotal, active: r.usersActive, contributors: r.usersContributors, authors: r.usersAuthors },
					pages: { total: r.pagesTotal, originals: r.pagesOriginals, translations: r.pagesTranslations },
					votes: { total: (r.votesUp || 0) + (r.votesDown || 0), upvotes: r.votesUp, downvotes: r.votesDown },
					revisions: { total: r.revisionsTotal }
				}));
			});
			res.json(mapped);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/site?date=YYYY-MM-DD
	router.get('/site', async (req, res, next) => {
		try {
			const { date } = req.query as Record<string, string>;
			if (!date) return res.status(400).json({ error: 'date is required' });
			const cacheKey = `stats:site:by-date:${date}`;
			const row = await cache.remember(cacheKey, 600, async () => {
				const sql = `
					SELECT date, "totalUsers", "activeUsers", "totalPages", "totalVotes",
					       "newUsersToday", "newPagesToday", "newVotesToday"
					FROM "SiteStats"
					WHERE date = $1::date
				`;
				const { rows } = await pool.query(sql, [date]);
				return rows[0] ?? null;
			});
			if (!row) return res.status(404).json({ error: 'not_found' });
			res.json(row);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/series
	router.get('/series', async (_req, res, next) => {
		try {
			const sql = `
				SELECT "seriesNumber", "isOpen", "totalSlots", "usedSlots",
				       "usagePercentage", "milestonePageId", "lastUpdated"
				FROM "SeriesStats"
				ORDER BY "seriesNumber" ASC
			`;
			const { rows } = await pool.query(sql);
			res.json(rows);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/series/availability
	// Combines SeriesStats with computed free numbers per series
	router.get('/series/availability', async (_req, res, next) => {
		try {
			// 1) Load series stats
			const seriesSql = `
				SELECT "seriesNumber", "isOpen", "totalSlots", "usedSlots",
				       "usagePercentage", "lastUpdated"
				FROM "SeriesStats"
				ORDER BY "seriesNumber" ASC
			`;
			const seriesRows = (await pool.query(seriesSql)).rows as Array<{
				seriesNumber: number;
				isOpen: boolean;
				totalSlots: number;
				usedSlots: number;
				usagePercentage: number;
				lastUpdated: string | Date;
			}>;

			// 2) Load all used SCP-CN numbers
			const usedSql = `
				SELECT p."currentUrl" AS url
				FROM "Page" p
				JOIN "PageVersion" pv ON p.id = pv."pageId"
				WHERE pv."validTo" IS NULL 
				  AND pv."isDeleted" = false
				  AND p."currentUrl" ~ '/scp-cn-[0-9]{3,4}($|/)'
				  AND p."currentUrl" NOT LIKE '%deleted:%'
				  AND '原创' = ANY(pv.tags)
				  AND NOT ('待删除' = ANY(pv.tags))
				  AND NOT ('待刪除' = ANY(pv.tags))
			`;
			const usedRows = (await pool.query(usedSql)).rows as Array<{ url: string }>;
			const used = new Set<number>();
			for (const r of usedRows) {
				const m = r.url.match(/\/scp-cn-(\d{3,4})(?:$|\/)/);
				if (m) {
					const n = parseInt(m[1], 10);
					if (!Number.isNaN(n) && n >= 1) used.add(n);
				}
			}

			// Helper to get numeric range for a series
			const seriesRange = (seriesNumber: number) => {
				if (seriesNumber === 1) return { start: 2, end: 999 };
				return { start: (seriesNumber - 1) * 1000, end: seriesNumber * 1000 - 1 };
			};

			// If no SeriesStats exist yet, synthesize a default list from 1..10
			const baseSeries = seriesRows.length > 0
				? seriesRows
				: Array.from({ length: 10 }, (_, i) => {
					const seriesNumber = i + 1;
					const { start, end } = seriesRange(seriesNumber);
					let usedSlots = 0;
					for (let n = start; n <= end; n++) if (used.has(n)) usedSlots++;
					const totalSlots = seriesNumber === 1 ? 998 : 1000;
					return {
						seriesNumber,
						isOpen: seriesNumber <= 6,
						totalSlots,
						usedSlots,
						usagePercentage: totalSlots > 0 ? (usedSlots / totalSlots) * 100 : 0,
						lastUpdated: new Date()
					};
				});

			// 3) Build payload with free numbers per series
			const payload = baseSeries.map((row) => {
				const { start, end } = seriesRange(row.seriesNumber);
				const freeNumbers: number[] = [];
				for (let n = start; n <= end; n++) {
					if (!used.has(n)) freeNumbers.push(n);
				}
				return {
					seriesNumber: row.seriesNumber,
					isOpen: row.isOpen,
					totalSlots: row.totalSlots,
					usedSlots: row.usedSlots,
					usagePercentage: row.usagePercentage,
					remainingSlots: Math.max(0, (row.totalSlots ?? 0) - (row.usedSlots ?? 0)),
					lastUpdated: row.lastUpdated,
					freeNumbers
				};
			});

			res.json(payload);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/site/series?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&limit=&offset=
	router.get('/site/series', async (req, res, next) => {
		try {
			const { startDate, endDate, limit = '365', offset = '0' } = req.query as Record<string, string>;
			// 默认近90天
			const defaultStart = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
			const effectiveStart = (startDate && startDate.trim()) ? startDate : defaultStart;
			const sql = `
				SELECT 
					date, 
					"totalUsers", 
					"activeUsers", -- 近60天活跃
					"totalPages", 
					"totalVotes",
					"newUsersToday", 
					"newPagesToday", 
					"newVotesToday"
				FROM "SiteStats"
				WHERE ($1::date IS NULL OR date >= $1::date)
				  AND ($2::date IS NULL OR date <= $2::date)
				ORDER BY date ASC
				LIMIT $3::int OFFSET $4::int
			`;
			const params = [effectiveStart, endDate || null, limit, offset];
			const { rows } = await pool.query(sql, params);
			res.json(rows);
		} catch (err) {
			next(err);
		}
	});

	return router;
}

// Additional stats endpoints
export function extendStatsRouter(pool: Pool, _redis: RedisClientType | null) {
	const router = Router();

  // GET /stats/category-benchmarks
  // Read precomputed payload from LeaderboardCache written by backend Analyze
  router.get('/category-benchmarks', async (_req, res, next) => {
    try {
      const sql = `
        SELECT payload, "updatedAt", "expiresAt"
        FROM "LeaderboardCache"
        WHERE key = $1::text AND period = $2::text
        LIMIT 1
      `;
      // Try v3 first, then v2, then v1
      let resRow: any | null = null;
      {
        const { rows } = await pool.query(sql, ['category_benchmarks_author_rating_v3', 'daily']);
        if (rows.length > 0) resRow = rows[0];
      }
      // Fallback to v2 if v3 absent
      if (!resRow) {
        const { rows } = await pool.query(sql, ['category_benchmarks_author_rating_v2', 'daily']);
        if (rows.length > 0) resRow = rows[0];
      }
      // Fallback to v1 if v2 absent
      if (!resRow) {
        const { rows } = await pool.query(sql, ['category_benchmarks_author_rating', 'daily']);
        if (rows.length > 0) resRow = rows[0];
      }
      if (!resRow) return res.status(404).json({ error: 'not_found' });
      res.json(resRow);
    } catch (err) {
      next(err);
    }
  });

	// GET /stats/pages/:wikidotId (PageStats for current version)
	router.get('/pages/:wikidotId', async (req, res, next) => {
		try {
			const { wikidotId } = req.params as Record<string, string>;
			const pageRes = await pool.query('SELECT id FROM "Page" WHERE "wikidotId" = $1::int LIMIT 1', [wikidotId]);
			if (pageRes.rows.length === 0) return res.status(404).json({ error: 'not_found' });
			const pageId = pageRes.rows[0].id;

			const currentRes = await pool.query(
				`SELECT id, "isDeleted"
				   FROM "PageVersion"
				  WHERE "pageId" = $1 AND "validTo" IS NULL
				  ORDER BY id DESC
				  LIMIT 1`,
				[pageId]
			);
			const current = currentRes.rows[0] ?? null;
			let targetId = current?.id ?? null;
			const currentDeleted = current?.isDeleted === true;
			if (!targetId || currentDeleted) {
				const fallbackRes = await pool.query(
					`SELECT id
					   FROM "PageVersion"
					  WHERE "pageId" = $1 AND "isDeleted" = false
					  ORDER BY "validFrom" DESC NULLS LAST, id DESC
					  LIMIT 1`,
					[pageId]
				);
				if (fallbackRes.rows.length > 0) {
					targetId = fallbackRes.rows[0].id;
				}
			}
			if (!targetId) return res.status(404).json({ error: 'not_found' });

				const { rows: statsRows } = await pool.query(
					`SELECT ps."uv", ps."dv", ps."wilson95", ps."controversy", ps."likeRatio"
					   FROM "PageStats" ps
					  WHERE ps."pageVersionId" = $1`,
					[targetId]
				);
				const statsRow = statsRows[0] ?? {
					uv: null,
					dv: null,
					wilson95: null,
					controversy: null,
					likeRatio: null
				};

				const aggregateRes = await pool.query(
					`SELECT
					       COALESCE(SUM(views), 0)::int AS "totalViews",
					       COALESCE(
						       SUM(
							       CASE
								       WHEN date = (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date
									       THEN views
								       ELSE 0
							       END
						       ),
						       0
					       )::int AS "todayViews"
					  FROM "PageDailyStats"
					  WHERE "pageId" = $1`,
					[pageId]
				);
					const aggregate = aggregateRes.rows[0] ?? { totalViews: 0, todayViews: 0 };
					res.json({ ...statsRow, ...aggregate, hasStats: Boolean(statsRows[0]) });
			} catch (err) {
				next(err);
			}
		});

	// GET /stats/pages/:wikidotId/daily
	router.get('/pages/:wikidotId/daily', async (req, res, next) => {
		try {
			const { wikidotId } = req.params as Record<string, string>;
			const { startDate, endDate, limit = '100', offset = '0' } = req.query as Record<string, string>;
			const pageRes = await pool.query('SELECT id FROM "Page" WHERE "wikidotId" = $1::int LIMIT 1', [wikidotId]);
			if (pageRes.rows.length === 0) return res.status(404).json({ error: 'not_found' });
			const pageId = pageRes.rows[0].id;
			const sql = `
				SELECT date, "votes_up" AS "votesUp", "votes_down" AS "votesDown", "total_votes" AS "totalVotes",
				       "unique_voters" AS "uniqueVoters", revisions, COALESCE(views, 0)::int AS "views"
				FROM "PageDailyStats" pds
				WHERE pds."pageId" = $1
				  AND ($2::date IS NULL OR pds.date >= $2::date)
				  AND ($3::date IS NULL OR pds.date <= $3::date)
				ORDER BY pds.date DESC
				LIMIT $4::int OFFSET $5::int
			`;
			const { rows } = await pool.query(sql, [pageId, startDate || null, endDate || null, limit, offset]);
			res.json(rows);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/users/:id/daily
	router.get('/users/:id/daily', async (req, res, next) => {
		try {
			const { id } = req.params as Record<string, string>;
			const { startDate, endDate, limit = '100', offset = '0' } = req.query as Record<string, string>;
			const limitInt = Math.max(0, Math.min(parseInt(limit, 10) || 100, 1000));
			const offsetInt = Math.max(0, parseInt(offset, 10) || 0);

			const votesSql = `
				SELECT date(v."timestamp") AS date,
				       COUNT(*)::int AS "votesCast",
				       MAX(v."timestamp") AS "lastVote"
				FROM "Vote" v
				WHERE v."userId" = $1::int
				  AND ($2::date IS NULL OR date(v."timestamp") >= $2::date)
				  AND ($3::date IS NULL OR date(v."timestamp") <= $3::date)
				GROUP BY date(v."timestamp")
			`;
			const revisionsSql = `
				WITH ranked_revisions AS (
					SELECT
						r."timestamp",
						r.type,
							ROW_NUMBER() OVER (
								PARTITION BY pv."pageId", COALESCE(r."wikidotId", r.id)
							ORDER BY r."timestamp" DESC, r.id DESC
						) AS row_num
					FROM "Revision" r
					JOIN "PageVersion" pv ON pv.id = r."pageVersionId"
					WHERE r."userId" = $1::int
					  AND ($2::date IS NULL OR date(r."timestamp") >= $2::date)
					  AND ($3::date IS NULL OR date(r."timestamp") <= $3::date)
				)
				SELECT
					date(ranked_revisions."timestamp") AS date,
					COUNT(*)::int AS "revisionCount",
					COUNT(*) FILTER (WHERE ranked_revisions.type = 'PAGE_CREATED')::int AS "pagesCreated",
					MAX(ranked_revisions."timestamp") AS "lastRevision"
				FROM ranked_revisions
				WHERE ranked_revisions.row_num = 1
				GROUP BY date(ranked_revisions."timestamp")
			`;

			const [votesRes, revisionsRes] = await Promise.all([
				pool.query(votesSql, [id, startDate || null, endDate || null]),
				pool.query(revisionsSql, [id, startDate || null, endDate || null])
			]);

			const merged = new Map<string, {
				date: string;
				votesCast: number;
				pagesCreated: number;
				revisions: number;
				lastActivity: Date | null;
			}>();

			for (const row of votesRes.rows) {
				const key = formatDateKey(row.date);
				if (!key) continue;
				const existing = merged.get(key) ?? {
					date: key,
					votesCast: 0,
					pagesCreated: 0,
					revisions: 0,
					lastActivity: null
				};
				existing.votesCast = Number(row.votesCast || 0);
				const lastVote = toDate(row.lastVote);
				if (lastVote && (!existing.lastActivity || lastVote > existing.lastActivity)) {
					existing.lastActivity = lastVote;
				}
				merged.set(key, existing);
			}

			for (const row of revisionsRes.rows) {
				const key = formatDateKey(row.date);
				if (!key) continue;
				const existing = merged.get(key) ?? {
					date: key,
					votesCast: 0,
					pagesCreated: 0,
					revisions: 0,
					lastActivity: null
				};
				existing.pagesCreated = Number(row.pagesCreated || 0);
				existing.revisions = Number(row.revisionCount || 0);
				const lastRevision = toDate(row.lastRevision);
				if (lastRevision && (!existing.lastActivity || lastRevision > existing.lastActivity)) {
					existing.lastActivity = lastRevision;
				}
				merged.set(key, existing);
			}

			const sorted = Array.from(merged.values()).sort((a, b) => (a.date < b.date ? 1 : -1));
			const sliced = sorted.slice(offsetInt, offsetInt + limitInt).map((row) => ({
				...row,
				lastActivity: row.lastActivity ? row.lastActivity.toISOString() : null
			}));

			res.json(sliced);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/trending?statType=&period=&limit=&offset=
	router.get('/trending', async (req, res, next) => {
		try {
			const { statType, period, limit = '20', offset = '0' } = req.query as Record<string, string>;
			const sql = `
				SELECT "statType", name, "entityId", "entityType", score, period, metadata, "calculatedAt"
				FROM "TrendingStats"
				WHERE ($1::text IS NULL OR "statType" = $1::text)
				  AND ($2::text IS NULL OR period = $2::text)
				ORDER BY score DESC
				LIMIT $3::int OFFSET $4::int
			`;
			const { rows } = await pool.query(sql, [statType || null, period || null, limit, offset]);
			res.json(rows);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/leaderboard?key=&period=
	router.get('/leaderboard', async (req, res, next) => {
		try {
			const { key, period } = req.query as Record<string, string>;
			if (!key || !period) return res.status(400).json({ error: 'key and period are required' });
			const sql = `
				SELECT payload, "updatedAt", "expiresAt"
				FROM "LeaderboardCache"
				WHERE key = $1::text AND period = $2::text
				LIMIT 1
			`;
			const { rows } = await pool.query(sql, [key, period]);
			if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
			res.json(rows[0]);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/interesting-facts?category=&type=&pageId=&userId=&date=&tag=
	router.get('/interesting-facts', async (req, res, next) => {
		try {
			const { category, type, pageId, userId, date, tag, limit = '50', offset = '0' } = req.query as Record<string, string>;
			const sql = `
				SELECT id, category, type, title, description, value, metadata, "pageId", "userId", "dateContext" AS date, "tagContext" AS tag, rank, "calculatedAt", "isActive"
				FROM "InterestingFacts"
				WHERE ($1::text IS NULL OR category = $1::text)
				  AND ($2::text IS NULL OR type = $2::text)
				  AND ($3::int IS NULL OR "pageId" = $3::int)
				  AND ($4::int IS NULL OR "userId" = $4::int)
				  AND ($5::date IS NULL OR "dateContext" = $5::date)
				  AND ($6::text IS NULL OR "tagContext" = $6::text)
				ORDER BY rank ASC, "calculatedAt" DESC
				LIMIT $7::int OFFSET $8::int
			`;
			const { rows } = await pool.query(sql, [category || null, type || null, pageId || null, userId || null, date || null, tag || null, limit, offset]);
			res.json(rows);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/milestones?period=&periodValue=&milestoneType=&pageId=
	router.get('/milestones', async (req, res, next) => {
		try {
			const { period, periodValue, milestoneType, pageId, limit = '50', offset = '0' } = req.query as Record<string, string>;
			const sql = `
				SELECT id, period, "periodValue", "milestoneType", "pageId", "pageTitle", "pageRating", "pageCreatedAt", "calculatedAt"
				FROM "TimeMilestones"
				WHERE ($1::text IS NULL OR period = $1::text)
				  AND ($2::text IS NULL OR "periodValue" = $2::text)
				  AND ($3::text IS NULL OR "milestoneType" = $3::text)
				  AND ($4::int IS NULL OR "pageId" = $4::int)
				ORDER BY "calculatedAt" DESC
				LIMIT $5::int OFFSET $6::int
			`;
			const { rows } = await pool.query(sql, [period || null, periodValue || null, milestoneType || null, pageId || null, limit, offset]);
			res.json(rows);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/tag-records?tag=&recordType=&pageId=&userId=
	router.get('/tag-records', async (req, res, next) => {
		try {
			const { tag, recordType, pageId, userId, limit = '100', offset = '0' } = req.query as Record<string, string>;
			const sql = `
				SELECT id, tag, "recordType", "pageId", "userId", value, metadata, "calculatedAt"
				FROM "TagRecords"
				WHERE ($1::text IS NULL OR tag = $1::text)
				  AND ($2::text IS NULL OR "recordType" = $2::text)
				  AND ($3::int IS NULL OR "pageId" = $3::int)
				  AND ($4::int IS NULL OR "userId" = $4::int)
				ORDER BY "calculatedAt" DESC
				LIMIT $5::int OFFSET $6::int
			`;
			const { rows } = await pool.query(sql, [tag || null, recordType || null, pageId || null, userId || null, limit, offset]);
			res.json(rows);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/content-records?recordType=&pageId=
	router.get('/content-records', async (req, res, next) => {
		try {
			const { recordType, pageId, limit = '100', offset = '0' } = req.query as Record<string, string>;
			const sql = `
				SELECT id, "recordType", "pageId", "pageTitle", "sourceLength", "contentLength", complexity, "calculatedAt"
				FROM "ContentRecords"
				WHERE ($1::text IS NULL OR "recordType" = $1::text)
				  AND ($2::int IS NULL OR "pageId" = $2::int)
				ORDER BY "calculatedAt" DESC
				LIMIT $3::int OFFSET $4::int
			`;
			const { rows } = await pool.query(sql, [recordType || null, pageId || null, limit, offset]);
			res.json(rows);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/rating-records?recordType=&timeframe=&pageId=
	router.get('/rating-records', async (req, res, next) => {
		try {
			const { recordType, timeframe, pageId, limit = '100', offset = '0' } = req.query as Record<string, string>;
			const sql = `
				SELECT id, "recordType", timeframe, "pageId", "pageTitle", rating, "voteCount", controversy, wilson95, value, "achievedAt", "calculatedAt"
				FROM "RatingRecords"
				WHERE ($1::text IS NULL OR "recordType" = $1::text)
				  AND ($2::text IS NULL OR timeframe = $2::text)
				  AND ($3::int IS NULL OR "pageId" = $3::int)
				ORDER BY COALESCE("achievedAt", "calculatedAt") DESC
				LIMIT $4::int OFFSET $5::int
			`;
			const { rows } = await pool.query(sql, [recordType || null, timeframe || null, pageId || null, limit, offset]);
			res.json(rows);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/user-activity?recordType=&userId=
	router.get('/user-activity', async (req, res, next) => {
		try {
			const { recordType, userId, limit = '100', offset = '0' } = req.query as Record<string, string>;
			const limitInt = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
			const offsetInt = Math.max(0, parseInt(offset, 10) || 0);
			const baseParams = [recordType || null, userId || null];
			const listSql = `
				SELECT id, "recordType", "userId", "userDisplayName", value, context, "achievedAt", "calculatedAt"
				FROM "UserActivityRecords"
				WHERE ($1::text IS NULL OR "recordType" = $1::text)
				  AND ($2::int IS NULL OR "userId" = $2::int)
				ORDER BY COALESCE("achievedAt", "calculatedAt") DESC
				LIMIT $3::int OFFSET $4::int
			`;
			const countSql = `
				SELECT COUNT(*)::int AS total
				FROM "UserActivityRecords"
				WHERE ($1::text IS NULL OR "recordType" = $1::text)
				  AND ($2::int IS NULL OR "userId" = $2::int)
			`;
			const [listRes, countRes] = await Promise.all([
				pool.query(listSql, [...baseParams, limitInt, offsetInt]),
				pool.query(countSql, baseParams)
			]);
			const total = Number(countRes.rows?.[0]?.total || 0);
			res.json({
				items: listRes.rows,
				total,
				limit: limitInt,
				offset: offsetInt
			});
		} catch (err) {
			next(err);
		}
	});

	return router;
}

function formatDateKey(input: unknown): string {
	if (!input) return '';
	if (typeof input === 'string') {
		return input.length >= 10 ? input.slice(0, 10) : input;
	}
	if (input instanceof Date) {
		const date = new Date(input.getTime());
		date.setUTCHours(0, 0, 0, 0);
		return date.toISOString().slice(0, 10);
	}
	return String(input);
}

function toDate(value: unknown): Date | null {
	if (!value) return null;
	if (value instanceof Date) {
		return Number.isNaN(value.getTime()) ? null : value;
	}
	const parsed = new Date(value as string);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}
