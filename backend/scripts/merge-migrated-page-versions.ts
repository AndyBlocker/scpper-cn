import { Command } from 'commander';
import { DatabaseStore } from '../src/core/store/DatabaseStore.js';
import { Logger } from '../src/utils/Logger.js';

const program = new Command();

program
  .option('--since <date>', '只处理在该日期之后创建的页面（ISO 日期，例如 2025-08-01）')
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

    const pages = await prisma.page.findMany({
      where: {
        isDeleted: true,
        ...(sinceDate ? { createdAt: { gte: sinceDate } } : {}),
        ...(wikidotIds.length > 0 ? { wikidotId: { in: wikidotIds } } : {})
      },
      orderBy: { createdAt: 'asc' },
      take: options.limit && Number.isFinite(options.limit) ? Math.max(1, options.limit) : undefined,
      select: {
        id: true,
        wikidotId: true,
        currentUrl: true,
        createdAt: true,
        versions: {
          orderBy: { validFrom: 'desc' },
          select: {
            id: true,
            validFrom: true,
            validTo: true,
            source: true,
            textContent: true,
            category: true,
            tags: true,
            title: true,
            alternateTitle: true,
            attributionCount: true,
            rating: true,
            voteCount: true
          }
        }
      }
    });

    const targets = pages
      .map((page) => {
        if (!page.versions || page.versions.length < 2) return null;
        const [latest, previous] = page.versions;
        if (!latest || !previous) return null;
        if (latest.validTo !== null && latest.validTo !== undefined) return null;
        const cutoff = sinceDate ?? new Date('2025-08-01T00:00:00Z');
        if (latest.validFrom < cutoff) return null;
        return { page, latest, previous };
      })
      .filter(Boolean) as Array<{
        page: typeof pages[number];
        latest: typeof pages[number]['versions'][number];
        previous: typeof pages[number]['versions'][number];
      }>;

    if (targets.length === 0) {
      Logger.info('未发现需要合并版本的页面。');
      return;
    }

    Logger.info(`待合并页面数量：${targets.length}${options.dryRun ? '（dry-run 模式）' : ''}`);

    if (options.dryRun) {
      for (const item of targets) {
        Logger.info(`  - wikidotId=${item.page.wikidotId} url=${item.page.currentUrl}`);
      }
      return;
    }

    let merged = 0;

    for (const { page, latest, previous } of targets) {
      try {
        await prisma.$transaction(async (tx) => {
          const updateData: Record<string, unknown> = { updatedAt: new Date(), validTo: null };
          if (latest.source) updateData.source = latest.source;
          if (latest.textContent) updateData.textContent = latest.textContent;
          if (latest.category !== undefined) updateData.category = latest.category;
          if (Array.isArray(latest.tags) && latest.tags.length > 0) updateData.tags = latest.tags;
          if (latest.title && latest.title !== previous.title) updateData.title = latest.title;
          if (latest.alternateTitle !== undefined) updateData.alternateTitle = latest.alternateTitle;
          if (latest.attributionCount !== undefined) updateData.attributionCount = latest.attributionCount;

          await tx.pageVersion.update({
            where: { id: previous.id },
            data: updateData
          });

          await tx.attribution.updateMany({
            where: { pageVerId: latest.id },
            data: { pageVerId: previous.id }
          });

          await tx.pageVersionImage.updateMany({
            where: { pageVersionId: latest.id },
            data: { pageVersionId: previous.id }
          });

          await tx.pageReference.updateMany({
            where: { pageVersionId: latest.id },
            data: { pageVersionId: previous.id }
          });

          await tx.sourceVersion.updateMany({
            where: { pageVersionId: latest.id },
            data: { pageVersionId: previous.id }
          });

          await tx.vote.updateMany({
            where: { pageVersionId: latest.id },
            data: { pageVersionId: previous.id }
          });

          await tx.revision.updateMany({
            where: { pageVersionId: latest.id },
            data: { pageVersionId: previous.id }
          });

          await tx.pageStats.deleteMany({ where: { pageVersionId: latest.id } });

          await tx.pageVersion.delete({
            where: { id: latest.id }
          });
        });

        merged++;
      } catch (err) {
        Logger.error(`合并页面 ${page.wikidotId} 失败：${(err as Error).message}`);
      }
    }

    Logger.info(`合并完成：${merged}/${targets.length}`);
  } finally {
    await store.disconnect();
  }
}

main().catch((err) => {
  Logger.error('merge-migrated-page-versions 脚本失败', err);
  process.exit(1);
});
