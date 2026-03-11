import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { createCache } from '../utils/cache.js';
import { getReadPoolSync } from '../utils/dbPool.js';

const FORUM_THREAD_BASE_URL = 'https://scp-wiki-cn.wikidot.com/forum/t-';
const PAGE_DISCUSSION_CATEGORY_ID = 675245;

function toPositiveInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function buildThreadSourceUrl(threadId: unknown): string | null {
  const id = toPositiveInt(threadId);
  return id ? `${FORUM_THREAD_BASE_URL}${id}/` : null;
}

function buildPostSourceUrl(threadId: unknown, postId: unknown): string | null {
  const sourceThreadUrl = buildThreadSourceUrl(threadId);
  const id = toPositiveInt(postId);
  if (!sourceThreadUrl || !id) return null;
  return `${sourceThreadUrl}#post-${id}`;
}

function withThreadSourceUrl<T extends Record<string, any>>(thread: T): T & { sourceThreadUrl: string | null } {
  return {
    ...thread,
    sourceThreadUrl: buildThreadSourceUrl(thread?.id),
  };
}

function withPostSourceUrl<T extends Record<string, any>>(post: T): T & { sourceThreadUrl: string | null; sourcePostUrl: string | null } {
  const sourceThreadUrl = buildThreadSourceUrl(post?.threadId);
  return {
    ...post,
    sourceThreadUrl,
    sourcePostUrl: sourceThreadUrl ? buildPostSourceUrl(post?.threadId, post?.id) : null,
  };
}

function extractSlugFromUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null;
  const input = rawUrl.trim();
  if (!input) return null;

  let pathname = input;
  try {
    pathname = new URL(input).pathname;
  } catch {
    // keep original when URL parser fails
  }

  const cleanPath = pathname.split('#')[0]?.split('?')[0] || '';
  const segments = cleanPath.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  const last = segments[segments.length - 1];
  if (!last) return null;
  try {
    const decoded = decodeURIComponent(last).trim().toLowerCase();
    return decoded || null;
  } catch {
    const normalized = last.trim().toLowerCase();
    return normalized || null;
  }
}

