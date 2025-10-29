import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { fetchAuthUser, ensureUserByWikidotId, type AuthUserPayload } from '../utils/auth.js';

const TITLE_MIN_LEN = 1;
const TITLE_MAX_LEN = 80;
const DESCRIPTION_MAX_LEN = 800;
const NOTES_MAX_LEN = 1200;
const ANNOTATION_MAX_LEN = 1200;
const MAX_COLLECTIONS_PER_USER = 20;
const MAX_ITEMS_PER_COLLECTION = 200;
const COVER_OFFSET_MIN = -60;
const COVER_OFFSET_MAX = 60;
const COVER_SCALE_MIN = 0.75;
const COVER_SCALE_MAX = 2.5;
let coverTransformColumnsAvailable: boolean | null = null;

type Visibility = 'PUBLIC' | 'PRIVATE';

const VISIBILITY_VALUES: Visibility[] = ['PUBLIC', 'PRIVATE'];

function normalizeString(input: unknown): string {
  if (typeof input === 'string') {
    return input.trim();
  }
  return '';
}

function sanitizeTitle(value: unknown): string | null {
  const title = normalizeString(value);
  if (title.length < TITLE_MIN_LEN || title.length > TITLE_MAX_LEN) {
    return null;
  }
  return title;
}

function sanitizeOptionalText(value: unknown, maxLength: number): string | null {
  const text = normalizeString(value);
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sanitizeVisibility(value: unknown): Visibility | null {
  if (typeof value !== 'string') return null;
  const upper = value.toUpperCase();
  return VISIBILITY_VALUES.includes(upper as Visibility) ? (upper as Visibility) : null;
}

function sanitizeCoverOffset(value: unknown, fallback = 0): number {
  if (value === undefined) return fallback;
  if (value === null || value === '') return 0;
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = Math.min(COVER_OFFSET_MAX, Math.max(COVER_OFFSET_MIN, parsed));
  return Number.isNaN(clamped) ? fallback : clamped;
}

function sanitizeCoverScale(value: unknown, fallback = 1): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'string' ? Number.parseFloat(value) : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = Math.min(COVER_SCALE_MAX, Math.max(COVER_SCALE_MIN, parsed));
  return Number.isNaN(clamped) ? fallback : clamped;
}

async function ensureCoverTransformColumns(pool: Pool): Promise<boolean> {
  if (coverTransformColumnsAvailable != null) return coverTransformColumnsAvailable;
  try {
    const { rows } = await pool.query<{ column_name: string }>(
      `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'UserCollection'
          AND column_name IN ('coverImageOffsetX', 'coverImageOffsetY', 'coverImageScale')
      `
    );
    const existing = rows.reduce<Record<string, true>>((acc, row) => {
      acc[row.column_name] = true;
      return acc;
    }, {});
    coverTransformColumnsAvailable = Boolean(
      existing.coverImageOffsetX && existing.coverImageOffsetY && existing.coverImageScale
    );
  } catch (error) {
    console.warn('[collections] failed to inspect cover transform columns', error);
    coverTransformColumnsAvailable = false;
  }
  return coverTransformColumnsAvailable;
}

const slugify = (input: string): string => input
  .toLowerCase()
  .trim()
  .replace(/[^a-z0-9\s-]/g, '')
  .replace(/\s+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '');

async function ensureUniqueSlug(pool: Pool, ownerId: number, baseSlug: string, excludeId?: number | null): Promise<string> {
  let attempt = 0;
  let candidate = baseSlug || `collection-${Date.now().toString(36)}`;
  while (true) {
    const { rows } = await pool.query<{ id: number }>(
      `
        SELECT id
        FROM "UserCollection"
        WHERE "ownerId" = $1 AND slug = $2
        ${excludeId ? 'AND id <> $3' : ''}
        LIMIT 1
      `,
      excludeId ? [ownerId, candidate, excludeId] : [ownerId, candidate]
    );
    if (rows.length === 0) return candidate;
    attempt += 1;
    candidate = `${baseSlug}-${attempt}`;
  }
}

async function countCollections(pool: Pool, ownerId: number): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM "UserCollection" WHERE "ownerId" = $1',
    [ownerId]
  );
  return Number(rows[0]?.count ?? 0);
}

