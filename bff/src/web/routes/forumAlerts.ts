import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { fetchAuthUser } from '../utils/auth.js';
import { getReadPoolSync } from '../utils/dbPool.js';

const FORUM_THREAD_BASE_URL = 'https://scp-wiki-cn.wikidot.com/forum/t-';

type ForumAlertType = 'PAGE_REPLY' | 'DIRECT_REPLY' | 'MENTION';

interface ForumAlertRow {
  id: number;
  type: ForumAlertType;
  detectedAt: string;
  acknowledgedAt: string | null;
  recipientUserId: number;
  actorUserId: number | null;
  actorWikidotId: number | null;
  actorName: string | null;
  postId: number;
  parentPostId: number | null;
  threadId: number;
  pageId: number | null;
  postTitle: string | null;
  postExcerpt: string | null;
  threadTitle: string | null;
  pageWikidotId: number | null;
  pageUrl: string | null;
  pageTitle: string | null;
  pageAlternateTitle: string | null;
}

function normalizeAlertType(input: unknown): ForumAlertType | null {
  if (typeof input !== 'string') return null;
  const value = input.trim().toUpperCase();
  if (value === 'PAGE_REPLY' || value === 'DIRECT_REPLY' || value === 'MENTION') {
    return value;
  }
  return null;
}

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

async function resolveRecipientId(readPool: Pool, wikidotId: number): Promise<number | null> {
  const result = await readPool.query<{ id: number }>(
    'SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1',
    [wikidotId]
  );
  return result.rows[0]?.id ?? null;
}

export function forumAlertsRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();
  const readPool = getReadPoolSync(pool);

  router.get('/', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      if (!auth || auth.linkedWikidotId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }

      const recipientUserId = await resolveRecipientId(readPool, auth.linkedWikidotId);
      if (recipientUserId == null) {
        return res.json({ ok: true, alerts: [], unreadCount: 0 });
      }

      const limit = Math.max(1, Math.min(Number.parseInt(String(req.query.limit ?? '20'), 10) || 20, 50));
      const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0);
      const alertType = normalizeAlertType(req.query.type);

      const alertsQuery = `
        SELECT
          a.id,
          a.type,
          a."detectedAt",
          a."acknowledgedAt",
          a."recipientUserId",
          a."actorUserId",
          a."actorWikidotId",
          a."actorName",
          a."postId",
          a."parentPostId",
          a."threadId",
          a."pageId",
          a."postTitle",
          a."postExcerpt",
          ft.title AS "threadTitle",
          p."wikidotId" AS "pageWikidotId",
          p."currentUrl" AS "pageUrl",
          pv.title AS "pageTitle",
          pv."alternateTitle" AS "pageAlternateTitle"
        FROM "ForumInteractionAlert" a
        JOIN "ForumThread" ft ON ft.id = a."threadId"
        LEFT JOIN "Page" p ON p.id = a."pageId"
        LEFT JOIN "PageVersion" pv ON pv."pageId" = a."pageId" AND pv."validTo" IS NULL
        WHERE a."recipientUserId" = $1
          AND ($2::text IS NULL OR a.type = CAST($2 AS "ForumInteractionAlertType"))
        ORDER BY a."detectedAt" DESC
        LIMIT $3 OFFSET $4
      `;

      const unreadQuery = `
        SELECT COUNT(*)::int AS count
        FROM "ForumInteractionAlert" a
        WHERE a."recipientUserId" = $1
          AND ($2::text IS NULL OR a.type = CAST($2 AS "ForumInteractionAlertType"))
          AND a."acknowledgedAt" IS NULL
      `;

      const [alertsResult, unreadResult] = await Promise.all([
        readPool.query<ForumAlertRow>(alertsQuery, [recipientUserId, alertType, limit, offset]),
        readPool.query<{ count: number }>(unreadQuery, [recipientUserId, alertType])
      ]);

      const alerts = alertsResult.rows.map((row) => ({
        id: row.id,
        type: row.type,
        detectedAt: row.detectedAt,
        acknowledgedAt: row.acknowledgedAt,
        recipientUserId: row.recipientUserId,
        actorUserId: row.actorUserId,
        actorWikidotId: row.actorWikidotId,
        actorName: row.actorName,
        postId: row.postId,
        parentPostId: row.parentPostId,
        threadId: row.threadId,
        pageId: row.pageId,
        postTitle: row.postTitle,
        postExcerpt: row.postExcerpt,
        threadTitle: row.threadTitle,
        pageWikidotId: row.pageWikidotId,
        pageUrl: row.pageUrl,
        pageTitle: row.pageTitle,
        pageAlternateTitle: row.pageAlternateTitle,
        sourceThreadUrl: buildThreadSourceUrl(row.threadId),
        sourcePostUrl: buildPostSourceUrl(row.threadId, row.postId)
      }));

      return res.json({
        ok: true,
        alerts,
        unreadCount: unreadResult.rows[0]?.count ?? 0
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/read-all', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      if (!auth || auth.linkedWikidotId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }

      const recipientUserId = await resolveRecipientId(pool, auth.linkedWikidotId);
      if (recipientUserId == null) {
        return res.status(404).json({ ok: false, error: 'user_not_found' });
      }

      const alertType = normalizeAlertType(req.body?.type);
      const result = await pool.query<{ id: number }>(
        `
          UPDATE "ForumInteractionAlert"
          SET "acknowledgedAt" = COALESCE("acknowledgedAt", NOW())
          WHERE "recipientUserId" = $1
            AND ($2::text IS NULL OR type = CAST($2 AS "ForumInteractionAlertType"))
            AND "acknowledgedAt" IS NULL
          RETURNING id
        `,
        [recipientUserId, alertType]
      );

      return res.json({ ok: true, updated: result.rowCount || 0 });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/read', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      if (!auth || auth.linkedWikidotId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }

      const recipientUserId = await resolveRecipientId(pool, auth.linkedWikidotId);
      if (recipientUserId == null) {
        return res.status(404).json({ ok: false, error: 'user_not_found' });
      }

      const alertId = Number.parseInt(String(req.params.id), 10);
      if (!Number.isFinite(alertId)) {
        return res.status(400).json({ ok: false, error: 'invalid_alert_id' });
      }

      const result = await pool.query<{ id: number; acknowledgedAt: string | null }>(
        `
          UPDATE "ForumInteractionAlert"
          SET "acknowledgedAt" = COALESCE("acknowledgedAt", NOW())
          WHERE id = $1
            AND "recipientUserId" = $2
          RETURNING id, "acknowledgedAt"
        `,
        [alertId, recipientUserId]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }

      return res.json({
        ok: true,
        id: alertId,
        acknowledgedAt: result.rows[0]?.acknowledgedAt ?? null
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
