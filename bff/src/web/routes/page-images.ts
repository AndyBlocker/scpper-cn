import { Router } from 'express';
import type { Pool } from 'pg';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { PAGE_IMAGE_ROOT, buildPageImagePath } from '../pageImagesConfig.js';

const normalizedRoot = PAGE_IMAGE_ROOT.endsWith(path.sep)
  ? PAGE_IMAGE_ROOT
  : `${PAGE_IMAGE_ROOT}${path.sep}`;

const IMAGE_STREAM_CACHE_HEADER = 'public, max-age=86400, immutable';
const LOW_VARIANT_NAME = 'low';
const VARIANT_EXTENSION = 'webp';

const buildVariantPath = (storagePath: string, variantName: string): string => {
  const parsed = path.parse(storagePath);
  const fileName = `${parsed.name}-${variantName}.${VARIANT_EXTENSION}`;
  return path.join(parsed.dir, fileName);
};

export function pageImagesRouter(pool: Pool) {
  const router = Router();

  router.get('/random', async (req, res, next) => {
    try {
      const rawLimit = Number.parseInt(String(req.query.limit ?? '20'), 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 20;

      const sql = `
        SELECT 
          pvi.id                 AS "pageVersionImageId",
          pvi."pageVersionId"    AS "pageVersionId",
          pvi."displayUrl"       AS "displayUrl",
          pvi."originUrl"        AS "originUrl",
          pvi."normalizedUrl"    AS "normalizedUrl",
          ia.id                   AS "assetId",
          ia."mimeType"          AS "mimeType",
          ia.width                AS width,
          ia.height               AS height,
          ia.bytes                AS bytes,
          ia."canonicalUrl"      AS "canonicalUrl",
          pv."wikidotId"         AS "wikidotId",
          pv.title                AS title,
          pv."alternateTitle"    AS "alternateTitle",
          p."currentUrl"         AS url
        FROM "PageVersionImage" pvi
        JOIN "ImageAsset" ia ON ia.id = pvi."imageAssetId"
        JOIN "PageVersion" pv ON pv.id = pvi."pageVersionId"
        JOIN "Page" p ON p.id = pv."pageId"
        WHERE pvi.status = 'RESOLVED'
          AND pvi."imageAssetId" IS NOT NULL
          AND ia."storagePath" IS NOT NULL
          AND ia."status" = 'READY'
        ORDER BY random()
        LIMIT $1::int
      `;

      const { rows } = await pool.query(sql, [limit]);
      const payload = rows.map((row) => ({
        pageVersionImageId: row.pageVersionImageId,
        pageVersionId: row.pageVersionId,
        displayUrl: row.displayUrl,
        originUrl: row.originUrl,
        normalizedUrl: row.normalizedUrl,
        imageUrl: buildPageImagePath(row.assetId),
        asset: {
          assetId: row.assetId,
          mimeType: row.mimeType,
          width: row.width,
          height: row.height,
          bytes: row.bytes,
          canonicalUrl: row.canonicalUrl
        },
        page: {
          wikidotId: row.wikidotId,
          title: row.title,
          alternateTitle: row.alternateTitle,
          url: row.url
        }
      }));

      res.json(payload);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:assetId', async (req, res, next) => {
    try {
      const assetId = Number.parseInt(String(req.params.assetId ?? ''), 10);
      if (!Number.isInteger(assetId) || assetId <= 0) {
        return res.status(400).json({ error: 'invalid_asset_id' });
      }

      const sql = `
        SELECT 
          id,
          "mimeType",
          bytes,
          "storagePath",
          "canonicalUrl",
          width,
          height,
          "updatedAt"
        FROM "ImageAsset"
        WHERE id = $1::int AND "status" = 'READY'
        LIMIT 1
      `;

      const { rows } = await pool.query(sql, [assetId]);
      if (rows.length === 0) {
        return res.status(404).json({ error: 'not_found' });
      }

      const asset = rows[0];
      const requestedVariant = String(req.query.variant ?? '').trim().toLowerCase();
      if (!asset.storagePath) {
        return res.status(404).json({ error: 'not_found' });
      }

      const isWithinRoot = (candidate: string) => candidate === PAGE_IMAGE_ROOT || candidate.startsWith(normalizedRoot);
      let relativePath: string = asset.storagePath;
      let absolutePath: string | null = null;
      let stats;

      if (requestedVariant === LOW_VARIANT_NAME) {
        const variantRelativePath = buildVariantPath(asset.storagePath, LOW_VARIANT_NAME);
        const variantAbsolutePath = path.resolve(PAGE_IMAGE_ROOT, variantRelativePath);
        if (isWithinRoot(variantAbsolutePath)) {
          try {
            stats = await fs.stat(variantAbsolutePath);
            relativePath = variantRelativePath;
            absolutePath = variantAbsolutePath;
          } catch {
            // fall back to the original asset below
          }
        }
      }

      if (!absolutePath) {
        const candidateAbsolute = path.resolve(PAGE_IMAGE_ROOT, asset.storagePath);
        if (!isWithinRoot(candidateAbsolute)) {
          return res.status(400).json({ error: 'invalid_storage_path' });
        }
        try {
          stats = await fs.stat(candidateAbsolute);
          absolutePath = candidateAbsolute;
        } catch {
          return res.status(404).json({ error: 'not_found' });
        }
      }

      if (!absolutePath) {
        return res.status(500).json({ error: 'invalid_storage_path' });
      }

      const responseMime = relativePath === asset.storagePath
        ? (asset.mimeType || 'application/octet-stream')
        : `image/${VARIANT_EXTENSION}`;

      if (!stats) {
        return res.status(404).json({ error: 'not_found' });
      }

      res.setHeader('Content-Type', responseMime);
      if (stats?.size) {
        res.setHeader('Content-Length', String(stats.size));
      }
      res.setHeader('Cache-Control', IMAGE_STREAM_CACHE_HEADER);
      res.setHeader('Last-Modified', stats.mtime.toUTCString());

      const stream = createReadStream(absolutePath);
      stream.on('error', (error) => {
        next(error);
      });
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
