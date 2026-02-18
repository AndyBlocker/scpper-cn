#!/usr/bin/env node

import { Command } from 'commander';
import { Prisma } from '@prisma/client';
import os from 'os';
import { Worker } from 'worker_threads';
import { sync } from './sync.js';
import { query } from './query.js';
import { analyzeIncremental } from '../jobs/IncrementalAnalyzeJob.js';
import { runDailySiteOverview } from '../jobs/DailySiteOverviewJob.js';
import { TrackingRetentionJob } from '../jobs/TrackingRetentionJob.js';
import { disconnectPrisma, getPrismaClient } from '../utils/db-connection.js';
import { validateUserStats } from '../jobs/ValidationJob.js';
import { Logger } from '../utils/Logger.js';
import { PageVersionImageService } from '../services/PageVersionImageService.js';
import { PageReferenceService } from '../services/PageReferenceService.js';
import { showImagesProgress } from './images-progress.js';
import { countComponentIncludeUsage } from './include-usage.js';
import { checkRecentAlerts } from './alerts.js';
import { syncGachaPool } from './gacha-sync.js';
import { backfillGachaPageImageRefs } from './gacha-backfill-page-image-refs.js';

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
  .command('gacha-sync')
  .description('Sync or rebuild gacha card pools using latest page data')
  .option('--pool-id <id>', 'Override pool id')
  .option('--pool-name <name>', 'Display name for the pool')
  .option('--description <text>', 'Pool description')
  .option('--token-cost <number>', 'Token cost for a single draw')
  .option('--ten-draw-cost <number>', 'Token cost for ten draws (defaults to token-cost ×10)')
  .option('--duplicate-reward <number>', 'Tokens awarded for duplicate cards')
  .option('--include-tags <tags>', '仅同步包含指定标签的页面（逗号分隔）')
  .option('--include-match <mode>', 'include-tags 的匹配模式：any|all（默认 any）')
  .option('--exclude-tags <tags>', '排除包含指定标签的页面（逗号分隔）')
  .option('--card-id-prefix <prefix>', '生成卡片 ID 的前缀（默认基于 pool-id 自动推导）')
  .option('--inactive', 'Create or update pool as inactive instead of active')
  .option('--dry-run', 'Preview planned changes without writing to the database')
  .option('--limit <number>', 'Only sync the first N pages (0 = all)')
  .action(async (options) => {
    const parseIntOption = (value: unknown): number | undefined => {
      if (value == null) return undefined;
      const parsed = Number.parseInt(String(value), 10);
      return Number.isFinite(parsed) ? parsed : undefined;
    };

    const tokenCost = parseIntOption(options.tokenCost);
    const tenDrawCost = parseIntOption(options.tenDrawCost);
    const duplicateReward = parseIntOption(options.duplicateReward);
    const limit = parseIntOption(options.limit) ?? 0;

    const parseTagsOption = (value: unknown): string[] => {
      if (value == null) return [];
      return String(value)
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    };

    const includeTags = parseTagsOption(options.includeTags);
    const excludeTags = parseTagsOption(options.excludeTags);
    const includeMatch = String(options.includeMatch ?? '').toLowerCase() === 'all' ? 'all' : 'any';

    await syncGachaPool({
      poolId: options.poolId ? String(options.poolId) : undefined,
      poolName: options.poolName ? String(options.poolName) : undefined,
      description: options.description ? String(options.description) : undefined,
      tokenCost,
      tenDrawCost,
      duplicateReward,
      includeTags,
      includeMatch,
      excludeTags,
      cardIdPrefix: options.cardIdPrefix ? String(options.cardIdPrefix) : undefined,
      isActive: options.inactive ? false : undefined,
      dryRun: Boolean(options.dryRun),
      limit
    });
  });

