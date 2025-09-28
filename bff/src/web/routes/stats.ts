import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';

export function statsRouter(pool: Pool, _redis: RedisClientType | null) {
	const router = Router();

	// GET /stats/site/latest
	router.get('/site/latest', async (_req, res, next) => {
		try {
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
			const { rows } = await pool.query(sql);
			if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
			res.json(rows[0]);
		} catch (err) {
			next(err);
		}
	});

	// GET /stats/site/overview
	router.get('/site/overview', async (_req, res, next) => {
		try {
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
			const votesPositiveSql = `
				SELECT COUNT(*)::bigint AS count
				FROM "Vote" v
				JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
				WHERE v.direction > 0 AND pv."validTo" IS NULL AND pv."isDeleted" = false`;
			const votesNegativeSql = `
				SELECT COUNT(*)::bigint AS count
				FROM "Vote" v
				JOIN "PageVersion" pv ON v."pageVersionId" = pv.id
				WHERE v.direction < 0 AND pv."validTo" IS NULL AND pv."isDeleted" = false`;
			const revisionsTotalSql = `
				SELECT COUNT(*)::bigint AS count
				FROM "Revision" r
				JOIN "PageVersion" pv ON r."pageVersionId" = pv.id
				WHERE pv."validTo" IS NULL AND pv."isDeleted" = false`;

			const [siteRow, contributorsRow, authorsRow, originalsRow, translationsRow, votesPosRow, votesNegRow, revisionsRow] = await Promise.all([
				pool.query(siteSql).then(r => r.rows[0] || null),
				pool.query(contributorsSql).then(r => r.rows[0] || { count: 0 }),
				pool.query(authorsSql).then(r => r.rows[0] || { count: 0 }),
				pool.query(pageOriginalsSql).then(r => r.rows[0] || { count: 0 }),
				pool.query(pageTranslationsSql).then(r => r.rows[0] || { count: 0 }),
				pool.query(votesPositiveSql).then(r => r.rows[0] || { count: 0n }),
				pool.query(votesNegativeSql).then(r => r.rows[0] || { count: 0n }),
				pool.query(revisionsTotalSql).then(r => r.rows[0] || { count: 0n })
			]);

			if (!siteRow) return res.status(404).json({ error: 'not_found' });

			const upvotes = Number(votesPosRow.count || 0);
			const downvotes = Number(votesNegRow.count || 0);
			const totalVotes = upvotes + downvotes;

			return res.json({
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
					translations: Number(translationsRow.count || 0)
				},
				votes: { total: totalVotes, upvotes, downvotes },
				revisions: { total: Number(revisionsRow.count || 0) }
			});
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
			const mapped = rows.map((r: any) => ({
				date: r.date,
				users: { total: r.usersTotal, active: r.usersActive, contributors: r.usersContributors, authors: r.usersAuthors },
				pages: { total: r.pagesTotal, originals: r.pagesOriginals, translations: r.pagesTranslations },
				votes: { total: (r.votesUp || 0) + (r.votesDown || 0), upvotes: r.votesUp, downvotes: r.votesDown },
				revisions: { total: r.revisionsTotal }
			}));
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
			const sql = `
				SELECT date, "totalUsers", "activeUsers", "totalPages", "totalVotes",
				       "newUsersToday", "newPagesToday", "newVotesToday"
				FROM "SiteStats"
				WHERE date = $1::date
			`;
			const { rows } = await pool.query(sql, [date]);
			if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
			res.json(rows[0]);
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

			const { rows } = await pool.query(
				`SELECT ps."uv", ps."dv", ps."wilson95", ps."controversy", ps."likeRatio"
				   FROM "PageStats" ps
				  WHERE ps."pageVersionId" = $1`,
				[targetId]
			);
			if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
			res.json(rows[0]);
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
				       "unique_voters" AS "uniqueVoters", revisions
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
			const sql = `
				SELECT date, "votes_cast" AS "votesCast", "pages_created" AS "pagesCreated",
				       "last_activity" AS "lastActivity"
				FROM "UserDailyStats"
				WHERE "userId" = $1::int
				  AND ($2::date IS NULL OR date >= $2::date)
				  AND ($3::date IS NULL OR date <= $3::date)
				ORDER BY date DESC
				LIMIT $4::int OFFSET $5::int
			`;
			const { rows } = await pool.query(sql, [id, startDate || null, endDate || null, limit, offset]);
			res.json(rows);
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
			const sql = `
				SELECT id, "recordType", "userId", "userDisplayName", value, context, "achievedAt", "calculatedAt"
				FROM "UserActivityRecords"
				WHERE ($1::text IS NULL OR "recordType" = $1::text)
				  AND ($2::int IS NULL OR "userId" = $2::int)
				ORDER BY COALESCE("achievedAt", "calculatedAt") DESC
				LIMIT $3::int OFFSET $4::int
			`;
			const { rows } = await pool.query(sql, [recordType || null, userId || null, limit, offset]);
			res.json(rows);
		} catch (err) {
			next(err);
		}
	});

	return router;
}


