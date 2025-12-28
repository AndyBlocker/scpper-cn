import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { getReadPoolSync } from '../utils/dbPool.js';

export function aggregateRouter(pool: Pool, _redis: RedisClientType | null) {
	const router = Router();

	// 读写分离：aggregate 全部是读操作，使用从库
	const readPool = getReadPoolSync();

	// GET /aggregate/pages
	router.get('/pages', async (req, res, next) => {
		try {
			const {
				urlStartsWith,
				titleEqLower,
				categoryEq,
				tagEq,
				ratingGte,
				ratingLte,
				createdAtGte,
				createdAtLte
			} = req.query as Record<string, string>;

			const sql = `
				SELECT COUNT(*)::int AS _count
				FROM "PageVersion" pv
				JOIN "Page" p ON pv."pageId" = p.id
				WHERE pv."validTo" IS NULL
				  AND ($1::text IS NULL OR p."currentUrl" LIKE ($1::text || '%'))
				  AND ($2::text IS NULL OR lower(pv.title) = $2::text)
				  AND ($3::text IS NULL OR pv.category = $3::text)
				  AND ($4::text IS NULL OR pv.tags @> ARRAY[$4::text]::text[])
				  AND ($5::int IS NULL OR pv.rating >= $5::int)
				  AND ($6::int IS NULL OR pv.rating <= $6::int)
				  AND ($7::timestamptz IS NULL OR pv."createdAt" >= $7::timestamptz)
				  AND ($8::timestamptz IS NULL OR pv."createdAt" <= $8::timestamptz)
			`;

			const params = [
				urlStartsWith || null,
				titleEqLower || null,
				categoryEq || null,
				tagEq || null,
				ratingGte || null,
				ratingLte || null,
				createdAtGte || null,
				createdAtLte || null
			];

			const { rows } = await readPool.query(sql, params);
			const count = rows[0]?._count ?? 0;
			res.json({ _count: Number(count) });
		} catch (err) {
			next(err);
		}
	});

	return router;
}



