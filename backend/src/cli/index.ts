#!/usr/bin/env node

import { Command } from 'commander';
import { sync } from './sync.js';
import { query } from './query.js';
import { analyzeIncremental } from '../jobs/IncrementalAnalyzeJob.js';
import { runDailySiteOverview } from '../jobs/DailySiteOverviewJob.js';
import { disconnectPrisma, getPrismaClient } from '../utils/db-connection.js';
import { validateUserStats } from '../jobs/ValidationJob.js';
import { Logger } from '../utils/Logger.js';

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