async function countItems(pool: Pool, collectionId: number): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM "UserCollectionItem" WHERE "collectionId" = $1',
    [collectionId]
  );
  return Number(rows[0]?.count ?? 0);
}

async function ensureAccountOwner(pool: Pool, auth: AuthUserPayload): Promise<number | null> {
  const accountId = String(auth.id || '').trim();
  if (!accountId) return null;

  const existing = await pool.query<{ userId: number }>(
    'SELECT "userId" FROM "CollectionAccountOwner" WHERE "accountId" = $1 LIMIT 1',
    [accountId]
  );
  if (existing.rows.length > 0) {
    return Number(existing.rows[0].userId);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const check = await client.query<{ userId: number }>(
      'SELECT "userId" FROM "CollectionAccountOwner" WHERE "accountId" = $1 LIMIT 1',
      [accountId]
    );
    if (check.rows.length > 0) {
      await client.query('COMMIT');
      return Number(check.rows[0].userId);
    }

    const displayName = (auth.displayName && auth.displayName.trim().slice(0, 80))
      || (auth.email && auth.email.trim().slice(0, 80))
      || `账号用户 ${accountId.slice(0, 6)}`;
    const insertedUser = await client.query<{ id: number }>(
      `
        INSERT INTO "User" ("displayName", "isGuest")
        VALUES ($1, TRUE)
        RETURNING id
      `,
      [displayName]
    );
    const userId = Number(insertedUser.rows[0].id);
    await client.query(
      `
        INSERT INTO "CollectionAccountOwner" ("accountId", "userId")
        VALUES ($1, $2)
      `,
      [accountId, userId]
    );
    await client.query('COMMIT');
    return userId;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    if ((error as any)?.code === '23505') {
      const retry = await pool.query<{ userId: number }>(
        'SELECT "userId" FROM "CollectionAccountOwner" WHERE "accountId" = $1 LIMIT 1',
        [accountId]
      );
      if (retry.rows.length > 0) {
        return Number(retry.rows[0].userId);
      }
    }
    throw error;
  } finally {
    client.release();
  }
}

async function resolveOwnerId(pool: Pool, auth: AuthUserPayload | null): Promise<number | null> {
  if (!auth) return null;
  if (auth.linkedWikidotId != null) {
    const wikidotOwner = await ensureUserByWikidotId(pool, auth.linkedWikidotId);
    if (wikidotOwner != null) {
      return wikidotOwner;
    }
  }
  return ensureAccountOwner(pool, auth);
}

async function findUserIdByWikidotId(pool: Pool, wikidotId: number): Promise<number | null> {
  if (!Number.isFinite(wikidotId) || wikidotId <= 0) return null;
  const { rows } = await pool.query<{ id: number }>(
    'SELECT id FROM "User" WHERE "wikidotId" = $1 LIMIT 1',
    [wikidotId]
  );
  return rows[0]?.id ?? null;
}

function mapCollectionRow(row: any) {
  return {
    id: Number(row.id),
    ownerId: Number(row.ownerId),
    title: row.title,
    slug: row.slug,
    visibility: row.visibility,
    description: row.description ?? null,
    notes: row.notes ?? null,
    coverImageUrl: row.coverImageUrl ?? null,
    coverImageOffsetX: row.coverImageOffsetX != null ? Number(row.coverImageOffsetX) : 0,
    coverImageOffsetY: row.coverImageOffsetY != null ? Number(row.coverImageOffsetY) : 0,
    coverImageScale: row.coverImageScale != null ? Number(row.coverImageScale) : 1,
    isDefault: Boolean(row.isDefault),
    publishedAt: row.publishedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    itemCount: Number(row.itemCount ?? 0)
  };
}

function mapItemRow(row: any) {
  return {
    id: Number(row.id),
    collectionId: Number(row.collectionId),
    pageId: Number(row.pageId),
    annotation: row.annotation ?? null,
    order: Number(row.order ?? 0),
    pinned: Boolean(row.pinned),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    page: {
      id: Number(row.pageId),
      wikidotId: row.pageWikidotId != null ? Number(row.pageWikidotId) : null,
      currentUrl: row.pageCurrentUrl ?? null,
      slug: row.pageSlug ?? null,
      title: row.pageTitle ?? null,
      alternateTitle: row.pageAlternateTitle ?? null,
      rating: row.pageRating != null ? Number(row.pageRating) : null
    }
  };
}

