import { Command } from 'commander';
import * as dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '../.env') });

import { bindGracefulShutdown, cleanupDb } from './store/db.js';
import { connect, close } from './client/WikidotDirectClient.js';

const program = new Command();

program
  .name('syncer')
  .description('SCPper CN Sync V2 — Vote Sentinel')
  .version('1.0.0');

// ── syncer sentinel ──
program
  .command('sentinel')
  .description('Run the vote sentinel loop')
  .option('--interval <seconds>', 'Polling interval in seconds', '300')
  .option('--run-immediately', 'Run first cycle immediately', false)
  .action(async (opts) => {
    bindGracefulShutdown();
    await connect();

    const { runVoteSentinelLoop } = await import('./sentinel/VoteSentinelLoop.js');
    const tier2Concurrency = parseInt(process.env.SYNCER_TIER2_CONCURRENCY || '3', 10);

    try {
      await runVoteSentinelLoop({
        intervalSeconds: parseInt(opts.interval, 10),
        runImmediately: opts.runImmediately,
        tier2Concurrency,
      });
    } finally {
      await close();
      await cleanupDb();
    }
  });

// ── syncer scan:tier1 ──
program
  .command('scan:tier1')
  .description('Run a single Tier 1 rating scan')
  .action(async () => {
    bindGracefulShutdown();
    await connect();

    const { scanAllRatings } = await import('./scanner/RatingScanner.js');

    try {
      const ratingMap = await scanAllRatings();
      console.log(`\nTotal pages scanned: ${ratingMap.size}`);

      // 打印一些统计
      let totalRating = 0;
      let totalVotes = 0;
      for (const { rating, votesCount } of ratingMap.values()) {
        totalRating += rating;
        totalVotes += votesCount;
      }
      console.log(`Total rating sum: ${totalRating}`);
      console.log(`Total votes sum: ${totalVotes}`);
    } finally {
      await close();
      await cleanupDb();
    }
  });

// ── syncer scan:tier2 ──
program
  .command('scan:tier2')
  .description('Run a single Tier 2 vote detail scan for specific pages')
  .requiredOption('--pages <fullnames>', 'Comma-separated list of page fullnames')
  .action(async (opts) => {
    bindGracefulShutdown();
    await connect();

    const { scanVoteDetails } = await import('./scanner/VoteDetailScanner.js');
    const fullnames = (opts.pages as string).split(',').map(s => s.trim()).filter(Boolean);

    try {
      const voteDetails = await scanVoteDetails(fullnames);

      for (const [fullname, votes] of voteDetails) {
        console.log(`\n${fullname}: ${votes.length} votes`);
        const upvotes = votes.filter(v => v.direction > 0).length;
        const downvotes = votes.filter(v => v.direction < 0).length;
        console.log(`  +${upvotes} / -${downvotes} = ${upvotes - downvotes}`);
      }
    } finally {
      await close();
      await cleanupDb();
    }
  });

// ── syncer fast-vote ── (快速投票监控：并发 rating 扫描 + Tier 2 + 轻量 Bridge)
program
  .command('fast-vote')
  .description('Fast vote monitoring loop (concurrent rating scan, ~30s/cycle)')
  .option('--interval <seconds>', 'Polling interval in seconds', '300')
  .option('--concurrency <n>', 'Concurrent ListPagesModule requests', '5')
  .option('--run-immediately', 'Run first cycle immediately', false)
  .action(async (opts) => {
    bindGracefulShutdown();
    await connect();

    const { runFastVoteLoop } = await import('./sentinel/FastVoteLoop.js');
    const tier2Concurrency = parseInt(process.env.SYNCER_TIER2_CONCURRENCY || '3', 10);

    try {
      await runFastVoteLoop({
        intervalSeconds: parseInt(opts.interval, 10),
        concurrency: parseInt(opts.concurrency, 10),
        runImmediately: opts.runImmediately,
        tier2Concurrency,
      });
    } finally {
      await close();
      await cleanupDb();
    }
  });

// ── syncer sync ── (完整同步循环：Tier 1 全字段 + Vote/Content Tier 2)
program
  .command('sync')
  .description('Run the full syncer loop (pages + votes + content)')
  .option('--interval <seconds>', 'Polling interval in seconds', '300')
  .option('--run-immediately', 'Run first cycle immediately', false)
  .action(async (opts) => {
    bindGracefulShutdown();
    await connect();

    const { runSyncerLoop } = await import('./sentinel/SyncerLoop.js');
    const tier2Concurrency = parseInt(process.env.SYNCER_TIER2_CONCURRENCY || '3', 10);

    try {
      await runSyncerLoop({
        intervalSeconds: parseInt(opts.interval, 10),
        runImmediately: opts.runImmediately,
        tier2Concurrency,
      });
    } finally {
      await close();
      await cleanupDb();
    }
  });

