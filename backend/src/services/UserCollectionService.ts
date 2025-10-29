import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';

export class UserCollectionService {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma || getPrismaClient();
  }

  /**
   * Remove items referencing deleted or missing pages.
   * Intended to be scheduled periodically to keep public collections clean.
   */
  async pruneInvalidItems(): Promise<{ removed: number }> {
    const removalResult = await this.prisma.$executeRaw`
      DELETE FROM "UserCollectionItem" uci
      USING "Page" p
      WHERE uci."pageId" = p.id
        AND (p."isDeleted" = true)
    `;

    const removed = typeof removalResult === 'number'
      ? removalResult
      : Array.isArray(removalResult) && removalResult.length > 0 && typeof removalResult[0] === 'number'
        ? removalResult[0]
        : 0;

    if (removed > 0) {
      Logger.info(`[collections] Pruned ${removed} invalid collection items referencing deleted pages.`);
    }

    return { removed };
  }
}
