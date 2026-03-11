import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { disconnectPrisma, getPrismaClient } from '../utils/db-connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: false });
dotenv.config({ path: path.resolve(__dirname, '../../../user-backend/.env'), override: false });

const DEFAULT_PAGE_IMAGE_ROUTE_PREFIX = '/page-images';
const DEFAULT_PAGE_CHUNK_SIZE = 5000;
const DEFAULT_VERSION_CHUNK_SIZE = 300;
const DEFAULT_UPDATE_CHUNK_SIZE = 500;
const PERMANENT_POOL_ID = 'permanent-main-pool';

type PgValue = string | number | null;

interface RepairOptions {
  dryRun?: boolean;
  pageChunkSize?: number;
  versionChunkSize?: number;
  updateChunkSize?: number;
}

interface UserCardRow {
  id: string;
  pageId: number;
  imageUrl: string | null;
  variantKey: string | null;
  createdAtEpoch: string;
}

interface PageVersionWindowRow {
  id: number;
  pageId: number;
  validFromEpoch: number;
  validToEpoch: number | null;
}

interface VersionImageRow {
  pageVersionId: number;
  sortId: number;
  imageAssetId: number;
  normalizedUrl: string | null;
  hashSha256: string | null;
}

function normalizePageImageRoutePrefix(raw: string | undefined): string {
  const trimmed = (raw ?? DEFAULT_PAGE_IMAGE_ROUTE_PREFIX).trim();
  let candidate = trimmed || DEFAULT_PAGE_IMAGE_ROUTE_PREFIX;
  if (!candidate.startsWith('/')) {
    candidate = `/${candidate}`;
  }
  candidate = candidate.replace(/\/+$/u, '');
  if (candidate === '' || candidate === '/') {
    return DEFAULT_PAGE_IMAGE_ROUTE_PREFIX;
  }
  return candidate;
}

const PAGE_IMAGE_ROUTE_PREFIX = normalizePageImageRoutePrefix(process.env.PAGE_IMAGE_ROUTE_PREFIX);

function buildPageImagePath(assetId: number | null | undefined): string | null {
  const normalized = Number.isFinite(assetId) ? Math.floor(Number(assetId)) : 0;
  if (!Number.isInteger(normalized) || normalized <= 0) return null;
  return `${PAGE_IMAGE_ROUTE_PREFIX}/${normalized}`;
}

