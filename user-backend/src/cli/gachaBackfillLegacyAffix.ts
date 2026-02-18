import { GachaAffixVisualStyle, Prisma } from '@prisma/client';
import { prisma } from '../db.js';

const AFFIX_STYLE_VALUES = ['NONE', 'MONO', 'SILVER', 'GOLD', 'CYAN', 'PRISM', 'COLORLESS'] as const;
type AffixStyle = typeof AFFIX_STYLE_VALUES[number];
type LegacyAffixStyle = Exclude<AffixStyle, 'NONE'>;
type AffixStackMap = Record<AffixStyle, number>;

const DEFAULT_BATCH_SIZE = 300;
const AFFIX_STACK_CONSUME_PRIORITY: AffixStyle[] = ['NONE', 'MONO', 'SILVER', 'CYAN', 'PRISM', 'GOLD', 'COLORLESS'];
const NON_NONE_AFFIX_STYLES: LegacyAffixStyle[] = ['MONO', 'SILVER', 'GOLD', 'CYAN', 'PRISM', 'COLORLESS'];

const AFFIX_STYLE_LABEL: Record<AffixStyle, string> = {
  NONE: '标准',
  MONO: '黑白',
  SILVER: '银镀层',
  GOLD: '金镀层',
  CYAN: '青镀层',
  PRISM: '棱镜',
  COLORLESS: '无色异化'
};

const AFFIX_KEYWORDS: Record<LegacyAffixStyle, string[]> = {
  MONO: ['mono', 'locked', 'lock', 'noir', 'blackwhite', 'black-white', '黑白', '单色', '灰度', '锁定'],
  SILVER: ['silver', 'chrome', 'argent', 'free-slot', 'freeslot', '空槽', '银色', '银镀层'],
  GOLD: ['gold', 'gilded', 'foil', 'yieldboost', 'yield-boost', '镀金', '金箔', '鎏金', '产出加成'],
  CYAN: ['cyan', 'azure', 'blueprint', 'offlinebuffer', 'offline-buffer', '青色', '蓝图', '离线缓冲'],
  PRISM: ['prism', 'holo', 'rainbow', 'dismantlebonus', 'dismantle-bonus', '彩虹', '棱镜', '分解加成'],
  COLORLESS: ['colorless', 'achromatic', 'void', 'blank', '无色', '异化', '透明', '无相']
};

const AFFIX_KEYWORD_STYLE_MAP = (() => {
  const map = new Map<string, LegacyAffixStyle>();
  for (const style of Object.keys(AFFIX_KEYWORDS) as LegacyAffixStyle[]) {
    for (const keyword of AFFIX_KEYWORDS[style]) {
      const normalized = keyword.trim().toLowerCase().replace(/[\s_]+/g, '').replace(/-/g, '');
      if (!normalized) continue;
      map.set(normalized, style);
    }
  }
  return map;
})();

export type BackfillLegacyAffixOptions = {
  userId?: string;
  dryRun?: boolean;
  batchSize?: number;
};

export type BackfillLegacyAffixSummary = {
  dryRun: boolean;
  scope: 'all' | 'user';
  userId?: string;
  inventoryScanned: number;
  inventoryUpdated: number;
  inventoryNullBefore: number;
  inventoryLegacyApplied: number;
  placementScanned: number;
  placementUpdated: number;
  placementLegacyApplied: number;
};

function normalizeAffixToken(value: string) {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '').replace(/-/g, '');
}

function normalizeAffixVisualStyleInput(value: unknown): AffixStyle {
  const raw = String(value ?? '').trim().toUpperCase();
  return (AFFIX_STYLE_VALUES as readonly string[]).includes(raw)
    ? raw as AffixStyle
    : 'NONE';
}

function resolveExplicitAffixStyleFromTags(tags: string[]) {
  for (const rawTag of tags) {
    const tag = String(rawTag || '').trim();
    if (!tag) continue;
    const normalized = normalizeAffixToken(tag);
    if (!normalized) continue;
    const direct = AFFIX_KEYWORD_STYLE_MAP.get(normalized);
    if (direct) return direct;

    let prefixed: string | null = null;
    if (normalized.startsWith('affix:')) {
      prefixed = normalized.slice('affix:'.length);
    } else if (normalized.startsWith('词条:')) {
      prefixed = normalized.slice('词条:'.length);
    } else if (normalized.startsWith('variant:')) {
      prefixed = normalized.slice('variant:'.length);
    }
    if (!prefixed) continue;
    const fromPrefix = AFFIX_KEYWORD_STYLE_MAP.get(prefixed);
    if (fromPrefix) return fromPrefix;
  }
  return null;
}

