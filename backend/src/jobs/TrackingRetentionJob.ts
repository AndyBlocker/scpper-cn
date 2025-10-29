import { PrismaClient } from '@prisma/client';
import { getPrismaClient } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';

type TableConfig = {
  name: string;
};

export type TrackingRetentionOptions = {
  retentionDays?: number;
  batchSize?: number;
  dryRun?: boolean;
};

const DEFAULT_RETENTION_DAYS = 75;
const DEFAULT_BATCH_SIZE = 10_000;
const TABLES: TableConfig[] = [
  { name: 'PageViewEvent' },
  { name: 'UserPixelEvent' }
];

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

export class TrackingRetentionJob {
  private prisma: PrismaClient;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? getPrismaClient();
  }

  async run(options: TrackingRetentionOptions = {}): Promise<void> {
    const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    const dryRun = Boolean(options.dryRun);

    assertPositiveInteger(retentionDays, 'retentionDays');
    assertPositiveInteger(batchSize, 'batchSize');

    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const cutoffIso = cutoff.toISOString();
    Logger.info(
      `[tracking-retention] Starting purge with cutoff ${cutoffIso} (>= ${retentionDays} days old)${dryRun ? ' [dry-run]' : ''}`
    );

    for (const table of TABLES) {
      await this.purgeTable(table.name, cutoffIso, batchSize, dryRun);
    }
  }

  private async purgeTable(tableName: string, cutoffIso: string, batchSize: number, dryRun: boolean): Promise<void> {
    const eligibleCount = await this.countRowsOlderThan(tableName, cutoffIso);

    if (eligibleCount === 0) {
      Logger.info(`[tracking-retention] ${tableName}: no rows older than cutoff, skipping`);
      return;
    }

    if (dryRun) {
      Logger.info(
        `[tracking-retention] ${tableName}: ${eligibleCount.toLocaleString()} rows would be deleted (dry-run)`
      );
      return;
    }

    Logger.info(
      `[tracking-retention] ${tableName}: ${eligibleCount.toLocaleString()} rows queued for deletion (batch ${batchSize})`
    );

    let totalDeleted = 0;
    while (true) {
      const deleted = await this.prisma.$executeRawUnsafe<number>(
        `WITH doomed AS (
           SELECT id
           FROM "${tableName}"
           WHERE "createdAt" < $1::timestamptz
           ORDER BY "createdAt" ASC
           LIMIT $2
         )
         DELETE FROM "${tableName}"
         WHERE id IN (SELECT id FROM doomed);`,
        cutoffIso,
        batchSize
      );
      const deletedCount = Number(deleted) || 0;
      if (deletedCount === 0) {
        break;
      }
      totalDeleted += deletedCount;
      Logger.info(
        `[tracking-retention] ${tableName}: deleted ${deletedCount.toLocaleString()} rows (total ${totalDeleted.toLocaleString()})`
      );
      if (deletedCount < batchSize) {
        break;
      }
    }

    const remaining = await this.countRowsOlderThan(tableName, cutoffIso);
    if (remaining > 0) {
      Logger.warn(
        `[tracking-retention] ${tableName}: ${remaining.toLocaleString()} rows still older than cutoff after purge`
      );
    } else {
      Logger.info(`[tracking-retention] ${tableName}: completed purge, all rows within retention window`);
    }
  }

  private async countRowsOlderThan(tableName: string, cutoffIso: string): Promise<number> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT COUNT(*)::bigint AS count
         FROM "${tableName}"
        WHERE "createdAt" < $1::timestamptz`,
      cutoffIso
    );
    const raw = rows[0]?.count ?? 0n;
    return typeof raw === 'bigint' ? Number(raw) : Number(raw ?? 0);
  }
}
