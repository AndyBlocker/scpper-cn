/**
 * gachaConsolidateVariants.ts
 *
 * 将每页 4 张 affix-variant 卡（base/mono/gilded/azure）合并为 1 张 base 卡。
 * 所有外键引用（GachaCardInstance, GachaInventory, GachaCardUnlock,
 * GachaTradeListing, GachaBuyRequest, GachaBuyRequestOfferedCard,
 * GachaPlacementSlot, GachaDrawItem）都重定向到 base 卡。
 *
 * 支持 --dry-run 模式预览变更。
 */
import { prisma } from '../db.js';

const VARIANT_SUFFIXES = ['-mono', '-gilded', '-azure'];

interface ConsolidateSummary {
  dryRun: boolean;
  pagesScanned: number;
  derivedCardsFound: number;
  instancesRepointed: number;
  inventoriesMerged: number;
  inventoriesDeleted: number;
  unlocksEnsured: number;
  tradeListingsRepointed: number;
  buyRequestsRepointed: number;
  buyRequestOfferedCardsRepointed: number;
  placementSlotsRepointed: number;
  drawItemsRepointed: number;
  cardDefinitionsDeleted: number;
}

export async function consolidateVariants(opts: { dryRun?: boolean } = {}): Promise<ConsolidateSummary> {
  const dryRun = opts.dryRun ?? false;

  const summary: ConsolidateSummary = {
    dryRun,
    pagesScanned: 0,
    derivedCardsFound: 0,
    instancesRepointed: 0,
    inventoriesMerged: 0,
    inventoriesDeleted: 0,
    unlocksEnsured: 0,
    tradeListingsRepointed: 0,
    buyRequestsRepointed: 0,
    buyRequestOfferedCardsRepointed: 0,
    placementSlotsRepointed: 0,
    drawItemsRepointed: 0,
    cardDefinitionsDeleted: 0,
  };

  // Step 1: Load all card definitions and group by pageId
  const allCards = await prisma.gachaCardDefinition.findMany({
    where: { pageId: { not: null } },
    select: { id: true, pageId: true, poolId: true },
    orderBy: { id: 'asc' },
  });

  // Group by pageId
  const byPage = new Map<number, typeof allCards>();
  for (const card of allCards) {
    if (card.pageId == null) continue;
    const list = byPage.get(card.pageId) ?? [];
    list.push(card);
    byPage.set(card.pageId, list);
  }

  summary.pagesScanned = byPage.size;

  // Identify base card and derived cards per page
  const merges: Array<{ baseCardId: string; derivedCardIds: string[] }> = [];

  for (const [, cards] of byPage) {
    // Find the base card (ID doesn't end with any variant suffix)
    const baseCard = cards.find((c) =>
      !VARIANT_SUFFIXES.some((suffix) => c.id.endsWith(suffix))
    );
    if (!baseCard) continue;

    const derivedCardIds = cards
      .filter((c) => c.id !== baseCard.id && VARIANT_SUFFIXES.some((suffix) => c.id.endsWith(suffix)))
      .map((c) => c.id);

    if (derivedCardIds.length === 0) continue;
    merges.push({ baseCardId: baseCard.id, derivedCardIds });
    summary.derivedCardsFound += derivedCardIds.length;
  }

  if (merges.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[consolidate-variants] 未发现需要合并的衍生变体卡。');
    return summary;
  }

  // eslint-disable-next-line no-console
  console.log(`[consolidate-variants] 发现 ${merges.length} 组页面需要合并，共 ${summary.derivedCardsFound} 张衍生卡。`);

  if (dryRun) {
    // In dry-run mode, just count what would be affected
    for (const { baseCardId, derivedCardIds } of merges) {
      const instances = await prisma.gachaCardInstance.count({
        where: { cardId: { in: derivedCardIds } },
      });
      summary.instancesRepointed += instances;

      const inventories = await prisma.gachaInventory.count({
        where: { cardId: { in: derivedCardIds } },
      });
      summary.inventoriesMerged += inventories;

      const tradeListings = await prisma.gachaTradeListing.count({
        where: { cardId: { in: derivedCardIds } },
      });
      summary.tradeListingsRepointed += tradeListings;

      const buyRequests = await prisma.gachaBuyRequest.count({
        where: { targetCardId: { in: derivedCardIds } },
      });
      summary.buyRequestsRepointed += buyRequests;

      const offeredCards = await prisma.gachaBuyRequestOfferedCard.count({
        where: { cardId: { in: derivedCardIds } },
      });
      summary.buyRequestOfferedCardsRepointed += offeredCards;

      const slots = await prisma.gachaPlacementSlot.count({
        where: { cardId: { in: derivedCardIds } },
      });
      summary.placementSlotsRepointed += slots;

      const drawItems = await prisma.gachaDrawItem.count({
        where: { cardId: { in: derivedCardIds } },
      });
      summary.drawItemsRepointed += drawItems;

      // Count unlocks that would be ensured
      const derivedUnlocks = await prisma.gachaCardUnlock.findMany({
        where: { cardId: { in: derivedCardIds } },
        select: { userId: true },
      });
      const uniqueUsers = new Set(derivedUnlocks.map((u) => u.userId));
      summary.unlocksEnsured += uniqueUsers.size;

      summary.cardDefinitionsDeleted += derivedCardIds.length;
    }
    return summary;
  }

  // Step 2: Execute merge — one transaction per page group for robustness
  const BATCH_LOG_INTERVAL = 1000;
  let processed = 0;

  for (const { baseCardId, derivedCardIds } of merges) {
    await prisma.$transaction(async (tx) => {
      // 2a. Repoint GachaCardInstance
      const instanceResult = await tx.gachaCardInstance.updateMany({
        where: { cardId: { in: derivedCardIds } },
        data: { cardId: baseCardId },
      });
      summary.instancesRepointed += instanceResult.count;

      // 2b. Merge GachaInventory: for each derived inventory row,
      //     upsert into base card's inventory row
      const derivedInventories = await tx.gachaInventory.findMany({
        where: { cardId: { in: derivedCardIds } },
      });
      for (const inv of derivedInventories) {
        if (inv.count <= 0) {
          // Just delete zero-count inventory rows
          await tx.gachaInventory.delete({ where: { id: inv.id } });
          summary.inventoriesDeleted += 1;
          continue;
        }
        // Try to find existing base inventory for this user
        const baseInv = await tx.gachaInventory.findUnique({
          where: { userId_cardId: { userId: inv.userId, cardId: baseCardId } },
        });
        if (baseInv) {
          await tx.gachaInventory.update({
            where: { id: baseInv.id },
            data: { count: baseInv.count + inv.count },
          });
        } else {
          // Create new inventory row for base card
          await tx.gachaInventory.create({
            data: {
              userId: inv.userId,
              cardId: baseCardId,
              count: inv.count,
            },
          });
        }
        await tx.gachaInventory.delete({ where: { id: inv.id } });
        summary.inventoriesMerged += 1;
        summary.inventoriesDeleted += 1;
      }

      // 2c. Ensure GachaCardUnlock for base card
      const derivedUnlocks = await tx.gachaCardUnlock.findMany({
        where: { cardId: { in: derivedCardIds } },
        select: { userId: true, firstUnlockedAt: true },
      });
      for (const unlock of derivedUnlocks) {
        const existing = await tx.gachaCardUnlock.findUnique({
          where: { userId_cardId: { userId: unlock.userId, cardId: baseCardId } },
        });
        if (!existing) {
          await tx.gachaCardUnlock.create({
            data: {
              userId: unlock.userId,
              cardId: baseCardId,
              firstUnlockedAt: unlock.firstUnlockedAt,
            },
          });
          summary.unlocksEnsured += 1;
        }
      }
      // Delete derived unlocks
      await tx.gachaCardUnlock.deleteMany({
        where: { cardId: { in: derivedCardIds } },
      });

      // 2d. Repoint GachaTradeListing
      const tradeResult = await tx.gachaTradeListing.updateMany({
        where: { cardId: { in: derivedCardIds } },
        data: { cardId: baseCardId },
      });
      summary.tradeListingsRepointed += tradeResult.count;

      // 2e. Repoint GachaBuyRequest.targetCardId
      const buyReqResult = await tx.gachaBuyRequest.updateMany({
        where: { targetCardId: { in: derivedCardIds } },
        data: { targetCardId: baseCardId },
      });
      summary.buyRequestsRepointed += buyReqResult.count;

      // 2f. Repoint GachaBuyRequestOfferedCard.cardId
      const offeredResult = await tx.gachaBuyRequestOfferedCard.updateMany({
        where: { cardId: { in: derivedCardIds } },
        data: { cardId: baseCardId },
      });
      summary.buyRequestOfferedCardsRepointed += offeredResult.count;

      // 2g. Repoint GachaPlacementSlot.cardId
      const slotResult = await tx.gachaPlacementSlot.updateMany({
        where: { cardId: { in: derivedCardIds } },
        data: { cardId: baseCardId },
      });
      summary.placementSlotsRepointed += slotResult.count;

      // 2h. Repoint GachaDrawItem.cardId
      const drawItemResult = await tx.gachaDrawItem.updateMany({
        where: { cardId: { in: derivedCardIds } },
        data: { cardId: baseCardId },
      });
      summary.drawItemsRepointed += drawItemResult.count;

      // 2i. Delete derived CardDefinitions (now with no references)
      const deleteResult = await tx.gachaCardDefinition.deleteMany({
        where: { id: { in: derivedCardIds } },
      });
      summary.cardDefinitionsDeleted += deleteResult.count;
    }, { timeout: 30_000 });

    processed += 1;
    if (processed % BATCH_LOG_INTERVAL === 0) {
      // eslint-disable-next-line no-console
      console.log(`[consolidate-variants] 已处理 ${processed} / ${merges.length} 组页面...`);
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[consolidate-variants] 合并完成，共处理 ${processed} 组页面。`);

  return summary;
}
