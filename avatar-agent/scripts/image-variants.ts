import { randomUUID } from 'node:crypto';
import path from 'node:path';
import fs from 'fs-extra';
import { Pool } from 'pg';
import sharp from 'sharp';

import { cfg } from '../src/config.js';
import { log } from '../src/logger.js';

const VARIANT_NAME = 'low';
const VARIANT_EXTENSION = 'webp';
const UNSUPPORTED_TYPES = new Set(['image/gif', 'image/svg+xml']);

type AssetRow = {
  id: number;
  storagePath: string;
  mimeType: string | null;
};

function buildVariantPath(storagePath: string): string {
  const parsed = path.parse(storagePath);
  const fileName = `${parsed.name}-${VARIANT_NAME}.${VARIANT_EXTENSION}`;
  return path.join(parsed.dir, fileName);
}

async function generateVariant(row: AssetRow, root: string): Promise<'created' | 'skipped'> {
  const sourceAbs = path.resolve(root, row.storagePath);
  if (!(await fs.pathExists(sourceAbs))) {
    log.warn({ id: row.id, path: row.storagePath }, 'source image missing, skip variant');
    return 'skipped';
  }

  const targetRel = buildVariantPath(row.storagePath);
  const targetAbs = path.resolve(root, targetRel);
  if (await fs.pathExists(targetAbs)) return 'skipped';

  const mime = (row.mimeType || '').toLowerCase();
  if (UNSUPPORTED_TYPES.has(mime)) return 'skipped';

  let width: number | null = null;
  try {
    const meta = await sharp(sourceAbs, { failOn: 'none' }).metadata();
    width = Number.isFinite(meta.width) ? Number(meta.width) : null;
  } catch (err) {
    log.warn({ id: row.id, err }, 'failed to read source metadata, fallback to generating');
  }
  if (width != null && width <= cfg.imageCache.variantMaxWidth) {
    return 'skipped';
  }

  await fs.ensureDir(path.dirname(targetAbs));
  const temp = `${targetAbs}.tmp-${randomUUID()}`;
  try {
    await sharp(sourceAbs, { failOn: 'none' })
      .resize({ width: cfg.imageCache.variantMaxWidth, withoutEnlargement: true, fit: 'inside' })
      .toFormat(VARIANT_EXTENSION, { quality: cfg.imageCache.variantQuality })
      .toFile(temp);
    await fs.move(temp, targetAbs, { overwrite: true });
    return 'created';
  } catch (err) {
    await fs.remove(temp).catch(() => {});
    log.warn({ id: row.id, err }, 'failed to generate variant');
    return 'skipped';
  }
}

async function main() {
  if (!cfg.imageCache.databaseUrl) {
    throw new Error('PAGE_IMAGE_DATABASE_URL not configured');
  }
  await fs.ensureDir(cfg.imageCache.assetRoot);

  const pool = new Pool({ connectionString: cfg.imageCache.databaseUrl });
  const query = `
    SELECT id, "storagePath", "mimeType"
      FROM "ImageAsset"
     WHERE status = 'READY'
       AND "storagePath" IS NOT NULL
       AND "storagePath" <> ''
  `;

  const { rows } = await pool.query<AssetRow>(query);
  log.info({ count: rows.length, root: cfg.imageCache.assetRoot }, 'starting variant generation');

  let created = 0;
  let skipped = 0;
  for (const row of rows) {
    const result = await generateVariant(row, cfg.imageCache.assetRoot);
    if (result === 'created') created += 1;
    else skipped += 1;
  }

  await pool.end();
  log.info({ created, skipped, total: rows.length }, 'variant generation completed');
  // eslint-disable-next-line no-console
  console.log(`Variants created: ${created}, skipped: ${skipped}, total: ${rows.length}`);
}

main().catch(err => {
  log.error({ err }, 'variant generation failed');
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});