function inferAffixVisualStyleFromTitle(title: string): LegacyAffixStyle | null {
  const normalizedTitle = normalizeAffixToken(title || '');
  if (!normalizedTitle) return null;
  const hasAffixMarker = normalizedTitle.includes('词条')
    || normalizedTitle.includes('affix')
    || normalizedTitle.includes('版本')
    || normalizedTitle.includes('variant')
    || normalizedTitle.includes('version');
  if (!hasAffixMarker) return null;
  for (const style of Object.keys(AFFIX_KEYWORDS) as LegacyAffixStyle[]) {
    const keywords = AFFIX_KEYWORDS[style];
    if (keywords.some((keyword) => normalizedTitle.includes(normalizeAffixToken(keyword)))) {
      return style;
    }
  }
  return null;
}

function inferLegacyAffixStyle(card: { title: string; tags?: string[] | null }) {
  const normalizedTags = (card.tags ?? [])
    .filter((tag) => typeof tag === 'string')
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0);
  const explicit = resolveExplicitAffixStyleFromTags(normalizedTags);
  if (explicit) return explicit;
  return inferAffixVisualStyleFromTitle(card.title);
}

function emptyAffixStackMap(): AffixStackMap {
  return {
    NONE: 0,
    MONO: 0,
    SILVER: 0,
    GOLD: 0,
    CYAN: 0,
    PRISM: 0,
    COLORLESS: 0
  };
}

function parseAffixStacks(raw: Prisma.JsonValue | null | undefined): AffixStackMap {
  const map = emptyAffixStackMap();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return map;
  }
  const json = raw as Record<string, unknown>;
  for (const style of AFFIX_STYLE_VALUES) {
    const value = Number(json[style]);
    map[style] = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  }
  return map;
}

function serializeAffixStacks(map: AffixStackMap): Prisma.JsonObject {
  const output: Record<string, number> = {};
  for (const style of AFFIX_STYLE_VALUES) {
    output[style] = Math.max(0, Math.floor(map[style] ?? 0));
  }
  return output;
}

function affixStackTotal(map: AffixStackMap) {
  return AFFIX_STYLE_VALUES.reduce((sum, style) => sum + Math.max(0, Math.floor(map[style] ?? 0)), 0);
}

function nonNoneAffixStackTotal(map: AffixStackMap) {
  return NON_NONE_AFFIX_STYLES.reduce((sum, style) => sum + Math.max(0, Math.floor(map[style] ?? 0)), 0);
}

