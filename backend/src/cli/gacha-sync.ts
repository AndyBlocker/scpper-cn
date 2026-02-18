import { randomUUID } from 'crypto';
import { Pool, type PoolClient } from 'pg';
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

type PgClient = Pool | PoolClient;

interface TagWeightRule {
  tags: string[];
  multiplier: number;
  match?: MatchMode;
}

function normalizeTagValue(raw: string | null | undefined): string {
  return String(raw ?? '').trim().toLowerCase();
}

function normalizeTagList(raw: string[] | null | undefined): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const entry of raw ?? []) {
    const normalized = normalizeTagValue(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function buildFilterTagSet(rawTags: string[] | null, category: string | null): Set<string> {
  const set = new Set<string>();
  const normalizedCategory = normalizeTagValue(category);
  if (normalizedCategory) set.add(normalizedCategory);
  for (const tag of rawTags ?? []) {
    const normalized = normalizeTagValue(tag);
    if (normalized) set.add(normalized);
  }
  return set;
}

function matchesIncludeTags(tagSet: Set<string>, includeTags: string[], matchMode: MatchMode): boolean {
  if (includeTags.length === 0) return true;
  if (matchMode === 'all') {
    return includeTags.every((tag) => tagSet.has(tag));
  }
  return includeTags.some((tag) => tagSet.has(tag));
}

function matchesExcludeTags(tagSet: Set<string>, excludeTags: string[]): boolean {
  return excludeTags.some((tag) => tagSet.has(tag));
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

const RARITY_RANK: Record<GachaRarity, number> = {
  WHITE: 0,
  GREEN: 1,
  BLUE: 2,
  PURPLE: 3,
  GOLD: 4
};

interface SyncOptions {
  poolId?: string;
  poolName?: string;
  description?: string;
  tokenCost?: number;
  tenDrawCost?: number;
  duplicateReward?: number;
  isActive?: boolean;
  includeTags?: string[];
  includeMatch?: MatchMode;
  excludeTags?: string[];
  cardIdPrefix?: string;
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
  images: Array<{ assetId: number; url: string | null }>;
}

interface CardPayload {
  id: string;
  poolId: string;
  title: string;
  rarity: GachaRarity;
  tags: string[];
  authorKeys: string[];
  weight: number;
  rewardTokens: number;
  wikidotId: number | null;
  pageId: number;
  imageUrl: string | null;
}

function normalizeAuthorKey(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^[#@]+/, '')
    .replace(/[\s_:\-\/\\\.]+/g, '');
}

async function loadAttributionsByPageIds(
  prisma: ReturnType<typeof getPrismaClient>,
  pageIds: number[]
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>();
  if (pageIds.length === 0) return result;

  const BATCH_SIZE = 5000;
  for (let i = 0; i < pageIds.length; i += BATCH_SIZE) {
    const batch = pageIds.slice(i, i + BATCH_SIZE);
    const rows = await prisma.$queryRaw<Array<{
      pageId: number;
      type: string;
      userId: number | null;
      anonKey: string | null;
      username: string | null;
      displayName: string | null;
    }>>`
      WITH latest AS (
        SELECT DISTINCT ON (pv."pageId") pv.id, pv."pageId"
        FROM "PageVersion" pv
        WHERE pv."pageId" = ANY(${batch}::int[])
        ORDER BY pv."pageId", (pv."validTo" IS NULL) DESC, pv."validFrom" DESC, pv.id DESC
      )
      SELECT l."pageId", a.type, a."userId", a."anonKey", u.username, u."displayName"
      FROM latest l
      LEFT JOIN "Attribution" a ON a."pageVerId" = l.id
      LEFT JOIN "User" u ON u.id = a."userId"
      WHERE a.type IN ('AUTHOR','TRANSLATOR','SUBMITTER')
    `;

    const grouped = new Map<number, { primary: string[]; submitter: string[] }>();
    for (const row of rows) {
      const pageId = Number(row.pageId);
      if (!grouped.has(pageId)) grouped.set(pageId, { primary: [], submitter: [] });
      const label = String(row.displayName || row.username || row.anonKey || '').trim();
      if (!label) continue;
      const key = normalizeAuthorKey(label);
      if (!key) continue;
      if (row.type === 'AUTHOR' || row.type === 'TRANSLATOR') {
        grouped.get(pageId)!.primary.push(key);
      } else if (row.type === 'SUBMITTER') {
        grouped.get(pageId)!.submitter.push(key);
      }
    }

    for (const [pageId, rec] of grouped.entries()) {
      const primary = [...new Set(rec.primary)];
      const submitter = [...new Set(rec.submitter)];
      result.set(pageId, primary.length > 0 ? primary : submitter);
    }
  }
  return result;
}

function buildImageVariants(row: PageRow, poolId: string, cardIdPrefix: string, authorKeys?: string[]): CardPayload[] {
  const rarity = determineRarity(row.voteCount);
  const title = fallbackTitle(row.title, row.currentUrl);
  const tags = normalizeTags(row.tags, row.category);
  const resolvedAuthorKeys = authorKeys ?? [];
  const weight = applyTagWeightMultipliers(RARITY_WEIGHTS[rarity], tags);
  const rewardTokens = 0;
  const baseId = `${cardIdPrefix}-${row.pageId}`;
  const images = row.images ?? [];

  if (images.length === 0) {
    return [{
      id: baseId, poolId, title, rarity, tags, authorKeys: resolvedAuthorKeys, weight,
      rewardTokens, wikidotId: row.wikidotId,
      pageId: row.pageId, imageUrl: null
    }];
  }

  return images.map((img, index) => ({
    id: index === 0 ? baseId : `${baseId}-img-${index + 1}`,
    poolId, title, rarity, tags, authorKeys: resolvedAuthorKeys, weight,
    rewardTokens, wikidotId: row.wikidotId,
    pageId: row.pageId,
    imageUrl: buildPageImagePath(img.assetId) ?? img.url
  }));
}

const DEFAULT_PAGE_IMAGE_ROUTE_PREFIX = '/page-images';

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

async function resolvePoolCreator(client: PgClient): Promise<string> {
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

async function upsertPool(client: PgClient, options: Required<SyncOptions> & { createdById: string }) {
  await client.query(
    `
      INSERT INTO "GachaPool"
        ("id","name","description","tokenCost","tenDrawCost","rewardPerDuplicate","startsAt","endsAt","isActive","createdById","createdAt","updatedAt")
      VALUES ($1,$2,$3,$4,$5,$6,timezone('UTC', now()),$7,$8,$9,timezone('UTC', now()),timezone('UTC', now()))
      ON CONFLICT ("id") DO UPDATE SET
        "name" = EXCLUDED."name",
        "description" = EXCLUDED."description",
        "tokenCost" = EXCLUDED."tokenCost",
        "tenDrawCost" = EXCLUDED."tenDrawCost",
        "rewardPerDuplicate" = EXCLUDED."rewardPerDuplicate",
        "startsAt" = COALESCE(LEAST("GachaPool"."startsAt", EXCLUDED."startsAt"), EXCLUDED."startsAt"),
        "endsAt" = EXCLUDED."endsAt",
        "isActive" = EXCLUDED."isActive",
        "updatedAt" = timezone('UTC', now())
    `,
    [
      options.poolId,
      options.poolName,
      options.description,
      options.tokenCost,
      options.tenDrawCost,
      options.duplicateReward,
      null,
      options.isActive,
      options.createdById
    ]
  );
}

async function insertCards(client: PgClient, cards: CardPayload[]) {
  if (cards.length === 0) return;
  // PostgreSQL prepared statements max at 65535 parameters.
  // We bind 11 params per card, so keep each chunk comfortably below the cap.
  const INSERT_BATCH_SIZE = 2500;
  const chunks = chunkArray(cards, INSERT_BATCH_SIZE);

  for (const chunk of chunks) {
    const values: string[] = [];
    const params: any[] = [];
    let index = 1;

    for (const card of chunk) {
      values.push(
        `($${index},$${index + 1},$${index + 2},$${index + 3},$${index + 4},$${index + 5},$${index + 6},$${index + 7},$${index + 8},$${index + 9},$${index + 10},timezone('UTC', now()),timezone('UTC', now()))`
      );
      params.push(
        card.id,
        card.poolId,
        card.title,
        card.rarity,
        card.tags,
        card.authorKeys,
        card.weight,
        card.rewardTokens,
        card.wikidotId,
        card.pageId,
        card.imageUrl
      );
      index += 11;
    }

    await client.query(
      `
        INSERT INTO "GachaCardDefinition"
          ("id","poolId","title","rarity","tags","authorKeys","weight","rewardTokens","wikidotId","pageId","imageUrl","createdAt","updatedAt")
        VALUES ${values.join(',')}
        ON CONFLICT ("id") DO UPDATE SET
          "poolId" = EXCLUDED."poolId",
          "title" = EXCLUDED."title",
          "rarity" = EXCLUDED."rarity",
          "tags" = EXCLUDED."tags",
          "authorKeys" = EXCLUDED."authorKeys",
          "weight" = EXCLUDED."weight",
          "rewardTokens" = EXCLUDED."rewardTokens",
          "wikidotId" = EXCLUDED."wikidotId",
          "pageId" = EXCLUDED."pageId",
          "imageUrl" = EXCLUDED."imageUrl",
          "updatedAt" = timezone('UTC', now())
      `,
      params
    );
  }
}

type ExistingCardRow = {
  id: string;
  rarity: GachaRarity;
  rewardTokens: number;
  weight: number | null;
  pageId: number | null;
};

type CardRarityUpgrade = {
  cardId: string;
  oldRarity: GachaRarity;
  newRarity: GachaRarity;
  deltaPerCopy: number;
};

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

function buildValuesClause<T>(rows: T[], mapper: (row: T) => unknown[]): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  const values: string[] = [];
  for (const row of rows) {
    const mapped = mapper(row);
    const placeholders = mapped.map((_value, index) => `$${params.length + index + 1}`);
    params.push(...mapped);
    values.push(`(${placeholders.join(',')})`);
  }
  return { clause: values.join(','), params };
}

function parsePgBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  if (typeof value === 'string' && value.trim().length > 0) return BigInt(value);
  return 0n;
}

async function disableRemovedPageCards(client: PgClient, poolId: string, removedIds: string[]) {
  if (removedIds.length === 0) return;
  await client.query(
    `
      UPDATE "GachaCardDefinition"
      SET "weight" = 0, "updatedAt" = timezone('UTC', now())
      WHERE "poolId" = $1
        AND "pageId" IS NOT NULL
        AND "id" = ANY($2::text[])
    `,
    [poolId, removedIds]
  );
}

async function applyRarityUpgradeRewards(
  client: PgClient,
  poolId: string,
  upgrades: CardRarityUpgrade[],
  dryRun: boolean
): Promise<{ affectedUsers: number; totalReward: bigint }> {
  if (upgrades.length === 0) return { affectedUsers: 0, totalReward: 0n };

  const userRewardMap = new Map<string, bigint>();
  const batches = chunkArray(upgrades, 1500);
  for (const batch of batches) {
    const { clause, params } = buildValuesClause(batch, (upgrade) => [upgrade.cardId, upgrade.deltaPerCopy]);
    const rows = await client.query<{ userId: string; delta: string }>(
      `
        SELECT inv."userId" AS "userId",
          SUM(inv."count"::bigint * v."deltaPerCopy"::bigint)::bigint AS "delta"
        FROM "GachaInventory" inv
        JOIN (VALUES ${clause}) AS v("cardId","deltaPerCopy")
          ON inv."cardId" = v."cardId"
        GROUP BY inv."userId"
        HAVING SUM(inv."count"::bigint * v."deltaPerCopy"::bigint) > 0
      `,
      params as any[]
    );
    for (const row of rows.rows ?? []) {
      const current = userRewardMap.get(row.userId) ?? 0n;
      userRewardMap.set(row.userId, current + parsePgBigInt(row.delta));
    }
  }

  const rewards = Array.from(userRewardMap.entries())
    .filter(([, delta]) => delta > 0n)
    .map(([userId, delta]) => ({ userId, delta }));

  const totalReward = rewards.reduce((acc, entry) => acc + entry.delta, 0n);
  if (rewards.length === 0) return { affectedUsers: 0, totalReward: 0n };

  if (dryRun) {
    return { affectedUsers: rewards.length, totalReward };
  }

  const MAX_INT = 2147483647n;
  const walletUpdates = rewards.map((entry) => {
    if (entry.delta > MAX_INT) {
      throw new Error(`用户 ${entry.userId} 的补偿 Token 超出 int 上限：${entry.delta.toString()}`);
    }
    const asNumber = Number(entry.delta);
    if (!Number.isSafeInteger(asNumber) || asNumber <= 0) {
      throw new Error(`用户 ${entry.userId} 的补偿 Token 非法：${entry.delta.toString()}`);
    }
    return { userId: entry.userId, delta: asNumber };
  });

  const walletUpdateValues = buildValuesClause(walletUpdates, (entry) => [entry.userId, entry.delta]);
  await client.query(
    `
      UPDATE "GachaWallet" AS w
      SET "balance" = w."balance" + v."delta",
        "totalEarned" = w."totalEarned" + v."delta",
        "updatedAt" = timezone('UTC', now())
      FROM (VALUES ${walletUpdateValues.clause}) AS v("userId","delta")
      WHERE w."userId" = v."userId"
    `,
    walletUpdateValues.params as any[]
  );

  const ledgerEntries = walletUpdates.map((entry) => ({
    id: randomUUID(),
    userId: entry.userId,
    delta: entry.delta
  }));

  const ledgerValues = buildValuesClause(ledgerEntries, (entry) => [entry.id, entry.userId, entry.delta]);
  const metadata = JSON.stringify({
    poolId,
    upgradedCards: upgrades.length
  });
  const ledgerParams = [...ledgerValues.params, metadata];
  const metadataIndex = ledgerParams.length;

  await client.query(
    `
      INSERT INTO "GachaLedgerEntry" ("id","walletId","userId","delta","reason","metadata","createdAt")
      SELECT v."id", w."id", v."userId", v."delta", 'CARD_RARITY_UPGRADE_BONUS', $${metadataIndex}::jsonb, timezone('UTC', now())
      FROM (VALUES ${ledgerValues.clause}) AS v("id","userId","delta")
      JOIN "GachaWallet" w ON w."userId" = v."userId"
    `,
    ledgerParams as any[]
  );

  return { affectedUsers: rewards.length, totalReward };
}

export async function syncGachaPool(rawOptions: SyncOptions = {}) {
  const prisma = getPrismaClient();
  const userDatabaseUrl = process.env.USER_DATABASE_URL ?? process.env.USER_BACKEND_DATABASE_URL;

  if (!userDatabaseUrl) {
    throw new Error('缺少 USER_DATABASE_URL（或 USER_BACKEND_DATABASE_URL）环境变量，无法连接用户数据库。');
  }

  const poolId = String(rawOptions.poolId ?? 'permanent-main-pool').trim() || 'permanent-main-pool';
  const options: Required<SyncOptions> = {
    poolId,
    poolName: rawOptions.poolName ?? '常驻卡池',
    description: rawOptions.description ?? '涵盖当前站内已收录文档的常驻卡池。',
    tokenCost: rawOptions.tokenCost ?? 10,
    tenDrawCost: rawOptions.tenDrawCost ?? (rawOptions.tokenCost ?? 10) * 10,
    duplicateReward: rawOptions.duplicateReward ?? 5,
    isActive: rawOptions.isActive ?? true,
    includeTags: normalizeTagList(rawOptions.includeTags),
    includeMatch: rawOptions.includeMatch === 'all' ? 'all' : 'any',
    excludeTags: normalizeTagList(rawOptions.excludeTags),
    cardIdPrefix: normalizeTagValue(rawOptions.cardIdPrefix) || (poolId === 'permanent-main-pool' ? 'permanent' : poolId),
    dryRun: rawOptions.dryRun ?? false,
    limit: rawOptions.limit ?? 0
  };

  if (options.poolId === 'permanent-main-pool') {
    options.tokenCost = 10;
    options.tenDrawCost = 100;
    options.duplicateReward = 0;
  }

  if (options.includeTags.length > 0 || options.excludeTags.length > 0) {
    console.log('[gacha-sync] Filters:', {
      includeTags: options.includeTags,
      includeMatch: options.includeMatch,
      excludeTags: options.excludeTags
    });
  }

  if (!options.cardIdPrefix) {
    throw new Error('无效的 cardIdPrefix，无法生成卡片 ID。');
  }

  const userDbPool = new Pool({ connectionString: userDatabaseUrl });
  const userDbClient = await userDbPool.connect();

  const rarityCounts: Record<GachaRarity, number> = {
    WHITE: 0,
    GREEN: 0,
    BLUE: 0,
    PURPLE: 0,
    GOLD: 0
  };
  let withImage = 0;
  let total = 0;
  let skippedByFilter = 0;
  let disabledCount = 0;
  let bonusPreview: { affectedUsers: number; totalReward: bigint } | null = null;

  try {
    const createdById = await resolvePoolCreator(userDbClient);
    const fullSync = options.limit <= 0;

    const existingCardsResult = await userDbClient.query<ExistingCardRow>(
      `
        SELECT "id", "rarity", "rewardTokens", "weight", "pageId"
        FROM "GachaCardDefinition"
        WHERE "poolId" = $1
      `,
      [options.poolId]
    );
    const existingCards = existingCardsResult.rows ?? [];
    const existingCardsById = new Map<string, ExistingCardRow>();
    const existingPageCardIds = new Set<string>();
    for (const card of existingCards) {
      existingCardsById.set(card.id, card);
      if (card.pageId != null) {
        existingPageCardIds.add(card.id);
      }
    }

    const newCardIds = new Set<string>();
    const rarityUpgrades: CardRarityUpgrade[] = [];

    if (!options.dryRun) {
      await userDbClient.query('BEGIN');
      await upsertPool(userDbClient, { ...options, createdById });
    }

    const batchSize = 2000;
    let lastId = 0;
    let remaining: number | null = options.limit > 0 ? options.limit : null;

    while (remaining === null || remaining > 0) {
      const take = batchSize;
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
          COALESCE(
            (SELECT json_agg(json_build_object(
              'assetId', img."imageAssetId",
              'url', COALESCE(img."displayUrl", img."normalizedUrl")
            ) ORDER BY img.id)
            FROM "PageVersionImage" img
            WHERE img."pageVersionId" = pv.id
              AND img.status = 'RESOLVED'
              AND img."imageAssetId" IS NOT NULL
            ), '[]'::json
          ) AS "images"
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

      // Load Attribution author keys for this batch
      const batchPageIds = rows.map((row) => row.pageId).filter((id) => Number.isFinite(id) && id > 0);
      const authorKeysByPage = await loadAttributionsByPageIds(prisma, batchPageIds);

      let matchedPageCount = 0;
      let cards = rows.flatMap((row) => {
        const tagSet = buildFilterTagSet(row.tags, row.category);
        if (!matchesIncludeTags(tagSet, options.includeTags, options.includeMatch)) return [];
        if (matchesExcludeTags(tagSet, options.excludeTags)) return [];
        matchedPageCount += 1;
        return buildImageVariants(row, options.poolId, options.cardIdPrefix!, authorKeysByPage.get(row.pageId));
      });

      skippedByFilter += rows.length - matchedPageCount;

      if (remaining !== null && cards.length > remaining) {
        cards = cards.slice(0, remaining);
      }
      for (const card of cards) {
        newCardIds.add(card.id);
        const existing = existingCardsById.get(card.id);
        if (existing && RARITY_RANK[card.rarity] > RARITY_RANK[existing.rarity]) {
          const deltaPerCopy = (card.rewardTokens ?? 0) - (existing.rewardTokens ?? 0);
          if (deltaPerCopy > 0) {
            rarityUpgrades.push({
              cardId: card.id,
              oldRarity: existing.rarity,
              newRarity: card.rarity,
              deltaPerCopy
            });
          }
        }
        rarityCounts[card.rarity] += 1;
        if (card.imageUrl) withImage += 1;
      }
      total += cards.length;
      if (remaining !== null) {
        remaining -= cards.length;
      }

      if (!options.dryRun) {
        await insertCards(userDbClient, cards);
      }
    }

    const removedIds = fullSync && existingPageCardIds.size > 0
      ? Array.from(existingPageCardIds).filter((id) => !newCardIds.has(id))
      : [];
    disabledCount = removedIds.length;

    if (rarityUpgrades.length > 0 && fullSync) {
      bonusPreview = await applyRarityUpgradeRewards(userDbClient, options.poolId, rarityUpgrades, options.dryRun);
    }

    if (!options.dryRun) {
      if (removedIds.length > 0) {
        await disableRemovedPageCards(userDbClient, options.poolId, removedIds);
      }
      await userDbClient.query('COMMIT');
    }

    // eslint-disable-next-line no-console
    console.log(`同步完成：共处理 ${total} 张卡片，其中 ${withImage} 张包含封面图片。`);
    if (skippedByFilter > 0) {
      console.log(`过滤跳过：${skippedByFilter} 条 PageVersion（未满足 include/excludeTags 条件）。`);
    }
    if (disabledCount > 0) {
      console.log(`已禁用：${disabledCount} 张不再匹配的旧卡片（weight=0，保留用户库存）。`);
    }
    if (!fullSync && rarityUpgrades.length > 0) {
      console.log(`注意：当前 limit=${options.limit}，已跳过稀有度升级补偿发放（避免部分同步误发）。`);
    } else if (bonusPreview && rarityUpgrades.length > 0) {
      const prefix = options.dryRun ? 'DRY RUN：预计' : '稀有度升级补偿：已';
      console.log(
        `${prefix}升级 ${rarityUpgrades.length} 张卡片，影响 ${bonusPreview.affectedUsers} 名用户，共发放 ${bonusPreview.totalReward.toString()} Token。`
      );
    }
    if (options.dryRun) {
      console.log('DRY RUN：未写入用户数据库；仅输出计划结果。');
    }
    // eslint-disable-next-line no-console
    console.table(
      Object.entries(rarityCounts).map(([rarity, count]) => ({ rarity, count }))
    );
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
