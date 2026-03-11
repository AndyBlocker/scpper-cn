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
const PERMANENT_POOL_ID = 'permanent-main-pool';
const DEFAULT_CARD_ID_PREFIX = 'permanent';
const NULL_IMAGE_KEY = '__NO_IMAGE__';
const NULL_VARIANT_KEY = '__NO_VARIANT__';

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
  imageRefCount: number;
  images: Array<{
    assetId: number;
    url: string | null;
    normalizedUrl: string | null;
    hashSha256: string | null;
  }>;
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
  variantKey: string | null;
}

function normalizeCardImageUrl(raw: string | null | undefined): string | null {
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
  assetId?: number | null;
}) {
  const hashSha256 = normalizeCardImageUrl(image.hashSha256);
  if (hashSha256) {
    return `hash:${hashSha256.toLowerCase()}`;
  }
  const normalizedUrl = normalizeCardImageUrl(image.normalizedUrl);
  if (normalizedUrl) {
    return `url:${normalizedUrl}`;
  }
  const assetId = Number.isFinite(image.assetId) ? Math.floor(Number(image.assetId)) : 0;
  if (assetId > 0) {
    return `asset:${assetId}`;
  }
  return null;
}

function parseVariantIndex(cardId: string, baseId: string): number | null {
  if (cardId === baseId) return 1;
  const prefix = `${baseId}-img-`;
  if (!cardId.startsWith(prefix)) return null;
  const parsed = Number.parseInt(cardId.slice(prefix.length), 10);
  if (!Number.isInteger(parsed) || parsed < 2) return null;
  return parsed;
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

function compareExistingVariantRows(a: ExistingCardRow, b: ExistingCardRow, baseId: string) {
  const idxA = parseVariantIndex(a.id, baseId);
  const idxB = parseVariantIndex(b.id, baseId);
  if (idxA != null && idxB != null && idxA !== idxB) return idxA - idxB;
  if (idxA != null && idxB == null) return -1;
  if (idxA == null && idxB != null) return 1;
  return a.id.localeCompare(b.id);
}

function normalizeExistingVariantIdentity(card: Pick<ExistingCardRow, 'variantKey' | 'imageUrl'>) {
  return normalizeVariantKey(card.variantKey)
    ?? normalizeCardImageUrl(card.imageUrl)
    ?? NULL_VARIANT_KEY;
}

function buildImageVariants(
  row: PageRow,
  poolId: string,
  cardIdPrefix: string,
  existingPageCards: ExistingCardRow[],
  authorKeys?: string[]
): CardPayload[] {
  const rarity = determineRarity(row.voteCount);
  const title = fallbackTitle(row.title, row.currentUrl);
  const tags = normalizeTags(row.tags, row.category);
  const resolvedAuthorKeys = authorKeys ?? [];
  const weight = applyTagWeightMultipliers(RARITY_WEIGHTS[rarity], tags);
  const rewardTokens = 0;
  const baseId = `${cardIdPrefix}-${row.pageId}`;
  const images = row.images ?? [];

  const existingIds = new Set(existingPageCards.map((card) => card.id));
  const assignedIds = new Set<string>();
  const existingByIdentity = new Map<string, ExistingCardRow[]>();

  for (const card of existingPageCards) {
    const key = normalizeExistingVariantIdentity(card);
    const list = existingByIdentity.get(key);
    if (list) {
      list.push(card);
    } else {
      existingByIdentity.set(key, [card]);
    }
  }

  for (const list of existingByIdentity.values()) {
    list.sort((a, b) => compareExistingVariantRows(a, b, baseId));
  }

  const takeExistingId = (identityKey: string) => {
    const list = existingByIdentity.get(identityKey);
    if (!list || list.length === 0) return null;
    while (list.length > 0) {
      const candidate = list.shift()!;
      if (!assignedIds.has(candidate.id)) {
        assignedIds.add(candidate.id);
        return candidate.id;
      }
    }
    return null;
  };

  const allocateNewId = () => {
    if (!existingIds.has(baseId) && !assignedIds.has(baseId)) {
      assignedIds.add(baseId);
      return baseId;
    }
    let suffix = 2;
    while (true) {
      const candidate = `${baseId}-img-${suffix}`;
      if (!existingIds.has(candidate) && !assignedIds.has(candidate)) {
        assignedIds.add(candidate);
        return candidate;
      }
      suffix += 1;
    }
  };

  const normalizedImages: Array<{ imageUrl: string | null; variantKey: string | null; identityKey: string }> = [];
  const seenImages = new Set<string>();
  for (const img of images) {
    const imageUrl = normalizeCardImageUrl(buildPageImagePath(img.assetId) ?? img.url);
    const variantKey = buildVariantKey(img);
    const identityKey = variantKey ?? imageUrl ?? NULL_VARIANT_KEY;
    if (seenImages.has(identityKey)) continue;
    seenImages.add(identityKey);
    normalizedImages.push({
      imageUrl,
      variantKey,
      identityKey
    });
  }

  if (normalizedImages.length === 0) {
    if (row.imageRefCount > 0) {
      return [];
    }
    const id = takeExistingId(NULL_VARIANT_KEY) ?? takeExistingId(NULL_IMAGE_KEY) ?? allocateNewId();
    return [{
      id,
      poolId,
      title,
      rarity,
      tags,
      authorKeys: resolvedAuthorKeys,
      weight,
      rewardTokens,
      wikidotId: row.wikidotId,
      pageId: row.pageId,
      imageUrl: null,
      variantKey: null
    }];
  }

  return normalizedImages.map(({ imageUrl, variantKey, identityKey }) => ({
    id: takeExistingId(identityKey) ?? allocateNewId(),
    poolId,
    title,
    rarity,
    tags,
    authorKeys: resolvedAuthorKeys,
    weight,
    rewardTokens,
    wikidotId: row.wikidotId,
    pageId: row.pageId,
    imageUrl,
    variantKey
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

async function deleteNonPermanentPools(client: PgClient) {
  await client.query(
    `
      DELETE FROM "GachaPool"
      WHERE "id" <> $1
    `,
    [PERMANENT_POOL_ID]
  );
}

async function insertCards(client: PgClient, cards: CardPayload[]) {
  if (cards.length === 0) return;
  // PostgreSQL prepared statements max at 65535 parameters.
  // We bind 12 params per card, so keep each chunk comfortably below the cap.
  const INSERT_BATCH_SIZE = 2400;
  const chunks = chunkArray(cards, INSERT_BATCH_SIZE);

  for (const chunk of chunks) {
    const values: string[] = [];
    const params: any[] = [];
    let index = 1;

    for (const card of chunk) {
      values.push(
        `($${index},$${index + 1},$${index + 2},$${index + 3},$${index + 4},$${index + 5},$${index + 6},$${index + 7},$${index + 8},$${index + 9},$${index + 10},$${index + 11},timezone('UTC', now()),timezone('UTC', now()))`
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
        card.imageUrl,
        card.variantKey
      );
      index += 12;
    }

    await client.query(
      `
        INSERT INTO "GachaCardDefinition"
          ("id","poolId","title","rarity","tags","authorKeys","weight","rewardTokens","wikidotId","pageId","imageUrl","variantKey","createdAt","updatedAt")
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
          "variantKey" = EXCLUDED."variantKey",
          "updatedAt" = timezone('UTC', now())
      `,
      params
    );
  }
}

type ExistingCardRow = {
  id: string;
  weight: number | null;
  pageId: number | null;
  imageUrl: string | null;
  variantKey: string | null;
};

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) return [items];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
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

export async function syncGachaPool(rawOptions: SyncOptions = {}) {
  const prisma = getPrismaClient();
  const userDatabaseUrl = process.env.USER_DATABASE_URL ?? process.env.USER_BACKEND_DATABASE_URL;

  if (!userDatabaseUrl) {
    throw new Error('缺少 USER_DATABASE_URL（或 USER_BACKEND_DATABASE_URL）环境变量，无法连接用户数据库。');
  }

  const requestedPoolId = String(rawOptions.poolId ?? PERMANENT_POOL_ID).trim() || PERMANENT_POOL_ID;
  if (requestedPoolId !== PERMANENT_POOL_ID) {
    throw new Error(`当前仅允许同步 ${PERMANENT_POOL_ID}（收到 poolId=${requestedPoolId}）。`);
  }
  if ((rawOptions.includeTags?.length ?? 0) > 0 || (rawOptions.excludeTags?.length ?? 0) > 0) {
    throw new Error('当前仅允许全量常驻主池，同步不再支持 include/exclude 标签过滤。');
  }
  if (rawOptions.cardIdPrefix && normalizeTagValue(rawOptions.cardIdPrefix) !== DEFAULT_CARD_ID_PREFIX) {
    throw new Error(`当前固定使用 ${DEFAULT_CARD_ID_PREFIX} 作为卡片 ID 前缀。`);
  }
  const options: Required<SyncOptions> = {
    poolId: PERMANENT_POOL_ID,
    poolName: rawOptions.poolName ?? '常驻卡池',
    description: rawOptions.description ?? '涵盖当前站内已收录文档的常驻卡池。',
    tokenCost: 10,
    tenDrawCost: 100,
    duplicateReward: 0,
    isActive: true,
    includeTags: [],
    includeMatch: 'any',
    excludeTags: [],
    cardIdPrefix: DEFAULT_CARD_ID_PREFIX,
    dryRun: rawOptions.dryRun ?? false,
    limit: rawOptions.limit ?? 0
  };

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
  let deferredPendingImagePages = 0;

  try {
    const createdById = await resolvePoolCreator(userDbClient);
    const fullSync = options.limit <= 0;

    const existingCardsResult = await userDbClient.query<ExistingCardRow>(
      `
        SELECT "id", "weight", "pageId", "imageUrl", "variantKey"
        FROM "GachaCardDefinition"
        WHERE "poolId" = $1
      `,
      [options.poolId]
    );
    const existingCards = existingCardsResult.rows ?? [];
    const existingCardsByPage = new Map<number, ExistingCardRow[]>();
    const existingPageCardIds = new Set<string>();
    for (const card of existingCards) {
      if (card.pageId != null) {
        existingPageCardIds.add(card.id);
        const list = existingCardsByPage.get(card.pageId);
        if (list) {
          list.push(card);
        } else {
          existingCardsByPage.set(card.pageId, [card]);
        }
      }
    }

    const newCardIds = new Set<string>();

    if (!options.dryRun) {
      await userDbClient.query('BEGIN');
      await upsertPool(userDbClient, { ...options, createdById });
      await deleteNonPermanentPools(userDbClient);
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
          (
            SELECT COUNT(*)::int
            FROM "PageVersionImage" pvi
            WHERE pvi."pageVersionId" = pv.id
          ) AS "imageRefCount",
          COALESCE(
            (
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
                  fpvi.id AS "fallbackPviId",
                  fpvi."imageAssetId" AS "fallbackAssetId",
                  fpvi."displayUrl" AS "fallbackDisplayUrl",
                  fpvi."originUrl" AS "fallbackOriginUrl",
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
                  COALESCE(rc."displayUrl", rc."normalizedUrl", rc."originUrl") AS url,
                  rc."normalizedUrl" AS "normalizedUrl",
                  rc."hashSha256" AS "hashSha256"
                FROM resolved_current rc
                UNION ALL
                SELECT
                  u."pageVersionImageId" AS sort_id,
                  f."fallbackAssetId" AS "imageAssetId",
                  COALESCE(
                    u."displayUrl",
                    f."fallbackDisplayUrl",
                    u."normalizedUrl",
                    u."originUrl",
                    f."fallbackOriginUrl"
                  ) AS url,
                  u."normalizedUrl" AS "normalizedUrl",
                  f."hashSha256" AS "hashSha256"
                FROM unresolved u
                JOIN fallback f ON f."normalizedUrl" = u."normalizedUrl"
              )
              SELECT json_agg(
                json_build_object(
                  'assetId', m."imageAssetId",
                  'url', m.url,
                  'normalizedUrl', m."normalizedUrl",
                  'hashSha256', m."hashSha256"
                )
                ORDER BY m.sort_id
              )
              FROM merged m
              WHERE m."imageAssetId" IS NOT NULL
            ),
            '[]'::json
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
        const existingPageCards = existingCardsByPage.get(row.pageId) ?? [];
        const pageCards = buildImageVariants(
          row,
          options.poolId,
          options.cardIdPrefix!,
          existingPageCards,
          authorKeysByPage.get(row.pageId)
        );
        if (pageCards.length === 0 && row.imageRefCount > 0 && existingPageCards.length > 0) {
          deferredPendingImagePages += 1;
          for (const card of existingPageCards) {
            newCardIds.add(card.id);
          }
        }
        return pageCards;
      });

      skippedByFilter += rows.length - matchedPageCount;

      if (remaining !== null && cards.length > remaining) {
        cards = cards.slice(0, remaining);
      }
      for (const card of cards) {
        newCardIds.add(card.id);
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
    if (deferredPendingImagePages > 0) {
      console.log(`已跳过：${deferredPendingImagePages} 个页面当前存在图片引用但暂无可用封面，保留既有卡片等待后续同步。`);
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
