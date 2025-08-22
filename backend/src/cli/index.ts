#!/usr/bin/env node

import { Command } from 'commander';
import { sync } from './sync.js';
import { query } from './query.js';
import { analyzeIncremental } from '../jobs/IncrementalAnalyzeJob.js';
import { disconnectPrisma } from '../utils/db-connection.js';
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
  .action(async (options) => { await sync(options as any); });

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