// ── syncer scan:pages ── (单次全字段 Tier 1 扫描)
program
  .command('scan:pages')
  .description('Run a single full-field Tier 1 page scan')
  .action(async () => {
    bindGracefulShutdown();
    await connect();

    const { scanAllPages } = await import('./scanner/PageScanner.js');

    try {
      const pageMap = await scanAllPages();
      console.log(`\nTotal pages: ${pageMap.size}`);

      let totalRating = 0;
      let withParent = 0;
      const tagCounts = new Map<string, number>();
      for (const p of pageMap.values()) {
        totalRating += p.rating;
        if (p.parentFullname) withParent++;
        for (const t of p.tags) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      }

      console.log(`Total rating sum: ${totalRating}`);
      console.log(`Pages with parent: ${withParent}`);
      console.log(`Unique tags: ${tagCounts.size}`);
    } finally {
      await close();
      await cleanupDb();
    }
  });

// ── syncer scan:content ── (对指定页面获取 source + HTML + revisions + files)
program
  .command('scan:content')
  .description('Fetch content (source, HTML, revisions, files) for specific pages')
  .requiredOption('--pages <fullnames>', 'Comma-separated page fullnames')
  .action(async (opts) => {
    bindGracefulShutdown();
    await connect();

    const { scanPageContent } = await import('./scanner/ContentScanner.js');
    const fullnames = (opts.pages as string).split(',').map(s => s.trim()).filter(Boolean);

    try {
      const results = await scanPageContent(fullnames);

      for (const [fullname, r] of results) {
        console.log(`\n${fullname}:`);
        console.log(`  source: ${r.sourceLength} chars`);
        console.log(`  html: ${r.html ? r.html.length : 0} chars`);
        console.log(`  revisions: ${r.revisions.length}`);
        console.log(`  files: ${r.files.length}`);
        if (r.revisions.length > 0) {
          const latest = r.revisions[0];
          console.log(`  latest rev: #${latest.revNo} by ${latest.createdByName} at ${latest.createdAt?.toISOString()}`);
        }
      }
    } finally {
      await close();
      await cleanupDb();
    }
  });

// ── syncer sync:attributions ── (采集并同步归属数据到主库)
program
  .command('sync:attributions')
  .description('Scan attribution-metadata pages and sync to main DB')
  .action(async () => {
    bindGracefulShutdown();
    await connect();

    const { scanAttributions } = await import('./scanner/AttributionScanner.js');
    const { bridgeAttributions } = await import('./bridge/MainDbBridge.js');

    try {
      const entries = await scanAttributions();
      const result = await bridgeAttributions(entries);
      console.log(`\nAttribution sync: ${result.written} written, ${result.skipped} skipped`);
    } finally {
      await close();
      await cleanupDb();
    }
  });

// ── syncer sync:alt-titles ── (从系列页面同步 alternateTitle)
program
  .command('sync:alt-titles')
  .description('Scan SCP series pages and sync alternate titles to main DB')
  .action(async () => {
    bindGracefulShutdown();
    await connect();

    const { scanAlternateTitles } = await import('./scanner/AlternateTitleScanner.js');
    const { bridgeAlternateTitles } = await import('./bridge/MainDbBridge.js');

    try {
      const entries = await scanAlternateTitles();
      const result = await bridgeAlternateTitles(entries);
      console.log(`\nAlternate title sync: ${result.updated} updated, ${result.skipped} skipped`);
    } finally {
      await close();
      await cleanupDb();
    }
  });

// ── syncer sync:metadata ── (一次性同步归属 + alternateTitle)
program
  .command('sync:metadata')
  .description('Sync attributions + alternate titles (run periodically)')
  .action(async () => {
    bindGracefulShutdown();
    await connect();

    try {
      const { scanAttributions } = await import('./scanner/AttributionScanner.js');
      const { bridgeAttributions, bridgeAlternateTitles } = await import('./bridge/MainDbBridge.js');
      const { scanAlternateTitles } = await import('./scanner/AlternateTitleScanner.js');

      console.log('=== Attribution sync ===');
      const attrEntries = await scanAttributions();
      const attrResult = await bridgeAttributions(attrEntries);
      console.log(`Attributions: ${attrResult.written} written, ${attrResult.skipped} skipped\n`);

      console.log('=== Alternate title sync ===');
      const altEntries = await scanAlternateTitles();
      const altResult = await bridgeAlternateTitles(altEntries);
      console.log(`Alternate titles: ${altResult.updated} updated, ${altResult.skipped} skipped`);
    } finally {
      await close();
      await cleanupDb();
    }
  });

program.parse();
