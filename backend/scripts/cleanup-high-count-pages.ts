// scripts/cleanup-high-count-pages.ts
// Delete all data for pages whose current version has revisionCount > N or voteCount > N
// Usage: node --import tsx/esm scripts/cleanup-high-count-pages.ts [--threshold 100] [--dry]

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

type Args = {
  threshold: number;
  dry: boolean;
};

function parseArgs(): Args {
  const args = process.argv.slice(2);
  let threshold = 100;
  let dry = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--threshold' || a === '-t') {
      const v = parseInt(args[i + 1] || '', 10);
      if (!Number.isFinite(v)) {
        console.error('Invalid threshold value');
        process.exit(1);
      }
      threshold = v;
      i++;
    } else if (a === '--dry') {
      dry = true;
    }
  }
  return { threshold, dry };
}

const prisma = new PrismaClient();

async function main() {
  const { threshold, dry } = parseArgs();
  console.log(`Cleaning pages where current PageVersion.revisionCount > ${threshold} OR voteCount > ${threshold}`);
  console.log(dry ? 'Dry-run mode: no data will be deleted.' : 'Live mode: data will be deleted.');

  // Find current page versions exceeding threshold
  const badVersions = await prisma.$queryRaw<Array<{ pageId: number; pvId: number }>>`
    SELECT pv."pageId" as "pageId", pv.id as "pvId"
    FROM "PageVersion" pv
    WHERE pv."validTo" IS NULL
      AND (
        (pv."revisionCount" IS NOT NULL AND pv."revisionCount" > ${threshold}) OR
        (pv."voteCount" IS NOT NULL AND pv."voteCount" > ${threshold})
      )
  `;

  if (badVersions.length === 0) {
    console.log('No pages matched the criteria.');
    return;
  }

  const pageIds = [...new Set(badVersions.map(b => b.pageId))];
  console.log(`Found ${pageIds.length} pages to clean.`);

  if (dry) {
    console.log('Page IDs (dry-run):', pageIds.slice(0, 50).join(', '), pageIds.length > 50 ? '...' : '');
    return;
  }

  // Use transaction for safety; delete in dependency order
  // We remove: Dependent analysis data, votes/revisions/sourceVersions/attributions for affected versions,
  // all PageVersion rows for the page, and finally the Page itself to force clean rebuilds.
  // Related queues/caches also cleared.
  const BATCH = 100;
  let totalDeletedPages = 0;

  for (let i = 0; i < pageIds.length; i += BATCH) {
    const batch = pageIds.slice(i, i + BATCH);
    console.log(`Deleting batch ${i / BATCH + 1}: ${batch.length} pages...`);

    await prisma.$transaction(async (tx) => {
      // Delete analysis/records linked by pageId
      await tx.interestingFacts.deleteMany({ where: { pageId: { in: batch } } });
      await tx.pageDailyStats.deleteMany({ where: { pageId: { in: batch } } });
      await tx.tagRecords.deleteMany({ where: { pageId: { in: batch } } });
      await tx.contentRecords.deleteMany({ where: { pageId: { in: batch } } });
      await tx.ratingRecords.deleteMany({ where: { pageId: { in: batch } } });
      await tx.timeMilestones.deleteMany({ where: { pageId: { in: batch } } });
      await tx.dirtyPage.deleteMany({ where: { pageId: { in: batch } } });

      // Find all pageVersion ids for these pages
      const versions = await tx.pageVersion.findMany({
        where: { pageId: { in: batch } },
        select: { id: true }
      });
      const pvIds = versions.map(v => v.id);

      if (pvIds.length > 0) {
        // Delete dependent rows keyed by pageVersionId
        await tx.vote.deleteMany({ where: { pageVersionId: { in: pvIds } } });
        await tx.revision.deleteMany({ where: { pageVersionId: { in: pvIds } } });
        await tx.sourceVersion.deleteMany({ where: { pageVersionId: { in: pvIds } } });
        await tx.attribution.deleteMany({ where: { pageVerId: { in: pvIds } } });
        await tx.pageStats.deleteMany({ where: { pageVersionId: { in: pvIds } } });
      }

      // Finally delete versions and pages
      await tx.pageVersion.deleteMany({ where: { pageId: { in: batch } } });
      await tx.page.deleteMany({ where: { id: { in: batch } } });
    }, { timeout: 120000 });

    totalDeletedPages += batch.length;
  }

  console.log(`Done. Deleted ${totalDeletedPages} pages and their related data.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });


