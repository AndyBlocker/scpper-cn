#!/usr/bin/env node

// 检查：于指定日期之后创建的已删除页面，其最新 PageVersion 的 tags 是否存在重复
// 用法示例：
//   node --import tsx/esm backend/scripts/check-deleted-duplicate-tags.ts --since 2025-10-29
//   npm run check:deleted-dup-tags -- --since 2025-10-29

import { Command } from 'commander';
import { getPrismaClient, disconnectPrisma } from '../src/utils/db-connection.js';

type DupReport = {
  wikidotId: number;
  pageId: number;
  url: string;
  createdAt: string;
  pageVersionId: number;
  isPvDeleted: boolean;
  tagsCount: number;
  uniqueTagsNormCount: number;
  duplicates: string; // 形如 tag1(x2)|tag2(x3)
};

function normalizeTag(tag: string): string {
  return String(tag ?? '')
    .trim()
    .toLowerCase();
}

function summarizeDuplicates(tags: string[]): { dupMap: Map<string, number>; uniqueCount: number } {
  const dupMap = new Map<string, number>();
  for (const t of tags) {
    const key = normalizeTag(t);
    if (!key) continue;
    dupMap.set(key, (dupMap.get(key) || 0) + 1);
  }
  return { dupMap, uniqueCount: Array.from(dupMap.keys()).length };
}

const program = new Command();
program
  .option('--since <date>', '仅检查该日期（含）之后创建的页面，ISO 日期，如 2025-10-29')
  .option('--limit <n>', '最多检查的页面数量', (val) => parseInt(String(val), 10))
  .option('--verbose', '打印含重复标签的完整 tags 列表');

async function main(): Promise<void> {
  program.parse(process.argv);
  const opts = program.opts<{ since?: string; limit?: number; verbose?: boolean }>();

  const sinceStr = opts.since ?? '2025-10-29';
  const since = new Date(sinceStr);
  if (Number.isNaN(since.getTime())) {
    console.error(`无法解析 --since 日期：${sinceStr}`);
    process.exit(1);
  }

  const prisma = getPrismaClient();

  console.log(`🔎 检查：创建时间 >= ${since.toISOString().slice(0, 10)} 的已删除页面，最新 PageVersion 标签重复`);

  const pages = await prisma.page.findMany({
    where: {
      isDeleted: true,
      createdAt: { gte: since }
    },
    orderBy: { createdAt: 'asc' },
    take: opts.limit && Number.isFinite(opts.limit) ? Math.max(1, opts.limit) : undefined,
    select: {
      id: true,
      wikidotId: true,
      currentUrl: true,
      url: true,
      createdAt: true,
      versions: {
        where: { validTo: null },
        orderBy: { validFrom: 'desc' },
        take: 1,
        select: {
          id: true,
          isDeleted: true,
          tags: true,
          updatedAt: true
        }
      }
    }
  });

  if (pages.length === 0) {
    console.log('ℹ️ 未发现符合条件的已删除页面。');
    await disconnectPrisma();
    return;
  }

  let checked = 0;
  const problems: DupReport[] = [];

  for (const p of pages) {
    checked += 1;
    const pv = p.versions[0] ?? null;
    if (!pv) continue;

    const tags = Array.isArray(pv.tags) ? pv.tags : [];
    const { dupMap, uniqueCount } = summarizeDuplicates(tags);

    const dups = Array.from(dupMap.entries()).filter(([, cnt]) => cnt > 1);
    if (dups.length > 0) {
      problems.push({
        wikidotId: p.wikidotId,
        pageId: p.id,
        url: p.currentUrl || p.url,
        createdAt: p.createdAt.toISOString(),
        pageVersionId: pv.id,
        isPvDeleted: !!pv.isDeleted,
        tagsCount: tags.length,
        uniqueTagsNormCount: uniqueCount,
        duplicates: dups.map(([k, v]) => `${k}(x${v})`).join('|')
      });

      if (opts.verbose) {
        console.log(`\n# wikidotId=${p.wikidotId} url=${p.currentUrl || p.url}`);
        console.log('  tags:', tags);
      }
    }
  }

  console.log(`\n🧮 已检查页面：${checked}，发现重复标签页面：${problems.length}`);
  if (problems.length > 0) {
    // 统一输出表格以便快速浏览
    console.table(
      problems.map((r) => ({
        wikidotId: r.wikidotId,
        pageId: r.pageId,
        pvId: r.pageVersionId,
        createdAt: r.createdAt.slice(0, 19),
        isPvDeleted: r.isPvDeleted,
        tagsCount: r.tagsCount,
        uniqueNorm: r.uniqueTagsNormCount,
        duplicates: r.duplicates,
        url: r.url
      }))
    );
  }

  console.log('\n提示：若需导出明细，可追加 --verbose 打印完整 tags。');

  await disconnectPrisma();
}

main().catch((err) => {
  console.error('检查失败：', err);
  process.exitCode = 1;
}).finally(async () => {
  try { await disconnectPrisma(); } catch {}
});