function resolvePrimaryAffixStyleFromStacks(map: AffixStackMap): AffixStyle {
  const entries = AFFIX_STYLE_VALUES
    .map((style) => ({
      style,
      count: Math.max(0, Math.floor(map[style] ?? 0))
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => {
      if (a.count !== b.count) return b.count - a.count;
      return AFFIX_STYLE_VALUES.indexOf(a.style) - AFFIX_STYLE_VALUES.indexOf(b.style);
    });
  return entries[0]?.style ?? 'NONE';
}

function alignAffixStackToCount(map: AffixStackMap, count: number, legacyStyle: LegacyAffixStyle | null) {
  const normalizedCount = Math.max(0, Math.floor(Number(count) || 0));
  let legacyApplied = false;

  if (legacyStyle && normalizedCount > 0) {
    const nonNone = nonNoneAffixStackTotal(map);
    if (nonNone === 0 && map[legacyStyle] <= 0 && map.NONE > 0) {
      map[legacyStyle] += map.NONE;
      map.NONE = 0;
      legacyApplied = true;
    }
  }

  let total = affixStackTotal(map);
  if (total < normalizedCount) {
    const nonNone = nonNoneAffixStackTotal(map);
    const fillStyle: AffixStyle = legacyStyle && nonNone === 0
      ? legacyStyle
      : total > 0
        ? resolvePrimaryAffixStyleFromStacks(map)
        : (legacyStyle ?? 'NONE');
    map[fillStyle] += (normalizedCount - total);
    legacyApplied = legacyApplied || (Boolean(legacyStyle) && fillStyle === legacyStyle);
    total = normalizedCount;
  }
  if (total > normalizedCount) {
    let overflow = total - normalizedCount;
    for (const style of AFFIX_STACK_CONSUME_PRIORITY) {
      if (overflow <= 0) break;
      const current = Math.max(0, Math.floor(map[style] ?? 0));
      if (current <= 0) continue;
      const deduct = Math.min(current, overflow);
      map[style] -= deduct;
      overflow -= deduct;
    }
  }

  return {
    map,
    legacyApplied
  };
}

function mapEquals(left: AffixStackMap, right: AffixStackMap) {
  for (const style of AFFIX_STYLE_VALUES) {
    if (left[style] !== right[style]) return false;
  }
  return true;
}

export async function backfillGachaLegacyAffix(options: BackfillLegacyAffixOptions = {}): Promise<BackfillLegacyAffixSummary> {
  const dryRun = options.dryRun === true;
  const userId = options.userId?.trim() || undefined;
  const scope: 'all' | 'user' = userId ? 'user' : 'all';
  const batchSize = Math.max(50, Math.min(2000, Math.floor(options.batchSize || DEFAULT_BATCH_SIZE)));
  const summary: BackfillLegacyAffixSummary = {
    dryRun,
    scope,
    userId,
    inventoryScanned: 0,
    inventoryUpdated: 0,
    inventoryNullBefore: 0,
    inventoryLegacyApplied: 0,
    placementScanned: 0,
    placementUpdated: 0,
    placementLegacyApplied: 0
  };

  const inventoryWhere: Prisma.GachaInventoryWhereInput = {
    count: { gt: 0 },
    ...(userId ? { userId } : {})
  };

  let inventoryCursorId: string | undefined;
  while (true) {
    const rows = await prisma.gachaInventory.findMany({
      where: inventoryWhere,
      include: {
        card: {
          select: {
            title: true,
            tags: true
          }
        }
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(inventoryCursorId ? { cursor: { id: inventoryCursorId }, skip: 1 } : {})
    });
    if (rows.length === 0) break;
    inventoryCursorId = rows[rows.length - 1].id;

    const updates: Array<{ id: string; affixStacks: Prisma.JsonObject; legacyApplied: boolean; fromNull: boolean }> = [];
    for (const row of rows) {
      summary.inventoryScanned += 1;
      const fromNull = row.affixStacks == null;
      const beforeMap = parseAffixStacks(row.affixStacks);
      const normalizedBefore = serializeAffixStacks(beforeMap);
      const legacyStyle = inferLegacyAffixStyle({
        title: row.card.title,
        tags: row.card.tags
      });
      const aligned = alignAffixStackToCount(beforeMap, row.count, legacyStyle);
      const normalizedAfter = serializeAffixStacks(aligned.map);
      const needsUpdate = fromNull || !mapEquals(
        normalizedBefore as unknown as AffixStackMap,
        normalizedAfter as unknown as AffixStackMap
      );
      if (!needsUpdate) continue;
      updates.push({
        id: row.id,
        affixStacks: normalizedAfter,
        legacyApplied: aligned.legacyApplied,
        fromNull
      });
    }

    if (!dryRun && updates.length > 0) {
      await prisma.$transaction(updates.map((entry) => prisma.gachaInventory.update({
        where: { id: entry.id },
        data: {
          affixStacks: entry.affixStacks
        }
      })));
    }

    summary.inventoryUpdated += updates.length;
    summary.inventoryNullBefore += updates.filter((entry) => entry.fromNull).length;
    summary.inventoryLegacyApplied += updates.filter((entry) => entry.legacyApplied).length;
  }

  const placementWhere: Prisma.GachaPlacementSlotWhereInput = {
    cardId: { not: null },
    ...(userId ? { userId } : {})
  };

  let placementCursorId: string | undefined;
  while (true) {
    const rows = await prisma.gachaPlacementSlot.findMany({
      where: placementWhere,
      include: {
        card: {
          select: {
            title: true,
            tags: true
          }
        }
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(placementCursorId ? { cursor: { id: placementCursorId }, skip: 1 } : {})
    });
    if (rows.length === 0) break;
    placementCursorId = rows[rows.length - 1].id;

    const updates: Array<{ id: string; style: AffixStyle; label: string; legacyApplied: boolean }> = [];
    for (const row of rows) {
      summary.placementScanned += 1;
      if (!row.card) continue;
      const currentStyle = normalizeAffixVisualStyleInput(row.affixVisualStyle);
      const legacyStyle = inferLegacyAffixStyle({
        title: row.card.title,
        tags: row.card.tags
      });
      const targetStyle: AffixStyle = currentStyle === 'NONE' && legacyStyle
        ? legacyStyle
        : currentStyle;
      const targetLabel = AFFIX_STYLE_LABEL[targetStyle];
      const currentLabel = String(row.affixLabel || '').trim();
      const needsUpdate = currentStyle !== targetStyle || currentLabel !== targetLabel;
      if (!needsUpdate) continue;
      updates.push({
        id: row.id,
        style: targetStyle,
        label: targetLabel,
        legacyApplied: currentStyle === 'NONE' && targetStyle !== 'NONE'
      });
    }

    if (!dryRun && updates.length > 0) {
      await prisma.$transaction(updates.map((entry) => prisma.gachaPlacementSlot.update({
        where: { id: entry.id },
        data: {
          affixVisualStyle: entry.style as GachaAffixVisualStyle,
          affixLabel: entry.label
        }
      })));
    }

    summary.placementUpdated += updates.length;
    summary.placementLegacyApplied += updates.filter((entry) => entry.legacyApplied).length;
  }

  return summary;
}
