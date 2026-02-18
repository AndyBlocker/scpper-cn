import { Prisma, GachaAffixVisualStyle } from '@prisma/client';
import { prisma } from '../db.js';

const DEFAULT_BATCH_SIZE = 200;

const AFFIX_VISUAL_STYLE_VALUES: readonly string[] = [
  'NONE', 'MONO', 'SILVER', 'GOLD', 'CYAN', 'PRISM',
  'COLORLESS', 'WILDCARD', 'SPECTRUM', 'MIRROR', 'ORBIT', 'ECHO'
];

function normalizeAffixVisualStyleInput(value: unknown): GachaAffixVisualStyle {
  const raw = String(value ?? '').trim().toUpperCase();
  return AFFIX_VISUAL_STYLE_VALUES.includes(raw)
    ? raw as GachaAffixVisualStyle
    : 'NONE';
}

function normalizeAffixStyleList(rawStyles: unknown[]): GachaAffixVisualStyle[] {
  const normalized = rawStyles
    .map((s) => normalizeAffixVisualStyleInput(s))
    .filter((s) => s !== 'NONE')
    .slice(0, 3);
  if (normalized.length <= 0) return ['NONE' as GachaAffixVisualStyle];
  const ORDER = AFFIX_VISUAL_STYLE_VALUES;
  return [...normalized].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
}

function affixSignatureFromStyles(styles: GachaAffixVisualStyle[]) {
  const normalized = normalizeAffixStyleList(styles);
  if (normalized.length <= 0) return 'NONE';
  if (normalized.length === 1 && normalized[0] === 'NONE') return 'NONE';
  return normalized.join('+');
}

function parseAffixSignature(signatureRaw: unknown): GachaAffixVisualStyle[] {
  const raw = String(signatureRaw ?? '').trim().toUpperCase();
  if (!raw) return ['NONE' as GachaAffixVisualStyle];
  const tokens = raw.split('+').map((item) => item.trim()).filter(Boolean);
  return normalizeAffixStyleList(tokens);
}

function resolvePrimaryVisualStyle(signature: string): GachaAffixVisualStyle {
  const styles = parseAffixSignature(signature);
  const nonNone = styles.filter((s) => s !== 'NONE');
  return nonNone.length > 0 ? nonNone[0] : 'NONE';
}

