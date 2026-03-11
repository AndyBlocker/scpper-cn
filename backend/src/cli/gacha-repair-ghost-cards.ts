import { Pool, type PoolClient } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: false });
dotenv.config({ path: path.resolve(__dirname, '../../../user-backend/.env'), override: false });

const PERMANENT_POOL_ID = 'permanent-main-pool';

interface RepairOptions {
  dryRun?: boolean;
}

interface CardRow {
  id: string;
  poolId: string;
  pageId: number;
  title: string;
  weight: number;
  imageUrl: string | null;
  variantKey: string | null;
  createdAt: Date;
}

interface InventoryRow {
  id: string;
  userId: string;
  count: number;
  affixStacks: unknown;
}

interface UnlockRow {
  id: string;
  userId: string;
  firstUnlockedAt: Date;
  updatedAt: Date;
}

interface Mapping {
  sourceId: string;
  targetId: string;
  pageId: number;
  title: string;
}

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0 || items.length <= chunkSize) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
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

function compareVariantRows(a: CardRow, b: CardRow, pageId: number) {
  const idxA = extractVariantIndex(a.id, pageId);
  const idxB = extractVariantIndex(b.id, pageId);
  if (idxA != null && idxB != null && idxA !== idxB) return idxA - idxB;
  if (idxA != null && idxB == null) return -1;
  if (idxA == null && idxB != null) return 1;
  const createdDelta = a.createdAt.getTime() - b.createdAt.getTime();
  if (createdDelta !== 0) return createdDelta;
  return a.id.localeCompare(b.id);
}

function chooseTargetCard(source: CardRow, activeCards: CardRow[]) {
  const sorted = [...activeCards].sort((a, b) => compareVariantRows(a, b, source.pageId));
  if (sorted.length === 0) return null;
  const variantIndex = extractVariantIndex(source.id, source.pageId);
  if (variantIndex != null) {
    const clampedIndex = Math.max(1, Math.min(variantIndex, sorted.length));
    return sorted[clampedIndex - 1] ?? sorted[sorted.length - 1] ?? null;
  }
  return sorted[sorted.length - 1] ?? null;
}

function normalizeAffixStacks(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {} as Record<string, number>;
  const output: Record<string, number> = {};
  for (const [key, valueRaw] of Object.entries(raw as Record<string, unknown>)) {
    const value = Math.max(0, Math.floor(Number(valueRaw) || 0));
    if (value > 0) {
      output[key] = value;
    }
  }
  return output;
}

function mergeAffixStacks(a: unknown, b: unknown) {
  const left = normalizeAffixStacks(a);
  const right = normalizeAffixStacks(b);
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    merged[key] = (merged[key] ?? 0) + value;
  }
  return merged;
}

async function mergeInventories(client: PoolClient, sourceId: string, targetId: string) {
  const sourceRows = await client.query<InventoryRow>(
    `
      SELECT id, "userId", count, "affixStacks"
      FROM "GachaInventory"
      WHERE "cardId" = $1
      ORDER BY "userId" ASC
    `,
    [sourceId]
  );
  if ((sourceRows.rowCount ?? 0) <= 0) return;

  const targetRows = await client.query<InventoryRow>(
    `
      SELECT id, "userId", count, "affixStacks"
      FROM "GachaInventory"
      WHERE "cardId" = $1
        AND "userId" = ANY($2::text[])
    `,
    [targetId, sourceRows.rows.map((row) => row.userId)]
  );
  const targetByUser = new Map(targetRows.rows.map((row) => [row.userId, row]));

  for (const source of sourceRows.rows) {
    const target = targetByUser.get(source.userId);
    if (target) {
      await client.query(
        `
          UPDATE "GachaInventory"
          SET
            count = $1,
            "affixStacks" = $2::jsonb,
            "updatedAt" = timezone('UTC', now())
          WHERE id = $3
        `,
        [
          target.count + source.count,
          JSON.stringify(mergeAffixStacks(target.affixStacks, source.affixStacks)),
          target.id
        ]
      );
      await client.query(
        `
          UPDATE "GachaPlacementSlot"
          SET
            "inventoryId" = $1,
            "cardId" = $2,
            "updatedAt" = timezone('UTC', now())
          WHERE "inventoryId" = $3
        `,
        [target.id, targetId, source.id]
      );
      await client.query('DELETE FROM "GachaInventory" WHERE id = $1', [source.id]);
      continue;
    }

    await client.query(
      `
        UPDATE "GachaInventory"
        SET
          "cardId" = $1,
          "updatedAt" = timezone('UTC', now())
        WHERE id = $2
      `,
      [targetId, source.id]
    );
    await client.query(
      `
        UPDATE "GachaPlacementSlot"
        SET
          "cardId" = $1,
          "updatedAt" = timezone('UTC', now())
        WHERE "inventoryId" = $2
      `,
      [targetId, source.id]
    );
  }
}