async function fetchCollectionById(pool: Pool, id: number) {
  const { rows } = await pool.query<any>(
    `
      SELECT c.*, (
        SELECT COUNT(*)::int FROM "UserCollectionItem" WHERE "collectionId" = c.id
      ) AS "itemCount"
      FROM "UserCollection" c
      WHERE c.id = $1
      LIMIT 1
    `,
    [id]
  );
  return rows[0] ?? null;
}

async function fetchCollectionItems(pool: Pool, collectionId: number) {
  const { rows } = await pool.query<any>(
    `
      SELECT
        i.id,
        i."collectionId",
        i."pageId",
        i.annotation,
        i."order",
        i.pinned,
        i."createdAt",
        i."updatedAt",
        p."wikidotId" AS "pageWikidotId",
        p."currentUrl" AS "pageCurrentUrl",
        p.url AS "pageSlug",
        pv.title AS "pageTitle",
        pv."alternateTitle" AS "pageAlternateTitle",
        pv.rating AS "pageRating"
      FROM "UserCollectionItem" i
      JOIN "Page" p ON p.id = i."pageId"
      LEFT JOIN "PageVersion" pv ON pv."pageId" = p.id AND pv."validTo" IS NULL
      WHERE i."collectionId" = $1
        AND (p."isDeleted" IS NULL OR p."isDeleted" = false)
      ORDER BY i.pinned DESC, i."order" ASC, i."createdAt" DESC
    `,
    [collectionId]
  );
  return rows;
}

async function resolvePageId(pool: Pool, payload: any): Promise<number | null> {
  if (payload == null) return null;
  if (payload.pageId != null && Number.isFinite(Number(payload.pageId))) {
    const numeric = Number(payload.pageId);
    const { rows } = await pool.query<{ id: number }>(
      'SELECT id FROM "Page" WHERE id = $1 AND ("isDeleted" IS NULL OR "isDeleted" = false) LIMIT 1',
      [numeric]
    );
    return rows[0]?.id ?? null;
  }
  if (payload.pageWikidotId != null && Number.isFinite(Number(payload.pageWikidotId))) {
    const wikidotId = Number(payload.pageWikidotId);
    const { rows } = await pool.query<{ id: number }>(
      'SELECT id FROM "Page" WHERE "wikidotId" = $1 AND ("isDeleted" IS NULL OR "isDeleted" = false) LIMIT 1',
      [wikidotId]
    );
    return rows[0]?.id ?? null;
  }
  return null;
}

