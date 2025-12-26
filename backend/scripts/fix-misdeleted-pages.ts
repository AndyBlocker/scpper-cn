import { Command } from 'commander';
import { DatabaseStore } from '../src/core/store/DatabaseStore.js';
import { Logger } from '../src/utils/Logger.js';

const program = new Command();

program
  .option('--wikidot-id <id...>', '仅修复指定 wikidotId（可多次传入或逗号分隔）')
  .option('--limit <n>', '最多处理的页面数量', (value) => parseInt(value, 10))
  .option('--dry-run', '仅打印将要修复的页面，不执行写入')
  .parse(process.argv);

const options = program.opts<{
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

    Logger.info('扫描 Page / PageVersion 删除状态不一致的页面...');

    const pages = await prisma.page.findMany({
      where: {
        isDeleted: true,
        ...(wikidotIds.length > 0 ? { wikidotId: { in: wikidotIds } } : {})
      },
      orderBy: { id: 'asc' },
      take: options.limit && Number.isFinite(options.limit) ? Math.max(1, options.limit) : undefined,
      select: {
        id: true,
        wikidotId: true,
        isDeleted: true,
        currentUrl: true,
        url: true,
        versions: {
          orderBy: { validFrom: 'desc' },
          select: {
            id: true,
            isDeleted: true,
            validFrom: true,
            validTo: true
          }
        }
      }
    });

    if (pages.length === 0) {
      Logger.info('未找到 Page.isDeleted = true 的页面。');
      return;
    }

    const candidates = pages.filter((page) => {
      const versions = page.versions;
      if (!versions || versions.length === 0) {
        // 没有任何 PageVersion，但 Page 被标记为删除，必然需要修复
        return true;
      }

      const hasDeletedVersion = versions.some((v) => v.isDeleted === true);
      const current = versions.find((v) => v.validTo === null) ?? versions[0];

      // 规范约束：Page.isDeleted = true 时，应该存在至少一个删除版本，且当前版本应为删除版本
      if (!hasDeletedVersion) return true;
      if (!current) return true;
      if (!current.isDeleted) return true;

      return false;
    });

    if (candidates.length === 0) {
      Logger.info('未发现需要修复的页面：Page.isDeleted 与 PageVersion 删除状态一致。');
      return;
    }

    Logger.info(`发现 ${candidates.length} 个删除状态不一致的页面。`);

    if (options.dryRun) {
      Logger.info('Dry-run 模式，仅列出将要修复的页面：');
      for (const page of candidates) {
        const url = page.currentUrl || page.url || '(unknown)';
        Logger.info(`  - wikidotId=${page.wikidotId} pageId=${page.id} url=${url}`);
      }
      return;
    }

    let fixed = 0;
    let failed = 0;

    for (const page of candidates) {
      const url = page.currentUrl || page.url || '(unknown)';
      try {
        Logger.info(`修复页面删除状态：wikidotId=${page.wikidotId} pageId=${page.id} url=${url}`);
        await store.markPageDeleted(page.id);
        fixed += 1;
      } catch (err: any) {
        failed += 1;
        Logger.error(
          `修复页面失败：wikidotId=${page.wikidotId} pageId=${page.id} url=${url} 原因=${err?.message ?? String(err)}`
        );
      }
    }

    Logger.info(`修复完成：成功 ${fixed} 条，失败 ${failed} 条。`);
  } finally {
    await store.disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('fix-misdeleted-pages 脚本运行失败', err);
  process.exit(1);
});

