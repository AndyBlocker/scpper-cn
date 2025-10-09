#!/usr/bin/env node

import { Command } from 'commander';
import { sync } from './sync.js';
import { query } from './query.js';
import { analyzeIncremental } from '../jobs/IncrementalAnalyzeJob.js';
import { runDailySiteOverview } from '../jobs/DailySiteOverviewJob.js';
import { disconnectPrisma, getPrismaClient } from '../utils/db-connection.js';
import { validateUserStats } from '../jobs/ValidationJob.js';
import { Logger } from '../utils/Logger.js';
import { PageVersionImageService } from '../services/PageVersionImageService.js';
import { showImagesProgress } from './images-progress.js';
import { countComponentIncludeUsage } from './include-usage.js';
import { checkRecentAlerts } from './alerts.js';

const program = new Command();

program
  .name('scpper')
  .description('SCPPER-CN data synchronization and analysis tool')
  .version('2.0.0');

program
  .command('sync')
  .description('Run data synchronization')
  .option('--full', 'Ignore incremental detection and sync all pages')
  .option('--phase <phase>', 'Run specific phase only (a, b, c)', 'all')
  .option('--concurrency <n>', 'Number of concurrent requests', '4')
  .option('--test', 'Test mode (first batch only)')
  .action(async (options) => { 
    // Backward-compat: map --test to testMode boolean expected by sync()
    const mapped = { ...options, testMode: Boolean((options as any).test) } as any;
    await sync(mapped); 
  });

program
  .command('query')
  .description('Query pages, users, or statistics')
  .option('-U, --url <url>', 'Query specific page URL')
  .option('-u, --user <name>', 'Query specific user')
  .option('--compact', 'Compact output for narrow terminals')
  .option('--stats', 'Show general statistics')
  .option('--user-rank', 'Show user rankings')
  .option('--vote-pattern', 'Show user vote patterns')
  .option('--vote-interactions', 'Show top vote interactions')
  .option('--popular-tags', 'Show popular tags by votes')
  .option('--site-stats', 'Show site-wide statistics and trends')
  .option('--series-stats', 'Show SCP-CN series usage statistics')
  .option('--historical', 'Show historical trends (requires --site-stats)')
  .option('--days <number>', 'Number of days for historical data (default 30)', '30')
  .option('--category <category>', 'User ranking category (overall, scp, translation, goi, story)', 'overall')
  .option('--usage', 'Show detailed usage for query command')
  .action(query);

program
  .command('analyze')
  .description('Calculate Wilson scores and controversy metrics')
  .option('--since <date>', 'Only analyze pages updated since date (YYYY-MM-DD)')
  .option('--full', 'Force full analysis instead of incremental')
  .action(async (options) => {
    // Note: --since option is not directly supported by IncrementalAnalyzeJob
    // but --full forces a complete analysis which is equivalent to the old behavior
    const forceFullAnalysis = options.full || options.since;
    await analyzeIncremental({ forceFullAnalysis });
  });

program
  .command('site-overview')
  .description('Compute daily site overview snapshots (non-destructive, UPSERT)')
  .option('--start <date>', 'Start date (YYYY-MM-DD)')
  .option('--end <date>', 'End date (YYYY-MM-DD)')
  .option('--dry-run', 'Print results without writing to DB')
  .action(async (options) => {
    await runDailySiteOverview({ startDate: options.start, endDate: options.end, dryRun: Boolean(options.dryRun) });
  });

program
  .command('validate-userstats')
  .description('Validate UserStats against recomputed aggregates')
  .option('--limit <n>', 'Max mismatch rows to show', '200')
  .option('--user <wikidotId>', 'Validate a single user by wikidotId')
  .action(async (options) => {
    const prisma = getPrismaClient();
    const limit = parseInt(String(options.limit || '200'), 10) || 200;
    let rows = await validateUserStats(prisma, limit);
    if (options.user) {
      const wid = parseInt(String(options.user), 10);
      rows = rows.filter(r => Number(r.wikidotId || 0) === wid);
    }
    console.log(`Found ${rows.length} mismatched users${options.user ? ' for wikidotId='+options.user : ''} (showing up to ${limit})`);
    console.table(rows.map(r => ({
      userId: r.userId, wikidotId: r.wikidotId, name: r.displayName,
      scp: `${r.scp_count_actual}/${Math.round(r.scp_rating_actual)}`,
      story: `${r.story_count_actual}/${Math.round(r.story_rating_actual)}`,
      goi: `${r.goi_count_actual}/${Math.round(r.goi_rating_actual)}`,
      wanderers: `${r.wanderers_count_actual}/${Math.round(r.wanderers_rating_actual)}`,
      art: `${r.art_count_actual}/${Math.round(r.art_rating_actual)}`,
      translation: `${r.translation_count_actual}/${Math.round(r.translation_rating_actual)}`,
      overall: `${r.overall_pages_actual}/${Math.round(r.overall_rating_actual)}`
    })), ['userId','wikidotId','name','scp','story','goi','wanderers','art','translation','overall']);
  });

program
  .command('images')
  .description('管理 PageVersion 图片提取队列')
  .option('--scan <ids...>', '仅扫描指定 PageVersion ID（可多个）')
  .option('--all', '扫描所有已有的 PageVersion（默认按 ID 升序批量处理）')
  .option('--limit <n>', '在 --all 模式下限制处理的 PageVersion 数量，默认 200', '200')
  .option('--batch <size>', '每批加载的 PageVersion 数量，默认 25', '25')
  .option('--dry-run', '仅展示计划，不实际写入')
  .action(async (options) => {
    const prisma = getPrismaClient();
    const service = new PageVersionImageService(prisma);
    const dryRun = Boolean(options.dryRun);

    const parseIds = (value: unknown): number[] => {
      if (!value) return [];
      const list = Array.isArray(value) ? value : [value];
      return list
        .flatMap((entry) => String(entry).split(',').map(s => s.trim()).filter(Boolean))
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n > 0);
    };

    const explicitIds = parseIds(options.scan);
    const limit = Number.parseInt(String(options.limit ?? '200'), 10) || 200;
    const batchSize = Math.max(1, Number.parseInt(String(options.batch ?? '25'), 10) || 25);

    if (explicitIds.length === 0 && !options.all) {
      console.log('请使用 --scan <id...> 指定要扫描的 PageVersion，或加上 --all 批量扫描。');
      await disconnectPrisma();
      return;
    }

    let processed = 0;

    if (explicitIds.length > 0) {
      Logger.info(`🔍 即将扫描 ${explicitIds.length} 个指定的 PageVersion`);
      for (const id of explicitIds) {
        const pv = await prisma.pageVersion.findUnique({ where: { id }, select: { id: true, source: true } });
        if (!pv || !pv.source) {
          Logger.warn(`⚠️ 跳过 PageVersion ${id}（未找到或缺少 source）`);
          continue;
        }
        processed += 1;
        if (dryRun) {
          Logger.info(`📝 [DryRun] 将扫描 PageVersion ${pv.id}`);
        } else {
          await service.syncPageVersionImages(pv.id, pv.source);
          Logger.info(`✅ 已处理 PageVersion ${pv.id}`);
        }
      }
    }

    if (options.all) {
      Logger.info(`📦 开始批量扫描 PageVersion（最多 ${limit} 条，每批 ${batchSize} 条）`);
      let cursor: number | undefined;
      outer: while (processed < limit) {
        const pages = await prisma.pageVersion.findMany({
          where: { source: { not: null } },
          orderBy: { id: 'asc' },
          take: batchSize,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
        });
        if (pages.length === 0) break;
        cursor = pages[pages.length - 1].id;
        for (const page of pages) {
          if (processed >= limit) break outer;
          processed += 1;
          if (dryRun) {
            Logger.info(`📝 [DryRun] 将扫描 PageVersion ${page.id}`);
            continue;
          }
          await service.syncPageVersionImages(page.id, page.source ?? undefined);
          Logger.debug(`✅ 已处理 PageVersion ${page.id}`);
        }
      }
    }

    Logger.info(`🎯 任务完成，共计处理 ${processed} 个 PageVersion${dryRun ? '（dry-run）' : ''}`);
    await disconnectPrisma();
  });

program
  .command('images-progress')
  .description('查看 PageVersion 图片提取进度')
  .option('--json', '以 JSON 格式输出结果')
  .action(async (options) => {
    await showImagesProgress({ json: Boolean(options.json) });
  });

program
  .command('include-usage')
  .description('统计 [[include :site:components]] 的使用次数（缺省站点视为 scp-wiki-cn）')
  .option('--default-site <text>', '当缺少站点名时使用的默认站点', 'scp-wiki-cn')
  .action(async (options) => {
    await countComponentIncludeUsage({ defaultSite: options.defaultSite });
  });

program
  .command('alerts')
  .description('检查最近的页面更新是否为已注册用户生成提醒')
  .option('--limit <n>', '回溯的最新页面更新数量（默认 20）', '20')
  .option('--since <iso>', '使用指定的 ISO 时间戳作为起点，忽略 --limit')
  .option('--json', '以 JSON 格式输出结果')
  .option('--user-db-url <url>', '覆盖用户后端数据库连接，用于仅筛选已注册用户')
  .action(async (options) => {
    await checkRecentAlerts({
      limit: options.limit,
      since: options.since,
      json: Boolean(options.json),
      userDbUrl: options.userDbUrl
    });
  });

// Global error handlers for robust CLI processes
const handleFatal = async (err: any) => {
  try {
    Logger.error('Fatal error', err instanceof Error ? err : new Error(String(err)));
  } catch {}
  try {
    await disconnectPrisma();
  } catch {}
  process.exit(1);
};

process.on('unhandledRejection', handleFatal);
process.on('uncaughtException', handleFatal);

program.parse();
