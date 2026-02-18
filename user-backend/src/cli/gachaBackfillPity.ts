import { prisma } from '../db.js';

/**
 * 回填 GachaWallet 的 purplePityCount / goldPityCount。
 *
 * 算法：按时间正序遍历每个用户的所有 GachaDrawItem，
 * 模拟与 executeDrawForUser 完全一致的 pity 递增/重置逻辑，
 * 取遍历结束后的最终值写入钱包。
 *
 * pity 规则：
 *   GOLD   → purplePity = 0, goldPity = 0
 *   PURPLE → purplePity = 0, goldPity += 1
 *   其他    → purplePity += 1, goldPity += 1
 */

export type BackfillPityOptions = {
  userId?: string;
  dryRun?: boolean;
};

export type BackfillPitySummary = {
  dryRun: boolean;
  scope: 'single' | 'all';
  userId?: string;
  usersProcessed: number;
  usersUpdated: number;
  totalItemsScanned: number;
  details: Array<{
    userId: string;
    displayName: string;
    itemCount: number;
    purplePityCount: number;
    goldPityCount: number;
    changed: boolean;
  }>;
};

type RawDrawItem = {
  rarity: string;
};

export async function backfillGachaPityCounters(
  options: BackfillPityOptions = {}
): Promise<BackfillPitySummary> {
  const dryRun = options.dryRun ?? false;
  const scope = options.userId ? 'single' : 'all';

  // 找到需要回填的钱包
  const walletWhere = options.userId ? { userId: options.userId } : {};
  const wallets = await prisma.gachaWallet.findMany({
    where: walletWhere,
    select: {
      id: true,
      userId: true,
      purplePityCount: true,
      goldPityCount: true,
      user: { select: { displayName: true, email: true } }
    }
  });

  const summary: BackfillPitySummary = {
    dryRun,
    scope,
    userId: options.userId,
    usersProcessed: 0,
    usersUpdated: 0,
    totalItemsScanned: 0,
    details: []
  };

  for (const wallet of wallets) {
    // 按时间正序取该用户的所有抽卡物品
    // GachaDrawItem 通过 GachaDraw 关联到用户
    const items: RawDrawItem[] = await prisma.$queryRaw`
      SELECT di.rarity
      FROM "GachaDrawItem" di
      JOIN "GachaDraw" d ON di."drawId" = d.id
      WHERE d."userId" = ${wallet.userId}
      ORDER BY d."createdAt" ASC, di."createdAt" ASC
    `;

    let purplePity = 0;
    let goldPity = 0;

    for (const item of items) {
      if (item.rarity === 'GOLD') {
        purplePity = 0;
        goldPity = 0;
      } else if (item.rarity === 'PURPLE') {
        purplePity = 0;
        goldPity += 1;
      } else {
        purplePity += 1;
        goldPity += 1;
      }
    }

    const changed =
      wallet.purplePityCount !== purplePity ||
      wallet.goldPityCount !== goldPity;

    summary.usersProcessed += 1;
    summary.totalItemsScanned += items.length;
    summary.details.push({
      userId: wallet.userId,
      displayName: wallet.user?.displayName || wallet.user?.email || wallet.userId,
      itemCount: items.length,
      purplePityCount: purplePity,
      goldPityCount: goldPity,
      changed
    });

    if (changed && !dryRun) {
      await prisma.gachaWallet.update({
        where: { id: wallet.id },
        data: {
          purplePityCount: purplePity,
          goldPityCount: goldPity
        }
      });
      summary.usersUpdated += 1;
    } else if (changed) {
      summary.usersUpdated += 1;
    }
  }

  return summary;
}
