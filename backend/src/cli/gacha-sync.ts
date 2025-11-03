import { Pool } from 'pg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { getPrismaClient, disconnectPrisma } from '../utils/db-connection.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load backend env first (handled in getPrismaClient), then user-backend env as fallback
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: false });
dotenv.config({ path: path.resolve(__dirname, '../../../user-backend/.env'), override: false });

type GachaRarity = 'WHITE' | 'GREEN' | 'BLUE' | 'PURPLE' | 'GOLD';

type MatchMode = 'any' | 'all';

interface TagWeightRule {
  tags: string[];
  multiplier: number;
  match?: MatchMode;
}

const RARITY_THRESHOLDS: Array<{ min: number; rarity: GachaRarity }> = [
  { min: 304, rarity: 'GOLD' },
  { min: 86, rarity: 'PURPLE' },
  { min: 46, rarity: 'BLUE' },
  { min: 11, rarity: 'GREEN' }
];

const RARITY_WEIGHTS: Record<GachaRarity, number> = {
  GOLD: 100,
  PURPLE: 100,
  BLUE: 100,
  GREEN: 100,
  WHITE: 100
};

const DEFAULT_DRAW_REWARDS: Record<GachaRarity, number> = {
  GOLD: 200,
  PURPLE: 100,
  BLUE: 50,
  GREEN: 10,
  WHITE: 1
};

interface SyncOptions {
  poolId?: string;
  poolName?: string;
  description?: string;
  tokenCost?: number;
  tenDrawCost?: number;
  duplicateReward?: number;
  isActive?: boolean;
  dryRun?: boolean;
  limit?: number;
}

interface PageRow {
  id: number;
  pageId: number;
  wikidotId: number | null;
  title: string | null;
  voteCount: number | null;
  tags: string[] | null;
  category: string | null;
  currentUrl: string;
  imageUrl: string | null;
}

interface CardPayload {
  id: string;
  poolId: string;
  title: string;
  rarity: GachaRarity;
  tags: string[];
  weight: number;
  rewardTokens: number;
  wikidotId: number | null;
  pageId: number;
  imageUrl: string | null;
}

function determineRarity(voteCount: number | null | undefined): GachaRarity {
  const normalized = Number.isFinite(voteCount) ? Number(voteCount) : -Infinity;
  for (const entry of RARITY_THRESHOLDS) {
    if (normalized >= entry.min) return entry.rarity;
  }
  return 'WHITE';
}

function normalizeTags(rawTags: string[] | null, category: string | null): string[] {
  const set = new Set<string>();
  if (category && category.trim().length > 0) {
    set.add(category.trim().toLowerCase());
  }
  for (const tag of rawTags ?? []) {
    const trimmed = tag.trim().toLowerCase();
    if (trimmed.length > 0) {
      set.add(trimmed);
    }
    if (set.size >= 12) break;
  }
  return Array.from(set).slice(0, 12);
}

function fallbackTitle(inputTitle: string | null, currentUrl: string): string {
  const trimmed = (inputTitle ?? '').trim();
  if (trimmed.length > 0) return trimmed;
  try {
    const withoutProto = currentUrl.replace(/^https?:\/\//i, '');
    const slug = withoutProto.split('/').filter(Boolean).pop() ?? currentUrl;
    return decodeURIComponent(slug.replace(/[-_]/g, ' ')).trim() || slug;
  } catch {
    return currentUrl;
  }
}

function loadTagWeightRules(): TagWeightRule[] {
  const rules: TagWeightRule[] = [];
  const filePath = process.env.GACHA_TAG_WEIGHT_RULES_FILE
    ? path.resolve(process.cwd(), process.env.GACHA_TAG_WEIGHT_RULES_FILE)
    : path.resolve(__dirname, '../../../config/gacha-tag-weight-rules.json');

  const loadFromRaw = (raw: string | undefined | null) => {
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        parsed.forEach((entry) => {
          if (Array.isArray(entry?.tags) && typeof entry?.multiplier === 'number') {
            rules.push({
              tags: entry.tags.map((tag: string) => tag.toLowerCase().trim()).filter(Boolean),
              multiplier: entry.multiplier,
              match: entry.match === 'all' ? 'all' : 'any'
            });
          }
        });
      }
    } catch (error) {
      console.warn('[gacha-sync] Failed to parse tag weight rules:', error);
    }
  };

  if (process.env.GACHA_TAG_WEIGHT_RULES) {
    loadFromRaw(process.env.GACHA_TAG_WEIGHT_RULES);
  } else if (fs.existsSync(filePath)) {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    loadFromRaw(fileContent);
  }
  return rules;
}

const TAG_WEIGHT_RULES = loadTagWeightRules();
if (TAG_WEIGHT_RULES.length > 0) {
  console.log(`[gacha-sync] Loaded ${TAG_WEIGHT_RULES.length} tag weight rule${TAG_WEIGHT_RULES.length > 1 ? 's' : ''}.`);
}

