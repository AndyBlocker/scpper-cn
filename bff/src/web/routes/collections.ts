import { Router } from 'express';
import type { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { fetchAuthUser, fetchFreshAuthUser } from '../utils/auth.js';
import {
  lockCollectionOwnerForWrite,
  resolveCollectionOwnerId,
  withLockedCollectionOwner
} from '../utils/collectionOwner.js';

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
type Queryable = Pick<Pool, 'query'>;

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

async function ensureCoverTransformColumns(db: Queryable): Promise<boolean> {
  if (coverTransformColumnsAvailable != null) return coverTransformColumnsAvailable;
  try {
    const { rows } = await db.query<{ column_name: string }>(
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

async function ensureUniqueSlug(
  db: Queryable,
  ownerId: number,
  baseSlug: string,
  excludeId?: number | null
): Promise<string> {
  const MAX_SLUG_ATTEMPTS = 100;
  let attempt = 0;
  let candidate = baseSlug || `collection-${Date.now().toString(36)}`;
  while (true) {
    const { rows } = await db.query<{ id: number }>(
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
    if (attempt >= MAX_SLUG_ATTEMPTS) {
      throw new Error(`Failed to generate unique slug after ${MAX_SLUG_ATTEMPTS} attempts`);
    }
    candidate = `${baseSlug}-${attempt}`;
  }
}

async function countCollections(db: Queryable, ownerId: number): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM "UserCollection" WHERE "ownerId" = $1',
    [ownerId]
  );
  return Number(rows[0]?.count ?? 0);
}

async function countItems(db: Queryable, collectionId: number): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    'SELECT COUNT(*)::text AS count FROM "UserCollectionItem" WHERE "collectionId" = $1',
    [collectionId]
  );
  return Number(rows[0]?.count ?? 0);
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

// Public routes use an allowlist rather than deleting `notes` after mapping.
// `notes` is explicitly presented as "只有自己可见" in the editor and must
// never be selected or serialized for anonymous collection responses.
function mapPublicCollectionRow(row: any) {
  return {
    id: Number(row.id),
    ownerId: Number(row.ownerId),
    title: row.title,
    slug: row.slug,
    visibility: row.visibility,
    description: row.description ?? null,
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

async function fetchCollectionById(db: Queryable, id: number) {
  const { rows } = await db.query<any>(
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

async function fetchCollectionItems(db: Queryable, collectionId: number) {
  const { rows } = await db.query<any>(
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

async function resolvePageId(db: Queryable, payload: any): Promise<number | null> {
  if (payload == null) return null;
  // Prefer explicit pageId, but fall back to wikidotId if not found (for backward compatibility)
  let resolved: number | null = null;
  if (payload.pageId != null && Number.isFinite(Number(payload.pageId))) {
    const numeric = Number(payload.pageId);
    const { rows } = await db.query<{ id: number }>(
      'SELECT id FROM "Page" WHERE id = $1 AND ("isDeleted" IS NULL OR "isDeleted" = false) LIMIT 1',
      [numeric]
    );
    resolved = rows[0]?.id ?? null;
  }
  if (!resolved && payload.pageWikidotId != null && Number.isFinite(Number(payload.pageWikidotId))) {
    const wikidotId = Number(payload.pageWikidotId);
    const { rows } = await db.query<{ id: number }>(
      'SELECT id FROM "Page" WHERE "wikidotId" = $1 AND ("isDeleted" IS NULL OR "isDeleted" = false) LIMIT 1',
      [wikidotId]
    );
    resolved = rows[0]?.id ?? null;
  }
  return resolved;
}

export function collectionsRouter(pool: Pool, _redis: RedisClientType | null) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      if (!auth) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const limitParam = Number.parseInt(String(req.query.limit ?? '20'), 10);
      const offsetParam = Number.parseInt(String(req.query.offset ?? '0'), 10);
      const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 100) : 20;
      const offset = Number.isFinite(offsetParam) ? Math.max(offsetParam, 0) : 0;

      const result = await withLockedCollectionOwner(
        pool,
        auth,
        async (client, mapping) => {
          const list = await client.query<any>(
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
            [mapping.userId, limit, offset]
          );
          const totalRows = await client.query<{ total: string }>(
            'SELECT COUNT(*)::text AS total FROM "UserCollection" WHERE "ownerId" = $1',
            [mapping.userId]
          );
          return {
            total: Number(totalRows.rows[0]?.total ?? 0),
            items: list.rows.map(mapCollectionRow)
          };
        },
        () => fetchFreshAuthUser(req)
      );
      if (!result) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }

      res.json({
        ok: true,
        total: result.total,
        items: result.items
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
            c.id,
            c."ownerId",
            c.title,
            c.slug,
            c.visibility,
            c.description,
            c."coverImageUrl",
            c."coverImageOffsetX",
            c."coverImageOffsetY",
            c."coverImageScale",
            c."isDefault",
            c."publishedAt",
            c."createdAt",
            c."updatedAt",
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
        items: rows.map(mapPublicCollectionRow)
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
          SELECT
            c.id,
            c."ownerId",
            c.title,
            c.slug,
            c.visibility,
            c.description,
            c."coverImageUrl",
            c."coverImageOffsetX",
            c."coverImageOffsetY",
            c."coverImageScale",
            c."isDefault",
            c."publishedAt",
            c."createdAt",
            c."updatedAt",
            (
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
        collection: mapPublicCollectionRow(collection),
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
      if (!auth) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const result = await withLockedCollectionOwner(
        pool,
        auth,
        async (client, mapping) => {
          const record = await fetchCollectionById(client, id);
          if (!record || Number(record.ownerId) !== mapping.userId) {
            return { kind: 'not_found' } as const;
          }
          const items = await fetchCollectionItems(client, id);
          return {
            kind: 'ok',
            collection: mapCollectionRow(record),
            items: items.map(mapItemRow)
          } as const;
        },
        () => fetchFreshAuthUser(req)
      );
      if (!result) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      if (result.kind === 'not_found') {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      res.json({
        ok: true,
        collection: result.collection,
        items: result.items
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/', async (req, res, next) => {
    try {
      const auth = await fetchAuthUser(req);
      if (!auth) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const title = sanitizeTitle(req.body?.title);
      if (!title) {
        return res.status(400).json({ ok: false, error: 'invalid_title' });
      }
      const visibility = req.body?.visibility === undefined
        ? 'PRIVATE'
        : sanitizeVisibility(req.body.visibility);
      if (!visibility) {
        return res.status(400).json({ ok: false, error: 'invalid_visibility' });
      }
      if (
        visibility === 'PUBLIC'
        && (!auth.linkedWikidotId || !Number.isFinite(auth.linkedWikidotId))
      ) {
        return res.status(400).json({ ok: false, error: 'require_linked_wikidot' });
      }
      const resolvedOwnerId = await resolveCollectionOwnerId(
        pool,
        auth,
        () => fetchFreshAuthUser(req)
      );
      if (resolvedOwnerId == null) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const description = sanitizeOptionalText(req.body?.description, DESCRIPTION_MAX_LEN);
      const notes = sanitizeOptionalText(req.body?.notes, NOTES_MAX_LEN);
      const coverImageUrl = normalizeString(req.body?.coverImageUrl) || null;
      const coverImageOffsetX = sanitizeCoverOffset(req.body?.coverImageOffsetX, 0);
      const coverImageOffsetY = sanitizeCoverOffset(req.body?.coverImageOffsetY, 0);
      const coverImageScale = sanitizeCoverScale(req.body?.coverImageScale, 1);
      const isDefault = req.body?.isDefault === true;
      const publishedAt = visibility === 'PUBLIC' ? new Date() : null;
      const baseSlug = slugify(req.body?.slug || title);

      // Pin the account mapping for the whole owner-dependent operation. This
      // shares the reconciliation lock so a concurrent Wikidot link cannot
      // leave a newly-created collection on the migrated-away guest owner.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const lockedOwner = await lockCollectionOwnerForWrite(client, auth);
        if (!lockedOwner) {
          await client.query('ROLLBACK');
          return res.status(401).json({ ok: false, error: 'unauthenticated' });
        }
        const ownerId = lockedOwner.userId;
        if (
          visibility === 'PUBLIC'
          && lockedOwner.wikidotId !== Number(auth.linkedWikidotId)
        ) {
          await client.query('ROLLBACK');
          return res.status(409).json({ ok: false, error: 'collection_owner_conflict' });
        }

        const existingCount = await countCollections(client, ownerId);
        if (existingCount >= MAX_COLLECTIONS_PER_USER) {
          await client.query('COMMIT');
          return res.status(400).json({ ok: false, error: 'collection_limit_reached' });
        }

        const slug = await ensureUniqueSlug(client, ownerId, baseSlug);
        const supportsTransforms = await ensureCoverTransformColumns(client);

        // Advisory lock on ownerId to serialize concurrent isDefault changes
        if (isDefault) {
          await client.query('SELECT pg_advisory_xact_lock($1)', [ownerId]);
        }

        const result = await client.query<any>(
          supportsTransforms
            ? `
              INSERT INTO "UserCollection"
              ("ownerId", title, slug, visibility, description, notes, "coverImageUrl", "coverImageOffsetX", "coverImageOffsetY", "coverImageScale", "isDefault", "publishedAt", "updatedAt")
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
              RETURNING *
            `
            : `
              INSERT INTO "UserCollection"
              ("ownerId", title, slug, visibility, description, notes, "coverImageUrl", "isDefault", "publishedAt", "updatedAt")
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
              RETURNING *
            `,
          supportsTransforms
            ? [
                ownerId,
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
                publishedAt
              ]
            : [
                ownerId,
                title,
                slug,
                visibility,
                description,
                notes,
                coverImageUrl,
                isDefault,
                publishedAt
              ]
        );

        if (isDefault) {
          await client.query(
            `
              UPDATE "UserCollection"
              SET "isDefault" = FALSE,
                  "updatedAt" = NOW()
              WHERE "ownerId" = $1 AND id <> $2 AND "isDefault" = TRUE
            `,
            [ownerId, result.rows[0].id]
          );
        }

        await client.query('COMMIT');
        res.status(201).json({ ok: true, collection: mapCollectionRow(result.rows[0]) });
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
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
      const ownerId = await resolveCollectionOwnerId(
        pool,
        auth,
        () => fetchFreshAuthUser(req)
      );
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

      const publishMoment = visibility === 'PUBLIC' && record.visibility !== 'PUBLIC' ? new Date() : null;
      const unpublish = visibility === 'PRIVATE' && record.visibility === 'PUBLIC';

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const lockedOwner = await lockCollectionOwnerForWrite(client, auth);
        if (!lockedOwner) {
          await client.query('ROLLBACK');
          return res.status(401).json({ ok: false, error: 'unauthenticated' });
        }
        const lockedOwnerId = lockedOwner.userId;
        const lockedCollection = await client.query<{ ownerId: number }>(
          `
            SELECT "ownerId"
            FROM "UserCollection"
            WHERE id = $1
            FOR UPDATE
          `,
          [id]
        );
        if (
          !lockedCollection.rows[0]
          || Number(lockedCollection.rows[0].ownerId) !== lockedOwnerId
        ) {
          await client.query('ROLLBACK');
          return res.status(404).json({ ok: false, error: 'not_found' });
        }
        if (
          visibility === 'PUBLIC'
          && lockedOwner.wikidotId !== Number(auth.linkedWikidotId)
        ) {
          await client.query('ROLLBACK');
          return res.status(409).json({ ok: false, error: 'collection_owner_conflict' });
        }

        const slug = await ensureUniqueSlug(
          client,
          lockedOwnerId,
          baseSlug || record.slug,
          id
        );
        const supportsTransforms = await ensureCoverTransformColumns(client);

        // Advisory lock on ownerId to serialize concurrent isDefault changes
        if (isDefault) {
          await client.query('SELECT pg_advisory_xact_lock($1)', [lockedOwnerId]);
        }

        const updated = await client.query<any>(
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
          await client.query(
            `
              UPDATE "UserCollection"
              SET "isDefault" = FALSE,
                  "updatedAt" = NOW()
              WHERE "ownerId" = $1 AND id <> $2 AND "isDefault" = TRUE
            `,
            [lockedOwnerId, id]
          );
        }

        await client.query('COMMIT');
        res.json({ ok: true, collection: mapCollectionRow(updated.rows[0]) });
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
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
      if (!auth) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const result = await withLockedCollectionOwner(
        pool,
        auth,
        async (client, mapping) => client.query(
          `
            DELETE FROM "UserCollection"
            WHERE id = $1 AND "ownerId" = $2
          `,
          [id, mapping.userId]
        ),
        () => fetchFreshAuthUser(req)
      );
      if (!result) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      if (result.rowCount !== 1) {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
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
      if (!auth) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const annotation = sanitizeOptionalText(req.body?.annotation, ANNOTATION_MAX_LEN);
      const pinned = req.body?.pinned === true;
      const result = await withLockedCollectionOwner(
        pool,
        auth,
        async (client, mapping) => {
          const record = await fetchCollectionById(client, id);
          if (!record || Number(record.ownerId) !== mapping.userId) {
            return { kind: 'not_found' } as const;
          }

          const pageId = await resolvePageId(client, req.body || {});
          if (!pageId) {
            return { kind: 'invalid_page' } as const;
          }
          const existingItemCount = await countItems(client, id);
          if (existingItemCount >= MAX_ITEMS_PER_COLLECTION) {
            return { kind: 'item_limit_reached' } as const;
          }

          const orderResult = await client.query<{ max: number }>(
            'SELECT COALESCE(MAX("order"), 0)::float AS max FROM "UserCollectionItem" WHERE "collectionId" = $1',
            [id]
          );
          const nextOrder = (orderResult.rows[0]?.max ?? 0) + 1;
          const inserted = await client.query<any>(
            `
              INSERT INTO "UserCollectionItem"
              ("collectionId", "pageId", annotation, "order", pinned, "updatedAt")
              VALUES ($1, $2, $3, $4, $5, NOW())
              ON CONFLICT ("collectionId", "pageId") DO UPDATE
              SET annotation = EXCLUDED.annotation,
                  pinned = EXCLUDED.pinned,
                  "updatedAt" = NOW()
              RETURNING *
            `,
            [id, pageId, annotation, nextOrder, pinned]
          );
          const items = await fetchCollectionItems(client, id);
          return {
            kind: 'ok',
            item: mapItemRow(inserted.rows[0]),
            items: items.map(mapItemRow)
          } as const;
        },
        () => fetchFreshAuthUser(req)
      );
      if (!result) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      if (result.kind === 'not_found') {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      if (result.kind === 'invalid_page') {
        return res.status(400).json({ ok: false, error: 'invalid_page' });
      }
      if (result.kind === 'item_limit_reached') {
        return res.status(400).json({ ok: false, error: 'item_limit_reached' });
      }
      res.status(201).json({
        ok: true,
        item: result.item,
        items: result.items
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
      if (!auth) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const result = await withLockedCollectionOwner(
        pool,
        auth,
        async (client, mapping) => {
          const record = await fetchCollectionById(client, id);
          if (!record || Number(record.ownerId) !== mapping.userId) {
            return { kind: 'not_found' } as const;
          }

          const { rows } = await client.query<any>(
            `
              SELECT id, "collectionId", annotation, "order", pinned
              FROM "UserCollectionItem"
              WHERE id = $1 AND "collectionId" = $2
              LIMIT 1
              FOR UPDATE
            `,
            [itemId, id]
          );
          if (rows.length === 0) {
            return { kind: 'item_not_found' } as const;
          }

          const annotation = req.body?.annotation !== undefined
            ? sanitizeOptionalText(req.body.annotation, ANNOTATION_MAX_LEN)
            : rows[0].annotation;
          const pinned = req.body?.pinned !== undefined
            ? Boolean(req.body.pinned)
            : rows[0].pinned;
          const updated = await client.query<any>(
            `
              UPDATE "UserCollectionItem"
              SET annotation = $1,
                  pinned = $2,
                  "updatedAt" = NOW()
              WHERE id = $3 AND "collectionId" = $4
              RETURNING *
            `,
            [annotation, pinned, itemId, id]
          );
          if (updated.rows.length === 0) {
            return { kind: 'item_not_found' } as const;
          }
          return { kind: 'ok', item: mapItemRow(updated.rows[0]) } as const;
        },
        () => fetchFreshAuthUser(req)
      );
      if (!result) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      if (result.kind === 'not_found') {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      if (result.kind === 'item_not_found') {
        return res.status(404).json({ ok: false, error: 'item_not_found' });
      }
      res.json({ ok: true, item: result.item });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:id/items/reorder', async (req, res, next) => {
    try {
      const id = Number.parseInt(String(req.params.id ?? ''), 10);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ ok: false, error: 'invalid_id' });
      }
      const orderList = Array.isArray(req.body?.order)
        ? req.body.order
          .map((value: unknown) => Number(value))
          .filter((value: number) => Number.isFinite(value) && value > 0)
        : [];
      if (orderList.length === 0) {
        return res.status(400).json({ ok: false, error: 'invalid_order' });
      }
      const auth = await fetchAuthUser(req);
      if (!auth) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const result = await withLockedCollectionOwner(
        pool,
        auth,
        async (client, mapping) => {
          const record = await fetchCollectionById(client, id);
          if (!record || Number(record.ownerId) !== mapping.userId) {
            return { kind: 'not_found' } as const;
          }

          // Batch update using unnest instead of N individual UPDATE statements.
          const positions = orderList.map((_: number, index: number) => index + 1);
          await client.query(
            `
              UPDATE "UserCollectionItem" AS t
              SET "order" = v.position,
                  "updatedAt" = NOW()
              FROM unnest($1::int[], $2::int[]) AS v(item_id, position)
              WHERE t.id = v.item_id AND t."collectionId" = $3
            `,
            [orderList, positions, id]
          );
          const items = await fetchCollectionItems(client, id);
          return { kind: 'ok', items: items.map(mapItemRow) } as const;
        },
        () => fetchFreshAuthUser(req)
      );
      if (!result) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      if (result.kind === 'not_found') {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      res.json({ ok: true, items: result.items });
    } catch (error) {
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
      if (!auth) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      const result = await withLockedCollectionOwner(
        pool,
        auth,
        async (client, mapping) => {
          const record = await fetchCollectionById(client, id);
          if (!record || Number(record.ownerId) !== mapping.userId) {
            return { kind: 'not_found' } as const;
          }
          const deleted = await client.query(
            'DELETE FROM "UserCollectionItem" WHERE id = $1 AND "collectionId" = $2',
            [itemId, id]
          );
          return { kind: 'ok', deleted: deleted.rowCount || 0 } as const;
        },
        () => fetchFreshAuthUser(req)
      );
      if (!result) {
        return res.status(401).json({ ok: false, error: 'unauthenticated' });
      }
      if (result.kind === 'not_found') {
        return res.status(404).json({ ok: false, error: 'not_found' });
      }
      res.json({ ok: true, deleted: result.deleted });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
