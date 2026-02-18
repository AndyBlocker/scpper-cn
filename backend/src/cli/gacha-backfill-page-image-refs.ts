import { Pool } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { getPrismaClient, disconnectPrisma } from '../utils/db-connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load backend env first (handled in getPrismaClient), then user-backend env as fallback
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: false });
dotenv.config({ path: path.resolve(__dirname, '../../../user-backend/.env'), override: false });

const DEFAULT_PAGE_IMAGE_ROUTE_PREFIX = '/page-images';
const DEFAULT_SCAN_BATCH_SIZE = 2000;
const DEFAULT_UPDATE_CHUNK_SIZE = 500;

type PgValue = string | number | null;

interface BackfillOptions {
  dryRun?: boolean;
  scanBatchSize?: number;
  updateChunkSize?: number;
}

interface PageImageRow {
  id: number;
  pageId: number;
  imageAssetId: number | null;
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

function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

export async function backfillGachaPageImageRefs(rawOptions: BackfillOptions = {}) {
  const prisma = getPrismaClient();
  const userDatabaseUrl = process.env.USER_DATABASE_URL ?? process.env.USER_BACKEND_DATABASE_URL;
  if (!userDatabaseUrl) {
    throw new Error('缺少 USER_DATABASE_URL（或 USER_BACKEND_DATABASE_URL）环境变量，无法连接用户数据库。');
  }

  const options: Required<BackfillOptions> = {
    dryRun: Boolean(rawOptions.dryRun),
    scanBatchSize: Math.max(100, Math.floor(rawOptions.scanBatchSize ?? DEFAULT_SCAN_BATCH_SIZE)),
    updateChunkSize: Math.max(50, Math.floor(rawOptions.updateChunkSize ?? DEFAULT_UPDATE_CHUNK_SIZE))
  };

  const userDbPool = new Pool({ connectionString: userDatabaseUrl });
  const userDbClient = await userDbPool.connect();

  let scannedRows = 0;
  let mappedPages = 0;
  let updateAttempts = 0;
  let updatedCards = 0;
  let lastId = 0;

  try {
    while (true) {
      const rows = await prisma.$queryRaw<PageImageRow[]>`
        SELECT
          pv.id,
          pv."pageId",
          (
            SELECT img."imageAssetId"
            FROM "PageVersionImage" img
            WHERE img."pageVersionId" = pv.id
              AND img.status = 'RESOLVED'
              AND img."imageAssetId" IS NOT NULL
            ORDER BY img.id
            LIMIT 1
          ) AS "imageAssetId"
        FROM "PageVersion" pv
        JOIN "Page" p ON p.id = pv."pageId"
        WHERE pv."validTo" IS NULL
          AND pv."isDeleted" = false
          AND p."isDeleted" = false
          AND pv.id > ${lastId}
        ORDER BY pv.id
        LIMIT ${options.scanBatchSize}
      `;

      if (rows.length === 0) break;
      lastId = rows[rows.length - 1]!.id;
      scannedRows += rows.length;

      const dedup = new Map<number, string>();
      for (const row of rows) {
        const imageUrl = buildPageImagePath(row.imageAssetId);
        if (!imageUrl) continue;
        dedup.set(row.pageId, imageUrl);
      }
      const updateRows = Array.from(dedup.entries()).map(([pageId, imageUrl]) => ({ pageId, imageUrl }));
      mappedPages += updateRows.length;

      if (options.dryRun || updateRows.length === 0) {
        continue;
      }

      for (const chunk of chunkRows(updateRows, options.updateChunkSize)) {
        if (chunk.length === 0) continue;
        updateAttempts += chunk.length;
        const values = buildValuesClause(chunk, (row) => [row.pageId, row.imageUrl]);
        const result = await userDbClient.query(
          `
            UPDATE "GachaCardDefinition" g
            SET
              "imageUrl" = (v."imageUrl")::text,
              "updatedAt" = timezone('UTC', now())
            FROM (VALUES ${values.clause}) AS v("pageId", "imageUrl")
            WHERE g."pageId" = (v."pageId")::int
              AND g."pageId" IS NOT NULL
              AND (g."imageUrl" IS DISTINCT FROM (v."imageUrl")::text)
          `,
          values.params as unknown[]
        );
        updatedCards += result.rowCount ?? 0;
      }
    }
  } finally {
    userDbClient.release();
    await userDbPool.end();
    await disconnectPrisma();
  }

  console.log('[gacha-backfill-image-refs] Completed.');
  console.log('[gacha-backfill-image-refs] routePrefix =', PAGE_IMAGE_ROUTE_PREFIX);
  console.log('[gacha-backfill-image-refs] scannedRows =', scannedRows);
  console.log('[gacha-backfill-image-refs] mappedPages =', mappedPages);
  if (options.dryRun) {
    console.log('[gacha-backfill-image-refs] dryRun = true (no database writes).');
  } else {
    console.log('[gacha-backfill-image-refs] updateAttempts =', updateAttempts);
    console.log('[gacha-backfill-image-refs] updatedCards =', updatedCards);
  }

  return {
    dryRun: options.dryRun,
    routePrefix: PAGE_IMAGE_ROUTE_PREFIX,
    scannedRows,
    mappedPages,
    updateAttempts,
    updatedCards
  };
}