async function loadDrawRewards(client: Pool): Promise<Record<GachaRarity, number>> {
  const rewards: Record<GachaRarity, number> = { ...DEFAULT_DRAW_REWARDS };
  try {
    const result = await client.query<{ rarity: GachaRarity; drawReward: number }>(
      'SELECT "rarity", "drawReward" FROM "GachaRarityReward"'
    );
    for (const row of result.rows ?? []) {
      if (row?.rarity && Number.isFinite(row.drawReward)) {
        rewards[row.rarity] = row.drawReward;
      }
    }
  } catch (error) {
    console.warn('[gacha-sync] Failed to load draw rewards; falling back to defaults.', error);
  }
  return rewards;
}

function applyTagWeightMultipliers(baseWeight: number, cardTags: string[]): number {
  if (TAG_WEIGHT_RULES.length === 0) return baseWeight;
  const tagSet = new Set(cardTags);
  let weight = baseWeight;
  for (const rule of TAG_WEIGHT_RULES) {
    if (rule.tags.length === 0 || !Number.isFinite(rule.multiplier)) continue;
    const matches = rule.match === 'all'
      ? rule.tags.every((tag) => tagSet.has(tag))
      : rule.tags.some((tag) => tagSet.has(tag));
    if (matches) {
      weight *= rule.multiplier;
    }
  }
  return Math.max(1, Math.min(1000, Math.round(weight)));
}

function buildCard(row: PageRow, poolId: string, drawRewards: Record<GachaRarity, number>): CardPayload {
  const rarity = determineRarity(row.voteCount);
  const title = fallbackTitle(row.title, row.currentUrl);
  const tags = normalizeTags(row.tags, row.category);
  const weight = applyTagWeightMultipliers(RARITY_WEIGHTS[rarity], tags);
  const rewardTokens = drawRewards[rarity] ?? DEFAULT_DRAW_REWARDS[rarity];

  return {
    id: `permanent-${row.pageId}`,
    poolId,
    title,
    rarity,
    tags,
    weight,
    rewardTokens,
    wikidotId: row.wikidotId,
    pageId: row.pageId,
    imageUrl: row.imageUrl
  };
}