async function mergeUnlocks(client: PoolClient, sourceId: string, targetId: string) {
  const sourceRows = await client.query<UnlockRow>(
    `
      SELECT id, "userId", "firstUnlockedAt", "updatedAt"
      FROM "GachaCardUnlock"
      WHERE "cardId" = $1
      ORDER BY "userId" ASC
    `,
    [sourceId]
  );
  if ((sourceRows.rowCount ?? 0) <= 0) return;

  const targetRows = await client.query<UnlockRow>(
    `
      SELECT id, "userId", "firstUnlockedAt", "updatedAt"
      FROM "GachaCardUnlock"
      WHERE "cardId" = $1
        AND "userId" = ANY($2::text[])
    `,
    [targetId, sourceRows.rows.map((row) => row.userId)]
  );
  const targetByUser = new Map(targetRows.rows.map((row) => [row.userId, row]));

  for (const source of sourceRows.rows) {
    const target = targetByUser.get(source.userId);
    if (target) {
      const firstUnlockedAt = source.firstUnlockedAt < target.firstUnlockedAt ? source.firstUnlockedAt : target.firstUnlockedAt;
      const updatedAt = source.updatedAt > target.updatedAt ? source.updatedAt : target.updatedAt;
      await client.query(
        `
          UPDATE "GachaCardUnlock"
          SET
            "firstUnlockedAt" = $1,
            "updatedAt" = $2
          WHERE id = $3
        `,
        [firstUnlockedAt, updatedAt, target.id]
      );
      await client.query('DELETE FROM "GachaCardUnlock" WHERE id = $1', [source.id]);
      continue;
    }

    await client.query(
      `
        UPDATE "GachaCardUnlock"
        SET
          "cardId" = $1,
          "updatedAt" = timezone('UTC', now())
        WHERE id = $2
      `,
      [targetId, source.id]
    );
  }
}

async function updateDirectCardReferences(
  client: PoolClient,
  tableName: string,
  columnName: string,
  mappings: Mapping[]
) {
  if (mappings.length === 0) return;
  for (const chunk of chunkArray(mappings, 200)) {
    const values: string[] = [];
    const params: string[] = [];
    let index = 1;
    for (const mapping of chunk) {
      values.push(`($${index}, $${index + 1})`);
      params.push(mapping.sourceId, mapping.targetId);
      index += 2;
    }
    await client.query(
      `
        UPDATE "${tableName}" AS t
        SET "${columnName}" = m.target_id
        FROM (VALUES ${values.join(', ')}) AS m(source_id, target_id)
        WHERE t."${columnName}" = m.source_id
      `,
      params
    );
  }
}