function buildAffixLabel(signature: string): string {
  const LABELS: Record<string, string> = {
    NONE: '标准', MONO: '黑白', SILVER: '银镀层', GOLD: '金镀层',
    CYAN: '青镀层', PRISM: '棱镜', COLORLESS: '无色异化',
    WILDCARD: '万象', SPECTRUM: '光谱', MIRROR: '镜像',
    ORBIT: '星轨', ECHO: '回响'
  };
  const styles = parseAffixSignature(signature);
  const counts: Record<string, number> = {};
  for (const s of styles) {
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const nonNone = Object.entries(counts).filter(([k]) => k !== 'NONE');
  if (nonNone.length <= 0) return LABELS.NONE;
  return nonNone.map(([style, count]) => {
    const label = LABELS[style] ?? style;
    return count > 1 ? `${label}x${count}` : label;
  }).join(' + ');
}

/** Parse affixStacks JSON (variant map format) into { signature → count } */
function parseVariantMap(raw: Prisma.JsonValue | null | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return result;
  const json = raw as Record<string, unknown>;
  for (const [rawKey, rawValue] of Object.entries(json)) {
    const count = Math.max(0, Math.floor(Number(rawValue) || 0));
    if (count <= 0) continue;
    const signature = affixSignatureFromStyles(parseAffixSignature(rawKey));
    result[signature] = (result[signature] ?? 0) + count;
  }
  return result;
}

export type BackfillInstancesOptions = {
  userId?: string;
  dryRun?: boolean;
  batchSize?: number;
};

export type BackfillInstancesSummary = {
  dryRun: boolean;
  scope: 'all' | 'user';
  userId?: string;
  inventoryScanned: number;
  instancesCreated: number;
  tradeListingsProcessed: number;
  tradeInstancesCreated: number;
  placementSlotsScanned: number;
  placementSlotsLinked: number;
  placementSlotsUnmatched: number;
};

export async function backfillGachaInstances(options: BackfillInstancesOptions = {}): Promise<BackfillInstancesSummary> {
  const dryRun = options.dryRun === true;
  const userId = options.userId?.trim() || undefined;
  const scope: 'all' | 'user' = userId ? 'user' : 'all';
  const batchSize = Math.max(50, Math.min(2000, Math.floor(options.batchSize || DEFAULT_BATCH_SIZE)));

  const summary: BackfillInstancesSummary = {
    dryRun,
    scope,
    userId,
    inventoryScanned: 0,
    instancesCreated: 0,
    tradeListingsProcessed: 0,
    tradeInstancesCreated: 0,
    placementSlotsScanned: 0,
    placementSlotsLinked: 0,
    placementSlotsUnmatched: 0
  };

  const log = (msg: string) => {
    // eslint-disable-next-line no-console
    console.log(`[backfill-instances] ${msg}`);
  };

  // ─── Step 1: Expand inventory into instances ───
  log('Step 1: Expanding inventory into card instances...');

  const inventoryWhere: Prisma.GachaInventoryWhereInput = {
    count: { gt: 0 },
    ...(userId ? { userId } : {})
  };

  let inventoryCursorId: string | undefined;
  while (true) {
    const rows = await prisma.gachaInventory.findMany({
      where: inventoryWhere,
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(inventoryCursorId ? { cursor: { id: inventoryCursorId }, skip: 1 } : {})
    });
    if (rows.length === 0) break;
    inventoryCursorId = rows[rows.length - 1].id;

    const creates: Prisma.GachaCardInstanceCreateManyInput[] = [];
    for (const row of rows) {
      summary.inventoryScanned += 1;
      const variantMap = parseVariantMap(row.affixStacks);
      const totalFromMap = Object.values(variantMap).reduce((s, c) => s + c, 0);

      if (totalFromMap < row.count) {
        // Fill gap with NONE signature
        variantMap['NONE'] = (variantMap['NONE'] ?? 0) + (row.count - totalFromMap);
      }

      // ── Idempotent: compare at card level (user+card) to avoid variant drift ──
      const existingFreeCount = await prisma.gachaCardInstance.count({
        where: { userId: row.userId, cardId: row.cardId, tradeListingId: null }
      });
      const cardGap = row.count - existingFreeCount;
      if (cardGap <= 0) continue;

      // Distribute the gap across variants from the map
      let remaining = cardGap;
      for (const [signature, count] of Object.entries(variantMap)) {
        if (count <= 0 || remaining <= 0) continue;
        const toCreate = Math.min(count, remaining);
        const visualStyle = resolvePrimaryVisualStyle(signature);
        const label = buildAffixLabel(signature);
        for (let i = 0; i < toCreate; i++) {
          creates.push({
            userId: row.userId,
            cardId: row.cardId,
            affixVisualStyle: visualStyle,
            affixSignature: signature,
            affixLabel: label,
            obtainedVia: 'BACKFILL',
            tradeListingId: null
          });
        }
        remaining -= toCreate;
      }
    }

    if (!dryRun && creates.length > 0) {
      await prisma.gachaCardInstance.createMany({ data: creates });
    }
    summary.instancesCreated += creates.length;
    if (creates.length > 0) {
      log(`  batch: scanned ${rows.length} inventory rows → ${creates.length} instances`);
    }
  }
  log(`Step 1 complete: ${summary.inventoryScanned} inventory scanned, ${summary.instancesCreated} instances created`);

  // ─── Step 2: Handle active trade listings ───
  log('Step 2: Processing OPEN trade listings...');

  const tradeWhere: Prisma.GachaTradeListingWhereInput = {
    status: 'OPEN',
    ...(userId ? { sellerId: userId } : {})
  };

  let tradeCursorId: string | undefined;
  while (true) {
    const listings = await prisma.gachaTradeListing.findMany({
      where: tradeWhere,
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(tradeCursorId ? { cursor: { id: tradeCursorId }, skip: 1 } : {})
    });
    if (listings.length === 0) break;
    tradeCursorId = listings[listings.length - 1].id;

    for (const listing of listings) {
      summary.tradeListingsProcessed += 1;

      // ── Idempotent: skip if listing already has instances ──
      const existingTradeInstances = await prisma.gachaCardInstance.count({
        where: { tradeListingId: listing.id }
      });
      if (existingTradeInstances >= listing.remaining) continue;

      // Parse affixBreakdown from metadata
      const metadata = listing.metadata as Record<string, unknown> | null;
      const breakdown = metadata?.affixBreakdown as Array<{ affixSignature?: string; count?: number }> | null;

      const creates: Prisma.GachaCardInstanceCreateManyInput[] = [];

      if (breakdown && Array.isArray(breakdown)) {
        for (const entry of breakdown) {
          const sig = String(entry?.affixSignature || 'NONE');
          const signature = affixSignatureFromStyles(parseAffixSignature(sig));
          const count = Math.max(0, Math.floor(Number(entry?.count) || 0));
          const visualStyle = resolvePrimaryVisualStyle(signature);
          const label = buildAffixLabel(signature);
          for (let i = 0; i < count; i++) {
            creates.push({
              userId: listing.sellerId,
              cardId: listing.cardId,
              affixVisualStyle: visualStyle,
              affixSignature: signature,
              affixLabel: label,
              obtainedVia: 'BACKFILL_TRADE',
              tradeListingId: listing.id
            });
          }
        }
      }

      // If no breakdown or instances < remaining, fill with NONE
      const totalCreated = creates.length;
      if (totalCreated < listing.remaining) {
        const gap = listing.remaining - totalCreated;
        for (let i = 0; i < gap; i++) {
          creates.push({
            userId: listing.sellerId,
            cardId: listing.cardId,
            affixVisualStyle: 'NONE',
            affixSignature: 'NONE',
            affixLabel: '标准',
            obtainedVia: 'BACKFILL_TRADE',
            tradeListingId: listing.id
          });
        }
      }

      if (!dryRun && creates.length > 0) {
        await prisma.gachaCardInstance.createMany({ data: creates });
      }
      summary.tradeInstancesCreated += creates.length;
    }
  }
  log(`Step 2 complete: ${summary.tradeListingsProcessed} listings, ${summary.tradeInstancesCreated} trade instances`);

  // ─── Step 3: Link placement slots ───
  log('Step 3: Linking placement slots to instances...');

  const slotWhere: Prisma.GachaPlacementSlotWhereInput = {
    cardId: { not: null },
    instanceId: null,
    ...(userId ? { userId } : {})
  };

  let slotCursorId: string | undefined;
  while (true) {
    const slots = await prisma.gachaPlacementSlot.findMany({
      where: slotWhere,
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(slotCursorId ? { cursor: { id: slotCursorId }, skip: 1 } : {})
    });
    if (slots.length === 0) break;
    slotCursorId = slots[slots.length - 1].id;

    for (const slot of slots) {
      summary.placementSlotsScanned += 1;
      if (!slot.cardId) continue;

      const targetSignature = slot.affixSignature
        ? affixSignatureFromStyles(parseAffixSignature(slot.affixSignature))
        : 'NONE';

      // Find a free instance: same userId + cardId + affixSignature, not locked in trade, not already assigned to a slot
      const freeInstance = await prisma.gachaCardInstance.findFirst({
        where: {
          userId: slot.userId,
          cardId: slot.cardId,
          affixSignature: targetSignature,
          tradeListingId: null,
          placementSlot: null // not linked to any slot
        },
        orderBy: { obtainedAt: 'asc' }
      });

      if (freeInstance) {
        if (!dryRun) {
          await prisma.gachaPlacementSlot.update({
            where: { id: slot.id },
            data: { instanceId: freeInstance.id }
          });
        }
        summary.placementSlotsLinked += 1;
      } else {
        log(`  WARNING: No free instance for slot ${slot.id} (userId=${slot.userId}, cardId=${slot.cardId}, sig=${targetSignature})`);
        summary.placementSlotsUnmatched += 1;
      }
    }
  }
  log(`Step 3 complete: ${summary.placementSlotsScanned} slots scanned, ${summary.placementSlotsLinked} linked, ${summary.placementSlotsUnmatched} unmatched`);

  return summary;
}