async function resolvePoolCreator(client: Pool): Promise<string> {
  const adminCandidates = (process.env.USER_ADMIN_EMAILS || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (const email of adminCandidates) {
    const result = await client.query<{ id: string }>(
      'SELECT id FROM "UserAccount" WHERE lower(email) = lower($1) LIMIT 1',
      [email]
    );
    if (result.rowCount && result.rows[0]?.id) {
      return result.rows[0].id;
    }
  }

  const fallback = await client.query<{ id: string }>(
    'SELECT id FROM "UserAccount" ORDER BY "createdAt" ASC LIMIT 1'
  );
  if (!fallback.rowCount || !fallback.rows[0]?.id) {
    throw new Error('无法确定用于创建卡池的用户账号。请先在用户服务中创建管理员账号。');
  }
  return fallback.rows[0].id;
}

async function upsertPool(client: Pool, options: Required<SyncOptions> & { createdById: string }) {
  await client.query(
    `
      INSERT INTO "GachaPool"
        ("id","name","description","tokenCost","tenDrawCost","rewardPerDuplicate","startsAt","endsAt","isActive","createdById","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
      ON CONFLICT ("id") DO UPDATE SET
        "name" = EXCLUDED."name",
        "description" = EXCLUDED."description",
        "tokenCost" = EXCLUDED."tokenCost",
        "tenDrawCost" = EXCLUDED."tenDrawCost",
        "rewardPerDuplicate" = EXCLUDED."rewardPerDuplicate",
        "startsAt" = LEAST("GachaPool"."startsAt", EXCLUDED."startsAt"),
        "endsAt" = EXCLUDED."endsAt",
        "isActive" = EXCLUDED."isActive",
        "updatedAt" = NOW()
    `,
    [
      options.poolId,
      options.poolName,
      options.description,
      options.tokenCost,
      options.tenDrawCost,
      options.duplicateReward,
      new Date(),
      null,
      options.isActive,
      options.createdById
    ]
  );
}

async function insertCards(client: Pool, cards: CardPayload[]) {
  if (cards.length === 0) return;
  const values: string[] = [];
  const params: any[] = [];
  let index = 1;

  for (const card of cards) {
    values.push(
      `($${index},$${index + 1},$${index + 2},$${index + 3},$${index + 4},$${index + 5},$${index + 6},$${index + 7},$${index + 8},$${index + 9},NOW(),NOW())`
    );
    params.push(
      card.id,
      card.poolId,
      card.title,
      card.rarity,
      card.tags,
      card.weight,
      card.rewardTokens,
      card.wikidotId,
      card.pageId,
      card.imageUrl
    );
    index += 10;
  }

  await client.query(
    `
      INSERT INTO "GachaCardDefinition"
        ("id","poolId","title","rarity","tags","weight","rewardTokens","wikidotId","pageId","imageUrl","createdAt","updatedAt")
      VALUES ${values.join(',')}
      ON CONFLICT ("id") DO UPDATE SET
        "poolId" = EXCLUDED."poolId",
        "title" = EXCLUDED."title",
        "rarity" = EXCLUDED."rarity",
        "tags" = EXCLUDED."tags",
        "weight" = EXCLUDED."weight",
        "rewardTokens" = EXCLUDED."rewardTokens",
        "wikidotId" = EXCLUDED."wikidotId",
        "pageId" = EXCLUDED."pageId",
        "imageUrl" = EXCLUDED."imageUrl",
        "updatedAt" = NOW()
    `,
    params
  );
}

export async function syncGachaPool(rawOptions: SyncOptions = {}) {
  const prisma = getPrismaClient();
  const userDatabaseUrl = process.env.USER_DATABASE_URL ?? process.env.USER_BACKEND_DATABASE_URL;

  if (!userDatabaseUrl) {
    throw new Error('缺少 USER_DATABASE_URL（或 USER_BACKEND_DATABASE_URL）环境变量，无法连接用户数据库。');
  }

  const options: Required<SyncOptions> = {
    poolId: rawOptions.poolId ?? 'permanent-main-pool',
    poolName: rawOptions.poolName ?? '常驻卡池',
    description: rawOptions.description ?? '涵盖当前站内已收录文档的常驻卡池。',
    tokenCost: rawOptions.tokenCost ?? 10,
    tenDrawCost: rawOptions.tenDrawCost ?? (rawOptions.tokenCost ?? 10) * 10,
    duplicateReward: rawOptions.duplicateReward ?? 5,
    isActive: rawOptions.isActive ?? true,
    dryRun: rawOptions.dryRun ?? false,
    limit: rawOptions.limit ?? 0
  };

  const client = new Pool({ connectionString: userDatabaseUrl });

  const rarityCounts: Record<GachaRarity, number> = {
    WHITE: 0,
    GREEN: 0,
    BLUE: 0,
    PURPLE: 0,
    GOLD: 0
  };
  let withImage = 0;
  let total = 0;

  try {
    const createdById = await resolvePoolCreator(client);
    const drawRewards = await loadDrawRewards(client);

    if (!options.dryRun) {
      await upsertPool(client, { ...options, createdById });
      await client.query('BEGIN');
      await client.query('DELETE FROM "GachaCardDefinition" WHERE "poolId" = $1', [options.poolId]);
    }

    const batchSize = 2000;
    let lastId = 0;
    let remaining: number | null = options.limit > 0 ? options.limit : null;

    while (remaining === null || remaining > 0) {
      const take = remaining === null ? batchSize : Math.min(batchSize, remaining);
      const rows = await prisma.$queryRaw<PageRow[]>`
        SELECT
          pv.id,
          pv."pageId",
          pv."wikidotId",
          pv.title,
          pv."voteCount",
          pv.tags,
          pv.category,
          p."currentUrl",
          (
            SELECT COALESCE(img."displayUrl", img."normalizedUrl")
            FROM "PageVersionImage" img
            WHERE img."pageVersionId" = pv.id
              AND img.status = 'RESOLVED'
            ORDER BY img.id
            LIMIT 1
          ) AS "imageUrl"
        FROM "PageVersion" pv
        JOIN "Page" p ON p.id = pv."pageId"
        WHERE pv."validTo" IS NULL
          AND pv."isDeleted" = false
          AND p."isDeleted" = false
          AND pv.id > ${lastId}
        ORDER BY pv.id
        LIMIT ${take}
      `;

      if (rows.length === 0) break;
      lastId = rows[rows.length - 1]!.id;

      const cards = rows.map((row) => buildCard(row, options.poolId, drawRewards));
      for (const card of cards) {
        rarityCounts[card.rarity] += 1;
        if (card.imageUrl) withImage += 1;
      }
      total += cards.length;
      if (remaining !== null) {
        remaining -= cards.length;
      }

      if (!options.dryRun) {
        await insertCards(client, cards);
      }
    }

    if (!options.dryRun) {
      await client.query('COMMIT');
    }

    // eslint-disable-next-line no-console
    console.log(`同步完成：共处理 ${total} 张卡片，其中 ${withImage} 张包含封面图片。`);
    // eslint-disable-next-line no-console
    console.table(
      Object.entries(rarityCounts).map(([rarity, count]) => ({ rarity, count }))
    );
  } catch (error) {
    if (!options.dryRun) {
      await client.query('ROLLBACK').catch(() => {});
    }
    throw error;
  } finally {
    await client.end();
    await disconnectPrisma();
  }
}
