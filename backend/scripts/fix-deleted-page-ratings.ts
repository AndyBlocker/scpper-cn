import { Command } from 'commander';
import { DatabaseStore } from '../src/core/store/DatabaseStore.js';
import { Logger } from '../src/utils/Logger.js';

const program = new Command();

program
  .option('--since <date>', '只处理在该日期之后创建的页面（ISO 日期）')
  .option('--wikidot-id <id...>', '仅处理指定 wikidotId（可多次传入或使用逗号分隔）')
  .option('--limit <n>', '最多处理的页面数量', (value) => parseInt(value, 10))
  .option('--dry-run', '仅打印待处理页面，不执行写入')
  .parse(process.argv);

const options = program.opts<{
  since?: string;
  wikidotId?: (string | string[])[];
  limit?: number;
  dryRun?: boolean;
}>();

type FixResult = {
  wikidotId: number;
  url: string;
  rating: number;
  upvotes: number;
  downvotes: number;
  status: 'updated' | 'skipped' | 'failed';
  reason?: string;
};

function parseWikidotIds(raw?: (string | string[])[]): number[] {
  if (!raw) return [];
  const flattened = raw.flatMap((entry) => (Array.isArray(entry) ? entry : String(entry).split(',')));
  const ids = flattened
    .map((value) => Number.parseInt(String(value).trim(), 10))
    .filter((value) => Number.isFinite(value) && value > 0);
  return Array.from(new Set(ids));
}

async function main(): Promise<void> {
  const store = new DatabaseStore();
  const prisma = store.prisma;

  try {
    const wikidotIds = parseWikidotIds(options.wikidotId);
    let sinceDate: Date | undefined;
    if (options.since) {
      const parsed = new Date(options.since);
      if (Number.isNaN(parsed.getTime())) {
        throw new Error(`无法解析 --since 参数：${options.since}`);
      }
      sinceDate = parsed;
    } else if (wikidotIds.length === 0) {
      sinceDate = new Date('2025-08-01T00:00:00Z');
      Logger.info('未指定 --since 或 --wikidot-id，默认仅处理 2025-08-01 之后新增的迁移页面。');
    }

    const whereClause: any = { isDeleted: true };
    if (wikidotIds.length > 0) {
      whereClause.wikidotId = { in: wikidotIds };
    } else if (sinceDate) {
      whereClause.createdAt = { gte: sinceDate };
    }

    const pages = await prisma.page.findMany({
      where: whereClause,
      orderBy: { createdAt: 'asc' },
      take: options.limit && Number.isFinite(options.limit) ? Math.max(1, options.limit) : undefined,
      select: {
        id: true,
        wikidotId: true,
        url: true,
        currentUrl: true,
        createdAt: true,
        versions: {
          where: { validTo: null },
          select: { id: true, rating: true, voteCount: true }
        }
      }
    });

    if (pages.length === 0) {
      Logger.info('未找到需要处理的已删除页面。');
      return;
    }

    Logger.info(`待处理页面数量：${pages.length}${options.dryRun ? '（dry-run 模式）' : ''}`);

    if (options.dryRun) {
      for (const page of pages) {
        Logger.info(`  - wikidotId=${page.wikidotId} url=${page.currentUrl || page.url}`);
      }
      return;
    }

    const results: FixResult[] = [];

    for (const page of pages) {
      const targetUrl = page.currentUrl || page.url;
      const currentVersion = page.versions[0] ?? null;
      if (!currentVersion) {
        results.push({
          wikidotId: page.wikidotId,
          url: targetUrl || '(unknown)',
          rating: 0,
          upvotes: 0,
          downvotes: 0,
          status: 'skipped',
          reason: '未找到活跃 PageVersion'
        });
        continue;
      }

      try {
        const stats = await prisma.$queryRawUnsafe<Array<{
          rating: number | null;
          upvotes: number | null;
          downvotes: number | null;
        }>>(
          `SELECT
              COALESCE(SUM(v.direction), 0) AS rating,
              COALESCE(SUM(CASE WHEN v.direction = 1 THEN 1 ELSE 0 END), 0) AS upvotes,
              COALESCE(SUM(CASE WHEN v.direction = -1 THEN 1 ELSE 0 END), 0) AS downvotes
             FROM "Vote" v
             JOIN "PageVersion" pv ON pv.id = v."pageVersionId"
            WHERE pv."pageId" = ${page.id}`
        );

        const agg = stats[0] ?? { rating: 0, upvotes: 0, downvotes: 0 };
        const rating = Number(agg.rating ?? 0) || 0;
        const upvotes = Number(agg.upvotes ?? 0) || 0;
        const downvotes = Number(agg.downvotes ?? 0) || 0;
        const totalVotes = upvotes + downvotes;

        await prisma.pageVersion.update({
          where: { id: currentVersion.id },
          data: {
            rating,
            voteCount: totalVotes,
            updatedAt: new Date()
          }
        });

        results.push({
          wikidotId: page.wikidotId,
          url: targetUrl || '(unknown)',
          rating,
          upvotes,
          downvotes,
          status: 'updated'
        });
      } catch (err: any) {
        results.push({
          wikidotId: page.wikidotId,
          url: targetUrl || '(unknown)',
          rating: 0,
          upvotes: 0,
          downvotes: 0,
          status: 'failed',
          reason: err?.message ?? String(err)
        });
      }
    }

    const updated = results.filter((r) => r.status === 'updated').length;
    const skipped = results.filter((r) => r.status === 'skipped');
    const failed = results.filter((r) => r.status === 'failed');

    Logger.info(`评分修正完成：${updated} 成功，${skipped.length} 跳过，${failed.length} 失败。`);

    if (skipped.length > 0) {
      Logger.info('跳过列表：');
      for (const item of skipped) {
        Logger.info(`  - wikidotId=${item.wikidotId} url=${item.url} 原因=${item.reason}`);
      }
    }

    if (failed.length > 0) {
      Logger.error('失败列表：');
      for (const item of failed) {
        Logger.error(`  - wikidotId=${item.wikidotId} url=${item.url} 原因=${item.reason}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await store.disconnect();
  }
}

main().catch((err) => {
  Logger.error('fix-deleted-page-ratings 脚本失败', err);
  process.exit(1);
});
