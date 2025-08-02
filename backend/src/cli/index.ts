#!/usr/bin/env node

import { Command } from 'commander';
import { sync } from './sync.js';
import { query } from './query.js';
import { analyze } from '../jobs/AnalyzeJob.js';

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
  .action(sync);

program
  .command('query')
  .description('Query pages, users, or statistics')
  .option('--url <url>', 'Query specific page URL')
  .option('--user <name>', 'Query specific user')
  .option('--stats', 'Show general statistics')
  .option('--user-rank', 'Show user rankings')
  .option('--category <category>', 'User ranking category (overall, scp, translation, goi, story)', 'overall')
  .action(query);

program
  .command('analyze')
  .description('Calculate Wilson scores and controversy metrics')
  .option('--since <date>', 'Only analyze pages updated since date (YYYY-MM-DD)')
  .action(async (options) => {
    const since = options.since ? new Date(options.since) : undefined;
    await analyze({ since });
  });

program.parse();