export function collectionsRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      const ownerId = await resolveOwnerId(pool, auth);
      if (!auth || ownerId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const limitParam = Number.parseInt(String(req.query.limit ?? '20'), 10);
      const offsetParam = Number.parseInt(String(req.query.offset ?? '0'), 10);
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 20;
      const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;

      const [list, totalRows] = await Promise.all([
        pool.query<any>(
          `
            SELECT
              c.*,
              COALESCE(items.count, 0)::int AS "itemCount"
            FROM "UserCollection" c
            LEFT JOIN LATERAL (
              SELECT COUNT(*) AS count FROM "UserCollectionItem" WHERE "collectionId" = c.id
            ) items ON TRUE
            WHERE c."ownerId" = $1
            ORDER BY c."isDefault" DESC, c."updatedAt" DESC
            LIMIT $2 OFFSET $3
          `,
          [ownerId, limit, offset]
        ),
        pool.query<{ total: string }>(
          'SELECT COUNT(*)::text AS total FROM "UserCollection" WHERE "ownerId" = $1',
          [ownerId]
        )
      ]);

      const total = Number(totalRows.rows[0]?.total ?? 0);
      res.json({
        ok: true,
        total,
        items: list.rows.map(mapCollectionRow)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/public/user/:wikidotId', async (req, res, next) => {
    try {
      const wikidotId = Number.parseInt(String(req.params.wikidotId ?? ''), 10);
      if (!Number.isFinite(wikidotId) || wikidotId <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_wikidot' });
      }
      const ownerId = await findUserIdByWikidotId(pool, wikidotId);
      if (!ownerId) {
        return res.json({ ok: true, total: 0, items: [] });
      }
      const { rows } = await pool.query<any>(
        `
          SELECT
            c.*,
            COALESCE(items.count, 0)::int AS "itemCount"
          FROM "UserCollection" c
          LEFT JOIN LATERAL (
            SELECT COUNT(*) AS count FROM "UserCollectionItem" WHERE "collectionId" = c.id
          ) items ON TRUE
          WHERE c."ownerId" = $1 AND c.visibility = 'PUBLIC'
          ORDER BY c."publishedAt" DESC NULLS LAST, c."updatedAt" DESC
        `,
        [ownerId]
      );
      res.json({
        ok: true,
        total: rows.length,
        items: rows.map(mapCollectionRow)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/public/user/:wikidotId/:slug', async (req, res, next) => {
    try {
      const wikidotId = Number.parseInt(String(req.params.wikidotId ?? ''), 10);
      const slug = normalizeString(req.params.slug);
      if (!Number.isFinite(wikidotId) || wikidotId <= 0 || !slug) {
        return res.status(400).json({ ok: false, error: 'invalid_params' });
      }
      const ownerId = await findUserIdByWikidotId(pool, wikidotId);
      if (!ownerId) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      const { rows } = await pool.query<any>(
        `
          SELECT c.*, (
            SELECT COUNT(*)::int FROM "UserCollectionItem" WHERE "collectionId" = c.id
          ) AS "itemCount"
          FROM "UserCollection" c
          WHERE c."ownerId" = $1
            AND c.slug = $2
            AND c.visibility = 'PUBLIC'
          LIMIT 1
        `,
        [ownerId, slug]
      );
      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      const collection = rows[0];
      const items = await fetchCollectionItems(pool, collection.id);
      res.json({
        ok: true,
        collection: mapCollectionRow(collection),
        items: items.map(mapItemRow)
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      const id = Number.parseInt(String(req.params.id ?? ''), 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_id' });
      }
      const auth = await fetchAuthUser(req);
      const ownerId = await resolveOwnerId(pool, auth);
      if (!auth || ownerId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const record = await fetchCollectionById(pool, id);
      if (!record || Number(record.ownerId) !== ownerId) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      const items = await fetchCollectionItems(pool, id);
      res.json({
        ok: true,
        collection: mapCollectionRow(record),
        items: items.map(mapItemRow)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      const ownerId = await resolveOwnerId(pool, auth);
      if (!auth || ownerId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const title = sanitizeTitle(req.body?.title);
      if (!title) {
        return res.status(400).json({ ok: false, error: 'invalid_title' });
      }
      const description = sanitizeOptionalText(req.body?.description, DESCRIPTION_MAX_LEN);
      const notes = sanitizeOptionalText(req.body?.notes, NOTES_MAX_LEN);
      const coverImageUrl = normalizeString(req.body?.coverImageUrl) || null;
      const coverImageOffsetX = sanitizeCoverOffset(req.body?.coverImageOffsetX, 0);
      const coverImageOffsetY = sanitizeCoverOffset(req.body?.coverImageOffsetY, 0);
      const coverImageScale = sanitizeCoverScale(req.body?.coverImageScale, 1);
      const isDefault = req.body?.isDefault === true;

      const existingCount = await countCollections(pool, ownerId);
      if (existingCount >= MAX_COLLECTIONS_PER_USER) {
        return res.status(400).json({ ok: false, error: 'collection_limit_reached' });
      }

      const baseSlug = slugify(req.body?.slug || title);
      const slug = await ensureUniqueSlug(pool, ownerId, baseSlug);

      const supportsTransforms = await ensureCoverTransformColumns(pool);

      const result = await pool.query<any>(
        supportsTransforms
          ? `
            INSERT INTO "UserCollection"
            ("ownerId", title, slug, visibility, description, notes, "coverImageUrl", "coverImageOffsetX", "coverImageOffsetY", "coverImageScale", "isDefault", "publishedAt")
            VALUES ($1, $2, $3, 'PRIVATE', $4, $5, $6, $7, $8, $9, $10, NULL)
            RETURNING *
          `
          : `
            INSERT INTO "UserCollection"
            ("ownerId", title, slug, visibility, description, notes, "coverImageUrl", "isDefault", "publishedAt")
            VALUES ($1, $2, $3, 'PRIVATE', $4, $5, $6, $7, NULL)
            RETURNING *
          `,
        supportsTransforms
          ? [ownerId, title, slug, description, notes, coverImageUrl, coverImageOffsetX, coverImageOffsetY, coverImageScale, isDefault]
          : [ownerId, title, slug, description, notes, coverImageUrl, isDefault]
      );

      if (isDefault) {
        await pool.query(
          `
            UPDATE "UserCollection"
            SET "isDefault" = FALSE
            WHERE "ownerId" = $1 AND id <> $2 AND "isDefault" = TRUE
          `,
          [ownerId, result.rows[0].id]
        );
      }

      res.status(201).json({ ok: true, collection: mapCollectionRow(result.rows[0]) });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id', async (req, res, next) => {
    try {
      const id = Number.parseInt(String(req.params.id ?? ''), 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_id' });
      }
      const auth = await fetchAuthUser(req);
      const ownerId = await resolveOwnerId(pool, auth);
      if (!auth || ownerId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const record = await fetchCollectionById(pool, id);
      if (!record || Number(record.ownerId) !== ownerId) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }

      const title = req.body?.title !== undefined ? sanitizeTitle(req.body.title) : record.title;
      if (!title) {
        return res.status(400).json({ ok: false, error: 'invalid_title' });
      }

      const description = req.body?.description !== undefined
        ? sanitizeOptionalText(req.body.description, DESCRIPTION_MAX_LEN)
        : record.description;
      const notes = req.body?.notes !== undefined
        ? sanitizeOptionalText(req.body.notes, NOTES_MAX_LEN)
        : record.notes;
      const coverImageUrl = req.body?.coverImageUrl !== undefined
        ? (normalizeString(req.body.coverImageUrl) || null)
        : record.coverImageUrl;
      const coverImageOffsetX = req.body?.coverImageOffsetX !== undefined
        ? sanitizeCoverOffset(req.body.coverImageOffsetX, Number(record.coverImageOffsetX ?? 0))
        : Number(record.coverImageOffsetX ?? 0);
      const coverImageOffsetY = req.body?.coverImageOffsetY !== undefined
        ? sanitizeCoverOffset(req.body.coverImageOffsetY, Number(record.coverImageOffsetY ?? 0))
        : Number(record.coverImageOffsetY ?? 0);
      const coverImageScale = req.body?.coverImageScale !== undefined
        ? sanitizeCoverScale(req.body.coverImageScale, Number(record.coverImageScale ?? 1))
        : Number(record.coverImageScale ?? 1);

      let visibility: Visibility = record.visibility;
      if (req.body?.visibility !== undefined) {
        const nextVisibility = sanitizeVisibility(req.body.visibility);
        if (!nextVisibility) {
          return res.status(400).json({ ok: false, error: 'invalid_visibility' });
        }
        if (nextVisibility === 'PUBLIC' && (!auth.linkedWikidotId || !Number.isFinite(auth.linkedWikidotId))) {
          return res.status(400).json({ ok: false, error: 'require_linked_wikidot' });
        }
        visibility = nextVisibility;
      }

      const isDefault = req.body?.isDefault === true;
      const slugInput = normalizeString(req.body?.slug || '');
      const baseSlug = slugInput ? slugify(slugInput) : slugify(title);
      const slug = await ensureUniqueSlug(pool, ownerId, baseSlug || record.slug, id);

      const publishMoment = visibility === 'PUBLIC' && record.visibility !== 'PUBLIC' ? new Date() : null;
      const unpublish = visibility === 'PRIVATE' && record.visibility === 'PUBLIC';

      const supportsTransforms = await ensureCoverTransformColumns(pool);

      const updated = await pool.query<any>(
        supportsTransforms
          ? `
            UPDATE "UserCollection"
            SET
              title = $1,
              slug = $2,
              visibility = $3,
              description = $4,
              notes = $5,
              "coverImageUrl" = $6,
              "coverImageOffsetX" = $7,
              "coverImageOffsetY" = $8,
              "coverImageScale" = $9,
              "isDefault" = $10,
              "publishedAt" = CASE
                WHEN $11::timestamptz IS NOT NULL THEN $11
                WHEN $12::boolean IS TRUE THEN NULL
                ELSE "publishedAt"
              END,
              "updatedAt" = NOW()
            WHERE id = $13
            RETURNING *
          `
          : `
            UPDATE "UserCollection"
            SET
              title = $1,
              slug = $2,
              visibility = $3,
              description = $4,
              notes = $5,
              "coverImageUrl" = $6,
              "isDefault" = $7,
              "publishedAt" = CASE
                WHEN $8::timestamptz IS NOT NULL THEN $8
                WHEN $9::boolean IS TRUE THEN NULL
                ELSE "publishedAt"
              END,
              "updatedAt" = NOW()
            WHERE id = $10
            RETURNING *
          `,
        supportsTransforms
          ? [
              title,
              slug,
              visibility,
              description,
              notes,
              coverImageUrl,
              coverImageOffsetX,
              coverImageOffsetY,
              coverImageScale,
              isDefault,
              publishMoment,
              unpublish,
              id
            ]
          : [
              title,
              slug,
              visibility,
              description,
              notes,
              coverImageUrl,
              isDefault,
              publishMoment,
              unpublish,
              id
            ]
      );

      if (isDefault) {
        await pool.query(
          `
            UPDATE "UserCollection"
            SET "isDefault" = FALSE
            WHERE "ownerId" = $1 AND id <> $2 AND "isDefault" = TRUE
          `,
          [ownerId, id]
        );
      }

      res.json({ ok: true, collection: mapCollectionRow(updated.rows[0]) });
    } catch (error) {
      next(error);
    }
  });

  router.delete('/:id', async (req, res, next) => {
    try {
      const id = Number.parseInt(String(req.params.id ?? ''), 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_id' });
      }
      const auth = await fetchAuthUser(req);
      const ownerId = await resolveOwnerId(pool, auth);
      if (!auth || ownerId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const record = await fetchCollectionById(pool, id);
      if (!record || Number(record.ownerId) !== ownerId) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      await pool.query('DELETE FROM "UserCollection" WHERE id = $1', [id]);
      res.json({ ok: true, deleted: 1 });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/items', async (req, res, next) => {
    try {
      const id = Number.parseInt(String(req.params.id ?? ''), 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_id' });
      }
      const auth = await fetchAuthUser(req);
      const ownerId = await resolveOwnerId(pool, auth);
      if (!auth || ownerId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const record = await fetchCollectionById(pool, id);
      if (!record || Number(record.ownerId) !== ownerId) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }

      const pageId = await resolvePageId(pool, req.body || {});
      if (!pageId) {
        return res.status(400).json({ ok: false, error: 'invalid_page' });
      }
      const existingItemCount = await countItems(pool, id);
      if (existingItemCount >= MAX_ITEMS_PER_COLLECTION) {
        return res.status(400).json({ ok: false, error: 'item_limit_reached' });
      }

      const annotation = sanitizeOptionalText(req.body?.annotation, ANNOTATION_MAX_LEN);
      const pinned = req.body?.pinned === true;

      const orderResult = await pool.query<{ max: number }>(
        'SELECT COALESCE(MAX("order"), 0)::float AS max FROM "UserCollectionItem" WHERE "collectionId" = $1',
        [id]
      );
      const nextOrder = (orderResult.rows[0]?.max ?? 0) + 1;

      const inserted = await pool.query<any>(
        `
          INSERT INTO "UserCollectionItem"
          ("collectionId", "pageId", annotation, "order", pinned)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT ("collectionId", "pageId") DO UPDATE
          SET annotation = EXCLUDED.annotation,
              pinned = EXCLUDED.pinned,
              "updatedAt" = NOW()
          RETURNING *
        `,
        [id, pageId, annotation, nextOrder, pinned]
      );

      const items = await fetchCollectionItems(pool, id);
      res.status(201).json({
        ok: true,
        item: mapItemRow(inserted.rows[0]),
        items: items.map(mapItemRow)
      });
    } catch (error) {
      next(error);
    }
  });

  router.patch('/:id/items/:itemId', async (req, res, next) => {
    try {
      const id = Number.parseInt(String(req.params.id ?? ''), 10);
      const itemId = Number.parseInt(String(req.params.itemId ?? ''), 10);
      if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(itemId) || itemId <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_id' });
      }
      const auth = await fetchAuthUser(req);
      const ownerId = await resolveOwnerId(pool, auth);
      if (!auth || ownerId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }

      const record = await fetchCollectionById(pool, id);
      if (!record || Number(record.ownerId) !== ownerId) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }

      const { rows } = await pool.query<any>(
        `
          SELECT id, "collectionId", annotation, "order", pinned
          FROM "UserCollectionItem"
          WHERE id = $1 AND "collectionId" = $2
          LIMIT 1
        `,
        [itemId, id]
      );
      if (rows.length === 0) {
        return res.status(404).json({ ok: false, error: 'item_not_found' });
      }

      const annotation = req.body?.annotation !== undefined
        ? sanitizeOptionalText(req.body.annotation, ANNOTATION_MAX_LEN)
        : rows[0].annotation;
      const pinned = req.body?.pinned !== undefined ? Boolean(req.body.pinned) : rows[0].pinned;

      const updated = await pool.query<any>(
        `
          UPDATE "UserCollectionItem"
          SET annotation = $1,
              pinned = $2,
              "updatedAt" = NOW()
          WHERE id = $3
          RETURNING *
        `,
        [annotation, pinned, itemId]
      );

      res.json({ ok: true, item: mapItemRow(updated.rows[0]) });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/items/reorder', async (req, res, next) => {
    const client = await pool.connect();
    let began = false;
    try {
      const id = Number.parseInt(String(req.params.id ?? ''), 10);
      if (!Number.isFinite(id) || id <= 0) {
        client.release();
        return res.status(400).json({ ok: false, error: 'invalid_id' });
      }
      const auth = await fetchAuthUser(req);
      const ownerId = await resolveOwnerId(pool, auth);
      if (!auth || ownerId == null) {
        client.release();
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const record = await fetchCollectionById(pool, id);
      if (!record || Number(record.ownerId) !== ownerId) {
        client.release();
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      const orderList = Array.isArray(req.body?.order) ? req.body.order.map((n: any) => Number(n)).filter((n: number) => Number.isFinite(n) && n > 0) : [];
      if (orderList.length === 0) {
        client.release();
        return res.status(400).json({ ok: false, error: 'invalid_order' });
      }

      await client.query('BEGIN');
      began = true;
      let position = 1;
      for (const itemId of orderList) {
        await client.query(
          `
            UPDATE "UserCollectionItem"
            SET "order" = $1,
                "updatedAt" = NOW()
            WHERE id = $2 AND "collectionId" = $3
          `,
          [position, itemId, id]
        );
        position += 1;
      }
      await client.query('COMMIT');

      const items = await fetchCollectionItems(pool, id);
      client.release();
      res.json({ ok: true, items: items.map(mapItemRow) });
    } catch (error) {
      if (began) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback errors
        }
      }
      client.release();
      next(error);
    }
  });

  router.delete('/:id/items/:itemId', async (req, res, next) => {
    try {
      const id = Number.parseInt(String(req.params.id ?? ''), 10);
      const itemId = Number.parseInt(String(req.params.itemId ?? ''), 10);
      if (!Number.isFinite(id) || id <= 0 || !Number.isFinite(itemId) || itemId <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_id' });
      }
      const auth = await fetchAuthUser(req);
      const ownerId = await resolveOwnerId(pool, auth);
      if (!auth || ownerId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const record = await fetchCollectionById(pool, id);
      if (!record || Number(record.ownerId) !== ownerId) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      const result = await pool.query(
        'DELETE FROM "UserCollectionItem" WHERE id = $1 AND "collectionId" = $2',
        [itemId, id]
      );
      res.json({ ok: true, deleted: result.rowCount || 0 });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