export function forumsRouter(pool: Pool, redis: RedisClientType | null) {
  const router = Router();
  const cache = createCache(redis);
  const readPool = getReadPoolSync(pool);

  // GET /forums/categories - 所有分类列表
  router.get('/categories', async (req, res, next) => {
    try {
      const result = await cache.remember('forums:categories', 300, async () => {
        const { rows } = await readPool.query(`
          SELECT id, title, description, "threadsCount", "postsCount",
                 "lastSyncedAt", "createdAt"
          FROM "ForumCategory"
          ORDER BY "postsCount" DESC
        `);
        return rows;
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /forums/categories/:id/threads - 分类下帖子列表（分页）
  router.get('/categories/:id/threads', async (req, res, next) => {
    try {
      const categoryId = Number(req.params.id);
      if (!Number.isInteger(categoryId) || categoryId <= 0) {
        return res.status(400).json({ error: 'invalid_category_id' });
      }

      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));
      const offset = (page - 1) * limit;

      const cacheKey = `forums:cat:${categoryId}:p${page}:l${limit}`;
      const result = await cache.remember(cacheKey, 120, async () => {
        const [threadsResult, countResult, categoryResult] = await Promise.all([
          readPool.query(`
            SELECT id, title, description, "createdByName", "createdByWikidotId",
                   "createdAt", "postCount", "pageId", "isDeleted"
            FROM "ForumThread"
            WHERE "categoryId" = $1 AND "isDeleted" = false
            ORDER BY "createdAt" DESC NULLS LAST
            LIMIT $2 OFFSET $3
          `, [categoryId, limit, offset]),
          readPool.query(`
            SELECT COUNT(*)::int AS total
            FROM "ForumThread"
            WHERE "categoryId" = $1 AND "isDeleted" = false
          `, [categoryId]),
          readPool.query(`
            SELECT id, title, description
            FROM "ForumCategory"
            WHERE id = $1
          `, [categoryId]),
        ]);

        if (categoryResult.rowCount === 0) {
          return null;
        }

        return {
          category: categoryResult.rows[0],
          threads: threadsResult.rows.map(withThreadSourceUrl),
          total: countResult.rows[0]?.total || 0,
          page,
          limit,
        };
      });

      if (!result) {
        return res.status(404).json({ error: 'category_not_found' });
      }

      return res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /forums/threads/:id - 帖子详情 + 所有回复
  router.get('/threads/:id', async (req, res, next) => {
    try {
      const threadId = Number(req.params.id);
      if (!Number.isInteger(threadId) || threadId <= 0) {
        return res.status(400).json({ error: 'invalid_thread_id' });
      }

      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const offset = (page - 1) * limit;
      const order = req.query.order === 'desc' ? 'DESC' : 'ASC';

      const cacheKey = `forums:thread:${threadId}:p${page}:l${limit}:o${order}`;
      const result = await cache.remember(cacheKey, 120, async () => {
        const [threadResult, postsResult, countResult] = await Promise.all([
          readPool.query(`
            SELECT t.id, t.title, t.description, t."createdByName",
                   t."createdByWikidotId", t."createdAt", t."postCount",
                   t."categoryId", t."pageId",
                   p."wikidotId" AS "pageWikidotId",
                   c.title AS "categoryTitle"
            FROM "ForumThread" t
            LEFT JOIN "ForumCategory" c ON c.id = t."categoryId"
            LEFT JOIN "Page" p ON p.id = t."pageId"
            WHERE t.id = $1 AND t."isDeleted" = false
          `, [threadId]),
          readPool.query(`
            SELECT id, "threadId", "parentId", title, "textHtml", "createdByName",
                   "createdByWikidotId", "createdByType", "createdAt",
                   "editedAt", "isDeleted"
            FROM "ForumPost"
            WHERE "threadId" = $1
            ORDER BY "createdAt" ${order} NULLS LAST, id ${order}
            LIMIT $2 OFFSET $3
          `, [threadId, limit, offset]),
          readPool.query(`
            SELECT COUNT(*)::int AS total
            FROM "ForumPost"
            WHERE "threadId" = $1
          `, [threadId]),
        ]);

        if (threadResult.rowCount === 0) {
          return null;
        }

        return {
          thread: withThreadSourceUrl(threadResult.rows[0]),
          posts: postsResult.rows.map(withPostSourceUrl),
          total: countResult.rows[0]?.total || 0,
          page,
          limit,
        };
      });

      if (!result) {
        return res.status(404).json({ error: 'thread_not_found' });
      }

      return res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /forums/pages/:wikidotId/discussion - 页面关联的讨论帖
  router.get('/pages/:wikidotId/discussion', async (req, res, next) => {
    try {
      const wikidotId = Number(req.params.wikidotId);
      if (!Number.isInteger(wikidotId) || wikidotId <= 0) {
        return res.status(400).json({ error: 'invalid_wikidot_id' });
      }

      const cacheKey = `forums:page-discussion:${wikidotId}`;
      const result = await cache.remember(cacheKey, 120, async () => {
        // Find the page's internal ID + URL slug for fallback matching
        const pageResult = await readPool.query(
          'SELECT id, "currentUrl", url FROM "Page" WHERE "wikidotId" = $1 LIMIT 1',
          [wikidotId]
        );

        if (pageResult.rowCount === 0) {
          return { threads: [] };
        }

        const pageRow = pageResult.rows[0] as { id: number; currentUrl: string | null; url: string | null };
        const pageId = Number(pageRow.id);
        const slugCandidates = Array.from(new Set([
          extractSlugFromUrl(pageRow.currentUrl),
          extractSlugFromUrl(pageRow.url),
        ].filter((v): v is string => Boolean(v))));

        const threadQuery = slugCandidates.length > 0
          ? readPool.query(`
            SELECT t.id, t.title, t."createdByName", t."createdByWikidotId", t."createdAt",
                   t."postCount", t."categoryId",
                   c.title AS "categoryTitle"
            FROM "ForumThread" t
            LEFT JOIN "ForumCategory" c ON c.id = t."categoryId"
            WHERE t."isDeleted" = false
              AND (
                t."pageId" = $1
                OR (
                  t."categoryId" = $2
                  AND LOWER(BTRIM(t.title)) = ANY($3::text[])
                )
              )
            ORDER BY t."createdAt" DESC NULLS LAST
          `, [pageId, PAGE_DISCUSSION_CATEGORY_ID, slugCandidates])
          : readPool.query(`
            SELECT t.id, t.title, t."createdByName", t."createdByWikidotId", t."createdAt",
                   t."postCount", t."categoryId",
                   c.title AS "categoryTitle"
            FROM "ForumThread" t
            LEFT JOIN "ForumCategory" c ON c.id = t."categoryId"
            WHERE t."pageId" = $1 AND t."isDeleted" = false
            ORDER BY t."createdAt" DESC NULLS LAST
          `, [pageId]);

        const { rows: threads } = await threadQuery;
        return { threads: threads.map(withThreadSourceUrl) };
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /forums/stats - 论坛全局统计
  router.get('/stats', async (req, res, next) => {
    try {
      const result = await cache.remember('forums:stats', 600, async () => {
        const [categoriesCount, threadsCount, postsCount, recentActivity] = await Promise.all([
          readPool.query('SELECT COUNT(*)::int AS count FROM "ForumCategory"'),
          readPool.query('SELECT COUNT(*)::int AS count FROM "ForumThread" WHERE "isDeleted" = false'),
          readPool.query('SELECT COUNT(*)::int AS count FROM "ForumPost" WHERE "isDeleted" = false'),
          readPool.query(`
            SELECT MAX("createdAt") AS "lastPostAt"
            FROM "ForumPost"
            WHERE "isDeleted" = false
          `),
        ]);

        // Top posters
        const { rows: topPosters } = await readPool.query(`
          SELECT "createdByName" AS name, "createdByWikidotId" AS "wikidotId",
                 COUNT(*)::int AS "postCount"
          FROM "ForumPost"
          WHERE "isDeleted" = false AND "createdByName" IS NOT NULL
          GROUP BY "createdByName", "createdByWikidotId"
          ORDER BY "postCount" DESC
          LIMIT 10
        `);

        return {
          categoriesCount: categoriesCount.rows[0]?.count || 0,
          threadsCount: threadsCount.rows[0]?.count || 0,
          postsCount: postsCount.rows[0]?.count || 0,
          lastPostAt: recentActivity.rows[0]?.lastPostAt || null,
          topPosters,
        };
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /forums/recent - 最新活跃帖子
  router.get('/recent', async (req, res, next) => {
    try {
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const cacheKey = `forums:recent:${limit}`;

      const result = await cache.remember(cacheKey, 120, async () => {
        const { rows } = await readPool.query(`
          SELECT t.id, t.title, t."createdByName", t."createdByWikidotId", t."createdAt",
                 t."postCount", t."categoryId",
                 c.title AS "categoryTitle"
          FROM "ForumThread" t
          LEFT JOIN "ForumCategory" c ON c.id = t."categoryId"
          WHERE t."isDeleted" = false
          ORDER BY t."createdAt" DESC NULLS LAST
          LIMIT $1
        `, [limit]);

        return rows.map(withThreadSourceUrl);
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /forums/recent-posts - 最新回帖（单条帖子级别，非主题级别）
  router.get('/recent-posts', async (req, res, next) => {
    try {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const offset = (page - 1) * limit;

      const cacheKey = `forums:recent-posts:p${page}:l${limit}`;
      const result = await cache.remember(cacheKey, 120, async () => {
        const [postsResult, countResult] = await Promise.all([
          readPool.query(`
            SELECT p.id, p.title, p."textHtml", p."createdByName",
                   p."createdByWikidotId", p."createdByType", p."createdAt",
                   p."threadId",
                   t.title AS "threadTitle", t."categoryId",
                   c.title AS "categoryTitle"
            FROM "ForumPost" p
            JOIN "ForumThread" t ON t.id = p."threadId"
            LEFT JOIN "ForumCategory" c ON c.id = t."categoryId"
            WHERE p."isDeleted" = false AND t."isDeleted" = false
            ORDER BY p."createdAt" DESC NULLS LAST
            LIMIT $1 OFFSET $2
          `, [limit, offset]),
          readPool.query(`
            SELECT COUNT(*)::int AS total
            FROM "ForumPost" p
            JOIN "ForumThread" t ON t.id = p."threadId"
            WHERE p."isDeleted" = false AND t."isDeleted" = false
          `),
        ]);

        return {
          posts: postsResult.rows.map(withPostSourceUrl),
          total: countResult.rows[0]?.total || 0,
          page,
          limit,
        };
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /forums/posts/:id/locate - 定位帖子在某排序/分页下的页码
  router.get('/posts/:id/locate', async (req, res, next) => {
    try {
      const postId = Number(req.params.id);
      if (!Number.isInteger(postId) || postId <= 0) {
        return res.status(400).json({ error: 'invalid_post_id' });
      }

      const order = req.query.order === 'asc' ? 'ASC' : 'DESC';
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));

      const cacheKey = `forums:locate:${postId}:o${order}:l${limit}`;
      const result = await cache.remember(cacheKey, 60, async () => {
        // Keep ranking and lookup in one SQL pipeline to avoid JS timestamp precision drift.
        const locationSql = `
          WITH target AS (
            SELECT id, "threadId"
            FROM "ForumPost"
            WHERE id = $1
          ),
          ranked AS (
            SELECT
              p.id,
              p."threadId",
              ROW_NUMBER() OVER (
                ORDER BY p."createdAt" ${order} NULLS LAST, p.id ${order}
              ) - 1 AS position
            FROM "ForumPost" p
            JOIN target t ON t."threadId" = p."threadId"
          )
          SELECT
            r."threadId" AS "threadId",
            r.id AS "postId",
            r.position AS position
          FROM ranked r
          JOIN target t ON t.id = r.id
          LIMIT 1
        `;

        const locationResult = await readPool.query(locationSql, [postId]);
        if (locationResult.rowCount === 0) {
          return null;
        }

        const row = locationResult.rows[0];
        const position = Number(row.position) || 0;
        const page = Math.floor(position / limit) + 1;

        return {
          threadId: Number(row.threadId),
          postId: Number(row.postId),
          page,
        };
      });

      if (!result) {
        return res.status(404).json({ error: 'post_not_found' });
      }

      return res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /forums/users/:wikidotId/posts - 用户论坛帖子列表（分页）
  router.get('/users/:wikidotId/posts', async (req, res, next) => {
    try {
      const wikidotId = Number(req.params.wikidotId);
      if (!Number.isInteger(wikidotId)) {
        return res.status(400).json({ error: 'invalid_wikidot_id' });
      }

      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 9));
      const offset = (page - 1) * limit;

      const cacheKey = `forums:user:${wikidotId}:posts:p${page}:l${limit}`;
      const result = await cache.remember(cacheKey, 120, async () => {
        const [postsResult, countResult] = await Promise.all([
          readPool.query(`
            SELECT p.id, p.title, p."textHtml", p."createdByName",
                   p."createdAt", p."threadId",
                   t.title AS "threadTitle", t."categoryId",
                   c.title AS "categoryTitle"
            FROM "ForumPost" p
            JOIN "ForumThread" t ON t.id = p."threadId"
            LEFT JOIN "ForumCategory" c ON c.id = t."categoryId"
            WHERE p."createdByWikidotId" = $1
              AND p."isDeleted" = false
              AND t."isDeleted" = false
            ORDER BY p."createdAt" DESC NULLS LAST
            LIMIT $2 OFFSET $3
          `, [wikidotId, limit, offset]),
          readPool.query(`
            SELECT COUNT(*)::int AS total
            FROM "ForumPost" p
            JOIN "ForumThread" t ON t.id = p."threadId"
            WHERE p."createdByWikidotId" = $1
              AND p."isDeleted" = false
              AND t."isDeleted" = false
          `, [wikidotId]),
        ]);

        return {
          posts: postsResult.rows.map(withPostSourceUrl),
          total: countResult.rows[0]?.total || 0,
          page,
          limit,
        };
      });

      return res.json(result);
    } catch (error) {
      next(error);
    }
  });

  // GET /forums/search - 搜索帖子
  router.get('/search', async (req, res, next) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q || q.length < 2) {
        return res.status(400).json({ error: 'query_too_short' });
      }

      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
      const offset = (page - 1) * limit;
      const searchPattern = `%${q}%`;

      const [postsResult, countResult] = await Promise.all([
        readPool.query(`
          SELECT p.id, p.title, p."textHtml", p."createdByName",
                 p."createdByWikidotId", p."createdAt", p."threadId",
                 t.title AS "threadTitle",
                 c.title AS "categoryTitle"
          FROM "ForumPost" p
          JOIN "ForumThread" t ON t.id = p."threadId"
          LEFT JOIN "ForumCategory" c ON c.id = t."categoryId"
          WHERE p."isDeleted" = false
            AND t."isDeleted" = false
            AND (p."textHtml" ILIKE $1 OR p.title ILIKE $1 OR t.title ILIKE $1)
          ORDER BY p."createdAt" DESC NULLS LAST
          LIMIT $2 OFFSET $3
        `, [searchPattern, limit, offset]),
        readPool.query(`
          SELECT COUNT(*)::int AS total
          FROM "ForumPost" p
          JOIN "ForumThread" t ON t.id = p."threadId"
          WHERE p."isDeleted" = false
            AND t."isDeleted" = false
            AND (p."textHtml" ILIKE $1 OR p.title ILIKE $1 OR t.title ILIKE $1)
        `, [searchPattern]),
      ]);

      return res.json({
        posts: postsResult.rows.map(withPostSourceUrl),
        total: countResult.rows[0]?.total || 0,
        page,
        limit,
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
