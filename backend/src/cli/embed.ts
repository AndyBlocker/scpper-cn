import { Command } from 'commander';
import { getPrismaClient, disconnectPrisma } from '../utils/db-connection.js';
import { Logger } from '../utils/Logger.js';
import { embeddingClientFromEnv } from '../services/embedding/EmbeddingClient.js';
import { runPageEmbeddingBackfill, runPageEmbeddingIncremental } from '../jobs/PageEmbeddingBackfillJob.js';
import { hybridSearch } from '../services/embedding/PageEmbeddingRepo.js';

export function registerEmbedCommands(program: Command) {
  const embed = program
    .command('embed')
    .description('Page embedding pipeline (BGE-M3 by default)');

  embed
    .command('health')
    .description('Ping the local embedding server and print model info')
    .action(async () => {
      const client = embeddingClientFromEnv();
      const h = await client.health();
      console.log(JSON.stringify(h, null, 2));
    });

  embed
    .command('backfill')
    .description('Embed all PageVersion rows that do not yet have a row in PageEmbedding for the current model')
    .option('--batch-size <n>', 'Texts per embed request', (v) => parseInt(v, 10), 16)
    .option('--limit <n>', 'Cap the number of PageVersions to process', (v) => parseInt(v, 10))
    .option('--no-deleted', 'Skip pages whose Page.isDeleted=true (default: include)')
    .option('--dry-run', 'List the candidates but do not call the embedding server or write DB')
    .action(async (opts) => {
      try {
        const res = await runPageEmbeddingBackfill({
          batchSize: opts.batchSize,
          limit: Number.isFinite(opts.limit) ? opts.limit : undefined,
          includeDeletedPages: opts.deleted !== false,
          dryRun: opts.dryRun === true
        });
        console.log(`[embed:backfill] total=${res.total} written=${res.written} truncated=${res.truncatedCount} skippedEmpty=${res.skippedEmpty} durationMs=${res.durationMs}`);
      } finally {
        await disconnectPrisma();
      }
    });

  embed
    .command('incremental')
    .description('Embed only the still-missing PageVersions (same query as backfill, smaller batch)')
    .option('--batch-size <n>', 'Texts per embed request', (v) => parseInt(v, 10), 8)
    .option('--limit <n>', 'Cap per run (safety for cron)', (v) => parseInt(v, 10), 500)
    .action(async (opts) => {
      try {
        const res = await runPageEmbeddingIncremental({
          batchSize: opts.batchSize,
          limit: Number.isFinite(opts.limit) ? opts.limit : 500
        });
        console.log(`[embed:incremental] written=${res.written} truncated=${res.truncatedCount} durationMs=${res.durationMs}`);
      } finally {
        await disconnectPrisma();
      }
    });

  embed
    .command('search <query...>')
    .description('Hybrid pgvector + pgroonga search; useful for smoke tests')
    .option('--limit <n>', 'Top K', (v) => parseInt(v, 10), 10)
    .option('--dense <n>', 'Dense candidates', (v) => parseInt(v, 10), 60)
    .option('--sparse <n>', 'Sparse candidates', (v) => parseInt(v, 10), 60)
    .option('--dense-weight <w>', 'Weight for dense score', (v) => parseFloat(v), 0.65)
    .option('--sparse-weight <w>', 'Weight for sparse score', (v) => parseFloat(v), 0.35)
    .action(async (queryWords: string[], opts) => {
      const client = embeddingClientFromEnv();
      const prisma = getPrismaClient();
      const query = queryWords.join(' ').trim();
      if (!query) {
        console.error('empty query');
        process.exit(1);
      }
      try {
        Logger.info(`[embed:search] "${query}"`);
        const [vec] = await client.embed([query]);
        const hits = await hybridSearch(prisma, client.modelId, vec, query, {
          limit: opts.limit,
          denseCandidates: opts.dense,
          sparseCandidates: opts.sparse,
          denseWeight: opts.denseWeight,
          sparseWeight: opts.sparseWeight
        });
        if (hits.length === 0) {
          console.log('(no matches)');
        }
        for (const h of hits) {
          const name = h.title || h.alternateTitle || `PV#${h.pageVersionId}`;
          const mark = h.isDeletedPage ? ' (deleted)' : '';
          console.log(
            `${h.finalScore.toFixed(4)}  dense=${h.denseScore.toFixed(3)} sparse=${h.sparseScore.toFixed(3)}  wid=${h.wikidotId ?? '-'}  ${name}${mark}`
          );
        }
      } finally {
        await disconnectPrisma();
      }
    });
}