function normalizeImageUrl(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeVariantKey(raw: string | null | undefined): string | null {
  const trimmed = String(raw ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildVariantKey(image: {
  normalizedUrl?: string | null;
  hashSha256?: string | null;
  imageAssetId?: number | null;
}) {
  const hashSha256 = normalizeImageUrl(image.hashSha256);
  if (hashSha256) {
    return `hash:${hashSha256.toLowerCase()}`;
  }
  const normalizedUrl = normalizeImageUrl(image.normalizedUrl);
  if (normalizedUrl) {
    return `url:${normalizedUrl}`;
  }
  const assetId = Number.isFinite(image.imageAssetId) ? Math.floor(Number(image.imageAssetId)) : 0;
  if (assetId > 0) {
    return `asset:${assetId}`;
  }
  return null;
}

function chunkRows<T>(rows: T[], size: number): T[][] {
  if (size <= 0 || rows.length <= size) return [rows];
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

function buildValuesClause<T>(
  rows: T[],
  mapper: (row: T) => PgValue[]
): { clause: string; params: PgValue[] } {
  const params: PgValue[] = [];
  let index = 1;
  const tuples = rows.map((row) => {
    const values = mapper(row);
    const placeholders = values.map(() => `$${index++}`);
    params.push(...values);
    return `(${placeholders.join(',')})`;
  });
  return {
    clause: tuples.join(', '),
    params
  };
}

function extractVariantIndex(cardId: string, pageId: number): number | null {
  const escapedPageId = String(pageId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`-${escapedPageId}(?:-img-(\\d+))?$`);
  const match = pattern.exec(cardId);
  if (!match) return null;
  if (!match[1]) return 1;
  const parsed = Number.parseInt(match[1], 10);
  if (!Number.isInteger(parsed) || parsed < 2) return null;
  return parsed;
}

function parseEpochSeconds(raw: string): number {
  const parsed = Number.parseInt(String(raw ?? '').trim(), 10);
  if (!Number.isFinite(parsed)) return 0;
  return parsed;
}

function pickVersionIdForCard(versions: PageVersionWindowRow[], createdAtEpoch: number): number | null {
  if (versions.length === 0) return null;
  for (const version of versions) {
    const startsBefore = version.validFromEpoch <= createdAtEpoch;
    const endsAfter = version.validToEpoch == null || createdAtEpoch < version.validToEpoch;
    if (startsBefore && endsAfter) {
      return version.id;
    }
  }

  // If no exact interval match, fall back to the latest version not newer than card creation.
  let fallback: PageVersionWindowRow | null = null;
  for (const version of versions) {
    if (version.validFromEpoch <= createdAtEpoch) {
      if (!fallback || version.validFromEpoch > fallback.validFromEpoch || version.id > fallback.id) {
        fallback = version;
      }
    }
  }
  if (fallback) return fallback.id;

  // Last resort: choose the earliest version for this page.
  return versions[0]!.id;
}

async function loadPageVersionWindows(
  prisma: ReturnType<typeof getPrismaClient>,
  pageIds: number[],
  pageChunkSize: number
) {
  const windowsByPageId = new Map<number, PageVersionWindowRow[]>();
  for (const chunk of chunkRows(pageIds, pageChunkSize)) {
    if (chunk.length === 0) continue;
    const rows = await prisma.$queryRaw<PageVersionWindowRow[]>`
      SELECT
        pv.id,
        pv."pageId",
        EXTRACT(EPOCH FROM (pv."validFrom" AT TIME ZONE 'UTC'))::bigint AS "validFromEpoch",
        EXTRACT(EPOCH FROM (pv."validTo" AT TIME ZONE 'UTC'))::bigint AS "validToEpoch"
      FROM "PageVersion" pv
      WHERE pv."pageId" = ANY(${chunk}::int[])
      ORDER BY pv."pageId", pv."validFrom" ASC, pv.id ASC
    `;
    for (const row of rows) {
      const list = windowsByPageId.get(row.pageId);
      if (list) {
        list.push(row);
      } else {
        windowsByPageId.set(row.pageId, [row]);
      }
    }
  }
  return windowsByPageId;
}

async function loadVersionImageMap(
  prisma: ReturnType<typeof getPrismaClient>,
  versionIds: number[],
  versionChunkSize: number
) {
  const imageMap = new Map<number, Array<{ imageUrl: string | null; variantKey: string | null }>>();
  for (const chunk of chunkRows(versionIds, versionChunkSize)) {
    if (chunk.length === 0) continue;
    const rows = await prisma.$queryRaw<VersionImageRow[]>`
      WITH targets AS (
        SELECT pv.id, pv."pageId"
        FROM "PageVersion" pv
        WHERE pv.id = ANY(${chunk}::int[])
      )
      SELECT
        t.id AS "pageVersionId",
        m.sort_id AS "sortId",
        m."imageAssetId",
        m."normalizedUrl",
        m."hashSha256"
      FROM targets t
      CROSS JOIN LATERAL (
        WITH current_rows AS (
          SELECT
            pvi.id,
            pvi."normalizedUrl",
            pvi."displayUrl",
            pvi."originUrl",
            pvi.status,
            pvi."imageAssetId"
          FROM "PageVersionImage" pvi
          WHERE pvi."pageVersionId" = t.id
        ),
        resolved_current AS (
          SELECT DISTINCT ON (cr."normalizedUrl")
            cr.id,
            cr."normalizedUrl",
            cr."displayUrl",
            cr."originUrl",
            cr."imageAssetId",
            ia."hashSha256"
          FROM current_rows cr
          JOIN "ImageAsset" ia ON ia.id = cr."imageAssetId"
          WHERE cr.status = 'RESOLVED'
            AND cr."imageAssetId" IS NOT NULL
            AND ia.status = 'READY'
            AND ia."storagePath" IS NOT NULL
          ORDER BY cr."normalizedUrl", cr.id DESC
        ),
        unresolved AS (
          SELECT
            cr.id AS "pageVersionImageId",
            cr."normalizedUrl",
            cr."displayUrl",
            cr."originUrl"
          FROM current_rows cr
          WHERE cr."normalizedUrl" IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM resolved_current rc
              WHERE rc."normalizedUrl" = cr."normalizedUrl"
            )
        ),
        fallback AS (
          SELECT DISTINCT ON (u."normalizedUrl")
            u."normalizedUrl",
            fpvi.id AS "fallbackPviId",
            fpvi."imageAssetId" AS "fallbackAssetId",
            fpvi."displayUrl" AS "fallbackDisplayUrl",
            fpvi."originUrl" AS "fallbackOriginUrl",
            ia."hashSha256"
          FROM unresolved u
          JOIN "PageVersionImage" fpvi ON fpvi."normalizedUrl" = u."normalizedUrl"
          JOIN "PageVersion" fpv ON fpv.id = fpvi."pageVersionId"
          JOIN "ImageAsset" ia ON ia.id = fpvi."imageAssetId"
          WHERE fpv."pageId" = t."pageId"
            AND fpvi.status = 'RESOLVED'
            AND fpvi."imageAssetId" IS NOT NULL
            AND ia.status = 'READY'
            AND ia."storagePath" IS NOT NULL
          ORDER BY u."normalizedUrl", fpvi."lastFetchedAt" DESC NULLS LAST, fpvi.id DESC
        ),
        merged AS (
          SELECT
            rc.id AS sort_id,
            rc."imageAssetId" AS "imageAssetId",
            rc."normalizedUrl" AS "normalizedUrl",
            rc."hashSha256" AS "hashSha256"
          FROM resolved_current rc
          UNION ALL
          SELECT
            u."pageVersionImageId" AS sort_id,
            f."fallbackAssetId" AS "imageAssetId",
            u."normalizedUrl" AS "normalizedUrl",
            f."hashSha256" AS "hashSha256"
          FROM unresolved u
          JOIN fallback f ON f."normalizedUrl" = u."normalizedUrl"
        )
        SELECT * FROM merged
        WHERE "imageAssetId" IS NOT NULL
      ) m
      ORDER BY t.id, m.sort_id
    `;

    for (const row of rows) {
      const imageUrl = buildPageImagePath(row.imageAssetId);
      const variantKey = buildVariantKey(row);
      const list = imageMap.get(row.pageVersionId);
      if (list) {
        list.push({ imageUrl, variantKey });
      } else {
        imageMap.set(row.pageVersionId, [{ imageUrl, variantKey }]);
      }
    }
  }
  return imageMap;
}

async function loadCurrentPageImageMap(
  prisma: ReturnType<typeof getPrismaClient>,
  pageIds: number[],
  pageChunkSize: number
) {
  const imageMap = new Map<number, Array<{ imageUrl: string | null; variantKey: string | null }>>();
  for (const chunk of chunkRows(pageIds, pageChunkSize)) {
    if (chunk.length === 0) continue;
    const rows = await prisma.$queryRaw<Array<{
      pageId: number;
      sortId: number;
      imageAssetId: number;
      normalizedUrl: string | null;
      hashSha256: string | null;
    }>>`
      SELECT
        pv."pageId" AS "pageId",
        m.sort_id AS "sortId",
        m."imageAssetId",
        m."normalizedUrl",
        m."hashSha256"
      FROM "PageVersion" pv
      CROSS JOIN LATERAL (
        WITH current_rows AS (
          SELECT
            pvi.id,
            pvi."normalizedUrl",
            pvi."displayUrl",
            pvi."originUrl",
            pvi.status,
            pvi."imageAssetId"
          FROM "PageVersionImage" pvi
          WHERE pvi."pageVersionId" = pv.id
        ),
        resolved_current AS (
          SELECT DISTINCT ON (cr."normalizedUrl")
            cr.id,
            cr."normalizedUrl",
            cr."displayUrl",
            cr."originUrl",
            cr."imageAssetId",
            ia."hashSha256"
          FROM current_rows cr
          JOIN "ImageAsset" ia ON ia.id = cr."imageAssetId"
          WHERE cr.status = 'RESOLVED'
            AND cr."imageAssetId" IS NOT NULL
            AND ia.status = 'READY'
            AND ia."storagePath" IS NOT NULL
          ORDER BY cr."normalizedUrl", cr.id DESC
        ),
        unresolved AS (
          SELECT
            cr.id AS "pageVersionImageId",
            cr."normalizedUrl",
            cr."displayUrl",
            cr."originUrl"
          FROM current_rows cr
          WHERE cr."normalizedUrl" IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM resolved_current rc
              WHERE rc."normalizedUrl" = cr."normalizedUrl"
            )
        ),
        fallback AS (
          SELECT DISTINCT ON (u."normalizedUrl")
            u."normalizedUrl",
            fpvi."imageAssetId" AS "fallbackAssetId",
            ia."hashSha256"
          FROM unresolved u
          JOIN "PageVersionImage" fpvi ON fpvi."normalizedUrl" = u."normalizedUrl"
          JOIN "PageVersion" fpv ON fpv.id = fpvi."pageVersionId"
          JOIN "ImageAsset" ia ON ia.id = fpvi."imageAssetId"
          WHERE fpv."pageId" = pv."pageId"
            AND fpvi.status = 'RESOLVED'
            AND fpvi."imageAssetId" IS NOT NULL
            AND ia.status = 'READY'
            AND ia."storagePath" IS NOT NULL
          ORDER BY u."normalizedUrl", fpvi."lastFetchedAt" DESC NULLS LAST, fpvi.id DESC
        ),
        merged AS (
          SELECT
            rc.id AS sort_id,
            rc."imageAssetId" AS "imageAssetId",
            rc."normalizedUrl" AS "normalizedUrl",
            rc."hashSha256" AS "hashSha256"
          FROM resolved_current rc
          UNION ALL
          SELECT
            u."pageVersionImageId" AS sort_id,
            f."fallbackAssetId" AS "imageAssetId",
            u."normalizedUrl" AS "normalizedUrl",
            f."hashSha256" AS "hashSha256"
          FROM unresolved u
          JOIN fallback f ON f."normalizedUrl" = u."normalizedUrl"
        )
        SELECT * FROM merged
        WHERE "imageAssetId" IS NOT NULL
      ) m
      WHERE pv."validTo" IS NULL
        AND pv."isDeleted" = false
        AND pv."pageId" = ANY(${chunk}::int[])
      ORDER BY pv."pageId", m.sort_id
    `;

    for (const row of rows) {
      const imageUrl = buildPageImagePath(row.imageAssetId);
      const variantKey = buildVariantKey(row);
      const list = imageMap.get(row.pageId);
      if (list) {
        list.push({ imageUrl, variantKey });
      } else {
        imageMap.set(row.pageId, [{ imageUrl, variantKey }]);
      }
    }
  }
  return imageMap;
}

export async function repairGachaCardImageMapping(rawOptions: RepairOptions = {}) {
  const prisma = getPrismaClient();
  const userDatabaseUrl = process.env.USER_DATABASE_URL ?? process.env.USER_BACKEND_DATABASE_URL;
  if (!userDatabaseUrl) {
    throw new Error('缺少 USER_DATABASE_URL（或 USER_BACKEND_DATABASE_URL）环境变量，无法连接用户数据库。');
  }

  const options: Required<RepairOptions> = {
    dryRun: Boolean(rawOptions.dryRun),
    pageChunkSize: Math.max(100, Math.floor(rawOptions.pageChunkSize ?? DEFAULT_PAGE_CHUNK_SIZE)),
    versionChunkSize: Math.max(20, Math.floor(rawOptions.versionChunkSize ?? DEFAULT_VERSION_CHUNK_SIZE)),
    updateChunkSize: Math.max(50, Math.floor(rawOptions.updateChunkSize ?? DEFAULT_UPDATE_CHUNK_SIZE))
  };

  const userDbPool = new Pool({ connectionString: userDatabaseUrl });
  const userDbClient = await userDbPool.connect();

  let totalCards = 0;
  let recognizedCards = 0;
  let unresolvedVersionCards = 0;
  let unresolvedImageCards = 0;
  let plannedUpdates = 0;
  let appliedUpdates = 0;

  try {
    const cardRows = await userDbClient.query<UserCardRow>(
      `
        SELECT
          "id",
          "pageId",
          "imageUrl",
          "variantKey",
          EXTRACT(EPOCH FROM ("createdAt" AT TIME ZONE 'UTC'))::bigint AS "createdAtEpoch"
        FROM "GachaCardDefinition"
        WHERE "poolId" = $1
          AND "pageId" IS NOT NULL
        ORDER BY "pageId" ASC, "id" ASC
      `,
      [PERMANENT_POOL_ID]
    );
    const cards = cardRows.rows ?? [];
    totalCards = cards.length;

    const pageIds = Array.from(new Set(cards.map((card) => card.pageId)));
    const currentImageMap = await loadCurrentPageImageMap(prisma, pageIds, options.pageChunkSize);

    for (const card of cards) {
      const variantIndex = extractVariantIndex(card.id, card.pageId);
      if (variantIndex == null) continue;
      recognizedCards += 1;
    }
    const updates: Array<{ id: string; imageUrl: string | null; variantKey: string | null }> = [];

    for (const card of cards) {
      const variantIndex = extractVariantIndex(card.id, card.pageId);
      if (variantIndex == null) continue;
      const images = currentImageMap.get(card.pageId);
      if (!images || images.length === 0) {
        unresolvedImageCards += 1;
        continue;
      }
      if (variantIndex > images.length) {
        unresolvedImageCards += 1;
        continue;
      }
      const expected = images[variantIndex - 1]!;
      if (
        normalizeImageUrl(card.imageUrl) !== normalizeImageUrl(expected.imageUrl)
        || normalizeVariantKey(card.variantKey) !== normalizeVariantKey(expected.variantKey)
      ) {
        updates.push({
          id: card.id,
          imageUrl: expected.imageUrl,
          variantKey: expected.variantKey
        });
      }
    }

    plannedUpdates = updates.length;

    if (!options.dryRun && updates.length > 0) {
      await userDbClient.query('BEGIN');
      for (const chunk of chunkRows(updates, options.updateChunkSize)) {
        if (chunk.length === 0) continue;
        const values = buildValuesClause(chunk, (row) => [row.id, row.imageUrl, row.variantKey]);
        const result = await userDbClient.query<{ id: string }>(
          `
            UPDATE "GachaCardDefinition" g
            SET
              "imageUrl" = (v."imageUrl")::text,
              "variantKey" = (v."variantKey")::text,
              "updatedAt" = timezone('UTC', now())
            FROM (VALUES ${values.clause}) AS v("id", "imageUrl", "variantKey")
            WHERE g."id" = (v."id")::text
              AND g."poolId" = $${values.params.length + 1}
              AND (
                g."imageUrl" IS DISTINCT FROM (v."imageUrl")::text
                OR g."variantKey" IS DISTINCT FROM (v."variantKey")::text
              )
            RETURNING g."id" AS "id"
          `,
          [...values.params, PERMANENT_POOL_ID] as unknown[]
        );
        appliedUpdates += result.rows.length;
      }
      await userDbClient.query('COMMIT');
    }

    console.log('[gacha-repair-card-image-mapping] Completed.');
    console.log('[gacha-repair-card-image-mapping] poolId =', PERMANENT_POOL_ID);
    console.log('[gacha-repair-card-image-mapping] routePrefix =', PAGE_IMAGE_ROUTE_PREFIX);
    console.log('[gacha-repair-card-image-mapping] totalCards =', totalCards);
    console.log('[gacha-repair-card-image-mapping] recognizedCards =', recognizedCards);
    console.log('[gacha-repair-card-image-mapping] unresolvedVersionCards =', unresolvedVersionCards);
    console.log('[gacha-repair-card-image-mapping] unresolvedImageCards =', unresolvedImageCards);
    console.log('[gacha-repair-card-image-mapping] plannedUpdates =', plannedUpdates);
    if (options.dryRun) {
      console.log('[gacha-repair-card-image-mapping] dryRun = true (no database writes).');
    } else {
      console.log('[gacha-repair-card-image-mapping] appliedUpdates =', appliedUpdates);
    }

    return {
      dryRun: options.dryRun,
      poolId: PERMANENT_POOL_ID,
      routePrefix: PAGE_IMAGE_ROUTE_PREFIX,
      totalCards,
      recognizedCards,
      unresolvedVersionCards,
      unresolvedImageCards,
      plannedUpdates,
      appliedUpdates
    };
  } catch (error) {
    if (!options.dryRun) {
      await userDbClient.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    userDbClient.release();
    await userDbPool.end();
    await disconnectPrisma();
  }
}