export async function repairGachaGhostCards(rawOptions: RepairOptions = {}) {
  const userDatabaseUrl = process.env.USER_DATABASE_URL ?? process.env.USER_BACKEND_DATABASE_URL;
  if (!userDatabaseUrl) {
    throw new Error('缺少 USER_DATABASE_URL（或 USER_BACKEND_DATABASE_URL）环境变量，无法连接用户数据库。');
  }

  const options: Required<RepairOptions> = {
    dryRun: Boolean(rawOptions.dryRun)
  };

  const userDbPool = new Pool({ connectionString: userDatabaseUrl });
  const client = await userDbPool.connect();

  try {
    const ghostRowsResult = await client.query<CardRow>(
      `
        SELECT
          id,
          "poolId",
          "pageId",
          title,
          weight,
          "imageUrl",
          "variantKey",
          "createdAt"
        FROM "GachaCardDefinition"
        WHERE "poolId" = $1
          AND weight = 0
          AND "pageId" IS NOT NULL
          AND "imageUrl" IS NULL
          AND "variantKey" IS NULL
          AND EXISTS (
            SELECT 1
            FROM "GachaCardDefinition" active
            WHERE active."poolId" = "GachaCardDefinition"."poolId"
              AND active."pageId" = "GachaCardDefinition"."pageId"
              AND active.weight > 0
              AND (active."imageUrl" IS NOT NULL OR active."variantKey" IS NOT NULL)
          )
        ORDER BY "pageId" ASC, id ASC
      `,
      [PERMANENT_POOL_ID]
    );
    const ghostRows = ghostRowsResult.rows ?? [];
    const pageIds = Array.from(new Set(ghostRows.map((row) => row.pageId)));
    const activeRowsResult = pageIds.length > 0
      ? await client.query<CardRow>(
        `
          SELECT
            id,
            "poolId",
            "pageId",
            title,
            weight,
            "imageUrl",
            "variantKey",
            "createdAt"
          FROM "GachaCardDefinition"
          WHERE "poolId" = $1
            AND "pageId" = ANY($2::int[])
            AND weight > 0
            AND ("imageUrl" IS NOT NULL OR "variantKey" IS NOT NULL)
          ORDER BY "pageId" ASC, id ASC
        `,
        [PERMANENT_POOL_ID, pageIds]
      )
      : { rows: [] as CardRow[] };

    const activeByPage = new Map<number, CardRow[]>();
    for (const row of activeRowsResult.rows) {
      const list = activeByPage.get(row.pageId);
      if (list) {
        list.push(row);
      } else {
        activeByPage.set(row.pageId, [row]);
      }
    }

    const mappings: Mapping[] = [];
    for (const ghost of ghostRows) {
      const target = chooseTargetCard(ghost, activeByPage.get(ghost.pageId) ?? []);
      if (!target || target.id === ghost.id) continue;
      mappings.push({
        sourceId: ghost.id,
        targetId: target.id,
        pageId: ghost.pageId,
        title: ghost.title
      });
    }

    const directRefTables = [
      { tableName: 'GachaCardInstance', columnName: 'cardId' },
      { tableName: 'GachaPlacementSlot', columnName: 'cardId' },
      { tableName: 'GachaTradeListing', columnName: 'cardId' },
      { tableName: 'GachaBuyRequest', columnName: 'targetCardId' },
      { tableName: 'GachaBuyRequestOfferedCard', columnName: 'cardId' },
      { tableName: 'GachaDrawItem', columnName: 'cardId' },
      { tableName: 'GachaDismantleLog', columnName: 'cardId' }
    ] as const;

    const stats = {
      candidateGhostCards: ghostRows.length,
      mappedGhostCards: mappings.length,
      pagesAffected: new Set(mappings.map((mapping) => mapping.pageId)).size,
      totalInventoryCount: 0,
      totalInventoryRows: 0,
      totalInstanceRows: 0,
      totalUnlockRows: 0,
      totalTradeRows: 0,
      totalBuyRequestRows: 0,
      totalOfferedCardRows: 0,
      totalDrawRows: 0,
      totalDismantleRows: 0
    };

    if (mappings.length > 0) {
      const sourceIds = mappings.map((mapping) => mapping.sourceId);
      const counts = await client.query<{
        inventoryCount: string;
        inventoryRows: string;
        instanceRows: string;
        unlockRows: string;
        tradeRows: string;
        buyRequestRows: string;
        offeredCardRows: string;
        drawRows: string;
        dismantleRows: string;
      }>(
        `
          SELECT
            COALESCE((SELECT SUM(count)::bigint FROM "GachaInventory" WHERE "cardId" = ANY($1::text[])), 0)::text AS "inventoryCount",
            COALESCE((SELECT COUNT(*)::bigint FROM "GachaInventory" WHERE "cardId" = ANY($1::text[])), 0)::text AS "inventoryRows",
            COALESCE((SELECT COUNT(*)::bigint FROM "GachaCardInstance" WHERE "cardId" = ANY($1::text[])), 0)::text AS "instanceRows",
            COALESCE((SELECT COUNT(*)::bigint FROM "GachaCardUnlock" WHERE "cardId" = ANY($1::text[])), 0)::text AS "unlockRows",
            COALESCE((SELECT COUNT(*)::bigint FROM "GachaTradeListing" WHERE "cardId" = ANY($1::text[])), 0)::text AS "tradeRows",
            COALESCE((SELECT COUNT(*)::bigint FROM "GachaBuyRequest" WHERE "targetCardId" = ANY($1::text[])), 0)::text AS "buyRequestRows",
            COALESCE((SELECT COUNT(*)::bigint FROM "GachaBuyRequestOfferedCard" WHERE "cardId" = ANY($1::text[])), 0)::text AS "offeredCardRows",
            COALESCE((SELECT COUNT(*)::bigint FROM "GachaDrawItem" WHERE "cardId" = ANY($1::text[])), 0)::text AS "drawRows",
            COALESCE((SELECT COUNT(*)::bigint FROM "GachaDismantleLog" WHERE "cardId" = ANY($1::text[])), 0)::text AS "dismantleRows"
        `,
        [sourceIds]
      );
      const row = counts.rows[0];
      if (row) {
        stats.totalInventoryCount = Number.parseInt(row.inventoryCount, 10) || 0;
        stats.totalInventoryRows = Number.parseInt(row.inventoryRows, 10) || 0;
        stats.totalInstanceRows = Number.parseInt(row.instanceRows, 10) || 0;
        stats.totalUnlockRows = Number.parseInt(row.unlockRows, 10) || 0;
        stats.totalTradeRows = Number.parseInt(row.tradeRows, 10) || 0;
        stats.totalBuyRequestRows = Number.parseInt(row.buyRequestRows, 10) || 0;
        stats.totalOfferedCardRows = Number.parseInt(row.offeredCardRows, 10) || 0;
        stats.totalDrawRows = Number.parseInt(row.drawRows, 10) || 0;
        stats.totalDismantleRows = Number.parseInt(row.dismantleRows, 10) || 0;
      }
    }

    if (!options.dryRun && mappings.length > 0) {
      await client.query('BEGIN');
      for (const { tableName, columnName } of directRefTables) {
        await updateDirectCardReferences(client, tableName, columnName, mappings);
      }
      for (const mapping of mappings) {
        await mergeInventories(client, mapping.sourceId, mapping.targetId);
        await mergeUnlocks(client, mapping.sourceId, mapping.targetId);
      }
      await client.query(
        'DELETE FROM "GachaCardDefinition" WHERE id = ANY($1::text[])',
        [mappings.map((mapping) => mapping.sourceId)]
      );
      await client.query('COMMIT');
    }

    console.log('[gacha-repair-ghost-cards] Completed.');
    console.log('[gacha-repair-ghost-cards] poolId =', PERMANENT_POOL_ID);
    console.log('[gacha-repair-ghost-cards] candidateGhostCards =', stats.candidateGhostCards);
    console.log('[gacha-repair-ghost-cards] mappedGhostCards =', stats.mappedGhostCards);
    console.log('[gacha-repair-ghost-cards] pagesAffected =', stats.pagesAffected);
    console.log('[gacha-repair-ghost-cards] totalInventoryCount =', stats.totalInventoryCount);
    console.log('[gacha-repair-ghost-cards] totalInventoryRows =', stats.totalInventoryRows);
    console.log('[gacha-repair-ghost-cards] totalInstanceRows =', stats.totalInstanceRows);
    console.log('[gacha-repair-ghost-cards] totalUnlockRows =', stats.totalUnlockRows);
    console.log('[gacha-repair-ghost-cards] totalTradeRows =', stats.totalTradeRows);
    console.log('[gacha-repair-ghost-cards] totalBuyRequestRows =', stats.totalBuyRequestRows);
    console.log('[gacha-repair-ghost-cards] totalOfferedCardRows =', stats.totalOfferedCardRows);
    console.log('[gacha-repair-ghost-cards] totalDrawRows =', stats.totalDrawRows);
    console.log('[gacha-repair-ghost-cards] totalDismantleRows =', stats.totalDismantleRows);
    if (options.dryRun) {
      console.log('[gacha-repair-ghost-cards] dryRun = true (no database writes).');
    }

    return {
      dryRun: options.dryRun,
      poolId: PERMANENT_POOL_ID,
      ...stats,
      mappings
    };
  } catch (error) {
    if (!options.dryRun) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    client.release();
    await userDbPool.end();
  }
}
