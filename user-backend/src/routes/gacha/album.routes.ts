import type { Router } from 'express';
import { Prisma, GachaRarity } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../../db.js';
import * as h from './_helpers.js';

export function registerAlbumRoutes(router: Router) {
  router.get('/album/summary', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      // Single query: user instance stats + pool card count in one DB round-trip
      const rows = await prisma.$queryRaw<Array<{
        totalPages: number | string | null;
        totalImageVariants: number | string | null;
        totalOwnedCount: number | string | null;
        coatingStyles: number | string | null;
        totalImageVariantsInPool: number | string | null;
        totalPagesInPool: number | string | null;
      }>>(Prisma.sql`
        WITH instance_rows AS (
          SELECT
            c."pageId" AS "pageId",
            c."imageUrl" AS "imageUrl",
            ci."cardId" AS "cardId",
            ci."affixVisualStyle" AS "affixVisualStyle"
          FROM "GachaCardInstance" ci
          JOIN "GachaCardDefinition" c ON c.id = ci."cardId"
          WHERE ci."userId" = ${req.authUser.id}
            AND ci."tradeListingId" IS NULL
        ),
        pool_total AS (
          SELECT
            COUNT(
              DISTINCT CASE
                WHEN "pageId" IS NOT NULL
                  THEN ("pageId")::text || '|' || COALESCE(NULLIF(BTRIM("imageUrl"), ''), '__NOIMG__')
                ELSE id
              END
            )::int AS total,
            COUNT(DISTINCT "pageId")::int AS "totalPages"
          FROM "GachaCardDefinition"
          WHERE "poolId" = ${h.PERMANENT_POOL_ID}
        )
        SELECT
          COUNT(DISTINCT "pageId") FILTER (WHERE "pageId" IS NOT NULL)::int AS "totalPages",
          COUNT(
            DISTINCT CASE
              WHEN "pageId" IS NOT NULL
                THEN ("pageId")::text || '|' || COALESCE(NULLIF(BTRIM("imageUrl"), ''), '__NOIMG__')
              ELSE "cardId"
            END
          )::int AS "totalImageVariants",
          COUNT(*)::int AS "totalOwnedCount",
          COUNT(DISTINCT "affixVisualStyle") FILTER (WHERE "affixVisualStyle" != 'NONE')::int AS "coatingStyles",
          (SELECT total FROM pool_total)::int AS "totalImageVariantsInPool",
          (SELECT "totalPages" FROM pool_total)::int AS "totalPagesInPool"
        FROM instance_rows
      `);
      const row = rows[0];
      res.json({
        ok: true,
        summary: {
          totalPages: Math.max(0, h.toSafeInt(row?.totalPages, 0)),
          totalImageVariants: Math.max(0, h.toSafeInt(row?.totalImageVariants, 0)),
          totalImageVariantsInPool: Math.max(0, h.toSafeInt(row?.totalImageVariantsInPool, 0)),
          totalPagesInPool: Math.max(0, h.toSafeInt(row?.totalPagesInPool, 0)),
          coatingStyles: Math.max(0, h.toSafeInt(row?.coatingStyles, 0)),
          totalOwnedCount: Math.max(0, h.toSafeInt(row?.totalOwnedCount, 0))
        }
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/album/pages', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const parsed = h.albumPagesQuerySchema.parse(req.query ?? {});
      const limit = Math.min(Math.max(Number(parsed.limit ?? '80'), 1), h.ALBUM_PAGE_QUERY_LIMIT_MAX);
      const offset = Math.max(Number(parsed.offset ?? '0'), 0);
      const search = parsed.search?.trim() ?? '';
      const userId = req.authUser.id;

      // Build search condition — match title, tags, or author
      let searchCondition: Prisma.Sql;
      if (search) {
        const searchLower = search.toLowerCase();
        const authorCardIds = await h.findCardIdsByAuthorKeyword(search);
        const orClauses: Prisma.Sql[] = [
          Prisma.sql`LOWER(pb."title") LIKE '%' || LOWER(${search}) || '%'`,
          Prisma.sql`EXISTS (
            SELECT 1 FROM "GachaCardDefinition" cd
            CROSS JOIN LATERAL unnest(cd."tags") AS t(tag)
            WHERE cd."pageId" = pb."pageId" AND LOWER(t.tag) = ${searchLower}
          )`
        ];
        if (authorCardIds.length > 0) {
          orClauses.push(Prisma.sql`EXISTS (
            SELECT 1 FROM "GachaCardDefinition" cd
            WHERE cd."pageId" = pb."pageId" AND cd.id IN (${Prisma.join(authorCardIds)})
          )`);
        }
        searchCondition = Prisma.sql`AND (${Prisma.join(orClauses, ' OR ')})`;
      } else {
        searchCondition = Prisma.empty;
      }

      type AlbumPageRow = {
        pageId: number | string;
        wikidotId: number | string | null;
        title: string | null;
        highestRarityRank: number | string;
        coverImageUrl: string | null;
        totalCount: number | string | null;
        variantCount: number | string | null;
        imageVariantCount: number | string | null;
        coatingCount: number | string | null;
      };

      // Optimized: split into data query + count query (parallel), no COUNT(*) OVER()
      // Also removed page_tags CTE from main query — tags are fetched post-pagination
      const baseCTE = Prisma.sql`
        WITH page_base AS (
          SELECT
            c."pageId" AS "pageId",
            MIN(c."wikidotId") FILTER (WHERE c."wikidotId" IS NOT NULL) AS "wikidotId",
            MIN(c."title") AS "title",
            MIN(
              CASE c."rarity"
                WHEN 'GOLD' THEN 0
                WHEN 'PURPLE' THEN 1
                WHEN 'BLUE' THEN 2
                WHEN 'GREEN' THEN 3
                ELSE 4
              END
            ) AS "highestRarityRank",
            MAX(c."imageUrl") FILTER (WHERE c."imageUrl" IS NOT NULL) AS "coverImageUrl",
            COUNT(*)::int AS "totalCount",
            COUNT(DISTINCT ci."affixSignature")::int AS "variantCount",
            COUNT(DISTINCT COALESCE(NULLIF(BTRIM(c."imageUrl"), ''), '__NOIMG__'))::int AS "imageVariantCount",
            COUNT(DISTINCT ci."affixVisualStyle") FILTER (WHERE ci."affixVisualStyle" != 'NONE')::int AS "coatingCount"
          FROM "GachaCardInstance" ci
          JOIN "GachaCardDefinition" c ON c.id = ci."cardId"
          WHERE ci."userId" = ${userId}
            AND ci."tradeListingId" IS NULL
            AND c."pageId" IS NOT NULL
          GROUP BY c."pageId"
        )
      `;

      const [rows, totalResult, poolTotals] = await Promise.all([
        prisma.$queryRaw<AlbumPageRow[]>(Prisma.sql`
          ${baseCTE}
          SELECT
            pb."pageId",
            pb."wikidotId",
            pb."title",
            pb."highestRarityRank",
            pb."coverImageUrl",
            pb."totalCount",
            pb."variantCount",
            pb."imageVariantCount",
            pb."coatingCount"
          FROM page_base pb
          WHERE TRUE ${searchCondition}
          ORDER BY pb."totalCount" DESC, pb."variantCount" DESC, pb."highestRarityRank" ASC, pb."pageId" ASC
          OFFSET ${offset}
          LIMIT ${limit}
        `),
        prisma.$queryRaw<[{ count: number | string }]>(Prisma.sql`
          ${baseCTE}
          SELECT COUNT(*)::int AS count
          FROM page_base pb
          WHERE TRUE ${searchCondition}
        `),
        // Pool image variant totals — only for the paged results (joined after)
        prisma.$queryRaw<Array<{ pageId: number | string; total: number | string }>>(Prisma.sql`
          SELECT "pageId", COUNT(DISTINCT COALESCE(NULLIF(BTRIM("imageUrl"), ''), '__NOIMG__'))::int AS total
          FROM "GachaCardDefinition"
          WHERE "poolId" = ${h.PERMANENT_POOL_ID} AND "pageId" IS NOT NULL
          GROUP BY "pageId"
        `)
      ]);

      const total = Math.max(0, Number(totalResult[0]?.count ?? 0));
      const poolTotalMap = new Map(poolTotals.map(r => [Number(r.pageId), Number(r.total)]));

      // Post-pagination: fetch tags only for returned page IDs
      const pageIds = rows.map(r => Number(r.pageId));
      let tagsByPage = new Map<number, string[]>();
      if (pageIds.length > 0) {
        const tagRows = await prisma.$queryRaw<Array<{ pageId: number | string; tags: string[] }>>(Prisma.sql`
          SELECT c."pageId"::int AS "pageId",
            ARRAY(
              SELECT DISTINCT NULLIF(BTRIM(t.tag), '')
              FROM "GachaCardDefinition" c2
              CROSS JOIN LATERAL unnest(c2."tags") AS t(tag)
              WHERE c2."pageId" = c."pageId" AND NULLIF(BTRIM(t.tag), '') IS NOT NULL
              ORDER BY 1
              LIMIT 8
            ) AS tags
          FROM "GachaCardDefinition" c
          WHERE c."pageId" = ANY(${pageIds}::int[])
          GROUP BY c."pageId"
        `);
        tagsByPage = new Map(tagRows.map(r => [Number(r.pageId), r.tags ?? []]));
      }

      const items = rows.map((row) => {
        const rarityRank = Number(row.highestRarityRank ?? 4);
        const highestRarity = (['GOLD', 'PURPLE', 'BLUE', 'GREEN', 'WHITE'] as const)[rarityRank] ?? 'WHITE';
        const pid = Number(row.pageId);
        return {
          pageId: Math.max(1, h.toSafeInt(row.pageId, 1)),
          wikidotId: row.wikidotId == null ? null : h.toSafeInt(row.wikidotId, 0),
          title: String(row.title || ''),
          highestRarity,
          coverImageUrl: row.coverImageUrl ? String(row.coverImageUrl) : null,
          totalCount: Math.max(0, h.toSafeInt(row.totalCount, 0)),
          variantCount: Math.max(0, h.toSafeInt(row.variantCount, 0)),
          imageVariantCount: Math.max(0, h.toSafeInt(row.imageVariantCount, 0)),
          imageVariantTotal: poolTotalMap.get(pid) ?? 0,
          coatingCount: Math.max(0, h.toSafeInt(row.coatingCount, 0)),
          tags: (tagsByPage.get(pid) ?? [])
            .map((tag) => String(tag || '').trim())
            .filter((tag) => tag.length > 0)
            .slice(0, 8)
        };
      });
      res.json({
        ok: true,
        items,
        total
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });

  router.get('/album/pages/:pageId/variants', async (req, res, next) => {
    try {
      if (!req.authUser) return res.status(401).json({ error: '未登录' });
      const params = h.albumVariantsParamSchema.parse(req.params ?? {});
      const pageId = params.pageId;
      const userId = req.authUser.id;

      // Single query: JOIN cards + instances, GROUP BY cardId + affixSignature
      type VariantRow = {
        cardId: string;
        title: string;
        rarity: string;
        tags: string[] | null;
        authorKeys: string[] | null;
        imageUrl: string | null;
        wikidotId: number | string | null;
        rowPageId: number | string | null;
        poolId: string;
        weight: number | null;
        affixSignature: string;
        cnt: number | string;
      };
      const variantRows = await prisma.$queryRaw<VariantRow[]>(Prisma.sql`
        SELECT
          c.id AS "cardId",
          c.title,
          c.rarity::text AS rarity,
          c.tags,
          c."authorKeys",
          c."imageUrl",
          c."wikidotId",
          c."pageId" AS "rowPageId",
          c."poolId",
          c.weight,
          ci."affixSignature",
          COUNT(*)::int AS cnt
        FROM "GachaCardInstance" ci
        JOIN "GachaCardDefinition" c ON c.id = ci."cardId"
        WHERE ci."userId" = ${userId}
          AND ci."tradeListingId" IS NULL
          AND c."pageId" = ${pageId}
        GROUP BY c.id, c.title, c.rarity, c.tags, c."authorKeys", c."imageUrl", c."wikidotId", c."pageId", c."poolId", c.weight, ci."affixSignature"
      `);

      if (variantRows.length === 0) {
        res.status(404).json({ error: '未找到该页面的已拥有变体' });
        return;
      }

      const variants = variantRows
        .map((row) => {
          const card = { id: row.cardId, title: row.title, rarity: row.rarity as GachaRarity, tags: row.tags ?? [] };
          const normalizedSignature = h.affixSignatureFromStyles(h.parseAffixSignature(
            row.affixSignature || 'NONE'
          ));
          const affix = h.resolveCardAffixWithBonus(card, {
            affixSignature: normalizedSignature
          });
          const imgMatch = row.cardId.match(/-img-(\d+)$/);
          const imageIndex = imgMatch ? parseInt(imgMatch[1], 10) - 1 : 0;
          const isAlternateArt = imageIndex > 0;
          return {
            cardId: row.cardId,
            title: row.title,
            rarity: row.rarity as GachaRarity,
            count: Number(row.cnt),
            tags: row.tags ?? [],
            authors: h.resolveCardAuthorsFromTags(row.tags ?? [], row.authorKeys ?? []),
            imageUrl: row.imageUrl ?? null,
            wikidotId: row.wikidotId != null ? Number(row.wikidotId) : null,
            pageId: row.rowPageId != null ? Number(row.rowPageId) : null,
            rewardTokens: h.DEFAULT_DISMANTLE_REWARD_BY_RARITY[row.rarity as GachaRarity] ?? 0,
            affixSignature: affix.affixSignature,
            affixStyles: affix.affixStyles,
            affixStyleCounts: affix.affixStyleCounts,
            affixVisualStyle: affix.affixVisualStyle,
            affixLabel: affix.affixLabel,
            affixYieldBoostPercent: affix.affixYieldBoostPercent,
            affixOfflineBufferBonus: affix.affixOfflineBufferBonus,
            affixDismantleBonusPercent: affix.affixDismantleBonusPercent,
            isRetired: h.isRetiredCard({ poolId: row.poolId, weight: row.weight }),
            isAlternateArt,
            imageIndex
          };
        })
        .sort((a, b) => {
          const rarityDiff = h.rarityWeight[a.rarity] - h.rarityWeight[b.rarity];
          if (rarityDiff !== 0) return rarityDiff;
          if (a.count !== b.count) return b.count - a.count;
          return a.title.localeCompare(b.title, 'zh-CN');
        });

      const primary = variants[0];
      const page = {
        pageId,
        wikidotId: primary?.wikidotId ?? null,
        title: primary?.title ?? `页面 ${pageId}`,
        totalCount: variants.reduce((sum, variant) => sum + variant.count, 0),
        variantCount: variants.length,
        coverImageUrl: variants.find((variant) => variant.imageUrl)?.imageUrl ?? null
      };

      res.json({
        ok: true,
        page,
        variants
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({ error: error.issues[0]?.message ?? '参数错误' });
        return;
      }
      next(error);
    }
  });
}