program
  .command('gacha-backfill-image-refs')
  .description('Backfill gacha card imageUrl to /page-images/:assetId for low-variant delivery')
  .option('--dry-run', 'Preview without writing to user-backend database')
  .option('--scan-batch-size <number>', 'Backend PageVersion scan batch size', '2000')
  .option('--update-chunk-size <number>', 'User-backend UPDATE VALUES chunk size', '500')
  .action(async (options) => {
    const parseIntOption = (value: unknown, fallback: number): number => {
      const parsed = Number.parseInt(String(value ?? ''), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
      return parsed;
    };

    await backfillGachaPageImageRefs({
      dryRun: Boolean(options.dryRun),
      scanBatchSize: parseIntOption(options.scanBatchSize, 2000),
      updateChunkSize: parseIntOption(options.updateChunkSize, 500)
    });
  });

program
  .command('gacha-sync-split-original')
  .description('已废弃：v0.2 固定为单常驻池，不再支持按标签拆分卡池')
  .option('--tag <tag>', '用于拆分的标签（默认：原创）', '原创')
  .option('--inactive', 'Create or update pools as inactive instead of active')
  .option('--dry-run', 'Preview planned changes without writing to the database')
  .option('--limit <number>', 'Only sync the first N matched pages per pool (0 = all)')
  .action(async (options) => {
    const tag = String(options.tag ?? '原创').trim() || '原创';
    throw new Error(`gacha-sync-split-original 已禁用：当前仅允许单常驻池（收到 tag=${tag}）。`);
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
  .command('tracking-retention')
  .description('删除超出保留窗口的 tracking 数据（PageViewEvent / UserPixelEvent）')
  .option('--days <n>', '保留天数，默认 75', '75')
  .option('--batch <n>', '单次删除条数上限，默认 10000', '10000')
  .option('--dry-run', '仅统计待删除数量，不执行删除')
  .action(async (options) => {
    const job = new TrackingRetentionJob();
    const parsedDays = Number.parseInt(String(options.days ?? ''), 10);
    const parsedBatch = Number.parseInt(String(options.batch ?? ''), 10);
    await job.run({
      retentionDays: Number.isFinite(parsedDays) && parsedDays > 0 ? parsedDays : undefined,
      batchSize: Number.isFinite(parsedBatch) && parsedBatch > 0 ? parsedBatch : undefined,
      dryRun: Boolean(options.dryRun)
    });
    await disconnectPrisma();
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
  .command('references')
  .description('解析 PageVersion 源码中的站内引用并写入 PageReference 表')
  .option('--scan <ids...>', '仅解析指定 PageVersion ID（可多个，逗号或空格分隔）')
  .option('--all', '扫描所有已有的 PageVersion（默认限制 --limit 条）')
  .option('--full', '全量模式，忽略 --limit，处理所有 PageVersion（与 --all 互补）')
  .option('--limit <n>', '在 --all 模式下限制处理的 PageVersion 数量，默认 200', '200')
  .option('--batch <size>', '每批加载的 PageVersion 数量，默认 25', '25')
  .option('--dry-run', '仅展示计划，不写入数据库')
  .option('--progress <n>', '每处理 N 个 PageVersion 输出一次进度，默认 50', '50')
  .action(async (options) => {
    const prisma = getPrismaClient();
    const service = new PageReferenceService(prisma);
    const dryRun = Boolean(options.dryRun);

    const parseIds = (value: unknown): number[] => {
      if (!value) return [];
      const list = Array.isArray(value) ? value : [value];
      return list
        .flatMap((entry) => String(entry).split(',').map((s) => s.trim()).filter(Boolean))
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n > 0);
    };

    const explicitIds = parseIds(options.scan);
    const isFull = Boolean(options.full);
    const limit = isFull ? Number.POSITIVE_INFINITY : (Number.parseInt(String(options.limit ?? '200'), 10) || 200);
    const batchSize = Math.max(1, Number.parseInt(String(options.batch ?? '25'), 10) || 25);
    const progressEvery = Math.max(1, Number.parseInt(String(options.progress ?? '50'), 10) || 50);

    if (explicitIds.length === 0 && !options.all && !isFull) {
      console.log('请使用 --scan <id...> 指定 PageVersion，或加上 --all / --full 进行批量扫描。');
      await disconnectPrisma();
      return;
    }

    let processed = 0;
    let scanned = 0;
    let skipped = 0;

    const reportProgress = () => {
      if (processed > 0 && processed % progressEvery === 0) {
        Logger.info(`📈 已完成 ${processed} 个 PageVersion，跳过 ${skipped} 个${dryRun ? '（dry-run 模式）' : ''}`);
      }
    };

    const handlePageVersion = async (id: number, source: string | null | undefined) => {
      scanned += 1;
      if (!source) {
        Logger.warn(`⚠️ 跳过 PageVersion ${id}（缺少 source 字段）`);
        skipped += 1;
        return;
      }
      if (dryRun) {
        Logger.info(`📝 [DryRun] 将解析 PageVersion ${id}`);
        processed += 1;
        reportProgress();
        return;
      }
      await service.syncPageReferences(id, source);
      processed += 1;
      Logger.debug(`✅ 已处理 PageVersion ${id}`);
      reportProgress();
    };

    if (explicitIds.length > 0) {
      Logger.info(`🔍 即将解析 ${explicitIds.length} 个指定 PageVersion`);
      for (const id of explicitIds) {
        const pv = await prisma.pageVersion.findUnique({ where: { id }, select: { id: true, source: true } });
        if (!pv) {
          Logger.warn(`⚠️ 跳过 PageVersion ${id}（未找到记录）`);
          skipped += 1;
          continue;
        }
        await handlePageVersion(pv.id, pv.source);
      }
    }

    if (options.all || isFull) {
      Logger.info(`📦 开始批量解析 PageVersion（${isFull ? '全量' : `最多 ${limit} 条`}，每批 ${batchSize} 条）`);
      let cursor: number | undefined;
      outer: while (true) {
        if (Number.isFinite(limit) && scanned >= limit) {
          break;
        }
        const remaining = Number.isFinite(limit) ? limit - scanned : batchSize;
        const take = Number.isFinite(limit) ? Math.min(batchSize, Math.max(0, remaining)) : batchSize;
        if (take <= 0) break;

        const pages = await prisma.pageVersion.findMany({
          where: { source: { not: null } },
          orderBy: { id: 'asc' },
          take,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {})
        });

        if (pages.length === 0) {
          break;
        }

        cursor = pages[pages.length - 1].id;

        for (const page of pages) {
          if (Number.isFinite(limit) && scanned >= limit) {
            break outer;
          }
          await handlePageVersion(page.id, page.source);
        }
      }
    }

    Logger.info(`🎯 引用解析完成，成功 ${processed} 个，跳过 ${skipped} 个，总计扫描 ${scanned} 个 PageVersion${dryRun ? '（dry-run）' : ''}`);
    await disconnectPrisma();
  });

program
  .command('references-graph')
  .description('生成页面引用关系快照（需手动执行）')
  .option('--label <text>', '快照标签，用于覆盖已有记录', 'latest')
  .option('--top <n>', '排行榜条目数量', '10')
  .option('--max-nodes <n>', '可视化节点上限', '150')
  .option('--max-edges <n>', '可视化边上限', '800')
  .option('--threads <n>', '工作线程数量（默认 CPU 并行度）')
  .option('--batch <n>', '单个工作线程处理的源页面数量，默认 400', '400')
  .option('--dry-run', '仅输出结果，不写入数据库')
  .action(async (options) => {
    const prisma = getPrismaClient();
    const label = String(options.label ?? 'latest');
    const top = Math.max(1, Number.parseInt(String(options.top ?? '10'), 10) || 10);
    const maxNodes = Math.max(top, Number.parseInt(String(options.maxNodes ?? '150'), 10) || 150);
    const maxEdges = Math.max(1, Number.parseInt(String(options.maxEdges ?? '800'), 10) || 800);
    const dryRun = Boolean(options.dryRun);
    const pageBatchSize = Math.max(10, Number.parseInt(String(options.batch ?? '400'), 10) || 400);

    const defaultThreadCount = (() => {
      const maybeAvailable = (os as unknown as { availableParallelism?: () => number }).availableParallelism;
      if (typeof maybeAvailable === 'function') {
        try {
          return Math.max(1, maybeAvailable());
        } catch {}
      }
      const cpus = os.cpus();
      return cpus && cpus.length > 0 ? cpus.length : 1;
    })();

    const requestedThreads = Number.parseInt(String(options.threads ?? ''), 10);
    const threads = Number.isFinite(requestedThreads) && requestedThreads > 0 ? requestedThreads : defaultThreadCount;

    const baseUrl = 'http://scp-wiki-cn.wikidot.com';
    const baseUrlWithSlash = `${baseUrl}/`;

    type MinimalPage = {
      id: number;
      wikidotId: number | null;
      currentUrl: string | null;
      url: string | null;
      urlHistory: string[];
      updatedAt: Date;
    };

    const canonicalizeUrl = (value: string | null | undefined): string | null => {
      if (value == null) return null;
      const raw = String(value).trim();
      if (!raw) return null;
      try {
        const url = raw.startsWith('http://') || raw.startsWith('https://')
          ? new URL(raw)
          : new URL(raw.startsWith('/') ? raw : `/${raw}`, baseUrlWithSlash);
        url.hash = '';
        url.search = '';
        let pathname = url.pathname || '/';
        if (!pathname.startsWith('/')) {
          pathname = `/${pathname}`;
        }
        if (pathname.length > 1 && pathname.endsWith('/')) {
          pathname = pathname.replace(/\/+$/, '');
          if (!pathname) pathname = '/';
        }
        return `${url.protocol}//${url.host}${pathname}`;
      } catch {
        return null;
      }
    };

    const canonicalizeTargetUrl = (targetPath: string): string | null => {
      const raw = String(targetPath ?? '').trim();
      if (!raw) return null;
      if (raw.startsWith('http://') || raw.startsWith('https://')) {
        return canonicalizeUrl(raw);
      }
      const normalized = raw.startsWith('/') ? raw : `/${raw}`;
      return canonicalizeUrl(`${baseUrl}${normalized}`);
    };

    const pageMap = new Map<number, MinimalPage>();
    const urlToPage = new Map<string, MinimalPage>();

    const addUrlMapping = (candidate: string | null | undefined, page: MinimalPage) => {
      const normalized = canonicalizeUrl(candidate);
      if (!normalized) return;
      const existing = urlToPage.get(normalized);
      if (!existing || existing.updatedAt < page.updatedAt) {
        urlToPage.set(normalized, page);
      }
      if (!normalized.endsWith('/')) {
        const withSlash = `${normalized}/`;
        const existingWithSlash = urlToPage.get(withSlash);
        if (!existingWithSlash || existingWithSlash.updatedAt < page.updatedAt) {
          urlToPage.set(withSlash, page);
        }
      } else {
        const withoutSlash = normalized.replace(/\/+$/, '');
        if (withoutSlash && withoutSlash !== normalized) {
          const existingWithoutSlash = urlToPage.get(withoutSlash);
          if (!existingWithoutSlash || existingWithoutSlash.updatedAt < page.updatedAt) {
            urlToPage.set(withoutSlash, page);
          }
        }
      }
    };

    const chunkArray = <T>(items: T[], size: number): T[][] => {
      const result: T[][] = [];
      for (let i = 0; i < items.length; i += size) {
        result.push(items.slice(i, i + size));
      }
      return result;
    };

    interface WorkerMessage {
      ok: boolean;
      edges?: WorkerEdge[];
      error?: string;
    }

    interface WorkerEdge {
      sourcePageId: number;
      targetPath: string;
      weight: number;
    }

    type Edge = {
      sourcePageId: number;
      targetPageId: number;
      sourceWikidotId: number;
      targetWikidotId: number;
      weight: number;
    };

    try {
      Logger.info('📦 预加载页面索引供引用扫描使用...');
      const pagesForMapping = await prisma.page.findMany({
        select: {
          id: true,
          wikidotId: true,
          currentUrl: true,
          url: true,
          urlHistory: true,
          updatedAt: true
        }
      });

      for (const page of pagesForMapping) {
        pageMap.set(page.id, page);
        addUrlMapping(page.currentUrl, page);
        addUrlMapping(page.url, page);
        for (const entry of page.urlHistory ?? []) {
          addUrlMapping(entry, page);
        }
      }

      if (pageMap.size === 0) {
        Logger.warn('未找到可用的页面数据，跳过。');
        return;
      }

      Logger.info(`📄 已加载 ${pageMap.size} 个页面索引映射`);

      const sourcePageRows = await prisma.$queryRaw<Array<{ page_id: number }>>(Prisma.sql`
        SELECT DISTINCT pv."pageId" AS page_id
        FROM "PageReference" pr
        JOIN "PageVersion" pv ON pv.id = pr."pageVersionId"
        WHERE pv."validTo" IS NULL
      `);

      const sourcePageIds = sourcePageRows
        .map(row => row.page_id)
        .filter(id => {
          const page = pageMap.get(id);
          return page?.wikidotId != null;
        })
        .sort((a, b) => a - b);

      if (sourcePageIds.length === 0) {
        Logger.warn('未找到可用的页面引用数据，跳过。');
        return;
      }

      const pageChunks = chunkArray(sourcePageIds, pageBatchSize);
      Logger.info(`🚀 将使用 ${threads} 个线程处理 ${sourcePageIds.length} 个源页面（共 ${pageChunks.length} 个批次）`);

      const workerModuleUrl = new URL('./workers/reference-graph-worker.js', import.meta.url);
      const workerExecArgv = process.execArgv?.length ? process.execArgv : undefined;

      const runWorker = (pageIds: number[]): Promise<WorkerEdge[]> =>
        new Promise((resolve, reject) => {
          const worker = new Worker(
            workerModuleUrl,
            {
              workerData: { pageIds },
              ...(workerExecArgv ? { execArgv: workerExecArgv } : {}),
              type: 'module'
            } as any
          );

          let settled = false;
          const cleanup = () => {
            worker.removeAllListeners('message');
            worker.removeAllListeners('error');
            worker.removeAllListeners('exit');
          };

          worker.once('message', (message: WorkerMessage) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (message.ok) {
              resolve(message.edges ?? []);
            } else {
              reject(new Error(message.error ?? 'Worker execution failed'));
            }
          });

          worker.once('error', (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
          });

          worker.once('exit', (code) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (code === 0) {
              resolve([]);
            } else {
              reject(new Error(`Worker exited with code ${code}`));
            }
          });
        });

      let rawEdgeCount = 0;
      const combinedEdgeMap = new Map<string, Edge>();

      const accumulateEdges = (rows: WorkerEdge[]) => {
        for (const row of rows) {
          if (!Number.isFinite(row.weight) || row.weight <= 0) continue;
          const source = pageMap.get(row.sourcePageId);
          if (!source || source.wikidotId == null) continue;
          const targetUrl = canonicalizeTargetUrl(row.targetPath);
          if (!targetUrl) continue;
          const target = urlToPage.get(targetUrl);
          if (!target || target.wikidotId == null) continue;
          const weight = Math.max(1, Math.round(row.weight));
          const key = `${source.wikidotId}:${target.wikidotId}`;
          const existing = combinedEdgeMap.get(key);
          if (existing) {
            existing.weight += weight;
          } else {
            combinedEdgeMap.set(key, {
              sourcePageId: source.id,
              targetPageId: target.id,
              sourceWikidotId: source.wikidotId,
              targetWikidotId: target.wikidotId,
              weight
            });
          }
        }
      };

      const startTime = Date.now();
      let completedChunks = 0;
      let nextChunkIndex = 0;
      const totalChunks = pageChunks.length;

      const processQueue = async () => {
        while (true) {
          const index = nextChunkIndex;
          nextChunkIndex += 1;
          if (index >= totalChunks) break;
          const chunk = pageChunks[index];
          const chunkStart = Date.now();
          const edges = await runWorker(chunk);
          rawEdgeCount += edges.length;
          accumulateEdges(edges);
          completedChunks += 1;
          const elapsed = ((Date.now() - chunkStart) / 1000).toFixed(2);
          Logger.info(`⚙️ 批次 ${completedChunks}/${totalChunks} 完成（新增 ${edges.length} 条原始边，${elapsed}s）`);
        }
      };

      await Promise.all(
        Array.from({ length: Math.max(1, Math.min(threads, totalChunks)) }, () => processQueue())
      );

      const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(2);
      Logger.info(`📦 引用扫描完成，共 ${rawEdgeCount} 条原始边，清洗后 ${combinedEdgeMap.size} 条候选边，用时 ${totalElapsed}s`);

      if (combinedEdgeMap.size === 0) {
        Logger.warn('未找到可用的页面引用数据，跳过。');
        return;
      }

      const edges = Array.from(combinedEdgeMap.values());

      const padUrl = (path: string | null | undefined): string | null => {
        if (!path) return null;
        if (path.startsWith('http://') || path.startsWith('https://')) return path;
        return `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
      };

      type NodeMetric = {
        pageId: number;
        wikidotId: number;
        url: string;
        title: string;
        inbound: number;
        outbound: number;
        inboundEdges: number;
        outboundEdges: number;
      };

      const nodeMap = new Map<number, NodeMetric>();
      const ensureNode = (wikidotId: number, pageId: number): NodeMetric => {
        let node = nodeMap.get(wikidotId);
        if (!node) {
          node = {
            pageId,
            wikidotId,
            url: '',
            title: '（无标题）',
            inbound: 0,
            outbound: 0,
            inboundEdges: 0,
            outboundEdges: 0
          };
          nodeMap.set(wikidotId, node);
        }
        return node;
      };

      for (const edge of edges) {
        const source = ensureNode(edge.sourceWikidotId, edge.sourcePageId);
        const target = ensureNode(edge.targetWikidotId, edge.targetPageId);
        source.outbound += edge.weight;
        source.outboundEdges += 1;
        target.inbound += edge.weight;
        target.inboundEdges += 1;
      }

      const pageIds = Array.from(new Set(edges.flatMap(e => [e.sourcePageId, e.targetPageId])));
      const pages = await prisma.page.findMany({
        where: { id: { in: pageIds } },
        select: {
          id: true,
          wikidotId: true,
          currentUrl: true,
          url: true,
          versions: {
            where: { validTo: null },
            orderBy: { validFrom: 'desc' },
            take: 1,
            select: { title: true, alternateTitle: true }
          }
        }
      });

      for (const page of pages) {
        const title = page.versions[0]?.title || page.versions[0]?.alternateTitle || '（无标题）';
        const url = padUrl(page.currentUrl) || padUrl(page.url) || '';
        if (page.wikidotId != null) {
          const metric = nodeMap.get(page.wikidotId);
          if (metric) {
            metric.title = title;
            metric.url = url || `http://scp-wiki-cn.wikidot.com/${page.wikidotId}`;
          }
        }
      }

      // 排行榜计算
      const metrics = Array.from(nodeMap.values());
      const byInbound = metrics
        .filter(n => n.inbound > 0)
        .sort((a, b) => b.inbound - a.inbound || b.inboundEdges - a.inboundEdges)
        .slice(0, top);
      const byOutbound = metrics
        .filter(n => n.outbound > 0)
        .sort((a, b) => b.outbound - a.outbound || b.outboundEdges - a.outboundEdges)
        .slice(0, top);

      const graphNodes = metrics.map(n => ({
        wikidotId: n.wikidotId,
        pageId: n.pageId,
        title: n.title,
        url: n.url,
        inbound: n.inbound,
        outbound: n.outbound,
        inboundEdges: n.inboundEdges,
        outboundEdges: n.outboundEdges
      }));

      const graphEdges = edges
        .filter(e => e.sourceWikidotId !== e.targetWikidotId)
        .sort((a, b) => b.weight - a.weight)
        .map(e => ({
          source: e.sourceWikidotId,
          target: e.targetWikidotId,
          weight: e.weight
        }));

      const maxWeight = graphEdges.reduce((acc, edge) => Math.max(acc, edge.weight), 0);

      const snapshotPayload = {
        generatedAt: new Date().toISOString(),
        parameters: { top, maxNodes, maxEdges, batchSize: pageBatchSize, threads, storedFullGraph: true },
        totals: {
          pages: metrics.length,
          edges: edges.length
        },
        topInbound: byInbound.map((n, index) => ({
          rank: index + 1,
          wikidotId: n.wikidotId,
          pageId: n.pageId,
          title: n.title,
          url: n.url,
          inbound: n.inbound,
          outbound: n.outbound
        })),
        topOutbound: byOutbound.map((n, index) => ({
          rank: index + 1,
          wikidotId: n.wikidotId,
          pageId: n.pageId,
          title: n.title,
          url: n.url,
          inbound: n.inbound,
          outbound: n.outbound
        })),
        graph: {
          nodeCount: graphNodes.length,
          edgeCount: graphEdges.length,
          maxWeight,
          nodes: graphNodes,
          edges: graphEdges
        }
      };

      if (dryRun) {
        Logger.info(`📝 [DryRun] 将生成标签为 ${label} 的快照（节点 ${graphNodes.length}，边 ${graphEdges.length}）`);
        Logger.info(JSON.stringify(snapshotPayload, null, 2));
        return;
      }

      await prisma.pageReferenceGraphSnapshot.upsert({
        where: { label },
        update: {
          description: `PageReference 图快照（${graphNodes.length} nodes / ${graphEdges.length} edges）`,
          stats: snapshotPayload,
          generatedAt: new Date()
        },
        create: {
          label,
          description: `PageReference 图快照（${graphNodes.length} nodes / ${graphEdges.length} edges）`,
          stats: snapshotPayload
        }
      });

      Logger.info(`✅ 已更新快照 ${label}：节点 ${graphNodes.length}，边 ${graphEdges.length}`);
    } finally {
      await disconnectPrisma();
    }
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

program
  .command('tags')
  .description('标签定义功能已暂时停用')
  .action(() => {
    Logger.warn('⚠️ 标签定义功能暂时停用，请稍后再试。');
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
