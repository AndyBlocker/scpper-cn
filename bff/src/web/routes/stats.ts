import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';

export function statsRouter(pool: Pool, _redis: RedisClientType | null) {
	const router = Router();

	// GET /stats/site/latest
	router.get('/site/latest', async (_req, res, next) => {
		try {
			const sql = `
				SELECT date, "totalUsers", "activeUsers", "totalPages", "totalVotes",
				       "newUsersToday", "newPagesToday", "newVotesToday"
				FROM "SiteStats"
				ORDER BY date DESC
				LIMIT 1
			`;
			const { rows } = await pool.query(sql);
			if (rows.length === 0) return res.status(404).json({ error: 'not_found' });
			res.json(rows[0]);
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

	return router;
}

// Additional stats endpoints
export function extendStatsRouter(pool: Pool, _redis: RedisClientType | null) {
	const router = Router();

	// GET /stats/pages/:wikidotId (PageStats for current version)
	router.get('/pages/:wikidotId', async (req, res, next) => {
		try {
			const { wikidotId } = req.params as Record<string, string>;
			const sql = `
				WITH pv AS (
					SELECT id FROM "PageVersion"
					WHERE "wikidotId" = $1::int
					ORDER BY id DESC
					LIMIT 1
				)
				SELECT ps."uv", ps."dv", ps."wilson95", ps."controversy", ps."likeRatio"
				FROM "PageStats" ps
				JOIN pv ON ps."pageVersionId" = pv.id
			`;
			const { rows } = await pool.query(sql, [wikidotId]);
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
			const sql = `
				WITH p AS (
					SELECT pv."pageId" AS id
					FROM "PageVersion" pv
					WHERE pv."wikidotId" = $1::int
					ORDER BY pv.id DESC LIMIT 1
				)
				SELECT date, "votes_up" AS "votesUp", "votes_down" AS "votesDown", "total_votes" AS "totalVotes",
				       "unique_voters" AS "uniqueVoters", revisions
				FROM "PageDailyStats" pds
				JOIN p ON p.id = pds."pageId"
				WHERE ($2::date IS NULL OR pds.date >= $2::date)
				  AND ($3::date IS NULL OR pds.date <= $3::date)
				ORDER BY pds.date DESC
				LIMIT $4::int OFFSET $5::int
			`;
			const { rows } = await pool.query(sql, [wikidotId, startDate || null, endDate || null, limit, offset]);
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



